import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createCache } from '../lib/cache.js';

describe('cache', () => {
  let cache;

  beforeEach(() => {
    cache = createCache(':memory:');
  });

  it('stores and retrieves a conversion', () => {
    cache.put({ url: 'https://example.com', title: 'Test', markdown: '# Test', source: 'readability' });
    const hit = cache.get('https://example.com');
    assert.equal(hit.title, 'Test');
    assert.equal(hit.markdown, '# Test');
    assert.equal(hit.source, 'readability');
  });

  it('returns null for unknown URL', () => {
    assert.equal(cache.get('https://nope.com'), null);
  });

  describe('extraction logging', () => {
    it('logs an extraction event with derived domain', () => {
      cache.logExtraction({
        url: 'https://example.com/page',
        source: 'trafilatura',
        quality: 0.85,
        markdownLen: 5000,
        extractorReason: 'readability fell back to body',
        durationMs: 250,
        client: 'browser',
        cached: false,
      });
      const stats = cache.extractionStats('-1 hour');
      assert.equal(stats.total, 1);
      assert.equal(stats.bySource[0].source, 'trafilatura');
      assert.equal(stats.bySource[0].count, 1);
      assert.equal(stats.bySource[0].avgQuality, 0.85);
    });

    it('aggregates by source with percentages', () => {
      for (let i = 0; i < 7; i++) cache.logExtraction({ url: 'https://a.com', source: 'readability', quality: 0.7, markdownLen: 1000, durationMs: 100, client: 'api' });
      for (let i = 0; i < 3; i++) cache.logExtraction({ url: 'https://b.com', source: 'trafilatura', quality: 0.5, markdownLen: 800, durationMs: 200, client: 'api' });
      const stats = cache.extractionStats('-1 hour');
      assert.equal(stats.total, 10);
      const readability = stats.bySource.find(s => s.source === 'readability');
      const trafilatura = stats.bySource.find(s => s.source === 'trafilatura');
      assert.equal(readability.pct, 70);
      assert.equal(trafilatura.pct, 30);
    });

    it('lists low-quality domains (uncached only)', () => {
      cache.logExtraction({ url: 'https://bad.com/x', source: 'readability-fallback', quality: 0.2, markdownLen: 100, durationMs: 50, client: 'api' });
      cache.logExtraction({ url: 'https://bad.com/y', source: 'readability-fallback', quality: 0.3, markdownLen: 200, durationMs: 50, client: 'api' });
      cache.logExtraction({ url: 'https://good.com', source: 'readability', quality: 0.9, markdownLen: 5000, durationMs: 50, client: 'api' });
      const stats = cache.extractionStats('-1 hour');
      assert.equal(stats.lowQualityDomains.length, 1);
      assert.equal(stats.lowQualityDomains[0].domain, 'bad.com');
      assert.equal(stats.lowQualityDomains[0].count, 2);
    });

    it('tracks fallback usage by domain', () => {
      cache.logExtraction({ url: 'https://thin.com/a', source: 'readability-fallback', quality: 0.2, markdownLen: 100, durationMs: 50, client: 'api' });
      cache.logExtraction({ url: 'https://thin.com/b', source: 'trafilatura', quality: 0.7, markdownLen: 5000, durationMs: 200, extractorReason: 'readability thin (<500c), trafilatura substantial', client: 'api' });
      const stats = cache.extractionStats('-1 hour');
      assert.equal(stats.fallbackByDomain[0].domain, 'thin.com');
      assert.equal(stats.fallbackByDomain[0].count, 2);
    });

    it('returns zero stats for empty log', () => {
      const stats = cache.extractionStats('-1 hour');
      assert.equal(stats.total, 0);
    });
  });

  it('returns null for expired entry (> 1 hour)', () => {
    cache.put({ url: 'https://old.com', title: 'Old', markdown: '# Old', source: 'cloudflare' });
    cache.db.prepare("UPDATE conversions SET created_at = datetime('now', '-2 hours') WHERE url = ?").run('https://old.com');
    assert.equal(cache.get('https://old.com'), null);
  });

  it('replaces existing entry on re-put', () => {
    cache.put({ url: 'https://x.com', title: 'V1', markdown: '# V1', source: 'cloudflare' });
    cache.put({ url: 'https://x.com', title: 'V2', markdown: '# V2', source: 'readability' });
    const hit = cache.get('https://x.com');
    assert.equal(hit.title, 'V2');
  });

  it('prunes entries older than 90 days', () => {
    cache.put({ url: 'https://old.com/pruned', title: 'Old', markdown: '# Old', source: 'readability' });
    cache.db.prepare("UPDATE conversions SET created_at = datetime('now', '-91 days') WHERE url = ?").run('https://old.com/pruned');
    // Trigger pruning by inserting another entry
    cache.put({ url: 'https://new.com/fresh', title: 'New', markdown: '# New', source: 'readability' });
    const count = cache.db.prepare("SELECT COUNT(*) as c FROM conversions WHERE url = 'https://old.com/pruned'").get().c;
    assert.equal(count, 0);
  });

  it('returns a share_id on put', () => {
    const shareId = cache.put({ url: 'https://share.com', title: 'Share', markdown: '# Share', source: 'readability' });
    assert.ok(shareId);
    assert.equal(shareId.length, 8);
  });

  it('preserves share_id on re-put', () => {
    const id1 = cache.put({ url: 'https://keep.com', title: 'V1', markdown: '# V1', source: 'cloudflare' });
    cache.put({ url: 'https://keep.com', title: 'V2', markdown: '# V2', source: 'readability' });
    const hit = cache.get('https://keep.com');
    assert.equal(hit.share_id, id1);
  });

  it('retrieves entry by share_id', () => {
    const shareId = cache.put({ url: 'https://by-share.com', title: 'Shared', markdown: '# Shared', source: 'readability' });
    const entry = cache.getByShareId(shareId);
    assert.equal(entry.title, 'Shared');
    assert.equal(entry.markdown, '# Shared');
  });

  it('returns null for expired share_id (> 90 days)', () => {
    const shareId = cache.put({ url: 'https://expired-share.com', title: 'Old', markdown: '# Old', source: 'readability' });
    cache.db.prepare("UPDATE conversions SET created_at = datetime('now', '-91 days') WHERE url = ?").run('https://expired-share.com');
    assert.equal(cache.getByShareId(shareId), null);
  });

  it('round-trips structured metadata through put/get and getByShareId', () => {
    const shareId = cache.put({ url: 'https://m.com', title: 'M', markdown: '# M', source: 'youtube', metadata: { ytDuration: '12:34', ytViews: '1000' } });
    assert.deepEqual(cache.get('https://m.com').metadata, { ytDuration: '12:34', ytViews: '1000' });
    assert.deepEqual(cache.getByShareId(shareId).metadata, { ytDuration: '12:34', ytViews: '1000' });
  });

  it('returns null metadata for rows stored without it', () => {
    cache.put({ url: 'https://n.com', title: 'N', markdown: '# N', source: 'readability' });
    assert.equal(cache.get('https://n.com').metadata, null);
  });

  it('stores client field', () => {
    cache.put({ url: 'https://client.com', title: 'C', markdown: '# C', source: 'readability', client: 'claude' });
    const hit = cache.get('https://client.com');
    assert.equal(hit.client, 'claude');
  });

  it('returns history entries with share_id and client', () => {
    cache.put({ url: 'https://a.com', title: 'A', markdown: '# A', source: 'cloudflare', client: 'browser' });
    cache.put({ url: 'https://b.com', title: 'B', markdown: '# B', source: 'readability', client: 'claude' });
    const history = cache.history(10);
    assert.equal(history.length, 2);
    assert.equal(history[0].url, 'https://b.com');
    assert.equal(history[0].title, 'B');
    assert.equal(history[0].source, 'readability');
    assert.equal(history[0].client, 'claude');
    assert.ok(history[0].share_id);
    assert.ok(history[0].created_at);
    assert.ok(history[0].id, 'history entries must include id so the recents UI can issue DELETE /api/cache/:id');
    assert.equal(history[0].markdown, undefined);
  });

  it('respects history limit', () => {
    for (let i = 0; i < 30; i++) {
      cache.put({ url: `https://example.com/${i}`, title: `T${i}`, markdown: `# ${i}`, source: 'readability' });
    }
    const history = cache.history(5);
    assert.equal(history.length, 5);
  });

  it('orders history by created_at so re-fetches bubble to the top', () => {
    cache.put({ url: 'https://old.com', title: 'Old', markdown: '# Old', source: 'readability' });
    cache.put({ url: 'https://newer.com', title: 'Newer', markdown: '# Newer', source: 'readability' });
    // Simulate the old row being re-fetched later — created_at advances past 'newer'.
    cache.db.prepare("UPDATE conversions SET created_at = datetime('now', '+1 minute') WHERE url = ?").run('https://old.com');
    const history = cache.history(10);
    assert.equal(history[0].url, 'https://old.com', 're-fetched URL should be first despite lower id');
    assert.equal(history[1].url, 'https://newer.com');
    const page = cache.historyPage(10, 0);
    assert.equal(page.items[0].url, 'https://old.com');
  });

  it('delete returns changes count', () => {
    cache.put({ url: 'https://del.com', title: 'D', markdown: '# D', source: 'readability' });
    const id = cache.db.prepare('SELECT id FROM conversions WHERE url = ?').get('https://del.com').id;
    assert.equal(cache.delete(id).changes, 1);
    assert.equal(cache.delete(id).changes, 0, 'second delete should be a no-op');
    assert.equal(cache.delete(99999).changes, 0, 'delete on unknown id should be a no-op');
  });

  describe('storageStats', () => {
    it('reports total, retention days, and db size', () => {
      cache.put({ url: 'https://a.com', title: 'A', markdown: '# A', source: 'readability' });
      cache.put({ url: 'https://b.com', title: 'B', markdown: '# B', source: 'reddit' });
      const s = cache.storageStats();
      assert.equal(s.total, 2);
      assert.equal(s.retentionDays, 90);
      assert.ok(s.dbSizeBytes > 0);
    });

    it('counts entries expiring soon (>80 days old)', () => {
      cache.put({ url: 'https://old.com', title: 'Old', markdown: '# Old', source: 'readability' });
      cache.db.prepare("UPDATE conversions SET created_at = datetime('now', '-85 days') WHERE url = ?").run('https://old.com');
      const s = cache.storageStats();
      assert.equal(s.expiringSoon, 1);
    });

    it('reports cache hit rate from extraction log', () => {
      for (let i = 0; i < 4; i++) cache.logExtraction({ url: 'https://a.com', source: 'readability', quality: 0.7, markdownLen: 1000, durationMs: 100, cached: false });
      for (let i = 0; i < 6; i++) cache.logExtraction({ url: 'https://a.com', source: 'readability', quality: 0.7, markdownLen: 1000, durationMs: 5, cached: true });
      const s = cache.storageStats();
      assert.equal(s.requests7d, 10);
      assert.equal(s.cacheHits7d, 6);
    });
  });
});

