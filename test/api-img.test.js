import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createApp } from '../server.js';
import { createCache } from '../lib/cache.js';
import { createImageStore } from '../lib/image-store.js';
import { createRateLimiter } from '../lib/oauth/rate-limit.js';

const ID = 'ab'.repeat(16);
const BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);

async function withServer(app, fn) {
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  try {
    return await fn(`http://localhost:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

describe('GET /img/:file', () => {
  let root;
  let store;
  let cache;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'pullmd-img-'));
    store = createImageStore(root);
    cache = createCache(':memory:', { retentionDays: 90 });
    store.write(ID, 'image/jpeg', BYTES);
    cache.put({ url: null, title: 'a.pdf', markdown: '# a', source: 'pdf-ocr', assets: [{ id: ID, mime: 'image/jpeg', size: BYTES.length }] });
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('serves the stored bytes with the stored type, a private cache header and nosniff', async () => {
    await withServer(createApp({ cache, imageStore: store }), async (base) => {
      for (const file of [`${ID}.jpeg`, `${ID}.jpg`, ID]) {
        const res = await fetch(`${base}/img/${file}`);
        assert.equal(res.status, 200, file);
        assert.equal(res.headers.get('content-type'), 'image/jpeg');
        assert.equal(res.headers.get('cache-control'), 'private, max-age=3600');
        assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
        assert.deepEqual(Buffer.from(await res.arrayBuffer()), BYTES);
      }
    });
  });

  it('answers 404 for anything that is not a live asset', async () => {
    cache.db.prepare(`UPDATE conversions SET created_at = datetime('now', '-100 days')`).run();
    await withServer(createApp({ cache, imageStore: store }), async (base) => {
      const files = [
        `${'ef'.repeat(16)}.jpeg`, // unknown id
        '..%2Fx',
        `${ID.toUpperCase()}.jpeg`,
        `${ID.slice(1)}.jpeg`, // 31 chars
        `${ID}.svg`,
        `${ID}.jpeg`, // row is past retention
        ID, // same, without extension
      ];
      for (const file of files) {
        const res = await fetch(`${base}/img/${file}`);
        assert.equal(res.status, 404, file);
      }
    });
  });

  it('answers 404 without crashing when the row exists but the file is gone', async () => {
    fs.rmSync(store.filePath(ID, 'image/jpeg'));
    await withServer(createApp({ cache, imageStore: store }), async (base) => {
      assert.equal((await fetch(`${base}/img/${ID}.jpeg`)).status, 404);
      // The server is still alive.
      assert.equal((await fetch(`${base}/api/config`)).status, 200);
    });
  });

  it('is absent when no imageStore is passed', async () => {
    await withServer(createApp({ cache }), async (base) => {
      assert.equal((await fetch(`${base}/img/${ID}.jpeg`)).status, 404);
    });
  });

  it('counts misses on the share miss limiter and answers 429 with Retry-After when exhausted', async () => {
    const shareMissLimiter = createRateLimiter({ windowMs: 60_000, max: 2 });
    await withServer(createApp({ cache, imageStore: store, shareMissLimiter }), async (base) => {
      const miss = `${'ef'.repeat(16)}.jpeg`;
      assert.equal((await fetch(`${base}/img/${miss}`)).status, 404);
      assert.equal((await fetch(`${base}/img/${miss}`)).status, 404);
      const limited = await fetch(`${base}/img/${miss}`);
      assert.equal(limited.status, 429);
      assert.ok(Number(limited.headers.get('retry-after')) >= 1);
      // A hit is never counted and is still served.
      assert.equal((await fetch(`${base}/img/${ID}.jpeg`)).status, 200);
    });
  });

  it('closes the file when the client aborts a download', { skip: !fs.existsSync('/proc/self/fd') }, async () => {
    const BIG_ID = 'cd'.repeat(16);
    const big = Buffer.alloc(8 * 1024 * 1024, 7);
    store.write(BIG_ID, 'image/jpeg', big);
    cache.put({ url: null, title: 'big.pdf', markdown: '# big', source: 'pdf-ocr', assets: [{ id: BIG_ID, mime: 'image/jpeg', size: big.length }] });
    const target = store.filePath(BIG_ID, 'image/jpeg');
    const openFds = () => fs.readdirSync('/proc/self/fd').filter((fd) => {
      try { return fs.readlinkSync(`/proc/self/fd/${fd}`) === target; } catch { return false; }
    }).length;

    await withServer(createApp({ cache, imageStore: store }), async (base) => {
      assert.equal(openFds(), 0);
      await new Promise((resolve, reject) => {
        const req = http.get(`${base}/img/${BIG_ID}.jpeg`, (res) => {
          // Headers are in, the body is not consumed: the server is blocked on backpressure.
          res.socket.destroy();
          resolve();
        });
        req.on('error', reject);
      });
      const deadline = Date.now() + 2000;
      while (openFds() > 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
      assert.equal(openFds(), 0, 'read stream must be destroyed after an aborted download');
    });
  });
});
