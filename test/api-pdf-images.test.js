import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createApp } from './helpers/fake-dns.js';
import { createCache } from '../lib/cache.js';
import { createImageStore } from '../lib/image-store.js';

const PDF_URL = 'https://docs.example.com/report.pdf';
const IMG_BASE = 'https://md.example.org';
const HOSTED_FORM = '# Report\n\nText.\n\n![Figure 1](https://placeholder.invalid/replaced)';
const CAPTION_FORM = '# Report\n\nText.\n\n> Figure 1: a chart';

function dataUri(bytes) {
  return `data:image/jpeg;base64,${Buffer.from(bytes).toString('base64')}`;
}

// An extractWeb stand-in that behaves like the OCR branch: asks the hosting
// callback for URLs and returns the hosted form plus the caption fallback.
function fakeExtractWeb(calls, extra = {}) {
  return async (url, opts) => {
    calls.push(opts);
    const hosted = opts.hostImages ? await opts.hostImages([{ id: 'img-0.jpeg', width: 100, height: 80, dataUri: dataUri([1, 2, 3, 4]) }]) : new Map();
    const imgUrl = hosted.get('img-0.jpeg');
    const markdown = imgUrl ? `# Report\n\nText.\n\n![Figure 1](${imgUrl})` : CAPTION_FORM;
    return {
      markdown,
      title: 'report.pdf',
      source: 'pdf-ocr',
      metadata: { title: 'report.pdf', sourceUrl: url, quality: 0.9, contentLength: markdown.length },
      ...(imgUrl ? { ocrFallbackMarkdown: CAPTION_FORM } : {}),
      ...extra,
    };
  };
}

