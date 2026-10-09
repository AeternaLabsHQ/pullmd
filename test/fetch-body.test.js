import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import {
  readBodyCapped,
  maxFetchBytes,
  DEFAULT_MAX_FETCH_BYTES,
  ResponseTooLargeError,
} from '../lib/fetch-body.js';
import { extractWeb } from '../lib/web.js';

const MB = 1024 * 1024;

function headersOf(map) {
  return { get: (h) => map[h.toLowerCase()] ?? null };
}

describe('maxFetchBytes', () => {
  it('defaults to 50 MB', () => {
    assert.equal(DEFAULT_MAX_FETCH_BYTES, 50 * MB);
    assert.equal(maxFetchBytes({}), 50 * MB);
  });

  it('reads PULLMD_MAX_FETCH_BYTES as a byte count', () => {
    assert.equal(maxFetchBytes({ PULLMD_MAX_FETCH_BYTES: '1048576' }), MB);
  });

  it('falls back to the default for empty, zero, negative or non-numeric values', () => {
    for (const v of ['', '0', '-5', 'abc', '1.5']) {
      assert.equal(maxFetchBytes({ PULLMD_MAX_FETCH_BYTES: v }), 50 * MB, `value ${JSON.stringify(v)}`);
    }
  });
});

describe('readBodyCapped', () => {
  it('returns the exact bytes of a streamed body under the cap (BOM and latin1 intact)', async () => {
    const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('f\xfcr R\xe4tsel', 'latin1')]);
    const buf = await readBodyCapped(new Response(bytes), { maxBytes: MB });
    assert.ok(Buffer.isBuffer(buf));
    assert.ok(buf.equals(bytes));
  });

  it('returns an empty buffer for a response without a body', async () => {
    const buf = await readBodyCapped(new Response(null), { maxBytes: MB });
    assert.equal(buf.length, 0);
  });

  it('rejects a Content-Length above the cap without reading the body', async () => {
    const res = {
      headers: headersOf({ 'content-length': String(10 * MB) }),
      body: { getReader() { throw new Error('body must not be read'); }, cancel: async () => {} },
      arrayBuffer: async () => { throw new Error('body must not be read'); },
    };
    await assert.rejects(readBodyCapped(res, { maxBytes: MB }), ResponseTooLargeError);
  });

  it('stops a streamed body once it passes the cap', async () => {
    let pulled = 0;
    const stream = new ReadableStream({
      pull(controller) {
        pulled++;
        controller.enqueue(new Uint8Array(64 * 1024));
      },
    });
    await assert.rejects(readBodyCapped(new Response(stream), { maxBytes: MB }), ResponseTooLargeError);
    assert.ok(pulled < 40, `stream read stops near the cap (pulled ${pulled} chunks)`);
  });

  it('applies the cap to arrayBuffer-only response objects', async () => {
    const res = { headers: headersOf({}), arrayBuffer: async () => new Uint8Array(2 * MB).buffer };
    await assert.rejects(readBodyCapped(res, { maxBytes: MB }), ResponseTooLargeError);
  });

  it('reads arrayBuffer-only response objects under the cap', async () => {
    const res = { headers: headersOf({}), arrayBuffer: async () => new TextEncoder().encode('hello').buffer };
    const buf = await readBodyCapped(res, { maxBytes: MB });
    assert.equal(buf.toString(), 'hello');
  });

  it('returns null for response objects that only offer text()', async () => {
    const res = { headers: headersOf({}), text: async () => 'hi' };
    assert.equal(await readBodyCapped(res, { maxBytes: MB }), null);
  });

  it('ends the read when the signal aborts, with the signal reason', async () => {
    const stream = new ReadableStream({ pull() { return new Promise(() => {}); } });
    const ctrl = new AbortController();
    const reason = new Error('deadline reached');
    setTimeout(() => ctrl.abort(reason), 50);
    await assert.rejects(readBodyCapped(new Response(stream), { maxBytes: MB, signal: ctrl.signal }), (err) => err === reason);
  });

  it('the error message names the limit', async () => {
    const res = { headers: headersOf({ 'content-length': String(60 * MB) }), arrayBuffer: async () => new ArrayBuffer(0) };
    await assert.rejects(readBodyCapped(res, { maxBytes: 50 * MB }), /larger than the 50 MB limit/);
  });
});

