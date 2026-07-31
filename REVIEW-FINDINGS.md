# Security & Code Review — feat/multi-user

Review scope: 14 commits on `feat/multi-user` (a0a03fa..ce2cd3a) implementing
the v2.0 multi-user authentication system per issue #5.

Reviewer: claude-opus-4-7. Method: full read of all auth-related source and
tests, threat-modeled against OWASP top-10 and the explicit checklist in the
review brief.

---

## CRITICAL

### C-1 — API key leaks into URL on key creation

`POST /api/keys` redirects to `/settings?new_key=pmd_<32 chars>` after creating
a new key (`lib/auth.js:399`). The freshly-minted key — the only secret that
is never re-shown to the user — ends up in:

- Browser history (`history.pushState` and the bar URL)
- HTTP server access logs (request line includes the query string)
- `Referer:` headers if the user clicks any external link from the loaded
  `/settings` page (the green "save this key" banner contains no external
  links, but the rendered `<form action="/api/keys/:id/revoke">` does mean
  any later navigation may leak it via referer if a third-party iframe is
  ever embedded)
- Any reverse-proxy access log (Traefik on `eiche` writes them by default)

**Fix:** flash-message via the `sessions` table — store the new key as JSON in
a `flash_data` column on the user's session row, redirect to `/settings`
without query params, then read-and-clear on render. Implemented in this
review (see Fixes section).

---

## SHOULD FIX

### S-1 — `?next=` open-redirect bypass via backslash

`POST /login` (`lib/auth.js:337`) gates the `next` redirect target with
`next.startsWith('/') && !next.startsWith('//')`. This blocks
`//evil.com` but **not** `/\evil.com`: Chrome and Firefox both normalise
`\` to `/` in URL paths, treating `/\evil.com` as protocol-relative
`//evil.com` — i.e. the user is redirected off-site after sign-in.

Exploitation: send a victim a link like
`https://pullmd.example.com/login?next=/\evil.com/phish`, they sign in, and
end up on the attacker's page (still trusting they're on PullMD).

**Fix:** also reject `next.startsWith('/\\')` and `next.includes('\\')` in
the safety check. Implemented in this review.

### S-2 — Any logged-in user can wipe the global cache

`DELETE /api/cache/:id` and `DELETE /api/cache` (`server.js:536-555`) are
gated only by `requireAuth()` — *any* authenticated user can delete cache
rows. Because the cache is **global** (URL-deduped, shared across all users
via `user_fetches`), this means in `multi-user` mode a regular signed-up
user can:

- Delete arbitrary admin or other-user history entries
- Nuke the entire cache for everyone with one `DELETE /api/cache`

The frontend doesn't expose this to non-admins, but the endpoint does.
Bug, not theoretical — anyone who reads the OSS source can `curl` it.

**Fix:** require `req.user.is_admin` in non-`disabled` modes. Disabled mode
keeps current behaviour (no auth, anyone can delete). Implemented in this
review.

Superseded in 3.8.0: a non-admin delete is now scoped to the caller's own
history instead of rejected outright. See the README's Auth boundary
section for the current behaviour.

---

## NICE TO HAVE — follow-ups, not release blockers

### N-1 — `generateKeyBody` modulo bias (cosmetic)

`bytes[i] % 62` over a uniform 0-255 byte slightly favours chars 0-7 (256 %
62 = 8 over-represented values). Per-char entropy drops from ~5.954 bits to
~5.952 bits — across 32 chars that's ~190.5 bits of entropy, still vastly
above any practical attack threshold. Pure rejection sampling would be
cleaner but has zero security impact at the current scale.

### N-2 — `user_fetches.cache_id` has no foreign key

`user_fetches.cache_id` (`lib/cache.js:82`) is just an INTEGER without
`REFERENCES conversions(id) ON DELETE CASCADE`. When a cache row is
deleted, orphaned `user_fetches` rows linger — they're filtered out by the
`JOIN` in history queries, so no user-visible bug, but they accumulate.

Adding a FK to an existing column in SQLite requires a table-rebuild
migration — not worth it for a tidiness issue. A periodic prune query
would do.

### N-3 — `generateShareId` is 32-bit (existing v1 issue)

