import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCache } from '../lib/cache.js';

describe('cache schema for auth', () => {
  let cache;
  beforeEach(() => { cache = createCache(':memory:'); });

  it('creates the users table', () => {
    const cols = cache.db.prepare("PRAGMA table_info(users)").all().map(c => c.name);
    assert.deepEqual(cols.sort(), ['created_at', 'email', 'id', 'is_admin', 'password_hash']);
  });

  it('creates the sessions table', () => {
    const cols = cache.db.prepare("PRAGMA table_info(sessions)").all().map(c => c.name);
    assert.deepEqual(cols.sort(), ['created_at', 'expires_at', 'flash_data', 'token', 'user_id']);
  });

  it('creates the api_keys table', () => {
    const cols = cache.db.prepare("PRAGMA table_info(api_keys)").all().map(c => c.name);
    assert.deepEqual(cols.sort(), ['created_at', 'id', 'key_hash', 'key_prefix', 'label', 'last_used_at', 'user_id']);
  });

  it('creates the user_fetches table', () => {
    const cols = cache.db.prepare("PRAGMA table_info(user_fetches)").all().map(c => c.name);
    assert.deepEqual(cols.sort(), ['cache_id', 'fetched_at', 'id', 'user_id']);
  });

  it('adds user_id to conversions', () => {
    const cols = cache.db.prepare("PRAGMA table_info(conversions)").all().map(c => c.name);
    assert.ok(cols.includes('user_id'), 'conversions.user_id must exist');
  });

  it('email is unique', () => {
    cache.db.prepare("INSERT INTO users (email, password_hash) VALUES (?, ?)").run('a@b.c', 'x');
    assert.throws(
      () => cache.db.prepare("INSERT INTO users (email, password_hash) VALUES (?, ?)").run('a@b.c', 'y'),
      /UNIQUE constraint failed: users.email/
    );
  });

  it('CASCADE-deletes child rows when a user is deleted', () => {
    const r = cache.db.prepare("INSERT INTO users (email, password_hash) VALUES (?, ?)").run('u@x.y', 'h');
    const userId = r.lastInsertRowid;
    cache.db.prepare("INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, datetime('now', '+1 day'))").run('tok1', userId);
    cache.db.prepare("INSERT INTO api_keys (user_id, key_hash, key_prefix) VALUES (?, ?, ?)").run(userId, 'h1', 'pmd_a');
    cache.db.prepare("INSERT INTO user_fetches (user_id, cache_id) VALUES (?, ?)").run(userId, 1);

    cache.db.prepare("DELETE FROM users WHERE id = ?").run(userId);

    assert.equal(cache.db.prepare("SELECT COUNT(*) c FROM sessions").get().c, 0);
    assert.equal(cache.db.prepare("SELECT COUNT(*) c FROM api_keys").get().c, 0);
    assert.equal(cache.db.prepare("SELECT COUNT(*) c FROM user_fetches").get().c, 0);
  });

  it('SETs NULL on conversions.user_id when the owning user is deleted', () => {
    const r = cache.db.prepare("INSERT INTO users (email, password_hash) VALUES (?, ?)").run('u@x.y', 'h');
    const userId = r.lastInsertRowid;
    cache.put({ url: 'https://kept.com', title: 'Kept', markdown: '# k', source: 'readability' });
    cache.db.prepare("UPDATE conversions SET user_id = ? WHERE url = ?").run(userId, 'https://kept.com');

    cache.db.prepare("DELETE FROM users WHERE id = ?").run(userId);

    const row = cache.db.prepare("SELECT user_id FROM conversions WHERE url = ?").get('https://kept.com');
    assert.equal(row.user_id, null, 'cache row must survive user deletion with user_id NULL');
  });

  it('users.is_admin defaults to 0', () => {
    cache.db.prepare("INSERT INTO users (email, password_hash) VALUES (?, ?)").run('default@x.y', 'h');
    const u = cache.db.prepare("SELECT is_admin FROM users WHERE email = ?").get('default@x.y');
    assert.equal(u.is_admin, 0);
  });
});

