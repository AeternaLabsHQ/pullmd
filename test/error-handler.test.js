import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from './helpers/fake-dns.js';
import { createCache } from '../lib/cache.js';
import { finalErrorHandler } from '../lib/error-handler.js';

const LEAK = /node_modules|\/home\/|at \w+ \(/;

async function withApp(fn, opts = {}) {
  const app = createApp({ cache: createCache(':memory:'), ...opts });
  const server = app.listen(0);
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    server.close();
  }
}

describe('final error handler', () => {
  it('answers invalid JSON on POST /mcp as 400 JSON without a stack', async () => {
    await withApp(async (base) => {
      const r = await fetch(base + '/mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{bad',
      });
      const text = await r.text();
      assert.equal(r.status, 400);
      assert.match(r.headers.get('content-type'), /json/);
      assert.equal(JSON.parse(text).code, 'invalid_body');
      assert.doesNotMatch(text, LEAK);
    });
  });

  it('answers an unexpected throw as 500 JSON without leaking the message', async () => {
    // GET /api/archive has no try/catch, so a failing cache reaches next(err).
    const cache = createCache(':memory:');
    cache.historyPage = () => { throw new Error('boom /secret/path'); };
    const origError = console.error;
    const logged = [];
    console.error = (...args) => { logged.push(args.join(' ')); };
    try {
      await withApp(async (base) => {
        const r = await fetch(base + '/api/archive');
        const text = await r.text();
        assert.equal(r.status, 500);
        assert.match(r.headers.get('content-type'), /json/);
        assert.equal(JSON.parse(text).code, 'internal_error');
        assert.doesNotMatch(text, /secret\/path/);
        assert.doesNotMatch(text, LEAK);
      }, { cache });
    } finally {
      console.error = origError;
    }
    assert.ok(logged.some((l) => l.includes('/api/archive') && l.includes('boom /secret/path')));
  });

  it('keeps the 413 message and adds a code', async () => {
    await withApp(async (base) => {
      const r = await fetch(base + '/api/html', {
        method: 'POST',
        headers: { 'Content-Type': 'text/html' },
        body: 'a'.repeat(10 * 1024 * 1024 + 1024),
      });
      assert.equal(r.status, 413);
      const body = await r.json();
      assert.equal(body.error, 'File too large (max 10 MB). / Datei zu groß (max. 10 MB).');
      assert.equal(body.code, 'payload_too_large');
    });
  });

  it('keeps other 4xx statuses with a generic message', () => {
    const res = fakeRes();
    const err = Object.assign(new Error('secret detail /home/x'), { status: 415 });
    finalErrorHandler(err, { method: 'GET', path: '/x' }, res, () => assert.fail('next'));
    assert.equal(res.statusCode, 415);
    assert.equal(res.body.code, 'bad_request');
    assert.doesNotMatch(JSON.stringify(res.body), /secret/);
  });

  it('hands over to next(err) and writes nothing when headers are already sent', () => {
    const res = fakeRes();
    res.headersSent = true;
    const err = new Error('late');
    let passed;
    finalErrorHandler(err, { method: 'GET', path: '/x' }, res, (e) => { passed = e; });
    assert.equal(passed, err);
    assert.equal(res.body, undefined);
    assert.equal(res.statusCode, undefined);
  });
});

function fakeRes() {
  return {
    headersSent: false,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}
