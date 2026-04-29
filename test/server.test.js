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
});
