import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { resolveRedditUrl } from './helpers/fake-dns.js';

describe('resolveRedditUrl', () => {
  it('returns normalized URL directly for standard URLs', async () => {
    const result = await resolveRedditUrl('https://www.reddit.com/r/javascript/comments/abc123/my_post/');
    assert.equal(result, 'https://www.reddit.com/r/javascript/comments/abc123/my_post/');
  });

  it('follows redirects for redd.it short links', async () => {
    const fetch = mock.fn(async (url, opts) => ({
      status: 302,
      headers: new Map([['location', 'https://www.reddit.com/r/javascript/comments/abc123/real_post/']]),
    }));

    const result = await resolveRedditUrl('https://redd.it/abc123', { fetch });
    assert.equal(result, 'https://www.reddit.com/r/javascript/comments/abc123/real_post/');
  });

  it('follows redirects for /s/ share links', async () => {
    const fetch = mock.fn(async (url, opts) => ({
      status: 302,
      headers: new Map([['location', 'https://www.reddit.com/r/javascript/comments/xyz789/shared_post/']]),
    }));

    const result = await resolveRedditUrl('https://www.reddit.com/r/javascript/s/AbCdEf123', { fetch });
    assert.equal(result, 'https://www.reddit.com/r/javascript/comments/xyz789/shared_post/');
  });

  it('throws on failed redirect resolution', async () => {
    const fetch = mock.fn(async () => ({ status: 404, headers: new Map() }));

    await assert.rejects(
      () => resolveRedditUrl('https://redd.it/nonexistent', { fetch }),
      { message: /failed to resolve/i }
    );
  });
});
