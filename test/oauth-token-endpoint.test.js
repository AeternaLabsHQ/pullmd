import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createHash, randomBytes } from 'node:crypto';
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
  const client = oauth.store.registerClient({
    redirect_uris: ['https://claude.ai/api/mcp/auth_callback'],
    client_name: 'Claude.ai', token_endpoint_auth_method: 'none',
  });
  return { app, auth, oauth, cache, userId, client };
}

async function withServer(app, fn) {
  const server = app.listen(0);
  try { return await fn(`http://127.0.0.1:${server.address().port}`); }
  finally { server.close(); }
}

function makePkce() {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

async function form(base, body) {
  return await fetch(`${base}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString(),
  });
}

describe('POST /oauth/token (authorization_code)', () => {
  it('happy path: returns access_token + refresh_token', async () => {
    const { app, oauth, userId, client } = await setup();
    const { verifier, challenge } = makePkce();
    const { code } = oauth.store.createAuthCode({
      client_id: client.client_id, user_id: userId,
      redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
      code_challenge: challenge, code_challenge_method: 'S256', scope: 'mcp:full',
    });
    await withServer(app, async (base) => {
      const r = await form(base, {
        grant_type: 'authorization_code', code,
        client_id: client.client_id,
        redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
        code_verifier: verifier,
      });
      assert.equal(r.status, 200);
      const m = await r.json();
      assert.equal(m.token_type, 'Bearer');
      assert.equal(m.expires_in, 3600);
      assert.ok(m.access_token);
      assert.ok(m.refresh_token);
      assert.equal(m.scope, 'mcp:full');
    });
  });

  it('PKCE verifier mismatch → 400 invalid_grant + code invalidated', async () => {
    const { app, oauth, userId, client } = await setup();
    const { challenge } = makePkce();
    const { code, codeHash } = oauth.store.createAuthCode({
      client_id: client.client_id, user_id: userId,
      redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
      code_challenge: challenge, code_challenge_method: 'S256', scope: 'mcp:full',
    });
    await withServer(app, async (base) => {
      const r = await form(base, {
        grant_type: 'authorization_code', code,
        client_id: client.client_id,
        redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
        code_verifier: 'WRONG-VERIFIER-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      });
      assert.equal(r.status, 400);
      const m = await r.json();
      assert.equal(m.error, 'invalid_grant');
    });
    // Code is now used — second presentation rejected
    const row = oauth.cache?.db ? null : null; // sentinel; check via store
    assert.equal(oauth.store.consumeAuthCode(codeHash), null);
  });

  it('redirect_uri mismatch from authorize → 400', async () => {
    const { app, oauth, userId, client } = await setup();
    const { verifier, challenge } = makePkce();
    const { code } = oauth.store.createAuthCode({
      client_id: client.client_id, user_id: userId,
      redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
      code_challenge: challenge, code_challenge_method: 'S256', scope: 'mcp:full',
    });
    await withServer(app, async (base) => {
      const r = await form(base, {
        grant_type: 'authorization_code', code,
        client_id: client.client_id,
        redirect_uri: 'https://different.example/cb',
        code_verifier: verifier,
      });
      assert.equal(r.status, 400);
    });
  });

  it('code reuse → 400 invalid_grant', async () => {
    const { app, oauth, userId, client } = await setup();
    const { verifier, challenge } = makePkce();
    const { code } = oauth.store.createAuthCode({
      client_id: client.client_id, user_id: userId,
      redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
      code_challenge: challenge, code_challenge_method: 'S256', scope: 'mcp:full',
    });
    await withServer(app, async (base) => {
      const r1 = await form(base, {
        grant_type: 'authorization_code', code,
        client_id: client.client_id,
        redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
        code_verifier: verifier,
      });
      assert.equal(r1.status, 200);
      const r2 = await form(base, {
        grant_type: 'authorization_code', code,
        client_id: client.client_id,
        redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
        code_verifier: verifier,
      });
      assert.equal(r2.status, 400);
    });
  });

  it('unsupported grant_type → 400', async () => {
    const { app } = await setup();
    await withServer(app, async (base) => {
      const r = await form(base, { grant_type: 'password' });
      assert.equal(r.status, 400);
      const m = await r.json();
      assert.equal(m.error, 'unsupported_grant_type');
    });
  });

  it('confidential client without secret → 401', async () => {
    const { app, oauth, userId } = await setup();
    const conf = oauth.store.registerClient({
      redirect_uris: ['https://claude.ai/api/mcp/auth_callback'],
      client_name: 'Conf', token_endpoint_auth_method: 'client_secret_post',
    });
    const { verifier, challenge } = makePkce();
    const { code } = oauth.store.createAuthCode({
      client_id: conf.client_id, user_id: userId,
      redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
      code_challenge: challenge, code_challenge_method: 'S256', scope: 'mcp:full',
    });
    await withServer(app, async (base) => {
      const r = await form(base, {
        grant_type: 'authorization_code', code,
        client_id: conf.client_id,
        redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
        code_verifier: verifier,
        // No client_secret
      });
      assert.equal(r.status, 401);
    });
  });
});
