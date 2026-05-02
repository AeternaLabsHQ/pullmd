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
  try { return await fn(`http://127.0.0.1:${server.address().port}`); }
  finally { server.close(); }
}

describe('Dynamic Client Registration (RFC 7591)', () => {
  it('POST /oauth/register returns client_id (no secret for public clients)', async () => {
    const { app } = await makeApp();
    await withServer(app, async (base) => {
      const r = await fetch(`${base}/oauth/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          redirect_uris: ['https://claude.ai/api/mcp/auth_callback'],
          client_name: 'Claude.ai',
          token_endpoint_auth_method: 'none',
        }),
      });
      assert.equal(r.status, 201);
      const m = await r.json();
      assert.ok(m.client_id);
      assert.equal(m.client_secret, undefined);
      assert.deepEqual(m.redirect_uris, ['https://claude.ai/api/mcp/auth_callback']);
      assert.equal(m.token_endpoint_auth_method, 'none');
    });
  });

  it('POST /oauth/register supports client_secret_post (returns secret once)', async () => {
    const { app } = await makeApp();
    await withServer(app, async (base) => {
      const r = await fetch(`${base}/oauth/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          redirect_uris: ['https://x.example/cb'],
          client_name: 'CLI',
          token_endpoint_auth_method: 'client_secret_post',
        }),
      });
      assert.equal(r.status, 201);
      const m = await r.json();
      assert.ok(m.client_secret);
    });
  });

  it('POST /oauth/register: missing redirect_uris → 400 invalid_client_metadata', async () => {
    const { app } = await makeApp();
    await withServer(app, async (base) => {
      const r = await fetch(`${base}/oauth/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ client_name: 'X' }),
      });
      assert.equal(r.status, 400);
      const m = await r.json();
      assert.equal(m.error, 'invalid_client_metadata');
    });
  });

  it('POST /oauth/register: javascript: redirect URI → 400', async () => {
    const { app } = await makeApp();
    await withServer(app, async (base) => {
      const r = await fetch(`${base}/oauth/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          redirect_uris: ['javascript:alert(1)'], client_name: 'X',
          token_endpoint_auth_method: 'none',
        }),
      });
      assert.equal(r.status, 400);
    });
  });

  it('POST /oauth/register: bad JSON → 400', async () => {
    const { app } = await makeApp();
    await withServer(app, async (base) => {
      const r = await fetch(`${base}/oauth/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{not-json',
      });
      assert.equal(r.status, 400);
    });
  });
});
