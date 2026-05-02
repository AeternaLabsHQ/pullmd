# Migrating from v1.x to v2.0

PullMD v2.0 introduces an authentication system. Existing installations keep working unchanged — `PULLMD_AUTH_MODE=disabled` (the default) preserves v1.x behavior. This document covers the path for operators who want to enable auth.

## TL;DR

If you don't set `PULLMD_AUTH_MODE`, nothing changes. Skip the rest.

## Before you upgrade

1. Back up `./data/cache.db`. The schema migration adds tables and a column; it's idempotent and reversible by restoring the backup, but defense in depth.
2. Decide which auth mode you want:
   - `single-admin` — one user, no self-signup, simplest for homelab.
   - `multi-user` — self-signup at `/signup`, per-user history.
3. Pick admin credentials. The first startup with auth enabled requires `PULLMD_ADMIN_EMAIL` + `PULLMD_ADMIN_PASSWORD`.

## Upgrading

1. Pull v2.0 (Docker: `docker compose pull && docker compose up -d` after editing `.env`).
2. Add to your `.env`:
   ```
   PULLMD_AUTH_MODE=single-admin           # or multi-user
   PULLMD_ADMIN_EMAIL=you@example.com
   PULLMD_ADMIN_PASSWORD=change-me-please
   ```
3. Restart. The first start runs an idempotent migration:
   - Creates `users`, `sessions`, `api_keys`, `user_fetches` tables.
   - Adds `user_id` column to `conversions`.
   - Bootstraps the admin user from your env vars.
   - Backfills every existing cache row to the admin.
4. Visit `/login`, sign in, go to `/settings`, generate an API key for each programmatic client.
5. Update those clients to send `Authorization: Bearer pmd_xxx`.

## What changed for end-users

- `/api`, `/api/stream`, `/mcp`, `/api/history`, `/api/archive` now require auth in non-`disabled` modes.
- `/s/:id` share links remain public, by design.
- Aggregate endpoints (`/api/stats`, `/api/storage`, `/api/config`) remain public.

## Legacy `PULLMD_AUTH_TOKEN`

If you were using the Caddy workaround (or any other reverse-proxy bearer-token gate) with a fixed token, you can preserve it during migration by setting both `PULLMD_AUTH_MODE=single-admin` and `PULLMD_AUTH_TOKEN=<your-token>`. Requests with `Authorization: Bearer <your-token>` resolve to the admin user. This compat is **deprecated** and will be removed in v3.0 — generate a fresh `pmd_*` API key from `/settings` and migrate clients off the legacy token.

## Resetting an admin password

If the admin loses their password, the env vars do **not** override the stored hash. Use the CLI:

```
docker compose exec pullmd node scripts/admin.js reset-password admin@example.com
```

You'll be prompted for the new password. All existing sessions for that user are invalidated.

## Known trade-offs (Phase 1)

- **No CSRF tokens.** Session cookies use `SameSite=Lax`, which blocks cross-site `POST` from third-party origins. Form CSRF tokens were not added in Phase 1 — Phase 2 will introduce them.
- **No rate limiting.** Brute-force protection on `/login` is not implemented. Run behind a reverse proxy that does rate limiting if your instance is public.
- **No password reset by email.** SMTP isn't wired up. Admins use the CLI.
- **Per-share access control is `public`.** Anyone with a `/s/:id` link can read it. Phase 1 keeps the v1.x share-link semantics intact.
- **Phase 2 (OAuth for `claude.ai` web)** is tracked in #6 and depends on the user system shipped here.

## Rolling back to v1.x

If something goes wrong:

1. Stop the v2 container.
2. Restore your pre-upgrade `data/cache.db` backup.
3. Pin to a v1.x image tag (e.g. `aeternalabshq/pullmd:1.2.0`).
4. Restart.

The `users`/`sessions`/`api_keys`/`user_fetches` tables and the `user_id` column on `conversions` are unused by v1.x and can stay if you're not restoring; v1.x ignores them.

## Upgrading from 2.0 to 2.1

Additive — no breaking changes. To enable the OAuth flow for claude.ai Web Connector:

1. Set `OAUTH_JWT_SECRET` (32+ chars, generate via `openssl rand -hex 32`).
2. Ensure `PUBLIC_URL` is set to your public origin.
3. Restart. Existing API keys, sessions, and the legacy `PULLMD_AUTH_TOKEN` continue working unchanged.

If `OAUTH_JWT_SECRET` is unset, the OAuth endpoints simply aren't mounted and PullMD behaves exactly as in 2.0. Database migrations are idempotent — empty `oauth_*` tables are created on first start regardless.
