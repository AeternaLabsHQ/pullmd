import Database from 'better-sqlite3';
import { randomBytes } from 'crypto';

function generateShareId() {
  return randomBytes(4).toString('hex');
}

export function createCache(dbPath = '/data/cache.db') {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS conversions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      url TEXT UNIQUE,
      title TEXT,
      markdown TEXT,
      source TEXT,
      share_id TEXT UNIQUE,
      client TEXT DEFAULT 'browser',
      metadata TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS extraction_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      url TEXT,
      domain TEXT,
      source TEXT,
      quality REAL,
      markdown_len INTEGER,
      extractor_reason TEXT,
      duration_ms INTEGER,
      client TEXT,
      cached INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_extraction_log_created_at ON extraction_log(created_at)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_extraction_log_source ON extraction_log(source)`);

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      is_admin INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TEXT DEFAULT (datetime('now')),
      expires_at TEXT NOT NULL,
      flash_data TEXT
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at)`);

  // Migrate: add flash_data column if missing (for early-v2 builds).
  const sessionCols = db.prepare("PRAGMA table_info(sessions)").all().map(c => c.name);
  if (!sessionCols.includes('flash_data')) {
    db.exec('ALTER TABLE sessions ADD COLUMN flash_data TEXT');
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS api_keys (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      key_hash TEXT UNIQUE NOT NULL,
      key_prefix TEXT NOT NULL,
      label TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      last_used_at TEXT
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_api_keys_user_id ON api_keys(user_id)`);

  db.exec(`
    CREATE TABLE IF NOT EXISTS user_fetches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      cache_id INTEGER NOT NULL,
      fetched_at TEXT DEFAULT (datetime('now'))
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_user_fetches_user_id ON user_fetches(user_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_user_fetches_cache_id ON user_fetches(cache_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_user_fetches_fetched_at ON user_fetches(fetched_at)`);
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_user_fetches_unique ON user_fetches(user_id, cache_id)`);

  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT DEFAULT (datetime('now'))
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS oauth_clients (
      client_id TEXT PRIMARY KEY,
      client_secret_hash TEXT,
      redirect_uris TEXT NOT NULL,
      client_name TEXT,
      token_endpoint_auth_method TEXT NOT NULL DEFAULT 'none',
      created_via TEXT NOT NULL DEFAULT 'dcr',
      created_at TEXT DEFAULT (datetime('now')),
      last_used_at TEXT
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS oauth_auth_codes (
      code_hash TEXT PRIMARY KEY,
      client_id TEXT NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      redirect_uri TEXT NOT NULL,
      code_challenge TEXT NOT NULL,
      code_challenge_method TEXT NOT NULL,
      scope TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      used_at TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_oauth_auth_codes_expires ON oauth_auth_codes(expires_at)`);

  db.exec(`
    CREATE TABLE IF NOT EXISTS oauth_refresh_tokens (
      token_hash TEXT PRIMARY KEY,
      client_id TEXT NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      scope TEXT NOT NULL,
      rotated_from TEXT,
      revoked_at TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      expires_at TEXT NOT NULL
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_oauth_refresh_user_client ON oauth_refresh_tokens(user_id, client_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_oauth_refresh_rotated_from ON oauth_refresh_tokens(rotated_from)`);

  // Migrate: add share_id column if missing
  const cols = db.prepare("PRAGMA table_info(conversions)").all().map(c => c.name);
  if (!cols.includes('share_id')) {
    db.exec('ALTER TABLE conversions ADD COLUMN share_id TEXT');
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_share_id ON conversions(share_id)');
  }
  if (!cols.includes('client')) {
    db.exec("ALTER TABLE conversions ADD COLUMN client TEXT DEFAULT 'browser'");
  }
  if (!cols.includes('user_id')) {
    db.exec('ALTER TABLE conversions ADD COLUMN user_id INTEGER REFERENCES users(id) ON DELETE SET NULL');
    db.exec('CREATE INDEX IF NOT EXISTS idx_conversions_user_id ON conversions(user_id)');
  }
  if (!cols.includes('metadata')) {
    db.exec('ALTER TABLE conversions ADD COLUMN metadata TEXT');
  }

  let recipesInvalidatedAt = '1970-01-01 00:00:00';

  // Parse the stored metadata JSON back into an object (null on absent/invalid).
  function parseMetadata(row) {
    if (!row) return row;
    let metadata = null;
    if (row.metadata) { try { metadata = JSON.parse(row.metadata); } catch { metadata = null; } }
    return { ...row, metadata };
  }

  const stmts = {
    upsert: db.prepare(`
      INSERT INTO conversions (url, title, markdown, source, share_id, client, user_id, metadata, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(url) DO UPDATE SET
        title = excluded.title,
        markdown = excluded.markdown,
        source = excluded.source,
        share_id = COALESCE(conversions.share_id, excluded.share_id),
        client = excluded.client,
        user_id = COALESCE(conversions.user_id, excluded.user_id),
        metadata = excluded.metadata,
        created_at = datetime('now')
    `),
    get: db.prepare(`
      SELECT title, markdown, source, share_id, client, metadata, created_at FROM conversions
      WHERE url = ?
        AND created_at > datetime('now', '-1 hour')
        AND created_at > ?
    `),
    getByShareId: db.prepare(`
      SELECT url, title, markdown, source, client, metadata, created_at FROM conversions
      WHERE share_id = ? AND created_at > datetime('now', '-90 days')
    `),
    history: db.prepare(`
      SELECT id, url, title, source, share_id, client, created_at FROM conversions
      ORDER BY created_at DESC, id DESC LIMIT ?
    `),
    historyPage: db.prepare(`
      SELECT id, url, title, source, share_id, client, created_at FROM conversions
      ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?
    `),
    count: db.prepare(`SELECT COUNT(*) as total FROM conversions`),
    deleteOne: db.prepare(`DELETE FROM conversions WHERE id = ?`),
    deleteAll: db.prepare(`DELETE FROM conversions`),
    pruneOld: db.prepare(`
      DELETE FROM conversions WHERE created_at < datetime('now', '-90 days')
    `),
    logInsert: db.prepare(`
      INSERT INTO extraction_log (url, domain, source, quality, markdown_len, extractor_reason, duration_ms, client, cached, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `),
    pruneLog: db.prepare(`
      DELETE FROM extraction_log WHERE created_at < datetime('now', '-30 days')
    `),
    logTotal: db.prepare(`SELECT COUNT(*) as c FROM extraction_log WHERE created_at > datetime('now', ?)`),
    logBySource: db.prepare(`
      SELECT source, COUNT(*) as c, AVG(quality) as avg_q, AVG(markdown_len) as avg_len, AVG(duration_ms) as avg_ms
      FROM extraction_log WHERE created_at > datetime('now', ?)
      GROUP BY source ORDER BY c DESC
    `),
    logLowQualityDomains: db.prepare(`
      SELECT domain, COUNT(*) as c, AVG(quality) as avg_q
      FROM extraction_log
      WHERE created_at > datetime('now', ?) AND quality < 0.4 AND cached = 0
      GROUP BY domain ORDER BY c DESC LIMIT 20
    `),
    logFallbackByDomain: db.prepare(`
      SELECT domain, COUNT(*) as c
      FROM extraction_log
      WHERE created_at > datetime('now', ?)
        AND (source = 'readability-fallback' OR extractor_reason LIKE '%fell back%' OR extractor_reason LIKE '%readability thin%')
      GROUP BY domain ORDER BY c DESC LIMIT 20
    `),
    upsertFetch: db.prepare(`
      INSERT INTO user_fetches (user_id, cache_id, fetched_at)
      VALUES (?, ?, datetime('now'))
      ON CONFLICT(user_id, cache_id) DO UPDATE SET fetched_at = datetime('now')
    `),
    historyForUser: db.prepare(`
      SELECT c.id, c.url, c.title, c.source, c.share_id, c.client, c.created_at
      FROM user_fetches f
      JOIN conversions c ON c.id = f.cache_id
      WHERE f.user_id = ?
      ORDER BY f.fetched_at DESC, f.id DESC
      LIMIT ?
    `),
    historyPageForUser: db.prepare(`
      SELECT c.id, c.url, c.title, c.source, c.share_id, c.client, c.created_at
      FROM user_fetches f
      JOIN conversions c ON c.id = f.cache_id
      WHERE f.user_id = ?
      ORDER BY f.fetched_at DESC, f.id DESC
      LIMIT ? OFFSET ?
    `),
    countForUser: db.prepare(`SELECT COUNT(*) as total FROM user_fetches WHERE user_id = ?`),
    metaGet: db.prepare(`SELECT value FROM meta WHERE key = ?`),
    metaSet: db.prepare(`
      INSERT INTO meta (key, value, updated_at) VALUES (?, ?, datetime('now'))
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')
    `),
  };

  return {
    db,

    put({ url, title, markdown, source, client, user_id = null, metadata = null }) {
      const shareId = generateShareId();
      const metaJson = metadata != null ? JSON.stringify(metadata) : null;
      stmts.upsert.run(url, title, markdown, source, shareId, client || 'browser', user_id, metaJson);
      stmts.pruneOld.run();
      const row = db.prepare('SELECT id, share_id FROM conversions WHERE url = ?').get(url);
      if (user_id != null && row?.id) {
        stmts.upsertFetch.run(user_id, row.id);
      }
      return row?.share_id || shareId;
    },

    getIdByUrl(url) {
      const row = db.prepare('SELECT id FROM conversions WHERE url = ?').get(url);
      return row?.id || null;
    },

    get(url) {
      const row = stmts.get.get(url, recipesInvalidatedAt);
      return row ? parseMetadata(row) : null;
    },

    getByShareId(shareId) {
      const row = stmts.getByShareId.get(shareId);
      return row ? parseMetadata(row) : null;
    },

    history(limit = 20) {
      return stmts.history.all(Math.min(limit, 100));
    },

    historyPage(limit = 50, offset = 0) {
      const items = stmts.historyPage.all(limit, offset);
      const { total } = stmts.count.get();
      return { items, total };
    },

    historyForUser(userId, limit = 20) {
      return stmts.historyForUser.all(userId, Math.min(limit, 100));
    },

    historyPageForUser(userId, limit = 50, offset = 0) {
      const items = stmts.historyPageForUser.all(userId, limit, offset);
      const { total } = stmts.countForUser.get(userId);
      return { items, total };
    },

    delete(id) {
      return stmts.deleteOne.run(id);
    },

    deleteAll() {
      return stmts.deleteAll.run();
    },

    logExtraction({ url, source, quality, markdownLen, extractorReason, durationMs, client, cached }) {
      let domain = null;
      try { domain = new URL(url).hostname; } catch {}
      stmts.logInsert.run(
        url,
        domain,
        source || null,
        quality ?? null,
        markdownLen ?? null,
        extractorReason || null,
        durationMs ?? null,
        client || null,
        cached ? 1 : 0,
      );
      stmts.pruneLog.run();
    },

    storageStats() {
      const total = stmts.count.get().total;
      const expiringSoon = db.prepare(`
        SELECT COUNT(*) as c FROM conversions WHERE created_at < datetime('now', '-80 days')
      `).get().c;
      const oldest = db.prepare(`SELECT MIN(created_at) as t FROM conversions`).get().t;
      const dbSizeBytes = db.prepare(`SELECT page_count * page_size AS size FROM pragma_page_count(), pragma_page_size()`).get().size;
      const cacheHits7d = db.prepare(`SELECT COUNT(*) as c FROM extraction_log WHERE cached = 1 AND created_at > datetime('now', '-7 days')`).get().c;
      const requests7d = db.prepare(`SELECT COUNT(*) as c FROM extraction_log WHERE created_at > datetime('now', '-7 days')`).get().c;
      return {
        total,
        expiringSoon,
        oldest,
        retentionDays: 90,
        dbSizeBytes,
        cacheHits7d,
        requests7d,
      };
    },

    extractionStats(window = '-7 days') {
      const total = stmts.logTotal.get(window).c;
      if (total === 0) return { total: 0, window };
      const bySource = stmts.logBySource.all(window).map(r => ({
        source: r.source,
        count: r.c,
        pct: Math.round((r.c / total) * 1000) / 10,
        avgQuality: r.avg_q ? Math.round(r.avg_q * 100) / 100 : null,
        avgLen: r.avg_len ? Math.round(r.avg_len) : null,
        avgMs: r.avg_ms ? Math.round(r.avg_ms) : null,
      }));
      const lowQualityDomains = stmts.logLowQualityDomains.all(window).map(r => ({
        domain: r.domain, count: r.c, avgQuality: Math.round(r.avg_q * 100) / 100,
      }));
      const fallbackByDomain = stmts.logFallbackByDomain.all(window).map(r => ({
        domain: r.domain, count: r.c,
      }));
      return { total, window, bySource, lowQualityDomains, fallbackByDomain };
    },

    getMeta(key) {
      const row = stmts.metaGet.get(key);
      return row ? row.value : null;
    },
    setMeta(key, value) {
      stmts.metaSet.run(key, value);
    },
    setRecipesInvalidatedAt(iso) {
      recipesInvalidatedAt = iso;
      stmts.metaSet.run('recipes_invalidated_at', iso);
    },
  };
}
