import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server.js';
import { createCache } from '../lib/cache.js';
import { createAuth } from '../lib/auth.js';
import { suggestFilename } from '../lib/filename.js';

// Stored uploads are the first conversions rows with `url` NULL. Every path
// that reads a row has to cope with that: no crash, no literal "null".

const FAKE = {
  markdown: '# Quarterly Report\n\nConverted body.',
  title: 'Quarterly Report', source: 'markitdown',
  metadata: { title: 'Quarterly Report', sourceUrl: null, quality: 0.9, contentLength: 400 },
};

async function withServer(app, fn) {
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  try {
    return await fn(`http://localhost:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function storeUpload(base, headers = {}) {
  const res = await fetch(`${base}/api/file?store=true&format=json&filename=${encodeURIComponent('Quarterly Report.pdf')}`, {
    method: 'POST', headers: { 'Content-Type': 'application/pdf', ...headers }, body: Buffer.from('%PDF-1.4'),
  });
  assert.equal(res.status, 200);
  return (await res.json()).shareId;
}

const backdate = (cache, hours) =>
  cache.db.prepare(`UPDATE conversions SET created_at = datetime('now', '-${hours} hours')`).run();

function parseSse(text) {
  const m = /^data: (.+)$/m.exec(text);
  return m ? JSON.parse(m[1]) : JSON.parse(text);
}

async function callTool(base, name, args = {}) {
  const r = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  assert.equal(r.status, 200);
  return parseSse(await r.text()).result;
}

describe('rows without a URL', () => {
  let cache;
  let app;
  beforeEach(() => {
    cache = createCache(':memory:');
    app = createApp({
      cache,
      extractFile: async () => FAKE,
      // A stale snapshot must never be sent to the network.
      extractWeb: async () => { throw new Error('refresh must not run for a row without a URL'); },
    });
    mock.method(console, 'warn', () => {});
  });
  afterEach(() => mock.restoreAll());

  it('GET /s/:id serves a stale row as the snapshot, with a download name', async () => {
    await withServer(app, async (base) => {
      const shareId = await storeUpload(base);
      backdate(cache, 5);
      const res = await fetch(`${base}/s/${shareId}`);
      assert.equal(res.status, 200);
      assert.equal(await res.text(), FAKE.markdown);
      // The stored title is the file name: the download name follows it.
      assert.equal(res.headers.get('x-suggested-filename'), 'quarterly-report.md');
    });
  });

  it('GET /api/history lists the row with url null', async () => {
    await withServer(app, async (base) => {
      await storeUpload(base);
      const [row] = await (await fetch(`${base}/api/history`)).json();
      assert.equal(row.url, null);
      assert.equal(row.title, 'Quarterly Report.pdf');
    });
  });

  it('GET /api/archive lists the row with url null', async () => {
    await withServer(app, async (base) => {
      await storeUpload(base);
      const { items, total } = await (await fetch(`${base}/api/archive`)).json();
      assert.equal(total, 1);
      assert.equal(items[0].url, null);
    });
  });

  it('DELETE /api/cache/:id and DELETE /api/cache remove the row', async () => {
    await withServer(app, async (base) => {
      const first = await storeUpload(base);
      const [row] = await (await fetch(`${base}/api/history`)).json();
      const one = await fetch(`${base}/api/cache/${row.id}`, { method: 'DELETE' });
      assert.equal(one.status, 200);
      assert.equal((await fetch(`${base}/s/${first}`)).status, 404);

      await storeUpload(base);
      await storeUpload(base);
      const all = await fetch(`${base}/api/cache`, { method: 'DELETE' });
      assert.equal((await all.json()).removed, 2);
      assert.deepEqual(await (await fetch(`${base}/api/history`)).json(), []);
    });
  });

  it('the MCP get_share tool returns a stale row without a url line and without refreshing', async () => {
    await withServer(app, async (base) => {
      const shareId = await storeUpload(base);
      backdate(cache, 5);
      const result = await callTool(base, 'get_share', { id: shareId });
      assert.ok(!result.isError, result.content?.[0]?.text);
      const text = result.content[0].text;
      assert.ok(text.includes('# Quarterly Report'));
      assert.ok(!/^url:/m.test(text), text);
      assert.ok(!text.includes('null'), text);
      assert.match(text, /refreshed: false/);
    });
  });

  it('the MCP list_recent tool lists the row with url null', async () => {
    await withServer(app, async (base) => {
      const shareId = await storeUpload(base);
      const result = await callTool(base, 'list_recent');
      const [item] = JSON.parse(result.content[0].text);
      assert.equal(item.url, null);
      assert.equal(item.title, 'Quarterly Report.pdf');
      assert.equal(item.share_id, shareId);
    });
  });
});

describe('suggestFilename without a url', () => {
  it('does not print "null" for a missing url', () => {
    const name = suggestFilename({ source: 'pdf-ocr', title: null, url: null, shareId: 'ab'.repeat(16) });
    assert.equal(name, `${'ab'.repeat(16)}.md`);
  });
});

describe('rows without a URL (multi-user delete scope)', () => {
  it('the owner deletes the row for real, the admin can delete anyone\'s', async () => {
    const cache = createCache(':memory:');
    const auth = createAuth({
      db: cache.db, mode: 'multi-user',
      env: { PULLMD_ADMIN_EMAIL: 'a@b.c', PULLMD_ADMIN_PASSWORD: 'pw1234567' },
      argon2Opts: { timeCost: 1, memoryCost: 1024, parallelism: 1 },
    });
    await auth.runMigration();
    const admin = cache.db.prepare('SELECT id FROM users WHERE is_admin = 1').get();
    const demo = await auth.createUser({ email: 'demo@x.y', password: 'pw1234567', isAdmin: false });
    const asAdmin = { Cookie: `pullmd_session=${auth.createSession(admin.id).token}` };
    const asDemo = { Cookie: `pullmd_session=${auth.createSession(demo.id).token}` };
    const app = createApp({ cache, auth, extractFile: async () => FAKE });
    await withServer(app, async (base) => {
      const ownShare = await storeUpload(base, asDemo);
      const [own] = await (await fetch(`${base}/api/history`, { headers: asDemo })).json();
      const owner = await fetch(`${base}/api/cache/${own.id}`, { method: 'DELETE', headers: asDemo });
      assert.deepEqual(await owner.json(), { ok: true, id: own.id, scope: 'user' });
      assert.equal((await fetch(`${base}/s/${ownShare}`)).status, 404, 'an upload has one owner, so it is really gone');

      const shareId = await storeUpload(base, asDemo);
      const [row] = await (await fetch(`${base}/api/history`, { headers: asDemo })).json();
      const global = await fetch(`${base}/api/cache/${row.id}`, { method: 'DELETE', headers: asAdmin });
      assert.equal((await global.json()).scope, 'global');
      assert.equal((await fetch(`${base}/s/${shareId}`)).status, 404);
    });
  });
});
