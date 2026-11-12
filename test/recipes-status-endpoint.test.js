import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server.js';
import { loadRecipes } from '../lib/recipes.js';
import { createCache } from '../lib/cache.js';
import { createAuth } from '../lib/auth.js';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const fix = (rel) => path.join(here, 'fixtures/recipes', rel);
// Explicit missing path: keeps PULLMD_SITE_RECIPES and ./data/site-recipes.json
// of the checkout out of the counts.
const NO_USER = fix('does-not-exist.json');

describe('GET /api/recipes/status', () => {
  it('returns ok=true with counts when all recipes loaded', async () => {
    loadRecipes({ defaultPath: fix('default.json'), userPath: NO_USER });
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

  it('answers without credentials on an instance with auth enabled', async () => {
    loadRecipes({ defaultPath: fix('default.json'), userPath: NO_USER });
    const cache = createCache(':memory:');
    const auth = createAuth({
      db: cache.db, mode: 'multi-user',
      env: { PULLMD_ADMIN_EMAIL: 'a@b.c', PULLMD_ADMIN_PASSWORD: 'pw1234567' },
      argon2Opts: { timeCost: 1, memoryCost: 1024, parallelism: 1 },
    });
    await auth.runMigration();
    const app = createApp({ cache, auth });
    const server = app.listen(0);
    const port = server.address().port;
    try {
      // Control: a gated endpoint really does reject this anonymous request.
      const gated = await fetch(`http://localhost:${port}/api/history`);
      assert.equal(gated.status, 401);

      const res = await fetch(`http://localhost:${port}/api/recipes/status`);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.loaded, 2);
    } finally {
      server.close();
      cache.db.close();
    }
  });
});
