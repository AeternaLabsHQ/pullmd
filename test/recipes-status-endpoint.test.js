import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server.js';
import { loadRecipes } from '../lib/recipes.js';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const fix = (rel) => path.join(here, 'fixtures/recipes', rel);

describe('GET /api/recipes/status', () => {
  it('returns ok=true with counts when all recipes loaded', async () => {
    loadRecipes({ defaultPath: fix('default.json') });
    const app = createApp({ cache: null });
    const server = app.listen(0);
    const port = server.address().port;
    try {
      const res = await fetch(`http://localhost:${port}/api/recipes/status`);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.ok, true);
      assert.equal(body.loaded, 2);
      assert.equal(body.rejected, 0);
      assert.equal(body.sources.length, 1);
    } finally {
      server.close();
    }
  });

  it('returns ok=false when there are rejections', async () => {
    loadRecipes({ defaultPath: fix('default.json'), userPath: fix('invalid.json') });
    const app = createApp({ cache: null });
    const server = app.listen(0);
    const port = server.address().port;
    try {
      const res = await fetch(`http://localhost:${port}/api/recipes/status`);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.ok, false);
      assert.equal(body.rejected, 1);
    } finally {
      server.close();
    }
  });

  it('does not require auth (returns 200 without bearer/session)', async () => {
    loadRecipes({ defaultPath: fix('default.json') });
    const app = createApp({ cache: null });
    const server = app.listen(0);
    const port = server.address().port;
    try {
      const res = await fetch(`http://localhost:${port}/api/recipes/status`);
      assert.equal(res.status, 200);
    } finally {
      server.close();
    }
  });
});
