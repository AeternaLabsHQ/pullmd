"""Browser tests: the address guard covers popups, new pages and workers.

Needs Playwright with Chromium. Skips (exit 0) when either is missing.
Run directly:  python3 test_popups.py

Setup: a stand-in "internal" server on 127.0.0.1 that records every request,
and an "attacker" server on 127.0.0.2 (allowlisted, plays the public site)
that serves the test pages. Each test renders an attacker page through
app._render and then checks the stand-in never saw the request.
"""
import asyncio
import http.server
import sys
import threading
import time

try:
    import app
    from ssrf import AllowList
except ImportError as exc:  # no playwright / fastapi in this interpreter
    print(f"skip test_popups.py: {exc}")
    sys.exit(0)

MARKER = "popup-guard-marker-7f3a"
STRICT_MARKER = "strict-script-ran-2c9d"


class Recorder:
    def __init__(self):
        self.lock = threading.Lock()
        self.paths: list[str] = []

    def add(self, path: str) -> None:
        with self.lock:
            self.paths.append(path)

    def clear(self) -> None:
        with self.lock:
            self.paths.clear()

    def hits(self) -> list[str]:
        with self.lock:
            return list(self.paths)


internal_log = Recorder()
public_log = Recorder()


class StandInHandler(http.server.BaseHTTPRequestHandler):
    def _answer(self):
        length = int(self.headers.get("Content-Length") or 0)
        if length:
            self.rfile.read(length)
        internal_log.add(self.path)
        body = b"<html><body><h1>INTERNAL</h1></body></html>"
        self.send_response(200)
        self.send_header("Content-Type", "text/html")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    do_GET = _answer
    do_POST = _answer

    def log_message(self, *args):
        pass


def make_pages(internal: str, public: str) -> dict[str, tuple[str, str]]:
    """Path -> (content type, body). `internal`/`public` are http://host:port."""
    article = f"<article><h1>Article</h1><p>{MARKER} lorem ipsum dolor sit amet, consectetur adipiscing elit.</p></article>"
    # Keeps the main page busy long enough for anything a popup would do.
    slow = f'<img src="{public}/slow">'
    popup = f"""
      try {{ window.open('{internal}/popup'); }} catch (e) {{}}
      try {{ window.open('{public}/stage2.html'); }} catch (e) {{}}
    """
    forms = f"""
      <form id="fg" action="{internal}/form-get" target="_blank" method="GET"><input name="a" value="b"></form>
      <form id="fp" action="{internal}/form-post" target="_blank" method="POST"><input name="cmd" value="x"></form>
      <a id="ab" href="{internal}/anchor-blank" target="_blank">x</a>
    """
    forms_js = """
      try { document.getElementById('fg').submit(); } catch (e) {}
      setTimeout(() => { try { document.getElementById('fp').submit(); } catch (e) {} }, 100);
      setTimeout(() => { try { document.getElementById('ab').click(); } catch (e) {} }, 200);
    """
    shared = f"""
      try {{ new SharedWorker('{public}/sw.js'); }} catch (e) {{}}
      try {{
        const src = "fetch('{internal}/sharedworker-blob', {{mode: 'no-cors'}});";
        new SharedWorker(URL.createObjectURL(new Blob([src], {{type: 'text/javascript'}})));
      }} catch (e) {{}}
      try {{
        // A fresh same-origin frame has its own globals.
        const frame = document.createElement('iframe');
        document.body.appendChild(frame);
        new frame.contentWindow.SharedWorker('{public}/sw.js?via=iframe', 'iframe');
      }} catch (e) {{}}
    """
    dedicated = f"try {{ new Worker('{public}/w.js'); }} catch (e) {{}}"
    public_worker = f"try {{ new Worker('{public}/wp.js'); }} catch (e) {{}}"

    def page(head_extra: str, script: str) -> tuple[str, str]:
        return "text/html", f"<html><head><title>t</title></head><body>{article}{head_extra}{slow}<script>{script}</script></body></html>"

    js = "application/javascript"
    return {
        "/popup.html": page("", popup),
        "/forms.html": page(forms, forms_js),
        "/shared.html": page("", shared),
        "/dedicated.html": page("", dedicated),
        "/public-worker.html": page("", public_worker),
        "/multi.html": page(forms + f'<iframe src="{public}/frame.html"></iframe>', popup + forms_js + shared + dedicated),
        "/frame.html": ("text/html", "<html><body>frame</body></html>"),
        "/strict.html": page(f'<iframe name="slot" src="about:blank"></iframe><form id="fi" action="{public}/into-iframe" target="slot"></form>',
                             "'use strict'; window.open = function () { return null; }; document.getElementById('fi').submit();"
                             # Split so the marker is not in the page source itself.
                             f" document.body.insertAdjacentHTML('beforeend', '<p>{STRICT_MARKER[:6]}' + '{STRICT_MARKER[6:]}</p>');"),
        "/speculation.html": page(
            f'<link rel="prerender" href="{internal}/link-prerender">'
            f'<link rel="preconnect" href="{internal}/link-preconnect">'
            f'<link rel="dns-prefetch" href="{internal}/link-dns-prefetch">'
            '<script type="speculationrules">'
            f'{{"prefetch": [{{"source": "list", "urls": ["{internal}/spec-prefetch"]}}],'
            f' "prerender": [{{"source": "list", "urls": ["{internal}/spec-prerender", "{public}/stage2.html?prerender"]}}]}}'
            '</script>',
            ""),
        "/stage2.html": ("text/html", f"<html><body><script>fetch('{internal}/from-popup', {{mode: 'no-cors'}});</script></body></html>"),
        "/sw.js": (js, f"fetch('{internal}/sharedworker-fetch' + self.location.search, {{mode: 'no-cors'}});"),
        "/wp.js": (js, f"fetch('{public}/worker-public', {{mode: 'no-cors'}});"),
        "/w.js": (js, f"fetch('{internal}/worker-fetch', {{mode: 'no-cors'}});"),
    }


