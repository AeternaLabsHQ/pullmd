import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server.js';
import { createCache } from '../lib/cache.js';
import { createAuth } from '../lib/auth.js';
import { createFileJobStore } from '../lib/file-jobs.js';
import { createRateLimiter } from '../lib/oauth/rate-limit.js';

const FAKE = {
  markdown: '# Report\n\nConverted body.',
  title: 'Report', source: 'markitdown',
  metadata: { title: 'Report', sourceUrl: null, quality: 0.8, contentLength: 400 },
};

const NOT_FOUND = { error: 'Job not found or expired. / Auftrag nicht gefunden oder abgelaufen.' };

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function newStore(opts = {}) {
  return createFileJobStore({ ttlMs: 60_000, maxBytes: 1_000_000, sweepIntervalMs: 0, ...opts });
}

// One server per test, so a job outlives the request that created it.
async function withServer(app, fn) {
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    return await fn(base);
  } finally {
    server.closeAllConnections?.();
    server.close();
  }
}

async function call(base, path, opts = {}) {
  const res = await fetch(base + path, opts);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, headers: Object.fromEntries(res.headers), body: text, json };
}

function submit(base, path = '/api/file?async=1', headers = {}, body = Buffer.from('%PDF-1.4')) {
  return call(base, path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/pdf', ...headers },
    body,
  });
}

