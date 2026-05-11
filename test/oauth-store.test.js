import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createCache } from '../lib/cache.js';
import { createOAuthStore } from '../lib/oauth/store.js';
import { createAuth } from '../lib/auth.js';

const fastOpts = { timeCost: 1, memoryCost: 1024, parallelism: 1 };

describe('oauth schema', () => {
  it('creates oauth_clients, oauth_auth_codes, oauth_refresh_tokens tables', () => {
    const cache = createCache(':memory:');
    const tables = cache.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map(r => r.name);
    assert.ok(tables.includes('oauth_clients'), 'oauth_clients missing');
    assert.ok(tables.includes('oauth_auth_codes'), 'oauth_auth_codes missing');
    assert.ok(tables.includes('oauth_refresh_tokens'), 'oauth_refresh_tokens missing');
  });

  it('oauth_clients has expected columns', () => {
    const cache = createCache(':memory:');
    const cols = cache.db.prepare("PRAGMA table_info(oauth_clients)").all().map(c => c.name);
    for (const col of ['client_id', 'client_secret_hash', 'redirect_uris', 'client_name',
                       'token_endpoint_auth_method', 'created_via', 'created_at', 'last_used_at']) {
      assert.ok(cols.includes(col), `oauth_clients.${col} missing`);
    }
  });

  it('oauth_auth_codes has expected columns', () => {
    const cache = createCache(':memory:');
    const cols = cache.db.prepare("PRAGMA table_info(oauth_auth_codes)").all().map(c => c.name);
    for (const col of ['code_hash', 'client_id', 'user_id', 'redirect_uri',
                       'code_challenge', 'code_challenge_method', 'scope',
                       'expires_at', 'used_at']) {
      assert.ok(cols.includes(col), `oauth_auth_codes.${col} missing`);
    }
  });

  it('oauth_refresh_tokens has expected columns', () => {
    const cache = createCache(':memory:');
    const cols = cache.db.prepare("PRAGMA table_info(oauth_refresh_tokens)").all().map(c => c.name);
    for (const col of ['token_hash', 'client_id', 'user_id', 'scope',
                       'rotated_from', 'revoked_at', 'created_at', 'expires_at']) {
      assert.ok(cols.includes(col), `oauth_refresh_tokens.${col} missing`);
    }
  });
});

async function makeStore() {
  const cache = createCache(':memory:');
  const auth = createAuth({
    db: cache.db, mode: 'multi-user',
    env: { PULLMD_ADMIN_EMAIL: 'a@b.c', PULLMD_ADMIN_PASSWORD: 'pw1234567' },
    argon2Opts: fastOpts,
  });
  await auth.runMigration();
  const userId = cache.db.prepare("SELECT id FROM users").get().id;
  const store = createOAuthStore({ db: cache.db });
  return { cache, store, userId };
}

function makeStoreSync() {
  const cache = createCache(':memory:');
  const store = createOAuthStore({ db: cache.db });
  return { cache, store };
}

describe('oauth client store (DCR)', () => {
  it('registers a new client and returns client_id + (optional) secret', async () => {
    const { store } = await makeStore();
    const reg = store.registerClient({
      redirect_uris: ['https://claude.ai/api/mcp/auth_callback'],
      client_name: 'Claude.ai',
      token_endpoint_auth_method: 'none',
    });
    assert.ok(reg.client_id);
    assert.equal(reg.client_secret, undefined);
    const got = store.getClient(reg.client_id);
    assert.equal(got.client_name, 'Claude.ai');
    assert.deepEqual(JSON.parse(got.redirect_uris), ['https://claude.ai/api/mcp/auth_callback']);
  });

  it('confidential client (client_secret_post) returns and stores hashed secret', async () => {
    const { store } = await makeStore();
    const reg = store.registerClient({
      redirect_uris: ['https://x/cb'],
      client_name: 'X',
      token_endpoint_auth_method: 'client_secret_post',
    });
    assert.ok(reg.client_secret);
    const got = store.getClient(reg.client_id);
    assert.ok(got.client_secret_hash);
    assert.notEqual(got.client_secret_hash, reg.client_secret);
    assert.equal(store.verifyClientSecret(reg.client_id, reg.client_secret), true);
    assert.equal(store.verifyClientSecret(reg.client_id, 'wrong'), false);
  });

  it('rejects redirect_uris that are not http(s)', () => {
    const { store } = makeStoreSync();
    assert.throws(() => store.registerClient({
      redirect_uris: ['javascript:alert(1)'], client_name: 'X',
      token_endpoint_auth_method: 'none',
    }), /redirect_uri/i);
  });

  it('rejects empty redirect_uris', () => {
    const { store } = makeStoreSync();
    assert.throws(() => store.registerClient({
      redirect_uris: [], client_name: 'X', token_endpoint_auth_method: 'none',
    }), /redirect_uri/i);
  });
});

