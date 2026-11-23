import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createCache } from '../lib/cache.js';

// Builds a cache whose onAssetsRemoved calls are recorded in `removed`.
function make(opts = {}) {
  const removed = [];
  const cache = createCache(':memory:', { ...opts, onAssetsRemoved: (assets) => removed.push(assets) });
  return { cache, removed };
}

const entry = (url, extra = {}) => ({ url, title: 'T', markdown: '# T', source: 'readability', ...extra });
const asset = (id, mime = 'image/png', size = 100) => ({ id, mime, size });
const backdateId = (cache, id, days) =>
  cache.db.prepare(`UPDATE conversions SET created_at = datetime('now', '-${days} days') WHERE id = ?`).run(id);

describe('cache.put return value', () => {
  it('returns { id, shareId } and keeps the share id when the URL is put again', () => {
    const { cache } = make();
    const first = cache.put(entry('https://example.com/a'));
    assert.equal(typeof first.id, 'number');
    assert.match(first.shareId, /^[0-9a-f]{32}$/);
    const second = cache.put(entry('https://example.com/a', { markdown: '# T2' }));
    assert.equal(second.id, first.id);
    assert.equal(second.shareId, first.shareId);
  });
});

describe('cache rows without a URL (stored uploads)', () => {
  it('inserts a new row on every put and never matches get()', () => {
    const { cache } = make();
    const a = cache.put({ url: null, title: 'a.pdf', markdown: '# a', source: 'pdf-ocr' });
    const b = cache.put({ url: null, title: 'b.pdf', markdown: '# b', source: 'pdf-ocr' });
    assert.notEqual(a.id, b.id);
    assert.notEqual(a.shareId, b.shareId);
    assert.equal(cache.getByShareId(a.shareId).title, 'a.pdf');
    assert.equal(cache.getByShareId(b.shareId).title, 'b.pdf');
    assert.equal(cache.getByShareId(a.shareId).url, null);
    assert.equal(cache.get(null), null);
    const titles = cache.history(10).map(r => r.title).sort();
    assert.deepEqual(titles, ['a.pdf', 'b.pdf']);
    assert.equal(cache.historyPage(10, 0).total, 2);
  });

  it('records a fetch for the owning user', () => {
    const { cache } = make();
    const uid = cache.db.prepare('INSERT INTO users (email, password_hash) VALUES (?, ?)').run('u@x.y', 'h').lastInsertRowid;
    cache.put({ url: null, title: 'mine.pdf', markdown: '# m', source: 'pdf-ocr', user_id: uid });
    assert.deepEqual(cache.historyForUser(uid, 10).map(r => r.title), ['mine.pdf']);
  });
});

describe('cache assets', () => {
  it('stores assets with a put and finds them with getAsset', () => {
    const { cache } = make();
    const { id } = cache.put(entry('https://example.com/a', { assets: [asset('a'.repeat(32), 'image/jpeg', 1234)] }));
    assert.deepEqual(cache.getAsset('a'.repeat(32)), { id: 'a'.repeat(32), mime: 'image/jpeg', size: 1234, conversion_id: id });
    assert.equal(cache.getAsset('b'.repeat(32)), null);
  });

  it('listAssetIds returns every stored id', () => {
    const { cache } = make();
    cache.put(entry('https://example.com/a', { assets: [asset('a1'), asset('a2')] }));
    cache.put({ url: null, title: 'x.pdf', markdown: '# x', source: 'pdf-ocr', assets: [asset('b1')] });
    assert.deepEqual(cache.listAssetIds().sort(), ['a1', 'a2', 'b1']);
  });

  it('re-putting a URL with new assets reports exactly the old ones and keeps the new ones', () => {
    const { cache, removed } = make();
    cache.put(entry('https://example.com/a', { assets: [asset('old1', 'image/png'), asset('old2', 'image/webp')] }));
    assert.equal(removed.length, 0);
    cache.put(entry('https://example.com/a', { assets: [asset('new1', 'image/jpeg')] }));
    assert.equal(removed.length, 1, 'one callback call');
    assert.deepEqual(removed[0].map(a => a.id).sort(), ['old1', 'old2']);
    assert.deepEqual(removed[0].find(a => a.id === 'old2'), { id: 'old2', mime: 'image/webp' });
    assert.equal(cache.getAsset('old1'), null);
    assert.equal(cache.getAsset('old2'), null);
    assert.equal(cache.getAsset('new1').mime, 'image/jpeg');
  });

  it('re-putting an asset id that is also in the old generation keeps it and does not report it as removed', () => {
    const { cache, removed } = make();
    cache.put(entry('https://example.com/a', { assets: [asset('same')] }));
    cache.put(entry('https://example.com/a', { assets: [asset('same')] }));
    assert.ok(cache.getAsset('same'));
    assert.deepEqual(removed, [], 'an id that lives on must not be reported, its file would be deleted');
  });

  it('re-putting without assets removes the old ones', () => {
    const { cache, removed } = make();
    cache.put(entry('https://example.com/a', { assets: [asset('old1')] }));
    cache.put(entry('https://example.com/a'));
    assert.deepEqual(removed, [[{ id: 'old1', mime: 'image/png' }]]);
    assert.equal(cache.getAsset('old1'), null);
  });

  it('does not call onAssetsRemoved when nothing was removed', () => {
    const { cache, removed } = make();
    cache.put(entry('https://example.com/a'));
    cache.put(entry('https://example.com/a'));
    cache.put(entry('https://example.com/b', { assets: [asset('x1')] }));
    assert.deepEqual(removed, []);
  });

  it('delete(id) reports the assets of that row only', () => {
    const { cache, removed } = make();
    const a = cache.put(entry('https://example.com/a', { assets: [asset('a1')] }));
    cache.put(entry('https://example.com/b', { assets: [asset('b1')] }));
    cache.delete(a.id);
    assert.deepEqual(removed, [[{ id: 'a1', mime: 'image/png' }]]);
    assert.equal(cache.getAsset('a1'), null);
    assert.ok(cache.getAsset('b1'));
  });

  it('deleteAll() reports every asset', () => {
    const { cache, removed } = make();
    cache.put(entry('https://example.com/a', { assets: [asset('a1')] }));
    cache.put({ url: null, title: 'x.pdf', markdown: '# x', source: 'pdf-ocr', assets: [asset('b1'), asset('b2')] });
    cache.deleteAll();
    assert.equal(removed.length, 1);
    assert.deepEqual(removed[0].map(a => a.id).sort(), ['a1', 'b1', 'b2']);
    assert.deepEqual(cache.listAssetIds(), []);
  });

  it('forgetting a row for one user leaves its assets alone', () => {
    const { cache, removed } = make();
    const uid = cache.db.prepare('INSERT INTO users (email, password_hash) VALUES (?, ?)').run('u@x.y', 'h').lastInsertRowid;
    const { id } = cache.put(entry('https://example.com/a', { user_id: uid, assets: [asset('a1')] }));
    cache.forgetForUser(uid, id);
    cache.forgetAllForUser(uid);
    assert.deepEqual(removed, []);
    assert.ok(cache.getAsset('a1'));
  });

  it('a callback that throws does not break put, delete or deleteAll', () => {
    const cache = createCache(':memory:', { onAssetsRemoved: () => { throw new Error('disk gone'); } });
    const log = console.error;
    console.error = () => {};
    try {
      const a = cache.put(entry('https://example.com/a', { assets: [asset('a1')] }));
      const again = cache.put(entry('https://example.com/a', { assets: [asset('a2')] }));
      assert.equal(again.id, a.id);
      assert.ok(cache.getAsset('a2'));
      assert.equal(cache.delete(a.id).changes, 1);
      cache.put(entry('https://example.com/b', { assets: [asset('b1')] }));
      assert.doesNotThrow(() => cache.deleteAll());
    } finally {
      console.error = log;
    }
  });

  it('works without an onAssetsRemoved callback', () => {
    const cache = createCache(':memory:');
    cache.put(entry('https://example.com/a', { assets: [asset('a1')] }));
    cache.put(entry('https://example.com/a'));
    assert.equal(cache.getAsset('a1'), null);
  });
});