Pre-existing in v1 — share-link IDs are 4 bytes random (32 bits). Birthday
collision probability becomes meaningful around 65k entries. Out of scope
for v2.0 but worth tracking as a separate issue.

### N-4 — No login/signup rate limiting (already documented)

`MIGRATION.md` documents this as a Phase 1 known-trade-off: brute-force on
`/login` and `/signup` is unmitigated. Reverse-proxy rate-limiting is the
escape hatch. Acceptable for a homelab-first OSS tool — `claude.ai`-grade
public deployment would need fail2ban / `express-rate-limit` /
Cloudflare Turnstile in front.

### N-5 — `isSecureRequest` trusts `X-Forwarded-Proto` from any peer

`req.headers['x-forwarded-proto'] === 'https'` is consulted without
`app.set('trust proxy', ...)`. Mostly harmless — the only effect is that
a spoofed `X-Forwarded-Proto: https` over a plain-HTTP connection causes
the server to set `Secure` on the cookie, which the browser then drops.
Worst-case is a session that fails to set, not a session that leaks.

If we ever care about `req.ip` or `req.protocol` correctness elsewhere,
set `app.set('trust proxy', 'loopback, linklocal, uniquelocal')` or
`'X.X.X.X/Y'` matching the upstream proxy.

### N-6 — Legacy `PULLMD_AUTH_TOKEN` contains no length/entropy minimum

`runMigration` accepts whatever string is passed and stores its SHA-256.
A user who sets `PULLMD_AUTH_TOKEN=foo` would have a guessable token. The
deprecation note in `MIGRATION.md` says "compat is **deprecated** and
will be removed in v3.0" — fine, but the doc could add a sentence
recommending a 32+ char random string. Optional.

---

## LOOKS GOOD — explicitly correct, do not regress

### Password hashing
- ✅ Argon2id (line 7), with `type` re-asserted on every call so callers
  cannot downgrade to argon2i/d (`lib/auth.js:20`).
- ✅ Production params `t=3, m=64MiB, p=4` exceed OWASP `m=19MiB, t=2`
  recommendation.
- ✅ Test-only override (`argon2Opts`) is wired so tests run in <100ms each
  without touching prod params.
- ✅ `verifyPassword` returns `false` (never throws) on malformed hashes.

### Sessions
- ✅ Token is `randomBytes(32).toString('hex')` — 256 bits of entropy, well
  above the 128-bit OWASP floor.
- ✅ Cookie sets `HttpOnly`, `SameSite=Lax`, `Path=/`, and conditional
  `Secure` (HTTPS only).
- ✅ Sliding expiry: bumped at most once per minute (avoids write-storm).
- ✅ Expired sessions pruned on every `createSession`.
- ✅ Logout deletes the session row server-side (not just clears the cookie).

### API keys
- ✅ Stored as SHA-256, the prefix stored separately for display.
- ✅ Lookup is by hash (b-tree index) — attacker-controlled input cannot
  influence which row matches without preimage of SHA-256.
- ✅ `pmd_<32-char-base62>` ≈ 190 bits of entropy.
- ✅ `revokeApiKey` is scoped to the user (`WHERE id = ? AND user_id = ?`).
  Test `auth-keys.test.js:72` explicitly verifies that User A cannot revoke
  User B's key.
- ✅ `listApiKeys` excludes `key_hash` from the output (`auth-keys.test.js:60`).

### User enumeration / timing
- ✅ `authenticate()` runs a **dummy** `argon2.verify()` against a fixed
  fake hash when the email doesn't exist (`lib/auth.js:228`). This makes
  unknown-email and wrong-password indistinguishable in timing.
- ✅ Legacy `PULLMD_AUTH_TOKEN` comparison goes through
  `timingSafeEqString` (`lib/auth.js:42`).

### SQL injection
- ✅ Every query uses `db.prepare(...)` with `?` placeholders. No string
  concatenation anywhere. Includes `scripts/admin.js`.

### CSRF posture
- ✅ Session cookie is `SameSite=Lax`. Cross-origin `POST /logout`,
  `POST /api/keys`, `POST /api/keys/:id/revoke` all fail to attach the
  cookie → 401.
- ✅ Logout is `POST` (not `GET`) so `<img src="/logout">` style attacks
  don't work.
