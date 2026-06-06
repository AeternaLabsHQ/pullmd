# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Self-hosters should consult [`MIGRATION.md`](./MIGRATION.md) when upgrading across a major version.

---

## [Unreleased]

### Fixed
- **Sessions no longer die a hard 7 days after login regardless of activity** ([#26](https://github.com/AeternaLabsHQ/pullmd/issues/26)). The session cookie is now re-issued with a fresh `Max-Age` whenever the DB-side sliding expiry bumps (existing once-per-minute throttle), so browser cookie and DB session finally slide together.

### Changed
- **Session TTL raised from 7 to 90 days** (sliding). Anyone active at least once every 90 days stays logged in.
- **Expired session in the PWA now redirects to the login page** instead of showing a bare "Authentication required" error; the requested URL is carried through `/login?next=` and the conversion resumes automatically after login ([#26](https://github.com/AeternaLabsHQ/pullmd/issues/26)).
- **`GET /share` is now auth-gated.** Share intents from a logged-out device go straight to the login page and return to the shared URL after login — no more lost share-target URLs. Instances with `PULLMD_AUTH_MODE=disabled` are unaffected ([#26](https://github.com/AeternaLabsHQ/pullmd/issues/26)).

---

## [2.4.1] - 2026-05-13

### Fixed
- Permalink bar hidden by ad-blockers (e.g. uBlock Origin). Renamed all `share-bar` / `share-url` / `share-copy-btn` CSS classes and IDs to `permalink-bar` / `permalink-url` / `permalink-copy-btn` so cosmetic filter lists no longer suppress the element.
- Service Worker: removed the aggressive forced tab-reload on SW activation that had been introduced as a debugging artifact.

### Changed
- **`:latest` Docker tag now tracks the most recent release again.** The v1 → v2 migration grace period is over; self-hosters who want to pin v1 should use `:1` or `:1.2`.

---

## [2.4.0] - 2026-05-11

### Added
- **Rendered Markdown view in the PWA** (closes [#23](https://github.com/AeternaLabsHQ/pullmd/issues/23), thanks @sladg). New `Raw | Rendered` segmented toggle in the result header lets users see the fetched output as actual formatted HTML (headings, lists, links, images, tables, blockquotes, code blocks) instead of the raw source. Raw remains the default; the chosen mode is persisted in `localStorage` (`pullmd-view-mode`).
  - GFM rendering via self-hosted [marked](https://github.com/markedjs/marked) v12.0.2 (~30 KB).
  - HTML sanitization via self-hosted [DOMPurify](https://github.com/cure53/DOMPurify) v3.4.2 (~20 KB). Strips scripts, inline styles, event handlers, `javascript:` URLs.
  - Rendered links open in a new tab with `rel="noopener noreferrer"`.
  - Lazy first-render: the rendered DOM is only built when the user first switches to Rendered for a given result, so users who only ever copy raw Markdown pay no rendering cost.
  - Copy button still copies the raw Markdown source regardless of the active view.
  - Both themes (dark + paper) styled via existing CSS variables — no new tokens.
- Service Worker precaches the new vendor files (`vendor/marked.min.js`, `vendor/purify.min.js`) so the rendered view also works offline in the installed PWA. `CACHE_NAME` bumped to `pullmd-v20`.

### Notes
- Out of scope for v2.4: syntax highlighting, math/diagrams, Reddit-style spoiler syntax, side-by-side view, rendered view for `/s/:id` share links (still pure `text/markdown`).

---

## [2.3.0] - 2026-05-11

### Added
- **OAuth 2.1 Authorization Code flow** with PKCE-S256 for the claude.ai web custom connector, Claude Desktop's custom-connector dialog, and other MCP-spec-compliant clients (closes [#6](https://github.com/AeternaLabsHQ/pullmd/issues/6), [#10](https://github.com/AeternaLabsHQ/pullmd/issues/10) — thanks @WinFuture23 for raising the Claude Desktop auth gap).
  - Dynamic Client Registration (`POST /oauth/register`, RFC 7591).
  - Authorization endpoint (`GET /oauth/authorize`) with server-rendered consent screen (DE/EN).
  - Token endpoint (`POST /oauth/token`) with `authorization_code` and `refresh_token` grants. Refresh tokens are rotated on every refresh; reuse triggers chain-wide invalidation.
  - Revocation endpoint (`POST /oauth/revoke`, RFC 7009).
  - Discovery: `/.well-known/oauth-authorization-server` (RFC 8414) and `/.well-known/oauth-protected-resource` (RFC 9728).
  - Access tokens are HS256 JWTs (`typ: at+jwt`, RFC 9068), audience-bound to `<PUBLIC_URL>/mcp`, 1h TTL. Refresh tokens are opaque, sha256-hashed in storage, 30d TTL.
  - Hardcoded redirect-URI allowlist: `https://claude.ai/api/mcp/auth_callback` and `https://claude.com/api/mcp/auth_callback`.
  - `WWW-Authenticate` 401 responses include the `resource_metadata` parameter pointing at the protected-resource metadata document.
- Rate limiting on `/oauth/token` and `/oauth/authorize` (60 req/min/IP) and `/oauth/register` (10 req/h/IP).
- CORS on `/oauth/token`, `/oauth/register`, `/oauth/revoke`, `/.well-known/*`, and `/mcp` (wildcard origin, no credentials — Bearer header travels independently).

### Changed
- `lib/auth.js` middleware accepts a third bearer-token type (OAuth JWT) via an injected verifier. Sessions and API keys (`pmd_*`) continue working unchanged.

### Configuration
- New env var `OAUTH_JWT_SECRET` enables OAuth. Must be 32+ chars. Generate via `openssl rand -hex 32`.
- `PUBLIC_URL` is required when OAuth is enabled (used as JWT `iss`/`aud` and in discovery metadata).

### Migration
- New tables `oauth_clients`, `oauth_auth_codes`, `oauth_refresh_tokens` are created automatically on first boot. No manual SQL.
- OAuth is **opt-in** — without `OAUTH_JWT_SECRET`, behavior is unchanged from v2.2.x. See `MIGRATION.md` for the full upgrade path.

---

## [2.2.0] - 2026-05-06

### Added
- **Site Recipe Engine** (closes [#18](https://github.com/AeternaLabsHQ/pullmd/issues/18)). Declarative `site-recipes.json` for per-host preprocess, fetch, select, and extractor rules. Default recipes ship in the repo (`site-recipes.default.json`); self-hosters can mount `data/site-recipes.json` or set `PULLMD_SITE_RECIPES` to point elsewhere. Four recipe categories:
  - `preprocess` — DOM cleanup actions (`remove-attr`, `remove-class`, `remove-element`, `unwrap`) applied before extraction
  - `fetch` — render forcing (`render: force|skip`), wait-for selector, mobile UA
  - `select` — extra remove-selectors added to `cleanDom`
  - `extractor` — preferred extractor per host (`readability`, `trafilatura`, `playwright`)
- Public endpoint `GET /api/recipes/status` (no auth) — counts loaded/rejected recipes per source for monitoring.
- Cache invalidation on recipe change. When recipe content changes between server boots, all cache rows become stale and re-extract on next access (lazy, on-demand).
- Playwright sidecar accepts new optional fields: `waitFor` (CSS selector), `waitTimeoutMs` (capped at 15 000), `mobileUa` (boolean). Backwards compatible — old fields are silently passed through.
- Initial default recipes covering Future PLC sites (paywall + recommendation widgets — seeded by @WinFuture23's analysis in [#17](https://github.com/AeternaLabsHQ/pullmd/issues/17)) and GitHub Issues (JS-rendered comments).
- Playwright sidecar bundles `playwright-stealth` to mitigate `navigator.webdriver`-style headless detection on JS-driven anti-bot pages.

### Known limitations
- Sites behind cookie-based consent walls (third-party CMP frameworks like TCF v2) are not unlocked by recipes alone in this release. Such sites redirect non-consenting visitors to a JS-rendered consent UI and only return article content once HttpOnly cookies are set after a click. Write a custom recipe with whatever combination of `select.remove`, `extractor`, and `fetch` settings works for your specific source.

---

## [2.1.0] - 2026-05-05

### Added
- PWA: persist frontmatter toggle, comments toggle and comment depth across reloads via `localStorage` (keys `pullmd-frontmatter`, `pullmd-comments`, `pullmd-comment-depth`). Closes [#20](https://github.com/AeternaLabsHQ/pullmd/issues/20).
- PWA: scroll to top when selecting a history/archive entry, so the new content is visible after click. Closes [#19](https://github.com/AeternaLabsHQ/pullmd/issues/19).

---

## [2.0.0] - 2026-05-02

> **Breaking:** PullMD now supports an authentication system. Existing installs keep working unchanged (default `PULLMD_AUTH_MODE=disabled`); operators who want auth must follow [`MIGRATION.md`](./MIGRATION.md).

> **Pulling v2.x:** Through 2026-05-13, `:latest` continued pointing at v1.x. Since v2.4.1 the `:latest` tag tracks v2.x again; self-hosters who want to stay on v1 should pin `:1` or `:1.2`.

### Added
- Three auth modes (`disabled` / `single-admin` / `multi-user`) controlled by `PULLMD_AUTH_MODE`.
- Web sessions: `POST /login`, `POST /logout`, `GET /signup`, `GET /api/me`, server-rendered HTML for `/login` and `/signup`.
- Per-user API keys: `pmd_<32-char-base62>` format, sent as `Authorization: Bearer pmd_xxx`. Manage at `/settings`. Stored as SHA-256 hashes.
- Per-user history: `/api/history` and `/api/archive` are scoped to `req.user` when authenticated.
- Admin CLI: `node scripts/admin.js {list-users,reset-password,make-admin}`.
- Schema: `users`, `sessions`, `api_keys`, `user_fetches` tables, plus `conversions.user_id`.
- Argon2id password hashing.

### Changed
- `/api`, `/api/stream`, `/mcp`, `/api/history`, `/api/archive`, `/api/cache/:id`, `DELETE /api/cache` require auth when mode != `disabled`.
- `/s/:id` share links remain public in all modes (design choice).
- `/api/config` now exposes `authMode`.

### Deprecated
- `PULLMD_AUTH_TOKEN` (legacy bearer compat) — works only in `single-admin` mode, removed in v3.0.

### Security
- Internal v2.0 security review (`REVIEW-FINDINGS.md` in the v2.0 release commit) tightened `DELETE /api/cache*` to admin-only in non-`disabled` modes and stopped flashing new API keys through URLs.

### Migration
See `MIGRATION.md`.

---

## [1.2.0] - 2026-05-02

### Added
- **User-Agent rotation** from a real-world UA pool with static seed fallback (closes [#14](https://github.com/AeternaLabsHQ/pullmd/issues/14), thanks @WinFuture23). Sites that silently degraded responses to the previous hardcoded Chrome 131 UA now extract cleanly.
- **Charset detection from HTML meta tags** when `Content-Type` lacks a `charset` directive (closes [#8](https://github.com/AeternaLabsHQ/pullmd/issues/8), thanks @WinFuture23). Eliminates mojibake on legacy ISO-8859-1 pages (e.g. `winfuture.de`).
- **Share URL embedded in MCP frontmatter responses** so LLMs stop hallucinating `pullmd.com` as the host instead of the operator's actual instance (closes [#1](https://github.com/AeternaLabsHQ/pullmd/issues/1), [#9](https://github.com/AeternaLabsHQ/pullmd/issues/9), thanks @looselyhuman and @WinFuture23).
- **HTML preprocessing** to recover dropped paragraphs adjacent to inline recommendation widgets, plus per-host extractor override (closes [#17](https://github.com/AeternaLabsHQ/pullmd/issues/17), thanks @WinFuture23 — analysis that later seeded the v2.2 recipe engine).
- **GHCR mirror** for all three images alongside Docker Hub (closes [#13](https://github.com/AeternaLabsHQ/pullmd/issues/13), thanks @Kampe).
- `DISABLE_PUBLIC_HISTORY` env var to hide the history/archive views on shared instances (closes [#7](https://github.com/AeternaLabsHQ/pullmd/issues/7)).

### Fixed
- **Reddit threads with embedded images:** post selftext now renders before the media block, so the header is visible alongside the image and the comment tree is no longer truncated (closes [#12](https://github.com/AeternaLabsHQ/pullmd/issues/12)).
- **Docker volume mount path:** `/app/data` corrected to `/data` so the documented bind mount actually works (closes [#15](https://github.com/AeternaLabsHQ/pullmd/issues/15), PR [#16](https://github.com/AeternaLabsHQ/pullmd/pull/16) — thanks @andrewthetechie).

---

## [1.1.3] - 2026-04-29

### Fixed
- **MCP response shape:** `read_url`, `get_share`, `list_recent` no longer return `structuredContent` alongside `content[0].text`. Claude Code and other MCP clients were surfacing the metadata JSON instead of the actual Markdown (closes [#1](https://github.com/AeternaLabsHQ/pullmd/issues/1), originally reported by @looselyhuman; upstream Anthropic bug tracked at `anthropics/claude-code#54450`).
- **Reddit images:** image renders before selftext to match Reddit's visual order, so the header/title isn't suppressed by the image preview.
- CI matrix corrected so all three images (pullmd, pullmd-trafilatura, pullmd-playwright) properly publish to Docker Hub at `:1.1.3` / `:1.1` / `:1` / `:latest`, alongside GHCR.

---

## [1.1.2] - 2026-04-27

### Added
- Delete button in the recents list on the homepage. Each row gets a discreet `×` on hover — same one-click pattern as the archive view. `opacity: 0` by default, fades in on row hover.

### Changed
- `cache.history()` now includes the row `id` so the PWA can issue `DELETE /api/cache/:id` straight from the recents list.
- Service Worker cache bumped v17 → v18.

---

## [1.1.1] - 2026-04-27

### Fixed
- **Readonly `<input>` values surface as `<code>`.** Click-to-copy widgets on CMS-driven sites (API model slugs, embed snippets, share links) used to hide their content in `<input type="text" readonly value="…">`, which `node-html-markdown` silently dropped as form chrome. They now come through as inline code. Only `readonly` text inputs are transformed; real forms are untouched.
- **Bare-UUID alt-text on images is dropped.** Strapi/Directus/Hygraph etc. leak asset IDs as the `alt` attribute. A strict UUID-v4 regex on the alt — drop the alt only, keep the image link. Descriptive alt text is preserved.

### Verified
- Diffed against 9 representative URLs (paulgraham.com, hillelwayne.com, 12factor.net, joelonsoftware.com, grugbrain.dev, RFC 2324, Wikipedia, HN frontpage) → byte-identical output. mistral.ai/pricing → expected diff (model slugs now `code`, UUID alts dropped).

---

## [1.1.0] - 2026-04-27

### Added
- **Playwright fallback for JavaScript-rendered pages.** When Readability + Trafilatura returns body-soup or low-quality output, the pipeline retries via headless Chromium and re-extracts on the rendered DOM. Source label is `playwright`; predicate reason is preserved in `metadata.extractorReason`.
- **New Python sidecar `pullmd-playwright`** (FastAPI + Chromium, `asyncio.Semaphore` concurrency limit, 20 s hard timeout, soft-fail networkidle wait). Optional — leave `PLAYWRIGHT_URL` unset and the pipeline silently degrades to static extraction.
- **Live status events for the PWA via Server-Sent Events.** New `GET /api/stream` endpoint emits `fetching → extracting → (rendering) → result`. Other clients (`curl`, Claude, MCP) continue to use `/api` unchanged.
- `lib/render-decision.js` — predicate over (i) readability fellback + thin, (ii) body-soup signature heading/paragraph ratio, (iii) low-quality safety net.
- `?render=force` and `?render=skip` manual overrides on both `/api` and `/api/stream`.
- Frontend status line under the spinner with i18n (DE/EN); EventSource auto-falls-back to plain fetch on transport failure.
- `client_mode` query-param fallback so PWA-originated SSE requests keep their attribution.
- Cache-ordering fix from the unreleased v1.0.3 included here: re-fetched URLs bubble to the top of the recents list.

### Operator notes
- The Playwright sidecar image is ~3.7 GB on disk (pulls Chromium on first build).
- `/api/stream` and `?render=force` are not rate-limited — recommended to keep PullMD behind an authenticating reverse proxy when exposed to the public internet.

---

## [1.0.2] - 2026-04-27

### Added
First public release. Self-hosted URL → Markdown service for humans and AI agents — PWA, REST, MCP, and a downloadable Claude Code skill, all from one container.

- **Multi-strategy extraction.** Cloudflare's native Markdown endpoint where available; Readability + Trafilatura running in parallel, picked by quality score elsewhere.
- **Reddit-aware path.** Auto-detects threads (incl. `redd.it` and `/s/` share links), returns post + nested comment tree with tunable `comment_depth` / `comment_limit`.
- **Refreshable share IDs.** Every conversion gets an 8-hex permalink; `GET /s/:id` re-fetches if older than 1h, falls back to the last good snapshot if the source dies.
- **Four interfaces, one codebase.** PWA frontend, REST (`/api`), MCP (`POST /mcp`, Streamable-HTTP), downloadable Claude Code skill bundle.
- **Multi-arch images** (`linux/amd64`, `linux/arm64`) on Docker Hub.

### Fixed
- First-boot DB file error on Docker volume mounts (thanks @goran-zdjelar, [#2](https://github.com/AeternaLabsHQ/pullmd/issues/2)).

---

[2.4.1]: https://github.com/AeternaLabsHQ/pullmd/releases/tag/v2.4.1
[2.4.0]: https://github.com/AeternaLabsHQ/pullmd/releases/tag/v2.4.0
[2.3.0]: https://github.com/AeternaLabsHQ/pullmd/releases/tag/v2.3.0
[2.2.0]: https://github.com/AeternaLabsHQ/pullmd/releases/tag/v2.2.0
[2.1.0]: https://github.com/AeternaLabsHQ/pullmd/releases/tag/v2.1.0
[2.0.0]: https://github.com/AeternaLabsHQ/pullmd/releases/tag/v2.0.0
[1.2.0]: https://github.com/AeternaLabsHQ/pullmd/releases/tag/v1.2.0
[1.1.3]: https://github.com/AeternaLabsHQ/pullmd/releases/tag/v1.1.3
[1.1.2]: https://github.com/AeternaLabsHQ/pullmd/releases/tag/v1.1.2
[1.1.1]: https://github.com/AeternaLabsHQ/pullmd/releases/tag/v1.1.1
[1.1.0]: https://github.com/AeternaLabsHQ/pullmd/releases/tag/v1.1.0
[1.0.2]: https://github.com/AeternaLabsHQ/pullmd/releases/tag/v1.0.2