describe('cache assets and retention', () => {
  it('getAsset hides expired assets before any prune, the next put prunes and reports them', () => {
    const { cache, removed } = make({ retentionDays: 90 });
    const old = cache.put({ url: null, title: 'old.pdf', markdown: '# o', source: 'pdf-ocr', assets: [asset('o1', 'image/gif')] });
    backdateId(cache, old.id, 100);
    assert.equal(cache.getAsset('o1'), null, 'expired rows are invisible without a prune');
    assert.deepEqual(cache.listAssetIds(), ['o1'], 'the row is still there until a put prunes');
    assert.deepEqual(removed, []);
    cache.put(entry('https://example.com/fresh', { assets: [asset('f1')] }));
    assert.deepEqual(removed, [[{ id: 'o1', mime: 'image/gif' }]]);
    assert.deepEqual(cache.listAssetIds(), ['f1']);
    assert.ok(cache.getAsset('f1'));
  });

  it('retentionDays 0: assets stay readable and nothing is pruned', () => {
    const { cache, removed } = make({ retentionDays: 0 });
    const old = cache.put({ url: null, title: 'old.pdf', markdown: '# o', source: 'pdf-ocr', assets: [asset('o1')] });
    backdateId(cache, old.id, 400);
    cache.put(entry('https://example.com/fresh'));
    assert.ok(cache.getAsset('o1'));
    assert.deepEqual(removed, []);
  });

  it('a re-put of an expired URL reports the old assets once and keeps the new ones', () => {
    const { cache, removed } = make({ retentionDays: 90 });
    const first = cache.put(entry('https://example.com/a', { assets: [asset('old1')] }));
    backdateId(cache, first.id, 100);
    cache.put(entry('https://example.com/a', { assets: [asset('new1')] }));
    assert.deepEqual(removed.flat().map(a => a.id), ['old1']);
    assert.ok(cache.getAsset('new1'));
  });

  it('retentionDays 0: a re-put with new assets reports the old ones once and keeps the new ones', () => {
    const { cache, removed } = make({ retentionDays: 0 });
    cache.put(entry('https://example.com/a', { assets: [asset('old1')] }));
    cache.put(entry('https://example.com/a', { assets: [asset('new1')] }));
    assert.deepEqual(removed.flat().map(a => a.id), ['old1']);
    assert.equal(cache.getAsset('old1'), null);
    assert.ok(cache.getAsset('new1'));
  });

  it('treats assets: null like no assets', () => {
    const { cache } = make();
    const { shareId } = cache.put(entry('https://example.com/n', { assets: null }));
    assert.equal(cache.getByShareId(shareId).title, 'T');
    assert.deepEqual(cache.listAssetIds(), []);
  });
});
