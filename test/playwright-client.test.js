import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { renderViaSidecar } from '../lib/playwright-client.js';

describe('renderViaSidecar', () => {
  let originalEnv;
  beforeEach(() => { originalEnv = process.env.PLAYWRIGHT_URL; });
  afterEach(()  => { process.env.PLAYWRIGHT_URL = originalEnv; });

  it('throws when PLAYWRIGHT_URL is not set', async () => {
    delete process.env.PLAYWRIGHT_URL;
    await assert.rejects(
      () => renderViaSidecar('https://example.com'),
      /not configured/i,
    );
  });

  it('returns rendered HTML on 200 OK', async () => {
    process.env.PLAYWRIGHT_URL = 'http://playwright:8002/render';
    const fetchStub = async (url, opts) => {
      assert.equal(url, 'http://playwright:8002/render');
      assert.equal(opts.method, 'POST');
      assert.equal(JSON.parse(opts.body).url, 'https://example.com');
      return { ok: true, status: 200, text: async () => '<html><body><h1>Rendered</h1></body></html>' };
    };
    const html = await renderViaSidecar('https://example.com', { fetch: fetchStub });
    assert.match(html, /<h1>Rendered<\/h1>/);
  });

  it('throws on non-2xx response', async () => {
    process.env.PLAYWRIGHT_URL = 'http://playwright:8002/render';
    const fetchStub = async () => ({ ok: false, status: 503, text: async () => 'busy' });
    await assert.rejects(
      () => renderViaSidecar('https://example.com', { fetch: fetchStub }),
      /503/,
    );
  });

  it('forwards external AbortSignal to underlying fetch', async () => {
    process.env.PLAYWRIGHT_URL = 'http://playwright:8002/render';
    const ctrl = new AbortController();
    const fetchStub = async (_url, opts) => {
      // Trigger the user's abort while fetch is "in flight"
      ctrl.abort();
      // Inner fetch sees the aborted internal signal
      assert.equal(opts.signal.aborted, true);
      const err = new Error('aborted');
      err.name = 'AbortError';
      throw err;
    };
    await assert.rejects(
      () => renderViaSidecar('https://example.com', { fetch: fetchStub, signal: ctrl.signal }),
      /aborted/i,
    );
  });
});

describe('renderViaSidecar — recipe-driven options', () => {
  it('forwards waitFor, waitTimeoutMs, mobileUa in POST body', async () => {
    let captured;
    const mockFetch = async (url, opts) => {
      captured = JSON.parse(opts.body);
      return { ok: true, text: async () => '<html></html>' };
    };
    process.env.PLAYWRIGHT_URL = 'http://sidecar.test/';
    const { renderViaSidecar } = await import('../lib/playwright-client.js');
    await renderViaSidecar('https://example.com/', {
      fetch: mockFetch,
      waitFor: '.x',
      waitTimeoutMs: 2500,
      mobileUa: true,
    });
    assert.equal(captured.url, 'https://example.com/');
    assert.equal(captured.waitFor, '.x');
    assert.equal(captured.waitTimeoutMs, 2500);
    assert.equal(captured.mobileUa, true);
  });

  it('emits only url when no recipe options set (backwards compat)', async () => {
    let captured;
    const mockFetch = async (url, opts) => {
      captured = JSON.parse(opts.body);
      return { ok: true, text: async () => '<html></html>' };
    };
    process.env.PLAYWRIGHT_URL = 'http://sidecar.test/';
    const { renderViaSidecar } = await import('../lib/playwright-client.js');
    await renderViaSidecar('https://example.com/', { fetch: mockFetch });
    assert.deepEqual(Object.keys(captured), ['url']);
  });

  it('forwards userAgent in POST body when set', async () => {
    let captured;
    const mockFetch = async (url, opts) => {
      captured = JSON.parse(opts.body);
      return { ok: true, text: async () => '<html></html>' };
    };
    process.env.PLAYWRIGHT_URL = 'http://sidecar.test/';
    const { renderViaSidecar } = await import('../lib/playwright-client.js');
    await renderViaSidecar('https://example.com/', {
      fetch: mockFetch,
      userAgent: 'Mozilla/5.0 (Test) Test/1.0',
    });
    assert.equal(captured.userAgent, 'Mozilla/5.0 (Test) Test/1.0');
  });
});
