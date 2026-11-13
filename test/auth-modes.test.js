import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createCache } from '../lib/cache.js';
import { createAuth } from '../lib/auth.js';

const fastOpts = { argon2Opts: { timeCost: 1, memoryCost: 1024, parallelism: 1 } };

describe('auth modes', () => {
  it('throws on unknown mode', () => {
    const cache = createCache(':memory:');
    assert.throws(() => createAuth({ db: cache.db, mode: 'unknown' }), /Invalid PULLMD_AUTH_MODE/);
  });

  for (const mode of ['disabled', 'single-admin', 'multi-user']) {
    it(`accepts mode=${mode}`, () => {
      const cache = createCache(':memory:');
      const auth = createAuth({ db: cache.db, mode, env: {} });
      assert.equal(auth.mode, mode);
    });
  }

  it('disabled mode: runMigration is a no-op', async () => {
    const cache = createCache(':memory:');
    const auth = createAuth({ db: cache.db, mode: 'disabled', env: {}, ...fastOpts });
    await auth.runMigration();
    assert.equal(cache.db.prepare("SELECT COUNT(*) c FROM users").get().c, 0);
  });

  it('single-admin requires PULLMD_ADMIN_EMAIL + PULLMD_ADMIN_PASSWORD on first run', async () => {
    const cache = createCache(':memory:');
    const auth = createAuth({ db: cache.db, mode: 'single-admin', env: {}, ...fastOpts });
    await assert.rejects(() => auth.runMigration(), /PULLMD_ADMIN_EMAIL/);
  });

  it('runMigration: missing-creds error carries err.code = ERR_BOOTSTRAP_MISSING_CREDENTIALS', async () => {
    const cache = createCache(':memory:');
    const auth = createAuth({ db: cache.db, mode: 'single-admin', env: {}, ...fastOpts });
    let caught;
    try { await auth.runMigration(); } catch (e) { caught = e; }
    assert.ok(caught, 'runMigration should throw');
    assert.equal(caught.code, 'ERR_BOOTSTRAP_MISSING_CREDENTIALS');
  });

  it('single-admin bootstraps admin user from env on first run', async () => {
    const cache = createCache(':memory:');
    const auth = createAuth({
      db: cache.db, mode: 'single-admin',
      env: { PULLMD_ADMIN_EMAIL: 'admin@x.y', PULLMD_ADMIN_PASSWORD: 'sekret123' },
      ...fastOpts,
    });
    await auth.runMigration();
    const u = cache.db.prepare("SELECT id, email, is_admin FROM users").get();
    assert.equal(u.email, 'admin@x.y');
    assert.equal(u.is_admin, 1);
  });

  it('runMigration is idempotent', async () => {
    const cache = createCache(':memory:');
    const env = { PULLMD_ADMIN_EMAIL: 'admin@x.y', PULLMD_ADMIN_PASSWORD: 'sekret123' };
    const auth = createAuth({ db: cache.db, mode: 'single-admin', env, ...fastOpts });
    await auth.runMigration();
    await auth.runMigration();
    await auth.runMigration();
    assert.equal(cache.db.prepare("SELECT COUNT(*) c FROM users").get().c, 1);
  });

  // The env token authenticates through lookupLegacyToken (constant-time env
  // comparison); it is not stored as an api_keys row.
  const adminEnv = { PULLMD_ADMIN_EMAIL: 'a@b.c', PULLMD_ADMIN_PASSWORD: 'pw1234567' };
  const sha256 = (v) => createHash('sha256').update(v).digest('hex');

  it('legacy PULLMD_AUTH_TOKEN authenticates as admin without an api_keys row', async () => {
    const cache = createCache(':memory:');
    const auth = createAuth({
      db: cache.db, mode: 'single-admin',
      env: { ...adminEnv, PULLMD_AUTH_TOKEN: 'legacy-token-abc' },
      ...fastOpts,
    });
    await auth.runMigration();
    const user = auth.lookupLegacyToken('legacy-token-abc');
    assert.ok(user, 'legacy token should resolve to admin');
    assert.equal(user.email, 'a@b.c');
    assert.equal(auth.lookupLegacyToken('wrong-token'), null);
    assert.equal(cache.db.prepare('SELECT COUNT(*) c FROM api_keys').get().c, 0);
  });

  it('runMigration removes a legacy api_keys row left by an earlier version', async () => {
    const cache = createCache(':memory:');
    const env = { ...adminEnv, PULLMD_AUTH_TOKEN: 'legacy-token-abc' };
    const auth = createAuth({ db: cache.db, mode: 'single-admin', env, ...fastOpts });
    await auth.runMigration();
    const adminId = cache.db.prepare('SELECT id FROM users').get().id;
    const insert = cache.db.prepare('INSERT INTO api_keys (user_id, key_hash, key_prefix, label) VALUES (?, ?, ?, ?)');
    insert.run(adminId, sha256('legacy-token-abc'), 'legacy-token', 'legacy PULLMD_AUTH_TOKEN');
    insert.run(adminId, sha256('pmd_other'), 'pmd_other', 'my script');

    await auth.runMigration();
    await auth.runMigration();

    const labels = cache.db.prepare('SELECT label FROM api_keys').all().map((r) => r.label);
    assert.deepEqual(labels, ['my script']);
    assert.ok(auth.lookupLegacyToken('legacy-token-abc'), 'the env token itself keeps working');
  });

  it('a pmd_-prefixed legacy token stops authenticating once the env var is gone', async () => {
    const cache = createCache(':memory:');
    const token = 'pmd_' + 'a'.repeat(32);
    const adminId = (await (async () => {
      const first = createAuth({ db: cache.db, mode: 'single-admin', env: adminEnv, ...fastOpts });
      await first.runMigration();
      return cache.db.prepare('SELECT id FROM users').get().id;
    })());
    // State an earlier version produced: the env token stored as a key row.
    cache.db.prepare('INSERT INTO api_keys (user_id, key_hash, key_prefix, label) VALUES (?, ?, ?, ?)')
      .run(adminId, sha256(token), token.slice(0, 12), 'legacy PULLMD_AUTH_TOKEN');
    assert.ok(createAuth({ db: cache.db, mode: 'single-admin', env: adminEnv, ...fastOpts }).lookupApiKey(token),
      'precondition: the stale row authenticates');

    // Operator removed PULLMD_AUTH_TOKEN and restarts.
    const restarted = createAuth({ db: cache.db, mode: 'single-admin', env: adminEnv, ...fastOpts });
    await restarted.runMigration();

    assert.equal(restarted.lookupApiKey(token), null);
    assert.equal(restarted.lookupLegacyToken(token), null);
  });

  it('legacy lookup is disabled in multi-user mode', async () => {
    const cache = createCache(':memory:');
    const auth = createAuth({
      db: cache.db, mode: 'multi-user',
      env: {
        PULLMD_ADMIN_EMAIL: 'a@b.c',
        PULLMD_ADMIN_PASSWORD: 'pw1234567',
        PULLMD_AUTH_TOKEN: 'legacy-token-abc',
      },
      ...fastOpts,
    });
    await auth.runMigration();
    assert.equal(auth.lookupLegacyToken('legacy-token-abc'), null);
  });

  it('cache-row backfill: existing conversions get user_id = admin.id on first migration', async () => {
    const cache = createCache(':memory:');
    cache.put({ url: 'https://pre.com', title: 'Pre', markdown: '# pre', source: 'readability' });
    const before = cache.db.prepare("SELECT user_id FROM conversions").get();
    assert.equal(before.user_id, null);

    const auth = createAuth({
      db: cache.db, mode: 'single-admin',
      env: { PULLMD_ADMIN_EMAIL: 'a@b.c', PULLMD_ADMIN_PASSWORD: 'pw1234567' },
      ...fastOpts,
    });
    await auth.runMigration();

    const adminId = cache.db.prepare("SELECT id FROM users").get().id;
    const after = cache.db.prepare("SELECT user_id FROM conversions").get();
    assert.equal(after.user_id, adminId);
  });

  it('user_fetches backfill: existing conversions get a user_fetches row for admin', async () => {
    const cache = createCache(':memory:');
    cache.put({ url: 'https://a.com', title: 'A', markdown: '# a', source: 'readability' });
    cache.put({ url: 'https://b.com', title: 'B', markdown: '# b', source: 'readability' });
    cache.put({ url: 'https://c.com', title: 'C', markdown: '# c', source: 'readability' });
    assert.equal(cache.db.prepare("SELECT COUNT(*) c FROM user_fetches").get().c, 0);

    const auth = createAuth({
      db: cache.db, mode: 'single-admin',
      env: { PULLMD_ADMIN_EMAIL: 'a@b.c', PULLMD_ADMIN_PASSWORD: 'pw1234567' },
      ...fastOpts,
    });
    await auth.runMigration();

    const adminId = cache.db.prepare("SELECT id FROM users").get().id;
    const fetches = cache.db.prepare(
      "SELECT user_id, cache_id, fetched_at FROM user_fetches ORDER BY cache_id"
    ).all();
    assert.equal(fetches.length, 3);
    for (const f of fetches) {
      assert.equal(f.user_id, adminId);
      assert.ok(f.fetched_at, 'fetched_at copied from conversions.created_at');
    }
  });

  it('user_fetches backfill is idempotent across repeated migrations', async () => {
    const cache = createCache(':memory:');
    cache.put({ url: 'https://a.com', title: 'A', markdown: '# a', source: 'readability' });
    cache.put({ url: 'https://b.com', title: 'B', markdown: '# b', source: 'readability' });

    const auth = createAuth({
      db: cache.db, mode: 'single-admin',
      env: { PULLMD_ADMIN_EMAIL: 'a@b.c', PULLMD_ADMIN_PASSWORD: 'pw1234567' },
      ...fastOpts,
    });
    await auth.runMigration();
    await auth.runMigration();
    await auth.runMigration();
    assert.equal(cache.db.prepare("SELECT COUNT(*) c FROM user_fetches").get().c, 2);
  });
});
