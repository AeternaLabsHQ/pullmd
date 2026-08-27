# PullMD Playwright Sidecar

Companion service for [**PullMD**](https://github.com/AeternaLabsHQ/pullmd) — renders JavaScript-heavy pages via headless Chromium so the main pullmd container can fall back to it when static-HTML extraction returns body-soup or thin output.

This image is **not** useful on its own. Use it together with `aeternalabshq/pullmd`.

## Endpoints

- `GET /health` → `{"ok": true, "playwright": "<version>", "browser": "chromium"}`
- `POST /render` body `{"url": "https://…"}` → `text/html` (rendered DOM after JavaScript execution)
- Returns `503 Retry-After: 5` when the concurrency limit (default 4) is saturated, `504` on render timeout (20s hard cap).

## Wiring

In your `docker-compose.yml`, run alongside `pullmd` on a shared internal network and set `PLAYWRIGHT_URL=http://playwright:8002/render` on the pullmd service:

```yaml
services:
  pullmd:
    image: aeternalabshq/pullmd:latest
    environment:
      - PLAYWRIGHT_URL=http://playwright:8002/render
    depends_on:
      - playwright
    networks:
      - pullmd-internal

  playwright:
    image: aeternalabshq/pullmd-playwright:latest
    networks:
      - pullmd-internal

networks:
  pullmd-internal:
    driver: bridge
```

## Identity

The rendered request has to be internally consistent. Chromium builds its
`Sec-CH-UA` header from its own identity, and overriding the User-Agent on the
browser context does not touch it — so by default a request goes out claiming
`Chrome/147` in one header and `"HeadlessChrome";v="131"` in the next. Bot
rules read the second one: holding everything else constant and swapping only
that brand token is the difference between `200` and `403` on hosts behind a
bot manager.

The sidecar therefore rewrites the Client-Hints metadata to match the
User-Agent it sends (brand, version, platform, mobile flag). For a
non-Chromium User-Agent — the iPhone profile from `mobileUa` — it strips the
`Sec-CH-UA*` headers instead, because Safari sends no Client Hints and a
fabricated one would be a fresh contradiction. Both are best-effort: a failure
here is logged and the render proceeds.

## Resource footprint

- Image size: **~3.7 GB** (Microsoft Playwright base image bundles Chromium, Firefox, WebKit binaries)
- Idle RAM: ~250 MB (one persistent browser instance)
- Per-render: brief spike, freed when the per-request browser context closes

## Wait strategy

`page.goto(url, wait_until="domcontentloaded")` then `wait_for_load_state("networkidle")` (5s soft-fail). 20-second hard timeout via `asyncio.wait_for`.

## Tags

- `latest` — main branch
- `1.1.2`, `1.1`, `sha-<short>` — released versions

Multi-arch: `linux/amd64`, `linux/arm64`.

## Source

[github.com/AeternaLabsHQ/pullmd](https://github.com/AeternaLabsHQ/pullmd) — see `playwright-sidecar/` for the source.

## License

[AGPL-3.0-or-later](https://github.com/AeternaLabsHQ/pullmd/blob/main/LICENSE).
