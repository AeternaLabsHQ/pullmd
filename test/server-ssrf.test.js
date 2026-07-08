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
