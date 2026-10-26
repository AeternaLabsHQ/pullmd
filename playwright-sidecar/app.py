"""Playwright HTTP sidecar for PullMD — renders JS-heavy pages on demand."""
import asyncio
import logging
import os
import socket
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException
from fastapi.responses import PlainTextResponse
from pydantic import BaseModel
from playwright.async_api import async_playwright, TimeoutError as PWTimeout
import importlib.metadata

from ssrf import POLICY, AllowList, PolicyError, assert_url_allowed, url_target
from ua_metadata import build_ua_metadata

logging.basicConfig(level=logging.INFO)

# Last updated: 2026-10-09 (major matches the bundled Chromium, Playwright 1.63)
# Source: https://github.com/WinFuture23/real-world-user-agents
# Update at each release alongside lib/user-agent.js seed pool.
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36"
)
MAX_CONCURRENCY = 4
NAV_TIMEOUT_MS = 15_000
NETWORKIDLE_TIMEOUT_MS = 5_000
HARD_TIMEOUT_S = 20.0

log = logging.getLogger("playwright-sidecar")
state: dict = {"browser": None, "pw": None, "sem": asyncio.Semaphore(MAX_CONCURRENCY)}

# Stealth: defeat navigator.webdriver and other headless markers.
# API has changed across versions; try the current modern entrypoint with a fallback.
try:
    from playwright_stealth import Stealth as _Stealth
    _stealth = _Stealth()
    async def _apply_stealth(page):
        # Modern API (>= 2.x): instance method on Stealth
        await _stealth.apply_stealth_async(page)
except (ImportError, AttributeError):
    try:
        from playwright_stealth import stealth_async as _apply_stealth  # legacy 1.x
    except ImportError:
        async def _apply_stealth(page):
            pass
        log.warning("playwright-stealth not installed; running without bot-detection mitigation")


class BlockedNavigation(Exception):
    """The page tried to navigate its main frame to a host the policy forbids."""

    def __init__(self, url: str, reason: str):
        super().__init__(reason)
        self.url = url
        self.reason = reason


async def _resolve(host: str) -> list[str]:
    """Resolve like Chromium will (same resolv.conf), without blocking the loop."""
    loop = asyncio.get_running_loop()
    infos = await loop.getaddrinfo(host, None, type=socket.SOCK_STREAM)
    return [info[4][0] for info in infos]


