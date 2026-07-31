import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server.js';
import { createCache } from '../lib/cache.js';
import { createAuth } from '../lib/auth.js';

const fastOpts = { timeCost: 1, memoryCost: 1024, parallelism: 1 };

async function withApp(mode, fn) {
  const cache = createCache(':memory:');
  const auth = createAuth({
    db: cache.db, mode,
    env: { PULLMD_ADMIN_EMAIL: 'a@b.c', PULLMD_ADMIN_PASSWORD: 'pw1234567' },
    argon2Opts: fastOpts,
  });
  await auth.runMigration();

  const ctx = { cache, auth };
  if (mode !== 'disabled') {
    ctx.admin = cache.db.prepare('SELECT id FROM users WHERE is_admin = 1').get();
    ctx.demo = await auth.createUser({ email: 'demo@x.y', password: 'pw1234567', isAdmin: false });
    ctx.adminCookie = { Cookie: `pullmd_session=${auth.createSession(ctx.admin.id).token}` };
    ctx.demoCookie = { Cookie: `pullmd_session=${auth.createSession(ctx.demo.id).token}` };
  }

  const app = createApp({
    cache, auth,
    extractWeb: async () => ({
      markdown: '# x', title: 'x', source: 'readability', metadata: { quality: 0.9 },
    }),
  });
  const server = app.listen(0);
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`, ctx);
  } finally {
    server.close();
  }
}

// Seeds one conversion owned by `userId` and returns its cache id + share id.
function seed(cache, url, userId) {
  const shareId = cache.put({ url, title: 't', markdown: '# t', source: 's', user_id: userId });
  return { id: cache.getIdByUrl(url), shareId };
}

describe('DELETE /api/cache/:id scope', () => {
  it('non-admin unlinks from own history, conversion and share link survive', async () => {
    await withApp('multi-user', async (base, ctx) => {
      const { id, shareId } = seed(ctx.cache, 'https://a.test/1', ctx.demo.id);

      const r = await fetch(`${base}/api/cache/${id}`, { method: 'DELETE', headers: ctx.demoCookie });

      assert.equal(r.status, 200);
      assert.deepEqual(await r.json(), { ok: true, id, scope: 'user' });
      assert.deepEqual(ctx.cache.historyForUser(ctx.demo.id), []);
      assert.ok(ctx.cache.getByShareId(shareId), 'share link must keep working');
    });
  });

  it('non-admin delete leaves another user history untouched', async () => {
    await withApp('multi-user', async (base, ctx) => {
      const { id } = seed(ctx.cache, 'https://a.test/2', ctx.demo.id);
      ctx.cache.db.prepare('INSERT INTO user_fetches (user_id, cache_id) VALUES (?, ?)')
        .run(ctx.admin.id, id);

      await fetch(`${base}/api/cache/${id}`, { method: 'DELETE', headers: ctx.demoCookie });

      assert.equal(ctx.cache.historyForUser(ctx.admin.id).length, 1);
    });
  });

  it('non-admin gets 404 for an entry that is not in their history', async () => {
    await withApp('multi-user', async (base, ctx) => {
      const { id } = seed(ctx.cache, 'https://a.test/3', ctx.admin.id);

      const r = await fetch(`${base}/api/cache/${id}`, { method: 'DELETE', headers: ctx.demoCookie });

      assert.equal(r.status, 404);
      assert.equal(ctx.cache.db.prepare('SELECT COUNT(*) c FROM conversions WHERE id = ?').get(id).c, 1);
    });
  });

  it('admin delete is global and leaves no orphan fetch rows', async () => {
    await withApp('multi-user', async (base, ctx) => {
      const { id, shareId } = seed(ctx.cache, 'https://a.test/4', ctx.demo.id);

      const r = await fetch(`${base}/api/cache/${id}`, { method: 'DELETE', headers: ctx.adminCookie });

      assert.equal(r.status, 200);
      assert.deepEqual(await r.json(), { ok: true, id, scope: 'global' });
      assert.equal(ctx.cache.getByShareId(shareId), null);
      assert.equal(ctx.cache.db.prepare('SELECT COUNT(*) c FROM user_fetches').get().c, 0);
    });
  });

  it('disabled mode deletes globally without auth', async () => {
    await withApp('disabled', async (base, ctx) => {
      const { id } = seed(ctx.cache, 'https://a.test/5', null);

      const r = await fetch(`${base}/api/cache/${id}`, { method: 'DELETE' });

      assert.equal(r.status, 200);
      assert.deepEqual(await r.json(), { ok: true, id, scope: 'global' });
    });
  });

  it('rejects an unparsable id with 400 before touching the cache', async () => {
    await withApp('multi-user', async (base, ctx) => {
      const r = await fetch(`${base}/api/cache/not-a-number`, { method: 'DELETE', headers: ctx.demoCookie });
      assert.equal(r.status, 400);
    });
  });

  it('still requires authentication', async () => {
    await withApp('multi-user', async (base) => {
      const r = await fetch(`${base}/api/cache/1`, { method: 'DELETE' });
      assert.equal(r.status, 401);
    });
  });
});

describe('DELETE /api/cache scope', () => {
  it('non-admin clears only their own history', async () => {
    await withApp('multi-user', async (base, ctx) => {
      seed(ctx.cache, 'https://a.test/6', ctx.demo.id);
      seed(ctx.cache, 'https://a.test/7', ctx.demo.id);
      seed(ctx.cache, 'https://a.test/8', ctx.admin.id);

      const r = await fetch(`${base}/api/cache`, { method: 'DELETE', headers: ctx.demoCookie });

      assert.equal(r.status, 200);
      assert.deepEqual(await r.json(), { ok: true, scope: 'user', removed: 2 });
      assert.deepEqual(ctx.cache.historyForUser(ctx.demo.id), []);
      assert.equal(ctx.cache.historyForUser(ctx.admin.id).length, 1);
      assert.equal(ctx.cache.db.prepare('SELECT COUNT(*) c FROM conversions').get().c, 3);
    });
  });

  it('admin purges everything', async () => {
    await withApp('multi-user', async (base, ctx) => {
      seed(ctx.cache, 'https://a.test/9', ctx.demo.id);
      seed(ctx.cache, 'https://a.test/10', ctx.admin.id);

      const r = await fetch(`${base}/api/cache`, { method: 'DELETE', headers: ctx.adminCookie });

      assert.equal(r.status, 200);
      assert.deepEqual(await r.json(), { ok: true, scope: 'global', removed: 2 });
      assert.equal(ctx.cache.db.prepare('SELECT COUNT(*) c FROM conversions').get().c, 0);
      assert.equal(ctx.cache.db.prepare('SELECT COUNT(*) c FROM user_fetches').get().c, 0);
    });
  });
});
