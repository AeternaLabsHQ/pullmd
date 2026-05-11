# Migrating from v2.2.x to v2.3.0

v2.3.0 ships the OAuth 2.1 Authorization Code flow for the claude.ai web custom connector and Claude Desktop's custom-connector dialog (#6, #10). Pure additive change — existing instances keep working unchanged unless you opt in by setting `OAUTH_JWT_SECRET`.

## Pin v2 tags explicitly

`:latest` stays on v1.x. Update your compose / k8s manifests:

```yaml
# Before
image: aeternalabshq/pullmd:2.2.0
# After
image: aeternalabshq/pullmd:2.3.0
```

The Playwright and Trafilatura sidecars don't need a bump for this release — v2.2.0 sidecars work with v2.3.0 pullmd. But there's no harm in bumping them together for consistency.

## Enable OAuth (optional)

OAuth is opt-in. If you don't set `OAUTH_JWT_SECRET`, nothing changes.

1. Generate a JWT signing secret (32+ chars):

   ```
   openssl rand -hex 32
   ```

2. Add to your `.env`:

   ```
   OAUTH_JWT_SECRET=<the hex string>
   PUBLIC_URL=https://your-host.example.com
   ```

   `PUBLIC_URL` is required when OAuth is enabled (used as JWT issuer + audience and in discovery metadata).

3. Restart. The first boot creates the `oauth_clients`, `oauth_auth_codes`, and `oauth_refresh_tokens` tables.

4. In claude.ai web or Claude Desktop, add a custom connector pointing at `<PUBLIC_URL>/mcp`. The connector dialog will discover the server's OAuth metadata, register itself via DCR, and walk the user through the consent screen.

## Schema migrations

The three `oauth_*` tables are created automatically on first boot — no manual SQL. They have foreign-key constraints onto `users` and cascade on delete.

## Rolling back to v2.2.x

OAuth tables are unused by v2.2.x and earlier, and can stay in the database without harm. Just pin to a v2.2.x image tag.

---

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

# Migrating from v2.1.x to v2.2.0

v2.2.0 ships the Site Recipe Engine (#18). Pure additive change — existing instances keep working unchanged. This section covers what to know if you want to use recipes.

## Pin v2 tags explicitly

`:latest` stays on v1.x until 2026-05-16. Update your compose / k8s manifests:

```yaml
# Before
image: aeternalabshq/pullmd:latest
# After
image: aeternalabshq/pullmd:2.2.0
# Also bump the playwright sidecar — wait_for and mobile_ua need the new sidecar:
image: aeternalabshq/pullmd-playwright:2.2.0
```

## Optional: mount user recipes

The default recipes in `site-recipes.default.json` cover Future PLC sites and GitHub Issues out of the box. To add your own:

```yaml
services:
  pullmd:
    image: aeternalabshq/pullmd:2.2.0
    volumes:
      - ./data:/app/data
    # Drop your custom recipes at ./data/site-recipes.json on the host
    # PullMD auto-discovers it. Or set PULLMD_SITE_RECIPES to a different path:
    environment:
      - PULLMD_SITE_RECIPES=/path/to/your/recipes.json
```

User recipes are concatenated with the defaults. On scalar conflicts (e.g. both define `extractor` for the same host), the user file wins via ordering.

## Schema migrations

The `meta` table is created automatically on first boot — no manual SQL. Existing cache rows remain valid until the first recipe content change is detected (the SHA256 of recipe file content is hashed at boot; on change, `recipes_invalidated_at` is bumped and old cache rows lazy-refresh on next access).

## Monitoring

`GET /api/recipes/status` returns `{ ok, loaded, rejected, sources }` — public, no auth. Add it to UptimeKuma / Healthchecks / equivalent to be alerted when a recipe fails to parse:

```json
{
  "ok": true,
  "loaded": 5,
  "rejected": 0,
  "sources": [
    { "path": "site-recipes.default.json", "loaded": 4, "rejected": 0 },
    { "path": "/app/data/site-recipes.json", "loaded": 1, "rejected": 0 }
  ]
}
```

`ok = (rejected === 0)`. HTTP always returns 200; use the `ok` field for monitoring decisions. Rejection details are in stderr at server start (`docker logs pullmd | grep recipes`).

## Rolling back to v2.1.x

The schema change is additive (new `meta` table, no column changes on existing tables). To roll back:

1. Stop v2.2.0 container.
2. Pin to `aeternalabshq/pullmd:2.1.0`.
3. Restart. The `meta` table stays — v2.1.x ignores it.
