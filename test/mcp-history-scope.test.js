import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createCache } from '../lib/cache.js';
import { createAuth } from '../lib/auth.js';
import { createOAuth } from '../lib/oauth/index.js';
import { createApp } from '../server.js';

// MCP list_recent follows the same scoping rules as GET /api/history:
// signed-in callers see their own conversions, anonymous callers (auth off)
// see the shared history unless DISABLE_PUBLIC_HISTORY is set.

const fastOpts = { timeCost: 1, memoryCost: 1024, parallelism: 1 };
const extractWeb = async () => ({
  markdown: '# x', title: 'x', source: 'readability', metadata: { quality: 0.9 },
});

async function withServer(app, fn) {
  const server = app.listen(0);
  try { return await fn(`http://127.0.0.1:${server.address().port}`); }
  finally { server.close(); }
}

function parseSse(text) {
  const m = /^data: (.+)$/m.exec(text);
  return m ? JSON.parse(m[1]) : JSON.parse(text);
}

async function callTool(base, name, args = {}, headers = {}) {
  const r = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...headers,
    },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name, arguments: args },
    }),
  });
  assert.equal(r.status, 200);
  return parseSse(await r.text()).result;
}

async function listRecentUrls(base, headers) {
  const result = await callTool(base, 'list_recent', {}, headers);
  assert.ok(!result.isError, result.content?.[0]?.text);
  return JSON.parse(result.content[0].text).map((it) => it.url);
}

async function bootMultiUser() {
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
      const u = cache.db.prepare('SELECT id, email, is_admin FROM users WHERE id = ?')
        .get(parseInt(payload.sub, 10));
      return u ? { id: u.id, email: u.email, is_admin: !!u.is_admin } : null;
    } catch { return null; }
  });
  const alice = await auth.createUser({ email: 'alice@x.y', password: 'pw1234567' });
  const bob = await auth.createUser({ email: 'bob@x.y', password: 'pw1234567' });
  const app = createApp({ cache, auth, oauth, extractWeb });
  return { app, auth, oauth, cache, alice, bob };
}

describe('MCP list_recent scope (multi-user)', () => {
  it('only returns the caller\'s own conversions (API key)', async () => {
    const { app, auth, alice, bob } = await bootMultiUser();
    const aliceKey = { Authorization: `Bearer ${auth.createApiKey(alice.id).fullKey}` };
    const bobKey = { Authorization: `Bearer ${auth.createApiKey(bob.id).fullKey}` };
    await withServer(app, async (base) => {
      const read = await callTool(base, 'read_url', { url: 'https://example.com/alice' }, aliceKey);
      assert.ok(!read.isError);

      assert.deepEqual(await listRecentUrls(base, aliceKey), ['https://example.com/alice']);
      assert.deepEqual(await listRecentUrls(base, bobKey), []);
    });
  });

  it('only returns the caller\'s own conversions (session cookie)', async () => {
    const { app, auth, cache, alice, bob } = await bootMultiUser();
    cache.put({ url: 'https://example.com/a', title: 'a', markdown: '# a', source: 's', user_id: alice.id });
    const aliceCookie = { Cookie: `pullmd_session=${auth.createSession(alice.id).token}` };
    const bobCookie = { Cookie: `pullmd_session=${auth.createSession(bob.id).token}` };
    await withServer(app, async (base) => {
      assert.deepEqual(await listRecentUrls(base, aliceCookie), ['https://example.com/a']);
      assert.deepEqual(await listRecentUrls(base, bobCookie), []);
    });
  });

  it('only returns the caller\'s own conversions (OAuth access token)', async () => {
    const { app, oauth, cache, alice, bob } = await bootMultiUser();
    cache.put({ url: 'https://example.com/a', title: 'a', markdown: '# a', source: 's', user_id: alice.id });
    const aliceJwt = await oauth.tokens.issueAccessToken({ sub: alice.id, scope: 'mcp:full' });
    const bobJwt = await oauth.tokens.issueAccessToken({ sub: bob.id, scope: 'mcp:full' });
    await withServer(app, async (base) => {
      assert.deepEqual(
        await listRecentUrls(base, { Authorization: `Bearer ${aliceJwt}` }),
        ['https://example.com/a'],
      );
      assert.deepEqual(await listRecentUrls(base, { Authorization: `Bearer ${bobJwt}` }), []);
    });
  });

  it('admin sees their own history, like GET /api/history', async () => {
    const { app, auth, cache, alice } = await bootMultiUser();
    cache.put({ url: 'https://example.com/a', title: 'a', markdown: '# a', source: 's', user_id: alice.id });
    const admin = cache.db.prepare('SELECT id FROM users WHERE is_admin = 1').get();
    const adminCookie = { Cookie: `pullmd_session=${auth.createSession(admin.id).token}` };
    await withServer(app, async (base) => {
      const rest = await (await fetch(`${base}/api/history`, { headers: adminCookie })).json();
      assert.deepEqual(rest, []);
      assert.deepEqual(await listRecentUrls(base, adminCookie), []);
    });
  });
});

