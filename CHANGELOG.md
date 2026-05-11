# Changelog

## v2.4.0 — 2026-05-11

### Added

- **Rendered Markdown view in the PWA** (closes #23). New `Raw | Rendered` segmented toggle in the result header lets users see the fetched output as actual formatted HTML (headings, lists, links, images, tables, blockquotes, code blocks) instead of the raw source. Raw remains the default; the chosen mode is persisted in `localStorage` (`pullmd-view-mode`).
  - GFM rendering via self-hosted [marked](https://github.com/markedjs/marked) v12.0.2 (~30KB).
  - HTML sanitization via self-hosted [DOMPurify](https://github.com/cure53/DOMPurify) v3.4.2 (~20KB). Strips scripts, inline styles, event handlers, `javascript:` URLs.
  - Rendered links open in a new tab with `rel="noopener noreferrer"`.
  - Lazy first-render: the rendered DOM is only built when the user first switches to Rendered for a given result, so users who only ever copy raw Markdown pay no rendering cost.
  - Copy button still copies the raw Markdown source regardless of active view.
  - Both themes (dark + paper) styled via existing CSS variables — no new tokens.
- Service Worker precaches the new vendor files (`vendor/marked.min.js`, `vendor/purify.min.js`) so the rendered view also works offline in the installed PWA. `CACHE_NAME` bumped to `pullmd-v20`.

### Notes

- Out of scope for v2.4.0: syntax highlighting, math/diagrams, Reddit-style spoiler syntax, side-by-side view, rendered view for `/s/:id` share links (still pure `text/markdown`).
- `:latest` policy unchanged from v2.3.0 — `:latest` still points at v1.2.x; self-hosters wanting v2.4 must pin `:2.4` or `:2.4.0`.

## v2.3.0 — 2026-05-11

### Added

- **OAuth 2.1 Authorization Code flow** with PKCE-S256 for the claude.ai web custom connector, Claude Desktop's custom-connector dialog, and other MCP-spec-compliant clients (closes #6, #10).
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

### Important — `:latest` tag stays on v1.x

Same policy as v2.2.0. The `:latest` tag in Docker Hub and GHCR remains pinned to v1.2.x. Self-hosters wanting OAuth **must pin `:v2.3.0`** (or `:2.3`) explicitly:

```yaml
services:
  pullmd:
    image: aeternalabshq/pullmd:2.3.0
```

### Migration

- New tables `oauth_clients`, `oauth_auth_codes`, `oauth_refresh_tokens` are created automatically on first boot. No manual SQL.
- OAuth is **opt-in** — without `OAUTH_JWT_SECRET`, behavior is unchanged from v2.2.x.
- See `MIGRATION.md` for the full upgrade path.

## v2.2.0 — 2026-05-06

### Added

- **Site Recipe Engine** (#18). Declarative `site-recipes.json` for per-host preprocess, fetch, select, and extractor rules. Default recipes ship in the repo (`site-recipes.default.json`); self-hosters can mount `data/site-recipes.json` or set `PULLMD_SITE_RECIPES` to point elsewhere. Four recipe categories:
  - `preprocess` — DOM cleanup actions (`remove-attr`, `remove-class`, `remove-element`, `unwrap`) applied before extraction
  - `fetch` — render forcing (`render: force|skip`), wait-for selector, mobile UA
  - `select` — extra remove-selectors added to `cleanDom`
  - `extractor` — preferred extractor per host (`readability`, `trafilatura`, `playwright`)
- New endpoint `GET /api/recipes/status` (public, no auth) — counts loaded/rejected recipes per source for monitoring.
- Cache invalidation on recipe change. When recipe content changes between server boots, all cache rows become stale and re-extract on next access (lazy, on-demand).
- Playwright sidecar accepts new optional fields: `waitFor` (CSS selector), `waitTimeoutMs` (capped at 15000), `mobileUa` (boolean). Backwards compatible — old fields are silently passed through.
- Initial default recipes covering Future PLC sites (paywall + recommendation widgets) and GitHub Issues (JS-rendered comments).
- The Playwright sidecar bundles `playwright-stealth` to mitigate `navigator.webdriver`-style headless detection on JS-driven anti-bot pages.

### Known limitations

- **Sites behind cookie-based consent walls** (third-party CMP frameworks like TCF v2) are not unlocked by recipes alone in this release. Such sites redirect non-consenting visitors to a JS-rendered consent UI and only return article content once HttpOnly cookies are set after a click. A future release will add a `fetch.cookies` recipe field so operators can paste their own consent state when they choose to. For now, write a custom recipe with whatever combination of `select.remove`, `extractor`, and `fetch` settings works for your specific source — the engine supports the experimentation, the defaults stay conservative.

### Important — `:latest` tag stays on v1.x

The `:latest` tag in Docker Hub and GHCR remains pinned to v1.x until the scheduled flip on 2026-05-16. Self-hosters wanting the recipe engine **must pin `:v2.2.0`** (or `:2.2`) explicitly for both `pullmd` and `pullmd-playwright`. Pulling `:latest` continues to give you v1, **without** the recipe engine.

```yaml
services:
  pullmd:
    image: aeternalabshq/pullmd:2.2.0
  playwright:
    image: aeternalabshq/pullmd-playwright:2.2.0
```

### Migration

- New `meta` table created automatically on first boot. No action required.
- Existing cache rows remain valid until the first recipe content change is detected.
- See `MIGRATION.md` for the full upgrade path.

## v2.1.0 — 2026-05-05

### Added
- PWA: persist frontmatter toggle, comments toggle and comment depth across reloads via `localStorage` (keys `pullmd-frontmatter`, `pullmd-comments`, `pullmd-comment-depth`). Closes #20.

## v2.0.0 — 2026-XX-XX

**Breaking:** PullMD now supports an authentication system. Existing installs keep working unchanged (default `PULLMD_AUTH_MODE=disabled`); operators who want auth must follow [`MIGRATION.md`](./MIGRATION.md).

> **Pulling v2.x:** Use the explicit `:2` tag (or `:2.0`, `:2.0.0`).
> The `:latest` tag remains on v1.x for backward compatibility 
> until v2.x has stabilized in real-world deployments.
> 
> ```yaml
> services:
>   pullmd:
>     image: aeternalabs/pullmd:2
> ```

### Added
- Three auth modes (`disabled` / `single-admin` / `multi-user`) controlled by `PULLMD_AUTH_MODE`.
- Web sessions: `POST /login`, `POST /logout`, `GET /signup`, `GET /api/me`, server-rendered HTML for `/login` and `/signup`.
- Per-user API keys: `pmd_<32-char-base62>` format, sent as `Authorization: Bearer pmd_xxx`. Manage at `/settings`. Stored as SHA-256 hashes.
- Per-user history: `/api/history` and `/api/archive` are scoped to `req.user` when authenticated.
- Admin CLI: `node scripts/admin.js {list-users,reset-password,make-admin}`.
- Schema: `users`, `sessions`, `api_keys`, `user_fetches` tables, plus `conversions.user_id`.

### Changed
- `/api`, `/api/stream`, `/mcp`, `/api/history`, `/api/archive`, `/api/cache/:id`, `DELETE /api/cache` require auth when mode != `disabled`.
- `/s/:id` share links remain public in all modes (design choice).
- `/api/config` now exposes `authMode`.

### Deprecated
- `PULLMD_AUTH_TOKEN` (legacy bearer compat) — works only in `single-admin` mode, removed in v3.0.

### Migration
See `MIGRATION.md`.

## v1.2.0 — 2026-05-02

(see git log for v1.x entries)
