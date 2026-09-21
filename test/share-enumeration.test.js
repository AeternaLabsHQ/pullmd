import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createApp } from '../server.js';
import { createCache } from '../lib/cache.js';
import { createRateLimiter } from '../lib/oauth/rate-limit.js';

async function withServer(app, fn) {
  const server = createServer(app);
  await new Promise((r) => server.listen(0, r));
  const { port } = server.address();
  try {
    return await fn(async (path, headers = {}) => {
      const res = await fetch(`http://127.0.0.1:${port}${path}`, { headers });
      return { status: res.status, body: await res.text(), headers: res.headers };
    });
  } finally {
    server.close();
  }
}

describe('/s/:id enumeration guard (#58)', () => {
  it('throttles unknown-id lookups per IP and never a valid link', async () => {
    const cache = createCache(':memory:');
    const id = cache.put({ url: 'https://ok.example', title: 'Ok', markdown: '# Ok', source: 'readability' });
    const app = createApp({ cache, shareMissLimiter: createRateLimiter({ windowMs: 60_000, max: 3 }) });
    await withServer(app, async (get) => {
      for (let i = 0; i < 3; i++) {
        assert.equal((await get(`/s/${'0'.repeat(31)}${i}`)).status, 404);
      }
      const blocked = await get('/s/deadbeefdeadbeefdeadbeefdeadbeef');
      assert.equal(blocked.status, 429);
      assert.ok(Number(blocked.headers.get('retry-after')) >= 1);
      // Valid links are looked up before the limiter and stay served.
      const ok = await get(`/s/${id}`);
      assert.equal(ok.status, 200);
      assert.equal(ok.body, '# Ok');
      // Another client is not affected.
      assert.equal((await get('/s/deadbeefdeadbeefdeadbeefdeadbeef', { 'x-forwarded-for': '203.0.113.9' })).status, 404);
    });
  });
});

describe('/api/stream SSRF guard ordering (#58)', () => {
  it('rejects a blocked URL before consulting the cache', async () => {
    const cache = createCache(':memory:');
    cache.put({ url: 'http://10.0.0.5/secret', title: 'Cached', markdown: '# leaked', source: 'readability' });
    const app = createApp({ cache, extractWeb: async () => { throw new Error('must not fetch'); } });
    await withServer(app, async (get) => {
      const res = await get('/api/stream?url=' + encodeURIComponent('http://10.0.0.5/secret'));
      assert.equal(res.status, 200); // SSE headers were already flushed
      assert.match(res.body, /event: error/);
      assert.match(res.body, /URL not allowed/);
      assert.doesNotMatch(res.body, /leaked/);
    });
  });
});
