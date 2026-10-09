import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createApp, parseTrustProxy } from '../server.js';
import { createCache } from '../lib/cache.js';
import { createAuth } from '../lib/auth.js';
import { createOAuthStore } from '../lib/oauth/store.js';
import { createRateLimiter } from '../lib/oauth/rate-limit.js';
import { createLlmBudget } from '../lib/llm/budget.js';
import { extractWeb, extractFile } from '../lib/web.js';

const fastOpts = { timeCost: 1, memoryCost: 1024, parallelism: 1 };

async function withServer(app, fn) {
  const server = createServer(app);
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    return await fn(base);
  } finally {
    server.close();
  }
}

function makeAuth(mode, opts = {}) {
  const cache = createCache(':memory:');
  const auth = createAuth({
    db: cache.db, mode,
    env: { PULLMD_ADMIN_EMAIL: 'admin@x.y', PULLMD_ADMIN_PASSWORD: 'adminpass1' },
    argon2Opts: fastOpts,
    ...opts,
  });
  return { cache, auth };
}

function postForm(base, path, body, headers = {}) {
  return fetch(base + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers },
    body,
    redirect: 'manual',
  });
}

describe('PULLMD_TRUST_PROXY parsing', () => {
  for (const v of [undefined, null, '', '  ', 'false', 'FALSE', 'off', 'no', '0']) {
    it(`treats ${JSON.stringify(v)} as off`, () => {
      assert.equal(parseTrustProxy(v), false);
    });
  }

  for (const v of ['true', 'TRUE', ' true ', 'yes', 'on']) {
    it(`treats ${JSON.stringify(v)} as trust-all`, () => {
      assert.equal(parseTrustProxy(v), true);
    });
  }

  it('maps a plain integer to a hop count', () => {
    assert.equal(parseTrustProxy('1'), 1);
    assert.equal(parseTrustProxy(' 2 '), 2);
  });

  it('maps a comma-separated list to an array of entries', () => {
    assert.deepEqual(parseTrustProxy('loopback, 10.0.0.0/8 ,,172.16.0.1'), ['loopback', '10.0.0.0/8', '172.16.0.1']);
  });

  it('createApp falls back to off when the configured list is not valid', () => {
    const app = createApp({ trustProxy: ['definitely-not-an-address'] });
    const fn = app.get('trust proxy fn');
    assert.equal(fn('203.0.113.1', 0), false);
  });
});

describe('client address for rate limiting', () => {
  it('without trust proxy, a changing X-Forwarded-For shares one bucket', async () => {
    const cache = createCache(':memory:');
    const app = createApp({ cache, shareMissLimiter: createRateLimiter({ windowMs: 60_000, max: 2 }) });
    await withServer(app, async (base) => {
      const miss = (xff) => fetch(`${base}/s/${'0'.repeat(32)}`, { headers: { 'x-forwarded-for': xff } });
      assert.equal((await miss('203.0.113.1')).status, 404);
      assert.equal((await miss('203.0.113.2')).status, 404);
      assert.equal((await miss('203.0.113.3')).status, 429);
    });
  });

  it('with one trusted hop, the address added by that hop selects the bucket', async () => {
    const cache = createCache(':memory:');
    const app = createApp({ cache, trustProxy: 1, shareMissLimiter: createRateLimiter({ windowMs: 60_000, max: 1 }) });
    await withServer(app, async (base) => {
      const miss = (xff) => fetch(`${base}/s/${'0'.repeat(32)}`, { headers: { 'x-forwarded-for': xff } });
      assert.equal((await miss('198.51.100.7, 203.0.113.9')).status, 404);
      // Same rightmost entry, different leftmost one: same client.
      assert.equal((await miss('198.51.100.8, 203.0.113.9')).status, 429);
      // A different client behind the same proxy has its own bucket.
      assert.equal((await miss('203.0.113.10')).status, 404);
    });
  });
});

describe('session cookie Secure flag', () => {
  async function loginCookie(trustProxy) {
    const { cache, auth } = makeAuth('multi-user');
    await auth.runMigration();
    const app = createApp({ cache, auth, ...(trustProxy !== undefined && { trustProxy }) });
    return withServer(app, async (base) => {
      const r = await postForm(base, '/login', 'email=admin@x.y&password=adminpass1', { 'x-forwarded-proto': 'https' });
      assert.equal(r.status, 302);
      return (r.headers.getSetCookie?.() || []).find((c) => c.startsWith('pullmd_session='));
    });
  }

  it('is set when a trusted proxy reports https', async () => {
    assert.match(await loginCookie(1), /;\s*Secure/);
  });

  it('is not derived from X-Forwarded-Proto without trust proxy', async () => {
    assert.doesNotMatch(await loginCookie(undefined), /;\s*Secure/);
  });
});

