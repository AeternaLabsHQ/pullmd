import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createCache } from '../lib/cache.js';
import { createAuth, hashPassword } from '../lib/auth.js';

const fastOpts = { argon2Opts: { timeCost: 1, memoryCost: 1024, parallelism: 1 } };

describe('sessions', () => {
  let cache, auth, userId;

  beforeEach(async () => {
    cache = createCache(':memory:');
    auth = createAuth({ db: cache.db, mode: 'multi-user', env: {}, ...fastOpts });
    const hash = await hashPassword('pw', fastOpts.argon2Opts);
    const r = cache.db
      .prepare("INSERT INTO users (email, password_hash) VALUES (?, ?)")
      .run('a@b.c', hash);
    userId = r.lastInsertRowid;
  });

  it('createSession returns a 64-char hex token', () => {
    const { token } = auth.createSession(userId);
    assert.match(token, /^[0-9a-f]{64}$/);
  });

  it('lookupSession returns the user for a valid token', () => {
    const { token } = auth.createSession(userId);
    const user = auth.lookupSession(token);
    assert.ok(user);
    assert.equal(user.id, userId);
    assert.equal(user.email, 'a@b.c');
  });

  it('lookupSession returns null for an unknown token', () => {
    assert.equal(auth.lookupSession('deadbeef'.repeat(8)), null);
  });

  it('lookupSession returns null for an expired token', () => {
    const { token } = auth.createSession(userId);
    cache.db
      .prepare("UPDATE sessions SET expires_at = datetime('now', '-1 hour') WHERE token = ?")
      .run(token);
    assert.equal(auth.lookupSession(token), null);
  });

  it('deleteSession revokes the token', () => {
    const { token } = auth.createSession(userId);
    auth.deleteSession(token);
    assert.equal(auth.lookupSession(token), null);
  });

  it('createSession sets expiry ~90 days out', () => {
    const { expiresAt } = auth.createSession(userId);
    const diffDays = (new Date(expiresAt + 'Z').getTime() - Date.now()) / 86400000;
    assert.ok(diffDays > 89 && diffDays < 91, `expected ~90 days; got ${diffDays}`);
  });

  it('lookupSession slides expiry on active sessions', () => {
    const { token } = auth.createSession(userId);
    cache.db
      .prepare("UPDATE sessions SET expires_at = datetime('now', '+30 days') WHERE token = ?")
      .run(token);
    auth.lookupSession(token);
    const row = cache.db.prepare("SELECT expires_at FROM sessions WHERE token = ?").get(token);
    const diffSeconds = (new Date(row.expires_at + 'Z').getTime() - Date.now()) / 1000;
    assert.ok(diffSeconds > 85 * 86400, `expected slide past 85 days; got ${diffSeconds}s`);
  });

  it('createAuth throws on unknown mode', () => {
    assert.throws(() => createAuth({ db: cache.db, mode: 'unknown' }), /Invalid PULLMD_AUTH_MODE/);
  });
});
