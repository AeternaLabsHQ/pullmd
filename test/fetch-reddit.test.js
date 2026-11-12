import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { fetchRedditJson } from '../lib/reddit.js';

const MOCK_REDDIT_JSON = [
  {
    data: {
      children: [{
        data: {
          title: 'Test Post Title',
          author: 'testuser',
          subreddit: 'javascript',
          score: 142,
          created_utc: Math.floor(Date.now() / 1000) - 7200,
          selftext: 'This is the post body.\n\nWith multiple paragraphs.',
          is_self: true,
          url: 'https://www.reddit.com/r/javascript/comments/abc123/test_post/',
          num_comments: 234,
          is_video: false,
          media: null,
          gallery_data: null,
          media_metadata: null,
          post_hint: undefined,
        }
      }]
    }
  },
  {
    data: {
      children: [
        { kind: 't1', data: { author: 'commenter1', score: 87, body: 'Top level comment', depth: 0, replies: '' } },
        { kind: 't1', data: { author: 'commenter2', score: 42, body: 'Another comment.', depth: 0, replies: '' } }
      ]
    }
  }
];

describe('fetchRedditJson', () => {
  it('fetches and returns parsed Reddit JSON data', async () => {
    const originalFetch = global.fetch;
    global.fetch = mock.fn(async () => ({
      ok: true, status: 200,
      json: async () => MOCK_REDDIT_JSON,
    }));

    try {
      const result = await fetchRedditJson('https://www.reddit.com/r/javascript/comments/abc123/test_post/');
      assert.equal(result[0].data.children[0].data.title, 'Test Post Title');
      assert.equal(result[1].data.children.length, 2);
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('throws on 404', async () => {
    const originalFetch = global.fetch;
    global.fetch = mock.fn(async () => ({ ok: false, status: 404 }));
    try {
      await assert.rejects(() => fetchRedditJson('https://www.reddit.com/r/javascript/comments/abc123/test_post/'), { message: /not found/i });
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('throws on 429 rate limit', async () => {
    const originalFetch = global.fetch;
    global.fetch = mock.fn(async () => ({ ok: false, status: 429 }));
    try {
      await assert.rejects(() => fetchRedditJson('https://www.reddit.com/r/javascript/comments/abc123/test_post/'), { message: /rate.limit/i });
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('throws on 403 blocked', async () => {
    const originalFetch = global.fetch;
    global.fetch = mock.fn(async () => ({ ok: false, status: 403 }));
    try {
      await assert.rejects(() => fetchRedditJson('https://www.reddit.com/r/javascript/comments/abc123/test_post/'), { message: /403/i });
    } finally {
      global.fetch = originalFetch;
    }
  });
});
