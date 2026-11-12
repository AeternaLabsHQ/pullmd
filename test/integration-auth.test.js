import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server.js';
import { createCache } from '../lib/cache.js';
import { createAuth } from '../lib/auth.js';

const fastOpts = { timeCost: 1, memoryCost: 1024, parallelism: 1 };

async function withApp(mode, fn, envExtra = {}) {
  const cache = createCache(':memory:');
  const auth = createAuth({
    db: cache.db, mode,
    env: { PULLMD_ADMIN_EMAIL: 'a@b.c', PULLMD_ADMIN_PASSWORD: 'pw1234567', ...envExtra },
    argon2Opts: fastOpts,
  });
  await auth.runMigration();
  const app = createApp({
    cache,
    auth,
    extractWeb: async () => ({
      markdown: '# x', title: 'x', source: 'readability',
      metadata: { quality: 0.9 },
    }),
  });
  const server = app.listen(0);
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`, { auth, cache });
  } finally {
    server.close();
  }
}

describe('integration: auth gating in createApp', () => {
  it('disabled mode: /api works without auth', async () => {
    await withApp('disabled', async (base) => {
      const r = await fetch(base + '/api?url=https://x.com&nocache=1');
      assert.equal(r.status, 200);
    });
  });

  it('multi-user: /api returns 401 without auth', async () => {
    await withApp('multi-user', async (base) => {
      const r = await fetch(base + '/api?url=https://x.com');
      assert.equal(r.status, 401);
    });
  });

  it('multi-user: /api works with API key', async () => {
    await withApp('multi-user', async (base, { auth, cache }) => {
      const adminId = cache.db.prepare("SELECT id FROM users").get().id;
      const { fullKey } = auth.createApiKey(adminId, 'k');
      const r = await fetch(base + '/api?url=https://x.com&nocache=1', {
        headers: { Authorization: `Bearer ${fullKey}` },
      });
      assert.equal(r.status, 200);
    });
  });

  it('multi-user: /api/history returns 401 without auth', async () => {
    await withApp('multi-user', async (base) => {
      const r = await fetch(base + '/api/history');
      assert.equal(r.status, 401);
    });
  });

  it('multi-user: /api/archive returns 401 without auth', async () => {
    await withApp('multi-user', async (base) => {
      const r = await fetch(base + '/api/archive');
      assert.equal(r.status, 401);
    });
  });

  it('multi-user: POST /api/html returns 401 without auth', async () => {
    await withApp('multi-user', async (base) => {
      const r = await fetch(base + '/api/html', {
        method: 'POST', body: '<h1>test</h1>',
        headers: { 'Content-Type': 'text/html' },
      });
      assert.equal(r.status, 401);
    });
  });

  it('multi-user: /mcp returns 401 without auth', async () => {
    await withApp('multi-user', async (base) => {
      const r = await fetch(base + '/mcp', {
        method: 'POST', body: '{}',
        headers: { 'Content-Type': 'application/json' },
      });
      assert.equal(r.status, 401);
    });
  });

  it('share link /s/:id stays public even when auth is on', async () => {
    await withApp('multi-user', async (base, { cache }) => {
      const adminId = cache.db.prepare("SELECT id FROM users").get().id;
      const shareId = cache.put({
        url: 'https://pub.com', title: 'Pub', markdown: '# pub',
        source: 'readability', client: 'api', user_id: adminId,
      });
      const r = await fetch(base + '/s/' + shareId);
      assert.equal(r.status, 200);
    });
  });

  it('static / and /help stay public', async () => {
    await withApp('multi-user', async (base) => {
      const a = await fetch(base + '/');
      assert.equal(a.status, 200);
      const b = await fetch(base + '/help');
      assert.equal(b.status, 200);
    });
  });

  it('aggregate /api/stats and /api/storage stay public', async () => {
    await withApp('multi-user', async (base) => {
      const a = await fetch(base + '/api/stats');
      assert.equal(a.status, 200);
      const b = await fetch(base + '/api/storage');
      assert.equal(b.status, 200);
    });
  });

  it('/api/stats omits per-domain lists for anonymous callers', async () => {
    await withApp('multi-user', async (base, { cache }) => {
      cache.logExtraction({ url: 'https://x.com/a', source: 'readability', quality: 0.1, markdownLen: 10, extractorReason: null, durationMs: 5, client: 'api', cached: false });
      const r = await fetch(base + '/api/stats');
      assert.equal(r.status, 200);
      const body = await r.json();
      assert.equal(body.total, 1);
      assert.equal(body.lowQualityDomains, undefined);
      assert.equal(body.fallbackByDomain, undefined);
    });
  });

  it('/api/stats keeps per-domain lists for the admin', async () => {
    await withApp('multi-user', async (base, { auth, cache }) => {
      const adminId = cache.db.prepare("SELECT id FROM users").get().id;
      const { fullKey } = auth.createApiKey(adminId, 'k');
      const conv = await fetch(base + '/api?url=https://x.com&nocache=1', { headers: { Authorization: `Bearer ${fullKey}` } });
      assert.equal(conv.status, 200);
      const r = await fetch(base + '/api/stats', { headers: { Authorization: `Bearer ${fullKey}` } });
      const body = await r.json();
      assert.ok(body.total >= 1);
      assert.ok(Array.isArray(body.lowQualityDomains));
      assert.ok(Array.isArray(body.fallbackByDomain));
    });
  });

  it('/api/stats omits per-domain lists for a non-admin user', async () => {
    await withApp('multi-user', async (base, { auth }) => {
      const bob = await auth.createUser({ email: 'bob@example.com', password: 'pw1234567' });
      const { fullKey } = auth.createApiKey(bob.id, 'k');
      const conv = await fetch(base + '/api?url=https://x.com&nocache=1', { headers: { Authorization: `Bearer ${fullKey}` } });
      assert.equal(conv.status, 200);
      const r = await fetch(base + '/api/stats', { headers: { Authorization: `Bearer ${fullKey}` } });
      const body = await r.json();
      assert.ok(body.total >= 1);
      assert.equal(body.lowQualityDomains, undefined);
      assert.equal(body.fallbackByDomain, undefined);
    });
  });

  it('GET /api/config exposes authMode', async () => {
    await withApp('multi-user', async (base) => {
      const r = await fetch(base + '/api/config');
      assert.equal(r.status, 200);
      const body = await r.json();
      assert.equal(body.authMode, 'multi-user');
    });
  });

  it('GET /api/config exposes authMisconfigured=false in normal modes', async () => {
    await withApp('multi-user', async (base) => {
      const body = await (await fetch(base + '/api/config')).json();
      assert.equal(body.authMisconfigured, false);
    });
    await withApp('single-admin', async (base) => {
      const body = await (await fetch(base + '/api/config')).json();
      assert.equal(body.authMisconfigured, false);
    });
    await withApp('disabled', async (base) => {
      const body = await (await fetch(base + '/api/config')).json();
      assert.equal(body.authMisconfigured, false);
    });
  });

  it('GET /api/config exposes authMisconfigured=true when token+disabled', async () => {
    await withApp('disabled', async (base) => {
      const body = await (await fetch(base + '/api/config')).json();
      assert.equal(body.authMisconfigured, true);
    }, { PULLMD_AUTH_TOKEN: 'leftover-v1-token' });
  });

  it('multi-user: /share redirects logged-out browser navigations to /login with next', async () => {
    await withApp('multi-user', async (base) => {
      const r = await fetch(base + '/share?link=' + encodeURIComponent('https://ex.com/a'), {
        redirect: 'manual',
        headers: { Accept: 'text/html' },
      });
      assert.equal(r.status, 302);
      const loc = r.headers.get('location');
      assert.ok(loc.startsWith('/login?next='), `unexpected location: ${loc}`);
      const next = decodeURIComponent(loc.slice('/login?next='.length));
      assert.equal(next, '/share?link=' + encodeURIComponent('https://ex.com/a'));
    });
  });

  it('multi-user: /share with a valid session redirects to /#url=', async () => {
    await withApp('multi-user', async (base, { auth, cache }) => {
      const adminId = cache.db.prepare("SELECT id FROM users").get().id;
      const { token } = auth.createSession(adminId);
      const r = await fetch(base + '/share?link=' + encodeURIComponent('https://ex.com/a'), {
        redirect: 'manual',
        headers: { Accept: 'text/html', Cookie: `pullmd_session=${token}` },
      });
      assert.equal(r.status, 302);
      assert.equal(r.headers.get('location'), '/#url=' + encodeURIComponent('https://ex.com/a'));
    });
  });

  it('disabled mode: /share stays open', async () => {
    await withApp('disabled', async (base) => {
      const r = await fetch(base + '/share?link=' + encodeURIComponent('https://ex.com/a'), {
        redirect: 'manual',
        headers: { Accept: 'text/html' },
      });
      assert.equal(r.status, 302);
      assert.equal(r.headers.get('location'), '/#url=' + encodeURIComponent('https://ex.com/a'));
    });
  });
});

describe('integration: per-user history', () => {
  it('user only sees their own fetches in /api/history', async () => {
    await withApp('multi-user', async (base, { auth, cache }) => {
      const adminId = cache.db.prepare("SELECT id FROM users").get().id;
      const { fullKey: adminKey } = auth.createApiKey(adminId, 'admin');

      const otherU = await auth.createUser({ email: 'other@x.y', password: 'pw1234567' });
      const { fullKey: otherKey } = auth.createApiKey(otherU.id, 'other');

      await fetch(base + '/api?url=https://8.8.8.8/&nocache=1', {
        headers: { Authorization: `Bearer ${adminKey}` },
      });
      await fetch(base + '/api?url=https://8.8.4.4/&nocache=1', {
        headers: { Authorization: `Bearer ${otherKey}` },
      });

      const adminHist = await (await fetch(base + '/api/history', {
        headers: { Authorization: `Bearer ${adminKey}` },
      })).json();
      const otherHist = await (await fetch(base + '/api/history', {
        headers: { Authorization: `Bearer ${otherKey}` },
      })).json();
      assert.deepEqual(adminHist.map(h => h.url), ['https://8.8.8.8/']);
      assert.deepEqual(otherHist.map(h => h.url), ['https://8.8.4.4/']);
    });
  });
});
