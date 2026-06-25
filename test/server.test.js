import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server.js';
import { createCache } from '../lib/cache.js';

async function request(app, path, opts = {}) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const port = server.address().port;
      fetch(`http://localhost:${port}${path}`, opts)
        .then(async (res) => {
          const text = await res.text();
          server.close();
          resolve({ status: res.status, headers: Object.fromEntries(res.headers), body: text });
        })
        .catch((err) => { server.close(); reject(err); });
    });
  });
}

describe('GET /api', () => {
  it('returns 400 when no url param provided', async () => {
    const app = createApp();
    const res = await request(app, '/api');
    assert.equal(res.status, 400);
    const json = JSON.parse(res.body);
    assert.ok(json.error);
  });

  it('routes non-Reddit URL to web pipeline (not 400)', async () => {
    const app = createApp({
      extractWeb: async () => ({ markdown: '# Page', title: 'Page', source: 'readability' }),
      cache: createCache(':memory:'),
    });
    const res = await request(app, '/api?url=https://example.com');
    assert.equal(res.status, 200);
  });

  it('returns markdown with correct content-type for valid request', async () => {
    const app = createApp({
      extractPost: async () => '# Test\n\nBody',
    });
    const res = await request(app, '/api?url=https://www.reddit.com/r/test/comments/abc/title/');
    assert.equal(res.status, 200);
    assert.ok(res.headers['content-type'].includes('text/markdown'));
    assert.ok(res.body.includes('# Test'));
  });

  it('returns text/plain when format=text', async () => {
    const app = createApp({
      extractPost: async () => '# Test\n\n**Bold** text',
    });
    const res = await request(app, '/api?url=https://www.reddit.com/r/test/comments/abc/title/&format=text');
    assert.equal(res.status, 200);
    assert.ok(res.headers['content-type'].includes('text/plain'));
    assert.ok(!res.body.includes('**'));
    assert.ok(!res.body.includes('# '));
  });

  it('passes comments option to extractPost', async () => {
    let receivedOptions;
    const app = createApp({
      extractPost: async (url, opts) => { receivedOptions = opts; return '# Test'; },
    });
    await request(app, '/api?url=https://www.reddit.com/r/test/comments/abc/title/&comments=true&comment_depth=5&comment_limit=10');
    assert.equal(receivedOptions.comments, true);
    assert.equal(receivedOptions.commentDepth, 5);
    assert.equal(receivedOptions.commentLimit, 10);
  });

  it('serves a Hacker News item via the HN extractor with merged frontmatter', async () => {
    const app = createApp({
      extractHn: async () => ({ markdown: '# HN Story\n\n## Kommentare (1 von 1)\n\n**bob** · 1h ago: hi', meta: { author: 'sub', published: '2026-06-10T00:00:00.000Z', upvotes: 99 } }),
      cache: createCache(':memory:'),
    });
    const res = await request(app, '/api?url=https://news.ycombinator.com/item?id=1&frontmatter=true');
    assert.equal(res.status, 200);
    assert.equal(res.headers['x-source'], 'hackernews');
    assert.ok(res.body.includes('# HN Story'));
    assert.ok(res.body.includes('upvotes: 99'));
  });

  it('passes comment params to the HN extractor', async () => {
    let opts;
    const app = createApp({
      extractHn: async (url, o) => { opts = o; return '# HN'; },
      cache: createCache(':memory:'),
    });
    await request(app, '/api?url=https://news.ycombinator.com/item?id=1&comment_depth=4&comment_limit=8');
    assert.equal(opts.commentDepth, 4);
    assert.equal(opts.commentLimit, 8);
    assert.equal(opts.withMeta, true);
  });

  it('falls back to the web pipeline when the HN extractor throws', async () => {
    const app = createApp({
      extractHn: async () => { throw new Error('Item not found'); },
      extractWeb: async () => ({ markdown: '# Web Fallback', title: 'Web', source: 'readability' }),
      cache: createCache(':memory:'),
    });
    const res = await request(app, '/api?url=https://news.ycombinator.com/item?id=1');
    assert.equal(res.status, 200);
    assert.ok(res.body.includes('# Web Fallback'));
  });

  it('returns 404 for post not found', async () => {
    const app = createApp({
      extractPost: async () => { throw new Error('Post not found'); },
    });
    const res = await request(app, '/api?url=https://www.reddit.com/r/test/comments/abc/title/');
    assert.equal(res.status, 404);
  });

  it('returns 502 for rate limiting', async () => {
    const app = createApp({
      extractPost: async () => { throw new Error('Rate limited by Reddit'); },
    });
    const res = await request(app, '/api?url=https://www.reddit.com/r/test/comments/abc/title/');
    assert.equal(res.status, 502);
  });
});

