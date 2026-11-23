import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server.js';
import { createCache } from '../lib/cache.js';
import { createLlmBudget } from '../lib/llm/budget.js';
import { refreshShareEntry } from '../lib/share-refresh.js';

// A stale share row is refreshed through the extractor of its source, the
// same way from MCP get_share and from GET /s/:id. A Hacker News row must go
// through the HN extractor, not the web pipeline: the web path drops the
// comments and stores the row as source web.

const HN = 'https://news.ycombinator.com/item?id=12345';
const OLD_MD = '# Old HN\n\nOld story.\n\n## Comments\n\nold comment';
const NEW_MD = '# New HN\n\nNew story.\n\n## Comments\n\nnew comment';

async function request(app, path, opts = {}) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const port = server.address().port;
      fetch(`http://localhost:${port}${path}`, opts)
        .then(async (res) => {
          const text = await res.text();
          server.close();
          resolve({ status: res.status, body: text });
        })
        .catch((err) => { server.close(); reject(err); });
    });
  });
}

function parseSse(text) {
  const m = text.match(/^data: (.+)$/m);
  return m ? JSON.parse(m[1]) : null;
}

const MCP_HEADERS = { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream' };

async function callTool(app, name, args) {
  const res = await request(app, '/mcp', {
    method: 'POST',
    headers: MCP_HEADERS,
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  return parseSse(res.body);
}

function makeApp() {
  const cache = createCache(':memory:');
  const hnCalls = [];
  const webCalls = [];
  const extractHn = async (url, opts) => {
    hnCalls.push({ url, opts });
    return { markdown: NEW_MD, meta: { points: 42 } };
  };
  const extractWeb = async (url, opts) => {
    webCalls.push({ url, opts });
    return { title: 'Web', markdown: '# Web\n\nFlattened.', source: 'web', metadata: {} };
  };
  const llmBudget = createLlmBudget({ isConfigured: () => false });
  const app = createApp({ cache, extractHn, extractWeb, llmBudget });
  return { app, cache, hnCalls, webCalls };
}

function staleHn(cache) {
  const shareId = cache.put({ url: HN, title: 'Old HN', markdown: OLD_MD, source: 'hackernews' }).shareId;
  cache.db.prepare("UPDATE conversions SET created_at = datetime('now', '-2 hours') WHERE url = ?").run(HN);
  return shareId;
}

function assertRefreshedThroughHn({ cache, hnCalls, webCalls }) {
  assert.equal(webCalls.length, 0, 'the web pipeline must not handle a Hacker News row');
  assert.equal(hnCalls.length, 1);
  assert.equal(hnCalls[0].url, HN);
  assert.equal(hnCalls[0].opts.comments, true);
  assert.equal(hnCalls[0].opts.commentDepth, 3);
  assert.equal(hnCalls[0].opts.lang, 'en');
  const row = cache.db.prepare('SELECT markdown, source, title FROM conversions WHERE url = ?').get(HN);
  assert.equal(row.source, 'hackernews');
  assert.equal(row.markdown, NEW_MD);
  assert.equal(row.title, 'New HN');
}

describe('share refresh - Hacker News rows', () => {
  it('MCP get_share refreshes a stale HN share through the HN extractor', async () => {
    const ctx = makeApp();
    const shareId = staleHn(ctx.cache);
    const j = await callTool(ctx.app, 'get_share', { id: shareId });
    const text = j.result.content[0].text;
    assert.match(text, /new comment/);
    assert.match(text, /^source: hackernews$/m);
    assert.match(text, /^refreshed: true$/m);
    assertRefreshedThroughHn(ctx);
  });

  it('GET /s/:id refreshes a stale HN share through the HN extractor', async () => {
    const ctx = makeApp();
    const shareId = staleHn(ctx.cache);
    const res = await request(ctx.app, `/s/${shareId}`);
    assert.equal(res.status, 200);
    assert.match(res.body, /new comment/);
    assertRefreshedThroughHn(ctx);
  });
});

// Rows that cannot be re-created from their URL are snapshots: an OCR
// conversion must not be re-extracted without OCR, and a row without a URL
// has nothing to extract from.
describe('share refresh - snapshot rows', () => {
  const OCR_URL = 'https://example.com/scan.pdf';
  const OCR_MD = '# Scan\n\nText recognised by OCR.';

  function staleOcr(cache) {
    const shareId = cache.put({ url: OCR_URL, title: 'Scan', markdown: OCR_MD, source: 'pdf-ocr' }).shareId;
    cache.db.prepare("UPDATE conversions SET created_at = datetime('now', '-2 hours') WHERE url = ?").run(OCR_URL);
    return shareId;
  }

  it('GET /s/:id serves a stale pdf-ocr row unchanged without extracting', async () => {
    const ctx = makeApp();
    const shareId = staleOcr(ctx.cache);
    const res = await request(ctx.app, `/s/${shareId}`);
    assert.equal(res.status, 200);
    assert.match(res.body, /Text recognised by OCR/);
    assert.equal(ctx.webCalls.length, 0);
    assert.equal(ctx.hnCalls.length, 0);
    const row = ctx.cache.db.prepare('SELECT markdown, source FROM conversions WHERE url = ?').get(OCR_URL);
    assert.equal(row.source, 'pdf-ocr');
    assert.equal(row.markdown, OCR_MD);
  });

  it('MCP get_share serves a stale pdf-ocr row unchanged without extracting', async () => {
    const ctx = makeApp();
    const shareId = staleOcr(ctx.cache);
    const j = await callTool(ctx.app, 'get_share', { id: shareId });
    const text = j.result.content[0].text;
    assert.match(text, /Text recognised by OCR/);
    assert.match(text, /^source: pdf-ocr$/m);
    assert.match(text, /^refreshed: false$/m);
    assert.equal(ctx.webCalls.length, 0);
  });

  function deps(calls) {
    const fail = (name) => async () => { calls.push(name); throw new Error(`${name} must not be called`); };
    return {
      cache: { put() { calls.push('put'); }, touch() { calls.push('touch'); } },
      extract: fail('extract'),
      extractHn: fail('extractHn'),
      extractWeb: fail('extractWeb'),
      isRedditUrl: () => false,
      isHnUrl: () => false,
      client: 'api',
    };
  }

  it('returns the snapshot for source pdf-ocr', async () => {
    const calls = [];
    const entry = { url: OCR_URL, markdown: OCR_MD, source: 'pdf-ocr', title: 'Scan' };
    const r = await refreshShareEntry(entry, deps(calls));
    assert.deepEqual(r, { markdown: OCR_MD, source: 'pdf-ocr', refreshed: false });
    assert.deepEqual(calls, []);
  });

  it('returns the snapshot for a row without url', async () => {
    const calls = [];
    const entry = { url: null, markdown: '# Upload\n\nBody.', source: 'upload', title: 'Upload' };
    const r = await refreshShareEntry(entry, deps(calls));
    assert.deepEqual(r, { markdown: '# Upload\n\nBody.', source: 'upload', refreshed: false });
    assert.deepEqual(calls, []);
  });
});
