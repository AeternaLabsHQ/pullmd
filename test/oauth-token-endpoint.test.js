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

async function obtainPair(base, oauth, userId, client) {
  const { verifier, challenge } = makePkce();
  const { code } = oauth.store.createAuthCode({
    client_id: client.client_id, user_id: userId,
    redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
    code_challenge: challenge, code_challenge_method: 'S256', scope: 'mcp:full',
  });
  const r = await form(base, {
    grant_type: 'authorization_code', code,
    client_id: client.client_id,
    redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
    code_verifier: verifier,
  });
  return await r.json();
}

describe('POST /oauth/token (refresh_token)', () => {
  it('happy path: returns NEW access + NEW refresh, old refresh revoked', async () => {
    const { app, oauth, userId, client } = await setup();
    await withServer(app, async (base) => {
      const first = await obtainPair(base, oauth, userId, client);
      const r = await form(base, {
        grant_type: 'refresh_token',
        refresh_token: first.refresh_token,
        client_id: client.client_id,
      });
      assert.equal(r.status, 200);
      const m = await r.json();
      assert.ok(m.access_token);
      assert.ok(m.refresh_token);
      assert.notEqual(m.refresh_token, first.refresh_token);

      // Old refresh now revoked
      const oldHash = oauth.tokens.hashRefreshToken(first.refresh_token);
      const oldRow = oauth.store.findRefreshToken(oldHash);
      assert.ok(oldRow.revoked_at);
    });
  });

  it('REUSE detection: presenting an already-rotated refresh invalidates entire chain', async () => {
    const { app, oauth, userId, client } = await setup();
    await withServer(app, async (base) => {
      const first = await obtainPair(base, oauth, userId, client);
      // Legitimate rotation -- produces second pair
      const second = await (await form(base, {
        grant_type: 'refresh_token', refresh_token: first.refresh_token,
        client_id: client.client_id,
      })).json();
      // Attacker replays the FIRST refresh
      const r = await form(base, {
        grant_type: 'refresh_token', refresh_token: first.refresh_token,
        client_id: client.client_id,
      });
      assert.equal(r.status, 400);
      const m = await r.json();
      assert.equal(m.error, 'invalid_grant');

      // Both chain members revoked now
      const secondHash = oauth.tokens.hashRefreshToken(second.refresh_token);
      const secondRow = oauth.store.findRefreshToken(secondHash);
      assert.ok(secondRow.revoked_at, 'second refresh should be revoked after reuse detection');

      // Even legitimate-looking second refresh now fails
      const r2 = await form(base, {
        grant_type: 'refresh_token', refresh_token: second.refresh_token,
        client_id: client.client_id,
      });
      assert.equal(r2.status, 400);
    });
  });

  it('refresh with unknown token → 400 invalid_grant', async () => {
    const { app, client } = await setup();
    await withServer(app, async (base) => {
      const r = await form(base, {
        grant_type: 'refresh_token',
        refresh_token: 'pmd_rt_does-not-exist',
        client_id: client.client_id,
      });
      assert.equal(r.status, 400);
    });
  });

  it('refresh with mismatched client_id → 400', async () => {
    const { app, oauth, userId, client } = await setup();
    const other = oauth.store.registerClient({
      redirect_uris: ['https://x/cb'], client_name: 'Other', token_endpoint_auth_method: 'none',
    });
    await withServer(app, async (base) => {
      const first = await obtainPair(base, oauth, userId, client);
      const r = await form(base, {
        grant_type: 'refresh_token',
        refresh_token: first.refresh_token,
        client_id: other.client_id,
      });
      assert.equal(r.status, 400);
    });
  });

  it('expired refresh → 400 invalid_grant', async () => {
    const { app, oauth, userId, client, cache } = await setup();
    await withServer(app, async (base) => {
      const first = await obtainPair(base, oauth, userId, client);
      const hash = oauth.tokens.hashRefreshToken(first.refresh_token);
      cache.db.prepare(`UPDATE oauth_refresh_tokens SET expires_at = datetime('now', '-1 hour') WHERE token_hash = ?`).run(hash);
      const r = await form(base, {
        grant_type: 'refresh_token', refresh_token: first.refresh_token,
        client_id: client.client_id,
      });
      assert.equal(r.status, 400);
    });
  });
});
