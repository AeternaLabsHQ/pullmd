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
