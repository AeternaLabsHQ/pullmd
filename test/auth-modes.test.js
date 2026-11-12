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

  it('legacy PULLMD_AUTH_TOKEN gets registered as admin\'s API key', async () => {
    const cache = createCache(':memory:');
    const auth = createAuth({
      db: cache.db, mode: 'single-admin',
      env: {
        PULLMD_ADMIN_EMAIL: 'a@b.c',
        PULLMD_ADMIN_PASSWORD: 'pw1234567',
        PULLMD_AUTH_TOKEN: 'legacy-token-abc',
      },
      ...fastOpts,
    });
    await auth.runMigration();
    const user = auth.lookupLegacyToken('legacy-token-abc');
    assert.ok(user, 'legacy token should resolve to admin');
    assert.equal(user.email, 'a@b.c');
    assert.equal(auth.lookupLegacyToken('wrong-token'), null);

    const keys = cache.db.prepare('SELECT user_id, key_hash, key_prefix, label FROM api_keys').all();
    assert.deepEqual(keys, [{
      user_id: user.id,
      key_hash: createHash('sha256').update('legacy-token-abc').digest('hex'),
      key_prefix: 'legacy-token',
      label: 'legacy PULLMD_AUTH_TOKEN',
    }]);
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
