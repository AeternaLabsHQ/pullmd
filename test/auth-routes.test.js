import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createCache } from '../lib/cache.js';
import { createAuth } from '../lib/auth.js';

const fastOpts = { timeCost: 1, memoryCost: 1024, parallelism: 1 };

function build(mode) {
  const cache = createCache(':memory:');
  const auth = createAuth({
    db: cache.db, mode,
    env: { PULLMD_ADMIN_EMAIL: 'admin@x.y', PULLMD_ADMIN_PASSWORD: 'adminpass1' },
    argon2Opts: fastOpts,
  });
  return { cache, auth };
}

async function withApp(mode, fn) {
  const { cache, auth } = build(mode);
  await auth.runMigration();
  const app = express();
  app.use(auth.middleware());
  auth.mountAuthRoutes(app);
  const server = app.listen(0);
  try {
    const port = server.address().port;
    return await fn(`http://127.0.0.1:${port}`, { auth, cache });
  } finally {
    server.close();
  }
}

function getCookie(res, name) {
  const set = res.headers.getSetCookie?.() || [];
  for (const c of set) {
    const [pair] = c.split(';');
    const [k, ...rest] = pair.split('=');
    if (k === name) return rest.join('=');
  }
  return null;
}

describe('auth routes — multi-user', () => {
  it('GET /login renders an HTML form', async () => {
    await withApp('multi-user', async (base) => {
      const r = await fetch(base + '/login');
      assert.equal(r.status, 200);
      assert.match(r.headers.get('content-type'), /html/);
      const body = await r.text();
      assert.match(body, /<form[^>]+action="\/login"/);
      assert.match(body, /name="email"/);
      assert.match(body, /name="password"/);
    });
  });

  it('POST /login with correct credentials sets session cookie and redirects', async () => {
    await withApp('multi-user', async (base) => {
      const r = await fetch(base + '/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'email=admin@x.y&password=adminpass1',
        redirect: 'manual',
      });
      assert.equal(r.status, 302);
      assert.match(r.headers.get('location'), /^\//);
      const token = getCookie(r, 'pullmd_session');
      assert.ok(token, 'must set pullmd_session cookie');
    });
  });

  it('POST /login honours a same-origin ?next=/path', async () => {
    await withApp('multi-user', async (base) => {
      const r = await fetch(base + '/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'email=admin@x.y&password=adminpass1&next=' + encodeURIComponent('/settings'),
        redirect: 'manual',
      });
      assert.equal(r.status, 302);
      assert.equal(r.headers.get('location'), '/settings');
    });
  });

  it('POST /login honours next=/#url=... (share-restore flow)', async () => {
    await withApp('multi-user', async (base) => {
      const next = '/#url=' + encodeURIComponent('https://ex.com/a');
      const r = await fetch(base + '/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'email=admin@x.y&password=adminpass1&next=' + encodeURIComponent(next),
        redirect: 'manual',
      });
      assert.equal(r.status, 302);
      assert.equal(r.headers.get('location'), next);
    });
  });

  it('POST /login refuses next=//evil.com (protocol-relative)', async () => {
    await withApp('multi-user', async (base) => {
      const r = await fetch(base + '/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'email=admin@x.y&password=adminpass1&next=' + encodeURIComponent('//evil.com'),
        redirect: 'manual',
      });
      assert.equal(r.status, 302);
      assert.match(r.headers.get('location'), /^\/\?login=ok/, 'must fall back to safe default, not redirect off-site');
    });
  });

  it('POST /login refuses next=/\\evil.com (backslash bypass)', async () => {
    await withApp('multi-user', async (base) => {
      const r = await fetch(base + '/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'email=admin@x.y&password=adminpass1&next=' + encodeURIComponent('/\\evil.com'),
        redirect: 'manual',
      });
      assert.equal(r.status, 302);
      assert.match(r.headers.get('location'), /^\/\?login=ok/, 'browsers normalise \\\\ to /, so this would otherwise leak the user off-site');
    });
  });

  it('POST /login refuses next=https://evil.com (absolute URL)', async () => {
    await withApp('multi-user', async (base) => {
      const r = await fetch(base + '/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'email=admin@x.y&password=adminpass1&next=' + encodeURIComponent('https://evil.com'),
        redirect: 'manual',
      });
      assert.equal(r.status, 302);
      assert.match(r.headers.get('location'), /^\/\?login=ok/);
    });
  });

  it('POST /login with wrong password 401s, no cookie', async () => {
    await withApp('multi-user', async (base) => {
      const r = await fetch(base + '/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'email=admin@x.y&password=wrong',
        redirect: 'manual',
      });
      assert.equal(r.status, 401);
      assert.equal(getCookie(r, 'pullmd_session'), null);
    });
  });

  it('POST /logout clears session cookie and redirects', async () => {
    await withApp('multi-user', async (base, { auth, cache }) => {
      const adminId = cache.db.prepare("SELECT id FROM users").get().id;
      const { token } = auth.createSession(adminId);
      const r = await fetch(base + '/logout', {
        method: 'POST',
        headers: { Cookie: `pullmd_session=${token}` },
        redirect: 'manual',
      });
      assert.equal(r.status, 302);
      assert.equal(auth.lookupSession(token), null);
    });
  });

  it('POST /logout while the session is sliding sends only the clearing cookie', async () => {
    await withApp('multi-user', async (base, { auth, cache }) => {
      const adminId = cache.db.prepare("SELECT id FROM users").get().id;
      const { token } = auth.createSession(adminId);
      // Age the session so the middleware's sliding refresh fires on this request.
      cache.db
        .prepare("UPDATE sessions SET expires_at = datetime('now', '+30 days') WHERE token = ?")
        .run(token);
      const r = await fetch(base + '/logout', {
        method: 'POST',
        headers: { Cookie: `pullmd_session=${token}` },
        redirect: 'manual',
      });
      assert.equal(r.status, 302);
      const sessionCookies = (r.headers.getSetCookie?.() || [])
        .filter((c) => c.startsWith('pullmd_session='));
      assert.equal(sessionCookies.length, 1, `expected exactly one session Set-Cookie, got: ${sessionCookies.join(' | ')}`);
      assert.match(sessionCookies[0], /^pullmd_session=;/);
      assert.match(sessionCookies[0], /Max-Age=0/);
    });
  });

  it('GET /signup renders form in multi-user mode', async () => {
    await withApp('multi-user', async (base) => {
      const r = await fetch(base + '/signup');
      assert.equal(r.status, 200);
      const body = await r.text();
      assert.match(body, /name="email"/);
    });
  });

  it('POST /signup creates a new user and logs them in', async () => {
    await withApp('multi-user', async (base, { cache }) => {
      const r = await fetch(base + '/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'email=new@user.io&password=newpass1234&password_confirm=newpass1234',
        redirect: 'manual',
      });
      assert.equal(r.status, 302);
      assert.ok(getCookie(r, 'pullmd_session'));
      const u = cache.db.prepare("SELECT * FROM users WHERE email = 'new@user.io'").get();
      assert.ok(u);
      assert.equal(u.is_admin, 0);
    });
  });

  it('POST /signup rejects mismatched passwords', async () => {
    await withApp('multi-user', async (base) => {
      const r = await fetch(base + '/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'email=a@b.c&password=onetwo123&password_confirm=mismatch',
        redirect: 'manual',
      });
      assert.equal(r.status, 400);
    });
  });

  it('POST /signup rejects too-short passwords', async () => {
    await withApp('multi-user', async (base) => {
      const r = await fetch(base + '/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'email=a@b.c&password=short&password_confirm=short',
        redirect: 'manual',
      });
      assert.equal(r.status, 400);
    });
  });

  it('POST /signup rejects duplicate email', async () => {
    await withApp('multi-user', async (base) => {
      const r = await fetch(base + '/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'email=admin@x.y&password=newpass1234&password_confirm=newpass1234',
        redirect: 'manual',
      });
      assert.equal(r.status, 400);
    });
  });

  it('GET /api/me returns 401 unauthenticated', async () => {
    await withApp('multi-user', async (base) => {
      const r = await fetch(base + '/api/me');
      assert.equal(r.status, 401);
    });
  });

  it('GET /api/me returns user when authenticated', async () => {
    await withApp('multi-user', async (base, { auth, cache }) => {
      const adminId = cache.db.prepare("SELECT id FROM users").get().id;
      const { token } = auth.createSession(adminId);
      const r = await fetch(base + '/api/me', {
        headers: { Cookie: `pullmd_session=${token}` },
      });
      assert.equal(r.status, 200);
      const body = await r.json();
      assert.equal(body.email, 'admin@x.y');
      assert.equal(body.is_admin, true);
    });
  });

  it('POST /api/keys (browser path) does NOT put the key in the redirect URL', async () => {
    await withApp('multi-user', async (base, { auth, cache }) => {
      const adminId = cache.db.prepare("SELECT id FROM users").get().id;
      const { token } = auth.createSession(adminId);
      const r = await fetch(base + '/api/keys', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Cookie': `pullmd_session=${token}`,
          'Accept': 'text/html',
        },
        body: 'label=' + encodeURIComponent('My laptop'),
        redirect: 'manual',
      });
      assert.equal(r.status, 302);
      const loc = r.headers.get('location');
      assert.equal(loc, '/settings', 'must redirect to a clean URL — never include the key as a query param');
      assert.ok(!/pmd_/.test(loc), 'no key body in URL');
    });
  });

  it('POST /api/keys flashes the key into the session, GET /settings consumes it once', async () => {
    await withApp('multi-user', async (base, { auth, cache }) => {
      const adminId = cache.db.prepare("SELECT id FROM users").get().id;
      const { token } = auth.createSession(adminId);

      const post = await fetch(base + '/api/keys', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Cookie': `pullmd_session=${token}`,
          'Accept': 'text/html',
        },
        body: 'label=flashtest',
        redirect: 'manual',
      });
      assert.equal(post.status, 302);

      // First GET /settings shows the freshly-minted key in the banner.
      const first = await fetch(base + '/settings', {
        headers: { Cookie: `pullmd_session=${token}`, Accept: 'text/html' },
      });
      const firstBody = await first.text();
      assert.match(firstBody, /pmd_[A-Za-z0-9]{32}/, 'first /settings render must show the new key');
      assert.match(firstBody, /Save this key now/);

      // Second GET /settings does NOT — flash was consumed.
      const second = await fetch(base + '/settings', {
        headers: { Cookie: `pullmd_session=${token}`, Accept: 'text/html' },
      });
      const secondBody = await second.text();
      assert.ok(!/Save this key now/.test(secondBody), 'flash must be cleared after first read');
    });
  });

  it('POST /api/keys with Accept: application/json returns the key as JSON', async () => {
    await withApp('multi-user', async (base, { auth, cache }) => {
      const adminId = cache.db.prepare("SELECT id FROM users").get().id;
      const { token } = auth.createSession(adminId);
      const r = await fetch(base + '/api/keys', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Cookie': `pullmd_session=${token}`,
          'Accept': 'application/json',
        },
        body: 'label=jsonpath',
      });
      assert.equal(r.status, 200);
      const body = await r.json();
      assert.match(body.key, /^pmd_[A-Za-z0-9]{32}$/);
    });
  });
});

describe('auth routes — single-admin', () => {
  it('GET /signup returns 404', async () => {
    await withApp('single-admin', async (base) => {
      const r = await fetch(base + '/signup');
      assert.equal(r.status, 404);
    });
  });

  it('POST /signup returns 404', async () => {
    await withApp('single-admin', async (base) => {
      const r = await fetch(base + '/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'email=x@y.z&password=pw1234567&password_confirm=pw1234567',
      });
      assert.equal(r.status, 404);
    });
  });

  it('POST /login still works', async () => {
    await withApp('single-admin', async (base) => {
      const r = await fetch(base + '/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'email=admin@x.y&password=adminpass1',
        redirect: 'manual',
      });
      assert.equal(r.status, 302);
    });
  });
});

describe('auth routes — disabled', () => {
  it('GET /login returns 404 in disabled mode', async () => {
    await withApp('disabled', async (base) => {
      const r = await fetch(base + '/login');
      assert.equal(r.status, 404);
    });
  });

  it('GET /api/me returns 404 in disabled mode', async () => {
    await withApp('disabled', async (base) => {
      const r = await fetch(base + '/api/me');
      assert.equal(r.status, 404);
    });
  });
});
