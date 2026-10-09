# Migrating from v3.12.x to v3.13.0

v3.13.0 has no breaking API change and no database schema change. It changes how PullMD reads forwarding headers, which matters if a reverse proxy sits in front of it. Instances started from the bundled `docker-compose.traefik.yml` are configured correctly out of the box; instances reached directly on their port are not affected.

## Action required if you run behind a reverse proxy

Until v3.12, PullMD read `X-Forwarded-For`, `X-Forwarded-Proto` and `X-Forwarded-Host` from every request. From v3.13 it uses them only when `PULLMD_TRUST_PROXY` says the connecting peer is a proxy. The setting is off by default.

**1. Set `PULLMD_TRUST_PROXY`.**

| Value | Meaning |
| ----- | ------- |
| unset, empty, `false`, `off`, `no`, `0` | Off (default). Forwarding headers are ignored. |
| `1`, `2`, ... | Hop count: trust that many proxies in front of PullMD. `1` for a single reverse proxy. |
| `true`, `yes`, `on` | Trust every hop. |
| comma-separated list | Addresses, CIDRs or the keywords `loopback`, `linklocal`, `uniquelocal`, e.g. `172.18.0.0/16`. An invalid list logs a warning at startup and leaves the setting off. |

A hop count trusts whatever connects to PullMD. Use it only when the container is reachable through the proxy alone (the Traefik compose file publishes no port, which is why it defaults to `1`). If the port is also published directly, as in the default `docker-compose.yml`, either stop publishing it or list the proxy's address or network instead of a count.

The compose files list environment variables one by one, so a variable reaches the container only through its own line. If you maintain your own compose file, add:

```yaml
      - PULLMD_TRUST_PROXY=${PULLMD_TRUST_PROXY:-}
```

Without the setting, every request appears to come from the proxy's address, and all clients share one rate-limit bucket:

- 10 login attempts per minute and 5 signups per hour (new in v3.13),
- 120 lookups of unknown share ids per minute,
- the OAuth endpoint limits (60 per minute for authorize and token, 10 registrations per hour),
- the hourly media-provider budget (`PULLMD_LLM_RATE_LIMIT`) of callers who are not signed in.

The first request that carries `X-Forwarded-For`, `Forwarded` or `X-Forwarded-Proto` while the setting is off logs, once per process:

```
Requests arrive through a proxy but PULLMD_TRUST_PROXY is not set: all clients share one rate-limit bucket and the client address is the proxy's. See MIGRATION.md.
```

**2. Set `PUBLIC_URL`** to the public origin, e.g. `PUBLIC_URL=https://pullmd.example.com`. Two things used to follow `X-Forwarded-Proto` / `X-Forwarded-Host` from any request and now follow them only through a trusted proxy:

- the session cookie's `Secure` flag. It is set when the request arrived over HTTPS (directly, or through a trusted proxy) or when `PUBLIC_URL` starts with `https://`. A TLS-terminating proxy plus an `https://` `PUBLIC_URL` keeps the flag even without `PULLMD_TRUST_PROXY`.
- the base URL on `/help`, in `/pullmd.zip` and in MCP share URLs, when `PUBLIC_URL` is unset.

Both bundled compose files set a `PUBLIC_URL` default (`https://${HOST_DOMAIN}` and `http://localhost:${PORT}`); set it explicitly if your public origin is something else.

**3. Check the `Host` header and `Referrer-Policy`.** `POST /login`, `/signup`, `/logout` and `/oauth/consent` are now accepted only when the browser's `Origin` header (or, without one, `Referer`) names the host the request arrived for or the host of `PUBLIC_URL`. Only hostnames are compared, so `https` in front of a plain-HTTP container is fine. Posts carrying neither header, such as scripted requests, are accepted.

- A proxy that rewrites `Host` to an internal name (for example `pullmd:3000`) makes the request's own host differ from what the browser sends. Set `PUBLIC_URL` to the public origin, or have the proxy pass the original `Host` through. Otherwise login answers `403 Forbidden: form posts are accepted from this site only.`
- Do not serve PullMD with `Referrer-Policy: no-referrer`, whether from the proxy or an injected header. Under that policy browsers send `Origin: null` and no `Referer` on form posts, and such a post is refused. The browser default (`strict-origin-when-cross-origin`) and `same-origin` both work. PullMD sets no `Referrer-Policy` of its own.

## Other changes to check

