"""Playwright HTTP sidecar for PullMD — renders JS-heavy pages on demand."""
import asyncio
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException
from fastapi.responses import PlainTextResponse
from pydantic import BaseModel
from playwright.async_api import async_playwright, TimeoutError as PWTimeout
import importlib.metadata

logging.basicConfig(level=logging.INFO)

# Last updated: 2026-05-02
# Source: https://github.com/WinFuture23/real-world-user-agents
# Update at each release alongside lib/user-agent.js seed pool.
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36"
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


@asynccontextmanager
async def lifespan(_app: FastAPI):
    state["pw"] = await async_playwright().start()
    state["browser"] = await state["pw"].chromium.launch(headless=True)
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


@app.get("/health")
def health():
    browser = state.get("browser")
    return {
        "ok": browser is not None,
        "playwright": importlib.metadata.version("playwright"),
        "browser": "chromium" if browser else None,
    }


async def _render(url: str, wait_for: str | None = None, wait_timeout_ms: int | None = None, mobile_ua: bool = False, user_agent: str | None = None) -> str:
    if mobile_ua:
        device = state["pw"].devices.get("iPhone 13")
        if device is None:
            # Fallback: hand-crafted mobile context if the device profile is unavailable
            context = await state["browser"].new_context(
                user_agent=(
                    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) "
                    "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"
                ),
                viewport={"width": 390, "height": 844},
                device_scale_factor=3,
                is_mobile=True,
                has_touch=True,
            )
        else:
            context = await state["browser"].new_context(**device)
    else:
        context = await state["browser"].new_context(user_agent=user_agent or USER_AGENT)

    try:
        page = await context.new_page()
        try:
            await _apply_stealth(page)
        except Exception as e:
            log.warning("stealth apply failed (non-fatal): %s", e)
        await page.goto(url, wait_until="domcontentloaded", timeout=NAV_TIMEOUT_MS)

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

        return await page.content()
    finally:
        await context.close()


@app.post("/render", response_class=PlainTextResponse)
async def render(req: RenderRequest):
    if not req.url:
        raise HTTPException(status_code=400, detail="url field required")

    sem = state["sem"]
    if sem.locked():
        raise HTTPException(status_code=503, detail="render queue saturated", headers={"Retry-After": "5"})

    async with sem:
        try:
            return await asyncio.wait_for(
                _render(req.url, wait_for=req.waitFor, wait_timeout_ms=req.waitTimeoutMs, mobile_ua=req.mobileUa, user_agent=req.userAgent),
                timeout=HARD_TIMEOUT_S,
            )
        except asyncio.TimeoutError:
            raise HTTPException(status_code=504, detail=f"render timeout after {HARD_TIMEOUT_S}s")
        except Exception as exc:
            log.exception("render failed: %s", req.url)
            raise HTTPException(status_code=500, detail=f"render failed: {exc}")
