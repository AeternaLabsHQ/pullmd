import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createCache } from '../lib/cache.js';
import { createAuth } from '../lib/auth.js';
import { createOAuth, mountOAuthRoutes } from '../lib/oauth/index.js';

// Rejections on the OAuth endpoints: every test also checks that the refused
// request left no usable artefact behind (no code, no rotation, no revocation).

const fastOpts = { timeCost: 1, memoryCost: 1024, parallelism: 1 };
const CALLBACK = 'https://claude.ai/api/mcp/auth_callback';

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
  const userId = cache.db.prepare('SELECT id FROM users').get().id;
  const { token: sessionToken } = auth.createSession(userId);
  const client = oauth.store.registerClient({
    redirect_uris: ['https://app.example/cb'],
    client_name: 'Public', token_endpoint_auth_method: 'none',
  });
  const conf = oauth.store.registerClient({
    redirect_uris: ['https://app.example/cb'],
    client_name: 'Confidential', token_endpoint_auth_method: 'client_secret_post',
  });
  return { app, oauth, cache, userId, sessionToken, client, conf };
}

async function withServer(app, fn) {
  const server = app.listen(0);
  try { return await fn(`http://127.0.0.1:${server.address().port}`); }
  finally { server.close(); }
}

function post(base, path, body, headers = {}) {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
    body: new URLSearchParams(body).toString(),
    redirect: 'manual',
  });
}

function seedRefresh(oauth, userId, clientId) {
  const { token, tokenHash } = oauth.tokens.generateRefreshToken();
  oauth.store.insertRefreshToken({
    tokenHash, client_id: clientId, user_id: userId, scope: 'mcp:full',
    expiresAt: new Date(Date.now() + 86400e3).toISOString(), rotated_from: null,
  });
  return { token, tokenHash };
}

const codeCount = (cache) => cache.db.prepare('SELECT COUNT(*) AS n FROM oauth_auth_codes').get().n;
const refreshCount = (cache) => cache.db.prepare('SELECT COUNT(*) AS n FROM oauth_refresh_tokens').get().n;

describe('POST /oauth/consent - rejected requests issue no code', () => {
  const consentBody = (client, over = {}) => ({
    decision: 'allow', client_id: client.client_id, redirect_uri: 'https://app.example/cb',
    code_challenge: 'CHAL', code_challenge_method: 'S256', state: 'S', scope: 'mcp:full', ...over,
  });
  const cookie = (t) => ({ Cookie: `pullmd_session=${t}` });

  it('accepts the baseline request (so the rejections below are not vacuous)', async () => {
    const { app, cache, sessionToken, client } = await setup();
    await withServer(app, async (base) => {
      const r = await post(base, '/oauth/consent', consentBody(client), cookie(sessionToken));
      assert.equal(r.status, 302);
      assert.ok(new URL(r.headers.get('location')).searchParams.get('code'));
      assert.equal(codeCount(cache), 1);
    });
  });

  it('unknown client_id → 400 invalid_client, no redirect', async () => {
    const { app, cache, sessionToken, client } = await setup();
    await withServer(app, async (base) => {
      const r = await post(base, '/oauth/consent', consentBody(client, { client_id: 'pmd_oc_nope' }), cookie(sessionToken));
      assert.equal(r.status, 400);
      assert.equal((await r.json()).error, 'invalid_client');
      assert.equal(r.headers.get('location'), null);
      assert.equal(codeCount(cache), 0);
    });
  });

  it('redirect_uri swapped after the authorize step → 400, never redirects to it', async () => {
    const { app, cache, sessionToken, client } = await setup();
    await withServer(app, async (base) => {
      const r = await post(base, '/oauth/consent', consentBody(client, { redirect_uri: 'https://evil.example/cb' }), cookie(sessionToken));
      assert.equal(r.status, 400);
      assert.equal((await r.json()).error, 'invalid_request');
      assert.equal(r.headers.get('location'), null);
      assert.equal(codeCount(cache), 0);
    });
  });

  for (const [label, over] of [
    ['code_challenge_method=plain', { code_challenge_method: 'plain' }],
    ['missing code_challenge', { code_challenge: '' }],
  ]) {
    it(`${label} → 400, PKCE cannot be dropped at the consent step`, async () => {
      const { app, cache, sessionToken, client } = await setup();
      await withServer(app, async (base) => {
        const r = await post(base, '/oauth/consent', consentBody(client, over), cookie(sessionToken));
        assert.equal(r.status, 400);
        assert.equal((await r.json()).error, 'invalid_request');
        assert.equal(codeCount(cache), 0);
      });
    });
  }
});

