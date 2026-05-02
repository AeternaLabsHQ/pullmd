import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createCache } from '../lib/cache.js';

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