describe('cache: user-scoped history', () => {
  let cache, userA, userB;
  beforeEach(() => {
    cache = createCache(':memory:');
    userA = cache.db.prepare("INSERT INTO users (email, password_hash) VALUES ('a@x.y', 'h') RETURNING id").get().id;
    userB = cache.db.prepare("INSERT INTO users (email, password_hash) VALUES ('b@x.y', 'h') RETURNING id").get().id;
  });

  it('cache.put records a user_fetch when user_id is provided', () => {
    cache.put({ url: 'https://a.com', title: 'A', markdown: '# A', source: 'readability', user_id: userA });
    const fetches = cache.db.prepare("SELECT user_id FROM user_fetches").all();
    assert.equal(fetches.length, 1);
    assert.equal(fetches[0].user_id, userA);
  });

  it('cache.put with user_id=null does NOT record a user_fetch', () => {
    cache.put({ url: 'https://a.com', title: 'A', markdown: '# A', source: 'readability', user_id: null });
    assert.equal(cache.db.prepare("SELECT COUNT(*) c FROM user_fetches").get().c, 0);
  });

  it('historyForUser returns only that user\'s fetches', () => {
    cache.put({ url: 'https://a.com', title: 'A', markdown: '# A', source: 'r', user_id: userA });
    cache.put({ url: 'https://b.com', title: 'B', markdown: '# B', source: 'r', user_id: userB });
    cache.put({ url: 'https://c.com', title: 'C', markdown: '# C', source: 'r', user_id: userA });
    const a = cache.historyForUser(userA, 10);
    const b = cache.historyForUser(userB, 10);
    assert.deepEqual(a.map(x => x.url).sort(), ['https://a.com', 'https://c.com']);
    assert.deepEqual(b.map(x => x.url).sort(), ['https://b.com']);
  });

  it('historyPageForUser paginates per user', () => {
    for (let i = 0; i < 25; i++) {
      cache.put({ url: `https://a.com/${i}`, title: `A${i}`, markdown: '# A', source: 'r', user_id: userA });
    }
    cache.put({ url: 'https://b.com', title: 'B', markdown: '# B', source: 'r', user_id: userB });
    const p = cache.historyPageForUser(userA, 10, 0);
    assert.equal(p.items.length, 10);
    assert.equal(p.total, 25);
  });

  it('re-fetching same URL by same user does not duplicate fetches', () => {
    cache.put({ url: 'https://a.com', title: 'A', markdown: '# A', source: 'r', user_id: userA });
    cache.put({ url: 'https://a.com', title: 'A2', markdown: '# A2', source: 'r', user_id: userA });
    const c = cache.db.prepare("SELECT COUNT(*) c FROM user_fetches WHERE user_id = ?").get(userA).c;
    assert.equal(c, 1);
  });
});

describe('cache: per-user history unlink', () => {
  let cache, uid;
  beforeEach(() => {
    cache = createCache(':memory:');
    const r = cache.db.prepare("INSERT INTO users (email, password_hash) VALUES (?, ?)").run('u@x.y', 'h');
    uid = r.lastInsertRowid;
  });

  it('forgetForUser removes only the caller fetch row, not the conversion', () => {
    const shareId = cache.put({ url: 'https://a.test/1', title: 't', markdown: '# t', source: 's', user_id: uid });
    const id = cache.getIdByUrl('https://a.test/1');

    const r = cache.forgetForUser(uid, id);

    assert.equal(r.changes, 1);
    assert.deepEqual(cache.historyForUser(uid), []);
    assert.ok(cache.getByShareId(shareId), 'share link must survive a user-scope unlink');
    assert.equal(cache.db.prepare('SELECT COUNT(*) c FROM conversions WHERE id = ?').get(id).c, 1);
  });

  it('forgetForUser reports 0 changes when the user has no fetch row', () => {
    cache.put({ url: 'https://a.test/2', title: 't', markdown: '# t', source: 's' });
    const id = cache.getIdByUrl('https://a.test/2');

    assert.equal(cache.forgetForUser(uid, id).changes, 0);
  });

  it('forgetForUser leaves another user history untouched', () => {
    const other = cache.db.prepare("INSERT INTO users (email, password_hash) VALUES (?, ?)").run('o@x.y', 'h').lastInsertRowid;
    cache.put({ url: 'https://a.test/3', title: 't', markdown: '# t', source: 's', user_id: uid });
    const id = cache.getIdByUrl('https://a.test/3');
    cache.db.prepare('INSERT INTO user_fetches (user_id, cache_id) VALUES (?, ?)').run(other, id);

    cache.forgetForUser(uid, id);

    assert.equal(cache.historyForUser(other).length, 1);
  });

  it('forgetAllForUser clears only the caller rows', () => {
    const other = cache.db.prepare("INSERT INTO users (email, password_hash) VALUES (?, ?)").run('o2@x.y', 'h').lastInsertRowid;
    cache.put({ url: 'https://a.test/4', title: 't', markdown: '# t', source: 's', user_id: uid });
    cache.put({ url: 'https://a.test/5', title: 't', markdown: '# t', source: 's', user_id: uid });
    cache.put({ url: 'https://a.test/6', title: 't', markdown: '# t', source: 's', user_id: other });

    const r = cache.forgetAllForUser(uid);

    assert.equal(r.changes, 2);
    assert.deepEqual(cache.historyForUser(uid), []);
    assert.equal(cache.historyForUser(other).length, 1);
    assert.equal(cache.db.prepare('SELECT COUNT(*) c FROM conversions').get().c, 3);
  });
});

