import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
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
  auth.setAccessTokenVerifier(async (token) => {
    try {
      const payload = await oauth.tokens.verifyAccessToken(token);
      const u = cache.db.prepare("SELECT id, email, is_admin FROM users WHERE id = ?")
        .get(parseInt(payload.sub, 10));
      return u ? { id: u.id, email: u.email, is_admin: !!u.is_admin } : null;
    } catch { return null; }
  });
  const app = createApp({ cache, auth, oauth });
  return { app, auth, oauth, cache };
}

async function withServer(app, fn) {
  const server = app.listen(0);
  try { return await fn(`http://127.0.0.1:${server.address().port}`); }
  finally { server.close(); }
}

describe('OAuth end-to-end', () => {
  it('DCR → login → authorize → consent → token → /api/me', async () => {
    const { app, auth, cache } = await bootApp();
    const userId = cache.db.prepare("SELECT id FROM users").get().id;
    const { token: sess } = auth.createSession(userId);

    await withServer(app, async (base) => {
      // 1. DCR
      const reg = await (await fetch(`${base}/oauth/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          redirect_uris: ['https://claude.ai/api/mcp/auth_callback'],
          client_name: 'claude.ai',
          token_endpoint_auth_method: 'none',
        }),
      })).json();
      assert.ok(reg.client_id);

      // 2. Authorize (with session) → expect 200 consent page
      const verifier = randomBytes(32).toString('base64url');
      const challenge = createHash('sha256').update(verifier).digest('base64url');
      const state = randomBytes(8).toString('hex');
      const authzUrl = `${base}/oauth/authorize?response_type=code&client_id=${reg.client_id}` +
        `&redirect_uri=${encodeURIComponent('https://claude.ai/api/mcp/auth_callback')}` +
        `&code_challenge=${challenge}&code_challenge_method=S256&state=${state}&scope=mcp:full`;
      const authzRes = await fetch(authzUrl, { headers: { Cookie: `pullmd_session=${sess}` } });
      assert.equal(authzRes.status, 200);

      // 3. Consent (allow) → 302 to redirect_uri with code
      const consentRes = await fetch(`${base}/oauth/consent`, {
        method: 'POST',
        headers: { Cookie: `pullmd_session=${sess}`, 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          decision: 'allow',
          client_id: reg.client_id,
          redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
          code_challenge: challenge,
          code_challenge_method: 'S256',
          state, scope: 'mcp:full',
        }).toString(),
        redirect: 'manual',
      });
      assert.equal(consentRes.status, 302);
      const cb = new URL(consentRes.headers.get('location'));
      assert.equal(cb.searchParams.get('state'), state);
      const code = cb.searchParams.get('code');

      // 4. Code exchange
      const tokenRes = await fetch(`${base}/oauth/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code', code,
          client_id: reg.client_id,
          redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
          code_verifier: verifier,
        }).toString(),
      });
      assert.equal(tokenRes.status, 200);
      const tk = await tokenRes.json();
      assert.ok(tk.access_token);
      assert.ok(tk.refresh_token);

      // 5. Use access token to call /api/me
      const meRes = await fetch(`${base}/api/me`, {
        headers: { Authorization: `Bearer ${tk.access_token}` },
      });
      assert.equal(meRes.status, 200);
      const me = await meRes.json();
      assert.equal(me.email, 'a@b.c');

      // 6. Refresh
      const refreshRes = await fetch(`${base}/oauth/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: tk.refresh_token,
          client_id: reg.client_id,
        }).toString(),
      });
      assert.equal(refreshRes.status, 200);
      const tk2 = await refreshRes.json();
      assert.notEqual(tk2.refresh_token, tk.refresh_token);
    });
  });
});
