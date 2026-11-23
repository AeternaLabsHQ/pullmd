import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createApp } from './helpers/fake-dns.js';
import { createCache } from '../lib/cache.js';
import { createImageStore } from '../lib/image-store.js';
import { createLlmBudget } from '../lib/llm/budget.js';

// MCP wiring for hosted PDF-OCR figures: the `pdf_images` param of read_url
// and the get_image tool. Mirrors test/api-pdf-images.test.js for /api.

const PDF = 'https://example.com/paper.pdf';
const ID = 'ab'.repeat(16);
const IMG_BASE = 'https://md.example.org';
const BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
const DATA_URI = `data:image/jpeg;base64,${BYTES.toString('base64')}`;

async function request(app, p, opts = {}) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const port = server.address().port;
      fetch(`http://localhost:${port}${p}`, opts)
        .then(async (res) => {
          const text = await res.text();
          server.close();
          resolve({ status: res.status, body: text });
        })
        .catch((err) => { server.close(); reject(err); });
    });
  });
}

const MCP_HEADERS = { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream' };

async function rpc(app, method, params, id = 1) {
  const res = await request(app, '/mcp', {
    method: 'POST',
    headers: MCP_HEADERS,
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  });
  const m = res.body.match(/^data: (.+)$/m);
  return m ? JSON.parse(m[1]) : null;
}

const callTool = (app, name, args) => rpc(app, 'tools/call', { name, arguments: args });

// Like rpc, but with a chosen Host header (fetch does not let a test set it).
async function rpcWithHost(app, host, method, params) {
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  try {
    const payload = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
    const body = await new Promise((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1', port: server.address().port, path: '/mcp', method: 'POST',
        headers: { ...MCP_HEADERS, Host: host, 'Content-Length': Buffer.byteLength(payload) },
      }, (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { text += c; });
        res.on('end', () => resolve(text));
      });
      req.on('error', reject);
      req.end(payload);
    });
    const m = body.match(/^data: (.+)$/m);
    return m ? JSON.parse(m[1]) : null;
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}
const textOf = (j) => j.result.content[0].text;

/** extractWeb double that records its options and hosts one figure on request. */
function ocrStub({ host = false } = {}) {
  const calls = [];
  const fn = async (url, opts) => {
    calls.push(opts);
    const result = { title: 'Paper', source: 'pdf-ocr', metadata: {}, markdown: '# Paper\n\nBody.' };
    if (!opts.hostImages) return result;
    const urls = await opts.hostImages([{ id: 'img-0.jpeg', dataUri: DATA_URI }]);
    return {
      ...result,
      markdown: `# Paper\n\n![Figure 1](${urls.get('img-0.jpeg')})`,
      ocrFallbackMarkdown: '# Paper\n\n*Figure 1: a chart*',
    };
  };
  return { fn, calls };
}