async function withServer(app, fn) {
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  try {
    return await fn(`http://localhost:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

// GET with a chosen Host header (fetch does not let a test set it).
function getWithHost(base, target, host) {
  const { port } = new URL(base);
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: target, headers: { Host: host } }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { text += c; });
      res.on('end', () => resolve(text));
    }).on('error', reject);
  });
}

function listFiles(root) {
  const out = [];
  for (const shard of fs.existsSync(root) ? fs.readdirSync(root) : []) out.push(...fs.readdirSync(path.join(root, shard)));
  return out;
}

// Reads the `result` event of an SSE answer.
function sseResult(text) {
  const blocks = text.split('\n\n');
  const block = blocks.find((b) => b.startsWith('event: result'));
  assert.ok(block, `no result event in:\n${text}`);
  return JSON.parse(block.split('\n').find((l) => l.startsWith('data: ')).slice(6));
}

describe('pdf_images on GET /api and GET /api/stream', () => {
  let root;
  let store;
  let cache;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'pullmd-pdfimg-'));
    store = createImageStore(root);
    cache = createCache(':memory:');
    mock.method(console, 'warn', () => {}); // the fallback paths log on purpose
  });
  afterEach(() => {
    mock.restoreAll();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const target = (extra = '') => `/api?url=${encodeURIComponent(PDF_URL)}&pdf=ocr&pdf_images=hosted&format=json${extra}`;

  it('hosts the figures: markdown links the image, /img serves it, the cache row holds the same markdown', async () => {
    const calls = [];
    const app = createApp({ cache, imageStore: store, imagePublicUrl: IMG_BASE, extractWeb: fakeExtractWeb(calls) });
    await withServer(app, async (base) => {
      const res = await fetch(`${base}${target()}`);
      assert.equal(res.status, 200);
      const body = await res.json();
      const m = /\/img\/([0-9a-f]{32})\.jpeg/.exec(body.markdown);
      assert.ok(m, body.markdown);
      assert.equal(calls[0].pdfImages, 'hosted');
      assert.equal(typeof calls[0].hostImages, 'function');
      const img = await fetch(`${base}/img/${m[1]}.jpeg`);
      assert.equal(img.status, 200);
      assert.deepEqual(Buffer.from(await img.arrayBuffer()), Buffer.from([1, 2, 3, 4]));
      const row = cache.getByShareId(body.shareId);
      assert.equal(row.markdown, body.markdown);
      assert.ok(cache.getAsset(m[1]));
    });
  });

  it('links hosted figures on PUBLIC_URL, never on the request Host', async () => {
    const saved = process.env.PUBLIC_URL;
    process.env.PUBLIC_URL = ' https://md.example.org/ ';
    let app;
    try {
      app = createApp({ cache, imageStore: store, extractWeb: fakeExtractWeb([]) }); // read at creation
    } finally {
      if (saved === undefined) delete process.env.PUBLIC_URL; else process.env.PUBLIC_URL = saved;
    }
    await withServer(app, async (base) => {
      const body = JSON.parse(await getWithHost(base, target(), 'tracker.example'));
      assert.match(body.markdown, /\(https:\/\/md\.example\.org\/img\/[0-9a-f]{32}\.jpeg\)/);
      assert.ok(!body.markdown.includes('tracker.example'), body.markdown);
      assert.ok(!cache.getByShareId(body.shareId).markdown.includes('tracker.example'));
    });
  });

  it('without PUBLIC_URL, hosted degrades to caption on /api and /api/stream and writes no files', async () => {
    const calls = [];
    const app = createApp({ cache, imageStore: store, imagePublicUrl: '', extractWeb: fakeExtractWeb(calls) });
    await withServer(app, async (base) => {
      const body = JSON.parse(await getWithHost(base, target(), 'tracker.example'));
      assert.equal(body.markdown, CAPTION_FORM);
      const res = await fetch(`${base}/api/stream?url=${encodeURIComponent(PDF_URL)}&pdf=ocr&pdf_images=hosted&nocache=true`);
      assert.equal(sseResult(await res.text()).markdown, CAPTION_FORM);
      assert.deepEqual(calls.map((c) => c.pdfImages), ['caption', 'caption']);
      assert.ok(calls.every((c) => c.hostImages === undefined));
      assert.deepEqual(listFiles(root), []);
      assert.equal((await (await fetch(`${base}/api/config`)).json()).imageHosting, false);
    });
  });

  it('without PUBLIC_URL, /img still serves figures that are already stored', async () => {
    const id = 'cd'.repeat(16);
    store.write(id, 'image/jpeg', Buffer.from([9, 9]));
    cache.put({ url: null, title: 'a.pdf', markdown: '# a', source: 'pdf-ocr', assets: [{ id, mime: 'image/jpeg', size: 2 }] });
    await withServer(createApp({ cache, imageStore: store, imagePublicUrl: '' }), async (base) => {
      assert.equal((await fetch(`${base}/img/${id}.jpeg`)).status, 200);
    });
  });

  it('hosts the figures on /api/stream as well', async () => {
    const calls = [];
    const app = createApp({ cache, imageStore: store, imagePublicUrl: IMG_BASE, extractWeb: fakeExtractWeb(calls) });
    await withServer(app, async (base) => {
      const res = await fetch(`${base}/api/stream?url=${encodeURIComponent(PDF_URL)}&pdf=ocr&pdf_images=hosted`);
      const result = sseResult(await res.text());
      const m = /\/img\/([0-9a-f]{32})\.jpeg/.exec(result.markdown);
      assert.ok(m, result.markdown);
      assert.equal(cache.getByShareId(result.shareId).markdown, result.markdown);
      assert.equal((await fetch(`${base}/img/${m[1]}.jpeg`)).status, 200);
    });
  });

  it('a failing cache.put falls back to the caption form and leaves no files', async () => {
    const calls = [];
    const failing = { ...cache, put() { throw new Error('disk full'); } };
    const app = createApp({ cache: failing, imageStore: store, imagePublicUrl: IMG_BASE, extractWeb: fakeExtractWeb(calls) });
    await withServer(app, async (base) => {
      const res = await fetch(`${base}${target()}`);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.markdown, CAPTION_FORM);
      assert.ok(!body.markdown.includes('/img/'));
      assert.equal(body.shareId, null);
      assert.deepEqual(listFiles(root), []);
    });
  });

  it('stream: a failing cache.put falls back to the caption form and leaves no files', async () => {
    const failing = { ...cache, put() { throw new Error('disk full'); } };
    const app = createApp({ cache: failing, imageStore: store, imagePublicUrl: IMG_BASE, extractWeb: fakeExtractWeb([]) });
    await withServer(app, async (base) => {
      const res = await fetch(`${base}/api/stream?url=${encodeURIComponent(PDF_URL)}&pdf=ocr&pdf_images=hosted`);
      const result = sseResult(await res.text());
      assert.equal(result.markdown, CAPTION_FORM);
      assert.equal(result.shareId, null);
      assert.deepEqual(listFiles(root), []);
    });
  });

  it('when only the put with assets fails, the caption form is stored without assets', async () => {
    const real = cache.put;
    const failing = { ...cache, put(row) { if (row.assets?.length) throw new Error('constraint'); return real(row); } };
    const app = createApp({ cache: failing, imageStore: store, imagePublicUrl: IMG_BASE, extractWeb: fakeExtractWeb([]) });
    await withServer(app, async (base) => {
      const body = await (await fetch(`${base}${target()}`)).json();
      assert.equal(body.markdown, CAPTION_FORM);
      assert.ok(body.shareId);
      assert.equal(cache.getByShareId(body.shareId).markdown, CAPTION_FORM);
      assert.deepEqual(cache.listAssetIds(), []);
      assert.deepEqual(listFiles(root), []);
    });
  });

  it('a noStore result is served in the caption form and its files are removed', async () => {
    const app = createApp({ cache, imageStore: store, imagePublicUrl: IMG_BASE, extractWeb: fakeExtractWeb([], { noStore: true }) });
    await withServer(app, async (base) => {
      const body = await (await fetch(`${base}${target()}`)).json();
      assert.equal(body.markdown, CAPTION_FORM);
      assert.equal(body.shareId, null);
      assert.deepEqual(listFiles(root), []);
      assert.deepEqual(cache.listAssetIds(), []);
    });
  });

  it('without an image store, hosted reaches the extractor as caption and without hostImages', async () => {
    const calls = [];
    const app = createApp({ cache, extractWeb: fakeExtractWeb(calls) });
    await withServer(app, async (base) => {
      const body = await (await fetch(`${base}${target()}`)).json();
      assert.equal(calls[0].pdfImages, 'caption');
      assert.equal(calls[0].hostImages, undefined);
      assert.equal(body.markdown, CAPTION_FORM);
    });
  });

  it('forwards caption, strip, unknown and missing values and the request language', async () => {
    const calls = [];
    const app = createApp({ cache, imageStore: store, imagePublicUrl: IMG_BASE, extractWeb: fakeExtractWeb(calls) });
    await withServer(app, async (base) => {
      const get = (q) => fetch(`${base}/api?url=${encodeURIComponent(PDF_URL)}&pdf=ocr&format=json${q}`);
      await get('&pdf_images=caption&lang=en');
      await get('&pdf_images=strip');
      await get('&pdf_images=bogus');
      await get('');
      assert.deepEqual(calls.map((c) => c.pdfImages), ['caption', 'strip', 'strip', 'strip']);
      assert.equal(calls[0].lang, 'en');
      assert.ok(calls.every((c) => c.hostImages === undefined));
    });
  });
});

describe('GET /api/config image flags', () => {
  it('reports imageHosting and uploadStore', async () => {
    const store = createImageStore(fs.mkdtempSync(path.join(os.tmpdir(), 'pullmd-cfg-')));
    try {
      await withServer(createApp({ cache: createCache(':memory:'), imageStore: store, imagePublicUrl: IMG_BASE, uploadStore: true }), async (base) => {
        const cfg = await (await fetch(`${base}/api/config`)).json();
        assert.equal(cfg.imageHosting, true);
        assert.equal(cfg.uploadStore, true);
      });
      await withServer(createApp({ cache: createCache(':memory:'), uploadStore: false }), async (base) => {
        const cfg = await (await fetch(`${base}/api/config`)).json();
        assert.equal(cfg.imageHosting, false);
        assert.equal(cfg.uploadStore, false);
      });
    } finally {
      fs.rmSync(store.rootDir, { recursive: true, force: true });
    }
  });

  it('uploadStore defaults to on and follows PULLMD_UPLOAD_STORE', async () => {
    const saved = process.env.PULLMD_UPLOAD_STORE;
    try {
      const cfgFor = async (value) => {
        if (value === undefined) delete process.env.PULLMD_UPLOAD_STORE; else process.env.PULLMD_UPLOAD_STORE = value;
        return withServer(createApp({}), async (base) => (await (await fetch(`${base}/api/config`)).json()).uploadStore);
      };
      assert.equal(await cfgFor(undefined), true);
      assert.equal(await cfgFor('false'), false);
      assert.equal(await cfgFor('0'), false);
      assert.equal(await cfgFor('true'), true);
      assert.equal(await cfgFor('garbage'), true);
    } finally {
      if (saved === undefined) delete process.env.PULLMD_UPLOAD_STORE; else process.env.PULLMD_UPLOAD_STORE = saved;
    }
  });
});