def attacker_handler(pages):
    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            path = self.path.split("?", 1)[0]
            public_log.add(self.path)
            if path == "/slow":
                time.sleep(1.5)
                self.send_response(204)
                self.end_headers()
                return
            if path not in pages:
                self.send_response(404)
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
            ctype, body = pages[path]
            data = body.encode()
            self.send_response(200)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def log_message(self, *args):
            pass

    return Handler


class Env:
    public = ""
    allow = AllowList("127.0.0.2")


async def render_and_settle(path: str) -> str:
    internal_log.clear()
    public_log.clear()
    html = await asyncio.wait_for(app._render(f"{Env.public}{path}", Env.allow), timeout=15)
    # Anything already in flight gets a moment to land at the stand-in.
    await asyncio.sleep(1.0)
    return html


async def test_window_open_does_not_reach_internal():
    await render_and_settle("/popup.html")
    hits = internal_log.hits()
    assert not hits, f"internal server was reached: {hits}"


async def test_form_target_blank_does_not_reach_internal():
    await render_and_settle("/forms.html")
    hits = internal_log.hits()
    assert not hits, f"internal server was reached: {hits}"


async def test_shared_worker_does_not_reach_internal():
    await render_and_settle("/shared.html")
    hits = internal_log.hits()
    assert not hits, f"internal server was reached: {hits}"


async def test_render_still_returns_main_document():
    html = await render_and_settle("/multi.html")
    assert MARKER in html, "main document missing from render output"
    assert "/frame.html" in public_log.hits(), "iframe on the main page did not load"


async def test_dedicated_worker_still_blocked():
    await render_and_settle("/dedicated.html")
    hits = internal_log.hits()
    assert not hits, f"internal server was reached: {hits}"


async def test_dedicated_worker_public_fetch_still_works():
    await render_and_settle("/public-worker.html")
    hits = public_log.hits()
    assert "/worker-public" in hits, f"worker fetch to the public site was lost: {hits}"


async def test_speculation_prefetch_does_not_reach_internal():
    # Speculative loads run outside context.route(); they must not happen.
    await render_and_settle("/speculation.html")
    hits = internal_log.hits()
    assert not hits, f"internal server was reached: {hits}"


async def test_page_scripts_keep_working():
    # Strict-mode code that wraps window.open must not throw, and a form
    # aimed at a named iframe of the page is not a new window.
    html = await render_and_settle("/strict.html")
    assert STRICT_MARKER in html, "page script failed after reassigning window.open"
    assert any(p.startswith("/into-iframe") for p in public_log.hits()), "form into a named iframe was dropped"


async def test_extra_pages_inert_without_init_script():
    # The init script only avoids extra pages; the route must hold on its own
    # for any popup path the script misses.
    saved = app.SINGLE_PAGE_INIT_SCRIPT
    app.SINGLE_PAGE_INIT_SCRIPT = ""
    try:
        html = await render_and_settle("/multi.html")
    finally:
        app.SINGLE_PAGE_INIT_SCRIPT = saved
    assert MARKER in html, "main document missing from render output"
    hits = internal_log.hits()
    assert not hits, f"internal server was reached: {hits}"
    assert "/stage2.html" not in public_log.hits(), "popup page was loaded"


def serve(host: str, handler) -> http.server.ThreadingHTTPServer:
    server = http.server.ThreadingHTTPServer((host, 0), handler)
    server.daemon_threads = True
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


async def main() -> int:
    standin = serve("127.0.0.1", StandInHandler)
    try:
        attacker = serve("127.0.0.2", attacker_handler({}))
    except OSError as exc:
        standin.shutdown()
        standin.server_close()
        print(f"skip test_popups.py: cannot bind 127.0.0.2 ({exc})")
        return 0
    internal = f"http://127.0.0.1:{standin.server_address[1]}"
    Env.public = f"http://127.0.0.2:{attacker.server_address[1]}"
    attacker.RequestHandlerClass = attacker_handler(make_pages(internal, Env.public))

    failed = 0
    try:
        try:
            lifespan = app.lifespan(app.app)
            await lifespan.__aenter__()
        except Exception as exc:  # noqa: BLE001 - no Chromium here
            print(f"skip test_popups.py: chromium did not launch ({exc})")
            return 0
        try:
            for name, fn in sorted(globals().items()):
                if name.startswith("test_") and callable(fn):
                    try:
                        await fn()
                        print(f"ok   {name}")
                    except Exception as exc:  # noqa: BLE001 - report and continue
                        failed += 1
                        print(f"FAIL {name}: {type(exc).__name__}: {exc}")
        finally:
            await lifespan.__aexit__(None, None, None)
    finally:
        for server in (standin, attacker):
            server.shutdown()
            server.server_close()
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