describe('MCP list_recent scope (single-admin legacy token)', () => {
  it('returns the admin\'s own conversions', async () => {
    const cache = createCache(':memory:');
    const token = 'legacy-token-0123456789abcdef';
    const auth = createAuth({
      db: cache.db, mode: 'single-admin',
      env: { PULLMD_ADMIN_EMAIL: 'a@b.c', PULLMD_ADMIN_PASSWORD: 'pw1234567', PULLMD_AUTH_TOKEN: token },
      argon2Opts: fastOpts,
    });
    await auth.runMigration();
    const admin = cache.db.prepare('SELECT id FROM users WHERE is_admin = 1').get();
    cache.put({ url: 'https://example.com/mine', title: 'm', markdown: '# m', source: 's', user_id: admin.id });
    cache.put({ url: 'https://example.com/anon', title: 'n', markdown: '# n', source: 's' });
    const app = createApp({ cache, auth, extractWeb });
    await withServer(app, async (base) => {
      const headers = { Authorization: `Bearer ${token}` };
      const rest = (await (await fetch(`${base}/api/history`, { headers })).json()).map((it) => it.url);
      assert.deepEqual(rest, ['https://example.com/mine']);
      assert.deepEqual(await listRecentUrls(base, headers), rest);
    });
  });
});

describe('MCP list_recent scope (auth disabled)', () => {
  function seeded() {
    const cache = createCache(':memory:');
    cache.put({ url: 'https://example.com/a', title: 'a', markdown: '# a', source: 's' });
    return cache;
  }

  it('returns the shared history when public history is on', async () => {
    const app = createApp({ cache: seeded(), extractWeb, disablePublicHistory: false });
    await withServer(app, async (base) => {
      assert.deepEqual(await listRecentUrls(base), ['https://example.com/a']);
    });
  });

  it('returns an error result and no rows with DISABLE_PUBLIC_HISTORY', async () => {
    const app = createApp({ cache: seeded(), extractWeb, disablePublicHistory: true });
    await withServer(app, async (base) => {
      const result = await callTool(base, 'list_recent');
      assert.equal(result.isError, true);
      assert.equal(result.content[0].text, 'Public history is disabled on this instance.');
      assert.doesNotMatch(result.content[0].text, /example\.com/);
    });
  });
});

describe('MCP get_share description', () => {
  it('describes the 32-hex share id format', async () => {
    const app = createApp();
    await withServer(app, async (base) => {
      const r = await fetch(`${base}/mcp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      });
      const tool = parseSse(await r.text()).result.tools.find((t) => t.name === 'get_share');
      const text = JSON.stringify(tool);
      assert.doesNotMatch(text, /8-hex/);
      assert.match(tool.description, /32-hex/);
      assert.match(tool.inputSchema.properties.id.description, /32-hex/);
    });
  });
});
