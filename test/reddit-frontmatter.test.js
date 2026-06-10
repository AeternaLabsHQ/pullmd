import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { formatPost, extractPost } from '../lib/reddit.js';
import { mergeMediaFrontmatter, KNOWN_FRONTMATTER_FIELDS } from '../lib/frontmatter.js';
import { createApp } from '../server.js';
import { createCache } from '../lib/cache.js';

// v3 clean body for Reddit: the inline meta line (**r/sub** · u/user · N ↑ · …)
// moves into the frontmatter (subreddit/author/published/upvotes), gated by
// the same PULLMD_SOURCE_HEADER opt-out as the web source header.

const makePostData = (overrides = {}) => ({
  title: 'Test Post Title',
  author: 'testuser',
  subreddit: 'javascript',
  score: 142,
  created_utc: 1717920000, // 2024-06-09T08:00:00Z
  selftext: 'This is the post body.',
  is_self: true,
  url: 'https://www.reddit.com/r/javascript/comments/abc123/test_post/',
  num_comments: 234,
  is_video: false,
  media: null,
  gallery_data: null,
  media_metadata: null,
  post_hint: undefined,
  ...overrides,
});

const MOCK_JSON = [
  { data: { children: [{ data: makePostData() }] } },
  { data: { children: [] } },
];

function withEnv(key, value, fn) {
  const prev = process.env[key];
  if (value === undefined) delete process.env[key]; else process.env[key] = value;
  return Promise.resolve(fn()).finally(() => {
    if (prev === undefined) delete process.env[key]; else process.env[key] = prev;
  });
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

describe('formatPost clean body', () => {
  it('omits the inline meta line by default', async () => {
    await withEnv('PULLMD_SOURCE_HEADER', undefined, () => {
      const result = formatPost(makePostData(), 'https://www.reddit.com/r/javascript/comments/abc123/test_post/');
      assert.ok(result.startsWith('# Test Post Title\n'));
      assert.ok(!result.includes('**r/javascript**'), `meta line should be gone:\n${result}`);
      assert.ok(!result.includes('142 ↑'));
      assert.ok(result.includes('This is the post body.'));
    });
  });

  it('restores the inline meta line with PULLMD_SOURCE_HEADER=true', async () => {
    await withEnv('PULLMD_SOURCE_HEADER', 'true', () => {
      const result = formatPost(makePostData(), 'https://www.reddit.com/r/javascript/comments/abc123/test_post/');
      assert.ok(result.includes('**r/javascript**'));
      assert.ok(result.includes('u/testuser'));
      assert.ok(result.includes('142 ↑'));
    });
  });
});

describe('extractPost withMeta', () => {
  it('returns markdown + meta fields when withMeta is set', async () => {
    const originalFetch = global.fetch;
    global.fetch = mock.fn(async () => ({ ok: true, status: 200, json: async () => MOCK_JSON }));
    try {
      const result = await extractPost('https://www.reddit.com/r/javascript/comments/abc123/test/', { comments: false, withMeta: true });
      assert.equal(typeof result.markdown, 'string');
      assert.equal(result.meta.subreddit, 'r/javascript');
      assert.equal(result.meta.author, 'u/testuser');
      assert.equal(result.meta.upvotes, 142);
      assert.equal(result.meta.published, '2024-06-09T08:00:00.000Z');
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('still returns a plain string without withMeta', async () => {
    const originalFetch = global.fetch;
    global.fetch = mock.fn(async () => ({ ok: true, status: 200, json: async () => MOCK_JSON }));
    try {
      const result = await extractPost('https://www.reddit.com/r/javascript/comments/abc123/test/', { comments: false });
      assert.equal(typeof result, 'string');
    } finally {
      global.fetch = originalFetch;
    }
  });
});

describe('reddit frontmatter fields', () => {
  it('mergeMediaFrontmatter emits reddit fields for source reddit', () => {
    const md = mergeMediaFrontmatter('# T\n\nBody', {
      subreddit: 'r/javascript', author: 'u/testuser', published: '2024-06-09T08:00:00.000Z', upvotes: 142,
    }, 'reddit');
    assert.match(md, /subreddit: r\/javascript/);
    assert.match(md, /author: u\/testuser/);
    assert.match(md, /upvotes: 142/);
    assert.match(md, /published: 2024-06-09T08:00:00\.000Z/);
  });

  it('subreddit and upvotes are known frontmatter fields', () => {
    assert.ok(KNOWN_FRONTMATTER_FIELDS.has('subreddit'));
    assert.ok(KNOWN_FRONTMATTER_FIELDS.has('upvotes'));
  });
});

describe('GET /api reddit frontmatter integration', () => {
  it('fresh request: meta in YAML, clean body; cached request keeps the fields', async () => {
    const cache = createCache(':memory:');
    const app = createApp({
      extractPost: async (url, opts) => {
        const markdown = '# Test Post Title\n\nThis is the post body.';
        const meta = { subreddit: 'r/javascript', author: 'u/testuser', published: '2024-06-09T08:00:00.000Z', upvotes: 142 };
        return opts?.withMeta ? { markdown, meta } : markdown;
      },
      cache,
    });

    const url = encodeURIComponent('https://www.reddit.com/r/javascript/comments/abc123/test/');
    const fresh = await request(app, `/api?url=${url}&frontmatter=true&comments=false`);
    assert.equal(fresh.status, 200);
    assert.match(fresh.body, /subreddit: r\/javascript/, `fresh frontmatter missing subreddit:\n${fresh.body.slice(0, 400)}`);
    assert.match(fresh.body, /upvotes: 142/);
    assert.ok(!fresh.body.includes('**r/javascript**'), 'body must not contain the inline meta line');

    const cached = await request(app, `/api?url=${url}&frontmatter=true&comments=false`);
    assert.equal(cached.status, 200);
    assert.match(cached.body, /subreddit: r\/javascript/, `cached frontmatter missing subreddit:\n${cached.body.slice(0, 400)}`);
    assert.match(cached.body, /upvotes: 142/);
  });
});