describe('GET /api - web URLs', () => {
  it('routes non-Reddit URLs to web pipeline', async () => {
    const app = createApp({
      extractWeb: async () => ({
        markdown: '# Web Page\n\nContent',
        title: 'Web Page',
        source: 'readability',
      }),
      cache: createCache(':memory:'),
    });
    const res = await request(app, '/api?url=https://example.com/article');
    assert.equal(res.status, 200);
    assert.ok(res.headers['content-type'].includes('text/markdown'));
    assert.ok(res.body.includes('# Web Page'));
  });

  it('serves media frontmatter fields (duration/views) from cache on a second request', async () => {
    const cache = createCache(':memory:');
    let calls = 0;
    const app = createApp({
      extractWeb: async () => {
        calls++;
        return {
          markdown: '# Vid\n\n## Transcript\n\nhello',
          title: 'Vid',
          source: 'youtube',
          metadata: { sourceUrl: 'https://youtu.be/x', quality: 0.9, ytDuration: '12:34', ytViews: '1000' },
        };
      },
      cache,
    });
    const r1 = await request(app, '/api?url=https://youtu.be/x&frontmatter=true');
    assert.match(r1.body, /duration: 12:34/);
    assert.match(r1.body, /views: 1000/);

    const r2 = await request(app, '/api?url=https://youtu.be/x&frontmatter=true');
    assert.equal(calls, 1, 'second request must be served from cache');
    assert.match(r2.body, /duration: 12:34/, 'cached serve must include duration');
    assert.match(r2.body, /views: 1000/, 'cached serve must include views');
  });

  it('sets the X-Transcript-Status header from the extraction result', async () => {
    const app = createApp({
      extractWeb: async () => ({
        markdown: '# V\n\n## Transcript\n\n_blocked_',
        title: 'V',
        source: 'youtube',
        transcriptStatus: 'blocked',
        noStore: true,
        metadata: { sourceUrl: 'https://youtu.be/x', quality: 0.4 },
      }),
      cache: createCache(':memory:'),
    });
    const r = await request(app, '/api?url=https://youtu.be/x');
    assert.equal(r.headers['x-transcript-status'], 'blocked');
  });

  it('omits X-Transcript-Status when the result has no transcript status', async () => {
    const app = createApp({
      extractWeb: async () => ({ markdown: '# Page', title: 'Page', source: 'readability', metadata: {} }),
      cache: createCache(':memory:'),
    });
    const r = await request(app, '/api?url=https://example.com/plain');
    assert.equal(r.headers['x-transcript-status'], undefined);
  });

  it('does NOT cache a noStore result (transient 429) — re-extracts on each request', async () => {
    let calls = 0;
    const cache = createCache(':memory:');
    const app = createApp({
      extractWeb: async () => {
        calls++;
        return {
          markdown: '# Vid\n\n## Transcript\n\n_blocked_',
          title: 'Vid',
          source: 'youtube',
          noStore: true,
          metadata: { sourceUrl: 'https://youtu.be/blocked', quality: 0.4 },
        };
      },
      cache,
    });
    const r1 = await request(app, '/api?url=https://youtu.be/blocked');
    await request(app, '/api?url=https://youtu.be/blocked');
    assert.equal(calls, 2, 'noStore result must not be cached; each request must re-extract');
    assert.equal(r1.headers['x-share-id'], undefined, 'no share id when the result is not stored');
  });

  it('forwards ?extractor= to extractWeb when valid (#17)', async () => {
    let received;
    const app = createApp({
      extractWeb: async (url, opts) => {
        received = opts.extractor;
        return { markdown: '# Forced', title: 'Forced', source: opts.extractor || 'readability' };
      },
      cache: createCache(':memory:'),
    });
    await request(app, '/api?url=https://example.com/x&extractor=trafilatura');
    assert.equal(received, 'trafilatura');
  });

  it('ignores invalid ?extractor= values (no override → undefined)', async () => {
    let received = '__unset__';
    const app = createApp({
      extractWeb: async (url, opts) => {
        received = opts.extractor;
        return { markdown: '# X', title: 'X', source: 'readability' };
      },
      cache: createCache(':memory:'),
    });
    await request(app, '/api?url=https://example.com/x&extractor=garbage');
    assert.equal(received, undefined);
  });

  it('?extractor= bypasses the cache so the override actually runs', async () => {
    let calls = 0;
    const cache = createCache(':memory:');
    const app = createApp({
      extractWeb: async () => { calls++; return { markdown: '# Y', title: 'Y', source: 'readability' }; },
      cache,
    });
    await request(app, '/api?url=https://example.com/cached2');
    await request(app, '/api?url=https://example.com/cached2&extractor=trafilatura');
    assert.equal(calls, 2, 'second call with extractor must skip the cache');
  });

  it('returns cached result when available', async () => {
    let callCount = 0;
    const cache = createCache(':memory:');
    const app = createApp({
      extractWeb: async () => {
        callCount++;
        return { markdown: '# Cached', title: 'Cached', source: 'readability' };
      },
      cache,
    });
    await request(app, '/api?url=https://example.com/page');
    await request(app, '/api?url=https://example.com/page');
    assert.equal(callCount, 1);
  });

  it('bypasses cache when comment_depth or comment_limit is explicitly set', async () => {
    let callCount = 0;
    const cache = createCache(':memory:');
    const app = createApp({
      extractPost: async () => {
        callCount++;
        return '# Reddit Post\n\nbody\n\n## Kommentare\n\n- one';
      },
      cache,
    });
    const url = 'https://www.reddit.com/r/test/comments/abc/title/';
    await request(app, `/api?url=${encodeURIComponent(url)}`);
    await request(app, `/api?url=${encodeURIComponent(url)}&comment_depth=5`);
    await request(app, `/api?url=${encodeURIComponent(url)}&comment_limit=30`);
    assert.equal(callCount, 3);
  });

  it('bypasses cache when nocache=true', async () => {
    let callCount = 0;
    const cache = createCache(':memory:');
    const app = createApp({
      extractWeb: async () => {
        callCount++;
        return { markdown: '# Fresh', title: 'Fresh', source: 'readability' };
      },
      cache,
    });
    await request(app, '/api?url=https://example.com/page');
    await request(app, '/api?url=https://example.com/page&nocache=true');
    assert.equal(callCount, 2);
  });
});

describe('client detection', () => {
  it('records client=pwa when X-Client-Mode header is pwa', async () => {
    const cache = createCache(':memory:');
    const app = createApp({
      extractWeb: async () => ({ markdown: '# X\n\nbody', title: 'X', source: 'readability', metadata: { quality: 0.8 } }),
      cache,
    });
    await request(app, '/api?url=https://example.com/p', {
      headers: { 'X-Client-Mode': 'pwa', 'User-Agent': 'Mozilla/5.0 Chrome/131' },
    });
    const stats = cache.extractionStats('-1 hour');
    const log = cache.db.prepare('SELECT client FROM extraction_log').get();
    assert.equal(log.client, 'pwa');
  });

  it('records client=browser without the header', async () => {
    const cache = createCache(':memory:');
    const app = createApp({
      extractWeb: async () => ({ markdown: '# X\n\nbody', title: 'X', source: 'readability', metadata: { quality: 0.8 } }),
      cache,
    });
    await request(app, '/api?url=https://example.com/p', {
      headers: { 'User-Agent': 'Mozilla/5.0 Chrome/131' },
    });
    const log = cache.db.prepare('SELECT client FROM extraction_log').get();
    assert.equal(log.client, 'browser');
  });
});

describe('GET /api with frontmatter=true', () => {
  it('prepends YAML frontmatter to web markdown', async () => {
    const app = createApp({
      extractWeb: async () => ({
        markdown: '# Article\n\nBody content.',
        title: 'Article',
        source: 'trafilatura',
        metadata: { title: 'Article', sourceUrl: 'https://example.com/a', quality: 0.8 },
      }),
      cache: createCache(':memory:'),
    });
    const res = await request(app, '/api?url=https://example.com/a&frontmatter=true');
    assert.equal(res.status, 200);
    assert.ok(res.body.startsWith('---\n'), `expected leading ---, got: ${res.body.slice(0, 50)}`);
    assert.ok(res.body.includes('source: trafilatura'));
    assert.ok(res.body.includes('quality: 0.8'));
    assert.ok(res.body.includes('# Article'));
  });

  it('does not add frontmatter without the param', async () => {
    const app = createApp({
      extractWeb: async () => ({
        markdown: '# Article\n\nBody.',
        title: 'Article',
        source: 'readability',
        metadata: { title: 'Article', sourceUrl: 'https://example.com/a' },
      }),
      cache: createCache(':memory:'),
    });
    const res = await request(app, '/api?url=https://example.com/a');
    assert.ok(!res.body.startsWith('---'));
  });

  it('adds frontmatter to cache hits too', async () => {
    const cache = createCache(':memory:');
    cache.put({ url: 'https://example.com/cached', title: 'Cached', markdown: '# Cached\n\nOld content.', source: 'trafilatura' });
    const app = createApp({ extractWeb: async () => { throw new Error('should not extract'); }, cache });
    const res = await request(app, '/api?url=https://example.com/cached&frontmatter=true');
    assert.ok(res.body.startsWith('---\n'));
    assert.ok(res.body.includes('source: trafilatura'));
  });
});

describe('GET /api - cache-hit metadata completeness', () => {
  function webApp(cache, metadata) {
    let calls = 0;
    const app = createApp({
      extractWeb: async () => {
        calls++;
        return { markdown: '# Leopards\n\nBody content here.', title: 'Leopards', source: 'readability', metadata };
      },
      cache,
    });
    return { app, calls: () => calls };
  }

  const META = {
    title: 'Leopards', sourceUrl: 'https://example.com/lp', quality: 1,
    ogImage: 'https://example.com/lead.webp', twitterImage: 'https://example.com/tw.jpg',
    description: 'A leopard story', author: 'Jane Doe', ogSiteName: 'Example', language: 'en',
  };

  it('surfaces image/description/author from cached metadata in frontmatter', async () => {
    const cache = createCache(':memory:');
    const { app, calls } = webApp(cache, META);
    await request(app, '/api?url=https://example.com/lp&frontmatter=true');     // fresh: stores metadata
    const r2 = await request(app, '/api?url=https://example.com/lp&frontmatter=true'); // cache hit
    assert.equal(calls(), 1, 'second request must be served from cache');
    assert.match(r2.body, /image: https:\/\/example\.com\/lead\.webp/, 'image must survive cache');
    assert.match(r2.body, /description: A leopard story/, 'description must survive cache');
    assert.match(r2.body, /author: Jane Doe/, 'author must survive cache');
  });

  it('returns full metadata (not null) with og/twitter image in format=json on cache hits', async () => {
    const cache = createCache(':memory:');
    const { app, calls } = webApp(cache, META);
    await request(app, '/api?url=https://example.com/lp&format=json');           // fresh
    const r2 = await request(app, '/api?url=https://example.com/lp&format=json'); // cache hit
    assert.equal(calls(), 1, 'second request must be served from cache');
    const body = JSON.parse(r2.body);
    assert.ok(body.metadata, 'cache-hit json metadata must not be null');
    assert.equal(body.metadata.ogImage, 'https://example.com/lead.webp');
    assert.equal(body.metadata.twitterImage, 'https://example.com/tw.jpg');
    assert.equal(body.metadata.sourceUrl, 'https://example.com/lp');
  });
});

