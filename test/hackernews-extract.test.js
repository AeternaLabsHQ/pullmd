// test/hackernews-extract.test.js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fetchAlgoliaItem, fetchAlgoliaSearch } from '../lib/hackernews.js';

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