describe('oauth auth-code store', () => {
  it('stores + retrieves a code by hash, marks one-time-use', async () => {
    const { store, userId } = await makeStore();
    const reg = store.registerClient({
      redirect_uris: ['https://x/cb'], client_name: 'X', token_endpoint_auth_method: 'none',
    });
    const { code, codeHash } = store.createAuthCode({
      client_id: reg.client_id,
      user_id: userId,
      redirect_uri: 'https://x/cb',
      code_challenge: 'CHALLENGE',
      code_challenge_method: 'S256',
      scope: 'mcp:full',
    });
    assert.ok(code);
    const found = store.consumeAuthCode(codeHash);
    assert.equal(found.user_id, userId);
    assert.equal(found.scope, 'mcp:full');
    // Second consume returns null (already used).
    assert.equal(store.consumeAuthCode(codeHash), null);
  });

  it('expired code returns null on consume and is invalidated', async () => {
    const { store, userId, cache } = await makeStore();
    const reg = store.registerClient({
      redirect_uris: ['https://x/cb'], client_name: 'X', token_endpoint_auth_method: 'none',
    });
    const { codeHash } = store.createAuthCode({
      client_id: reg.client_id, user_id: userId, redirect_uri: 'https://x/cb',
      code_challenge: 'C', code_challenge_method: 'S256', scope: 'mcp:full',
    });
    // Forcibly expire it.
    cache.db.prepare("UPDATE oauth_auth_codes SET expires_at = datetime('now', '-1 minute') WHERE code_hash = ?").run(codeHash);
    assert.equal(store.consumeAuthCode(codeHash), null);
  });
});

describe('oauth refresh-token chain (rotation + reuse detection)', () => {
  it('rotates a refresh token: new row links rotated_from to predecessor', async () => {
    const { store, userId } = await makeStore();
    const reg = store.registerClient({
      redirect_uris: ['https://x/cb'], client_name: 'X', token_endpoint_auth_method: 'none',
    });
    const a = store.insertRefreshToken({
      tokenHash: 'AAA', client_id: reg.client_id, user_id: userId, scope: 'mcp:full',
      expiresAt: new Date(Date.now() + 30 * 86400e3).toISOString(),
      rotated_from: null,
    });
    const b = store.rotateRefreshToken({
      oldHash: 'AAA',
      newHash: 'BBB',
      client_id: reg.client_id, user_id: userId, scope: 'mcp:full',
      expiresAt: new Date(Date.now() + 30 * 86400e3).toISOString(),
    });
    const oldRow = store.findRefreshToken('AAA');
    assert.ok(oldRow.revoked_at, 'old token should be marked revoked after rotation');
    const newRow = store.findRefreshToken('BBB');
    assert.equal(newRow.rotated_from, 'AAA');
    assert.equal(newRow.revoked_at, null);
  });

  it('reuse detection: invalidates ALL tokens in (user_id, client_id) chain', async () => {
    const { store, userId } = await makeStore();
    const reg = store.registerClient({
      redirect_uris: ['https://x/cb'], client_name: 'X', token_endpoint_auth_method: 'none',
    });
    const exp = new Date(Date.now() + 30 * 86400e3).toISOString();
    store.insertRefreshToken({ tokenHash: 'A', client_id: reg.client_id, user_id: userId, scope: 'mcp:full', expiresAt: exp, rotated_from: null });
    store.rotateRefreshToken({ oldHash: 'A', newHash: 'B', client_id: reg.client_id, user_id: userId, scope: 'mcp:full', expiresAt: exp });
    store.rotateRefreshToken({ oldHash: 'B', newHash: 'C', client_id: reg.client_id, user_id: userId, scope: 'mcp:full', expiresAt: exp });

    // Attacker presents already-rotated 'A'
    store.invalidateRefreshChain({ user_id: userId, client_id: reg.client_id });

    for (const h of ['A', 'B', 'C']) {
      const row = store.findRefreshToken(h);
      assert.ok(row.revoked_at, `${h} should be revoked after chain invalidation`);
    }
  });

  it('expired refresh token: findRefreshToken still returns row, isUsable returns false', async () => {
    const { store, userId, cache } = await makeStore();
    const reg = store.registerClient({
      redirect_uris: ['https://x/cb'], client_name: 'X', token_endpoint_auth_method: 'none',
    });
    store.insertRefreshToken({
      tokenHash: 'X', client_id: reg.client_id, user_id: userId, scope: 'mcp:full',
      expiresAt: new Date(Date.now() - 1000).toISOString(),
      rotated_from: null,
    });
    const row = store.findRefreshToken('X');
    assert.ok(row);
    assert.equal(store.isUsable(row), false);
  });
});
