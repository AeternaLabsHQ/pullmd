import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createCache } from '../lib/cache.js';
import { createAuth } from '../lib/auth.js';
import express from 'express';

describe('api keys', () => {
  let cache, auth, userId;

  beforeEach(() => {
    cache = createCache(':memory:');
    auth = createAuth({ db: cache.db, mode: 'multi-user', env: {} });
    const r = cache.db
      .prepare("INSERT INTO users (email, password_hash) VALUES (?, ?)")
      .run('u@x.y', 'pw-hash');
    userId = r.lastInsertRowid;
  });

  it('createApiKey returns key with pmd_ prefix and 36 chars total', () => {
    const { fullKey, prefix } = auth.createApiKey(userId, 'My laptop');
    assert.match(fullKey, /^pmd_[A-Za-z0-9]{32}$/);
    assert.equal(fullKey.length, 36);
    assert.equal(prefix, fullKey.slice(0, 12));
  });

  it('lookupApiKey returns the user for a valid key', () => {
    const { fullKey } = auth.createApiKey(userId, 'k1');
    const user = auth.lookupApiKey(fullKey);
    assert.equal(user.id, userId);
    assert.equal(user.email, 'u@x.y');
  });

  it('lookupApiKey returns null for malformed prefix', () => {
    assert.equal(auth.lookupApiKey('bearer-no-prefix'), null);
    assert.equal(auth.lookupApiKey(''), null);
    assert.equal(auth.lookupApiKey(null), null);
  });

  it('lookupApiKey returns null for unknown key', () => {
    assert.equal(auth.lookupApiKey('pmd_' + 'x'.repeat(32)), null);
  });

  it('lookupApiKey updates last_used_at', () => {
    const { fullKey } = auth.createApiKey(userId, 'k2');
    const before = cache.db.prepare("SELECT last_used_at FROM api_keys WHERE label = 'k2'").get();
    assert.equal(before.last_used_at, null);
    auth.lookupApiKey(fullKey);
    const after = cache.db.prepare("SELECT last_used_at FROM api_keys WHERE label = 'k2'").get();
    assert.ok(after.last_used_at);
  });

  it('listApiKeys returns prefix + label, never the full key or hash', () => {
    auth.createApiKey(userId, 'k3');
    auth.createApiKey(userId, 'k4');
    const keys = auth.listApiKeys(userId);
    assert.equal(keys.length, 2);
    for (const k of keys) {
      assert.ok(k.id);
      assert.match(k.key_prefix, /^pmd_/);
      assert.ok('last_used_at' in k);
      assert.ok(!('key_hash' in k), 'must not leak key_hash');
    }
  });

  it('revokeApiKey deletes by id, scoped to user', () => {
    const { fullKey } = auth.createApiKey(userId, 'doomed');
    const id = cache.db.prepare("SELECT id FROM api_keys WHERE label = 'doomed'").get().id;
    assert.equal(auth.revokeApiKey(userId, id), true);
    assert.equal(auth.lookupApiKey(fullKey), null);
    assert.equal(auth.revokeApiKey(userId, id), false);
  });

  it('revokeApiKey refuses to delete another user\'s key', () => {
    const r = cache.db
      .prepare("INSERT INTO users (email, password_hash) VALUES (?, ?)")
      .run('other@x.y', 'pw');
    const otherId = r.lastInsertRowid;
    auth.createApiKey(userId, 'mine');
    const myKeyId = cache.db.prepare("SELECT id FROM api_keys WHERE label = 'mine'").get().id;
    assert.equal(auth.revokeApiKey(otherId, myKeyId), false);
    assert.equal(auth.listApiKeys(userId).length, 1);
  });
});

describe('api key routes - same-origin check', () => {
  async function withApp(fn) {
    const cache = createCache(':memory:');
    const auth = createAuth({ db: cache.db, mode: 'multi-user', env: {} });
    const userId = cache.db
      .prepare("INSERT INTO users (email, password_hash) VALUES (?, ?)")
      .run('u@x.y', 'pw-hash').lastInsertRowid;
    const app = express();
    app.use(auth.middleware());
    auth.mountAuthRoutes(app);
    const server = app.listen(0);
    try {
      const base = `http://127.0.0.1:${server.address().port}`;
      const { token } = auth.createSession(userId);
      return await fn(base, { auth, cache, userId, cookie: `pullmd_session=${token}` });
    } finally {
      server.close();
    }
  }

  const form = { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'text/html' };

  it('POST /api/keys refuses a foreign Origin and creates no key', async () => {
    await withApp(async (base, { auth, userId, cookie }) => {
      const r = await fetch(base + '/api/keys', {
        method: 'POST', redirect: 'manual',
        headers: { ...form, Cookie: cookie, Origin: 'https://evil.example' },
        body: 'label=x',
      });
      assert.equal(r.status, 403);
      assert.equal(auth.listApiKeys(userId).length, 0);
    });
  });

  it('POST /api/keys with the instance origin still redirects and creates the key', async () => {
    await withApp(async (base, { auth, userId, cookie }) => {
      const r = await fetch(base + '/api/keys', {
        method: 'POST', redirect: 'manual',
        headers: { ...form, Cookie: cookie, Origin: base },
        body: 'label=x',
      });
      assert.equal(r.status, 302);
      assert.equal(r.headers.get('location'), '/settings');
      assert.equal(auth.listApiKeys(userId).length, 1);
    });
  });

  it('POST /api/keys/:id/revoke refuses a foreign Origin and keeps the key', async () => {
    await withApp(async (base, { auth, cache, userId, cookie }) => {
      auth.createApiKey(userId, 'keep');
      const id = cache.db.prepare("SELECT id FROM api_keys WHERE label = 'keep'").get().id;
      const r = await fetch(base + `/api/keys/${id}/revoke`, {
        method: 'POST', redirect: 'manual',
        headers: { ...form, Cookie: cookie, Origin: 'https://evil.example' },
        body: '',
      });
      assert.equal(r.status, 403);
      assert.equal(auth.listApiKeys(userId).length, 1);
    });
  });

  it('POST /api/keys/:id/revoke with the instance origin still redirects and revokes', async () => {
    await withApp(async (base, { auth, cache, userId, cookie }) => {
      auth.createApiKey(userId, 'doomed');
      const id = cache.db.prepare("SELECT id FROM api_keys WHERE label = 'doomed'").get().id;
      const r = await fetch(base + `/api/keys/${id}/revoke`, {
        method: 'POST', redirect: 'manual',
        headers: { ...form, Cookie: cookie, Origin: base },
        body: '',
      });
      assert.equal(r.status, 302);
      assert.equal(auth.listApiKeys(userId).length, 0);
    });
  });

  it('an API key in Authorization without Origin keeps working on both routes', async () => {
    await withApp(async (base, { auth, userId }) => {
      const { fullKey } = auth.createApiKey(userId, 'cli');
      const headers = { ...form, Accept: 'application/json', Authorization: `Bearer ${fullKey}` };
      const created = await fetch(base + '/api/keys', { method: 'POST', headers, body: 'label=second' });
      assert.equal(created.status, 200);
      assert.match((await created.json()).key, /^pmd_/);
      const id = auth.listApiKeys(userId).find((k) => k.label === 'second').id;
      const revoked = await fetch(base + `/api/keys/${id}/revoke`, { method: 'POST', headers, body: '' });
      assert.equal(revoked.status, 200);
      assert.deepEqual(await revoked.json(), { ok: true });
    });
  });
});