describe('login and signup rate limits', () => {
  it('POST /login answers 429 with the login page once the limit is reached', async () => {
    const { cache, auth } = makeAuth('multi-user', {
      limits: { login: createRateLimiter({ windowMs: 60_000, max: 2 }) },
    });
    await auth.runMigration();
    const app = createApp({ cache, auth });
    await withServer(app, async (base) => {
      assert.equal((await postForm(base, '/login', 'email=admin@x.y&password=wrongpass1')).status, 401);
      assert.equal((await postForm(base, '/login', 'email=admin@x.y&password=wrongpass1')).status, 401);
      const r = await postForm(base, '/login', 'email=admin@x.y&password=adminpass1');
      assert.equal(r.status, 429);
      assert.ok(Number(r.headers.get('retry-after')) >= 1);
      assert.match(r.headers.get('content-type'), /html/);
      const body = await r.text();
      assert.match(body, /Too many attempts/);
      assert.match(body, /<form[^>]+action="\/login"/);
      assert.equal((r.headers.getSetCookie?.() || []).some((c) => c.startsWith('pullmd_session=')), false);
    });
  });

  it('POST /signup answers 429 with the signup page once the limit is reached', async () => {
    const { cache, auth } = makeAuth('multi-user', {
      limits: { signup: createRateLimiter({ windowMs: 60_000, max: 1 }) },
    });
    await auth.runMigration();
    const app = createApp({ cache, auth });
    await withServer(app, async (base) => {
      const ok = await postForm(base, '/signup', 'email=u1@x.y&password=password1&password_confirm=password1');
      assert.equal(ok.status, 302);
      const r = await postForm(base, '/signup', 'email=u2@x.y&password=password1&password_confirm=password1');
      assert.equal(r.status, 429);
      assert.ok(Number(r.headers.get('retry-after')) >= 1);
      const body = await r.text();
      assert.match(body, /Too many attempts/);
      assert.match(body, /<form[^>]+action="\/signup"/);
      const row = cache.db.prepare('SELECT 1 FROM users WHERE email = ?').get('u2@x.y');
      assert.equal(row, undefined);
    });
  });

  it('uses default limits when none are injected', () => {
    const { auth } = makeAuth('multi-user');
    assert.equal(typeof auth.limits.login.check, 'function');
    assert.equal(typeof auth.limits.signup.check, 'function');
  });
});

describe('dynamic client registration housekeeping', () => {
  const reg = (store) => store.registerClient({
    redirect_uris: ['https://claude.ai/api/mcp/auth_callback'],
    client_name: 'c',
    token_endpoint_auth_method: 'none',
  });

  it('removes clients older than a day that never obtained a token', () => {
    const cache = createCache(':memory:');
    const store = createOAuthStore({ db: cache.db });
    const stale = reg(store).client_id;
    const used = reg(store).client_id;
    const fresh = reg(store).client_id;
    cache.db.prepare("UPDATE oauth_clients SET created_at = datetime('now', '-2 days') WHERE client_id IN (?, ?)").run(stale, used);
    cache.db.prepare("UPDATE oauth_clients SET last_used_at = datetime('now', '-1 day') WHERE client_id = ?").run(used);
    reg(store);
    assert.equal(store.getClient(stale), null);
    assert.ok(store.getClient(used));
    assert.ok(store.getClient(fresh));
  });
});