- **OAuth access tokens work only on `/mcp`.** They were always issued for the MCP endpoint (audience `<PUBLIC_URL>/mcp`); other routes, `/api/me` included, no longer accept them. Scripts that call `/api` should use an API key from `/settings`.
- **MCP `list_recent` follows the history scope.** Signed-in callers see their own conversions, the same as `GET /api/history`. With auth disabled and `DISABLE_PUBLIC_HISTORY=true`, the tool returns an error result instead of the shared list.
- **`/api/stats`** omits `lowQualityDomains` and `fallbackByDomain` unless the caller is the admin, or auth is off and public history is on. The aggregate counts are unchanged.
- **Media-provider budget.** Image captioning, audio transcription and PDF OCR share `PULLMD_LLM_RATE_LIMIT` requests per hour (default `30`), per signed-in user or per client address. Over budget, PullMD returns what it would return without a provider (metadata for images and audio, the regular markitdown conversion for PDFs) and does not cache that result. Set `PULLMD_LLM_RATE_LIMIT=0` to turn the budget off, or a higher value for busy instances.
- **Outbound size limit.** Fetched pages and documents, and the Playwright sidecar's response, are limited to `PULLMD_MAX_FETCH_BYTES` (default 50 MB); a page fetch also has to finish within 60 s. Raise the limit if you convert larger documents by URL.
- **Email rules for new accounts.** Signup and `scripts/admin.js create-user` reject addresses without a dotted domain or with whitespace and some punctuation. Existing accounts, including a bootstrap admin like `admin@localhost`, log in as before.

## Pin tags and rolling back

```yaml
image: aeternalabshq/pullmd:3.13.0
```

There is no schema change, so rolling back is a matter of pinning `aeternalabshq/pullmd:3.12.1` again. `PULLMD_TRUST_PROXY`, `PULLMD_LLM_RATE_LIMIT` and `PULLMD_MAX_FETCH_BYTES` are ignored by older versions.

---

# Migrating from v2.x to v3.0.0

v3.0.0 is a major release with one breaking change to the response body format. No database schema changes are required - the upgrade is a drop-in image swap plus an optional `.env` tweak if you relied on the old body format.

## Breaking change: clean body by default

The inline source-attribution line that previously appeared at the top of the body (`**domain** · fetched` + url, or `**filename** · fetched` for local uploads) is no longer emitted. The same applies to Reddit posts: the meta line (`**r/sub** · u/user · N ↑ · age · date` + url) is gone from the body; subreddit, author, upvotes, and publish date are available in the frontmatter instead (`subreddit`, `author`, `upvotes`, `published`). The body now opens with `# Title` and goes straight into content.

The source URL, fetch date, and all extraction metadata are still available - unchanged - in the YAML frontmatter (e.g. `url`, `fetched`, `source`, `quality`). No frontmatter fields were removed.

**Keep the old behavior:** add `PULLMD_SOURCE_HEADER=true` to your `.env`. The legacy inline header is restored verbatim. No other configuration changes are needed.

**Plain-text callers:** if you fetch with `format=text` and relied on the inline source URL appearing in the body, either request `frontmatter=true` (the URL is in the `url:` field) or set `PULLMD_SOURCE_HEADER=true` to keep the inline header.

## New: frontmatter field allowlist

`PULLMD_FRONTMATTER_FIELDS` accepts a comma-separated list of field names to include in the YAML block (e.g. `title,url,source,llm_tokens`). Leave it unset to emit all fields (the v2.x default). Useful for agent pipelines where you want to trim frontmatter to just the fields you use.

## Renamed: Claude Code skill bundle (`web-reader` → `pullmd`)

The downloadable Claude Code skill is now named `pullmd` and served at `GET /pullmd.zip`. The old `/web-reader.zip` URL keeps working as a permanent redirect, so existing docs and scripts don't break.

**If you have the old skill installed**, installing the new zip does not replace it — Claude Code would load both side by side. Remove the old one first:

```bash
rm -rf ~/.claude/skills/web-reader
curl -O https://your-instance.example.com/pullmd.zip
unzip pullmd.zip -d ~/.claude/skills/
```

## Pin tags

Update your compose or k8s manifests to the new image tag:

```yaml
# Before
image: aeternalabshq/pullmd:2.6.0
# After
image: aeternalabshq/pullmd:3.0.0
```

The MarkItDown sidecar is optional and only needed if you use document conversion, image captioning, audio transcription, or YouTube transcript features. No sidecar update is required for v3.0.0 - the markitdown sidecar API is unchanged.

## Rolling back to v2.x

Stop the v3.0.0 container and pin back to `aeternalabshq/pullmd:2.6.0`. The database is unchanged - v2.x will work against the same `data/cache.db` without any restores.

---

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
     Since 3.8.0, self-signup can be closed with `PULLMD_ALLOW_SIGNUP=false` while staying in `multi-user` mode.
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

If you were using the Caddy workaround (or any other reverse-proxy bearer-token gate) with a fixed token, you can preserve it during migration by setting both `PULLMD_AUTH_MODE=single-admin` and `PULLMD_AUTH_TOKEN=<your-token>`. Requests with `Authorization: Bearer <your-token>` resolve to the admin user. This compat is **deprecated** and slated for removal in a future major release — generate a fresh `pmd_*` API key from `/settings` and migrate clients off the legacy token.

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
