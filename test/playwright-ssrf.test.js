import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderViaSidecar } from '../lib/playwright-client.js';
import { SsrfError } from '../lib/ssrf.js';

test('renderViaSidecar refuses a blocked URL before calling the sidecar', async () => {
  const prev = process.env.PLAYWRIGHT_URL;
  process.env.PLAYWRIGHT_URL = 'http://sidecar.local/render';
  let called = false;
  const fetchFn = async () => { called = true; return new Response('<html></html>'); };
  try {
    await assert.rejects(
      () => renderViaSidecar('http://169.254.169.254/', { fetch: fetchFn }),
      SsrfError,
    );
    assert.equal(called, false);
  } finally {
    if (prev === undefined) delete process.env.PLAYWRIGHT_URL;
    else process.env.PLAYWRIGHT_URL = prev;
  }
});

test('renderViaSidecar forwards PULLMD_ALLOWED_HOSTS to the sidecar', async () => {
  const prevUrl = process.env.PLAYWRIGHT_URL;
  const prevAllow = process.env.PULLMD_ALLOWED_HOSTS;
  process.env.PLAYWRIGHT_URL = 'http://sidecar.local/render';
  process.env.PULLMD_ALLOWED_HOSTS = '10.0.5.0/24,wiki.internal';
  let sent;
  const fetchFn = async (_u, init) => { sent = JSON.parse(init.body); return new Response('<html></html>'); };
  try {
    await renderViaSidecar('https://example.com/', { fetch: fetchFn });
    assert.equal(sent.allowedHosts, '10.0.5.0/24,wiki.internal');
  } finally {
    if (prevUrl === undefined) delete process.env.PLAYWRIGHT_URL; else process.env.PLAYWRIGHT_URL = prevUrl;
    if (prevAllow === undefined) delete process.env.PULLMD_ALLOWED_HOSTS; else process.env.PULLMD_ALLOWED_HOSTS = prevAllow;
  }
});

test('renderViaSidecar omits allowedHosts when PULLMD_ALLOWED_HOSTS is unset', async () => {
  const prevUrl = process.env.PLAYWRIGHT_URL;
  const prevAllow = process.env.PULLMD_ALLOWED_HOSTS;
  process.env.PLAYWRIGHT_URL = 'http://sidecar.local/render';
  delete process.env.PULLMD_ALLOWED_HOSTS;
  let sent;
  const fetchFn = async (_u, init) => { sent = JSON.parse(init.body); return new Response('<html></html>'); };
  try {
    await renderViaSidecar('https://example.com/', { fetch: fetchFn });
    assert.equal('allowedHosts' in sent, false);
  } finally {
    if (prevUrl === undefined) delete process.env.PLAYWRIGHT_URL; else process.env.PLAYWRIGHT_URL = prevUrl;
    if (prevAllow === undefined) delete process.env.PULLMD_ALLOWED_HOSTS; else process.env.PULLMD_ALLOWED_HOSTS = prevAllow;
  }
});

test('a sidecar 403 ssrf_blocked surfaces as SsrfError (GHSA-26wr-prg5-vr77)', async () => {
  const prev = process.env.PLAYWRIGHT_URL;
  process.env.PLAYWRIGHT_URL = 'http://sidecar.local/render';
  const fetchFn = async () => new Response(
    JSON.stringify({ detail: { code: 'ssrf_blocked', url: 'http://internal-secret:9000/', reason: 'blocked address 172.20.0.4 for host internal-secret' } }),
    { status: 403, headers: { 'content-type': 'application/json' } },
  );
  try {
    await assert.rejects(
      () => renderViaSidecar('https://example.com/redirects-inward', { fetch: fetchFn }),
      (err) => err instanceof SsrfError && /172\.20\.0\.4/.test(err.message) && /internal-secret:9000/.test(err.message),
    );
  } finally {
    if (prev === undefined) delete process.env.PLAYWRIGHT_URL; else process.env.PLAYWRIGHT_URL = prev;
  }
});

test('a sidecar 403 without the ssrf code stays a generic sidecar error', async () => {
  const prev = process.env.PLAYWRIGHT_URL;
  process.env.PLAYWRIGHT_URL = 'http://sidecar.local/render';
  const fetchFn = async () => new Response('forbidden', { status: 403 });
  try {
    await assert.rejects(
      () => renderViaSidecar('https://example.com/', { fetch: fetchFn }),
      (err) => !(err instanceof SsrfError) && /Sidecar returned 403/.test(err.message),
    );
  } finally {
    if (prev === undefined) delete process.env.PLAYWRIGHT_URL; else process.env.PLAYWRIGHT_URL = prev;
  }
});
