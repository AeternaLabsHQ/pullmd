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

function postFile(app, path, body, headers = {}) {
  return request(app, path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/pdf', ...headers },
    body,
  });
}

const FAKE = {
  markdown: '# Report\n\n**report.pdf** · 2026-06-08\n\nConverted body.',
  title: 'Report', source: 'markitdown',
  metadata: { title: 'Report', sourceUrl: null, quality: 0.8, contentLength: 400 },
};

describe('POST /api/file - happy paths', () => {
  it('returns markdown with X-Source header, no share id', async () => {
    const app = createApp({ extractFile: async () => FAKE });
    const res = await postFile(app, '/api/file', Buffer.from('%PDF-1.4'));
    assert.equal(res.status, 200);
    assert.ok(res.headers['content-type'].includes('text/markdown'));
    assert.equal(res.headers['x-source'], 'markitdown');
    assert.equal(res.headers['x-share-id'], undefined);
    assert.ok(res.body.includes('# Report'));
  });

  it('forwards filename (X-Filename header) and content-type to extractFile', async () => {
    let received;
    const app = createApp({ extractFile: async (buf, opts) => { received = { len: buf.length, ...opts }; return FAKE; } });
    await postFile(app, '/api/file', Buffer.from('%PDF'), { 'X-Filename': encodeURIComponent('über.pdf') });
    assert.equal(received.filename, 'über.pdf');
    assert.equal(received.contentType, 'application/pdf');
    assert.ok(received.len > 0);
  });

  it('returns the JSON envelope when format=json', async () => {
    const app = createApp({ extractFile: async () => FAKE });
    const res = await postFile(app, '/api/file?format=json', Buffer.from('%PDF'));
    const json = JSON.parse(res.body);
    assert.equal(json.source, 'markitdown');
    assert.equal(json.shareId, null);
  });
});

describe('POST /api/file - errors', () => {
  it('400 when the body is empty', async () => {
    const app = createApp({ extractFile: async () => FAKE });
    const res = await postFile(app, '/api/file', Buffer.alloc(0));
    assert.equal(res.status, 400);
  });

  it('502 when conversion throws', async () => {
    const app = createApp({ extractFile: async () => { throw new Error('sidecar down'); } });
    const res = await postFile(app, '/api/file', Buffer.from('%PDF'));
    assert.equal(res.status, 502);
    assert.ok(JSON.parse(res.body).error.includes('sidecar down'));
  });
});

describe('POST /api/file - privacy', () => {
  it('never writes a cache entry; telemetry uses the placeholder', async () => {
    const cache = createCache(':memory:');
    const app = createApp({ cache, extractFile: async () => FAKE });
    const res = await postFile(app, '/api/file?filename=secret.pdf', Buffer.from('%PDF'), { 'X-Filename': encodeURIComponent('secret-tax.pdf') });
    assert.equal(res.status, 200);
    const history = await request(app, '/api/history');
    assert.deepEqual(JSON.parse(history.body), []);
    const logged = cache.db.prepare('SELECT url FROM extraction_log').all();
    assert.equal(logged[0].url, 'local-file');
    assert.ok(!JSON.stringify(logged).includes('secret-tax'));
  });
});
