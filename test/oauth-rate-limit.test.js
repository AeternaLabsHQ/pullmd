import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRateLimiter } from '../lib/oauth/rate-limit.js';

describe('rate limiter', () => {
  it('allows requests under the limit', () => {
    const rl = createRateLimiter({ windowMs: 60_000, max: 3 });
    assert.equal(rl.check('1.2.3.4'), true);
    assert.equal(rl.check('1.2.3.4'), true);
    assert.equal(rl.check('1.2.3.4'), true);
  });

  it('rejects the request after max is exceeded', () => {
    const rl = createRateLimiter({ windowMs: 60_000, max: 2 });
    assert.equal(rl.check('a'), true);
    assert.equal(rl.check('a'), true);
    assert.equal(rl.check('a'), false);
  });

  it('tracks each key independently', () => {
    const rl = createRateLimiter({ windowMs: 60_000, max: 1 });
    assert.equal(rl.check('a'), true);
    assert.equal(rl.check('b'), true);
    assert.equal(rl.check('a'), false);
  });

  it('expires window entries after windowMs (tested via injected clock)', () => {
    let now = 1_000_000;
    const rl = createRateLimiter({ windowMs: 1000, max: 1, now: () => now });
    assert.equal(rl.check('x'), true);
    assert.equal(rl.check('x'), false);
    now += 1100;
    assert.equal(rl.check('x'), true);
  });

  it('middleware returns 429 with Retry-After when over limit', async () => {
    const express = (await import('express')).default;
    const rl = createRateLimiter({ windowMs: 60_000, max: 1 });
    const app = express();
    app.get('/x', rl.middleware(), (req, res) => res.json({ ok: true }));
    const server = app.listen(0);
    try {
      const port = server.address().port;
      const r1 = await fetch(`http://127.0.0.1:${port}/x`);
      assert.equal(r1.status, 200);
      const r2 = await fetch(`http://127.0.0.1:${port}/x`);
      assert.equal(r2.status, 429);
      assert.ok(r2.headers.get('retry-after'));
    } finally {
      server.close();
    }
  });
});

describe('rate limiter key eviction', () => {
  it('sweeps keys whose window has fully expired once the map grows large', () => {
    let now = 1_000_000;
    const rl = createRateLimiter({ windowMs: 1000, max: 5, now: () => now });
    for (let i = 0; i < 10_000; i++) rl.check(`ip-${i}`);
    assert.equal(rl.size(), 10_000);
    now += 2000;
    rl.check('fresh');
    assert.equal(rl.size(), 1);
  });

  it('keeps keys that still have live timestamps during a sweep', () => {
    let now = 1_000_000;
    const rl = createRateLimiter({ windowMs: 1000, max: 5, now: () => now });
    for (let i = 0; i < 9_999; i++) rl.check(`old-${i}`);
    now += 500;
    rl.check('young');
    now += 700;
    rl.check('trigger');
    assert.equal(rl.size(), 2);
  });
});
