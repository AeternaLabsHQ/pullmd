import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createCache } from '../lib/cache.js';
import { createAuth } from '../lib/auth.js';
import { createOAuth } from '../lib/oauth/index.js';

const fastOpts = { timeCost: 1, memoryCost: 1024, parallelism: 1 };

async function setup() {
  const cache = createCache(':memory:');
  const auth = createAuth({
    db: cache.db, mode: 'multi-user',
    env: { PULLMD_ADMIN_EMAIL: 'a@b.c', PULLMD_ADMIN_PASSWORD: 'pw1234567' },
    argon2Opts: fastOpts,
    publicUrl: 'https://pullmd.test',
  });
  await auth.runMigration();
  const oauth = createOAuth({
    db: cache.db, auth,
    env: { OAUTH_JWT_SECRET: 'x'.repeat(48), PUBLIC_URL: 'https://pullmd.test' },
  });
  // Wire OAuth verifier into auth middleware
  auth.setAccessTokenVerifier(async (token) => {
    try {
      const payload = await oauth.tokens.verifyAccessToken(token);
      const userId = parseInt(payload.sub, 10);
      if (!userId) return null;
      const u = cache.db.prepare("SELECT id, email, is_admin FROM users WHERE id = ?").get(userId);
      return u ? { id: u.id, email: u.email, is_admin: !!u.is_admin } : null;
    } catch { return null; }
  });
  const userId = cache.db.prepare("SELECT id FROM users").get().id;
  const app = express();
  app.use(auth.middleware());
  app.get('/whoami', (req, res) => res.json({ user: req.user || null }));
  return { app, auth, oauth, userId };
}

async function withServer(app, fn) {
  const server = app.listen(0);
  try { return await fn(`http://127.0.0.1:${server.address().port}`); }
  finally { server.close(); }
}

describe('auth middleware: JWT bearer (OAuth)', () => {
  it('valid JWT populates req.user', async () => {
    const { app, oauth, userId } = await setup();
    const jwt = await oauth.tokens.issueAccessToken({ sub: userId, scope: 'mcp:full' });
    await withServer(app, async (base) => {
      const r = await fetch(`${base}/whoami`, {
        headers: { Authorization: `Bearer ${jwt}` },
      });
      const m = await r.json();
      assert.equal(m.user.email, 'a@b.c');
    });
  });

  it('JWT signed with different secret → req.user null', async () => {
    const { app, userId } = await setup();
    const otherCache = createCache(':memory:');
    const otherAuth = createAuth({
      db: otherCache.db, mode: 'multi-user',
      env: { PULLMD_ADMIN_EMAIL: 'a@b.c', PULLMD_ADMIN_PASSWORD: 'pw1234567' },
      argon2Opts: fastOpts,
    });
    await otherAuth.runMigration();
    const otherOauth = createOAuth({
      db: otherCache.db, auth: otherAuth,
      env: { OAUTH_JWT_SECRET: 'y'.repeat(48), PUBLIC_URL: 'https://pullmd.test' },
    });
    const jwt = await otherOauth.tokens.issueAccessToken({ sub: userId, scope: 'mcp:full' });
    await withServer(app, async (base) => {
      const r = await fetch(`${base}/whoami`, {
        headers: { Authorization: `Bearer ${jwt}` },
      });
      const m = await r.json();
      assert.equal(m.user, null);
    });
  });

  it('JWT with wrong audience → req.user null', async () => {
    const { app, oauth, userId } = await setup();
    // Impersonate a different audience by making a fresh tokens instance.
    const { createTokens } = await import('../lib/oauth/tokens.js');
    const wrongAud = createTokens({ secret: 'x'.repeat(48), issuer: 'https://pullmd.test', audience: 'https://other/mcp' });
    const jwt = await wrongAud.issueAccessToken({ sub: userId, scope: 'mcp:full' });
    await withServer(app, async (base) => {
      const r = await fetch(`${base}/whoami`, {
        headers: { Authorization: `Bearer ${jwt}` },
      });
      const m = await r.json();
      assert.equal(m.user, null);
    });
  });

  it('expired JWT → req.user null', async () => {
    const { app, oauth, userId } = await setup();
    // Sign a JWT with exp in the past — call jose directly
    const { SignJWT } = await import('jose');
    const key = new TextEncoder().encode('x'.repeat(48));
    const jwt = await new SignJWT({ scope: 'mcp:full' })
      .setProtectedHeader({ alg: 'HS256', typ: 'at+jwt' })
      .setIssuer('https://pullmd.test')
      .setAudience('https://pullmd.test/mcp')
      .setSubject(String(userId))
      .setIssuedAt(Math.floor(Date.now() / 1000) - 7200)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 3600)
      .sign(key);
    await withServer(app, async (base) => {
      const r = await fetch(`${base}/whoami`, {
        headers: { Authorization: `Bearer ${jwt}` },
      });
      const m = await r.json();
      assert.equal(m.user, null);
    });
  });

  it('regression: pmd_ API key path still works', async () => {
    const { app, auth, userId } = await setup();
    const { fullKey } = auth.createApiKey(userId, 'k');
    await withServer(app, async (base) => {
      const r = await fetch(`${base}/whoami`, {
        headers: { Authorization: `Bearer ${fullKey}` },
      });
      const m = await r.json();
      assert.equal(m.user.email, 'a@b.c');
    });
  });
});

describe('WWW-Authenticate: resource_metadata parameter', () => {
  it('401 response includes resource_metadata pointing at /.well-known/oauth-protected-resource', async () => {
    const { app, auth } = await setup();
    // Mount a protected route that triggers requireAuth
    app.get('/protected', auth.requireAuth(), (req, res) => res.json({ ok: true }));
    await withServer(app, async (base) => {
      const r = await fetch(`${base}/protected`);
      assert.equal(r.status, 401);
      const wwwAuth = r.headers.get('www-authenticate') || '';
      assert.match(wwwAuth, /Bearer/);
      assert.match(wwwAuth, /resource_metadata="[^"]*\/\.well-known\/oauth-protected-resource"/);
    });
  });
});
