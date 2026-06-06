import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createCache } from '../lib/cache.js';
import { createAuth } from '../lib/auth.js';

const fastOpts = { timeCost: 1, memoryCost: 1024, parallelism: 1 };

function makeApp(mode, envExtra = {}) {
  const cache = createCache(':memory:');
  const auth = createAuth({
    db: cache.db, mode, env: {
      PULLMD_ADMIN_EMAIL: 'a@b.c',
      PULLMD_ADMIN_PASSWORD: 'pw1234567',
      ...envExtra,
    }, argon2Opts: fastOpts,
  });
  const app = express();
  app.use(auth.middleware());
  app.get('/whoami', (req, res) => {
    res.json({ user: req.user || null });
  });
  return { app, auth, cache };
}

async function withServer(app, fn) {
  const server = app.listen(0);
  try {
    const port = server.address().port;
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    server.close();
  }
}

describe('auth middleware', () => {
  it('disabled mode: req.user is null, no auth required', async () => {
    const { app, auth } = makeApp('disabled');
    await auth.runMigration();
    await withServer(app, async (base) => {
      const r = await fetch(base + '/whoami');
      assert.equal(r.status, 200);
      const body = await r.json();
      assert.equal(body.user, null);
    });
  });

  it('multi-user: bare request leaves req.user null', async () => {
    const { app, auth } = makeApp('multi-user');
    await auth.runMigration();
    await withServer(app, async (base) => {
      const r = await fetch(base + '/whoami');
      const body = await r.json();
      assert.equal(body.user, null);
    });
  });

  it('multi-user: valid session cookie populates req.user', async () => {
    const { app, auth, cache } = makeApp('multi-user');
    await auth.runMigration();
    const adminId = cache.db.prepare("SELECT id FROM users").get().id;
    const { token } = auth.createSession(adminId);
    await withServer(app, async (base) => {
      const r = await fetch(base + '/whoami', {
        headers: { Cookie: `pullmd_session=${token}` },
      });
      const body = await r.json();
      assert.equal(body.user.email, 'a@b.c');
    });
  });

  it('multi-user: refreshes the session cookie once past the slide threshold', async () => {
    const { app, auth, cache } = makeApp('multi-user');
    await auth.runMigration();
    const adminId = cache.db.prepare("SELECT id FROM users").get().id;
    const { token } = auth.createSession(adminId);
    // Age the session: only 30 of 90 days remain, well past the 1-min slide throttle.
    cache.db
      .prepare("UPDATE sessions SET expires_at = datetime('now', '+30 days') WHERE token = ?")
      .run(token);
    await withServer(app, async (base) => {
      const r = await fetch(base + '/whoami', {
        headers: { Cookie: `pullmd_session=${token}` },
      });
      const setCookie = r.headers.get('set-cookie');
      assert.ok(setCookie, 'expected a refreshed Set-Cookie header');
      assert.ok(setCookie.includes(`pullmd_session=${token}`), 'must re-issue the same token');
      assert.match(setCookie, /Max-Age=7776000/); // 90 days in seconds
    });
  });

  it('multi-user: does not re-set the cookie for a fresh session', async () => {
    const { app, auth, cache } = makeApp('multi-user');
    await auth.runMigration();
    const adminId = cache.db.prepare("SELECT id FROM users").get().id;
    const { token } = auth.createSession(adminId);
    await withServer(app, async (base) => {
      const r = await fetch(base + '/whoami', {
        headers: { Cookie: `pullmd_session=${token}` },
      });
      // The session was just created, so < SESSION_SLIDE_MIN_MS (1 min) has
      // elapsed — the bump condition is not met and no refresh cookie is issued.
      assert.equal(r.headers.get('set-cookie'), null);
    });
  });

  it('multi-user: invalid session cookie leaves req.user null', async () => {
    const { app, auth } = makeApp('multi-user');
    await auth.runMigration();
    await withServer(app, async (base) => {
      const r = await fetch(base + '/whoami', {
        headers: { Cookie: 'pullmd_session=garbage' },
      });
      const body = await r.json();
      assert.equal(body.user, null);
    });
  });

  it('multi-user: valid API key populates req.user', async () => {
    const { app, auth, cache } = makeApp('multi-user');
    await auth.runMigration();
    const adminId = cache.db.prepare("SELECT id FROM users").get().id;
    const { fullKey } = auth.createApiKey(adminId, 'k');
    await withServer(app, async (base) => {
      const r = await fetch(base + '/whoami', {
        headers: { Authorization: `Bearer ${fullKey}` },
      });
      const body = await r.json();
      assert.equal(body.user.email, 'a@b.c');
    });
  });

  it('single-admin: legacy PULLMD_AUTH_TOKEN as Bearer populates req.user', async () => {
    const { app, auth } = makeApp('single-admin', { PULLMD_AUTH_TOKEN: 'mylegacy' });
    await auth.runMigration();
    await withServer(app, async (base) => {
      const r = await fetch(base + '/whoami', {
        headers: { Authorization: 'Bearer mylegacy' },
      });
      const body = await r.json();
      assert.equal(body.user.email, 'a@b.c');
    });
  });

  it('multi-user: legacy token is rejected', async () => {
    const { app, auth } = makeApp('multi-user', { PULLMD_AUTH_TOKEN: 'mylegacy' });
    await auth.runMigration();
    await withServer(app, async (base) => {
      const r = await fetch(base + '/whoami', {
        headers: { Authorization: 'Bearer mylegacy' },
      });
      const body = await r.json();
      assert.equal(body.user, null);
    });
  });

  it('requireAuth: rejects unauthenticated with 401 in non-disabled modes', async () => {
    const cache = createCache(':memory:');
    const auth = createAuth({
      db: cache.db, mode: 'multi-user',
      env: { PULLMD_ADMIN_EMAIL: 'a@b.c', PULLMD_ADMIN_PASSWORD: 'pw1234567' },
      argon2Opts: fastOpts,
    });
    await auth.runMigration();
    const app = express();
    app.use(auth.middleware());
    app.get('/protected', auth.requireAuth(), (req, res) => res.json({ ok: true }));
    await withServer(app, async (base) => {
      const r = await fetch(base + '/protected');
      assert.equal(r.status, 401);
      const body = await r.json();
      assert.match(body.error, /authentication/i);
    });
  });

  it('requireAuth: passes through in disabled mode', async () => {
    const cache = createCache(':memory:');
    const auth = createAuth({ db: cache.db, mode: 'disabled', env: {}, argon2Opts: fastOpts });
    await auth.runMigration();
    const app = express();
    app.use(auth.middleware());
    app.get('/protected', auth.requireAuth(), (req, res) => res.json({ ok: true }));
    await withServer(app, async (base) => {
      const r = await fetch(base + '/protected');
      assert.equal(r.status, 200);
    });
  });
});