describe('paid media tier budget', () => {
  const imgFetch = () => async () => ({
    ok: true, status: 200,
    headers: { get: (h) => (h.toLowerCase() === 'content-type' ? 'image/jpeg' : null) },
    arrayBuffer: async () => Buffer.from('JPEGBYTES').buffer,
  });

  it('extractWeb skips the caption provider and marks the result non-cacheable when the budget is used up', async () => {
    let called = false;
    const kinds = [];
    const result = await extractWeb('https://example.com/photo.jpg', {
      fetch: imgFetch(),
      captionFn: async () => { called = true; return { markdown: 'caption', usage: null }; },
      llmAllowed: (kind) => { kinds.push(kind); return false; },
    });
    assert.equal(called, false);
    assert.deepEqual(kinds, ['image']);
    assert.notEqual(result.source, 'image-caption');
    assert.equal(result.noStore, true);
  });

  it('extractWeb uses the provider and stays cacheable while the budget allows', async () => {
    const result = await extractWeb('https://example.com/photo.jpg', {
      fetch: imgFetch(),
      captionFn: async () => ({ markdown: 'caption', usage: null }),
      llmAllowed: () => true,
    });
    assert.equal(result.source, 'image-caption');
    assert.ok(!result.noStore);
  });

  it('extractFile falls back to markitdown for PDF OCR when the budget is used up', async () => {
    const r = await extractFile(Buffer.from('%PDF-1.4'), {
      filename: 'doc.pdf', contentType: 'application/pdf', pdfOcr: true,
      ocrFn: async () => { throw new Error('provider must not be called'); },
      markitdownClient: async () => ({ markdown: 'plain doc', title: 'Doc' }),
      llmAllowed: (kind) => kind !== 'pdf',
    });
    assert.equal(r.source, 'markitdown');
  });

  it('budget keys on the user when logged in, else on the client address, and ignores unconfigured tiers', () => {
    const budget = createLlmBudget({
      limiter: createRateLimiter({ windowMs: 60_000, max: 1 }),
      isConfigured: (kind) => kind !== 'audio',
    });
    const anon = { ip: '203.0.113.5' };
    const user = { ip: '203.0.113.5', user: { id: 7 } };
    assert.equal(budget.forRequest(anon)('image'), true);
    assert.equal(budget.forRequest(anon)('pdf'), false);
    assert.equal(budget.forRequest(user)('image'), true);
    assert.equal(budget.forRequest(user)('image'), false);
    // Unconfigured tier never consumes budget.
    assert.equal(budget.forRequest(anon)('audio'), true);
  });

  it('/api hands extractWeb a per-request budget check', async () => {
    const seen = [];
    const llmBudget = createLlmBudget({ limiter: createRateLimiter({ windowMs: 60_000, max: 1 }), isConfigured: () => true });
    const app = createApp({
      llmBudget,
      extractWeb: async (url, opts) => {
        seen.push(opts.llmAllowed('image'));
        return { markdown: '# x', title: 'x', source: 'readability', metadata: {} };
      },
    });
    await withServer(app, async (base) => {
      await fetch(`${base}/api?url=${encodeURIComponent('https://example.com/a.jpg')}`);
      await fetch(`${base}/api?url=${encodeURIComponent('https://example.com/b.jpg')}`);
    });
    assert.deepEqual(seen, [true, false]);
  });

  it('MCP read_url hands extractWeb a per-request budget check', async () => {
    const seen = [];
    const llmBudget = createLlmBudget({ limiter: createRateLimiter({ windowMs: 60_000, max: 1 }), isConfigured: () => true });
    const app = createApp({
      llmBudget,
      extractWeb: async (url, opts) => {
        seen.push(opts.llmAllowed('image'));
        return { markdown: '# x', title: 'x', source: 'readability', metadata: {} };
      },
    });
    await withServer(app, async (base) => {
      for (const u of ['https://example.com/a.jpg', 'https://example.com/b.jpg']) {
        await fetch(`${base}/mcp`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'read_url', arguments: { url: u } } }),
        }).then((r) => r.text());
      }
    });
    assert.deepEqual(seen, [true, false]);
  });

  it('/api/file hands extractFile a per-request budget check', async () => {
    const seen = [];
    const llmBudget = createLlmBudget({ limiter: createRateLimiter({ windowMs: 60_000, max: 1 }), isConfigured: () => true });
    const app = createApp({
      llmBudget,
      extractFile: async (buf, opts) => {
        seen.push(opts.llmAllowed('pdf'));
        return { markdown: '# x', title: 'x', source: 'markitdown', metadata: {} };
      },
    });
    await withServer(app, async (base) => {
      for (let i = 0; i < 2; i++) {
        await fetch(`${base}/api/file?filename=a.pdf&pdf=ocr`, { method: 'POST', headers: { 'Content-Type': 'application/pdf' }, body: '%PDF-1.4' });
      }
    });
    assert.deepEqual(seen, [true, false]);
  });
});