describe('POST /oauth/revoke - client authentication', () => {
  it('unknown client_id → 401 invalid_client', async () => {
    const { app } = await setup();
    await withServer(app, async (base) => {
      const r = await post(base, '/oauth/revoke', { token: 'pmd_rt_x', client_id: 'pmd_oc_nope' });
      assert.equal(r.status, 401);
      assert.equal((await r.json()).error, 'invalid_client');
    });
  });

  for (const [label, secret] of [['without a secret', undefined], ['with a wrong secret', 'wrong']]) {
    it(`confidential client ${label} → 401, token stays valid`, async () => {
      const { app, oauth, userId, conf } = await setup();
      const { token, tokenHash } = seedRefresh(oauth, userId, conf.client_id);
      await withServer(app, async (base) => {
        const body = { token, client_id: conf.client_id };
        if (secret) body.client_secret = secret;
        const r = await post(base, '/oauth/revoke', body);
        assert.equal(r.status, 401);
        assert.equal((await r.json()).error, 'invalid_client');
        assert.equal(oauth.store.findRefreshToken(tokenHash).revoked_at, null);
      });
    });
  }

  it('confidential client with the right secret → 200, token revoked', async () => {
    const { app, oauth, userId, conf } = await setup();
    const { token, tokenHash } = seedRefresh(oauth, userId, conf.client_id);
    await withServer(app, async (base) => {
      const r = await post(base, '/oauth/revoke', { token, client_id: conf.client_id, client_secret: conf.client_secret });
      assert.equal(r.status, 200);
      assert.ok(oauth.store.findRefreshToken(tokenHash).revoked_at);
    });
  });
});

describe('POST /oauth/token (refresh_token) - client authentication', () => {
  const refreshBody = (token, clientId, over = {}) => ({
    grant_type: 'refresh_token', refresh_token: token, client_id: clientId, ...over,
  });

  it('missing refresh_token or client_id → 400 invalid_request', async () => {
    const { app, client } = await setup();
    await withServer(app, async (base) => {
      for (const body of [
        { grant_type: 'refresh_token', client_id: client.client_id },
        { grant_type: 'refresh_token', refresh_token: 'pmd_rt_x' },
      ]) {
        const r = await post(base, '/oauth/token', body);
        assert.equal(r.status, 400);
        assert.equal((await r.json()).error, 'invalid_request');
      }
    });
  });

  it('unknown client_id → 401 invalid_client, token not rotated', async () => {
    const { app, oauth, cache, userId, client } = await setup();
    const { token, tokenHash } = seedRefresh(oauth, userId, client.client_id);
    await withServer(app, async (base) => {
      const r = await post(base, '/oauth/token', refreshBody(token, 'pmd_oc_nope'));
      assert.equal(r.status, 401);
      assert.equal((await r.json()).error, 'invalid_client');
      assert.equal(oauth.store.findRefreshToken(tokenHash).revoked_at, null);
      assert.equal(refreshCount(cache), 1);
    });
  });

  for (const [label, over] of [['without a secret', {}], ['with a wrong secret', { client_secret: 'wrong' }]]) {
    it(`confidential client ${label} → 401, no tokens issued, token not rotated`, async () => {
      const { app, oauth, cache, userId, conf } = await setup();
      const { token, tokenHash } = seedRefresh(oauth, userId, conf.client_id);
      await withServer(app, async (base) => {
        const r = await post(base, '/oauth/token', refreshBody(token, conf.client_id, over));
        assert.equal(r.status, 401);
        const m = await r.json();
        assert.equal(m.error, 'invalid_client');
        assert.equal(m.access_token, undefined);
        assert.equal(oauth.store.findRefreshToken(tokenHash).revoked_at, null);
        assert.equal(refreshCount(cache), 1);
      });
    });
  }

  it('confidential client with the right secret → 200 and rotation', async () => {
    const { app, oauth, userId, conf } = await setup();
    const { token, tokenHash } = seedRefresh(oauth, userId, conf.client_id);
    await withServer(app, async (base) => {
      const r = await post(base, '/oauth/token', refreshBody(token, conf.client_id, { client_secret: conf.client_secret }));
      assert.equal(r.status, 200);
      const m = await r.json();
      assert.ok(m.access_token);
      assert.notEqual(m.refresh_token, token);
      assert.ok(oauth.store.findRefreshToken(tokenHash).revoked_at);
    });
  });
});