describe('GET /api/stats', () => {
  it('returns extraction stats from logged events', async () => {
    const cache = createCache(':memory:');
    const app = createApp({
      extractWeb: async () => ({ markdown: '# Web\n\nContent', title: 'Web', source: 'trafilatura', metadata: { quality: 0.8, extractorReason: 'longer with structure' } }),
      cache,
    });
    await request(app, '/api?url=https://example.com/a');
    await request(app, '/api?url=https://example.com/b');
    const res = await request(app, '/api/stats');
    assert.equal(res.status, 200);
    const stats = JSON.parse(res.body);
    assert.equal(stats.total, 2);
    assert.equal(stats.bySource[0].source, 'trafilatura');
    assert.equal(stats.bySource[0].count, 2);
  });

  it('returns empty when cache absent', async () => {
    const app = createApp({});
    const res = await request(app, '/api/stats');
    const stats = JSON.parse(res.body);
    assert.equal(stats.total, 0);
  });
});

describe('GET /api/history', () => {
  it('returns history as JSON', async () => {
    const cache = createCache(':memory:');
    cache.put({ url: 'https://a.com', title: 'A', markdown: '# A', source: 'readability' });
    const app = createApp({ cache });
    const res = await request(app, '/api/history');
    assert.equal(res.status, 200);
    assert.ok(res.headers['content-type'].includes('application/json'));
    const data = JSON.parse(res.body);
    assert.equal(data.length, 1);
    assert.equal(data[0].url, 'https://a.com');
  });

  it('respects limit parameter', async () => {
    const cache = createCache(':memory:');
    for (let i = 0; i < 10; i++) {
      cache.put({ url: `https://example.com/${i}`, title: `T${i}`, markdown: `# ${i}`, source: 'readability' });
    }
    const app = createApp({ cache });
    const res = await request(app, '/api/history?limit=3');
    const data = JSON.parse(res.body);
    assert.equal(data.length, 3);
  });
});

describe('DELETE /api/cache/:id', () => {
  it('returns 404 when the row does not exist', async () => {
    const cache = createCache(':memory:');
    const app = createApp({ cache });
    const res = await request(app, '/api/cache/9999', { method: 'DELETE' });
    assert.equal(res.status, 404);
    const json = JSON.parse(res.body);
    assert.match(json.error, /not found/i);
  });

  it('returns 200 and deletes the row when it exists', async () => {
    const cache = createCache(':memory:');
    cache.put({ url: 'https://drop-me.com', title: 'D', markdown: '# D', source: 'readability' });
    const id = cache.db.prepare('SELECT id FROM conversions WHERE url = ?').get('https://drop-me.com').id;
    const app = createApp({ cache });
    const res = await request(app, `/api/cache/${id}`, { method: 'DELETE' });
    assert.equal(res.status, 200);
    assert.equal(JSON.parse(res.body).ok, true);
    assert.equal(cache.get('https://drop-me.com'), null);
  });
});

describe('GET /api - JSON format', () => {
  it('returns JSON with metadata when format=json for web URLs', async () => {
    const app = createApp({
      extractWeb: async () => ({
        markdown: '# Page\n\nContent',
        title: 'Page',
        source: 'readability',
        metadata: {
          title: 'Page', description: 'Desc', canonical: null, author: null,
          publishedTime: null, modifiedTime: null,
          ogTitle: null, ogDescription: null, ogImage: null,
          ogSiteName: null, ogType: null,
          twitterCard: null, twitterTitle: null, twitterDescription: null, twitterImage: null,
          language: 'en', sourceUrl: 'https://example.com', statusCode: 200,
        },
      }),
      cache: createCache(':memory:'),
    });
    const res = await request(app, '/api?url=https://example.com&format=json');
    assert.equal(res.status, 200);
    assert.ok(res.headers['content-type'].includes('application/json'));
    const json = JSON.parse(res.body);
    assert.ok(json.markdown);
    assert.ok(json.metadata);
    assert.equal(json.metadata.title, 'Page');
    assert.equal(json.source, 'readability');
    assert.ok(json.shareId || json.shareId === null);
  });

  it('returns JSON with metadata for Reddit URLs when format=json', async () => {
    const app = createApp({
      extractPost: async () => '# Reddit Post\n\nBody',
    });
    const res = await request(app, '/api?url=https://www.reddit.com/r/test/comments/abc/title/&format=json');
    assert.equal(res.status, 200);
    assert.ok(res.headers['content-type'].includes('application/json'));
    const json = JSON.parse(res.body);
    assert.ok(json.markdown);
    assert.equal(json.source, 'reddit');
    assert.ok(json.metadata);
  });

  it('still returns markdown by default (backwards compat)', async () => {
    const app = createApp({
      extractWeb: async () => ({
        markdown: '# Page\n\nContent',
        title: 'Page',
        source: 'readability',
        metadata: { title: 'Page' },
      }),
      cache: createCache(':memory:'),
    });
    const res = await request(app, '/api?url=https://example.com');
    assert.equal(res.status, 200);
    assert.ok(res.headers['content-type'].includes('text/markdown'));
  });
});

describe('GET /s/:id', () => {
  it('returns 404 for unknown share id', async () => {
    const app = createApp({ cache: createCache(':memory:') });
    const res = await request(app, '/s/deadbeef');
    assert.equal(res.status, 404);
  });

  it('serves cached markdown without refresh when fresh (<1h old)', async () => {
    const cache = createCache(':memory:');
    let extractCalls = 0;
    const app = createApp({
      cache,
      extractWeb: async () => { extractCalls++; return { markdown: '# Refreshed', title: 'X', source: 'readability' }; },
    });
    const id = cache.put({ url: 'https://example.com/a', title: 'A', markdown: '# Original', source: 'readability', client: 'browser' });
    const res = await request(app, '/s/' + id);
    assert.equal(res.status, 200);
    assert.ok(res.body.includes('# Original'));
    assert.equal(extractCalls, 0, 'should not refresh when fresh');
  });

  it('refreshes from source when cache row is older than 1h', async () => {
    const cache = createCache(':memory:');
    let extractCalls = 0;
    const app = createApp({
      cache,
      extractWeb: async () => { extractCalls++; return { markdown: '# Refreshed', title: 'X', source: 'readability' }; },
    });
    const id = cache.put({ url: 'https://example.com/b', title: 'B', markdown: '# Original', source: 'readability', client: 'browser' });
    // backdate the cache row to >1h ago
    cache.db.prepare("UPDATE conversions SET created_at = datetime('now', '-2 hours') WHERE share_id = ?").run(id);
    const res = await request(app, '/s/' + id);
    assert.equal(res.status, 200);
    assert.equal(extractCalls, 1, 'should call extract on stale row');
    assert.ok(res.body.includes('# Refreshed'));
  });

  it('falls back to stale snapshot when refresh throws', async () => {
    const cache = createCache(':memory:');
    const app = createApp({
      cache,
      extractWeb: async () => { throw new Error('source dead'); },
    });
    const id = cache.put({ url: 'https://example.com/c', title: 'C', markdown: '# Snapshot', source: 'readability', client: 'browser' });
    cache.db.prepare("UPDATE conversions SET created_at = datetime('now', '-2 hours') WHERE share_id = ?").run(id);
    const res = await request(app, '/s/' + id);
    assert.equal(res.status, 200);
    assert.ok(res.body.includes('# Snapshot'));
  });
});

