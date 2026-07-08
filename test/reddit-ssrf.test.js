import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertUrlAllowed, SsrfError } from '../lib/ssrf.js';

// Reddit redirect resolution guards the target URL via assertUrlAllowed.
// This test pins the contract the reddit.js change relies on: a metadata
// target is rejected before any fetch.
test('a metadata redirect target is rejected by the shared guard', async () => {
  await assert.rejects(
    () => assertUrlAllowed('http://169.254.169.254/', { env: {} }),
    SsrfError,
  );
});
