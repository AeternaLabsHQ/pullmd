import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server.js';
import { createCache } from '../lib/cache.js';
import { loadRecipes } from '../lib/recipes.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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

function post(app, path, body, headers = {}) {
  return request(app, path, {
    method: 'POST',
    headers: { 'Content-Type': 'text/html', ...headers },
    body,
  });
}

const FAKE_RESULT = {
  markdown: '# Saved Page\n\nLots of useful content here.',
  title: 'Saved Page',
  source: 'readability',
  metadata: { title: 'Saved Page', sourceUrl: null, quality: 0.9, contentLength: 500 },
};

const LONG_PARAGRAPH = 'Main content paragraph that needs to be long enough for the Readability extraction to consider it substantial content worth keeping. This paragraph contains enough text to exceed the minimum threshold for content extraction, ensuring that the Readability algorithm identifies it as the main article body.';

describe('POST /api/html - happy paths', () => {
  it('returns markdown with X-Source/X-Quality headers', async () => {
    const app = createApp({ extractHtml: async () => FAKE_RESULT });
    const res = await post(app, '/api/html', '<html><body>x</body></html>');
    assert.equal(res.status, 200);
    assert.ok(res.headers['content-type'].includes('text/markdown'));
    assert.equal(res.headers['x-source'], 'readability');
    assert.equal(res.headers['x-quality'], '0.9');
    assert.ok(res.body.includes('# Saved Page'));
    assert.equal(res.headers['x-share-id'], undefined, 'local conversions never get a share id');
  });

  it('returns the JSON envelope with shareId null when format=json', async () => {
    const app = createApp({ extractHtml: async () => FAKE_RESULT });
    const res = await post(app, '/api/html?format=json', '<html><body>x</body></html>');
    assert.equal(res.status, 200);
    const json = JSON.parse(res.body);
    assert.ok(json.markdown.includes('# Saved Page'));
    assert.equal(json.source, 'readability');
    assert.equal(json.shareId, null);
    assert.equal(json.metadata.quality, 0.9);
  });

  it('strips markdown when format=text', async () => {
    const app = createApp({ extractHtml: async () => FAKE_RESULT });
    const res = await post(app, '/api/html?format=text', '<html><body>x</body></html>');
    assert.equal(res.status, 200);
    assert.ok(res.headers['content-type'].includes('text/plain'));
    assert.ok(!res.body.includes('# '));
  });

  it('forwards url, filename, extractor to extractHtml', async () => {
    let received;
    const app = createApp({
      extractHtml: async (html, opts) => { received = { html, ...opts }; return FAKE_RESULT; },
    });
    await post(app, '/api/html?url=https://example.com/a&filename=a.html&extractor=trafilatura', '<p>body</p>');
    assert.equal(received.html, '<p>body</p>');
    assert.equal(received.url, 'https://example.com/a');
    assert.equal(received.filename, 'a.html');
    assert.equal(received.extractor, 'trafilatura');
  });

  it('prepends frontmatter when frontmatter=true', async () => {
    const app = createApp({ extractHtml: async () => FAKE_RESULT });
    const res = await post(app, '/api/html?frontmatter=true', '<html><body>x</body></html>');
    assert.ok(res.body.startsWith('---\n'));
    assert.ok(res.body.includes('source: readability'));
  });

  it('converts real HTML end-to-end (no override)', async () => {
    const prev = process.env.PULLMD_SOURCE_HEADER; process.env.PULLMD_SOURCE_HEADER = 'true';
    const app = createApp({});
    const html = `<html><head><title>E2E</title></head><body><article><p>${LONG_PARAGRAPH}</p></article></body></html>`;
    const res = await post(app, '/api/html?filename=e2e.html', html);
    assert.equal(res.status, 200);
    assert.ok(res.body.includes('Main content paragraph'));
    assert.ok(res.body.includes('**e2e.html**'));
    if (prev === undefined) delete process.env.PULLMD_SOURCE_HEADER; else process.env.PULLMD_SOURCE_HEADER = prev;
  });

  it('prefers the X-Filename header (URI-encoded) over the query param', async () => {
    let received;
    const app = createApp({
      extractHtml: async (html, opts) => { received = opts; return FAKE_RESULT; },
    });
    await post(app, '/api/html?filename=query.html', '<p>x</p>', {
      'X-Filename': encodeURIComponent('über alles.html'),
    });
    assert.equal(received.filename, 'über alles.html');
  });
});

