import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { createCache } from '../lib/cache.js';

// createCache() upgrades databases written by older builds in place
// (ALTER TABLE for share_id, client, user_id, metadata, sessions.flash_data).
// These tests open hand-built old databases instead of fresh ones.

const OLD_URL = 'https://example.com/alt';

let dir;
let dbPath;
const open = [];

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pullmd-cache-migration-'));
  dbPath = path.join(dir, 'cache.db');
});

afterEach(() => {
  for (const db of open.splice(0)) { try { db.close(); } catch { /* already closed */ } }
  fs.rmSync(dir, { recursive: true, force: true });
});

function openCache() {
  const cache = createCache(dbPath);
  open.push(cache.db);
  return cache;
}

// v1.0: conversions before share links, client detection, users and metadata.
function writeV1Database() {
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE conversions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      url TEXT UNIQUE,
      title TEXT,
      markdown TEXT,
      source TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);
  db.prepare('INSERT INTO conversions (url, title, markdown, source) VALUES (?, ?, ?, ?)')
    .run(OLD_URL, 'Alter Eintrag', '# Alter Eintrag\n\nText', 'readability');
  db.prepare("INSERT INTO conversions (url, title, markdown, source, created_at) VALUES (?, ?, ?, ?, datetime('now', '-3 days'))")
    .run('https://example.com/aelter', 'Noch aelter', '# Noch aelter', 'reddit');
  db.close();
}

