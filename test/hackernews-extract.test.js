// test/hackernews-extract.test.js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fetchAlgoliaItem, fetchAlgoliaSearch, extractHn } from '../lib/hackernews.js';
import { readFileSync } from 'node:fs';
const itemFixture = JSON.parse(readFileSync(new URL('./fixtures/hn-item.json', import.meta.url)));
const searchFixture = JSON.parse(readFileSync(new URL('./fixtures/hn-search.json', import.meta.url)));
const ok = (body) => async () => ({ ok: true, status: 200, json: async () => body });

const fakeFetch = (status, body) => async () => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

describe('fetchAlgoliaItem', () => {
  it('returns parsed JSON on 200', async () => {
    const item = await fetchAlgoliaItem('1', { fetchImpl: fakeFetch(200, { id: 1, type: 'story' }) });
    assert.equal(item.id, 1);
  });
  it('throws "Item not found" on 404', async () => {
    await assert.rejects(() => fetchAlgoliaItem('1', { fetchImpl: fakeFetch(404, {}) }), /not found/i);
  });
  it('throws on 429', async () => {
    await assert.rejects(() => fetchAlgoliaItem('1', { fetchImpl: fakeFetch(429, {}) }), /rate limit/i);
  });
});

describe('fetchAlgoliaSearch', () => {
  it('returns hits array', async () => {
    const hits = await fetchAlgoliaSearch('/', { fetchImpl: fakeFetch(200, { hits: [{ objectID: '9' }] }) });
    assert.equal(hits[0].objectID, '9');
  });
  it('defaults unknown listing to front_page without throwing', async () => {
    const hits = await fetchAlgoliaSearch('/bogus', { fetchImpl: fakeFetch(200, { hits: [] }) });
    assert.deepEqual(hits, []);
  });
});

describe('extractHn', () => {
  it('renders an item with meta', async () => {
    const r = await extractHn('https://news.ycombinator.com/item?id=1', { withMeta: true, commentDepth: 5, fetchImpl: ok(itemFixture) });
    assert.ok(r.markdown.startsWith('# '));
    assert.ok(r.markdown.includes('## Kommentare'));
    assert.ok('upvotes' in r.meta && 'author' in r.meta && 'published' in r.meta);
  });
  it('renders a listing (meta null)', async () => {
    const r = await extractHn('https://news.ycombinator.com/', { withMeta: true, fetchImpl: ok(searchFixture) });
    assert.ok(r.markdown.startsWith('# Hacker News —'));
    assert.equal(r.meta, null);
  });
  it('returns a bare string when withMeta is false', async () => {
    const md = await extractHn('https://news.ycombinator.com/item?id=1', { fetchImpl: ok(itemFixture) });
    assert.equal(typeof md, 'string');
  });
});