describe('POST /api/html - errors', () => {
  it('400 when the body is empty', async () => {
    const app = createApp({ extractHtml: async () => FAKE_RESULT });
    const res = await post(app, '/api/html', '');
    assert.equal(res.status, 400);
    assert.ok(JSON.parse(res.body).error.includes('text/html'));
  });

  it('400 when the Content-Type is not text/html', async () => {
    const app = createApp({ extractHtml: async () => FAKE_RESULT });
    const res = await post(app, '/api/html', '{"html":"x"}', { 'Content-Type': 'application/json' });
    assert.equal(res.status, 400);
  });

  it('400 when the url param is not a valid URL', async () => {
    const app = createApp({ extractHtml: async () => FAKE_RESULT });
    const res = await post(app, '/api/html?url=not-a-url', '<p>x</p>');
    assert.equal(res.status, 400);
  });

  it('422 when extraction finds almost nothing (SPA shell)', async () => {
    const app = createApp({
      extractHtml: async () => ({
        markdown: '# Stub\n\n', title: 'Stub', source: 'readability-fallback',
        metadata: { contentLength: 12, quality: 0, sourceUrl: null },
      }),
    });
    const res = await post(app, '/api/html', '<html><body><div id="root"></div></body></html>');
    assert.equal(res.status, 422);
    assert.ok(JSON.parse(res.body).error.includes('Original-URL'));
  });

  it('500 with error message when extraction throws', async () => {
    const app = createApp({ extractHtml: async () => { throw new Error('boom'); } });
    const res = await post(app, '/api/html', '<p>x</p>');
    assert.equal(res.status, 500);
    assert.ok(JSON.parse(res.body).error.includes('boom'));
  });
});

describe('POST /api/html - over-nested markup (real extractHtml path)', () => {
  it('answers 422 document_too_complex quickly', async () => {
    const app = createApp({});
    const t0 = Date.now();
    const res = await post(app, '/api/html', '<html><body>' + '<div>'.repeat(100_000) + 'x</body></html>');
    assert.ok(Date.now() - t0 < 2000, `took ${Date.now() - t0} ms`);
    assert.equal(res.status, 422, res.body);
    const j = JSON.parse(res.body);
    assert.equal(j.code, 'document_too_complex');
    assert.equal(j.error, 'Document is nested too deeply or has too many elements');
  });

  it('also guards uploads with inlined data: images', async () => {
    const app = createApp({});
    const t0 = Date.now();
    const res = await post(app, '/api/html', '<img src="data:image/png;base64,AA">' + '<div>'.repeat(100_000));
    assert.ok(Date.now() - t0 < 2000, `took ${Date.now() - t0} ms`);
    assert.equal(res.status, 422, res.body);
    assert.equal(JSON.parse(res.body).code, 'document_too_complex');
  });
});

describe('POST /api/html - raw-text contexts in foreign content', () => {
  for (const prefix of ['<svg><title>', '<svg><style>', '<svg><script>', '<math><mtext><textarea>']) {
    it(`${prefix} + 10k <div> answers fast and never 500`, async () => {
      const app = createApp({});
      const t0 = Date.now();
      const res = await post(app, '/api/html?extractor=readability', prefix + '<div>'.repeat(10_000));
      assert.ok(Date.now() - t0 < 5000, `took ${Date.now() - t0} ms`);
      assert.ok([200, 422].includes(res.status), `${res.status} ${res.body.slice(0, 200)}`);
    });
  }
});

describe('POST /api/html - escaped markup inside unencoded elements', () => {
  it('a guaranteed 422 carries error and code only', async () => {
    const app = createApp({});
    const res = await post(app, '/api/html', '<div>'.repeat(300));
    assert.equal(res.status, 422, res.body);
    const body = JSON.parse(res.body);
    assert.equal(body.code, 'document_too_complex');
    assert.equal('limit' in body, false, 'the exceeded budget stays internal');
  });

  for (const tag of ['noscript', 'iframe', 'noembed', 'noframes', 'plaintext']) {
    it(`<${tag}> + 20k escaped <div> answers fast and never 500`, async () => {
      const app = createApp({});
      const t0 = Date.now();
      const close = tag === 'plaintext' ? '' : `</${tag}>`;
      const res = await post(app, '/api/html?extractor=readability', `<p>x</p><${tag}>` + '&lt;div&gt;'.repeat(20_000) + close);
      assert.ok(Date.now() - t0 < 5000, `took ${Date.now() - t0} ms`);
      assert.ok([200, 422].includes(res.status), `${res.status} ${res.body.slice(0, 200)}`);
      if (res.status === 422) assert.equal('limit' in JSON.parse(res.body), false, 'the exceeded budget stays internal');
    });
  }
});

