import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('server starts with a header limit large enough for YouTube responses', () => {
  const dockerfile = readFileSync(new URL('../Dockerfile', import.meta.url), 'utf8');
  assert.match(dockerfile, /CMD \["node", "--max-http-header-size=65536", "server\.js"\]/);
});
