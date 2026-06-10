// test/hackernews-url.test.js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeHnUrl, isHnUrl } from '../lib/hackernews.js';

describe('normalizeHnUrl', () => {
  it('parses an item URL', () => {
    const t = normalizeHnUrl('https://news.ycombinator.com/item?id=48471048');
    assert.deepEqual(t, { kind: 'item', id: '48471048', canonical: 'https://news.ycombinator.com/item?id=48471048' });
  });
  it('parses item URLs with extra query params', () => {
    const t = normalizeHnUrl('https://news.ycombinator.com/item?id=123&p=2');
    assert.equal(t.kind, 'item');
    assert.equal(t.id, '123');
  });
  it('maps each listing path', () => {
    assert.equal(normalizeHnUrl('https://news.ycombinator.com/').listing, '/');
    assert.equal(normalizeHnUrl('https://news.ycombinator.com/news').listing, '/news');
    assert.equal(normalizeHnUrl('https://news.ycombinator.com/newest').listing, '/newest');
    assert.equal(normalizeHnUrl('https://news.ycombinator.com/ask').listing, '/ask');
    assert.equal(normalizeHnUrl('https://news.ycombinator.com/show').listing, '/show');
    assert.equal(normalizeHnUrl('https://news.ycombinator.com/jobs').listing, '/jobs');
    assert.equal(normalizeHnUrl('https://news.ycombinator.com/best').listing, '/best');
  });
  it('rejects user, threads, and non-HN URLs', () => {
    assert.throws(() => normalizeHnUrl('https://news.ycombinator.com/user?id=pg'));
    assert.throws(() => normalizeHnUrl('https://news.ycombinator.com/threads?id=pg'));
    assert.throws(() => normalizeHnUrl('https://example.com/item?id=1'));
    assert.throws(() => normalizeHnUrl('https://news.ycombinator.com/item'));        // no id
    assert.throws(() => normalizeHnUrl('https://news.ycombinator.com/item?id=abc')); // non-numeric
    assert.throws(() => normalizeHnUrl('not a url'));
    assert.throws(() => normalizeHnUrl(null));
  });
});

describe('isHnUrl', () => {
  it('is true for HN URLs, false otherwise', () => {
    assert.equal(isHnUrl('https://news.ycombinator.com/item?id=1'), true);
    assert.equal(isHnUrl('https://news.ycombinator.com/ask'), true);
    assert.equal(isHnUrl('https://reddit.com/r/x'), false);
    assert.equal(isHnUrl('garbage'), false);
  });
});
