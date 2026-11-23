import Database from 'better-sqlite3';
import { randomBytes } from 'crypto';

// 128 bits: with 32 bits (the pre-3.12 size) and no throttling, an
// enumeration script could walk the whole id space in days (#58). Rows created
// with the old 8-char ids keep resolving: the column is TEXT and nothing
// checks the length.
function generateShareId() {
  return randomBytes(16).toString('hex');
}

export const DEFAULT_CACHE_RETENTION_DAYS = 90;

// Upper bound (100 years), a policy cap with margin: SQLite's date modifier
// only stops computing around seven-digit day counts, and a long enough digit
// string overflows to exponential notation or Infinity before it reaches a
// prepared statement. Anything above the cap is treated as malformed.
export const MAX_CACHE_RETENTION_DAYS = 36500;

// How many days before the cutoff an entry starts counting as "expiring soon"
// in the footer stats. Clamped so short retentions cannot go negative.
const EXPIRING_SOON_LEAD_DAYS = 10;

/** Clamp a row count / offset to an integer in [min, max]; non-numbers fall back to `fallback`. */
function clampInt(value, min, max, fallback) {
  const n = Number.isFinite(value) ? Math.trunc(value) : fallback;
  return Math.max(min, Math.min(n, max));
}

/**
 * Read PULLMD_CACHE_RETENTION_DAYS: an integer number of days between 0 and
 * MAX_CACHE_RETENTION_DAYS, where 0 means unlimited (never prune). Unset or
 * empty after trimming is the normal "not configured" case (compose files
 * pass ${VAR:-}) and falls back silently. Any other malformed value, out of
 * range included, warns once and falls back too, so a typo never keeps the
 * server from starting.
 */
export function readCacheRetentionDays(env = process.env, warn = console.warn) {
  const raw = env.PULLMD_CACHE_RETENTION_DAYS;
  if (raw == null) return DEFAULT_CACHE_RETENTION_DAYS;
  const value = String(raw).trim();
  if (value === '') return DEFAULT_CACHE_RETENTION_DAYS;
  if (/^\d+$/.test(value)) {
    // Digits alone are not enough: a long enough run of them parses to
    // exponential notation or Infinity, neither of which survives being
    // interpolated into a SQLite date modifier.
    const days = Number(value);
    if (days <= MAX_CACHE_RETENTION_DAYS) return days;
  }
  warn(`PULLMD_CACHE_RETENTION_DAYS: invalid value "${raw}" (expected an integer number of days between 0 and ${MAX_CACHE_RETENTION_DAYS}); using default ${DEFAULT_CACHE_RETENTION_DAYS}`);
  return DEFAULT_CACHE_RETENTION_DAYS;
}

/**
 * @param {string} dbPath
 * @param {object} [opts]
 * @param {number} [opts.retentionDays]
 * @param {(assets: Array<{ id: string, mime: string }>) => void} [opts.onAssetsRemoved]
 *   Called after a transaction that deleted `assets` rows has committed, with
 *   the removed rows, so the caller can delete the files behind them. The
 *   cache does no file I/O itself. A throwing callback is caught and logged.
 */
