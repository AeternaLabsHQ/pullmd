import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { BotChallengeError, challengeVendorFromHeaders, challengeVendorFromBody } from '../lib/challenge.js';
import { extractWeb } from '../lib/web.js';
import { createApp } from '../server.js';

function headersOf(map) {
  return { get: (h) => map[h.toLowerCase()] ?? null };
}

const CF_BODY = `<!DOCTYPE html><html><head><title>Just a moment...</title>
<script src="/cdn-cgi/challenge-platform/h/b/orchestrate/chl_page/v1"></script></head>
<body><div id="challenge-running">Checking your browser</div></body></html>`;

const BUNNY_BODY = `<!DOCTYPE html><html><head><title>Establishing a secure connection ...</title>
<link href="/.bunny-shield/assets/challenge-styles.css" rel="stylesheet" />
<script src="/.bunny-shield/assets/shield-challenge.js"></script></head>
<body data-pow="abc#def#1"><p>Submitting...</p><p>Request ID: <b>18ebe5ca</b></p></body></html>`;

const ARTICLE = `<!DOCTYPE html><html><head><title>Real article</title></head><body><article>
<h1>Real article</h1>${'<p>Cloudflare is a CDN vendor. This paragraph is ordinary prose about it.</p>'.repeat(20)}
</article></body></html>`;

describe('challenge detection helpers', () => {
  it('recognises the Cloudflare and Bunny Shield headers', () => {
    assert.equal(challengeVendorFromHeaders(headersOf({ 'cf-mitigated': 'challenge' })), 'Cloudflare');
    assert.equal(challengeVendorFromHeaders(headersOf({ 'cdn-challenge': 'true' })), 'Bunny Shield');
    assert.equal(challengeVendorFromHeaders(headersOf({ server: 'cloudflare' })), null);
  });

  it('recognises the interstitial bodies but not prose that mentions a vendor', () => {
    assert.equal(challengeVendorFromBody(CF_BODY), 'Cloudflare');
    assert.equal(challengeVendorFromBody(BUNNY_BODY), 'Bunny Shield');
    assert.equal(challengeVendorFromBody(ARTICLE), null);
    assert.equal(challengeVendorFromBody(''), null);
  });

  it('BotChallengeError carries vendor, status and the workaround', () => {
    const err = new BotChallengeError('Cloudflare', 403);
    assert.equal(err.vendor, 'Cloudflare');
    assert.equal(err.status, 403);
    assert.match(err.message, /Cloudflare/);
    assert.match(err.message, /POST \/api\/html/);
  });
});

describe('extractWeb + /api on challenge pages', () => {
  let server, base, app, prevAllowed;

  before(async () => {
    prevAllowed = process.env.PULLMD_ALLOWED_HOSTS;
    process.env.PULLMD_ALLOWED_HOSTS = '127.0.0.1';
    server = createServer((req, res) => {
      if (req.url === '/cf-403') {
        res.writeHead(403, { 'content-type': 'text/html', 'cf-mitigated': 'challenge' });
        return res.end(CF_BODY);
      }
      if (req.url === '/bunny-200') {
        // gocomics.com: challenge delivered with HTTP 200 for some user agents
        res.writeHead(200, { 'content-type': 'text/html' });
        return res.end(BUNNY_BODY);
      }
      if (req.url === '/bunny-403-header') {
        res.writeHead(403, { 'content-type': 'text/html', 'cdn-challenge': 'true' });
        return res.end(BUNNY_BODY);
      }
      if (req.url === '/plain-403') {
        res.writeHead(403, { 'content-type': 'text/html' });
        return res.end('<html><body>Forbidden</body></html>');
      }
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(ARTICLE);
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${server.address().port}`;
    app = createApp({ cache: null });
  });
  after(() => {
    server.close();
    if (prevAllowed === undefined) delete process.env.PULLMD_ALLOWED_HOSTS;
    else process.env.PULLMD_ALLOWED_HOSTS = prevAllowed;
  });

  const opts = { render: 'skip', fetchDeadlineMs: 10_000 };

  it('throws BotChallengeError on a Cloudflare 403 challenge (header)', async () => {
    await assert.rejects(extractWeb(`${base}/cf-403`, opts), (err) => {
      assert.ok(err instanceof BotChallengeError);
      assert.equal(err.vendor, 'Cloudflare');
      assert.equal(err.status, 403);
      return true;
    });
  });

  it('throws BotChallengeError on a Bunny Shield challenge served with 200 (body sniff)', async () => {
    await assert.rejects(extractWeb(`${base}/bunny-200`, opts), (err) => {
      assert.ok(err instanceof BotChallengeError);
      assert.equal(err.vendor, 'Bunny Shield');
      assert.equal(err.status, 200);
      return true;
    });
  });

  it('throws BotChallengeError on a Bunny Shield 403 (header)', async () => {
    await assert.rejects(extractWeb(`${base}/bunny-403-header`, opts), (err) => err instanceof BotChallengeError && err.vendor === 'Bunny Shield');
  });

  it('a plain 403 without challenge markers keeps the generic fetch error', async () => {
    await assert.rejects(extractWeb(`${base}/plain-403`, opts), (err) => {
      assert.ok(!(err instanceof BotChallengeError));
      assert.match(err.message, /status 403/);
      return true;
    });
  });

  it('still extracts an ordinary page that mentions a vendor', async () => {
    const r = await extractWeb(`${base}/article`, opts);
    assert.match(r.markdown, /ordinary prose/);
  });

  it('even render=force does not call the sidecar on a challenge page', async () => {
    const prev = process.env.PLAYWRIGHT_URL;
    process.env.PLAYWRIGHT_URL = 'http://127.0.0.1:9/render'; // would fail loudly if called
    try {
      await assert.rejects(extractWeb(`${base}/bunny-200`, { ...opts, render: 'force' }), (err) => err instanceof BotChallengeError);
    } finally {
      if (prev === undefined) delete process.env.PLAYWRIGHT_URL; else process.env.PLAYWRIGHT_URL = prev;
    }
  });

  it('/api answers 502 with code bot_challenge and the vendor', async () => {
    const srv = app.listen(0, '127.0.0.1');
    await new Promise((r) => srv.once('listening', r));
    try {
      const port = srv.address().port;
      const res = await fetch(`http://127.0.0.1:${port}/api?url=${encodeURIComponent(`${base}/bunny-200`)}&render=skip`);
      assert.equal(res.status, 502);
      const body = await res.json();
      assert.equal(body.code, 'bot_challenge');
      assert.equal(body.vendor, 'Bunny Shield');
      assert.match(body.error, /bot-protection challenge \(Bunny Shield\)/);
      assert.match(body.error, /POST \/api\/html/);
    } finally {
      srv.close();
    }
  });
});
