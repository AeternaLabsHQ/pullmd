import { test, describe, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { transcribeImages } from '../lib/embedded-images.js';

const ssrfOpts = {
  lookup: async () => [{ address: '151.101.1.140', family: 4 }],
  env: {},
};

const USAGE = { model: 'm', prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };

function imgRes(body = 'PNGDATA', { status = 200, type = 'image/png', headers = {} } = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: new Headers({ 'content-type': type, ...headers }),
    arrayBuffer: async () => new TextEncoder().encode(body).buffer,
  };
}

/** fetchFn stub that records URLs and answers per URL (default: a PNG). */
function makeFetch(map = {}) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push(String(url));
    const r = map[url];
    if (typeof r === 'function') return r(url, init);
    return r ?? imgRes();
  };
  fn.calls = calls;
  return fn;
}

function makeCaption(text = 'A chat screenshot.\n---\nHello there') {
  const calls = [];
  const fn = async (buf, opts) => {
    calls.push({ buf, opts });
    return { markdown: text, usage: USAGE };
  };
  fn.calls = calls;
  return fn;
}

const A = { url: 'https://i.redd.it/a.png', key: 'a' };
const B = { url: 'https://i.redd.it/b.png', key: 'b' };

describe('transcribeImages', () => {
  let warn;
  beforeEach(() => { warn = mock.method(console, 'warn', () => {}); });
  afterEach(() => { warn.mock.restore(); });

  test('two images succeed: transcripts, summed usage, no miss', async () => {
    const captionFn = makeCaption();
    const r = await transcribeImages([A, B], { captionFn, fetchFn: makeFetch(), ssrfOpts });
    assert.deepEqual(r.transcripts.a, { description: 'A chat screenshot.', transcript: 'Hello there' });
    assert.deepEqual(r.transcripts.b, r.transcripts.a);
    assert.equal(r.transientMiss, false);
    assert.equal(r.budgetDeferred, false);
    assert.deepEqual(r.usage, { model: 'm', prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 });
    const opts = captionFn.calls[0].opts;
    assert.equal(opts.mimetype, 'image/png');
    assert.equal(opts.raw, true);
    assert.equal(opts.maxTokens, 2000);
    assert.match(opts.prompt, /German/);
    assert.ok(opts.signal instanceof AbortSignal);
    assert.equal(captionFn.calls[0].buf.toString(), 'PNGDATA');
  });

  test('previous transcript is reused without fetch, caption or budget', async () => {
    const captionFn = makeCaption();
    const fetchFn = makeFetch();
    let allowed = 0;
    const r = await transcribeImages([A, B], {
      captionFn, fetchFn, ssrfOpts,
      llmAllowed: () => { allowed++; return true; },
      previous: { a: { description: 'old', transcript: null } },
    });
    assert.deepEqual(fetchFn.calls, [B.url]);
    assert.equal(captionFn.calls.length, 1);
    assert.equal(allowed, 1);
    assert.deepEqual(r.transcripts.a, { description: 'old', transcript: null });
    assert.ok(r.transcripts.b);
    assert.equal(r.usage.total_tokens, 15);
  });

  test('everything reused: no usage', async () => {
    const r = await transcribeImages([A], {
      captionFn: makeCaption(), fetchFn: makeFetch(), ssrfOpts,
      previous: { a: { description: 'old', transcript: 'x' } },
    });
    assert.equal(r.usage, null);
    assert.equal(r.transientMiss, false);
  });

  test('previous failed marker is carried without fetch', async () => {
    const fetchFn = makeFetch();
    const r = await transcribeImages([A], {
      captionFn: makeCaption(), fetchFn, ssrfOpts, previous: { a: { failed: true } },
    });
    assert.deepEqual(fetchFn.calls, []);
    assert.deepEqual(r.transcripts.a, { failed: true });
    assert.equal(r.transientMiss, false);
  });

  test('llmAllowed false: fetched, no caption call, transient + budget deferred, stops', async () => {
    const captionFn = makeCaption();
    const fetchFn = makeFetch();
    const r = await transcribeImages([A, B], {
      captionFn, fetchFn, ssrfOpts, llmAllowed: () => false,
    });
    assert.deepEqual(fetchFn.calls, [A.url]);
    assert.equal(captionFn.calls.length, 0);
    assert.equal(r.transientMiss, true);
    assert.equal(r.budgetDeferred, true);
    assert.deepEqual(r.transcripts, {});
    assert.equal(r.usage, null);
  });

  test('404 is a permanent miss: marker, no budget, next image still processed', async () => {
    let allowed = 0;
    const captionFn = makeCaption();
    const r = await transcribeImages([A, B], {
      captionFn, ssrfOpts,
      fetchFn: makeFetch({ [A.url]: imgRes('', { status: 404, type: 'text/html' }) }),
      llmAllowed: () => { allowed++; return true; },
    });
    assert.deepEqual(r.transcripts.a, { failed: true });
    assert.ok(r.transcripts.b.description);
    assert.equal(r.transientMiss, false);
    assert.equal(allowed, 1);
    assert.equal(captionFn.calls.length, 1);
  });

  test('5xx download is transient and does not stop the loop', async () => {
    const r = await transcribeImages([A, B], {
      captionFn: makeCaption(), ssrfOpts,
      fetchFn: makeFetch({ [A.url]: imgRes('', { status: 503 }) }),
    });
    assert.equal(r.transcripts.a, undefined);
    assert.ok(r.transcripts.b);
    assert.equal(r.transientMiss, true);
    assert.equal(r.budgetDeferred, false);
  });

  test('network error on download is transient', async () => {
    const r = await transcribeImages([A], {
      captionFn: makeCaption(), ssrfOpts,
      fetchFn: makeFetch({ [A.url]: () => { throw new Error('ECONNRESET'); } }),
    });
    assert.deepEqual(r.transcripts, {});
    assert.equal(r.transientMiss, true);
  });

  test('text/html content type is permanent and costs no budget', async () => {
    let allowed = 0;
    const r = await transcribeImages([A], {
      captionFn: makeCaption(), ssrfOpts,
      fetchFn: makeFetch({ [A.url]: imgRes('<html>', { type: 'text/html; charset=utf-8' }) }),
      llmAllowed: () => { allowed++; return true; },
    });
    assert.deepEqual(r.transcripts.a, { failed: true });
    assert.equal(r.transientMiss, false);
    assert.equal(allowed, 0);
  });

  test('image over the size cap is permanent', async () => {
    const r = await transcribeImages([A], {
      captionFn: makeCaption(), ssrfOpts,
      fetchFn: makeFetch({ [A.url]: imgRes('x', { headers: { 'content-length': String(21 * 1024 * 1024) } }) }),
    });
    assert.deepEqual(r.transcripts.a, { failed: true });
    assert.equal(r.transientMiss, false);
  });

  test('redirect to a foreign host is rejected before the foreign fetch', async () => {
    const fetchFn = makeFetch({
      [A.url]: imgRes('', { status: 302, type: 'text/plain', headers: { location: 'https://evil.example/x.png' } }),
    });
    const r = await transcribeImages([A, B], { captionFn: makeCaption(), fetchFn, ssrfOpts });
    assert.deepEqual(r.transcripts.a, { failed: true });
    assert.ok(r.transcripts.b);
    assert.ok(!fetchFn.calls.some((u) => u.includes('evil.example')));
    assert.equal(r.transientMiss, false);
  });

  test('redirect between allowed hosts is followed', async () => {
    const fetchFn = makeFetch({
      [A.url]: imgRes('', { status: 302, type: 'text/plain', headers: { location: 'https://preview.redd.it/a.png' } }),
    });
    const r = await transcribeImages([A], { captionFn: makeCaption(), fetchFn, ssrfOpts });
    assert.ok(r.transcripts.a.description);
    assert.deepEqual(fetchFn.calls, [A.url, 'https://preview.redd.it/a.png']);
  });

  test('redirect to a loopback address is rejected', async () => {
    const fetchFn = makeFetch({
      [A.url]: imgRes('', { status: 302, type: 'text/plain', headers: { location: 'http://127.0.0.1/x.png' } }),
    });
    const r = await transcribeImages([A], { captionFn: makeCaption(), fetchFn, ssrfOpts });
    assert.deepEqual(r.transcripts.a, { failed: true });
    assert.deepEqual(fetchFn.calls, [A.url]);
    assert.equal(r.transientMiss, false);
  });

  test('a first URL outside the allowlist is permanent without any fetch', async () => {
    const fetchFn = makeFetch();
    const r = await transcribeImages([{ url: 'https://evil.example/a.png', key: 'e' }], {
      captionFn: makeCaption(), fetchFn, ssrfOpts,
    });
    assert.deepEqual(r.transcripts.e, { failed: true });
    assert.deepEqual(fetchFn.calls, []);
  });

  test('caption throw is transient', async () => {
    const r = await transcribeImages([A, B], {
      fetchFn: makeFetch(), ssrfOpts,
      captionFn: async () => { throw new Error('provider 500'); },
    });
    assert.deepEqual(r.transcripts, {});
    assert.equal(r.transientMiss, true);
    assert.equal(r.budgetDeferred, false);
    assert.equal(r.usage, null);
  });

  test('null caption result (no provider) and unparseable reply are transient', async () => {
    const r1 = await transcribeImages([A], {
      fetchFn: makeFetch(), ssrfOpts, captionFn: async () => null,
    });
    assert.equal(r1.transientMiss, true);
    const r2 = await transcribeImages([A], {
      fetchFn: makeFetch(), ssrfOpts, captionFn: async () => ({ markdown: '  \n', usage: USAGE }),
    });
    assert.equal(r2.transientMiss, true);
    assert.deepEqual(r2.transcripts, {});
  });

  test('empty description with a transcript counts as success', async () => {
    const r = await transcribeImages([A], {
      fetchFn: makeFetch(), ssrfOpts, captionFn: makeCaption('---\nonly text'),
    });
    assert.deepEqual(r.transcripts.a, { description: '', transcript: 'only text' });
    assert.equal(r.transientMiss, false);
  });

  test('deadline aborts the caption and later images are not attempted', async () => {
    const calls = [];
    const captionFn = (buf, { signal }) => {
      calls.push(1);
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => resolve({ markdown: 'late', usage: USAGE }), 100);
        signal.addEventListener('abort', () => { clearTimeout(t); reject(signal.reason); }, { once: true });
      });
    };
    const fetchFn = makeFetch();
    const t0 = Date.now();
    const r = await transcribeImages([A, B], { captionFn, fetchFn, ssrfOpts, deadlineMs: 50 });
    assert.ok(Date.now() - t0 < 90);
    assert.equal(calls.length, 1);
    assert.deepEqual(fetchFn.calls, [A.url]);
    assert.equal(r.transientMiss, true);
    assert.deepEqual(r.transcripts, {});
  });

  test('deadline already passed before the first image: nothing attempted', async () => {
    const fetchFn = makeFetch();
    const r = await transcribeImages([A], {
      captionFn: makeCaption(), fetchFn, ssrfOpts, deadlineMs: 0,
    });
    assert.deepEqual(fetchFn.calls, []);
    assert.equal(r.transientMiss, true);
  });

  test('only the first max images are attempted', async () => {
    const images = Array.from({ length: 6 }, (_, i) => ({ url: `https://i.redd.it/${i}.png`, key: `k${i}` }));
    const captionFn = makeCaption();
    const r = await transcribeImages(images, { captionFn, fetchFn: makeFetch(), ssrfOpts, max: 4 });
    assert.equal(captionFn.calls.length, 4);
    assert.deepEqual(Object.keys(r.transcripts), ['k0', 'k1', 'k2', 'k3']);
  });

  test('the same key twice is processed once', async () => {
    const captionFn = makeCaption();
    const r = await transcribeImages([A, A], { captionFn, fetchFn: makeFetch(), ssrfOpts });
    assert.equal(captionFn.calls.length, 1);
    assert.deepEqual(Object.keys(r.transcripts), ['a']);
  });

  test('lang en changes the prompt', async () => {
    const captionFn = makeCaption();
    await transcribeImages([A], { captionFn, fetchFn: makeFetch(), ssrfOpts, lang: 'en' });
    assert.match(captionFn.calls[0].opts.prompt, /English/);
  });
});