describe('POST /api/html - escaped markup in <head><title> with a url', () => {
  it('answers fast and never 500', async () => {
    const app = createApp({});
    const html = '<html><head><title>T&lt;/title&gt;' + '&lt;div&gt;'.repeat(20_000) + '</title></head><body><p>x</p></body></html>';
    const t0 = Date.now();
    const res = await post(app, `/api/html?extractor=readability&url=${encodeURIComponent('https://example.org/a')}`, html);
    assert.ok(Date.now() - t0 < 5000, `took ${Date.now() - t0} ms`);
    assert.ok([200, 422].includes(res.status), `${res.status} ${res.body.slice(0, 200)}`);
  });
});

describe('POST /api/html - size limit', () => {
  it('413 with a friendly bilingual JSON error for bodies over 10 MB', async () => {
    const app = createApp({ extractHtml: async () => FAKE_RESULT });
    const big = '<p>' + 'x'.repeat(11 * 1024 * 1024) + '</p>';
    const res = await post(app, '/api/html', big);
    assert.equal(res.status, 413);
    const json = JSON.parse(res.body);
    assert.ok(json.error.includes('10 MB'));
  });

  it('413 generic message (no misleading 10 MB) for oversized /mcp JSON bodies', async () => {
    const app = createApp({ extractHtml: async () => FAKE_RESULT });
    const big = JSON.stringify({ jsonrpc: '2.0', method: 'x', params: { blob: 'y'.repeat(2 * 1024 * 1024) } });
    const res = await request(app, '/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: big,
    });
    assert.equal(res.status, 413);
    const json = JSON.parse(res.body);
    assert.ok(!json.error.includes('10 MB'), 'must not claim a 10 MB limit on /mcp');
    assert.ok(json.error.includes('too large'));
  });
});

describe('POST /api/html - recipe frontmatter (real extractHtml path, no override)', () => {
  it('injects a recipe-defined frontmatter field extracted from JSON-LD in uploaded HTML', async () => {
    const tmpFile = path.join(os.tmpdir(), `recipes-api-html-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
    fs.writeFileSync(tmpFile, JSON.stringify([{
      name: 'html-upload-fm', host: 'example.com',
      frontmatter: {
        jsonld: { type: 'Article' },
        fields: { rating: { jsonld: 'aggregateRating.ratingValue' } },
      },
    }]));
    loadRecipes({ defaultPath: tmpFile, userPath: null });
    try {
      const app = createApp({});
      const html = `<html><head><title>Uploaded</title>
        <script type="application/ld+json">${JSON.stringify({
          '@type': 'Article', aggregateRating: { ratingValue: '4.8' },
        })}</script>
        </head><body><article><h1>Uploaded</h1><p>${LONG_PARAGRAPH}</p></article></body></html>`;
      const res = await post(app, '/api/html?url=https://example.com/upload&frontmatter=true', html);
      assert.equal(res.status, 200, res.body);
      assert.match(res.body, /rating: '?4\.8'?/);
    } finally {
      fs.unlinkSync(tmpFile);
      loadRecipes({}); // restore module recipe state for any later test in this file
    }
  });
});

describe('POST /api/html - privacy', () => {
  it('never writes a cache entry: history stays empty, log uses placeholder', async () => {
    const cache = createCache(':memory:');
    const app = createApp({ cache, extractHtml: async () => FAKE_RESULT });
    const res = await post(app, '/api/html?filename=secret-bank-statement.html', '<p>x</p>');
    assert.equal(res.status, 200);

    const history = await request(app, '/api/history');
    assert.deepEqual(JSON.parse(history.body), [], 'history must stay empty');

    const logged = cache.db.prepare('SELECT url, domain FROM extraction_log').all();
    assert.equal(logged.length, 1);
    assert.equal(logged[0].url, 'local-file', 'telemetry must use the constant placeholder');
    assert.ok(!JSON.stringify(logged).includes('secret-bank-statement'));
  });
});