// The background work settles a microtask or a few later; poll until it has.
async function settled(base, id, headers = {}) {
  for (let i = 0; i < 50; i++) {
    const r = await call(base, `/api/file/jobs/${id}`, { headers });
    if (r.json?.status !== 'pending') return r;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('job never settled');
}

describe('POST /api/file?async=1 and job pickup', () => {
  it('async=1 answers 202 with a 32-hex jobId and no-store', async () => {
    const d = deferred();
    const app = createApp({ fileJobs: newStore(), extractFile: () => d.promise });
    await withServer(app, async (base) => {
      const r = await submit(base);
      assert.equal(r.status, 202);
      assert.equal(r.headers['cache-control'], 'no-store');
      assert.equal(r.json.status, 'pending');
      assert.match(r.json.jobId, /^[0-9a-f]{32}$/);
      assert.deepEqual(Object.keys(r.json).sort(), ['jobId', 'status']);
      d.resolve(FAKE);
    });
  });

  it('also accepts async=true', async () => {
    const d = deferred();
    const app = createApp({ fileJobs: newStore(), extractFile: () => d.promise });
    await withServer(app, async (base) => {
      const r = await submit(base, '/api/file?async=true');
      assert.equal(r.status, 202);
      d.resolve(FAKE);
    });
  });

  it('job is pending until the extractor resolves, then done', async () => {
    const d = deferred();
    const app = createApp({ fileJobs: newStore(), extractFile: () => d.promise });
    await withServer(app, async (base) => {
      const { json: { jobId } } = await submit(base);
      const pending = await call(base, `/api/file/jobs/${jobId}`);
      assert.equal(pending.status, 200);
      assert.equal(pending.headers['cache-control'], 'no-store');
      assert.deepEqual(pending.json, { status: 'pending' });

      d.resolve(FAKE);
      const done = await settled(base, jobId);
      assert.equal(done.status, 200);
      assert.equal(done.headers['cache-control'], 'no-store');
      assert.equal(done.json.status, 'done');
      assert.equal(done.json.markdown, FAKE.markdown);
      assert.equal(done.json.source, 'markitdown');
      assert.equal(done.json.shareId, null);
      assert.deepEqual(done.json.metadata, FAKE.metadata);
      assert.deepEqual(Object.keys(done.json).sort(),
        ['markdown', 'metadata', 'shareId', 'source', 'status', 'suggestedFilename']);
    });
  });

  it('ignores format for async jobs and stores the markdown', async () => {
    const app = createApp({ fileJobs: newStore(), extractFile: async () => FAKE });
    await withServer(app, async (base) => {
      const { json: { jobId } } = await submit(base, '/api/file?async=1&format=text');
      const done = await settled(base, jobId);
      assert.equal(done.json.markdown, FAKE.markdown);
    });
  });

  it('done result includes frontmatter when frontmatter=true', async () => {
    const app = createApp({ fileJobs: newStore(), extractFile: async () => FAKE });
    await withServer(app, async (base) => {
      const { json: { jobId } } = await submit(base, '/api/file?async=1&frontmatter=true');
      const done = await settled(base, jobId);
      assert.ok(done.json.markdown.startsWith('---\n'));
      assert.ok(done.json.markdown.includes('source: markitdown'));
    });
  });

  it('done result carries suggestedFilename from the uploaded name', async () => {
    let received;
    const app = createApp({
      fileJobs: newStore(),
      extractFile: async (buf, opts) => { received = opts; return { ...FAKE, metadata: { quality: 0.8 }, title: null }; },
    });
    await withServer(app, async (base) => {
      const { json: { jobId } } = await submit(base, '/api/file?async=1&lang=en&pdf=ocr', {
        'X-Filename': encodeURIComponent('Mein Memo.m4a'),
      });
      const done = await settled(base, jobId);
      assert.equal(typeof done.json.suggestedFilename, 'string');
      assert.ok(done.json.suggestedFilename.length > 3);
      assert.ok(done.json.suggestedFilename.endsWith('.md'));
      assert.equal(received.filename, 'Mein Memo.m4a');
      assert.equal(received.lang, 'en');
      assert.equal(received.pdfOcr, true);
      assert.equal(typeof received.llmAllowed, 'function');
    });
  });

  it('result stays fetchable until deleted (two GETs, then DELETE 204, then 404)', async () => {
    const app = createApp({ fileJobs: newStore(), extractFile: async () => FAKE });
    await withServer(app, async (base) => {
      const { json: { jobId } } = await submit(base);
      const first = await settled(base, jobId);
      const second = await call(base, `/api/file/jobs/${jobId}`);
      assert.equal(first.json.status, 'done');
      assert.deepEqual(second.json, first.json);

      const del = await call(base, `/api/file/jobs/${jobId}`, { method: 'DELETE' });
      assert.equal(del.status, 204);
      assert.equal(del.headers['cache-control'], 'no-store');

      const gone = await call(base, `/api/file/jobs/${jobId}`);
      assert.equal(gone.status, 404);
      assert.deepEqual(gone.json, NOT_FOUND);
    });
  });

  it('finishes the job even when the client aborted right after the 202', async () => {
    const d = deferred();
    const app = createApp({ fileJobs: newStore(), extractFile: () => d.promise });
    await withServer(app, async (base) => {
      const ac = new AbortController();
      const res = await fetch(base + '/api/file?async=1', {
        method: 'POST', headers: { 'Content-Type': 'audio/mp4' }, body: Buffer.from('m4a'), signal: ac.signal,
      });
      assert.equal(res.status, 202);
      const { jobId } = await res.json();
      ac.abort();

      d.resolve(FAKE);
      const done = await settled(base, jobId);
      assert.equal(done.json.status, 'done');
      assert.equal(done.json.markdown, FAKE.markdown);
    });
  });

  it('extractor rejection becomes status error with httpStatus 502', async (t) => {
    const errorLog = t.mock.method(console, 'error', () => {});
    const d = deferred();
    const app = createApp({ fileJobs: newStore(), extractFile: () => d.promise });
    await withServer(app, async (base) => {
      const { json: { jobId } } = await submit(base);
      d.reject(new Error('sidecar down'));
      const r = await settled(base, jobId);
      assert.equal(r.status, 200);
      assert.equal(r.json.status, 'error');
      assert.equal(r.json.httpStatus, 502);
      assert.ok(r.json.error.startsWith('Failed to convert file: '));
      assert.ok(r.json.error.includes('sidecar down'));
      assert.equal(errorLog.mock.callCount(), 1);
      assert.equal(errorLog.mock.calls[0].arguments[0], 'File conversion error:');
    });
  });

  it('a synchronous extractor throw also fails the job', async (t) => {
    t.mock.method(console, 'error', () => {});
    const app = createApp({ fileJobs: newStore(), extractFile: () => { throw new Error('boom'); } });
    await withServer(app, async (base) => {
      const { status, json: { jobId } } = await submit(base);
      assert.equal(status, 202);
      const r = await settled(base, jobId);
      assert.equal(r.json.status, 'error');
      assert.equal(r.json.httpStatus, 502);
    });
  });

  it('caps a long error message at 500 characters', async (t) => {
    t.mock.method(console, 'error', () => {});
    const app = createApp({ fileJobs: newStore(), extractFile: async () => { throw new Error('x'.repeat(5000)); } });
    await withServer(app, async (base) => {
      const { json: { jobId } } = await submit(base);
      const r = await settled(base, jobId);
      assert.equal(r.json.status, 'error');
      assert.equal(r.json.error.length, 500);
    });
  });

  it('a result that cannot be stored fails the job instead of leaving it pending', async (t) => {
    t.mock.method(console, 'error', () => {});
    const app = createApp({
      fileJobs: newStore(),
      extractFile: async () => ({ ...FAKE, metadata: { quality: 0.8, big: 1n } }),
    });
    await withServer(app, async (base) => {
      const { json: { jobId } } = await submit(base);
      const r = await settled(base, jobId);
      assert.equal(r.json.status, 'error');
      assert.equal(r.json.httpStatus, 502);
    });
  });

  it('extractor 422 rejection becomes status error with httpStatus 422 and the original message', async (t) => {
    const errorLog = t.mock.method(console, 'error', () => {});
    const msg = 'Unsupported file type. / Dateityp nicht unterstützt.';
    const app = createApp({
      fileJobs: newStore(),
      extractFile: async () => { throw Object.assign(new Error(msg), { status: 422 }); },
    });
    await withServer(app, async (base) => {
      const { json: { jobId } } = await submit(base);
      const r = await settled(base, jobId);
      assert.deepEqual(r.json, { status: 'error', error: msg, httpStatus: 422 });
      assert.equal(errorLog.mock.callCount(), 0);
    });
  });

  it('empty body with async=1 is still a synchronous 400', async () => {
    const store = newStore();
    const app = createApp({ fileJobs: store, extractFile: async () => FAKE });
    await withServer(app, async (base) => {
      const r = await submit(base, '/api/file?async=1', {}, Buffer.alloc(0));
      assert.equal(r.status, 400);
      assert.ok(r.json.error.includes('Datei-Bytes'));
      assert.equal(store.stats().jobs, 0);
    });
  });

  it('unknown, malformed and deleted ids share one 404 body', async () => {
    const app = createApp({ fileJobs: newStore(), extractFile: async () => FAKE });
    await withServer(app, async (base) => {
      const { json: { jobId } } = await submit(base);
      await settled(base, jobId);
      await call(base, `/api/file/jobs/${jobId}`, { method: 'DELETE' });

      const unknown = await call(base, `/api/file/jobs/${'0'.repeat(32)}`);
      const malformed = await call(base, '/api/file/jobs/not-a-job-id');
      const upper = await call(base, `/api/file/jobs/${jobId.toUpperCase()}`);
      const deleted = await call(base, `/api/file/jobs/${jobId}`);
      const delAgain = await call(base, `/api/file/jobs/${jobId}`, { method: 'DELETE' });
      for (const r of [unknown, malformed, upper, deleted, delAgain]) {
        assert.equal(r.status, 404);
        assert.equal(r.headers['cache-control'], 'no-store');
        assert.deepEqual(r.json, NOT_FOUND);
      }
      assert.equal(unknown.body, malformed.body);
      assert.equal(unknown.body, deleted.body);
      assert.equal(unknown.body, delAgain.body);
    });
  });

  it('falls back to a synchronous 200 when the store refuses', async () => {
    const app = createApp({ fileJobs: createFileJobStore({ ttlMs: 0 }), extractFile: async () => FAKE });
    await withServer(app, async (base) => {
      const r = await submit(base, '/api/file?async=1&format=json');
      assert.equal(r.status, 200);
      assert.equal(r.headers['x-source'], 'markitdown');
      assert.equal(r.headers['cache-control'], undefined);
      assert.equal(r.json.markdown, FAKE.markdown);
      assert.equal(r.json.jobId, undefined);
    });
  });

  it('falls back to synchronous when the client already holds 3 jobs', async () => {
    const d = deferred();
    let n = 0;
    const app = createApp({
      fileJobs: newStore(),
      extractFile: () => (++n <= 3 ? d.promise : Promise.resolve(FAKE)),
    });
    await withServer(app, async (base) => {
      for (let i = 0; i < 3; i++) {
        const r = await submit(base);
        assert.equal(r.status, 202);
      }
      const fourth = await submit(base);
      assert.equal(fourth.status, 200);
      assert.equal(fourth.headers['x-source'], 'markitdown');
      assert.ok(fourth.body.includes('# Report'));
      d.resolve(FAKE);
    });
  });

  it('without async the route never creates a job', async () => {
    const store = newStore();
    const app = createApp({ fileJobs: store, extractFile: async () => FAKE });
    await withServer(app, async (base) => {
      const r = await submit(base, '/api/file');
      assert.equal(r.status, 200);
      assert.equal(store.stats().jobs, 0);
      const other = await submit(base, '/api/file?async=0');
      assert.equal(other.status, 200);
      assert.equal(store.stats().jobs, 0);
    });
  });

  it('logs extraction for an async success with url local-file', async () => {
    const cache = createCache(':memory:');
    const app = createApp({ cache, fileJobs: newStore(), extractFile: async () => FAKE });
    await withServer(app, async (base) => {
      const { json: { jobId } } = await submit(base, '/api/file?async=1', {
        'X-Filename': encodeURIComponent('secret-tax.pdf'),
      });
      await settled(base, jobId);
      const logged = cache.db.prepare('SELECT * FROM extraction_log').all();
      assert.equal(logged.length, 1);
      assert.equal(logged[0].url, 'local-file');
      assert.ok(!JSON.stringify(logged).includes('secret-tax'));
      assert.ok(!JSON.stringify(logged).includes(jobId));
      const history = await call(base, '/api/history');
      assert.deepEqual(history.json, []);
    });
  });

  it('throttles repeated misses with 429', async () => {
    const app = createApp({
      fileJobs: newStore(),
      jobMissLimiter: createRateLimiter({ windowMs: 60_000, max: 2 }),
      extractFile: async () => FAKE,
    });
    await withServer(app, async (base) => {
      const id = 'f'.repeat(32);
      assert.equal((await call(base, `/api/file/jobs/${id}`)).status, 404);
      assert.equal((await call(base, `/api/file/jobs/${id}`, { method: 'DELETE' })).status, 404);
      const third = await call(base, `/api/file/jobs/${id}`);
      assert.equal(third.status, 429);
      assert.deepEqual(third.json, { error: 'rate_limited' });
      assert.ok(Number(third.headers['retry-after']) >= 1);
      assert.equal(third.headers['cache-control'], 'no-store');
    });
  });

  it('a hit is not counted against the miss limiter', async () => {
    const app = createApp({
      fileJobs: newStore(),
      jobMissLimiter: createRateLimiter({ windowMs: 60_000, max: 1 }),
      extractFile: async () => FAKE,
    });
    await withServer(app, async (base) => {
      const { json: { jobId } } = await submit(base);
      await settled(base, jobId);
      for (let i = 0; i < 3; i++) {
        assert.equal((await call(base, `/api/file/jobs/${jobId}`)).status, 200);
      }
      assert.equal((await call(base, `/api/file/jobs/${jobId}`, { method: 'DELETE' })).status, 204);
      assert.equal((await call(base, `/api/file/jobs/${'0'.repeat(32)}`)).status, 404);
      assert.equal((await call(base, `/api/file/jobs/${'0'.repeat(32)}`)).status, 429);
    });
  });
});

describe('file job ownership (multi-user)', () => {
  const fastOpts = { timeCost: 1, memoryCost: 1024, parallelism: 1 };

  async function withAuthApp(fn) {
    const cache = createCache(':memory:');
    const auth = createAuth({
      db: cache.db, mode: 'multi-user',
      env: { PULLMD_ADMIN_EMAIL: 'a@b.c', PULLMD_ADMIN_PASSWORD: 'pw1234567' },
      argon2Opts: fastOpts,
    });
    await auth.runMigration();
    const userA = cache.db.prepare('SELECT id FROM users').get().id;
    const userB = (await auth.createUser({ email: 'b@b.c', password: 'pw1234567' })).id;
    const keyA = auth.createApiKey(userA, 'a').fullKey;
    const keyB = auth.createApiKey(userB, 'b').fullKey;
    const app = createApp({ cache, auth, fileJobs: newStore(), extractFile: async () => FAKE });
    return withServer(app, (base) => fn(base, {
      a: { Authorization: `Bearer ${keyA}` },
      b: { Authorization: `Bearer ${keyB}` },
    }));
  }

  it('user B gets 404 for user A\'s job on GET and DELETE, A still gets the result', async () => {
    await withAuthApp(async (base, { a, b }) => {
      const sub = await submit(base, '/api/file?async=1', a);
      assert.equal(sub.status, 202);
      const { jobId } = sub.json;
      const own = await settled(base, jobId, a);
      assert.equal(own.json.status, 'done');

      const unknown = await call(base, `/api/file/jobs/${'0'.repeat(32)}`, { headers: b });
      const foreignGet = await call(base, `/api/file/jobs/${jobId}`, { headers: b });
      const foreignDel = await call(base, `/api/file/jobs/${jobId}`, { method: 'DELETE', headers: b });
      for (const r of [foreignGet, foreignDel]) {
        assert.equal(r.status, 404);
        assert.equal(r.body, unknown.body);
      }

      const still = await call(base, `/api/file/jobs/${jobId}`, { headers: a });
      assert.equal(still.json.status, 'done');
      assert.equal(still.json.markdown, FAKE.markdown);
      const del = await call(base, `/api/file/jobs/${jobId}`, { method: 'DELETE', headers: a });
      assert.equal(del.status, 204);
    });
  });

  it('an unauthenticated request to the job routes gets 401 in multi-user mode', async () => {
    await withAuthApp(async (base, { a }) => {
      const { json: { jobId } } = await submit(base, '/api/file?async=1', a);
      const get = await call(base, `/api/file/jobs/${jobId}`);
      const del = await call(base, `/api/file/jobs/${jobId}`, { method: 'DELETE' });
      const post = await submit(base);
      assert.equal(get.status, 401);
      assert.equal(del.status, 401);
      assert.equal(post.status, 401);
      // The job survived the unauthenticated DELETE.
      assert.equal((await settled(base, jobId, a)).json.status, 'done');
    });
  });
});
