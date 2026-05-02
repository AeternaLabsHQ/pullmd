# Changelog

## [2.1.0] - 2026-05-02

### Added
- OAuth 2.1 Authorization Code flow with PKCE-S256 for claude.ai Web Connector and other MCP-spec-compliant clients (closes #6, #10).
  - Dynamic Client Registration (`POST /oauth/register`, RFC 7591).
  - Authorization endpoint (`GET /oauth/authorize`) with consent screen (DE/EN).
  - Token endpoint (`POST /oauth/token`) with `authorization_code` and `refresh_token` grants. Refresh tokens are rotated; reuse triggers chain-wide invalidation.
  - Revocation endpoint (`POST /oauth/revoke`, RFC 7009).
  - Discovery: `/.well-known/oauth-authorization-server` (RFC 8414) and `/.well-known/oauth-protected-resource` (RFC 9728).
  - Access tokens are JWTs (HS256), audience-bound, 1h TTL.
  - `WWW-Authenticate` 401 responses now include `resource_metadata` parameter pointing at the RS metadata document.
- Rate limiting on `/oauth/token` and `/oauth/authorize` (60 req/min/IP) and `/oauth/register` (10 req/h/IP).

### Changed
- `lib/auth.js` middleware now accepts a third bearer-token type (OAuth JWT) via an injected verifier. Sessions and API keys (`pmd_*`) work unchanged.

### Configuration
- New env var `OAUTH_JWT_SECRET` enables OAuth. Must be 32+ chars.
- `PUBLIC_URL` is required when OAuth is enabled (used as JWT iss/aud and in discovery metadata).

## v2.0.0 — 2026-XX-XX

**Breaking:** PullMD now supports an authentication system. Existing installs keep working unchanged (default `PULLMD_AUTH_MODE=disabled`); operators who want auth must follow [`MIGRATION.md`](./MIGRATION.md).

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
