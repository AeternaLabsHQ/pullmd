import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server.js';
import { createCache } from '../lib/cache.js';
import { createAuth } from '../lib/auth.js';
import { loginPage } from '../lib/auth-pages.js';

const fastOpts = { timeCost: 1, memoryCost: 1024, parallelism: 1 };
const bootstrapEnv = { PULLMD_ADMIN_EMAIL: 'a@b.c', PULLMD_ADMIN_PASSWORD: 'pw1234567' };

function makeAuth(mode, env = {}, allowSignup) {
  const cache = createCache(':memory:');
  const auth = createAuth({
    db: cache.db, mode,
    env: { ...bootstrapEnv, ...env },
    allowSignup,
    argon2Opts: fastOpts,
  });
  return { cache, auth };
}

async function withApp(mode, env, fn) {
  const { cache, auth } = makeAuth(mode, env);
  await auth.runMigration();
  const app = createApp({ cache, auth });
  const server = app.listen(0);
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`, { cache, auth });
  } finally {
    server.close();
  }
}

describe('PULLMD_ALLOW_SIGNUP parsing', () => {
  it('defaults to on when unset', () => {
    assert.equal(makeAuth('multi-user').auth.allowSignup, true);
  });

  for (const v of ['false', 'FALSE', ' false ', '0', 'no', 'off', 'Off']) {
    it(`treats ${JSON.stringify(v)} as off`, () => {
      assert.equal(makeAuth('multi-user', { PULLMD_ALLOW_SIGNUP: v }).auth.allowSignup, false);
    });
  }

  for (const v of ['true', '1', 'yes', 'on', '']) {
    it(`treats ${JSON.stringify(v)} as on`, () => {
      assert.equal(makeAuth('multi-user', { PULLMD_ALLOW_SIGNUP: v }).auth.allowSignup, true);
    });
  }

  it('honours an explicit override over the env', () => {
    assert.equal(makeAuth('multi-user', { PULLMD_ALLOW_SIGNUP: 'false' }, true).auth.allowSignup, true);
  });

  it('signupOpen is false outside multi-user even when signup is allowed', () => {
    assert.equal(makeAuth('single-admin').auth.signupOpen, false);
    assert.equal(makeAuth('multi-user').auth.signupOpen, true);
    assert.equal(makeAuth('multi-user', { PULLMD_ALLOW_SIGNUP: 'off' }).auth.signupOpen, false);
  });
});

describe('signup routes follow the switch', () => {
  it('multi-user with signup allowed serves /signup', async () => {
    await withApp('multi-user', {}, async (base) => {
      assert.equal((await fetch(base + '/signup')).status, 200);
    });
  });

  it('multi-user with signup off returns 404 for GET and POST', async () => {
    await withApp('multi-user', { PULLMD_ALLOW_SIGNUP: 'false' }, async (base) => {
      assert.equal((await fetch(base + '/signup')).status, 404);
      const post = await fetch(base + '/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'email=x@y.z&password=pw1234567&password_confirm=pw1234567',
      });
      assert.equal(post.status, 404);
    });
  });

  it('signup off does not create a user', async () => {
    await withApp('multi-user', { PULLMD_ALLOW_SIGNUP: 'false' }, async (base, { cache }) => {
      await fetch(base + '/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'email=sneak@y.z&password=pw1234567&password_confirm=pw1234567',
      });
      assert.equal(cache.db.prepare("SELECT COUNT(*) c FROM users WHERE email = ?").get('sneak@y.z').c, 0);
    });
  });

  it('single-admin never serves /signup', async () => {
    await withApp('single-admin', {}, async (base) => {
      assert.equal((await fetch(base + '/signup')).status, 404);
    });
  });
});

describe('login page signup link', () => {
  it('renders the link when signup is reachable', () => {
    assert.match(loginPage({ mode: 'multi-user', signupOpen: true }), /href="\/signup"/);
  });

  it('omits the link when signup is closed', () => {
    assert.doesNotMatch(loginPage({ mode: 'multi-user', signupOpen: false }), /href="\/signup"/);
  });

  it('omits the link in single-admin mode (regression: dead link)', () => {
    assert.doesNotMatch(loginPage({ mode: 'single-admin' }), /href="\/signup"/);
  });

  it('the served login page matches the switch', async () => {
    await withApp('multi-user', {}, async (base) => {
      assert.match(await (await fetch(base + '/login')).text(), /href="\/signup"/);
    });
    await withApp('multi-user', { PULLMD_ALLOW_SIGNUP: 'false' }, async (base) => {
      assert.doesNotMatch(await (await fetch(base + '/login')).text(), /href="\/signup"/);
    });
    await withApp('single-admin', {}, async (base) => {
      assert.doesNotMatch(await (await fetch(base + '/login')).text(), /href="\/signup"/);
    });
  });

  it('keeps the link out of the failed-login re-render when signup is closed', async () => {
    await withApp('multi-user', { PULLMD_ALLOW_SIGNUP: 'false' }, async (base) => {
      const r = await fetch(base + '/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'email=a@b.c&password=wrongpassword',
      });
      assert.equal(r.status, 401);
      assert.doesNotMatch(await r.text(), /href="\/signup"/);
    });
  });
});

describe('/api/config exposes the effective value', () => {
  it('reports signupOpen true only for multi-user with signup allowed', async () => {
    await withApp('multi-user', {}, async (base) => {
      assert.equal((await (await fetch(base + '/api/config')).json()).signupOpen, true);
    });
    await withApp('multi-user', { PULLMD_ALLOW_SIGNUP: 'false' }, async (base) => {
      assert.equal((await (await fetch(base + '/api/config')).json()).signupOpen, false);
    });
    await withApp('single-admin', {}, async (base) => {
      assert.equal((await (await fetch(base + '/api/config')).json()).signupOpen, false);
    });
  });

  it('reports false when auth is not configured at all', async () => {
    const app = createApp({ cache: createCache(':memory:') });
    const server = app.listen(0);
    try {
      const base = `http://127.0.0.1:${server.address().port}`;
      assert.equal((await (await fetch(base + '/api/config')).json()).signupOpen, false);
    } finally {
      server.close();
    }
  });
});
