import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { resolveRedditUrl } from './helpers/fake-dns.js';

describe('resolveRedditUrl', () => {
  it('returns normalized URL directly for standard URLs', async () => {
    const result = await resolveRedditUrl('https://www.reddit.com/r/javascript/comments/abc123/my_post/');
    assert.equal(result, 'https://www.reddit.com/r/javascript/comments/abc123/my_post/');
  });

  it('follows redirects for redd.it short links', async () => {
    const originalFetch = global.fetch;
    global.fetch = mock.fn(async (url, opts) => ({
      status: 302,
      headers: new Map([['location', 'https://www.reddit.com/r/javascript/comments/abc123/real_post/']]),
    }));

    try {
      const result = await resolveRedditUrl('https://redd.it/abc123');
      assert.equal(result, 'https://www.reddit.com/r/javascript/comments/abc123/real_post/');
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('follows redirects for /s/ share links', async () => {
    const originalFetch = global.fetch;
    global.fetch = mock.fn(async (url, opts) => ({
      status: 302,
      headers: new Map([['location', 'https://www.reddit.com/r/javascript/comments/xyz789/shared_post/']]),
    }));

    try {
      const result = await resolveRedditUrl('https://www.reddit.com/r/javascript/s/AbCdEf123');
      assert.equal(result, 'https://www.reddit.com/r/javascript/comments/xyz789/shared_post/');
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('throws on failed redirect resolution', async () => {
    const originalFetch = global.fetch;
    global.fetch = mock.fn(async () => ({ status: 404, headers: new Map() }));

    try {
      await assert.rejects(
        () => resolveRedditUrl('https://redd.it/nonexistent'),
        { message: /failed to resolve/i }
      );
    } finally {
      global.fetch = originalFetch;
    }
  });
});