describe('cache: no orphaned user_fetches', () => {
  let cache, uid;
  beforeEach(() => {
    cache = createCache(':memory:');
    uid = cache.db.prepare("INSERT INTO users (email, password_hash) VALUES (?, ?)").run('u@x.y', 'h').lastInsertRowid;
  });

  const orphanCount = (cache) => cache.db.prepare(`
    SELECT COUNT(*) c FROM user_fetches f
    LEFT JOIN conversions c ON c.id = f.cache_id
    WHERE c.id IS NULL
  `).get().c;

  it('delete removes the fetch rows along with the conversion', () => {
    cache.put({ url: 'https://a.test/7', title: 't', markdown: '# t', source: 's', user_id: uid });
    const id = cache.getIdByUrl('https://a.test/7');

    const r = cache.delete(id);

    assert.equal(r.changes, 1, 'return value must stay the conversions delete count');
    assert.equal(orphanCount(cache), 0);
  });

  it('countForUser stays consistent with historyPageForUser after a global delete', () => {
    cache.put({ url: 'https://a.test/8', title: 't', markdown: '# t', source: 's', user_id: uid });
    cache.put({ url: 'https://a.test/9', title: 't', markdown: '# t', source: 's', user_id: uid });
    cache.delete(cache.getIdByUrl('https://a.test/8'));

    const page = cache.historyPageForUser(uid, 50, 0);

    assert.equal(page.total, page.items.length, 'total must not count rows the join cannot return');
    assert.equal(page.total, 1);
  });

  it('deleteAll leaves no fetch rows behind', () => {
    cache.put({ url: 'https://a.test/10', title: 't', markdown: '# t', source: 's', user_id: uid });

    cache.deleteAll();

    assert.equal(cache.db.prepare('SELECT COUNT(*) c FROM user_fetches').get().c, 0);
  });

  it('pruneOrphanFetches sweeps pre-existing orphans', () => {
    cache.db.prepare('INSERT INTO user_fetches (user_id, cache_id) VALUES (?, ?)').run(uid, 999999);

    const r = cache.pruneOrphanFetches();

    assert.equal(r.changes, 1);
    assert.equal(orphanCount(cache), 0);
  });

  it('createCache sweeps orphans left by an earlier process', () => {
    // Temp-file pattern copied from test/recipes-frontmatter.test.js:126.
    const file = path.join(os.tmpdir(), `pullmd-orphan-${Date.now()}-${Math.random().toString(16).slice(2)}.db`);
    const first = createCache(file);
    first.db.prepare("INSERT INTO users (email, password_hash) VALUES (?, ?)").run('u@x.y', 'h');
    first.db.prepare('INSERT INTO user_fetches (user_id, cache_id) VALUES (?, ?)').run(1, 424242);
    first.db.close();

    try {
      const second = createCache(file);
      assert.equal(second.db.prepare('SELECT COUNT(*) c FROM user_fetches').get().c, 0);
      second.db.close();
    } finally {
      fs.rmSync(file, { force: true });
    }
  });
});