describe('cache — recipes invalidation in get()', () => {
  it('returns null when row created_at < recipes_invalidated_at', () => {
    const c = createCache(':memory:');
    c.put({ url: 'https://x.com', title: 'T', markdown: '# T', source: 'readability' });
    // Set invalidation timestamp AFTER the row was inserted
    const future = new Date(Date.now() + 1000).toISOString().replace('T', ' ').slice(0, 19);
    c.setRecipesInvalidatedAt(future);
    assert.equal(c.get('https://x.com'), null);
  });

  it('still returns the row when invalidation timestamp is in the past', () => {
    const c = createCache(':memory:');
    c.setRecipesInvalidatedAt('1970-01-01 00:00:00');
    c.put({ url: 'https://x.com', title: 'T', markdown: '# T', source: 'readability' });
    const hit = c.get('https://x.com');
    assert.ok(hit);
    assert.equal(hit.title, 'T');
  });

  it('default (no setRecipesInvalidatedAt called) treats all rows as fresh re: recipes', () => {
    const c = createCache(':memory:');
    c.put({ url: 'https://x.com', title: 'T', markdown: '# T', source: 'readability' });
    const hit = c.get('https://x.com');
    assert.ok(hit);
  });
});

describe('cache — meta table', () => {
  it('creates the meta table on init', () => {
    const c = createCache(':memory:');
    assert.equal(c.getMeta('any-missing-key'), null);
    c.setMeta('foo', 'bar');
    assert.equal(c.getMeta('foo'), 'bar');
  });

  it('overwrites existing key on setMeta', () => {
    const c = createCache(':memory:');
    c.setMeta('foo', 'one');
    c.setMeta('foo', 'two');
    assert.equal(c.getMeta('foo'), 'two');
  });

  it('exposes setRecipesInvalidatedAt + reads it back via meta', () => {
    const c = createCache(':memory:');
    c.setRecipesInvalidatedAt('2026-05-06 12:00:00');
    assert.equal(c.getMeta('recipes_invalidated_at'), '2026-05-06 12:00:00');
  });
});
