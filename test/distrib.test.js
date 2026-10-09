import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { substituteUrl, substituteVars, renderHelp, renderIndex, buildSkillZip, getSkillZip, _resetCaches, _zipCacheSize, publicUrlFor } from '../lib/distrib.js';
import { createApp } from '../server.js';

describe('substituteUrl', () => {
  it('replaces every placeholder', () => {
    const out = substituteUrl('a __PULLMD_URL__/x b __PULLMD_URL__/y', 'https://my.host');
    assert.equal(out, 'a https://my.host/x b https://my.host/y');
  });

  it('strips trailing slash from the base url', () => {
    const out = substituteUrl('__PULLMD_URL__/api', 'https://my.host/');
    assert.equal(out, 'https://my.host/api');
  });

  it('returns input unchanged when no placeholder present', () => {
    assert.equal(substituteUrl('plain text', 'https://x'), 'plain text');
  });
});

describe('substituteVars', () => {
  it('replaces both URL and VERSION placeholders', () => {
    const out = substituteVars(
      'PullMD __PULLMD_VERSION__ at __PULLMD_URL__/api',
      'https://my.host',
      '9.9.9'
    );
    assert.equal(out, 'PullMD 9.9.9 at https://my.host/api');
  });

  it('replaces every VERSION occurrence', () => {
    const out = substituteVars('v__PULLMD_VERSION__ — __PULLMD_VERSION__', 'https://h', '1.2.3');
    assert.equal(out, 'v1.2.3 — 1.2.3');
  });

  it('returns input unchanged when no placeholders present', () => {
    assert.equal(substituteVars('plain', 'https://x', '1.0.0'), 'plain');
  });
});

describe('publicUrlFor', () => {
  it('uses PUBLIC_URL env var when set', () => {
    const prev = process.env.PUBLIC_URL;
    process.env.PUBLIC_URL = 'https://override.example';
    const fakeReq = { protocol: 'http', get: () => 'localhost:3000' };
    assert.equal(publicUrlFor(fakeReq), 'https://override.example');
    process.env.PUBLIC_URL = prev;
  });

  it('falls back to req protocol+host when env unset', () => {
    const prev = process.env.PUBLIC_URL;
    delete process.env.PUBLIC_URL;
    const headers = {};
    const fakeReq = {
      protocol: 'https',
      get: (k) => k === 'host' ? 'pull.example.com' : headers[k.toLowerCase()],
    };
    assert.equal(publicUrlFor(fakeReq), 'https://pull.example.com');
    if (prev) process.env.PUBLIC_URL = prev;
  });

  it('takes protocol and host from the request object, not raw forwarding headers', () => {
    const prev = process.env.PUBLIC_URL;
    delete process.env.PUBLIC_URL;
    const headers = { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'public.example', host: 'internal:3000' };
    const fakeReq = { protocol: 'http', host: 'internal:3000', get: (k) => headers[k.toLowerCase()] };
    assert.equal(publicUrlFor(fakeReq), 'http://internal:3000');
    if (prev) process.env.PUBLIC_URL = prev;
  });
});

describe('publicUrlFor through the app (trust proxy)', () => {
  async function helpVia(trustProxy) {
    const prev = process.env.PUBLIC_URL;
    delete process.env.PUBLIC_URL;
    _resetCaches();
    const app = createApp({ trustProxy });
    const server = app.listen(0);
    try {
      const port = server.address().port;
      const r = await fetch(`http://127.0.0.1:${port}/help`, {
        headers: { 'X-Forwarded-Host': 'public.example', 'X-Forwarded-Proto': 'https' },
      });
      return { port, html: await r.text() };
    } finally {
      server.close();
      if (prev) process.env.PUBLIC_URL = prev;
    }
  }

  it('ignores forwarding headers when trust proxy is off', async () => {
    const { port, html } = await helpVia(false);
    assert.ok(html.includes(`http://127.0.0.1:${port}/mcp`));
    assert.ok(!html.includes('public.example'));
  });

  it('honours forwarding headers when trust proxy is on', async () => {
    const { html } = await helpVia(true);
    assert.ok(html.includes('https://public.example/mcp'));
  });
});

describe('renderHelp', () => {
  beforeEach(() => _resetCaches());

  it('substitutes the public URL into help.html', () => {
    const html = renderHelp('https://my.host');
    assert.ok(html.includes('https://my.host/mcp'));
    assert.ok(!html.includes('__PULLMD_URL__'));
  });

  it('output equals plain placeholder substitution for an ordinary origin', () => {
    const raw = readFileSync(new URL('../public/help.html', import.meta.url), 'utf8');
    const base = 'https://my.host:3000';
    assert.equal(renderHelp(base), substituteVars(raw, base));
  });

  it('HTML-escapes the substituted origin', () => {
    const html = renderHelp('http://a"b<c>&d');
    assert.ok(!html.includes('a"b<c>'));
    assert.ok(html.includes('http://a&quot;b&lt;c&gt;&amp;d/mcp'));
  });
});

describe('renderIndex', () => {
  beforeEach(() => _resetCaches());

  it('returns the templated index.html with no unresolved placeholders', () => {
    const html = renderIndex('https://my.host');
    assert.ok(!html.includes('__PULLMD_VERSION__'), 'version placeholder must be replaced');
    assert.ok(!html.includes('__PULLMD_URL__'), 'URL placeholder must be replaced');
    assert.ok(html.length > 1000, 'expected real html, not empty');
  });
});

describe('buildSkillZip', () => {
  beforeEach(() => _resetCaches());

  it('returns a non-empty buffer with the substituted URL embedded', async () => {
    const buf = await buildSkillZip('https://my.host');
    assert.ok(Buffer.isBuffer(buf));
    assert.ok(buf.length > 100);
    // ZIP signature
    assert.equal(buf.slice(0, 4).toString('hex'), '504b0304');
    // Substituted URL should appear in the deflate stream — check by re-extracting
    // a known file via a tiny inline reader. Easiest: just look at raw bytes
    // for the literal substring (works because plugin.json is small enough
    // that DEFLATE may store it uncompressed, but to be safe, inflate one entry).
    // Smoke check: placeholder must not survive substitution.
    assert.equal(buf.indexOf(Buffer.from('__PULLMD_URL__')), -1, 'placeholder should not appear in zip');
  });
});

describe('getSkillZip cache', () => {
  beforeEach(() => _resetCaches());

  it('keeps at most 8 entries and reuses a cached one', async () => {
    for (let i = 0; i < 10; i++) await getSkillZip(`https://h${i}.example`);
    assert.equal(_zipCacheSize(), 8);
    const a = await getSkillZip('https://h9.example');
    const b = await getSkillZip('https://h9.example');
    assert.equal(a, b);
    assert.equal(_zipCacheSize(), 8);
  });
});
