import argon2 from 'argon2';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import express from 'express';
import { loginPage, signupPage, settingsPage } from './auth-pages.js';

const PROD_ARGON2_OPTS = {
  type: argon2.argon2id,
  timeCost: 3,
  memoryCost: 65536,
  parallelism: 4,
};

/**
 * Hash a password with Argon2id.
 * @param {string} password
 * @param {object} [opts] override params (used by tests for speed)
 * @returns {Promise<string>} argon2 encoded hash
 */
export async function hashPassword(password, opts = {}) {
  const params = { ...PROD_ARGON2_OPTS, ...opts, type: argon2.argon2id };
  return argon2.hash(password, params);
}

/**
 * Verify a password against an argon2 hash. Returns false (never throws) on malformed hashes.
 */
export async function verifyPassword(hash, password) {
  try {
    return await argon2.verify(hash, password);
  } catch {
    return false;
  }
}

const SESSION_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const SESSION_SLIDE_MIN_MS = 60 * 1000; // bump expiry at most once per minute

function isoFromMs(ms) {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, '').replace('T', ' ');
}

function timingSafeEqString(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * True when v1 auth-token compat is set but the v2 auth mode is not — i.e.
 * the operator upgraded from v1 with PULLMD_AUTH_TOKEN in their .env, but
 * never set PULLMD_AUTH_MODE. The v1 token now does nothing and the
 * instance is silently unauthenticated.
 */
export function detectAuthMisconfig(env = {}) {
  if (!env.PULLMD_AUTH_TOKEN) return false;
  const mode = env.PULLMD_AUTH_MODE;
  return mode !== 'single-admin' && mode !== 'multi-user';
}

function logMisconfigBanner(logger = console.warn) {
  const bar = '='.repeat(64);
  logger(bar);
  logger('WARNING: PULLMD_AUTH_TOKEN is set but PULLMD_AUTH_MODE is not.');
  logger('In v2.0, PULLMD_AUTH_TOKEN only works when PULLMD_AUTH_MODE=single-admin.');
  logger('This instance is currently UNAUTHENTICATED.');
  logger('See MIGRATION.md for upgrade steps.');
  logger(bar);
}

/**
 * Format the bootstrap-credentials-missing error as a multi-line block.
 * Used by server.js's direct-run path to produce a readable, actionable
 * message instead of a stack trace when PULLMD_AUTH_MODE is set without
 * the matching admin env vars.
 */
export function formatBootstrapError(mode) {
  const bar = '='.repeat(64);
  return [
    bar,
    `ERROR: PULLMD_AUTH_MODE=${mode} requires bootstrap credentials.`,
    '',
    'Set the following environment variables:',
    '  PULLMD_ADMIN_EMAIL    (e.g. admin@example.com)',
    '  PULLMD_ADMIN_PASSWORD (any string, min 8 characters)',
    '',
    'Then restart the container. See MIGRATION.md for details.',
    bar,
  ].join('\n');
}

export function createAuth({ db, mode = 'disabled', env = {}, argon2Opts, warnLogger, publicUrl } = {}) {
  if (!['disabled', 'single-admin', 'multi-user'].includes(mode)) {
    throw new Error(`Invalid PULLMD_AUTH_MODE: ${mode}`);
  }

  // Misconfig: v1 token set but v2 auth mode is disabled — the instance is
  // silently unauthenticated. Warn loudly at startup; the PWA banner picks
  // up the same flag via /api/config so end-users see it too.
  const isMisconfigured = !!env.PULLMD_AUTH_TOKEN && mode === 'disabled';
  if (isMisconfigured) {
    logMisconfigBanner(warnLogger || console.warn);
  }

  const stmts = {
    insertSession: db.prepare(`
      INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)
    `),
    findSession: db.prepare(`
      SELECT s.token, s.user_id, s.expires_at, u.id AS uid, u.email, u.is_admin
      FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token = ? AND s.expires_at > datetime('now')
    `),
    deleteSession: db.prepare(`DELETE FROM sessions WHERE token = ?`),
    deleteUserSessions: db.prepare(`DELETE FROM sessions WHERE user_id = ?`),
    bumpSession: db.prepare(`UPDATE sessions SET expires_at = ? WHERE token = ?`),
    pruneSessions: db.prepare(`DELETE FROM sessions WHERE expires_at < datetime('now')`),
    setFlash: db.prepare(`UPDATE sessions SET flash_data = ? WHERE token = ?`),
    readFlash: db.prepare(`SELECT flash_data FROM sessions WHERE token = ? AND expires_at > datetime('now')`),
    clearFlash: db.prepare(`UPDATE sessions SET flash_data = NULL WHERE token = ?`),
  };

  const keyStmts = {
    insertKey: db.prepare(`
      INSERT INTO api_keys (user_id, key_hash, key_prefix, label) VALUES (?, ?, ?, ?)
    `),
    findKey: db.prepare(`
      SELECT k.id, u.id AS uid, u.email, u.is_admin
      FROM api_keys k JOIN users u ON u.id = k.user_id
      WHERE k.key_hash = ?
    `),
    bumpKeyUsed: db.prepare(`UPDATE api_keys SET last_used_at = datetime('now') WHERE id = ?`),
    listUserKeys: db.prepare(`
      SELECT id, key_prefix, label, created_at, last_used_at
      FROM api_keys WHERE user_id = ? ORDER BY created_at DESC
    `),
    deleteUserKey: db.prepare(`DELETE FROM api_keys WHERE id = ? AND user_id = ?`),
  };

  let accessTokenVerifier = null;
  function setAccessTokenVerifier(fn) {
    if (typeof fn !== 'function') throw new Error('verifier must be a function');
    accessTokenVerifier = fn;
  }

  function createSession(userId) {
    const token = randomBytes(32).toString('hex');
    const expiresAt = isoFromMs(Date.now() + SESSION_TTL_MS);
    stmts.insertSession.run(token, userId, expiresAt);
    stmts.pruneSessions.run();
    return { token, expiresAt };
  }

  // Internal: like lookupSession, but also reports whether the sliding
  // expiry was bumped — the middleware uses this to re-issue the cookie
  // with a fresh Max-Age so browser cookie and DB session slide together.
  function lookupSessionEx(token) {
    if (!token || typeof token !== 'string') return { user: null, bumped: false };
    const row = stmts.findSession.get(token);
    if (!row) return { user: null, bumped: false };

    // Sliding expiry: if the session has been bumped within the last minute,
    // don't bump again. This avoids a write per request while keeping active
    // users logged in indefinitely.
    let bumped = false;
    const expiresMs = new Date(row.expires_at + 'Z').getTime();
    const remaining = expiresMs - Date.now();
    if (SESSION_TTL_MS - remaining > SESSION_SLIDE_MIN_MS) {
      stmts.bumpSession.run(isoFromMs(Date.now() + SESSION_TTL_MS), token);
      bumped = true;
    }

    return { user: { id: row.uid, email: row.email, is_admin: !!row.is_admin }, bumped };
  }

  function lookupSession(token) {
    return lookupSessionEx(token).user;
  }

  function deleteSession(token) {
    stmts.deleteSession.run(token);
  }

  // Flash storage: persist a small JSON payload on the session row, read-and-
  // clear on next read. Used to surface a freshly-minted API key on /settings
  // without ever putting it in a URL (which would leak via browser history,
  // server access logs, and Referer).
  function setSessionFlash(token, data) {
    if (!token) return;
    stmts.setFlash.run(JSON.stringify(data ?? null), token);
  }

  function consumeSessionFlash(token) {
    if (!token) return null;
    const row = stmts.readFlash.get(token);
    if (!row || !row.flash_data) return null;
    stmts.clearFlash.run(token);
    try { return JSON.parse(row.flash_data); } catch { return null; }
  }

  function generateKeyBody(len = 32) {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    const bytes = randomBytes(len);
    let out = '';
    for (let i = 0; i < len; i++) {
      out += alphabet[bytes[i] % alphabet.length];
    }
    return out;
  }

  function sha256Hex(s) {
    return createHash('sha256').update(s).digest('hex');
  }

  function createApiKey(userId, label = null) {
    const fullKey = 'pmd_' + generateKeyBody(32);
    const keyHash = sha256Hex(fullKey);
    const prefix = fullKey.slice(0, 12);
    keyStmts.insertKey.run(userId, keyHash, prefix, label);
    return { fullKey, prefix };
  }

  function lookupApiKey(fullKey) {
    if (!fullKey || typeof fullKey !== 'string' || !fullKey.startsWith('pmd_')) return null;
    const keyHash = sha256Hex(fullKey);
    const row = keyStmts.findKey.get(keyHash);
    if (!row) return null;
    keyStmts.bumpKeyUsed.run(row.id);
    return { id: row.uid, email: row.email, is_admin: !!row.is_admin };
  }

  function listApiKeys(userId) {
    return keyStmts.listUserKeys.all(userId);
  }

  function revokeApiKey(userId, id) {
    const r = keyStmts.deleteUserKey.run(id, userId);
    return r.changes > 0;
  }

  function lookupAdmin() {
    return db.prepare("SELECT id, email, is_admin FROM users WHERE is_admin = 1 ORDER BY id ASC LIMIT 1").get() || null;
  }

  async function runMigration() {
    if (mode === 'disabled') return;

    let admin = lookupAdmin();
    if (!admin) {
      const email = (env.PULLMD_ADMIN_EMAIL || '').trim().toLowerCase();
      const password = env.PULLMD_ADMIN_PASSWORD;
      if (!email || !password) {
        const err = new Error(
          `PULLMD_AUTH_MODE=${mode} requires PULLMD_ADMIN_EMAIL and PULLMD_ADMIN_PASSWORD ` +
          `on first startup to bootstrap an admin user.`
        );
        err.code = 'ERR_BOOTSTRAP_MISSING_CREDENTIALS';
        throw err;
      }
      const hash = await hashPassword(password, argon2Opts);
      const r = db
        .prepare("INSERT INTO users (email, password_hash, is_admin) VALUES (?, ?, 1)")
        .run(email, hash);
      admin = { id: r.lastInsertRowid, email, is_admin: 1 };
    }

    db.prepare("UPDATE conversions SET user_id = ? WHERE user_id IS NULL").run(admin.id);

    // Backfill user_fetches for cache rows that were just inherited by admin —
    // /api/history reads from user_fetches, so without this the admin sees an
    // empty history after upgrading. Idempotent via LEFT JOIN ... uf.id IS NULL.
    db.prepare(`
      INSERT INTO user_fetches (user_id, cache_id, fetched_at)
      SELECT ?, c.id, c.created_at
      FROM conversions c
      LEFT JOIN user_fetches uf ON uf.cache_id = c.id AND uf.user_id = ?
      WHERE c.user_id = ? AND uf.id IS NULL
    `).run(admin.id, admin.id, admin.id);

    if (mode === 'single-admin' && env.PULLMD_AUTH_TOKEN) {
      const token = env.PULLMD_AUTH_TOKEN;
      const tokenHash = sha256Hex(token);
      const exists = db.prepare("SELECT 1 FROM api_keys WHERE key_hash = ?").get(tokenHash);
      if (!exists) {
        const prefix = token.slice(0, 12);
        keyStmts.insertKey.run(admin.id, tokenHash, prefix, 'legacy PULLMD_AUTH_TOKEN');
      }
    }
  }

  function lookupLegacyToken(token) {
    if (mode !== 'single-admin' || !token || !env.PULLMD_AUTH_TOKEN) return null;
    if (!timingSafeEqString(token, env.PULLMD_AUTH_TOKEN)) return null;
    const admin = lookupAdmin();
    return admin ? { id: admin.id, email: admin.email, is_admin: !!admin.is_admin } : null;
  }

  function validateEmail(s) {
    if (!s || typeof s !== 'string') return null;
    const e = s.trim().toLowerCase();
    const at = e.indexOf('@');
    if (at < 1 || at >= e.length - 1) return null;
    return e;
  }

  async function createUser({ email, password, isAdmin = false }) {
    const cleanEmail = validateEmail(email);
    if (!cleanEmail) throw new Error('Invalid email');
    if (!password || typeof password !== 'string' || password.length < 8) {
      throw new Error('Password must be at least 8 characters');
    }
    const hash = await hashPassword(password, argon2Opts);
    const r = db
      .prepare("INSERT INTO users (email, password_hash, is_admin) VALUES (?, ?, ?)")
      .run(cleanEmail, hash, isAdmin ? 1 : 0);
    return { id: r.lastInsertRowid, email: cleanEmail, is_admin: isAdmin };
  }

  async function authenticate(email, password) {
    const cleanEmail = validateEmail(email);
    if (!cleanEmail) return null;
    const u = db
      .prepare("SELECT id, email, password_hash, is_admin FROM users WHERE email = ?")
      .get(cleanEmail);
    if (!u) {
      // Run a dummy verify to keep timing constant; ignore the result.
      await verifyPassword('$argon2id$v=19$m=1024,t=1,p=1$xxxxxxxx$xxxxxxxx', password);
      return null;
    }
    const ok = await verifyPassword(u.password_hash, password);
    if (!ok) return null;
    return { id: u.id, email: u.email, is_admin: !!u.is_admin };
  }

  function parseCookie(header, name) {
    if (!header) return null;
    for (const part of header.split(';')) {
      const [k, ...rest] = part.trim().split('=');
      if (k === name) return rest.join('=');
    }
    return null;
  }

  function parseBearer(header) {
    if (!header || typeof header !== 'string') return null;
    const m = /^Bearer\s+(.+)$/.exec(header.trim());
    return m ? m[1].trim() : null;
  }

  // Whitelist redirect targets to same-origin absolute paths. Rejects:
  //   - non-strings / empty
  //   - protocol-relative (//evil.com)
  //   - backslash variants (/\evil.com, \\evil.com) — Chrome / Firefox
  //     normalise \ to / in URL paths, treating /\evil.com as //evil.com
  //   - anything not starting with a single /
  function safeRedirectPath(next, fallback) {
    if (typeof next !== 'string' || next.length === 0) return fallback;
    if (!next.startsWith('/')) return fallback;
    if (next.startsWith('//')) return fallback;
    if (next.includes('\\')) return fallback;
    return next;
  }

  function middleware() {
    return (req, res, next) => {
      if (mode === 'disabled') {
        req.user = null;
        return next();
      }

      const sessionToken = parseCookie(req.headers.cookie, 'pullmd_session');
      if (sessionToken) {
        const { user: u, bumped } = lookupSessionEx(sessionToken);
        if (u) {
          req.user = u;
          // Keep the browser cookie's Max-Age in sync with the DB-side sliding
          // expiry — otherwise the cookie dies a fixed TTL after login no
          // matter how active the user is.
          if (bumped) setSessionCookie(res, sessionToken, isSecureRequest(req));
          return next();
        }
      }

      const bearer = parseBearer(req.headers.authorization);
      if (bearer) {
        if (bearer.startsWith('pmd_')) {
          const u = lookupApiKey(bearer);
          if (u) { req.user = u; return next(); }
        } else if (accessTokenVerifier) {
          // OAuth JWT path. The verifier returns the user object or null.
          // It's async, so we await it before continuing.
          return Promise.resolve(accessTokenVerifier(bearer))
            .then((u) => {
              if (u) { req.user = u; return next(); }
              // Fall through to legacy token / null user
              const lu = lookupLegacyToken(bearer);
              if (lu) { req.user = lu; return next(); }
              req.user = null;
              return next();
            })
            .catch(() => { req.user = null; next(); });
        } else {
          const u = lookupLegacyToken(bearer);
          if (u) { req.user = u; return next(); }
        }
      }

      req.user = null;
      next();
    };
  }

  function wwwAuthHeader() {
    const base = (publicUrl || env.PUBLIC_URL || '').replace(/\/+$/, '');
    if (!base) return 'Bearer realm="pullmd"';
    return `Bearer realm="pullmd", resource_metadata="${base}/.well-known/oauth-protected-resource"`;
  }

  function requireAuth() {
    return (req, res, next) => {
      if (mode === 'disabled') return next();
      if (req.user) return next();
      const accept = req.headers.accept || '';
      const wantsJson = accept.includes('application/json')
        || (req.path || '').startsWith('/api')
        || (req.path || '') === '/mcp'
        || !accept.includes('text/html');
      if (wantsJson) {
        res.set('WWW-Authenticate', wwwAuthHeader());
        return res.status(401).json({ error: 'Authentication required' });
      }
      return res.redirect(302, '/login?next=' + encodeURIComponent(req.originalUrl));
    };
  }

  // Remove any pullmd_session cookie already queued on this response — the
  // sliding-refresh middleware may have appended one before the route ran.
  // Dropping it first means the caller's Set-Cookie unambiguously wins,
  // regardless of header order.
  function dropQueuedSessionCookie(res) {
    const existing = res.getHeader('Set-Cookie');
    if (!existing) return;
    const rest = (Array.isArray(existing) ? existing : [existing])
      .filter((c) => !String(c).startsWith('pullmd_session='));
    res.removeHeader('Set-Cookie');
    for (const c of rest) res.append('Set-Cookie', c);
  }

  function setSessionCookie(res, token, secure) {
    dropQueuedSessionCookie(res);
    const parts = [
      `pullmd_session=${token}`,
      'HttpOnly',
      'SameSite=Lax',
      'Path=/',
      'Max-Age=' + Math.floor(SESSION_TTL_MS / 1000),
    ];
    if (secure) parts.push('Secure');
    res.append('Set-Cookie', parts.join('; '));
  }

  function clearSessionCookie(res) {
    dropQueuedSessionCookie(res);
    res.append('Set-Cookie', 'pullmd_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
  }

  function isSecureRequest(req) {
    return req.secure || (req.headers['x-forwarded-proto'] === 'https');
  }

  function mountAuthRoutes(app) {
    if (mode === 'disabled') return;

    const formParser = express.urlencoded({ extended: false, limit: '8kb' });

    app.get('/login', (req, res) => {
      res.set('Content-Type', 'text/html; charset=utf-8');
      res.send(loginPage({ next: req.query.next || '', mode }));
    });

    app.post('/login', formParser, async (req, res) => {
      const { email = '', password = '', next = '' } = req.body || {};
      const user = await authenticate(email, password);
      if (!user) {
        res.status(401).set('Content-Type', 'text/html; charset=utf-8');
        return res.send(loginPage({ error: 'wrong_credentials', email, next, mode }));
      }
      const { token } = createSession(user.id);
      setSessionCookie(res, token, isSecureRequest(req));
      res.redirect(302, safeRedirectPath(next, '/?login=ok'));
    });

    app.post('/logout', (req, res) => {
      const token = parseCookie(req.headers.cookie, 'pullmd_session');
      if (token) deleteSession(token);
      clearSessionCookie(res);
      res.redirect(302, '/');
    });

    if (mode === 'multi-user') {
      app.get('/signup', (req, res) => {
        res.set('Content-Type', 'text/html; charset=utf-8');
        res.send(signupPage({}));
      });

      app.post('/signup', formParser, async (req, res) => {
        const { email = '', password = '', password_confirm = '' } = req.body || {};
        const errs = (key) => {
          res.status(400).set('Content-Type', 'text/html; charset=utf-8');
          return res.send(signupPage({ error: key, email }));
        };
        if (password !== password_confirm) return errs('passwords_dont_match');
        if (typeof password !== 'string' || password.length < 8) return errs('password_too_short');
        if (!validateEmail(email)) return errs('invalid_email');
        const exists = db.prepare("SELECT 1 FROM users WHERE email = ?").get(validateEmail(email));
        if (exists) return errs('email_taken');
        const noAdminYet = !lookupAdmin();
        try {
          const u = await createUser({ email, password, isAdmin: noAdminYet });
          const { token } = createSession(u.id);
          setSessionCookie(res, token, isSecureRequest(req));
          res.redirect(302, '/?signup=ok');
        } catch (err) {
          // createUser throws messages in English; map the known shapes back
          // to keys so the user gets a translated error.
          const m = err?.message || '';
          if (/Invalid email/i.test(m)) return errs('invalid_email');
          if (/at least 8/i.test(m)) return errs('password_too_short');
          return errs('create_failed');
        }
      });
    }

    app.get('/api/me', (req, res) => {
      if (!req.user) {
        res.set('WWW-Authenticate', wwwAuthHeader());
        return res.status(401).json({ error: 'Authentication required' });
      }
      res.json({ id: req.user.id, email: req.user.email, is_admin: !!req.user.is_admin });
    });

    app.get('/settings', requireAuth(), (req, res) => {
      const sessionToken = parseCookie(req.headers.cookie, 'pullmd_session');
      const flash = sessionToken ? consumeSessionFlash(sessionToken) : null;
      const newKey = flash && typeof flash.new_key === 'string' ? flash.new_key : null;
      res.set('Content-Type', 'text/html; charset=utf-8');
      res.send(settingsPage({ user: req.user, keys: listApiKeys(req.user.id), newKey }));
    });

    app.post('/api/keys', formParser, requireAuth(), (req, res) => {
      const label = (req.body?.label || '').toString().slice(0, 100) || null;
      const { fullKey } = createApiKey(req.user.id, label);
      if ((req.headers.accept || '').includes('application/json')) {
        return res.json({ key: fullKey });
      }
      // Flash via the session row, then redirect to a clean URL. This keeps
      // the freshly-minted key out of browser history, server access logs,
      // and Referer headers.
      const sessionToken = parseCookie(req.headers.cookie, 'pullmd_session');
      if (sessionToken) {
        setSessionFlash(sessionToken, { new_key: fullKey });
        return res.redirect(302, '/settings');
      }
      // No session (e.g. form POST authenticated by an API key — unusual,
      // but possible). Fall back to JSON so the key isn't lost.
      res.json({ key: fullKey });
    });

    app.post('/api/keys/:id/revoke', requireAuth(), (req, res) => {
      const id = parseInt(req.params.id, 10);
      if (!id) return res.status(400).json({ error: 'Invalid id' });
      revokeApiKey(req.user.id, id);
      if ((req.headers.accept || '').includes('application/json')) {
        return res.json({ ok: true });
      }
      res.redirect(302, '/settings');
    });
  }

  return {
    mode,
    isMisconfigured,
    runMigration,
    createSession, lookupSession, deleteSession,
    setSessionFlash, consumeSessionFlash,
    createApiKey, lookupApiKey, listApiKeys, revokeApiKey,
    lookupLegacyToken,
    middleware, requireAuth,
    setAccessTokenVerifier,
    mountAuthRoutes,
    createUser, authenticate,
    _stmts: stmts,
    _keyStmts: keyStmts,
    _argon2Opts: argon2Opts,
    _safeRedirectPath: safeRedirectPath,
  };
}