describe('POST /mcp', () => {
  function parseSse(text) {
    const m = text.match(/^data: (.+)$/m);
    return m ? JSON.parse(m[1]) : null;
  }

  it('responds to initialize with server info', async () => {
    const app = createApp();
    const res = await request(app, '/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '0' } },
      }),
    });
    assert.equal(res.status, 200);
    const j = parseSse(res.body);
    assert.equal(j.result.serverInfo.name, 'pullmd');
  });

  it('exposes the three PullMD tools via tools/list', async () => {
    const app = createApp();
    const res = await request(app, '/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    assert.equal(res.status, 200);
    const j = parseSse(res.body);
    const names = j.result.tools.map(t => t.name).sort();
    assert.deepEqual(names, ['get_share', 'list_recent', 'read_url']);
  });

  it('read_url returns extracted markdown via tools/call', async () => {
    const app = createApp({
      cache: createCache(':memory:'),
      extractWeb: async () => ({ markdown: '# Test page', title: 'T', source: 'readability', metadata: { quality: 0.8 } }),
    });
    const res = await request(app, '/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'tools/call',
        params: { name: 'read_url', arguments: { url: 'https://example.com/x' } },
      }),
    });
    assert.equal(res.status, 200);
    const j = parseSse(res.body);
    assert.ok(j.result.content[0].text.includes('# Test page'));
    assert.equal(j.result.structuredContent, undefined, 'structuredContent must be absent so MCP clients surface content[0].text');
  });

  it('read_url prepends YAML frontmatter with source, share_id, share_url, quality, cached', async () => {
    const app = createApp({
      cache: createCache(':memory:'),
      extractWeb: async () => ({ markdown: '# Test page\n\nBody', title: 'T', source: 'readability', metadata: { quality: 0.8 } }),
    });
    const res = await request(app, '/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'tools/call',
        params: { name: 'read_url', arguments: { url: 'https://example.com/x' } },
      }),
    });
    const text = parseSse(res.body).result.content[0].text;
    assert.ok(text.startsWith('---\n'), 'response should start with YAML frontmatter delimiter');
    const fmEnd = text.indexOf('\n---\n', 4);
    assert.ok(fmEnd > 0, 'frontmatter block should be closed');
    const fm = text.slice(4, fmEnd);
    assert.match(fm, /^source: readability$/m);
    assert.match(fm, /^share_id: [0-9a-f]{8}$/m);
    assert.match(fm, /^share_url: https?:\/\/[^/]+\/s\/[0-9a-f]{8}$/m);
    assert.match(fm, /^quality: 0\.8$/m);
    assert.match(fm, /^cached: false$/m);
    assert.ok(text.slice(fmEnd).includes('# Test page'), 'markdown body comes after frontmatter');
  });

  it('read_url uses PUBLIC_URL env for share_url when set', async () => {
    const prev = process.env.PUBLIC_URL;
    process.env.PUBLIC_URL = 'https://my-instance.example.com';
    try {
      const app = createApp({
        cache: createCache(':memory:'),
        extractWeb: async () => ({ markdown: '# X', title: 'X', source: 'trafilatura', metadata: { quality: 1 } }),
      });
      const res = await request(app, '/mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream' },
        body: JSON.stringify({
          jsonrpc: '2.0', id: 1, method: 'tools/call',
          params: { name: 'read_url', arguments: { url: 'https://example.com/x' } },
        }),
      });
      const text = parseSse(res.body).result.content[0].text;
      assert.match(text, /^share_url: https:\/\/my-instance\.example\.com\/s\/[0-9a-f]{8}$/m);
    } finally {
      if (prev === undefined) delete process.env.PUBLIC_URL;
      else process.env.PUBLIC_URL = prev;
    }
  });

  it('read_url marks cached=true on the second call to the same URL', async () => {
    const cache = createCache(':memory:');
    let calls = 0;
    const app = createApp({
      cache,
      extractWeb: async () => { calls++; return { markdown: '# Cached page', title: 'T', source: 'readability', metadata: { quality: 0.7 } }; },
    });
    const body = (id) => JSON.stringify({
      jsonrpc: '2.0', id, method: 'tools/call',
      params: { name: 'read_url', arguments: { url: 'https://example.com/cached' } },
    });
    await request(app, '/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream' },
      body: body(1),
    });
    const res2 = await request(app, '/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream' },
      body: body(2),
    });
    const text = parseSse(res2.body).result.content[0].text;
    assert.equal(calls, 1, 'extractWeb should be called only once across the two requests');
    assert.match(text, /^cached: true$/m);
  });

  it('read_url with frontmatter=true merges share_url/cached into existing block (no duplicate keys)', async () => {
    const app = createApp({
      cache: createCache(':memory:'),
      extractWeb: async () => ({
        markdown: '# Page\n\nBody',
        title: 'Page',
        source: 'trafilatura',
        metadata: { title: 'Page', sourceUrl: 'https://example.com/y', quality: 0.9 },
      }),
    });
    const res = await request(app, '/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'tools/call',
        params: { name: 'read_url', arguments: { url: 'https://example.com/y', frontmatter: true } },
      }),
    });
    const text = parseSse(res.body).result.content[0].text;
    assert.ok(text.startsWith('---\n'));
    const fmEnd = text.indexOf('\n---\n', 4);
    const fm = text.slice(4, fmEnd);
    assert.equal(fm.match(/^source:/gm).length, 1, 'source must appear exactly once');
    assert.equal(fm.match(/^share_id:/gm).length, 1, 'share_id must appear exactly once');
    assert.equal(fm.match(/^quality:/gm).length, 1, 'quality must appear exactly once');
    assert.match(fm, /^share_url: https?:\/\/[^/]+\/s\/[0-9a-f]{8}$/m);
    assert.match(fm, /^cached: false$/m);
  });

  it('list_recent includes share_url for each item', async () => {
    const cache = createCache(':memory:');
    cache.put({ url: 'https://example.com/a', title: 'A', markdown: '# A', source: 'readability', client: 'api' });
    const app = createApp({ cache });
    const res = await request(app, '/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'tools/call',
        params: { name: 'list_recent', arguments: {} },
      }),
    });
    const items = JSON.parse(parseSse(res.body).result.content[0].text);
    assert.equal(items.length, 1);
    assert.match(items[0].share_url, /^https?:\/\/[^/]+\/s\/[0-9a-f]{8}$/);
    assert.equal(items[0].share_id, items[0].share_url.split('/').pop());
  });

  it('read_url forwards extractor option to extractWeb (#17)', async () => {
    let receivedExtractor = '__unset__';
    const app = createApp({
      cache: createCache(':memory:'),
      extractWeb: async (url, opts) => {
        receivedExtractor = opts.extractor;
        return { markdown: '# X', title: 'X', source: opts.extractor || 'readability', metadata: { quality: 0.9 } };
      },
    });
    const res = await request(app, '/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'tools/call',
        params: { name: 'read_url', arguments: { url: 'https://example.com/forced', extractor: 'trafilatura' } },
      }),
    });
    const text = parseSse(res.body).result.content[0].text;
    assert.equal(receivedExtractor, 'trafilatura');
    assert.match(text, /^source: trafilatura$/m);
  });

  it('read_url forwards pdf_ocr to extractWeb and bypasses the cache', async () => {
    const received = [];
    const app = createApp({
      cache: createCache(':memory:'),
      extractWeb: async (url, opts) => {
        received.push(opts);
        return { markdown: '# OCR doc', title: 'D', source: 'pdf-ocr', metadata: { quality: 0.9, pdfPages: 3 } };
      },
    });
    const headers = { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream' };
    const body = (id) => JSON.stringify({
      jsonrpc: '2.0', id, method: 'tools/call',
      params: { name: 'read_url', arguments: { url: 'https://example.com/doc.pdf', pdf_ocr: true, frontmatter: true } },
    });
    await request(app, '/mcp', { method: 'POST', headers, body: body(1) });
    const res2 = await request(app, '/mcp', { method: 'POST', headers, body: body(2) });
    assert.equal(received.length, 2, 'pdf_ocr requests must bypass the cache (extractWeb runs every time)');
    assert.equal(received[0].pdfOcr, true, 'pdfOcr option must be forwarded to extractWeb');
    const text = parseSse(res2.body).result.content[0].text;
    assert.match(text, /^pdf_pages: 3$/m);
  });

  it('read_url rejects an invalid extractor value via Zod schema', async () => {
    const app = createApp({ cache: createCache(':memory:') });
    const res = await request(app, '/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'tools/call',
        params: { name: 'read_url', arguments: { url: 'https://example.com/x', extractor: 'invalid-value' } },
      }),
    });
    const j = parseSse(res.body);
    // MCP surfaces tool-arg validation as an error; either an error envelope
    // or an isError content payload is acceptable here.
    const errored = j.error || j.result?.isError;
    assert.ok(errored, 'invalid extractor enum value must be rejected');
  });

  it('read_url forwards yt_timecodes and yt_chunk to extractWeb', async () => {
    let receivedOpts = {};
    const app = createApp({
      cache: createCache(':memory:'),
      extractWeb: async (url, opts) => {
        receivedOpts = opts;
        return { markdown: '# YT', title: 'YT', source: 'youtube', metadata: { quality: 0.9 } };
      },
    });
    const res = await request(app, '/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'tools/call',
        params: { name: 'read_url', arguments: { url: 'https://www.youtube.com/watch?v=abc', yt_timecodes: 'plain', yt_chunk: 0 } },
      }),
    });
    parseSse(res.body); // assert no MCP-level error
    assert.equal(receivedOpts.ytTimecodes, 'plain');
    assert.equal(receivedOpts.ytChunk, 0, 'yt_chunk: 0 must be forwarded (not dropped by falsy check)');
  });

  it('read_url does not forward yt_timecodes/yt_chunk when omitted', async () => {
    let receivedOpts = {};
    const app = createApp({
      cache: createCache(':memory:'),
      extractWeb: async (url, opts) => {
        receivedOpts = opts;
        return { markdown: '# YT', title: 'YT', source: 'readability', metadata: { quality: 0.9 } };
      },
    });
    await request(app, '/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'tools/call',
        params: { name: 'read_url', arguments: { url: 'https://example.com/no-yt' } },
      }),
    });
    assert.equal(receivedOpts.ytTimecodes, undefined);
    assert.equal(receivedOpts.ytChunk, undefined);
  });

  it('get_share embeds url, source, share_id, share_url, refreshed, age_ms in frontmatter', async () => {
    const cache = createCache(':memory:');
    const shareId = cache.put({ url: 'https://example.com/z', title: 'Z', markdown: '# Z\n\nBody', source: 'readability', client: 'api' });
    const app = createApp({ cache });
    const res = await request(app, '/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'tools/call',
        params: { name: 'get_share', arguments: { id: shareId } },
      }),
    });
    const text = parseSse(res.body).result.content[0].text;
    assert.ok(text.startsWith('---\n'));
    const fmEnd = text.indexOf('\n---\n', 4);
    const fm = text.slice(4, fmEnd);
    assert.match(fm, /^url: https:\/\/example\.com\/z$/m);
    assert.match(fm, /^source: readability$/m);
    assert.match(fm, new RegExp(`^share_id: ${shareId}$`, 'm'));
    assert.match(fm, new RegExp(`^share_url: https?:\\/\\/[^\\/]+\\/s\\/${shareId}$`, 'm'));
    assert.match(fm, /^refreshed: false$/m);
    assert.match(fm, /^age_ms: \d+$/m);
    assert.ok(text.slice(fmEnd).includes('# Z'));
  });
});

