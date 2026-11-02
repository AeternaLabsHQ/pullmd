import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { healthUrl, createStatusChecker, MIN_PLAYWRIGHT_POLICY } from '../lib/status.js';

const ENV = {
  TRAFILATURA_URL: 'http://trafilatura:8001/extract',
  PLAYWRIGHT_URL: 'http://playwright:8002/render',
  MARKITDOWN_URL: 'http://markitdown:8003/convert',
};

// What a current sidecar reports. Only Playwright is checked for `policy`,
// the others ignore the extra field.
const HEALTHY_BODY = { ok: true, policy: { ssrf: MIN_PLAYWRIGHT_POLICY } };

// Minimal Response stand-in: the checker only reads ok/status/json().
const reply = (body = HEALTHY_BODY, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

function fakeFetch(handler) {
  const calls = [];
  const fn = async (url, opts) => {
    calls.push(url);
    return handler(url, opts);
  };
  fn.calls = calls;
  return fn;
}

describe('healthUrl', () => {
  it('swaps the endpoint path segment for /health', () => {
    assert.equal(healthUrl('http://playwright:8002/render'), 'http://playwright:8002/health');
    assert.equal(healthUrl('http://trafilatura:8001/extract'), 'http://trafilatura:8001/health');
    assert.equal(healthUrl('http://markitdown:8003/convert'), 'http://markitdown:8003/health');
  });

  it('keeps a nested base path', () => {
    assert.equal(healthUrl('http://host/sidecar/v1/render'), 'http://host/sidecar/v1/health');
  });

  it('handles a trailing slash and a bare origin', () => {
    assert.equal(healthUrl('http://host:8002/'), 'http://host:8002/health');
    assert.equal(healthUrl('http://host:8002'), 'http://host:8002/health');
  });

  it('drops query and hash', () => {
    assert.equal(healthUrl('http://host/render?debug=1#x'), 'http://host/health');
  });
});

describe('createStatusChecker', () => {
  it('reports every configured sidecar as ok when all answer', async () => {
    const fetch = fakeFetch(() => reply());
    const status = await createStatusChecker({ fetch, env: ENV })();

    assert.equal(status.ok, true);
    assert.deepEqual(Object.keys(status.services), ['trafilatura', 'playwright', 'markitdown']);
    for (const svc of Object.values(status.services)) {
      assert.equal(svc.status, 'ok');
      assert.equal(typeof svc.latencyMs, 'number');
    }
    assert.equal(typeof status.version, 'string');
  });

  it('probes the /health path, not the working endpoint', async () => {
    const fetch = fakeFetch(() => reply());
    await createStatusChecker({ fetch, env: ENV })();

    assert.deepEqual(fetch.calls.sort(), [
      'http://markitdown:8003/health',
      'http://playwright:8002/health',
      'http://trafilatura:8001/health',
    ]);
  });

  it('marks an unreachable sidecar down and flips the top-level ok', async () => {
    const fetch = fakeFetch((url) => {
      if (url.includes('playwright')) throw new TypeError('fetch failed');
      return reply();
    });
    const status = await createStatusChecker({ fetch, env: ENV })();

    assert.equal(status.ok, false);
    assert.deepEqual(status.services.playwright, { status: 'down', error: 'unreachable' });
    assert.equal(status.services.trafilatura.status, 'ok');
  });

  it('distinguishes a timeout from an unreachable host', async () => {
    const fetch = fakeFetch((url) => {
      if (url.includes('playwright')) {
        const err = new Error('The operation was aborted due to timeout');
        err.name = 'TimeoutError';
        throw err;
      }
      return reply();
    });
    const status = await createStatusChecker({ fetch, env: ENV })();

    assert.equal(status.services.playwright.error, 'timeout');
  });

  it('reports a non-2xx health response with its status code', async () => {
    const fetch = fakeFetch((url) => (url.includes('markitdown') ? reply({}, 502) : reply()));
    const status = await createStatusChecker({ fetch, env: ENV })();

    assert.equal(status.ok, false);
    assert.equal(status.services.markitdown.status, 'down');
    assert.equal(status.services.markitdown.error, 'http 502');
  });

  it('treats a 200 with ok:false as unhealthy', async () => {
    // What a Playwright sidecar returns when the browser failed to launch.
    const fetch = fakeFetch((url) =>
      (url.includes('playwright') ? reply({ ok: false, browser: null }) : reply()));
    const status = await createStatusChecker({ fetch, env: ENV })();

    assert.equal(status.ok, false);
    assert.equal(status.services.playwright.error, 'unhealthy');
  });

  it('accepts a 200 whose body is not JSON', async () => {
    const fetch = fakeFetch(() => ({
      ok: true,
      status: 200,
      json: async () => { throw new SyntaxError('Unexpected token'); },
    }));
    const status = await createStatusChecker({
      fetch,
      env: { TRAFILATURA_URL: ENV.TRAFILATURA_URL, MARKITDOWN_URL: ENV.MARKITDOWN_URL },
    })();

    assert.equal(status.ok, true);
    assert.equal(status.services.trafilatura.status, 'ok');
  });

  it('accepts a Playwright sidecar that reports the address policy', async () => {
    const fetch = fakeFetch(() => reply());
    const status = await createStatusChecker({ fetch, env: ENV })();

    assert.equal(status.ok, true);
    assert.equal(status.services.playwright.status, 'ok');
  });

  it('flags a Playwright sidecar without the policy as degraded', async () => {
    // A pullmd-playwright image from before v3.15.2: healthy, renders fine,
    // but follows redirects into internal hosts (GHSA-26wr-prg5-vr77).
    const fetch = fakeFetch((url) => (url.includes('playwright')
      ? reply({ ok: true, playwright: '1.49.0', browser: 'chromium' })
      : reply()));
    const status = await createStatusChecker({ fetch, env: ENV })();

    assert.equal(status.ok, false);
    assert.equal(status.services.playwright.status, 'degraded');
    assert.equal(status.services.playwright.error, 'policy-missing');
    assert.equal(typeof status.services.playwright.latencyMs, 'number');
    assert.equal(status.services.trafilatura.status, 'ok');
  });

  it('rejects malformed or too-old policy markers', async () => {
    for (const policy of [{ ssrf: 0 }, { ssrf: '1' }, { ssrf: true }, { ssrf: 0.5 }, {}, 'enforced', null]) {
      const fetch = fakeFetch(() => reply({ ok: true, policy }));
      const status = await createStatusChecker({ fetch, env: { PLAYWRIGHT_URL: ENV.PLAYWRIGHT_URL } })();
      assert.equal(status.services.playwright.status, 'degraded', JSON.stringify(policy));
    }
  });

  it('accepts a newer policy revision', async () => {
    const fetch = fakeFetch(() => reply({ ok: true, policy: { ssrf: MIN_PLAYWRIGHT_POLICY + 1 } }));
    const status = await createStatusChecker({ fetch, env: { PLAYWRIGHT_URL: ENV.PLAYWRIGHT_URL } })();

    assert.equal(status.services.playwright.status, 'ok');
  });

  it('treats a non-JSON Playwright health body as policy-missing', async () => {
    const fetch = fakeFetch(() => ({
      ok: true,
      status: 200,
      json: async () => { throw new SyntaxError('Unexpected token'); },
    }));
    const status = await createStatusChecker({ fetch, env: { PLAYWRIGHT_URL: ENV.PLAYWRIGHT_URL } })();

    assert.equal(status.ok, false);
    assert.equal(status.services.playwright.error, 'policy-missing');
  });

  it('reports unhealthy before policy-missing', async () => {
    // A browser that failed to launch is the more urgent problem.
    const fetch = fakeFetch(() => reply({ ok: false, browser: null }));
    const status = await createStatusChecker({ fetch, env: { PLAYWRIGHT_URL: ENV.PLAYWRIGHT_URL } })();

    assert.deepEqual(
      { status: status.services.playwright.status, error: status.services.playwright.error },
      { status: 'down', error: 'unhealthy' },
    );
  });

  it('does not expect a policy from trafilatura or markitdown', async () => {
    const fetch = fakeFetch(() => reply({ ok: true }));
    const status = await createStatusChecker({
      fetch,
      env: { TRAFILATURA_URL: ENV.TRAFILATURA_URL, MARKITDOWN_URL: ENV.MARKITDOWN_URL },
    })();

    assert.equal(status.ok, true);
  });

  it('calls an unconfigured sidecar not-configured and keeps ok true', async () => {
    const fetch = fakeFetch(() => reply());
    const status = await createStatusChecker({
      fetch,
      env: { TRAFILATURA_URL: ENV.TRAFILATURA_URL },
    })();

    assert.equal(status.ok, true);
    assert.deepEqual(status.services.playwright, { status: 'not-configured' });
    assert.deepEqual(status.services.markitdown, { status: 'not-configured' });
    assert.equal(fetch.calls.length, 1);
  });

  it('reports a malformed sidecar URL as misconfigured', async () => {
    const fetch = fakeFetch(() => reply());
    const status = await createStatusChecker({
      fetch,
      env: { ...ENV, PLAYWRIGHT_URL: 'not a url' },
    })();

    assert.equal(status.ok, false);
    assert.deepEqual(status.services.playwright, { status: 'down', error: 'misconfigured' });
  });

  it('never leaks the sidecar URL into the error field', async () => {
    const fetch = fakeFetch(() => { throw new Error('getaddrinfo ENOTFOUND playwright'); });
    const status = await createStatusChecker({ fetch, env: ENV })();

    assert.equal(JSON.stringify(status).includes('playwright:8002'), false);
    assert.equal(JSON.stringify(status).includes('ENOTFOUND'), false);
  });

  it('serves a second call from cache within the TTL', async () => {
    const fetch = fakeFetch(() => reply());
    let clock = 1000;
    const check = createStatusChecker({ fetch, env: ENV, ttlMs: 5000, now: () => clock });

    await check();
    clock += 4999;
    await check();

    assert.equal(fetch.calls.length, 3, 'three sidecars probed exactly once');
  });

  it('re-probes once the TTL has expired', async () => {
    const fetch = fakeFetch(() => reply());
    let clock = 1000;
    const check = createStatusChecker({ fetch, env: ENV, ttlMs: 5000, now: () => clock });

    await check();
    clock += 5001;
    await check();

    assert.equal(fetch.calls.length, 6);
  });

  it('coalesces concurrent calls into one round of probes', async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    const fetch = fakeFetch(async () => { await gate; return reply(); });
    const check = createStatusChecker({ fetch, env: ENV });

    const both = Promise.all([check(), check()]);
    release();
    const [a, b] = await both;

    assert.equal(fetch.calls.length, 3);
    assert.deepEqual(a, b);
  });

  it('does not cache across a failed probe round', async () => {
    let fail = true;
    const fetch = fakeFetch(() => { if (fail) throw new TypeError('fetch failed'); return reply(); });
    let clock = 1000;
    const check = createStatusChecker({ fetch, env: ENV, ttlMs: 5000, now: () => clock });

    assert.equal((await check()).ok, false);
    fail = false;
    clock += 5001;
    assert.equal((await check()).ok, true);
  });
});
