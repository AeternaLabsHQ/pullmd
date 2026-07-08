import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractWeb } from '../lib/web.js';
import { SsrfError } from '../lib/ssrf.js';

test('extractWeb refuses a metadata-IP URL without fetching', async () => {
  let fetched = false;
  const fetchFn = async () => { fetched = true; return new Response('secret', { status: 200 }); };
  await assert.rejects(
    () => extractWeb('http://100.100.100.200/latest/user-data', { fetch: fetchFn }),
    SsrfError,
  );
  assert.equal(fetched, false);
});

test('extractWeb refuses a private-IP literal URL', async () => {
  const fetchFn = async () => new Response('x', { status: 200 });
  await assert.rejects(
    () => extractWeb('http://127.0.0.1:8080/', { fetch: fetchFn }),
    SsrfError,
  );
});