class AddressGuard:
    """Enforce the outbound address policy on everything Chromium requests.

    Node validates the submitted URL once; from there on Chromium navigates on
    its own (3xx, meta refresh, `location` changes, iframes, subresources,
    WebSockets) and none of that passes through Node. This guard is installed
    unconditionally on every page and checks each request before it leaves
    the browser. A blocked main-frame navigation is remembered so the render
    can fail loudly instead of returning whatever page Chromium stayed on.
    """

    def __init__(self, allow: AllowList, strip_client_hints: bool):
        self.allow = allow
        self.strip_client_hints = strip_client_hints
        self.cache: dict[str, list[str]] = {}
        self.blocked_navigation: BlockedNavigation | None = None
        self.session = None
        self.main_frame_id: str | None = None

    async def _check(self, url: str) -> str | None:
        try:
            await assert_url_allowed(url, self.allow, _resolve, self.cache)
        except PolicyError as exc:
            return str(exc)
        return None

    async def route(self, route):
        request = route.request
        reason = await self._check(request.url)
        if reason is not None:
            is_main = request.is_navigation_request() and request.frame == request.frame.page.main_frame
            log.warning("blocked %s request to %s: %s", "navigation" if is_main else "subresource", request.url, reason)
            if is_main and self.blocked_navigation is None:
                self.blocked_navigation = BlockedNavigation(request.url, reason)
            await route.abort("blockedbyclient")
            return
        if self.strip_client_hints:
            headers = {k: v for k, v in request.headers.items() if not k.lower().startswith("sec-ch-ua")}
            await route.continue_(headers=headers)
        else:
            await route.continue_()

    async def route_web_socket(self, ws):
        # page.route() does not see WebSockets; a page script could still open
        # ws://internal-host and read whatever comes back. Same policy here.
        url = ws.url.replace("wss://", "https://", 1).replace("ws://", "http://", 1)
        reason = await self._check(url)
        if reason is not None:
            log.warning("blocked websocket to %s: %s", ws.url, reason)
            await ws.close(code=1008, reason="blocked by policy")
            return
        ws.connect_to_server()

    async def _on_request_paused(self, event: dict) -> None:
        request_id = event["requestId"]
        try:
            if not event.get("redirectedRequestId"):
                # First hop of a request: page.route() above already decided.
                await self.session.send("Fetch.continueRequest", {"requestId": request_id})
                return
            url = event["request"]["url"]
            reason = await self._check(url)
            if reason is None:
                await self.session.send("Fetch.continueRequest", {"requestId": request_id})
                return
            is_main = event.get("resourceType") == "Document" and event.get("frameId") == self.main_frame_id
            log.warning("blocked redirect %s to %s: %s", "navigation" if is_main else "subresource", url, reason)
            if is_main and self.blocked_navigation is None:
                self.blocked_navigation = BlockedNavigation(url, reason)
            await self.session.send("Fetch.failRequest", {"requestId": request_id, "errorReason": "BlockedByClient"})
        except Exception as exc:  # noqa: BLE001 - fail closed, never leave a request hanging open
            log.warning("redirect guard error for %s (%s); failing the request", event.get("request", {}).get("url"), exc)
            try:
                await self.session.send("Fetch.failRequest", {"requestId": request_id, "errorReason": "BlockedByClient"})
            except Exception:  # noqa: BLE001 - request may be gone already
                pass

    async def install(self, context, page):
        await page.route("**/*", self.route)
        await page.route_web_socket("**/*", self.route_web_socket)
        # Playwright never hands a redirect hop to page.route(): its network
        # manager continues redirected requests itself (crNetworkManager,
        # `if (redirectedFrom ...) Fetch.continueRequest`). Chromium does pause
        # them for any Fetch client though, so a second CDP session catches
        # exactly those hops. Without this a public URL answering 302 to an
        # internal host would be followed, response body and all.
        self.session = await context.new_cdp_session(page)
        tree = await self.session.send("Page.getFrameTree")
        self.main_frame_id = tree["frameTree"]["frame"]["id"]
        loop = asyncio.get_running_loop()
        self.session.on("Fetch.requestPaused", lambda event: loop.create_task(self._on_request_paused(event)))
        await self.session.send("Fetch.enable", {"patterns": [{"urlPattern": "*", "requestStage": "Request"}]})

    async def check_final_url(self, url: str) -> None:
        """Belt and braces for the main frame after the waits have run."""
        if self.blocked_navigation is not None:
            raise self.blocked_navigation
        try:
            await assert_url_allowed(url, self.allow, _resolve, self.cache)
        except PolicyError as exc:
            raise BlockedNavigation(url, str(exc)) from exc


async def _align_client_hints(context, page, user_agent: str, mobile: bool) -> bool:
    """Make Sec-CH-UA agree with the User-Agent we claim.

    Chromium builds Sec-CH-UA from its own identity, so overriding the UA on
    the context leaves the request advertising `"HeadlessChrome";v="<real>"`
    one header below a UA that says Chrome. Bot rules key on exactly that:
    with everything else held constant, only swapping that brand token decides
    whether an Akamai-protected host answers 200 or 403.

    Chromium-based UA -> rewrite the metadata to match. Anything else (the
    iPhone/Safari device profile) -> tell the caller to strip the header in
    the request guard, because Safari sends no Client Hints and a fabricated
    one would be a fresh contradiction.

    Best-effort throughout: this is camouflage, never a reason to fail a
    render that would otherwise succeed.

    Returns True when the caller should strip `Sec-CH-UA*` request headers.
    """
    metadata = build_ua_metadata(user_agent, mobile=mobile)

    if metadata is None:
        return True

    session = await context.new_cdp_session(page)
    await session.send("Emulation.setUserAgentOverride", {
        "userAgent": user_agent,
        "platform": metadata["platform"],
        "userAgentMetadata": metadata,
    })
    return False


@asynccontextmanager
async def lifespan(_app: FastAPI):
    state["pw"] = await async_playwright().start()
    # Site isolation off: every frame of a page lives in the page's own
    # target, so the redirect guard's CDP session sees cross-site iframes too.
    state["browser"] = await state["pw"].chromium.launch(headless=True, args=["--disable-site-isolation-trials"])
    log.info("playwright launched, chromium ready")
    try:
        yield
    finally:
        await state["browser"].close()
        await state["pw"].stop()


app = FastAPI(title="playwright-sidecar", lifespan=lifespan)


class RenderRequest(BaseModel):
    url: str
    waitFor: str | None = None
    waitTimeoutMs: int | None = None
    mobileUa: bool = False
    userAgent: str | None = None
    # Raw PULLMD_ALLOWED_HOSTS of the calling pullmd instance, so the sidecar
    # applies the same exceptions without needing its own copy of the env.
    allowedHosts: str | None = None