describe('GET /share', () => {
  it('redirects to / with hash fragment', async () => {
    const app = createApp();
    const server = app.listen(0);
    const port = server.address().port;
    try {
      const res = await fetch(`http://localhost:${port}/share?link=https://reddit.com/r/test/comments/abc/x/`, { redirect: 'manual' });
      assert.equal(res.status, 302);
      assert.ok(res.headers.get('location').includes('#url='));
    } finally {
      server.close();
    }
  });
});

describe('GET / (templated index)', () => {
  it('returns templated index.html with version and credit links', async () => {
    const app = createApp();
    const res = await request(app, '/');
    assert.equal(res.status, 200);
    assert.ok(res.headers['content-type'].includes('text/html'));
    assert.ok(!res.body.includes('__PULLMD_VERSION__'), 'version placeholder leaked');
    assert.ok(!res.body.includes('__PULLMD_URL__'), 'URL placeholder leaked');

    const { PULLMD_VERSION } = await import('../lib/distrib.js');
    assert.ok(res.body.includes(`v${PULLMD_VERSION}`), 'expected v<version> in body');
    assert.ok(res.body.includes('AeternaLabsHQ/pullmd'), 'expected GitHub repo URL');
    assert.ok(res.body.includes('AGPL-3.0'), 'expected license link text');
  });

  it('GET /index.html serves the same templated content', async () => {
    const app = createApp();
    const res = await request(app, '/index.html');
    assert.equal(res.status, 200);
    assert.ok(res.headers['content-type'].includes('text/html'));
  });
});

describe('GET /api - render query param', () => {
  it('passes render=force through to extractWeb', async () => {
    let received;
    const app = createApp({
      extractWeb: async (url, opts) => {
        received = opts;
        return { markdown: '# Page', title: 'P', source: 'playwright', metadata: { quality: 1, extractorReason: 'forced' } };
      },
      cache: createCache(':memory:'),
    });
    const res = await request(app, '/api?url=https://example.com&render=force');
    assert.equal(res.status, 200);
    assert.equal(received.render, 'force');
  });

  it('passes render=skip through to extractWeb', async () => {
    let received;
    const app = createApp({
      extractWeb: async (url, opts) => {
        received = opts;
        return { markdown: '# Page', title: 'P', source: 'readability', metadata: { quality: 1 } };
      },
      cache: createCache(':memory:'),
    });
    await request(app, '/api?url=https://example.com&render=skip');
    assert.equal(received.render, 'skip');
  });

  it('passes undefined render when param absent', async () => {
    let received;
    const app = createApp({
      extractWeb: async (url, opts) => {
        received = opts;
        return { markdown: '# Page', title: 'P', source: 'readability', metadata: { quality: 1 } };
      },
      cache: createCache(':memory:'),
    });
    await request(app, '/api?url=https://example.com');
    assert.equal(received.render, undefined);
  });

  it('ignores invalid render values (e.g. render=bogus)', async () => {
    let received;
    const app = createApp({
      extractWeb: async (url, opts) => {
        received = opts;
        return { markdown: '# Page', title: 'P', source: 'readability', metadata: { quality: 1 } };
      },
      cache: createCache(':memory:'),
    });
    await request(app, '/api?url=https://example.com&render=bogus');
    assert.equal(received.render, undefined);
  });

  it('bypasses cache when render=force is set', async () => {
    let extractCalls = 0;
    const cache = createCache(':memory:');
    cache.put({ url: 'https://example.com', title: 'Cached', markdown: '# Cached', source: 'readability' });
    const app = createApp({
      extractWeb: async (url, opts) => {
        extractCalls++;
        return { markdown: '# Fresh', title: 'F', source: 'playwright', metadata: { quality: 1 } };
      },
      cache,
    });
    await request(app, '/api?url=https://example.com&render=force');
    assert.equal(extractCalls, 1, 'expected fresh extraction, not cached response');
  });

  it('bypasses cache when render=skip is set', async () => {
    let extractCalls = 0;
    const cache = createCache(':memory:');
    cache.put({ url: 'https://example.com', title: 'Cached', markdown: '# Cached', source: 'readability' });
    const app = createApp({
      extractWeb: async (url, opts) => {
        extractCalls++;
        return { markdown: '# Fresh', title: 'F', source: 'readability', metadata: { quality: 1 } };
      },
      cache,
    });
    await request(app, '/api?url=https://example.com&render=skip');
    assert.equal(extractCalls, 1);
  });
});

