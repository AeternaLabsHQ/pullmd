import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import express from 'express';
import { createCache } from '../lib/cache.js';
import { createAuth } from '../lib/auth.js';
import { createOAuth, mountOAuthRoutes } from '../lib/oauth/index.js';
import { createUserCmd } from '../scripts/admin.js';

const fastOpts = { timeCost: 1, memoryCost: 1024, parallelism: 1 };
const FORM = { 'Content-Type': 'application/x-www-form-urlencoded' };
const LOGIN_BODY = 'email=admin@x.y&password=adminpass1';

async function withApp({ env = {}, publicUrl, trustProxy, oauth = false } = {}, fn) {
  const cache = createCache(':memory:');
  const auth = createAuth({
    db: cache.db, mode: 'multi-user',
    env: { PULLMD_ADMIN_EMAIL: 'admin@x.y', PULLMD_ADMIN_PASSWORD: 'adminpass1', ...env },
    argon2Opts: fastOpts,
    publicUrl,
  });
  await auth.runMigration();
  const app = express();
  if (trustProxy !== undefined) app.set('trust proxy', trustProxy);
  app.use(auth.middleware());
  auth.mountAuthRoutes(app);
  let oa = null;
  if (oauth) {
    oa = createOAuth({
      db: cache.db, auth,
      env: { OAUTH_JWT_SECRET: 'x'.repeat(48), PUBLIC_URL: 'https://pullmd.test' },
    });
    mountOAuthRoutes(app, oa);
  }
  const server = app.listen(0);
  try {
    const port = server.address().port;
    return await fn(`http://127.0.0.1:${port}`, { auth, cache, port, oauth: oa });
  } finally {
    server.close();
  }
}

function login(base, headers = {}) {
  return fetch(base + '/login', {
    method: 'POST', headers: { ...FORM, ...headers }, body: LOGIN_BODY, redirect: 'manual',
  });
}

describe('account email validation', () => {
  it('signup refuses an email containing markup', async () => {
    await withApp({}, async (base, { cache }) => {
      const email = '<img src=x>@x.y';
      const body = new URLSearchParams({ email, password: 'pw1234567', password_confirm: 'pw1234567' });
      const r = await fetch(base + '/signup', { method: 'POST', headers: FORM, body: body.toString(), redirect: 'manual' });
      assert.equal(r.status, 400);
      assert.match(await r.text(), /Invalid email/);
      assert.equal(cache.db.prepare('SELECT COUNT(*) c FROM users').get().c, 1);
    });
  });

  for (const email of [
    'a b@x.y', 'a@b@x.y', '@x.y', 'a@', 'a@xy', 'a@.x.y', 'a@x.y.', 'a"b@x.y', "a'b@x.y",
    'a(b)@x.y', 'a;b@x.y', 'a,b@x.y', 'a`b@x.y', 'a\\b@x.y', 'a\u0001b@x.y', 'a@x.y\u007f',
  ]) {
    it(`createUser refuses ${JSON.stringify(email)}`, async () => {
      await withApp({}, async (_base, { auth }) => {
        await assert.rejects(auth.createUser({ email, password: 'pw1234567' }), /Invalid email/);
      });
    });
  }

  it('createUser still accepts ordinary addresses', async () => {
    await withApp({}, async (_base, { auth }) => {
      const u = await auth.createUser({ email: '  First.Last+tag@Sub.Example.org ', password: 'pw1234567' });
      assert.equal(u.email, 'first.last+tag@sub.example.org');
    });
  });

  it('admin CLI create-user uses the same email rules', async () => {
    await withApp({}, async (_base, { auth, cache }) => {
      const r = await createUserCmd({ db: cache.db, auth }, '<b>x</b>@x.y', 'pw1234567');
      assert.equal(r.ok, false);
      assert.equal(r.reason, 'invalid');
    });
  });

  it('an existing account whose email does not meet the signup rules can still log in', async () => {
    await withApp({ env: { PULLMD_ADMIN_EMAIL: 'admin@localhost' } }, async (base) => {
      const r = await fetch(base + '/login', {
        method: 'POST', headers: FORM, body: 'email=Admin@localhost&password=adminpass1', redirect: 'manual',
      });
      assert.equal(r.status, 302);
    });
  });
});