export function createCache(dbPath = '/data/cache.db', { retentionDays = DEFAULT_CACHE_RETENTION_DAYS, onAssetsRemoved } = {}) {
  // Validated before the database is opened: the prepared statements below bake
  // the retention window into their SQL, and a bad value must not leave a
  // half-initialised db file behind. readCacheRetentionDays is the only
  // coercion boundary, so callers pass a real number or get a TypeError.
  if (!Number.isInteger(retentionDays) || retentionDays < 0 || retentionDays > MAX_CACHE_RETENTION_DAYS) {
    throw new TypeError(`createCache: retentionDays must be an integer between 0 and ${MAX_CACHE_RETENTION_DAYS} (got ${typeof retentionDays} ${String(retentionDays)})`);
  }

  // Retention 0 = unlimited: no age condition on share lookups, no prune, and
  // nothing counts as expiring soon.
  const retentionCutoff = retentionDays > 0
    ? `datetime('now', '-${retentionDays} days')`
    : null;
  const expiringSoonCutoff = retentionDays > 0
    ? `datetime('now', '-${Math.max(retentionDays - EXPIRING_SOON_LEAD_DAYS, 0)} days')`
    : null;

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

  // Metadata of the files stored for a conversion (hosted OCR figures). The
  // files live on disk; a row ties each one to its conversion. The FK cascade
  // is only a net: every path that deletes a conversions row deletes its
  // assets explicitly first, to learn which files to remove. A URL re-convert
  // is an upsert (the row id stays), so no cascade fires there either.
  db.exec(`
    CREATE TABLE IF NOT EXISTS assets (
      id            TEXT PRIMARY KEY,
      conversion_id INTEGER NOT NULL REFERENCES conversions(id) ON DELETE CASCADE,
      mime          TEXT NOT NULL,
      size          INTEGER NOT NULL,
      created_at    TEXT DEFAULT (datetime('now'))
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_assets_conversion ON assets(conversion_id)`);

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

  // Embedded image transcripts, keyed by the image itself (not by the page
  // URL), so every URL form of a post and every share link reuses what was
  // paid for once. `data` is `{description, transcript}` or `{failed: true}`.
  db.exec(`
    CREATE TABLE IF NOT EXISTS image_transcripts (
      key TEXT PRIMARY KEY,
      data TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

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

  // Runs after the deleting transaction committed. A failing callback (disk
  // error while removing files) must not fail the request that triggered it.
  function notifyAssetsRemoved(removed) {
    if (!onAssetsRemoved || removed.length === 0) return;
    try {
      onAssetsRemoved(removed);
    } catch (err) {
      console.error('cache: onAssetsRemoved failed:', err?.message || err);
    }
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
    insertRow: db.prepare(`
      INSERT INTO conversions (url, title, markdown, source, share_id, client, user_id, metadata, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `),
    getRowByUrl: db.prepare(`SELECT id, share_id FROM conversions WHERE url = ?`),
    insertAsset: db.prepare(`INSERT INTO assets (id, conversion_id, mime, size) VALUES (?, ?, ?, ?)`),
    // Same retention cutoff as getByShareId: pruning only happens inside put().
    getAsset: db.prepare(`
      SELECT a.id, a.mime, a.size, a.conversion_id FROM assets a
      JOIN conversions c ON c.id = a.conversion_id
      WHERE a.id = ?${retentionCutoff ? ` AND c.created_at > ${retentionCutoff}` : ''}
    `),
    listAssetIds: db.prepare(`SELECT id FROM assets`),
    deleteAssetsForConversion: db.prepare(`DELETE FROM assets WHERE conversion_id = ? RETURNING id, mime`),
    deleteAllAssets: db.prepare(`DELETE FROM assets RETURNING id, mime`),
    touch: db.prepare(`UPDATE conversions SET created_at = datetime('now') WHERE url = ?`),
    get: db.prepare(`
      SELECT id, title, markdown, source, share_id, client, metadata, created_at FROM conversions
      WHERE url = ?
        AND created_at > datetime('now', '-1 hour')
        AND created_at > ?
    `),
    getByShareId: db.prepare(`
      SELECT url, title, markdown, source, client, metadata, created_at FROM conversions
      WHERE share_id = ?${retentionCutoff ? ` AND created_at > ${retentionCutoff}` : ''}
    `),
    getImageTranscript: db.prepare(`
      SELECT data FROM image_transcripts
      WHERE key = ?${retentionCutoff ? ` AND created_at > ${retentionCutoff}` : ''}
    `),
    putImageTranscript: db.prepare(`
      INSERT INTO image_transcripts (key, data, created_at) VALUES (?, ?, datetime('now'))
      ON CONFLICT(key) DO UPDATE SET data = excluded.data, created_at = datetime('now')
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
    deleteFetchesForCache: db.prepare(`DELETE FROM user_fetches WHERE cache_id = ?`),
    deleteAllFetches: db.prepare(`DELETE FROM user_fetches`),
    deleteAllImageTranscripts: db.prepare(`DELETE FROM image_transcripts`),
    isOwnedUpload: db.prepare(`SELECT 1 FROM conversions WHERE id = ? AND url IS NULL AND user_id = ?`),
    ownedUploadIds: db.prepare(`SELECT id FROM conversions WHERE url IS NULL AND user_id = ?`),
    forgetFetch: db.prepare(`DELETE FROM user_fetches WHERE user_id = ? AND cache_id = ?`),
    forgetAllFetches: db.prepare(`DELETE FROM user_fetches WHERE user_id = ?`),
    // user_fetches.cache_id declares no FK to conversions (foreign keys are
    // enabled above, but this column was created without one and SQLite cannot
    // add one in place), so fetch rows are cleaned explicitly. Without this,
    // countForUser counts rows historyPageForUser cannot join and the archive
    // paginates toward entries that never arrive.
    pruneOrphanFetches: db.prepare(`
      DELETE FROM user_fetches WHERE cache_id NOT IN (SELECT id FROM conversions)
    `),
    // null when retention is unlimited, in which case put() skips the prune.
    pruneOld: retentionCutoff
      ? db.prepare(`DELETE FROM conversions WHERE created_at < ${retentionCutoff}`)
      : null,
    pruneOldAssets: retentionCutoff
      ? db.prepare(`
          DELETE FROM assets
          WHERE conversion_id IN (SELECT id FROM conversions WHERE created_at < ${retentionCutoff})
          RETURNING id, mime
        `)
      : null,
    pruneOldImageTranscripts: retentionCutoff
      ? db.prepare(`DELETE FROM image_transcripts WHERE created_at < ${retentionCutoff}`)
      : null,
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

  // One-time sweep so a database written by an older build (where pruneOld
  // dropped conversions without their fetch rows) starts out consistent.
  stmts.pruneOrphanFetches.run();

  return {
    db,

    get retentionDays() { return retentionDays; },

    /**
     * Store a conversion. `url: null` is a stored upload: a new row every time.
     * Otherwise the row for the URL is updated in place (its id and share id
     * stay). The previous generation's assets are deleted first, then the new
     * `assets` are inserted, all in one transaction. Returns { id, shareId }.
     */
    put({ url, title, markdown, source, client, user_id = null, metadata = null, assets }) {
      const shareId = generateShareId();
      const metaJson = metadata != null ? JSON.stringify(metadata) : null;
      assets = assets ?? [];
      const newIds = new Set(assets.map(a => a.id));
      const removed = [];
      const run = db.transaction(() => {
        let id;
        let finalShareId;
        if (url == null) {
          id = Number(stmts.insertRow.run(null, title, markdown, source, shareId, client || 'browser', user_id, metaJson).lastInsertRowid);
          finalShareId = shareId;
        } else {
          // Old generation first: the upsert keeps the row id, so no FK cascade
          // would remove these. The new assets are inserted only afterwards.
          const existing = stmts.getRowByUrl.get(url);
          if (existing) removed.push(...stmts.deleteAssetsForConversion.all(existing.id));
          stmts.upsert.run(url, title, markdown, source, shareId, client || 'browser', user_id, metaJson);
          const row = stmts.getRowByUrl.get(url);
          id = row.id;
          finalShareId = row.share_id || shareId;
        }
        if (stmts.pruneOld) {
          removed.push(...stmts.pruneOldAssets.all());
          const pruned = stmts.pruneOld.run();
          // Only pay for the orphan scan when the retention prune actually
          // removed something, which is rare - put() runs on every conversion.
          if (pruned.changes > 0) stmts.pruneOrphanFetches.run();
          stmts.pruneOldImageTranscripts.run();
        }
        for (const a of assets) stmts.insertAsset.run(a.id, id, a.mime, a.size);
        if (user_id != null) stmts.upsertFetch.run(user_id, id);
        return { id, shareId: finalShareId };
      });
      const result = run();
      // An old asset whose id was handed in again lives on: its file stays.
      notifyAssetsRemoved(removed.filter(a => !newIds.has(a.id)));
      return result;
    },

    /**
     * Record that a user received an existing row (a cache hit), so it shows
     * up in their history like a fresh conversion does via put() (#98).
     * No-op without a user, i.e. when sign-in is off.
     */
    recordFetch(userId, cacheId) {
      if (userId == null || cacheId == null) return;
      stmts.upsertFetch.run(userId, cacheId);
    },

    // Restart the refresh clock of an entry without changing its content.
    touch(url) {
      stmts.touch.run(url);
    },

    getIdByUrl(url) {
      const row = db.prepare('SELECT id FROM conversions WHERE url = ?').get(url);
      return row?.id || null;
    },

    get(url) {
      const row = stmts.get.get(url, recipesInvalidatedAt);
      return row ? parseMetadata(row) : null;
    },

    /** Stored transcript of one embedded image (retention applies), or null. */
    getImageTranscript(key) {
      const row = stmts.getImageTranscript.get(key);
      if (!row) return null;
      try { return JSON.parse(row.data); } catch { return null; }
    },

    /** Store (or replace) the transcript of one embedded image; restarts its retention clock. */
    putImageTranscript(key, data) {
      stmts.putImageTranscript.run(key, JSON.stringify(data));
    },

    getByShareId(shareId) {
      const row = stmts.getByShareId.get(shareId);
      return row ? parseMetadata(row) : null;
    },

    /** Metadata of one stored asset (retention applies), or null. */
    getAsset(id) {
      return stmts.getAsset.get(id) || null;
    },

    listAssetIds() {
      return stmts.listAssetIds.all().map(r => r.id);
    },

    history(limit = 20) {
      return stmts.history.all(clampInt(limit, 1, 100, 20));
    },

    historyPage(limit = 50, offset = 0) {
      const items = stmts.historyPage.all(clampInt(limit, 1, 200, 50), clampInt(offset, 0, Number.MAX_SAFE_INTEGER, 0));
      const { total } = stmts.count.get();
      return { items, total };
    },

    historyForUser(userId, limit = 20) {
      return stmts.historyForUser.all(userId, clampInt(limit, 1, 100, 20));
    },

    historyPageForUser(userId, limit = 50, offset = 0) {
      const items = stmts.historyPageForUser.all(userId, clampInt(limit, 1, 200, 50), clampInt(offset, 0, Number.MAX_SAFE_INTEGER, 0));
      const { total } = stmts.countForUser.get(userId);
      return { items, total };
    },

    delete(id) {
      let removed = [];
      const run = db.transaction((cacheId) => {
        stmts.deleteFetchesForCache.run(cacheId);
        removed = stmts.deleteAssetsForConversion.all(cacheId);
        return stmts.deleteOne.run(cacheId);
      });
      const result = run(id);
      notifyAssetsRemoved(removed);
      return result;
    },

    deleteAll() {
      let removed = [];
      const run = db.transaction(() => {
        stmts.deleteAllFetches.run();
        removed = stmts.deleteAllAssets.all();
        // A full clear also drops stored image transcripts (and failure
        // markers), so it is a way to retry every image.
        stmts.deleteAllImageTranscripts.run();
        return stmts.deleteAll.run();
      });
      const result = run();
      notifyAssetsRemoved(removed);
      return result;
    },

    /**
     * A stored upload (row without a URL) belongs to the one user who made it;
     * unlike a URL row it is never shared, so its owner may delete it for real.
     */
    isOwnedUpload(userId, cacheId) {
      return !!stmts.isOwnedUpload.get(cacheId, userId);
    },

    ownedUploadIds(userId) {
      return stmts.ownedUploadIds.all(userId).map(r => r.id);
    },

    forgetForUser(userId, cacheId) {
      return stmts.forgetFetch.run(userId, cacheId);
    },

    forgetAllForUser(userId) {
      return stmts.forgetAllFetches.run(userId);
    },

    pruneOrphanFetches() {
      return stmts.pruneOrphanFetches.run();
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
      // <= so that a retention short enough to clamp the lead time to 0 days
      // counts rows written in this very second, instead of silently skipping
      // them on the second boundary.
      const expiringSoon = expiringSoonCutoff
        ? db.prepare(`
            SELECT COUNT(*) as c FROM conversions WHERE created_at <= ${expiringSoonCutoff}
          `).get().c
        : 0;
      const oldest = db.prepare(`SELECT MIN(created_at) as t FROM conversions`).get().t;
      const dbSizeBytes = db.prepare(`SELECT page_count * page_size AS size FROM pragma_page_count(), pragma_page_size()`).get().size;
      const cacheHits7d = db.prepare(`SELECT COUNT(*) as c FROM extraction_log WHERE cached = 1 AND created_at > datetime('now', '-7 days')`).get().c;
      const requests7d = db.prepare(`SELECT COUNT(*) as c FROM extraction_log WHERE created_at > datetime('now', '-7 days')`).get().c;
      return {
        total,
        expiringSoon,
        oldest,
        retentionDays,
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