// Early v2: share links and clients exist, users and sessions too, but no
// conversions.user_id / metadata and no sessions.flash_data yet.
function writeEarlyV2Database() {
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE conversions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      url TEXT UNIQUE,
      title TEXT,
      markdown TEXT,
      source TEXT,
      share_id TEXT UNIQUE,
      client TEXT DEFAULT 'browser',
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      is_admin INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE sessions (
      token TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TEXT DEFAULT (datetime('now')),
      expires_at TEXT NOT NULL
    );
  `);
  db.prepare('INSERT INTO conversions (url, title, markdown, source, share_id, client) VALUES (?, ?, ?, ?, ?, ?)')
    .run(OLD_URL, 'Alter Eintrag', '# Alter Eintrag\n\nText', 'readability', 'abc123', 'claude');
  db.prepare("INSERT INTO users (email, password_hash) VALUES ('a@b.c', 'x')").run();
  db.prepare("INSERT INTO sessions (token, user_id, expires_at) VALUES ('tok', 1, datetime('now', '+1 day'))").run();
  db.close();
}

const columns = (db, table) => db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
const index = (db, name) => db.prepare('PRAGMA index_list(conversions)').all().find((i) => i.name === name);
const schemaDump = (db) => db.prepare('SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name').all();

describe('createCache on a v1 database (bare conversions table)', () => {
  beforeEach(writeV1Database);

  it('adds the missing columns and indexes', () => {
    const { db } = openCache();

    assert.deepEqual(columns(db, 'conversions'),
      ['id', 'url', 'title', 'markdown', 'source', 'created_at', 'share_id', 'client', 'user_id', 'metadata']);
    assert.equal(index(db, 'idx_share_id')?.unique, 1, 'share ids must stay unique after the upgrade');
    assert.ok(index(db, 'idx_conversions_user_id'), 'user_id index missing');
    const fk = db.prepare('PRAGMA foreign_key_list(conversions)').all();
    assert.equal(fk.length, 1);
    assert.deepEqual([fk[0].table, fk[0].from, fk[0].to, fk[0].on_delete], ['users', 'user_id', 'id', 'SET NULL']);
  });

  it('creates the tables the old build did not have', () => {
    const { db } = openCache();
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name);
    for (const t of ['users', 'sessions', 'api_keys', 'user_fetches', 'meta', 'extraction_log', 'image_transcripts']) {
      assert.ok(tables.includes(t), `table ${t} missing`);
    }
  });

  it('keeps the old rows readable through the cache API', () => {
    const cache = openCache();

    const row = cache.get(OLD_URL);
    assert.equal(row.title, 'Alter Eintrag');
    assert.equal(row.markdown, '# Alter Eintrag\n\nText');
    assert.equal(row.source, 'readability');
    assert.equal(row.share_id, null);
    assert.equal(row.client, 'browser', 'old rows take the column default');
    assert.equal(row.metadata, null);

    const { items, total } = cache.historyPage(10, 0);
    assert.equal(total, 2);
    assert.deepEqual(items.map((i) => i.url), [OLD_URL, 'https://example.com/aelter']);
    assert.deepEqual(cache.history(1).map((i) => i.title), ['Alter Eintrag']);
    assert.equal(cache.getIdByUrl(OLD_URL), 1);
  });

  it('gives an old row a share id on its next put, keeping its id', () => {
    const cache = openCache();

    const shareId = cache.put({
      url: OLD_URL, title: 'Neu', markdown: '# Neu', source: 'trafilatura', client: 'api',
      metadata: { language: 'de', quality: 0.9 },
    });

    assert.match(shareId, /^[0-9a-f]{32}$/);
    assert.equal(cache.getIdByUrl(OLD_URL), 1, 'the row is updated, not replaced');
    assert.equal(cache.historyPage().total, 2);
    const shared = cache.getByShareId(shareId);
    assert.equal(shared.url, OLD_URL);
    assert.equal(shared.markdown, '# Neu');
    assert.equal(shared.client, 'api');
    assert.deepEqual(shared.metadata, { language: 'de', quality: 0.9 });
    assert.deepEqual(cache.get(OLD_URL).metadata, { language: 'de', quality: 0.9 });
    // A second put keeps the link stable.
    assert.equal(cache.put({ url: OLD_URL, title: 'Neu', markdown: '# Neu 2', source: 'trafilatura' }), shareId);
  });

  it('stores new rows, per-user history and meta on the migrated database', () => {
    const cache = openCache();
    const userId = cache.db.prepare("INSERT INTO users (email, password_hash) VALUES ('a@b.c', 'x')").run().lastInsertRowid;

    const shareId = cache.put({ url: 'https://example.com/neu', title: 'Neu', markdown: '# Neu', source: 'readability', user_id: userId });

    assert.equal(cache.getByShareId(shareId).title, 'Neu');
    assert.equal(cache.historyPage().total, 3);
    assert.deepEqual(cache.historyForUser(userId).map((i) => i.url), ['https://example.com/neu']);
    assert.equal(cache.getMeta('recipes_hash'), null);
    cache.setMeta('recipes_hash', 'h1');
    assert.equal(cache.getMeta('recipes_hash'), 'h1');

    // The added user_id column carries its foreign key: the row outlives its owner.
    cache.db.prepare('DELETE FROM users WHERE id = ?').run(userId);
    assert.equal(cache.db.prepare('SELECT user_id FROM conversions WHERE url = ?').get('https://example.com/neu').user_id, null);
    assert.ok(cache.getByShareId(shareId));
  });

  it('rejects a duplicate share id after the upgrade', () => {
    const cache = openCache();
    const shareId = cache.put({ url: 'https://example.com/a', title: 'A', markdown: '# A', source: 'readability' });
    assert.throws(
      () => cache.db.prepare('INSERT INTO conversions (url, share_id) VALUES (?, ?)').run('https://example.com/b', shareId),
      /UNIQUE constraint failed/,
    );
  });

  it('is a no-op when opened a second time', () => {
    const first = openCache();
    const shareId = first.put({ url: OLD_URL, title: 'Neu', markdown: '# Neu', source: 'readability' });
    const schema = schemaDump(first.db);
    const rows = first.db.prepare('SELECT * FROM conversions ORDER BY id').all();
    first.db.close();

    const second = openCache();

    assert.deepEqual(schemaDump(second.db), schema);
    assert.deepEqual(second.db.prepare('SELECT * FROM conversions ORDER BY id').all(), rows);
    assert.equal(second.getByShareId(shareId).url, OLD_URL);
  });
});

describe('createCache on an early v2 database (share links, no user_id/metadata/flash_data)', () => {
  beforeEach(writeEarlyV2Database);

  it('adds only what is missing and keeps share link, client and session', () => {
    const cache = openCache();
    const { db } = cache;

    assert.deepEqual(columns(db, 'conversions'),
      ['id', 'url', 'title', 'markdown', 'source', 'share_id', 'client', 'created_at', 'user_id', 'metadata']);
    assert.deepEqual(columns(db, 'sessions'), ['token', 'user_id', 'created_at', 'expires_at', 'flash_data']);
    assert.ok(index(db, 'idx_conversions_user_id'));

    const shared = cache.getByShareId('abc123');
    assert.equal(shared.url, OLD_URL);
    assert.equal(shared.client, 'claude');
    assert.equal(shared.metadata, null);
    assert.deepEqual(db.prepare('SELECT token, user_id, flash_data FROM sessions').all(),
      [{ token: 'tok', user_id: 1, flash_data: null }]);
  });

  it('keeps the existing share id when the row is fetched again', () => {
    const cache = openCache();
    const shareId = cache.put({ url: OLD_URL, title: 'Neu', markdown: '# Neu', source: 'readability', user_id: 1, metadata: { a: 1 } });

    assert.equal(shareId, 'abc123');
    assert.deepEqual(cache.getByShareId('abc123').metadata, { a: 1 });
    assert.deepEqual(cache.historyForUser(1).map((i) => i.url), [OLD_URL]);
  });

  it('is a no-op when opened a second time', () => {
    const first = openCache();
    const schema = schemaDump(first.db);
    first.db.close();

    const second = openCache();
    assert.deepEqual(schemaDump(second.db), schema);
    assert.equal(second.getByShareId('abc123').url, OLD_URL);
  });
});
