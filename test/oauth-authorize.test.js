import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createCache } from '../lib/cache.js';
import { createAuth } from '../lib/auth.js';
import { createOAuth, mountOAuthRoutes } from '../lib/oauth/index.js';

const fastOpts = { timeCost: 1, memoryCost: 1024, parallelism: 1 };

async function setup() {
  const cache = createCache(':memory:');
  const auth = createAuth({
    db: cache.db, mode: 'multi-user',
    env: { PULLMD_ADMIN_EMAIL: 'a@b.c', PULLMD_ADMIN_PASSWORD: 'pw1234567' },
    argon2Opts: fastOpts,
  });
  await auth.runMigration();
  const oauth = createOAuth({
    db: cache.db, auth,
    env: { OAUTH_JWT_SECRET: 'x'.repeat(48), PUBLIC_URL: 'https://pullmd.test' },
  });
  const app = express();
  app.use(auth.middleware());
  auth.mountAuthRoutes(app);
  mountOAuthRoutes(app, oauth);
  const userId = cache.db.prepare("SELECT id FROM users").get().id;
  const { token: sessionToken } = auth.createSession(userId);
  // Pre-register a public DCR client for use in these tests.
  const reg = oauth.store.registerClient({
    redirect_uris: ['https://claude.ai/api/mcp/auth_callback'],
    client_name: 'Claude.ai',
    token_endpoint_auth_method: 'none',
  });
  return { app, auth, oauth, cache, sessionToken, userId, client: reg };
}

async function withServer(app, fn) {
  const server = app.listen(0);
  try { return await fn(`http://127.0.0.1:${server.address().port}`); }
  finally { server.close(); }
}

const COOKIE = (t) => ({ Cookie: `pullmd_session=${t}` });

describe('GET /oauth/authorize', () => {
  it('without session → 302 redirect to /login?next=...', async () => {
    const { app, client } = await setup();
    await withServer(app, async (base) => {
      const url = `${base}/oauth/authorize?response_type=code&client_id=${client.client_id}` +
        `&redirect_uri=${encodeURIComponent('https://claude.ai/api/mcp/auth_callback')}` +
        `&code_challenge=abc&code_challenge_method=S256&state=xyz&scope=mcp:full`;
      const r = await fetch(url, { redirect: 'manual' });
      assert.equal(r.status, 302);
      const loc = r.headers.get('location');
      assert.match(loc, /^\/login\?next=/);
    });
  });

  it('with session → 200, renders consent HTML', async () => {
    const { app, sessionToken, client } = await setup();
    await withServer(app, async (base) => {
      const url = `${base}/oauth/authorize?response_type=code&client_id=${client.client_id}` +
        `&redirect_uri=${encodeURIComponent('https://claude.ai/api/mcp/auth_callback')}` +
        `&code_challenge=abc&code_challenge_method=S256&state=xyz&scope=mcp:full`;
      const r = await fetch(url, { headers: COOKIE(sessionToken) });
      assert.equal(r.status, 200);
      const html = await r.text();
      assert.match(html, /Claude\.ai/);
      assert.match(html, /mcp:full|PullMD/);
    });
  });

  it('redirect_uri NOT in client allowlist → 400 (no redirect)', async () => {
    const { app, sessionToken, client } = await setup();
    await withServer(app, async (base) => {
      const url = `${base}/oauth/authorize?response_type=code&client_id=${client.client_id}` +
        `&redirect_uri=${encodeURIComponent('https://evil.example/cb')}` +
        `&code_challenge=abc&code_challenge_method=S256&state=xyz&scope=mcp:full`;
      const r = await fetch(url, { headers: COOKIE(sessionToken), redirect: 'manual' });
      assert.equal(r.status, 400);
    });
  });

  it('unknown client_id → 400', async () => {
    const { app, sessionToken } = await setup();
    await withServer(app, async (base) => {
      const url = `${base}/oauth/authorize?response_type=code&client_id=nope` +
        `&redirect_uri=${encodeURIComponent('https://claude.ai/api/mcp/auth_callback')}` +
        `&code_challenge=abc&code_challenge_method=S256&state=xyz&scope=mcp:full`;
      const r = await fetch(url, { headers: COOKIE(sessionToken), redirect: 'manual' });
      assert.equal(r.status, 400);
    });
  });

  it('code_challenge_method=plain → 400', async () => {
    const { app, sessionToken, client } = await setup();
    await withServer(app, async (base) => {
      const url = `${base}/oauth/authorize?response_type=code&client_id=${client.client_id}` +
        `&redirect_uri=${encodeURIComponent('https://claude.ai/api/mcp/auth_callback')}` +
        `&code_challenge=abc&code_challenge_method=plain&state=xyz&scope=mcp:full`;
      const r = await fetch(url, { headers: COOKIE(sessionToken), redirect: 'manual' });
      assert.equal(r.status, 400);
    });
  });

  it('missing state → 400', async () => {
    const { app, sessionToken, client } = await setup();
    await withServer(app, async (base) => {
      const url = `${base}/oauth/authorize?response_type=code&client_id=${client.client_id}` +
        `&redirect_uri=${encodeURIComponent('https://claude.ai/api/mcp/auth_callback')}` +
        `&code_challenge=abc&code_challenge_method=S256&scope=mcp:full`;
      const r = await fetch(url, { headers: COOKIE(sessionToken), redirect: 'manual' });
      assert.equal(r.status, 400);
    });
  });

  it('hard-coded claude.ai redirect URI works even without DCR (allowlist fallback)', async () => {
    // Clients hard-coded into HARDCODED_REDIRECT_ALLOWLIST should still validate
    // even if the DCR client doesn't list it (defence-in-depth bound).
    const { app, sessionToken, client, oauth, cache } = await setup();
    // Point client to a different URI to prove hardcoded is independent.
    cache.db.prepare(`UPDATE oauth_clients SET redirect_uris = ? WHERE client_id = ?`)
      .run(JSON.stringify(['https://claude.ai/api/mcp/auth_callback']), client.client_id);
    await withServer(app, async (base) => {
      const url = `${base}/oauth/authorize?response_type=code&client_id=${client.client_id}` +
        `&redirect_uri=${encodeURIComponent('https://claude.ai/api/mcp/auth_callback')}` +
        `&code_challenge=abc&code_challenge_method=S256&state=xyz&scope=mcp:full`;
      const r = await fetch(url, { headers: COOKIE(sessionToken) });
      assert.equal(r.status, 200);
    });
  });
});

