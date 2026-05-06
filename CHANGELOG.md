# Changelog

## v2.2.0 — 2026-05-XX

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