describe('GET /api/stream', () => {
  function parseSse(body) {
    const out = [];
    const blocks = body.split('\n\n').filter(Boolean);
    for (const block of blocks) {
      const lines = block.split('\n');
      const event = (lines.find(l => l.startsWith('event: ')) || '').slice(7).trim();
      const data  = (lines.find(l => l.startsWith('data: '))  || '').slice(6).trim();
      out.push({ event, data: data ? JSON.parse(data) : null });
    }
    return out;
  }

  it('emits fetching → extracting → result for a clean web page', async () => {
    const cache = createCache(':memory:');
    const app = createApp({
      extractWeb: async (url, { emit }) => {
        emit('fetching', { url });
        emit('extracting', { source: 'readability' });
        return { markdown: '# Page', title: 'Page', source: 'readability', metadata: { quality: 1 } };
      },
      cache,
    });
    const res = await request(app, '/api/stream?url=https://example.com');
    assert.equal(res.status, 200);
    assert.match(res.headers['content-type'] || '', /text\/event-stream/);
    const events = parseSse(res.body);
    const stages = events.filter(e => e.event === 'status').map(e => e.data.stage);
    assert.deepEqual(stages, ['fetching', 'extracting']);
    const result = events.find(e => e.event === 'result');
    assert.ok(result);
    assert.equal(result.data.source, 'readability');
    assert.match(result.data.markdown, /# Page/);
  });

  it('emits rendering stage on playwright fallback path', async () => {
    const cache = createCache(':memory:');
    const app = createApp({
      extractWeb: async (url, { emit }) => {
        emit('fetching', { url });
        emit('extracting', { source: 'readability' });
        emit('rendering', { reason: 'body-soup signature' });
        emit('extracting', { source: 'playwright' });
        return { markdown: '# Rendered', title: 'R', source: 'playwright', metadata: { quality: 0.9, extractorReason: 'body-soup signature → rendered via playwright' } };
      },
      cache,
    });
    const res = await request(app, '/api/stream?url=https://example.com');
    const events = parseSse(res.body);
    const stages = events.filter(e => e.event === 'status').map(e => e.data.stage);
    assert.deepEqual(stages, ['fetching', 'extracting', 'rendering', 'extracting']);
    const result = events.find(e => e.event === 'result');
    assert.equal(result.data.source, 'playwright');
  });

  it('emits an error event when extraction throws', async () => {
    const app = createApp({
      extractWeb: async () => { throw new Error('upstream 502'); },
      cache: createCache(':memory:'),
    });
    const res = await request(app, '/api/stream?url=https://example.com');
    const events = parseSse(res.body);
    const err = events.find(e => e.event === 'error');
    assert.ok(err);
    assert.match(err.data.message, /502/);
  });

  it('returns 400 when url param missing', async () => {
    const app = createApp({});
    const res = await request(app, '/api/stream');
    assert.equal(res.status, 400);
  });

  it('streams a Hacker News item via the HN extractor', async () => {
    const app = createApp({
      extractHn: async () => ({ markdown: '# HN Story', meta: { author: 'sub', published: '2026-06-10T00:00:00.000Z', upvotes: 42 } }),
      cache: createCache(':memory:'),
    });
    const res = await request(app, '/api/stream?url=https://news.ycombinator.com/item?id=1');
    const events = parseSse(res.body);
    const result = events.find(e => e.event === 'result');
    assert.ok(result);
    assert.equal(result.data.source, 'hackernews');
    assert.match(result.data.markdown, /# HN Story/);
    assert.ok(!events.find(e => e.event === 'error'));
  });

  it('falls back to the web path (no error event) when the HN extractor throws', async () => {
    const app = createApp({
      extractHn: async () => { throw new Error('Item not found'); },
      extractWeb: async (url, { emit }) => {
        emit('fetching', { url });
        emit('extracting', { source: 'readability' });
        return { markdown: '# Web Fallback', title: 'Web', source: 'readability', metadata: { quality: 1 } };
      },
      cache: createCache(':memory:'),
    });
    const res = await request(app, '/api/stream?url=https://news.ycombinator.com/item?id=1');
    const events = parseSse(res.body);
    assert.ok(!events.find(e => e.event === 'error'), 'HN failure must not emit an error event');
    const result = events.find(e => e.event === 'result');
    assert.ok(result);
    assert.equal(result.data.source, 'readability');
    assert.match(result.data.markdown, /# Web Fallback/);
  });
});

describe('DISABLE_PUBLIC_HISTORY', () => {
  it('returns 200 from /api/history by default (flag off)', async () => {
    const cache = createCache(':memory:');
    cache.put({ url: 'https://a.com', title: 'A', markdown: '# A', source: 'readability' });
    const app = createApp({ cache, disablePublicHistory: false });
    const res = await request(app, '/api/history');
    assert.equal(res.status, 200);
    const data = JSON.parse(res.body);
    assert.equal(data.length, 1);
  });

  it('returns 200 from /api/archive by default (flag off)', async () => {
    const cache = createCache(':memory:');
    cache.put({ url: 'https://a.com', title: 'A', markdown: '# A', source: 'readability' });
    const app = createApp({ cache, disablePublicHistory: false });
    const res = await request(app, '/api/archive');
    assert.equal(res.status, 200);
    const data = JSON.parse(res.body);
    assert.equal(data.total, 1);
  });

  it('returns 403 from /api/history when flag is on', async () => {
    const cache = createCache(':memory:');
    cache.put({ url: 'https://a.com', title: 'A', markdown: '# A', source: 'readability' });
    const app = createApp({ cache, disablePublicHistory: true });
    const res = await request(app, '/api/history');
    assert.equal(res.status, 403);
    const json = JSON.parse(res.body);
    assert.match(json.error, /disabled/i);
  });

  it('returns 403 from /api/archive when flag is on', async () => {
    const cache = createCache(':memory:');
    cache.put({ url: 'https://a.com', title: 'A', markdown: '# A', source: 'readability' });
    const app = createApp({ cache, disablePublicHistory: true });
    const res = await request(app, '/api/archive');
    assert.equal(res.status, 403);
    const json = JSON.parse(res.body);
    assert.match(json.error, /disabled/i);
  });

  it('keeps /s/:id working when flag is on (direct share access)', async () => {
    const cache = createCache(':memory:');
    const id = cache.put({ url: 'https://example.com/x', title: 'X', markdown: '# Hidden but reachable', source: 'readability', client: 'browser' });
    const app = createApp({ cache, disablePublicHistory: true });
    const res = await request(app, '/s/' + id);
    assert.equal(res.status, 200);
    assert.ok(res.body.includes('# Hidden but reachable'));
  });

  it('keeps /api/storage public when flag is on (footer stats are aggregate-only)', async () => {
    const cache = createCache(':memory:');
    cache.put({ url: 'https://a.com', title: 'A', markdown: '# A', source: 'readability' });
    const app = createApp({ cache, disablePublicHistory: true });
    const res = await request(app, '/api/storage');
    assert.equal(res.status, 200);
    const data = JSON.parse(res.body);
    assert.equal(data.total, 1);
    assert.ok(typeof data.dbSizeBytes === 'number');
  });

  it('exposes the flag via /api/config', async () => {
    const off = await request(createApp({ disablePublicHistory: false }), '/api/config');
    const offBody = JSON.parse(off.body);
    assert.equal(offBody.disablePublicHistory, false);
    assert.equal(offBody.authMode, 'disabled');
    assert.equal(offBody.authMisconfigured, false);
    const on = await request(createApp({ disablePublicHistory: true }), '/api/config');
    const onBody = JSON.parse(on.body);
    assert.equal(onBody.disablePublicHistory, true);
    assert.equal(onBody.authMode, 'disabled');
    assert.equal(onBody.authMisconfigured, false);
  });

  it('reads DISABLE_PUBLIC_HISTORY=true from env when no override given', async () => {
    const prev = process.env.DISABLE_PUBLIC_HISTORY;
    process.env.DISABLE_PUBLIC_HISTORY = 'true';
    try {
      const app = createApp({ cache: createCache(':memory:') });
      const res = await request(app, '/api/history');
      assert.equal(res.status, 403);
    } finally {
      if (prev === undefined) delete process.env.DISABLE_PUBLIC_HISTORY;
      else process.env.DISABLE_PUBLIC_HISTORY = prev;
    }
  });

  it('treats DISABLE_PUBLIC_HISTORY=false / unset as disabled-off', async () => {
    const prev = process.env.DISABLE_PUBLIC_HISTORY;
    process.env.DISABLE_PUBLIC_HISTORY = 'false';
    try {
      const app = createApp({ cache: createCache(':memory:') });
      const res = await request(app, '/api/history');
      assert.equal(res.status, 200);
    } finally {
      if (prev === undefined) delete process.env.DISABLE_PUBLIC_HISTORY;
      else process.env.DISABLE_PUBLIC_HISTORY = prev;
    }
  });

  it('substitutes the disable-history flag into the rendered index html', async () => {
    const onApp = createApp({ disablePublicHistory: true });
    const onRes = await request(onApp, '/');
    assert.equal(onRes.status, 200);
    assert.ok(!onRes.body.includes('__PULLMD_DISABLE_HISTORY_FLAG__'), 'placeholder leaked');
    assert.ok(onRes.body.includes('window.__PULLMD_DISABLE_HISTORY__ = true'), 'expected flag=true in html');

    const offApp = createApp({ disablePublicHistory: false });
    const offRes = await request(offApp, '/');
    assert.ok(offRes.body.includes('window.__PULLMD_DISABLE_HISTORY__ = false'), 'expected flag=false in html');
  });
});

describe('GET /api/config - markitdown flag', () => {
  it('reports markitdown:false when MARKITDOWN_URL is unset', async () => {
    const prev = process.env.MARKITDOWN_URL;
    delete process.env.MARKITDOWN_URL;
    const app = createApp({});
    const res = await request(app, '/api/config');
    assert.equal(JSON.parse(res.body).markitdown, false);
    if (prev !== undefined) process.env.MARKITDOWN_URL = prev;
  });

  it('reports markitdown:true when MARKITDOWN_URL is set', async () => {
    const prev = process.env.MARKITDOWN_URL;
    process.env.MARKITDOWN_URL = 'http://markitdown:8003/convert';
    const app = createApp({});
    const res = await request(app, '/api/config');
    assert.equal(JSON.parse(res.body).markitdown, true);
    if (prev === undefined) delete process.env.MARKITDOWN_URL; else process.env.MARKITDOWN_URL = prev;
  });
});

describe('GET /api/config - vision and stt flags', () => {
  it('reports vision:true when PULLMD_VISION_API_KEY is set', async () => {
    const prev = process.env.PULLMD_VISION_API_KEY;
    process.env.PULLMD_VISION_API_KEY = 'test-key';
    delete process.env.PULLMD_LLM_API_KEY;
    const res = await request(createApp({}), '/api/config');
    assert.equal(JSON.parse(res.body).vision, true);
    if (prev === undefined) delete process.env.PULLMD_VISION_API_KEY; else process.env.PULLMD_VISION_API_KEY = prev;
  });

  it('reports stt:true when PULLMD_STT_API_KEY is set', async () => {
    const prev = process.env.PULLMD_STT_API_KEY;
    process.env.PULLMD_STT_API_KEY = 'test-key';
    delete process.env.PULLMD_LLM_API_KEY;
    const res = await request(createApp({}), '/api/config');
    assert.equal(JSON.parse(res.body).stt, true);
    if (prev === undefined) delete process.env.PULLMD_STT_API_KEY; else process.env.PULLMD_STT_API_KEY = prev;
  });

  it('reports vision:false and stt:false when no media keys are set', async () => {
    const prevV = process.env.PULLMD_VISION_API_KEY;
    const prevS = process.env.PULLMD_STT_API_KEY;
    const prevL = process.env.PULLMD_LLM_API_KEY;
    delete process.env.PULLMD_VISION_API_KEY;
    delete process.env.PULLMD_STT_API_KEY;
    delete process.env.PULLMD_LLM_API_KEY;
    const res = await request(createApp({}), '/api/config');
    const body = JSON.parse(res.body);
    assert.equal(body.vision, false);
    assert.equal(body.stt, false);
    assert.equal(body.markitdownMedia, undefined, 'markitdownMedia must not be present');
    if (prevV !== undefined) process.env.PULLMD_VISION_API_KEY = prevV;
    if (prevS !== undefined) process.env.PULLMD_STT_API_KEY = prevS;
    if (prevL !== undefined) process.env.PULLMD_LLM_API_KEY = prevL;
  });

  it('reports vision:true and stt:true when only PULLMD_LLM_API_KEY is set (shared key fallback)', async () => {
    const prevV = process.env.PULLMD_VISION_API_KEY;
    const prevS = process.env.PULLMD_STT_API_KEY;
    const prevL = process.env.PULLMD_LLM_API_KEY;
    delete process.env.PULLMD_VISION_API_KEY;
    delete process.env.PULLMD_STT_API_KEY;
    process.env.PULLMD_LLM_API_KEY = 'shared-key';
    const res = await request(createApp({}), '/api/config');
    const body = JSON.parse(res.body);
    assert.equal(body.vision, true);
    assert.equal(body.stt, true);
    if (prevV !== undefined) process.env.PULLMD_VISION_API_KEY = prevV; else delete process.env.PULLMD_VISION_API_KEY;
    if (prevS !== undefined) process.env.PULLMD_STT_API_KEY = prevS; else delete process.env.PULLMD_STT_API_KEY;
    if (prevL !== undefined) process.env.PULLMD_LLM_API_KEY = prevL; else delete process.env.PULLMD_LLM_API_KEY;
  });
});

describe('GET /api/config - markitdownYoutube flag', () => {
  it('reflects MARKITDOWN_YOUTUBE', async () => {
    const prev = process.env.MARKITDOWN_YOUTUBE; process.env.MARKITDOWN_YOUTUBE = 'true';
    const res = await request(createApp({}), '/api/config');
    assert.equal(JSON.parse(res.body).markitdownYoutube, true);
    if (prev === undefined) delete process.env.MARKITDOWN_YOUTUBE; else process.env.MARKITDOWN_YOUTUBE = prev;
  });
});

describe('GET /api/config - pdfOcr flag', () => {
  it('reports pdfOcr:true when PULLMD_PDF_OCR_API_KEY is set', async () => {
    const prevOcr = process.env.PULLMD_PDF_OCR_API_KEY;
    const prevLlm = process.env.PULLMD_LLM_API_KEY;
    process.env.PULLMD_PDF_OCR_API_KEY = 'test-ocr-key';
    delete process.env.PULLMD_LLM_API_KEY;
    const res = await request(createApp({}), '/api/config');
    assert.equal(JSON.parse(res.body).pdfOcr, true);
    if (prevOcr === undefined) delete process.env.PULLMD_PDF_OCR_API_KEY; else process.env.PULLMD_PDF_OCR_API_KEY = prevOcr;
    if (prevLlm !== undefined) process.env.PULLMD_LLM_API_KEY = prevLlm;
  });

  it('reports pdfOcr:false when neither PULLMD_PDF_OCR_API_KEY nor PULLMD_LLM_API_KEY is set', async () => {
    const prevOcr = process.env.PULLMD_PDF_OCR_API_KEY;
    const prevLlm = process.env.PULLMD_LLM_API_KEY;
    delete process.env.PULLMD_PDF_OCR_API_KEY;
    delete process.env.PULLMD_LLM_API_KEY;
    const res = await request(createApp({}), '/api/config');
    assert.equal(JSON.parse(res.body).pdfOcr, false);
    if (prevOcr !== undefined) process.env.PULLMD_PDF_OCR_API_KEY = prevOcr;
    if (prevLlm !== undefined) process.env.PULLMD_LLM_API_KEY = prevLlm;
  });

  it('pdfOcr does NOT use the shared LLM key (reports false when only PULLMD_LLM_API_KEY is set)', async () => {
    const prevOcr = process.env.PULLMD_PDF_OCR_API_KEY;
    const prevLlm = process.env.PULLMD_LLM_API_KEY;
    delete process.env.PULLMD_PDF_OCR_API_KEY;
    process.env.PULLMD_LLM_API_KEY = 'shared-key';
    const res = await request(createApp({}), '/api/config');
    assert.equal(JSON.parse(res.body).pdfOcr, false);
    if (prevOcr !== undefined) process.env.PULLMD_PDF_OCR_API_KEY = prevOcr; else delete process.env.PULLMD_PDF_OCR_API_KEY;
    if (prevLlm !== undefined) process.env.PULLMD_LLM_API_KEY = prevLlm; else delete process.env.PULLMD_LLM_API_KEY;
  });
});

describe('GET /api - pdf-ocr frontmatter', () => {
  it('emits pdf_pages and source:pdf-ocr in frontmatter for pdf-ocr source', async () => {
    const app = createApp({
      extractWeb: async () => ({
        markdown: '# doc.pdf\n\n| a | b |',
        title: 'doc.pdf',
        source: 'pdf-ocr',
        metadata: { quality: 0.6, sourceUrl: 'https://example.com/doc.pdf', pdfPages: 2, llmModel: 'mistral-ocr-latest' },
      }),
    });
    const res = await request(app, '/api?url=https://example.com/doc.pdf&pdf=ocr&frontmatter=true');
    assert.ok(res.body.startsWith('---\n'));
    assert.ok(res.body.includes('source: pdf-ocr'), 'expected source: pdf-ocr in frontmatter');
    assert.ok(res.body.includes('pdf_pages:'), 'expected pdf_pages in frontmatter');
    assert.ok(res.body.includes('llm_model:'), 'expected llm_model in frontmatter');
  });
});

describe('GET /api - ?pdf=ocr cache bypass', () => {
  it('?pdf=ocr bypasses the cache so OCR always runs', async () => {
    let calls = 0;
    const cache = createCache(':memory:');
    const app = createApp({
      extractWeb: async () => { calls++; return { markdown: '# Doc\n\npage', title: 'Doc', source: 'pdf-ocr', metadata: { quality: 0.6, pdfPages: 1, llmModel: 'mistral-ocr-latest' } }; },
      cache,
    });
    await request(app, '/api?url=https://example.com/doc.pdf');
    await request(app, '/api?url=https://example.com/doc.pdf&pdf=ocr');
    assert.equal(calls, 2, 'second call with pdf=ocr must skip the cache');
  });
});

describe('GET /api - YouTube format params', () => {
  it('forwards yt_timecodes/yt_chunk to extractWeb and bypasses cache', async () => {
    let opts;
    const cache = createCache(':memory:');
    const app = createApp({ cache, extractWeb: async (u, o) => { opts = o; return { markdown: '# V\n\nbody', title: 'V', source: 'youtube', metadata: { quality: 0.9, ytDuration: '12:34', ytViews: '1000' } }; } });
    await request(app, '/api?url=https://youtu.be/abc123&yt_timecodes=plain&yt_chunk=0');
    assert.equal(opts.ytTimecodes, 'plain');
    assert.equal(opts.ytChunk, 0);
  });

  it('merges duration/views into frontmatter for youtube source', async () => {
    const app = createApp({ extractWeb: async () => ({ markdown: '# V\n\nbody', title: 'V', source: 'youtube', metadata: { quality: 0.9, sourceUrl: 'https://www.youtube.com/watch?v=abc123', author: 'Chan', ytDuration: '12:34', ytViews: '1000' } }) });
    const res = await request(app, '/api?url=https://youtu.be/abc123&frontmatter=true');
    assert.ok(res.body.startsWith('---\n'));
    assert.ok(res.body.includes('source: youtube'));
    assert.ok(res.body.includes('duration: 12:34'));
    assert.ok(res.body.includes('views: 1000'));
  });
});

describe('GET /api - LLM usage + meta frontmatter', () => {
  it('emits llm token + model + image_size in frontmatter for media source', async () => {
    const app = createApp({ extractWeb: async () => ({ markdown: '# I\n\ncaption', title: 'I', source: 'markitdown', metadata: { quality: 0.8, sourceUrl: 'https://e/p.jpg', llmModel: 'gpt-4o-mini', llmTokens: 123, imageSize: '172x178' } }) });
    const res = await request(app, '/api?url=https://e/p.jpg&frontmatter=true');
    assert.ok(res.body.includes('llm_model: gpt-4o-mini'));
    assert.ok(res.body.includes('llm_tokens: 123'));
    assert.ok(res.body.includes('image_size: 172x178'));
  });
  it('emits audio_seconds for transcription results', async () => {
    const app = createApp({ extractWeb: async () => ({ markdown: '# A\n\nx', title: 'A', source: 'markitdown', metadata: { quality: 0.8, sourceUrl: 'https://e/a.mp3', llmModel: 'whisper-1', audioSeconds: 12.3 } }) });
    const res = await request(app, '/api?url=https://e/a.mp3&frontmatter=true');
    assert.ok(res.body.includes('audio_seconds: 12.3'));
    assert.ok(res.body.includes('llm_model: whisper-1'));
  });
  it('emits NO meta in the body or without frontmatter', async () => {
    const app = createApp({ extractWeb: async () => ({ markdown: '# I\n\ncaption', title: 'I', source: 'markitdown', metadata: { quality: 0.8, llmModel: 'gpt-4o-mini', llmTokens: 123 } }) });
    const res = await request(app, '/api?url=https://e/p.jpg');
    assert.ok(!res.body.includes('llm_model'), 'no meta without frontmatter');
    assert.ok(!res.body.includes('llm_tokens'));
  });
  it('emits image_size and llm_model in frontmatter for image-caption source via /api', async () => {
    const app = createApp({ extractWeb: async () => ({ markdown: '# pic.jpg\n\nA sunny scene.', title: 'pic.jpg', source: 'image-caption', metadata: { quality: 0.5, sourceUrl: 'https://e/pic.jpg', imageSize: '2x2', llmModel: 'gpt-4o-mini', llmTokens: 99 } }) });
    const res = await request(app, '/api?url=https://e/pic.jpg&frontmatter=true');
    assert.ok(res.body.startsWith('---\n'));
    assert.ok(res.body.includes('image_size: 2x2'), 'expected image_size in frontmatter');
    assert.ok(res.body.includes('llm_model: gpt-4o-mini'), 'expected llm_model in frontmatter');
  });
});