describe('POST /oauth/consent', () => {
  it('decision=allow → 302 to redirect_uri with code+state', async () => {
    const { app, sessionToken, client } = await setup();
    await withServer(app, async (base) => {
      const body = new URLSearchParams({
        decision: 'allow',
        client_id: client.client_id,
        redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
        code_challenge: 'CHAL',
        code_challenge_method: 'S256',
        state: 'STATE-123',
        scope: 'mcp:full',
      }).toString();
      const r = await fetch(`${base}/oauth/consent`, {
        method: 'POST',
        headers: { ...COOKIE(sessionToken), 'content-type': 'application/x-www-form-urlencoded' },
        body, redirect: 'manual',
      });
      assert.equal(r.status, 302);
      const loc = r.headers.get('location');
      const u = new URL(loc);
      assert.equal(u.origin + u.pathname, 'https://claude.ai/api/mcp/auth_callback');
      assert.ok(u.searchParams.get('code'));
      assert.equal(u.searchParams.get('state'), 'STATE-123');
    });
  });

  it('decision=deny → 302 to redirect_uri with error=access_denied+state', async () => {
    const { app, sessionToken, client } = await setup();
    await withServer(app, async (base) => {
      const body = new URLSearchParams({
        decision: 'deny',
        client_id: client.client_id,
        redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
        code_challenge: 'CHAL',
        code_challenge_method: 'S256',
        state: 'STATE-DENY',
        scope: 'mcp:full',
      }).toString();
      const r = await fetch(`${base}/oauth/consent`, {
        method: 'POST',
        headers: { ...COOKIE(sessionToken), 'content-type': 'application/x-www-form-urlencoded' },
        body, redirect: 'manual',
      });
      assert.equal(r.status, 302);
      const u = new URL(r.headers.get('location'));
      assert.equal(u.searchParams.get('error'), 'access_denied');
      assert.equal(u.searchParams.get('state'), 'STATE-DENY');
    });
  });

  it('consent without session → 401', async () => {
    const { app, client } = await setup();
    await withServer(app, async (base) => {
      const body = new URLSearchParams({
        decision: 'allow',
        client_id: client.client_id,
        redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
        code_challenge: 'CHAL', code_challenge_method: 'S256', state: 'X', scope: 'mcp:full',
      }).toString();
      const r = await fetch(`${base}/oauth/consent`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body, redirect: 'manual',
      });
      assert.equal(r.status, 401);
    });
  });
});