describe('same-origin check on auth form posts', () => {
  it('accepts a form post without Origin or Referer', async () => {
    await withApp({}, async (base) => {
      assert.equal((await login(base)).status, 302);
    });
  });

  it('accepts a same-origin form post', async () => {
    await withApp({}, async (base) => {
      assert.equal((await login(base, { Origin: base })).status, 302);
    });
  });

  it('allows a secure Origin on a plain-HTTP request to the same host', async () => {
    await withApp({}, async (base, { port }) => {
      const r = await login(base, { Origin: `https://127.0.0.1:${port}` });
      assert.equal(r.status, 302);
    });
  });

  it('accepts a same-host Referer when Origin is absent', async () => {
    await withApp({}, async (base, { port }) => {
      const r = await login(base, { Referer: `https://127.0.0.1:${port}/login?next=/` });
      assert.equal(r.status, 302);
    });
  });

  it('accepts an Origin matching PUBLIC_URL when the Host header differs', async () => {
    await withApp({ publicUrl: 'https://pullmd.example' }, async (base) => {
      const r = await login(base, { Origin: 'https://pullmd.example' });
      assert.equal(r.status, 302);
    });
  });

  it('accepts an Origin matching a forwarded host from a trusted proxy', async () => {
    await withApp({ trustProxy: true }, async (base) => {
      const r = await login(base, { Origin: 'https://pullmd.example', 'X-Forwarded-Host': 'pullmd.example' });
      assert.equal(r.status, 302);
    });
  });

  it('ignores a forwarded host when no proxy is trusted', async () => {
    await withApp({}, async (base) => {
      const r = await login(base, { Origin: 'https://pullmd.example', 'X-Forwarded-Host': 'pullmd.example' });
      assert.equal(r.status, 403);
    });
  });

  it('rejects a login form post from another origin', async () => {
    await withApp({}, async (base) => {
      const r = await login(base, { Origin: 'https://other.example' });
      assert.equal(r.status, 403);
      assert.equal(r.headers.get('set-cookie'), null);
    });
  });

  it('rejects a form post whose Referer is another origin', async () => {
    await withApp({}, async (base) => {
      const r = await login(base, { Referer: 'https://other.example/page' });
      assert.equal(r.status, 403);
    });
  });

  it('rejects an opaque Origin', async () => {
    await withApp({}, async (base) => {
      assert.equal((await login(base, { Origin: 'null' })).status, 403);
    });
  });

  it('rejects a signup form post from another origin', async () => {
    await withApp({}, async (base, { cache }) => {
      const body = new URLSearchParams({ email: 'new@x.y', password: 'pw1234567', password_confirm: 'pw1234567' });
      const r = await fetch(base + '/signup', {
        method: 'POST', headers: { ...FORM, Origin: 'https://other.example' }, body: body.toString(), redirect: 'manual',
      });
      assert.equal(r.status, 403);
      assert.equal(cache.db.prepare('SELECT COUNT(*) c FROM users').get().c, 1);
    });
  });

  it('rejects a logout form post from another origin and keeps the session', async () => {
    await withApp({}, async (base, { auth, cache }) => {
      const uid = cache.db.prepare('SELECT id FROM users').get().id;
      const { token } = auth.createSession(uid);
      const r = await fetch(base + '/logout', {
        method: 'POST', headers: { Cookie: `pullmd_session=${token}`, Origin: 'https://other.example' }, redirect: 'manual',
      });
      assert.equal(r.status, 403);
      assert.ok(auth.lookupSession(token), 'session must survive');
    });
  });

  it('accepts a same-origin logout', async () => {
    await withApp({}, async (base, { auth, cache }) => {
      const uid = cache.db.prepare('SELECT id FROM users').get().id;
      const { token } = auth.createSession(uid);
      const r = await fetch(base + '/logout', {
        method: 'POST', headers: { Cookie: `pullmd_session=${token}`, Origin: base }, redirect: 'manual',
      });
      assert.equal(r.status, 302);
    });
  });

  it('rejects an OAuth consent form post from another origin', async () => {
    await withApp({ oauth: true }, async (base, { auth, cache, oauth }) => {
      const uid = cache.db.prepare('SELECT id FROM users').get().id;
      const { token } = auth.createSession(uid);
      const client = oauth.store.registerClient({
        redirect_uris: ['https://claude.ai/api/mcp/auth_callback'],
        client_name: 'Claude.ai',
        token_endpoint_auth_method: 'none',
      });
      const body = new URLSearchParams({
        decision: 'allow', client_id: client.client_id,
        redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
        code_challenge: 'CHAL', code_challenge_method: 'S256', state: 'S', scope: 'mcp:full',
      }).toString();
      const post = (origin) => fetch(base + '/oauth/consent', {
        method: 'POST',
        headers: { ...FORM, Cookie: `pullmd_session=${token}`, Origin: origin },
        body, redirect: 'manual',
      });
      assert.equal((await post('https://other.example')).status, 403);
      assert.equal((await post('https://pullmd.test')).status, 302);
    });
  });
});

describe('PWA auth slot', () => {
  it('renders the account email as text, not markup', () => {
    const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
    assert.doesNotMatch(html, /\$\{me\.email\}/);
    assert.doesNotMatch(html, /slot\.innerHTML/);
  });
});
