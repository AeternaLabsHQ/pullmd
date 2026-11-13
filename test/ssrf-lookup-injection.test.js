// An injected DNS lookup must reach the SSRF guard on every entry point.
// Each test resolves a hostname to a private address through the injected
// lookup only; if a path still used the system resolver the name would not
// resolve to that address and the assertion on the "blocked address" verdict
// would fail.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server.js';
import { createCache } from '../lib/cache.js';
import { extractWeb } from '../lib/web.js';
import { renderViaSidecar } from '../lib/playwright-client.js';
import { resolveRedditUrl, extractPost } from '../lib/reddit.js';
import { SsrfError } from '../lib/ssrf.js';
import { createFakeLookup } from './helpers/fake-dns.js';

const lookup = createFakeLookup({
  'intranet.test': '10.0.0.5',
  'redd.it': '10.0.0.6',
});

const BLOCKED = /blocked address 10\.0\.0\.\d for host (intranet\.test|redd\.it)/;

async function get(app, path, init) {
  const server = app.listen(0);
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}${path}`, init);
    return { status: res.status, body: await res.text() };
  } finally {
    server.close();
  }
}

function spyApp(extra = {}) {
  const calls = { web: [], reddit: [] };
  const app = createApp({
    cache: null,
    lookup,
    extractWeb: async (url, opts) => { calls.web.push({ url, opts }); return { markdown: '# x', title: 'x', source: 'readability', metadata: {} }; },
    extractPost: async (url, opts) => { calls.reddit.push({ url, opts }); return '# x'; },
    ...extra,
  });
  return { app, calls };
}

describe('injected lookup reaches the SSRF guard', () => {
  it('createApp: GET /api', async () => {
    const { app, calls } = spyApp();
    const res = await get(app, '/api?url=' + encodeURIComponent('http://intranet.test/'));
    assert.equal(res.status, 403);
    assert.match(res.body, BLOCKED);
    assert.equal(calls.web.length, 0);
  });

  it('createApp: GET /api/stream', async () => {
    const { app, calls } = spyApp();
    const res = await get(app, '/api/stream?url=' + encodeURIComponent('http://intranet.test/'));
    assert.match(res.body, /event: error/);
    assert.match(res.body, BLOCKED);
    assert.equal(calls.web.length, 0);
  });

  it('createApp: MCP read_url', async () => {
    const { app, calls } = spyApp();
    const res = await get(app, '/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'read_url', arguments: { url: 'http://intranet.test/' } } }),
    });
    const j = JSON.parse(res.body.match(/^data: (.+)$/m)[1]);
    assert.equal(j.result.isError, true);
    assert.match(j.result.content[0].text, BLOCKED);
    assert.equal(calls.web.length, 0);
  });

  it('createApp hands the lookup to the extractors and to share refresh', async () => {
    const cache = createCache(':memory:');
    const { app, calls } = spyApp({ cache });
    await get(app, '/api?nocache=1&url=' + encodeURIComponent('https://public.test/a'));
    await get(app, '/api?url=' + encodeURIComponent('https://www.reddit.com/r/x/comments/abc123/t/'));
    const shareId = cache.put({ url: 'https://public.test/b', title: 'b', markdown: '# b', source: 'readability' });
    cache.db.prepare("UPDATE conversions SET created_at = datetime('now', '-2 hours') WHERE url = ?").run('https://public.test/b');
    await get(app, `/s/${shareId}`);
    assert.equal(calls.web.length, 2);
    for (const c of calls.web) assert.equal(c.opts.lookup, lookup);
    assert.equal(calls.reddit.length, 1);
    assert.equal(calls.reddit[0].opts.ssrfOpts.lookup, lookup);
  });

  it('extractWeb: first hop and redirect hop', async () => {
    let calls = 0;
    const fetch = async () => { calls++; return new Response(null, { status: 302, headers: { location: 'http://intranet.test/' } }); };
    await assert.rejects(extractWeb('http://intranet.test/', { fetch, lookup }), (err) => err instanceof SsrfError && BLOCKED.test(err.message));
    assert.equal(calls, 0);
    await assert.rejects(extractWeb('https://public.test/', { fetch, lookup }), (err) => err instanceof SsrfError && BLOCKED.test(err.message));
    assert.equal(calls, 1);
  });

  it('renderViaSidecar', async () => {
    const prev = process.env.PLAYWRIGHT_URL;
    process.env.PLAYWRIGHT_URL = 'http://sidecar.test/render';
    let calls = 0;
    try {
      await assert.rejects(
        renderViaSidecar('http://intranet.test/', { fetch: async () => { calls++; return new Response('<html></html>'); }, lookup }),
        (err) => err instanceof SsrfError && BLOCKED.test(err.message),
      );
      assert.equal(calls, 0);
    } finally {
      if (prev === undefined) delete process.env.PLAYWRIGHT_URL;
      else process.env.PLAYWRIGHT_URL = prev;
    }
  });

  it('resolveRedditUrl and extractPost: short-link resolution', async () => {
    await assert.rejects(resolveRedditUrl('https://redd.it/abc123', { lookup }), (err) => err instanceof SsrfError && BLOCKED.test(err.message));
    await assert.rejects(extractPost('https://redd.it/abc123', { ssrfOpts: { lookup } }), (err) => err instanceof SsrfError && BLOCKED.test(err.message));
  });
});
