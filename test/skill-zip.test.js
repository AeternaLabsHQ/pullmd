import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server.js';
import { buildSkillZip } from '../lib/distrib.js';

// The skill bundle is named "pullmd" (renamed from "web-reader" in v3).
// Zip entry paths are stored uncompressed in the local file headers, so the
// raw buffer can be checked for them directly.

async function request(app, path, opts = {}) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const port = server.address().port;
      fetch(`http://localhost:${port}${path}`, { redirect: 'manual', ...opts })
        .then(async (res) => {
          const buf = Buffer.from(await res.arrayBuffer());
          server.close();
          resolve({ status: res.status, headers: Object.fromEntries(res.headers), buf });
        })
        .catch((err) => { server.close(); reject(err); });
    });
  });
}

describe('skill bundle naming', () => {
  it('zip entries live under pullmd/, not web-reader/', async () => {
    const buf = await buildSkillZip('https://my.host');
    assert.ok(buf.indexOf(Buffer.from('pullmd/skills/pullmd/SKILL.md')) !== -1,
      'expected pullmd/skills/pullmd/SKILL.md entry');
    assert.equal(buf.indexOf(Buffer.from('web-reader/')), -1,
      'no web-reader/ entry paths should remain');
  });

  it('GET /pullmd.zip serves the bundle', async () => {
    const app = createApp();
    const res = await request(app, '/pullmd.zip');
    assert.equal(res.status, 200);
    assert.equal(res.buf.slice(0, 4).toString('hex'), '504b0304');
    assert.match(res.headers['content-disposition'] || '', /pullmd\.zip/);
  });

  it('GET /web-reader.zip redirects to /pullmd.zip (legacy compat)', async () => {
    const app = createApp();
    const res = await request(app, '/web-reader.zip');
    assert.ok(res.status === 301 || res.status === 308, `expected permanent redirect, got ${res.status}`);
    assert.equal(res.headers['location'], '/pullmd.zip');
  });
});