@app.get("/health")
def health():
    browser = state.get("browser")
    return {
        "ok": browser is not None,
        "playwright": importlib.metadata.version("playwright"),
        "browser": "chromium" if browser else None,
        "policy": POLICY,
    }


async def _render(url: str, allow: AllowList, wait_for: str | None = None, wait_timeout_ms: int | None = None, mobile_ua: bool = False, user_agent: str | None = None) -> str:
    # Service workers would answer fetches from their own cache or network
    # without passing through page.route(); the renderer has no use for them.
    context_opts = {"service_workers": "block"}
    if mobile_ua:
        device = state["pw"].devices.get("iPhone 13")
        if device is None:
            # Fallback: hand-crafted mobile context if the device profile is unavailable
            effective_ua = (
                "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) "
                "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"
            )
            context = await state["browser"].new_context(
                user_agent=effective_ua,
                viewport={"width": 390, "height": 844},
                device_scale_factor=3,
                is_mobile=True,
                has_touch=True,
                **context_opts,
            )
        else:
            effective_ua = device.get("user_agent", "")
            context = await state["browser"].new_context(**device, **context_opts)
    else:
        effective_ua = user_agent or USER_AGENT
        context = await state["browser"].new_context(user_agent=effective_ua, **context_opts)

    try:
        page = await context.new_page()
        try:
            await _apply_stealth(page)
        except Exception as e:
            log.warning("stealth apply failed (non-fatal): %s", e)
        strip_client_hints = False
        try:
            strip_client_hints = await _align_client_hints(context, page, effective_ua, mobile_ua)
        except Exception as e:
            log.warning("client-hints alignment failed (non-fatal): %s", e)

        # Not optional and not best-effort: if the guard cannot be installed
        # the render must not happen.
        guard = AddressGuard(allow, strip_client_hints)
        await guard.install(context, page)

        try:
            await page.goto(url, wait_until="domcontentloaded", timeout=NAV_TIMEOUT_MS)
        except Exception:
            if guard.blocked_navigation is not None:
                raise guard.blocked_navigation
            raise

        if wait_for:
            # Recipe-driven: wait for a specific selector instead of networkidle
            timeout = max(0, min(wait_timeout_ms or 5000, 15_000))
            try:
                await page.wait_for_selector(wait_for, timeout=timeout)
            except PWTimeout:
                log.info("wait_for selector timeout, returning current DOM: %s (selector=%s)", url, wait_for)
        else:
            # Default behavior: wait for networkidle as before
            try:
                await page.wait_for_load_state("networkidle", timeout=NETWORKIDLE_TIMEOUT_MS)
            except PWTimeout:
                log.info("networkidle timeout, returning current DOM: %s", url)

        await guard.check_final_url(page.url)
        return await page.content()
    finally:
        await context.close()


@app.post("/render", response_class=PlainTextResponse)
async def render(req: RenderRequest):
    if not req.url:
        raise HTTPException(status_code=400, detail="url field required")

    allowed_hosts = req.allowedHosts if req.allowedHosts is not None else os.environ.get("PULLMD_ALLOWED_HOSTS")
    allow = AllowList(allowed_hosts)
    try:
        await assert_url_allowed(req.url, allow, _resolve)
    except PolicyError as exc:
        raise HTTPException(status_code=403, detail={"code": "ssrf_blocked", "url": req.url, "reason": str(exc)})

    sem = state["sem"]
    if sem.locked():
        raise HTTPException(status_code=503, detail="render queue saturated", headers={"Retry-After": "5"})

    async with sem:
        try:
            return await asyncio.wait_for(
                _render(req.url, allow, wait_for=req.waitFor, wait_timeout_ms=req.waitTimeoutMs, mobile_ua=req.mobileUa, user_agent=req.userAgent),
                timeout=HARD_TIMEOUT_S,
            )
        except asyncio.TimeoutError:
            raise HTTPException(status_code=504, detail=f"render timeout after {HARD_TIMEOUT_S}s")
        except BlockedNavigation as exc:
            log.warning("render refused, navigation to blocked host: %s -> %s (%s)", req.url, exc.url, exc.reason)
            raise HTTPException(status_code=403, detail={"code": "ssrf_blocked", "url": exc.url, "reason": exc.reason})
        except Exception as exc:
            log.exception("render failed: %s", req.url)
            raise HTTPException(status_code=500, detail=f"render failed: {exc}")
