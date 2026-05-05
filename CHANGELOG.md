# Changelog

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
