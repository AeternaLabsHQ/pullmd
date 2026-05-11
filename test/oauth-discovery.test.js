import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createCache } from '../lib/cache.js';
import { createAuth } from '../lib/auth.js';
import { createOAuth, mountOAuthRoutes } from '../lib/oauth/index.js';

const fastOpts = { timeCost: 1, memoryCost: 1024, parallelism: 1 };

async function makeApp() {
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
  return { app, oauth, cache };
}

async function withServer(app, fn) {
  const server = app.listen(0);
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`);
  } finally { server.close(); }
}

describe('OAuth discovery (RFC 8414, 9728)', () => {
  it('GET /.well-known/oauth-authorization-server returns AS metadata', async () => {
    const { app } = await makeApp();
    await withServer(app, async (base) => {
      const r = await fetch(`${base}/.well-known/oauth-authorization-server`);
      assert.equal(r.status, 200);
      const m = await r.json();
      assert.equal(m.issuer, 'https://pullmd.test');
      assert.equal(m.authorization_endpoint, 'https://pullmd.test/oauth/authorize');
      assert.equal(m.token_endpoint, 'https://pullmd.test/oauth/token');
      assert.equal(m.registration_endpoint, 'https://pullmd.test/oauth/register');
      assert.equal(m.revocation_endpoint, 'https://pullmd.test/oauth/revoke');
      assert.deepEqual(m.grant_types_supported.sort(), ['authorization_code', 'refresh_token']);
      assert.deepEqual(m.response_types_supported, ['code']);
      assert.deepEqual(m.code_challenge_methods_supported, ['S256']);
      assert.ok(m.token_endpoint_auth_methods_supported.includes('none'));
      assert.deepEqual(m.scopes_supported, ['mcp:full']);
    });
  });

  it('GET /.well-known/oauth-protected-resource returns RS metadata', async () => {
    const { app } = await makeApp();
    await withServer(app, async (base) => {
      const r = await fetch(`${base}/.well-known/oauth-protected-resource`);
      assert.equal(r.status, 200);
      const m = await r.json();
      assert.equal(m.resource, 'https://pullmd.test/mcp');
      assert.deepEqual(m.authorization_servers, ['https://pullmd.test']);
      assert.deepEqual(m.bearer_methods_supported, ['header']);
      assert.deepEqual(m.scopes_supported, ['mcp:full']);
    });
  });
});
