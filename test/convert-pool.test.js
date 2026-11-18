import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import zlib from 'node:zlib';
import { createConvertPool } from '../lib/convert-pool.js';
import { extractHtml, extractFile, extractWeb } from '../lib/web.js';
import { mergeRecipes } from '../lib/recipes.js';
import { createApp } from '../server.js';
import { publicLookup } from './helpers/fake-dns.js';

const TEST_WORKER = new URL('./helpers/convert-test-worker.js', import.meta.url);
const CONVERT_WORKER = new URL('../lib/convert-worker.js', import.meta.url);

function withEnv(vars, fn) {
  const saved = {};
  for (const k of Object.keys(vars)) {
    saved[k] = process.env[k];
    if (vars[k] === undefined) delete process.env[k];
    else process.env[k] = vars[k];
  }
  const restore = () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
  return Promise.resolve().then(fn).finally(restore);
}

// Main-thread responsiveness while a conversion runs.
function lagMeter(intervalMs = 20) {
  let last = performance.now();
  let max = 0;
  const t = setInterval(() => {
    const now = performance.now();
    max = Math.max(max, now - last - intervalMs);
    last = now;
  }, intervalMs);
  return { stop() { clearInterval(t); return max; } };
}

const LOREM = 'Lorem ipsum dolor sit amet, consectetur adipiscing elit. '.repeat(8);
const wrap = (b) => `<!DOCTYPE html><html><head><title>T</title></head><body><article><h1>H</h1><p>${LOREM}</p>${b}<p>${LOREM}</p></article></body></html>`;
// The C1 family: escaped markup in a <title> inside the body. The bare
// body <title> is fast on this branch; inside a nested <head> it still
// takes about 38 s at 4000 repeats (in-process, this branch), well within the
// input budgets.
const C1_BOMB = wrap(`<div><head><title>${'&lt;div&gt;x'.repeat(5000)}</title></head></div>`);

const ARTICLE = `<!DOCTYPE html><html><head><title>Ein Artikel</title>
<meta name="description" content="Beschreibung"></head><body>
<nav><a href="/">Start</a></nav>
<article><h1>Ein Artikel</h1>
${'<p>Ein Absatz mit genug Text, damit Readability ihn als Inhalt erkennt. <a href="/mehr">mehr</a></p>'.repeat(12)}
<table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>
<img src="data:image/png;base64,AAAA" alt="Bild">
</article><footer>Fuss</footer></body></html>`;

function makeZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const e of entries) {
    const raw = Buffer.from(e.data);
    const body = e.deflate ? zlib.deflateRawSync(raw, { level: 9 }) : raw;
    const name = Buffer.from(e.name);
    const crc = zlib.crc32(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(e.deflate ? 8 : 0, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(e.deflate ? 8 : 0, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, body);
    centrals.push(central, name);
    offset += 30 + name.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

// About 32 MB of empty elements, about 33 KB on the wire.
function tinyOdt() {
  const head = '<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"><office:body><office:text><text:p>';
  const tail = '</text:p></office:text></office:body></office:document-content>';
  const n = Math.floor((32 * 1024 * 1024 - 400) / 4);
  return makeZip([
    { name: 'mimetype', data: 'application/vnd.oasis.opendocument.text' },
    { name: 'content.xml', data: head + '<a/>'.repeat(n) + tail, deflate: true },
  ]);
}

const htmlJob = (html) => ({ op: 'html', html, url: null, filename: 'x.html', recipe: mergeRecipes([]), trafilatura: false });

describe('conversion pool - lib/web.js through worker threads', () => {
  // Start the shared pool's workers first: a running instance has them, and
  // loading the modules on a fresh thread is not part of the time limit.
  before(() => Promise.all([extractHtml(ARTICLE, { filename: 'a.html' }), extractHtml(ARTICLE, { filename: 'b.html' })]));

  it('stops a slow document at the time limit and keeps the main thread responsive', async () => {
    await withEnv({ PULLMD_CONVERT_TIMEOUT_MS: '2000', PULLMD_CONVERT_WORKERS: undefined }, async () => {
      const lag = lagMeter();
      const t0 = Date.now();
      await assert.rejects(() => extractHtml(C1_BOMB, { filename: 'c1.html' }), (err) => {
        assert.equal(err.status, 422);
        assert.equal(err.code, 'conversion_timeout');
        assert.equal(err.message, 'Document took too long to convert');
        return true;
      });
      const elapsed = Date.now() - t0;
      const maxLag = lag.stop();
      assert.ok(elapsed < 3000, `took ${elapsed} ms`);
      assert.ok(maxLag < 200, `main loop lagged ${maxLag.toFixed(0)} ms`);
    });
  });

  it('answers 422 for a small OpenDocument that expands to millions of elements, and keeps converting', async () => {
    await withEnv({ PULLMD_CONVERT_TIMEOUT_MS: '2000' }, async () => {
      const buf = tinyOdt();
      assert.ok(buf.length < 64 * 1024, `zip is ${buf.length} bytes`);
      await assert.rejects(() => extractFile(buf, { filename: 'tiny.odt' }), (err) => err.status === 422);
      const ok = await extractHtml(ARTICLE, { filename: 'a.html' });
      assert.match(ok.markdown, /Ein Absatz/);
    });
  });

  it('converts byte-identical to in-process conversion', async () => {
    const odt = fs.readFileSync(new URL('./fixtures/odf/bericht.odt', import.meta.url));
    const msg = fs.readFileSync(new URL('./fixtures/msg/html-body.msg', import.meta.url));
    const eml = Buffer.from(`From: a@example.org\r\nTo: b@example.org\r\nSubject: Hallo\r\nMIME-Version: 1.0\r\nContent-Type: text/html; charset=utf-8\r\n\r\n${ARTICLE}`);
    const run = () => Promise.all([
      extractHtml(ARTICLE, { filename: 'a.html' }),
      extractHtml(ARTICLE, { url: 'https://example.org/artikel', recipes: [] }),
      extractFile(odt, { filename: 'bericht.odt', lang: 'de' }),
      extractFile(msg, { filename: 'html-body.msg', lang: 'en' }),
      extractFile(eml, { filename: 'mail.eml', lang: 'de' }),
      extractFile(Buffer.from('a,b\n1,2\n'), { filename: 'd.csv' }),
      extractWeb('https://example.org/seite', {
        lookup: publicLookup, recipes: [], render: 'skip',
        fetch: async () => ({ ok: true, status: 200, headers: new Map([['content-type', 'text/html']]), text: async () => ARTICLE }),
      }),
    ]);
    const pooled = await withEnv({ PULLMD_CONVERT_WORKERS: '2' }, run);
    const inProcess = await withEnv({ PULLMD_CONVERT_WORKERS: '0' }, run);
    assert.deepEqual(pooled, inProcess);
  });

  it('sends Trafilatura through the main thread with the injected fetch; its delay does not count', async () => {
    await withEnv({ TRAFILATURA_URL: 'http://mock-trafilatura/extract', PULLMD_CONVERT_TIMEOUT_MS: '2000' }, async () => {
      const { extractHtml: extractHtmlFresh } = await import(`../lib/web.js?pool-rpc=${Date.now()}`);
      const calls = [];
      const trafilaturaMd = '# Aus Trafilatura\n\n' + 'Sehr guter Inhalt aus dem Sidecar. '.repeat(200);
      const result = await extractHtmlFresh('<html><head><title>T</title></head><body><div>kurz</div></body></html>', {
        filename: 't.html',
        fetch: async (url, opts) => {
          calls.push({ url: String(url), method: opts?.method });
          await new Promise((r) => setTimeout(r, 2500));
          return { ok: true, text: async () => trafilaturaMd };
        },
      });
      assert.deepEqual(calls, [{ url: 'http://mock-trafilatura/extract', method: 'POST' }]);
      assert.equal(result.source, 'trafilatura');
      assert.match(result.markdown, /Sehr guter Inhalt/);
    });
  });

  it('three slow documents, two workers, one queue place: the waiting one is refused as busy', async () => {
    const pool = createConvertPool({ size: 2, timeoutMs: 2000, maxQueue: 1, maxWaitMs: 1000, workerUrl: CONVERT_WORKER });
    try {
      const results = await Promise.allSettled([1, 2, 3].map(() => pool.run(htmlJob(C1_BOMB))));
      const codes = results.map((r) => r.reason?.code).sort();
      assert.deepEqual(codes, ['conversion_timeout', 'conversion_timeout', 'converter_busy']);
      const busy = results.find((r) => r.reason?.code === 'converter_busy').reason;
      assert.equal(busy.status, 503);
      assert.equal(busy.retryAfter, 5);
    } finally {
      pool.retire();
    }
  });
});

describe('conversion pool - extractWeb', () => {
  const thinPage = '<html><head><title>App</title></head><body><div id="root"></div></body></html>';
  const pageFetch = (html) => async () => ({
    ok: true, status: 200,
    headers: new Map([['content-type', 'text/html; charset=utf-8']]),
    text: async () => html,
  });

  it('a static pass over the time limit gets no Playwright retry', async () => {
    await withEnv({ PULLMD_CONVERT_TIMEOUT_MS: '2000' }, async () => {
      let renders = 0;
      await assert.rejects(() => extractWeb('https://example.com/c1', {
        fetch: pageFetch(C1_BOMB), lookup: publicLookup, recipes: [],
        renderClient: async () => { renders++; return thinPage; },
      }), (err) => err.code === 'conversion_timeout');
      assert.equal(renders, 0);
    });
  });

  it('a rendered pass over the time limit keeps the static result, unless render=force', async () => {
    await withEnv({ PULLMD_CONVERT_TIMEOUT_MS: '2000' }, async () => {
      const opts = { fetch: pageFetch(thinPage), lookup: publicLookup, recipes: [], renderClient: async () => C1_BOMB };
      const kept = await extractWeb('https://example.com/spa', opts);
      assert.match(kept.metadata.extractorReason, /took too long to convert/);
      await assert.rejects(() => extractWeb('https://example.com/spa', { ...opts, render: 'force' }),
        (err) => err.code === 'conversion_timeout');
    });
  });
});

describe('conversion pool - limits (stand-in worker)', () => {
  let pool;
  after(() => pool?.retire());

  it('reports a worker out of memory as document_too_complex and replaces the worker', async () => {
    pool = createConvertPool({ size: 1, heapMb: 32, workerUrl: TEST_WORKER });
    await assert.rejects(() => pool.run({ op: 'alloc' }), (err) => {
      assert.equal(err.status, 422);
      assert.equal(err.code, 'document_too_complex');
      return true;
    });
    assert.equal(await pool.run({ op: 'echo', value: 'still here' }), 'still here');
    pool.retire();
  });

  it('a crashed worker fails its job without a status (500) and is replaced', async () => {
    pool = createConvertPool({ size: 1, workerUrl: TEST_WORKER });
    await assert.rejects(() => pool.run({ op: 'exit' }), (err) => err.status === undefined && /exited/.test(err.message));
    assert.equal(await pool.run({ op: 'echo', value: 1 }), 1);
    pool.retire();
  });

  it('carries status, code and limit of a conversion error across the thread boundary', async () => {
    pool = createConvertPool({ size: 1, workerUrl: TEST_WORKER });
    await assert.rejects(() => pool.run({ op: 'throw' }), (err) => {
      assert.equal(err.status, 422);
      assert.equal(err.code, 'document_too_complex');
      assert.equal(err.limit, 'x');
      return true;
    });
    pool.retire();
  });

  it('refuses a job when the queue is full', async () => {
    pool = createConvertPool({ size: 1, maxQueue: 1, workerUrl: TEST_WORKER });
    const first = pool.run({ op: 'spin', ms: 300 });
    const second = pool.run({ op: 'echo', value: 2 });
    await assert.rejects(() => pool.run({ op: 'echo', value: 3 }), (err) => err.code === 'converter_busy' && err.status === 503);
    assert.equal(await first, 'spun');
    assert.equal(await second, 2);
    pool.retire();
  });

  it('refuses a job that waited too long', async () => {
    pool = createConvertPool({ size: 1, maxWaitMs: 200, workerUrl: TEST_WORKER });
    const first = pool.run({ op: 'spin', ms: 800 });
    const t0 = Date.now();
    await assert.rejects(() => pool.run({ op: 'echo', value: 2 }), (err) => err.code === 'converter_busy');
    assert.ok(Date.now() - t0 < 700, 'refused before the first job finished');
    await first;
    pool.retire();
  });

  it('does not count queue wait or the Trafilatura round-trip toward the time limit', async () => {
    pool = createConvertPool({ size: 1, timeoutMs: 600, workerUrl: TEST_WORKER });
    const hooks = { trafilatura: async (html) => { await new Promise((r) => setTimeout(r, 1000)); return `md:${html}`; } };
    const first = pool.run({ op: 'spin', ms: 400 });
    const second = pool.run({ op: 'rpc', html: 'x', before: 300, after: 200 }, hooks);
    assert.equal(await first, 'spun');
    assert.equal(await second, 'md:x');
    // ...but CPU time on both sides of it does.
    await assert.rejects(() => pool.run({ op: 'rpc', html: 'y', before: 400, after: 400 }, hooks),
      (err) => err.code === 'conversion_timeout');
    pool.retire();
  });
});

describe('conversion pool - HTTP answers', () => {
  async function request(app, path, opts) {
    const server = app.listen(0);
    try {
      const res = await fetch(`http://localhost:${server.address().port}${path}`, opts);
      return { status: res.status, headers: res.headers, body: await res.json() };
    } finally {
      server.close();
    }
  }
  const busy = () => { throw Object.assign(new Error('The converter is busy, try again shortly'), { status: 503, code: 'converter_busy', retryAfter: 5 }); };

  it('/api/html answers 422 conversion_timeout for a document over the time limit', async () => {
    await withEnv({ PULLMD_CONVERT_TIMEOUT_MS: '2000' }, async () => {
      const r = await request(createApp({ cache: null }), '/api/html', { method: 'POST', headers: { 'Content-Type': 'text/html' }, body: C1_BOMB });
      assert.equal(r.status, 422);
      assert.deepEqual(r.body, { error: 'Document took too long to convert', code: 'conversion_timeout' });
    });
  });

  for (const [route, override, opts] of [
    ['/api/html', 'extractHtml', { method: 'POST', headers: { 'Content-Type': 'text/html' }, body: '<p>x</p>' }],
    ['/api/file', 'extractFile', { method: 'POST', headers: { 'Content-Type': 'text/plain', 'X-Filename': 'a.txt' }, body: 'x' }],
    ['/api?url=https://example.com/a&nocache=1', 'extractWeb', {}],
  ]) {
    it(`${route.split('?')[0]} answers 503 converter_busy with Retry-After`, async () => {
      const app = createApp({ cache: null, lookup: publicLookup, [override]: busy });
      const r = await request(app, route, opts);
      assert.equal(r.status, 503);
      assert.equal(r.headers.get('retry-after'), '5');
      assert.equal(r.body.code, 'converter_busy');
    });
  }

  it('/api/stream sends the converter_busy code in its error event', async () => {
    const app = createApp({ cache: null, lookup: publicLookup, extractWeb: busy });
    const server = app.listen(0);
    try {
      const res = await fetch(`http://localhost:${server.address().port}/api/stream?url=${encodeURIComponent('https://example.com/a')}`);
      const text = await res.text();
      const m = text.match(/event: error\ndata: (.+)/);
      assert.ok(m, text.slice(0, 300));
      assert.equal(JSON.parse(m[1]).code, 'converter_busy');
    } finally {
      server.close();
    }
  });

  it('an async file job refused as busy ends with httpStatus 503', async () => {
    const app = createApp({ cache: null, extractFile: busy });
    const server = app.listen(0);
    try {
      const base = `http://localhost:${server.address().port}`;
      const sub = await fetch(`${base}/api/file?async=1`, { method: 'POST', headers: { 'Content-Type': 'text/plain', 'X-Filename': 'a.txt' }, body: 'x' });
      const { jobId } = await sub.json();
      let job;
      for (let i = 0; i < 50; i++) {
        job = await (await fetch(`${base}/api/file/jobs/${jobId}`)).json();
        if (job.status !== 'pending') break;
        await new Promise((r) => setTimeout(r, 20));
      }
      assert.equal(job.status, 'error');
      assert.equal(job.httpStatus, 503);
    } finally {
      server.close();
    }
  });
});