- ⚠️ No double-submit token / hidden form token. `MIGRATION.md` documents
  this as a Phase 1 trade-off; SameSite=Lax is an adequate default for
  the current threat model.

### Validation
- ✅ Email lower-cased and trimmed before insert/lookup.
- ✅ Password length floor enforced both client-side (`minlength=8`) and
  server-side.
- ✅ API key label clamped to 100 chars (`lib/auth.js:394`).
- ✅ `formParser` capped at `8kb`.

### Schema & migration
- ✅ `runMigration` is idempotent (test `auth-modes.test.js:49` runs it
  three times in a row).
- ✅ Foreign keys ON (`PRAGMA foreign_keys = ON`); CASCADE on session/key
  deletion when a user is removed; `SET NULL` on `conversions.user_id`
  so cache survives user deletion (test `cache-users.test.js:42, 56`).
- ✅ Existing v1 cache rows are backfilled to admin on first migration
  (`auth-modes.test.js:91`).

### Auth-mode separation
- ✅ `disabled` is a true no-op — `runMigration` returns early, middleware
  passes through, `requireAuth` is a passthrough, `/login` /signup`
  /settings are not mounted.
- ✅ `single-admin` blocks `/signup` (returns 404) — verified in
  `auth-routes.test.js:183`.
- ✅ `multi-user` blocks legacy token even if `PULLMD_AUTH_TOKEN` is set
  (`auth-middleware.test.js:110`).
- ✅ `req.user` is the single abstraction over session / API key / legacy
  token — keeps the door open for OAuth (Phase 2 / #6) without a
  re-architecture.

### Route protection
- ✅ Protected: `/api`, `/api/stream`, `/api/history`, `/api/archive`,
  `/api/cache/:id`, `/api/cache`, `/mcp`, `/settings`, `/api/keys*`.
- ✅ Public: `/`, `/help`, `/web-reader.zip`, static assets, `/s/:id`,
  `/share`, `/api/stats`, `/api/storage`, `/api/config`.
- ✅ `/s/:id` share links explicitly stay public (design choice, documented
  in MIGRATION.md).
- ✅ Static middleware comes before auth middleware — `/favicon.ico`
  doesn't need `req.user`. ✓

### Server-rendered HTML
- ✅ `escape()` HTML-escapes the email and error messages on login /
  signup / settings pages (`lib/auth-pages.js:62`). Tested implicitly via
  the route tests.
- ✅ The new key banner uses `escape(newKey)` even though the key body is
  alphanumeric — defense in depth.

### Admin CLI
- ✅ Reads password from raw stdin without echo (`scripts/admin.js:31`).
- ✅ Resetting a password invalidates all of that user's sessions
  (`scripts/admin.js:21`, tested at `auth-admin-cli.test.js:29`).
- ✅ Same `argon2Opts` flow as the live app — no risk of producing a
  prod-incompatible hash from the CLI.

### Test coverage
- ✅ 8 new test files, full coverage of: hashing, sessions, keys, middleware,
  modes, routes, integration, admin CLI, cache schema, per-user history.
- ✅ All three auth modes exercised in middleware + integration tests.
- ✅ Session expiry tested (`auth-sessions.test.js:39`).
- ✅ Migration idempotence and cache backfill tested.

### Documentation
- ✅ `MIGRATION.md` is thorough: pre-upgrade checklist, env vars, what
  changes for end-users, legacy token compat, password reset, known
  trade-offs, rollback plan.
- ✅ `CHANGELOG.md` flags the breaking change clearly.
- ✅ `.env.example` documents `PULLMD_AUTH_MODE`, `PULLMD_ADMIN_EMAIL`,
  `PULLMD_ADMIN_PASSWORD`, `PULLMD_AUTH_TOKEN` with usage notes.

---

## Verdict

**Merge-ready after the C-1 / S-1 / S-2 fixes land** (implemented in this
review and committed). Test suite stays green. The Phase-1 trade-offs
(no CSRF tokens, no login rate limit, no password-reset email) are all
clearly disclosed in `MIGRATION.md` and acceptable for a homelab-first
OSS tool.

Forward compatibility for OAuth (issue #6) is preserved: `req.user` is
the single abstraction; adding a new bearer or cookie path doesn't
require touching the route layer.