describe('extractWeb - bounded response bodies', () => {
  let prevAllowed;
  before(() => {
    prevAllowed = process.env.PULLMD_ALLOWED_HOSTS;
    process.env.PULLMD_ALLOWED_HOSTS = '127.0.0.1';
  });
  after(() => {
    if (prevAllowed === undefined) delete process.env.PULLMD_ALLOWED_HOSTS;
    else process.env.PULLMD_ALLOWED_HOSTS = prevAllowed;
  });

  async function withServer(handler, fn) {
    const server = createServer(handler);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      return await fn(base);
    } finally {
      server.closeAllConnections();
      server.close();
    }
  }

  it('aborts an endless body once it passes the cap', async () => {
    let written = 0;
    const chunk = Buffer.alloc(64 * 1024, 0x61);
    await withServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      const pump = () => {
        while (written < 200 * MB) {
          written += chunk.length;
          if (!res.write(chunk)) { res.once('drain', pump); return; }
        }
        res.end();
      };
      res.on('close', () => {});
      pump();
    }, async (base) => {
      const started = Date.now();
      await assert.rejects(
        extractWeb(`${base}/big`, { maxFetchBytes: MB, render: 'skip' }),
        /larger than the 1 MB limit/,
      );
      assert.ok(Date.now() - started < 5000, 'fails fast');
    });
    assert.ok(written < 32 * MB, `server stopped well before the end (wrote ${written} bytes)`);
  });

  it('rejects a Content-Length above the cap before reading the body', async () => {
    await withServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html', 'content-length': String(100 * MB) });
      res.write('<html>');
      // never finishes: a body read would hang until the deadline
    }, async (base) => {
      const started = Date.now();
      await assert.rejects(
        extractWeb(`${base}/declared`, { maxFetchBytes: MB, fetchDeadlineMs: 10_000, render: 'skip' }),
        /larger than the 1 MB limit/,
      );
      assert.ok(Date.now() - started < 2000, 'rejected without waiting for the body');
    });
  });

  it('ends a slowly dripping body at the deadline', async () => {
    await withServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      const t = setInterval(() => res.write('a'), 50);
      res.on('close', () => clearInterval(t));
    }, async (base) => {
      const started = Date.now();
      await assert.rejects(
        extractWeb(`${base}/drip`, { fetchDeadlineMs: 300, render: 'skip' }),
        /not received within/,
      );
      const elapsed = Date.now() - started;
      assert.ok(elapsed < 3000, `ended near the deadline (${elapsed} ms)`);
    });
  });

  it('applies the cap in comments mode too', async () => {
    await withServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(Buffer.alloc(2 * MB, 0x61));
    }, async (base) => {
      await assert.rejects(
        extractWeb(`${base}/c`, { comments: true, maxFetchBytes: MB, render: 'skip' }),
        /larger than the 1 MB limit/,
      );
    });
  });

  it('extracts a normal page over a real connection as before', async () => {
    const html = '<!DOCTYPE html><html><head><meta charset="iso-8859-1"><title>Normal</title></head><body><article><h1>Gr\xfc\xdfe aus dem Test</h1><p>Dieser Absatz ist lang genug, damit Readability ihn als Hauptinhalt erkennt und nicht verwirft. Er enth\xe4lt Umlaute, die nach dem Dekodieren unver\xe4ndert ankommen m\xfcssen, und reichlich weiteren Text f\xfcr die Mindestl\xe4nge.</p></article></body></html>';
    await withServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(Buffer.from(html, 'latin1'));
    }, async (base) => {
      const result = await extractWeb(`${base}/ok`, { render: 'skip' });
      assert.ok(result.markdown.includes('Grüße aus dem Test'));
      assert.ok(result.markdown.includes('Umlaute'));
      assert.ok(!result.markdown.includes('�'));
    });
  });
});
