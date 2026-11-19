import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createCache } from '../lib/cache.js';
import { createAuth } from '../lib/auth.js';
import { createOAuth } from '../lib/oauth/index.js';
import { createApp } from '../server.js';

const fastOpts = { timeCost: 1, memoryCost: 1024, parallelism: 1 };

const EXPECTED = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'SAMEORIGIN',
  'content-security-policy': "frame-ancestors 'self'",
  'referrer-policy': 'same-origin',
};

function assertHeaders(r, label) {
  for (const [name, value] of Object.entries(EXPECTED)) {
    assert.equal(r.headers.get(name), value, `${label}: ${name}`);
  }
}

async function withServer(app, fn) {
  const server = app.listen(0);
  try { return await fn(`http://127.0.0.1:${server.address().port}`); }
  finally { server.close(); }
}

async function bootOAuthApp() {
  const cache = createCache(':memory:');
  const auth = createAuth({
    db: cache.db, mode: 'multi-user',
    env: { PULLMD_ADMIN_EMAIL: 'a@b.c', PULLMD_ADMIN_PASSWORD: 'pw1234567' },
    argon2Opts: fastOpts,
    publicUrl: 'http://localhost',
  });
  await auth.runMigration();
  const oauth = createOAuth({
    db: cache.db, auth,
    env: { OAUTH_JWT_SECRET: 'x'.repeat(48), PUBLIC_URL: 'http://localhost' },
  });
  return { app: createApp({ cache, auth, oauth }), cache, auth, oauth };
}

describe('security headers', () => {
  it('are sent on pages, API, static files and 404s', async () => {
    const cache = createCache(':memory:');
    await withServer(createApp({ cache }), async (base) => {
      for (const path of ['/', '/help', '/api/status', '/s/' + 'a'.repeat(32), '/sw.js', '/manifest.json']) {
        const r = await fetch(base + path);
        assertHeaders(r, path);
      }
    });
  });

  it("merges frame-ancestors into Express's own 404 page CSP", async () => {
    const cache = createCache(':memory:');
    await withServer(createApp({ cache }), async (base) => {
      const r = await fetch(`${base}/nope-not-here`);
      assert.equal(r.status, 404);
      assert.equal(r.headers.get('content-security-policy'), "default-src 'none'; frame-ancestors 'self'");
      for (const name of ['x-content-type-options', 'x-frame-options', 'referrer-policy']) {
        assert.equal(r.headers.get(name), EXPECTED[name], name);
      }
    });
  });

  it('are sent on a JSON error answer', async () => {
    const cache = createCache(':memory:');
    await withServer(createApp({ cache }), async (base) => {
      const r = await fetch(`${base}/api`);
      assert.equal(r.status, 400);
      assertHeaders(r, '/api without url');
    });
  });

  it('are sent on the login page, /oauth/authorize and /mcp when OAuth is enabled', async () => {
    const { app, cache, auth, oauth } = await bootOAuthApp();
    const userId = cache.db.prepare('SELECT id FROM users').get().id;
    const { token } = auth.createSession(userId);
    const client = oauth.store.registerClient({
      redirect_uris: ['https://claude.ai/api/mcp/auth_callback'],
      client_name: 'Claude.ai',
      token_endpoint_auth_method: 'none',
    });
    await withServer(app, async (base) => {
      const login = await fetch(`${base}/login`);
      assertHeaders(login, '/login');

      const authorizeUrl = `${base}/oauth/authorize?response_type=code&client_id=${client.client_id}` +
        `&redirect_uri=${encodeURIComponent('https://claude.ai/api/mcp/auth_callback')}` +
        `&code_challenge=abc&code_challenge_method=S256&state=xyz&scope=mcp:full`;
      const anon = await fetch(authorizeUrl, { redirect: 'manual' });
      assert.equal(anon.status, 302);
      assertHeaders(anon, '/oauth/authorize (redirect)');

      const consent = await fetch(authorizeUrl, { headers: { Cookie: `pullmd_session=${token}` } });
      assert.equal(consent.status, 200);
      assertHeaders(consent, '/oauth/authorize (consent page)');

      const mcp = await fetch(`${base}/mcp`, { method: 'POST' });
      assert.equal(mcp.status, 401);
      assertHeaders(mcp, '/mcp (401)');
    });
  });
});
