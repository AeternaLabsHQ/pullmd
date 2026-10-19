import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server.js';

// Minimal app with no cache and a fetch that must never be called for blocked URLs.
function makeApp() {
  return createApp({
    cache: null,
    extractWeb: async () => ({ markdown: 'should not reach', title: 't', source: 'web', metadata: {} }),
  });
}

async function get(app, path) {
  const { createServer } = await import('node:http');
  const server = createServer(app);
  await new Promise((r) => server.listen(0, r));
  const { port } = server.address();
  try {
    const res = await fetch(`http://127.0.0.1:${port}${path}`);
    const body = await res.text();
    return { status: res.status, body };
  } finally {
    server.close();
  }
}

test('GET /api with a metadata URL returns 403', async () => {
  const app = makeApp();
  const res = await get(app, '/api?url=' + encodeURIComponent('http://100.100.100.200/latest/user-data'));
  assert.equal(res.status, 403);
});

test('GET /api with a private-IP URL returns 403', async () => {
  const app = makeApp();
  const res = await get(app, '/api?url=' + encodeURIComponent('http://10.0.0.5/'));
  assert.equal(res.status, 403);
});

test('GET /api with a public URL is not rejected as SSRF', async () => {
  const app = makeApp();
  const res = await get(app, '/api?url=' + encodeURIComponent('https://example.com/'));
  assert.notEqual(res.status, 403);
});

// GHSA-26wr-prg5-vr77: a block that only shows up below the up-front check
// (redirect hop, render-time navigation) must still be a 403 and never 502.
test('GET /api answers 403 when the extraction hits the guard on a later hop', async () => {
  const { SsrfError } = await import('../lib/ssrf.js');
  const app = createApp({
    cache: null,
    extractWeb: async () => { throw new SsrfError('blocked address 172.20.0.4 for host internal-secret (via http://internal-secret:9000/)'); },
  });
  const res = await get(app, '/api?url=' + encodeURIComponent('https://example.com/refresh-inward') + '&render=force');
  assert.equal(res.status, 403);
  assert.match(res.body, /URL not allowed: blocked address 172\.20\.0\.4/);
});

test('GET /api/stream reports a later-hop block as an error event with the URL-not-allowed wording', async () => {
  const { SsrfError } = await import('../lib/ssrf.js');
  const app = createApp({
    cache: null,
    extractWeb: async () => { throw new SsrfError('blocked address 172.20.0.4 for host internal-secret'); },
  });
  const res = await get(app, '/api/stream?url=' + encodeURIComponent('https://example.com/refresh-inward') + '&render=force');
  assert.match(res.body, /event: error/);
  assert.match(res.body, /URL not allowed: blocked address 172\.20\.0\.4/);
});
