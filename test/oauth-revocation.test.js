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
  mountOAuthRoutes(app, oauth);
  const userId = cache.db.prepare("SELECT id FROM users").get().id;
  const client = oauth.store.registerClient({
    redirect_uris: ['https://claude.ai/api/mcp/auth_callback'],
    client_name: 'X', token_endpoint_auth_method: 'none',
  });
  return { app, oauth, cache, userId, client };
}

async function withServer(app, fn) {
  const server = app.listen(0);
  try { return await fn(`http://127.0.0.1:${server.address().port}`); }
  finally { server.close(); }
}

describe('POST /oauth/revoke (RFC 7009)', () => {
  it('revokes a refresh token, subsequent use → invalid_grant', async () => {
    const { app, oauth, userId, client } = await setup();
    const exp = new Date(Date.now() + 30 * 86400e3).toISOString();
    const { token, tokenHash } = oauth.tokens.generateRefreshToken();
    oauth.store.insertRefreshToken({
      tokenHash, client_id: client.client_id, user_id: userId, scope: 'mcp:full',
      expiresAt: exp, rotated_from: null,
    });
    await withServer(app, async (base) => {
      const r = await fetch(`${base}/oauth/revoke`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          token, token_type_hint: 'refresh_token', client_id: client.client_id,
        }).toString(),
      });
      // RFC 7009: respond 200 even if the token doesn't exist (don't leak info)
      assert.equal(r.status, 200);
      const row = oauth.store.findRefreshToken(tokenHash);
      assert.ok(row.revoked_at);
    });
  });

  it('revoke unknown token → still 200 (no info leak per RFC 7009)', async () => {
    const { app, client } = await setup();
    await withServer(app, async (base) => {
      const r = await fetch(`${base}/oauth/revoke`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          token: 'pmd_rt_unknown', client_id: client.client_id,
        }).toString(),
      });
      assert.equal(r.status, 200);
    });
  });

  it('revoke without client_id → 400', async () => {
    const { app } = await setup();
    await withServer(app, async (base) => {
      const r = await fetch(`${base}/oauth/revoke`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token: 'pmd_rt_x' }).toString(),
      });
      assert.equal(r.status, 400);
    });
  });
});
