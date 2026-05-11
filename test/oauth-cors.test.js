import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createCache } from '../lib/cache.js';
import { createAuth } from '../lib/auth.js';
import { createOAuth } from '../lib/oauth/index.js';
import { createApp } from '../server.js';

const fastOpts = { timeCost: 1, memoryCost: 1024, parallelism: 1 };

async function bootApp() {
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
  const app = createApp({ cache, auth, oauth });
  return { app };
}

async function withServer(app, fn) {
  const server = app.listen(0);
  try { return await fn(`http://127.0.0.1:${server.address().port}`); }
  finally { server.close(); }
}

const ORIGIN = 'http://localhost:6274';

const CORS_PATHS = [
  ['GET',  '/.well-known/oauth-authorization-server'],
  ['GET',  '/.well-known/oauth-protected-resource'],
  ['POST', '/oauth/register'],
  ['POST', '/oauth/token'],
  ['POST', '/oauth/revoke'],
  ['POST', '/mcp'],
];

describe('CORS preflight on OAuth + MCP endpoints', () => {
  for (const [method, path] of CORS_PATHS) {
    it(`OPTIONS ${path} returns 204 + CORS headers (preflight ${method})`, async () => {
      const { app } = await bootApp();
      await withServer(app, async (base) => {
        const r = await fetch(`${base}${path}`, {
          method: 'OPTIONS',
          headers: {
            'Origin': ORIGIN,
            'Access-Control-Request-Method': method,
            'Access-Control-Request-Headers': 'content-type, authorization',
          },
        });
        assert.equal(r.status, 204, `expected 204 preflight, got ${r.status}`);
        assert.equal(r.headers.get('access-control-allow-origin'), '*');
        const allowedMethods = r.headers.get('access-control-allow-methods') || '';
        assert.match(allowedMethods, new RegExp(`\\b${method}\\b`),
          `Allow-Methods should include ${method}, got: ${allowedMethods}`);
        const allowedHeaders = (r.headers.get('access-control-allow-headers') || '').toLowerCase();
        assert.match(allowedHeaders, /content-type/);
        assert.match(allowedHeaders, /authorization/);
        // Wildcard origin must NOT be combined with credentials
        const cred = r.headers.get('access-control-allow-credentials');
        assert.ok(cred === null || cred === 'false',
          `Allow-Credentials must not be true with wildcard origin, got: ${cred}`);
      });
    });
  }
});

describe('CORS on actual responses (non-preflight)', () => {
  for (const [method, path] of CORS_PATHS) {
    it(`${method} ${path} response carries Access-Control-Allow-Origin: *`, async () => {
      const { app } = await bootApp();
      await withServer(app, async (base) => {
        const r = await fetch(`${base}${path}`, {
          method,
          headers: { 'Origin': ORIGIN, 'Content-Type': 'application/json' },
          body: method === 'POST' ? JSON.stringify({}) : undefined,
        });
        // We don't assert the status here — handler may return 400/401 for empty body.
        // We only care that the CORS header is present so the browser doesn't strip the response.
        assert.equal(r.headers.get('access-control-allow-origin'), '*',
          `${method} ${path} should expose Allow-Origin on actual responses too`);
      });
    });
  }
});

describe('CORS NOT applied to non-OAuth endpoints (Phase-1 regression)', () => {
  const NON_CORS_PATHS = [
    ['GET',  '/api/me'],
    ['GET',  '/login'],
    ['POST', '/login'],
    ['GET',  '/oauth/authorize'],
    ['GET',  '/api/config'],
    ['GET',  '/settings'],
  ];
  for (const [method, path] of NON_CORS_PATHS) {
    it(`${method} ${path} does NOT emit Access-Control-Allow-Origin`, async () => {
      const { app } = await bootApp();
      await withServer(app, async (base) => {
        const r = await fetch(`${base}${path}`, {
          method,
          headers: { 'Origin': ORIGIN, 'Content-Type': 'application/x-www-form-urlencoded' },
          body: method === 'POST' ? 'email=a@b.c&password=wrong' : undefined,
          redirect: 'manual',
        });
        assert.equal(r.headers.get('access-control-allow-origin'), null,
          `${method} ${path} should NOT have Allow-Origin (Phase-1 endpoint)`);
      });
    });
  }
});
