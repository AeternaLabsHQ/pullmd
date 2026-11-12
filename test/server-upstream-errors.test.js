import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server.js';
import { createCache } from '../lib/cache.js';
import { RedditUnsupportedPageError } from '../lib/reddit.js';

const REDDIT_URL = 'https://www.reddit.com/r/test/comments/abc/title/';
const HN_URL = 'https://news.ycombinator.com/item?id=1';

// The SSRF guard resolves hostnames before a fetch. Allowlisted names skip
// that lookup, so these tests never touch DNS.
let savedAllowedHosts;
before(() => {
  savedAllowedHosts = process.env.PULLMD_ALLOWED_HOSTS;
  process.env.PULLMD_ALLOWED_HOSTS = 'www.reddit.com,news.ycombinator.com';
});
after(() => {
  if (savedAllowedHosts === undefined) delete process.env.PULLMD_ALLOWED_HOSTS;
  else process.env.PULLMD_ALLOWED_HOSTS = savedAllowedHosts;
});

async function request(app, path) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}${path}`);
    return { status: res.status, headers: Object.fromEntries(res.headers), body: await res.text() };
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

const api = (url, extra = '') => `/api?url=${encodeURIComponent(url)}${extra}`;

function assertNothingStored(cache) {
  assert.equal(cache.historyPage().total, 0, 'a failed extraction must not be cached');
  assert.equal(cache.db.prepare('SELECT COUNT(*) c FROM extraction_log').get().c, 0, 'a failed extraction must not be logged as one');
}

describe('GET /api - Reddit extractor errors', () => {
  const cases = [
    { label: '"Rate limited"', message: 'Rate limited by Reddit', status: 502, error: 'Reddit rate limit. Try again later.' },
    { label: 'a 429 status in the message', message: 'Reddit API returned 429', status: 502, error: 'Reddit rate limit. Try again later.' },
    { label: 'a 403 status in the message', message: 'Reddit API returned 403', status: 502, error: 'Reddit blocked the request.' },
    { label: '"Blocked"', message: 'Blocked by Reddit', status: 502, error: 'Reddit blocked the request.' },
    { label: '"not found"', message: 'Post not found', status: 404, error: 'Post not found' },
    { label: '"Not found"', message: 'Not found', status: 404, error: 'Post not found' },
  ];

  for (const c of cases) {
    it(`${c.label} -> ${c.status} "${c.error}"`, async (t) => {
      const errorLog = t.mock.method(console, 'error', () => {});
      const cache = createCache(':memory:');
      const app = createApp({ cache, extractPost: async () => { throw new Error(c.message); } });

      const res = await request(app, api(REDDIT_URL));

      assert.equal(res.status, c.status);
      assert.match(res.headers['content-type'], /application\/json/);
      assert.deepEqual(JSON.parse(res.body), { error: c.error });
      assert.equal(res.headers['x-source'], undefined);
      assert.equal(res.headers['x-share-id'], undefined);
      assertNothingStored(cache);
      assert.equal(errorLog.mock.callCount(), 0, 'an expected upstream failure is not a server error');
    });
  }

  it('an unsupported Reddit page -> 400 with the error code', async () => {
    const cache = createCache(':memory:');
    const pageUrl = 'https://www.reddit.com/user/someone/';
    const app = createApp({ cache, extractPost: async () => { throw new RedditUnsupportedPageError(pageUrl); } });

    const res = await request(app, api(REDDIT_URL));

    assert.equal(res.status, 400);
    assert.deepEqual(JSON.parse(res.body), {
      error: `Unsupported Reddit page: PullMD reads Reddit posts and subreddits, not ${pageUrl}`,
      code: 'reddit_unsupported_page',
    });
    assertNothingStored(cache);
  });

  // The class decides, not the wording: the message contains "403" here.
  it('an unsupported page whose URL contains 403 is still a 400', async () => {
    const app = createApp({ extractPost: async () => { throw new RedditUnsupportedPageError('https://www.reddit.com/r/x/about/403'); } });
    const res = await request(app, api(REDDIT_URL));
    assert.equal(res.status, 400);
    assert.equal(JSON.parse(res.body).code, 'reddit_unsupported_page');
  });

  it('"not found" wins over a rate-limit wording in the same message', async () => {
    const app = createApp({ extractPost: async () => { throw new Error('Post not found (after 429 retry)'); } });
    const res = await request(app, api(REDDIT_URL));
    assert.equal(res.status, 404);
  });

  it('rate limit wins over blocked when a message names both', async () => {
    const app = createApp({ extractPost: async () => { throw new Error('Rate limited, fallback returned 403'); } });
    const res = await request(app, api(REDDIT_URL));
    assert.equal(res.status, 502);
    assert.deepEqual(JSON.parse(res.body), { error: 'Reddit rate limit. Try again later.' });
  });

  it('anything else -> 500 without leaking the internal message', async (t) => {
    const errorLog = t.mock.method(console, 'error', () => {});
    const cache = createCache(':memory:');
    const boom = new Error('connect ECONNREFUSED 10.1.2.3:8080 token=s3cret');
    const app = createApp({ cache, extractPost: async () => { throw boom; } });

    for (const format of ['', '&format=json', '&format=text']) {
      const res = await request(app, api(REDDIT_URL, format));
      assert.equal(res.status, 500);
      assert.deepEqual(JSON.parse(res.body), { error: 'Internal server error' });
      assert.ok(!res.body.includes('ECONNREFUSED') && !res.body.includes('s3cret') && !res.body.includes('10.1.2.3'));
    }
    assertNothingStored(cache);
    // The operator still gets the real error.
    assert.equal(errorLog.mock.callCount(), 3);
    assert.deepEqual(errorLog.mock.calls[0].arguments, ['API error:', boom]);
  });

  it('a failed refetch keeps serving nothing new but leaves an earlier cache row alone', async (t) => {
    t.mock.method(console, 'error', () => {});
    const cache = createCache(':memory:');
    const shareId = cache.put({ url: REDDIT_URL, title: 'Alt', markdown: '# Alt\n\nText', source: 'reddit' });
    const app = createApp({ cache, extractPost: async () => { throw new Error('Reddit API returned 403'); } });

    const res = await request(app, api(REDDIT_URL, '&nocache=true'));

    assert.equal(res.status, 502);
    assert.equal(cache.getByShareId(shareId).markdown, '# Alt\n\nText');
    assert.equal(cache.historyPage().total, 1);
  });
});

describe('GET /api - Hacker News branch', () => {
  const HN_MD = '# Show HN: A **bold** thing\n\nSome [link](https://example.com/x) text\n\n## Comments\n\n- first';
  const hnOk = async () => ({ markdown: HN_MD, meta: { author: 'pg', points: 42 } });
  const webMustNotRun = async () => { throw new Error('web pipeline must not run'); };

  it('format=json returns markdown, metadata, source and shareId', async () => {
    const cache = createCache(':memory:');
    const app = createApp({ cache, extractHn: hnOk, extractWeb: webMustNotRun });

    const res = await request(app, api(HN_URL, '&format=json'));

    assert.equal(res.status, 200);
    assert.match(res.headers['content-type'], /application\/json/);
    const json = JSON.parse(res.body);
    assert.deepEqual(Object.keys(json).sort(), ['markdown', 'metadata', 'shareId', 'source']);
    assert.equal(json.markdown, HN_MD);
    assert.equal(json.source, 'hackernews');
    assert.match(json.shareId, /^[0-9a-f]{32}$/);
    assert.equal(json.metadata.title, 'Show HN: A **bold** thing');
    assert.equal(json.metadata.sourceUrl, HN_URL);
    assert.equal(json.metadata.statusCode, 200);
    assert.equal(typeof json.metadata.quality, 'number');
    assert.equal(json.metadata.author, null);

    assert.equal(res.headers['x-source'], 'hackernews');
    assert.equal(res.headers['x-share-id'], json.shareId);
    assert.equal(res.headers['x-quality'], String(json.metadata.quality));

    // The share id is real: the row is stored with the extractor's meta.
    const stored = cache.getByShareId(json.shareId);
    assert.equal(stored.url, HN_URL);
    assert.equal(stored.source, 'hackernews');
    assert.equal(stored.title, 'Show HN: A **bold** thing');
    assert.deepEqual(stored.metadata, { author: 'pg', points: 42 });
  });

  it('format=json without a cache reports shareId null', async () => {
    const app = createApp({ extractHn: hnOk, extractWeb: webMustNotRun });
    const json = JSON.parse((await request(app, api(HN_URL, '&format=json'))).body);
    assert.equal(json.shareId, null);
    assert.equal(json.source, 'hackernews');
  });

  it('format=text returns text/plain with the markdown stripped', async () => {
    const app = createApp({ extractHn: hnOk, extractWeb: webMustNotRun });

    const res = await request(app, api(HN_URL, '&format=text'));

    assert.equal(res.status, 200);
    assert.match(res.headers['content-type'], /^text\/plain; charset=utf-8/);
    assert.equal(res.headers['x-source'], 'hackernews');
    assert.equal(res.body,
      'Show HN: A bold thing\n\nSome link (https://example.com/x) text\n\nComments\n\n- first');
  });

  it('accepts a bare string from the extractor and falls back to a default title', async () => {
    const cache = createCache(':memory:');
    const app = createApp({ cache, extractHn: async () => 'no heading here', extractWeb: webMustNotRun });

    const json = JSON.parse((await request(app, api(HN_URL, '&format=json'))).body);

    assert.equal(json.metadata.title, null);
    const stored = cache.getByShareId(json.shareId);
    assert.equal(stored.title, 'Hacker News');
    assert.equal(stored.metadata, null);
  });

  it('falls through to the web pipeline when the HN extractor throws', async (t) => {
    const warn = t.mock.method(console, 'warn', () => {});
    const cache = createCache(':memory:');
    const webCalls = [];
    const app = createApp({
      cache,
      extractHn: async () => { throw new Error('Algolia returned 503'); },
      extractWeb: async (url, opts) => {
        webCalls.push({ url, opts });
        return { markdown: '# From the web pipeline\n\nBody', title: 'From the web pipeline', source: 'readability', metadata: { title: 'From the web pipeline' } };
      },
    });

    const res = await request(app, api(HN_URL, '&format=json'));

    assert.equal(res.status, 200);
    assert.equal(webCalls.length, 1);
    assert.equal(webCalls[0].url, HN_URL);
    assert.equal(webCalls[0].opts.comments, false);
    const json = JSON.parse(res.body);
    assert.equal(json.source, 'readability');
    assert.equal(json.markdown, '# From the web pipeline\n\nBody');
    assert.equal(res.headers['x-source'], 'readability');
    // Cached as what it is, not as a Hacker News result.
    assert.equal(cache.getByShareId(json.shareId).source, 'readability');
    assert.equal(cache.historyPage().total, 1);

    const hnWarnings = warn.mock.calls.map((c) => String(c.arguments[0])).filter((m) => m.startsWith('[hn]'));
    assert.equal(hnWarnings.length, 1);
    assert.ok(hnWarnings[0].includes(HN_URL) && hnWarnings[0].includes('Algolia returned 503'));
  });

  it('does not call the web pipeline when the HN extractor succeeds', async () => {
    let webCalled = 0;
    const app = createApp({ extractHn: hnOk, extractWeb: async () => { webCalled++; return { markdown: 'x', title: 'x', source: 'readability' }; } });
    const res = await request(app, api(HN_URL));
    assert.equal(res.status, 200);
    assert.match(res.headers['content-type'], /^text\/markdown/);
    assert.equal(res.body, HN_MD);
    assert.equal(webCalled, 0);
  });
});
