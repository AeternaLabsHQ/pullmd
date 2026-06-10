// test/hackernews-listing.test.js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { formatListing } from '../lib/hackernews.js';

const hit = (o = {}) => ({ objectID: '100', title: 'Story', url: 'https://ex.com', author: 'a', points: 234, num_comments: 56, ...o });

describe('formatListing', () => {
  it('renders a numbered list with points, comments, discussion link', () => {
    const md = formatListing([hit()], '/');
    assert.ok(md.startsWith('# Hacker News — Front Page'));
    assert.ok(md.includes('1. [Story](https://ex.com)'));
    assert.ok(md.includes('234 points'));
    assert.ok(md.includes('56 comments'));
    assert.ok(md.includes('[discussion](https://news.ycombinator.com/item?id=100)'));
  });
  it('links Ask HN (no url) to the discussion', () => {
    const md = formatListing([hit({ url: null, title: 'Ask HN: Q?' })], '/ask');
    assert.ok(md.startsWith('# Hacker News — Ask HN'));
    assert.ok(md.includes('[Ask HN: Q?](https://news.ycombinator.com/item?id=100)'));
  });
});
