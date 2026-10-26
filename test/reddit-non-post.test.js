import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { extractPost, RedditUnsupportedPageError } from '../lib/reddit.js';
import { createApp } from '../server.js';

// Reddit URLs that are neither a post nor a subreddit front page (rules,
// wiki, user profiles, ...) used to crash with "Cannot read properties of
// undefined (reading 'data')". They now fail with a clear error.

async function withFetch(impl, fn) {
  const original = global.fetch;
  global.fetch = mock.fn(impl);
  try {
    return await fn(global.fetch);
  } finally {
    global.fetch = original;
  }
}

async function request(app, path) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const port = server.address().port;
      fetch(`http://localhost:${port}${path}`)
        .then(async (res) => {
          const text = await res.text();
          server.close();
          resolve({ status: res.status, body: text });
        })
        .catch((err) => { server.close(); reject(err); });
    });
  });
}

describe('extractPost on Reddit pages that are not posts', () => {
  for (const url of [
    'https://www.reddit.com/r/selfhosted/about/rules/',
    'https://old.reddit.com/r/selfhosted/wiki/index',
    'https://www.reddit.com/user/someone/',
    'https://www.reddit.com/r/selfhosted/top/',
  ]) {
    it(`rejects ${url} without fetching`, async () => {
      await withFetch(async () => { throw new Error('must not fetch'); }, async (fetchMock) => {
        await assert.rejects(extractPost(url), RedditUnsupportedPageError);
        assert.equal(fetchMock.mock.callCount(), 0);
      });
    });
  }

  it('rejects a post-shaped URL whose JSON is not a post listing', async () => {
    const json = { kind: 'wikipage', data: { content_md: 'x' } };
    await withFetch(async () => ({ ok: true, status: 200, json: async () => json }), async () => {
      await assert.rejects(
        extractPost('https://www.reddit.com/gallery/abc123'),
        RedditUnsupportedPageError,
      );
    });
  });

  it('still accepts comment permalinks and posts without a subreddit', async () => {
    const listing = [
      { data: { children: [{ data: { title: 'T', selftext: 'body', is_self: true, num_comments: 0 } }] } },
      { data: { children: [] } },
    ];
    await withFetch(async () => ({ ok: true, status: 200, json: async () => listing }), async () => {
      for (const url of [
        'https://www.reddit.com/r/x/comments/abc123/t/def456/',
        'https://www.reddit.com/comments/abc123/',
        'https://www.reddit.com/user/someone/comments/abc123/t/',
      ]) {
        const md = await extractPost(url, { comments: false });
        assert.match(md, /^# T/m, url);
      }
    });
  });
});

describe('GET /api on a Reddit page that is not a post', () => {
  it('answers 400 with a readable error', async () => {
    const app = createApp({
      extractPost: async () => { throw new RedditUnsupportedPageError('https://www.reddit.com/r/x/about/rules/'); },
    });
    const url = encodeURIComponent('https://www.reddit.com/r/x/about/rules/');
    const res = await request(app, `/api?url=${url}`);
    assert.equal(res.status, 400);
    const body = JSON.parse(res.body);
    assert.equal(body.code, 'reddit_unsupported_page');
    assert.match(body.error, /posts and subreddits/);
  });
});