describe('MCP pdf_images and get_image', () => {
  let root;
  let store;
  let cache;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'pullmd-mcpimg-'));
    store = createImageStore(root);
    cache = createCache(':memory:', { retentionDays: 90 });
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  const makeApp = (stub, extra = {}) => createApp({
    cache,
    imageStore: store,
    imagePublicUrl: IMG_BASE,
    extractWeb: stub.fn,
    llmBudget: createLlmBudget({ isConfigured: () => false }),
    ...extra,
  });

  // Files in the store (its shard directories stay behind when emptied).
  const storedFiles = () => fs.readdirSync(root).flatMap((d) => fs.readdirSync(path.join(root, d)));

  const seedImage = () => {
    store.write(ID, 'image/jpeg', BYTES);
    cache.put({ url: null, title: 'a.pdf', markdown: '# a', source: 'pdf-ocr', assets: [{ id: ID, mime: 'image/jpeg', size: BYTES.length }] });
  };

  describe('read_url pdf_images', () => {
    it('is in the tool schema with its description', async () => {
      const j = await rpc(makeApp(ocrStub()), 'tools/list', {});
      const prop = j.result.tools.find((t) => t.name === 'read_url').inputSchema.properties.pdf_images;
      assert.deepEqual(prop.enum, ['strip', 'caption', 'hosted']);
      assert.equal(
        prop.description,
        'With pdf_ocr: what to do with figures. "caption" replaces each figure by a short description, "hosted" also keeps the image (fetch it with get_image). Default "strip".',
      );
    });

    it('rejects an unknown value at the schema', async () => {
      const stub = ocrStub();
      const j = await callTool(makeApp(stub), 'read_url', { url: PDF, pdf_ocr: true, pdf_images: 'all' });
      assert.ok(j.error || j.result?.isError);
      assert.equal(stub.calls.length, 0);
    });

    for (const [arg, want, hostsImages] of [[undefined, 'strip', false], ['strip', 'strip', false], ['caption', 'caption', false], ['hosted', 'hosted', true]]) {
      it(`${arg ?? 'no value'} reaches extractWeb as pdfImages ${want}`, async () => {
        const stub = ocrStub();
        const j = await callTool(makeApp(stub), 'read_url', { url: PDF, pdf_ocr: true, ...(arg && { pdf_images: arg }) });
        assert.ok(!j.result.isError);
        assert.equal(stub.calls.length, 1);
        assert.equal(stub.calls[0].pdfOcr, true);
        assert.equal(stub.calls[0].pdfImages, want);
        assert.equal(typeof stub.calls[0].hostImages === 'function', hostsImages);
      });
    }

    it('hosted degrades to caption without PUBLIC_URL; get_image still serves stored figures', async () => {
      seedImage();
      const stub = ocrStub();
      const app = makeApp(stub, { imagePublicUrl: '' });
      const j = await callTool(app, 'read_url', { url: PDF, pdf_ocr: true, pdf_images: 'hosted' });
      assert.ok(!j.result.isError);
      assert.equal(stub.calls[0].pdfImages, 'caption');
      assert.equal(stub.calls[0].hostImages, undefined);
      assert.doesNotMatch(textOf(j), /\/img\//);
      assert.deepEqual(storedFiles(), [`${ID}.jpeg`]);
      const img = await callTool(app, 'get_image', { id: ID });
      assert.equal(img.result.content[0].type, 'image');
    });

    it('links hosted figures on PUBLIC_URL, never on the request Host', async () => {
      const saved = process.env.PUBLIC_URL;
      process.env.PUBLIC_URL = ' https://md.example.org/ ';
      let app;
      try {
        app = makeApp(ocrStub(), { imagePublicUrl: undefined }); // read from the env at creation
      } finally {
        if (saved === undefined) delete process.env.PUBLIC_URL; else process.env.PUBLIC_URL = saved;
      }
      const j = await rpcWithHost(app, 'tracker.example', 'tools/call', {
        name: 'read_url', arguments: { url: PDF, pdf_ocr: true, pdf_images: 'hosted' },
      });
      assert.match(textOf(j), /!\[Figure 1\]\(https:\/\/md\.example\.org\/img\/[0-9a-f]{32}\.jpeg\)/);
      assert.doesNotMatch(textOf(j), /tracker\.example\/img/);
    });

    it('hosted degrades to caption when the instance has no image store', async () => {
      const stub = ocrStub();
      const app = makeApp(stub, { imageStore: null });
      await callTool(app, 'read_url', { url: PDF, pdf_ocr: true, pdf_images: 'hosted' });
      assert.equal(stub.calls[0].pdfImages, 'caption');
      assert.equal(stub.calls[0].hostImages, undefined);
    });

    it('hosted end to end: the answer links the figure and get_image returns it', async () => {
      const stub = ocrStub();
      const app = makeApp(stub);
      const j = await callTool(app, 'read_url', { url: PDF, pdf_ocr: true, pdf_images: 'hosted' });
      const m = /!\[Figure 1\]\((https?:\/\/[^/)]+)\/img\/([0-9a-f]{32})\.jpeg\)/.exec(textOf(j));
      assert.ok(m, textOf(j));
      assert.equal(m[1], IMG_BASE);
      assert.match(textOf(j), /^share_id: [0-9a-f]{32}$/m);
      assert.ok(cache.getAsset(m[2]), 'the asset row is stored with the conversion');
      const img = await callTool(app, 'get_image', { id: m[2] });
      assert.deepEqual(img.result.content, [{ type: 'image', data: BYTES.toString('base64'), mimeType: 'image/jpeg' }]);
    });

    it('serves the caption form and keeps no file when the conversion cannot be stored', async (t) => {
      t.mock.method(console, 'warn', () => {});
      const real = cache.put.bind(cache);
      let calls = 0;
      t.mock.method(cache, 'put', (row) => {
        if (calls++ === 0) throw new Error('disk full');
        return real(row);
      });
      const j = await callTool(makeApp(ocrStub()), 'read_url', { url: PDF, pdf_ocr: true, pdf_images: 'hosted' });
      assert.ok(!j.result.isError);
      assert.match(textOf(j), /\*Figure 1: a chart\*/);
      assert.doesNotMatch(textOf(j), /\/img\//);
      assert.match(textOf(j), /^share_id: [0-9a-f]{32}$/m);
      assert.deepEqual(storedFiles(), []);
      assert.equal(cache.db.prepare('SELECT COUNT(*) c FROM assets').get().c, 0);
    });

    it('removes hosted files again when the extractor throws', async () => {
      const app = makeApp({
        fn: async (url, opts) => {
          await opts.hostImages([{ id: 'img-0.jpeg', dataUri: DATA_URI }]);
          throw new Error('boom');
        },
      });
      const j = await callTool(app, 'read_url', { url: PDF, pdf_ocr: true, pdf_images: 'hosted' });
      assert.ok(j.error || j.result?.isError);
      assert.deepEqual(storedFiles(), []);
    });
  });

  describe('get_image', () => {
    const notFound = { content: [{ type: 'text', text: 'Image not found or expired.' }], isError: true };

    it('returns the image for a bare id', async () => {
      seedImage();
      const j = await callTool(makeApp(ocrStub()), 'get_image', { id: ID });
      assert.deepEqual(j.result.content, [{ type: 'image', data: BYTES.toString('base64'), mimeType: 'image/jpeg' }]);
      assert.ok(!j.result.isError);
    });

    for (const form of [`https://pullmd.example/img/${ID}.jpeg`, `http://localhost:3000/img/${ID}`, `https://x.example/sub/img/${ID}.jpg?v=1#f`]) {
      it(`returns the image for the URL ${form}`, async () => {
        seedImage();
        const j = await callTool(makeApp(ocrStub()), 'get_image', { id: form });
        assert.equal(j.result.content[0].type, 'image');
        assert.equal(j.result.content[0].data, BYTES.toString('base64'));
      });
    }

    it('reports an unknown id as an error', async () => {
      seedImage();
      const j = await callTool(makeApp(ocrStub()), 'get_image', { id: 'ef'.repeat(16) });
      assert.deepEqual(j.result, notFound);
    });

    for (const garbage of ['', 'nonsense', '../../etc/passwd', `${ID}/../${ID}`, 'https://x.example/s/' + ID, `https://x.example/img/${ID}.svg`, ID.toUpperCase(), ID.slice(1)]) {
      it(`reports ${JSON.stringify(garbage)} as an error`, async () => {
        seedImage();
        const j = await callTool(makeApp(ocrStub()), 'get_image', { id: garbage });
        assert.deepEqual(j.result, notFound);
      });
    }

    it('reports an asset row without a file as an error', async () => {
      seedImage();
      fs.rmSync(root, { recursive: true, force: true });
      const j = await callTool(makeApp(ocrStub()), 'get_image', { id: ID });
      assert.deepEqual(j.result, notFound);
    });

    it('reports an image past the retention as an error', async () => {
      seedImage();
      cache.db.prepare(`UPDATE conversions SET created_at = datetime('now', '-100 days')`).run();
      const j = await callTool(makeApp(ocrStub()), 'get_image', { id: ID });
      assert.deepEqual(j.result, notFound);
    });

    it('is only in the tool list when an image store is set', async () => {
      const names = async (app) => (await rpc(app, 'tools/list', {})).result.tools.map((t) => t.name);
      assert.ok((await names(makeApp(ocrStub()))).includes('get_image'));
      assert.ok(!(await names(makeApp(ocrStub(), { imageStore: null }))).includes('get_image'));
    });
  });
});
