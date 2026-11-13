import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { fetch as undiciFetch } from 'undici';
import { resolveRedditUrl } from '../lib/reddit.js';
import { SsrfError } from '../lib/ssrf.js';

// A loopback server stands in for the host behind redd.it. It is reachable
// only when the address policy lets 127.0.0.1 through (PULLMD_ALLOWED_HOSTS).
const hits = [];
const server = http.createServer((req, res) => {
  hits.push(req.headers.host);
  res.writeHead(302, { location: 'https://www.reddit.com/r/javascript/comments/abc123/real_post/' });
  res.end();
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
after(() => server.close());

const ENV = { PULLMD_ALLOWED_HOSTS: '127.0.0.1' };
const REAL = 'https://www.reddit.com/r/javascript/comments/abc123/real_post/';

// First answer is allowed by the policy, every later one points inward.
function rebindingLookup() {
  const calls = [];
  const fn = async (host, options) => {
    calls.push(host);
    const address = calls.length === 1 ? '127.0.0.1' : '10.0.0.5';
    const records = [{ address, family: 4 }];
    return options?.all ? records : records[0];
  };
  fn.calls = calls;
  return fn;
}

// Stand-in for the network: the short-link URL is https on port 443, so the
// test redirects the request to the loopback server but keeps the hostname
// (and the dispatcher the caller supplied), which is what decides the address.
function toLoopback(seen) {
  return async (url, init) => {
    seen.push({ url, init });
    return undiciFetch(`http://redd.it:${port}/abc123`, init);
  };
}

test('short-link request connects to the address the policy checked', async () => {
  const lookup = rebindingLookup();
  const seen = [];
  const before = hits.length;
  const result = await resolveRedditUrl('https://redd.it/abc123', { lookup, env: ENV, fetch: toLoopback(seen) });
  assert.equal(result, REAL);
  assert.equal(hits.length, before + 1);
  assert.equal(hits.at(-1), `redd.it:${port}`);
  // One query for the check; the connector reused the pinned answer.
  assert.deepEqual(lookup.calls, ['redd.it']);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].init.redirect, 'manual');
  assert.ok(seen[0].init.dispatcher, 'request carries the pinned dispatcher');
  assert.ok(seen[0].init.headers['User-Agent']);
});

test('the dispatcher refuses an unpinned name that resolves to a blocked address, surfaced as SsrfError', async () => {
  // The request goes to a host other than the checked one, so no pin applies
  // and the connector resolves and checks it itself before any socket opens.
  const lookup = async (host, options) => {
    const address = host === 'redd.it' ? '127.0.0.1' : '10.0.0.5';
    return options?.all ? [{ address, family: 4 }] : { address, family: 4 };
  };
  const before = hits.length;
  const fetchFn = async (url, init) => undiciFetch(`http://other.test:${port}/`, init);
  await assert.rejects(
    () => resolveRedditUrl('https://redd.it/abc123', { lookup, env: ENV, fetch: fetchFn }),
    (err) => err instanceof SsrfError && /blocked address 10\.0\.0\.5 for host other\.test/.test(err.message),
  );
  assert.equal(hits.length, before);
});

test('a short link whose host resolves to a blocked address is refused before any request', async () => {
  let called = false;
  const lookup = async (host, options) => (options?.all ? [{ address: '10.0.0.5', family: 4 }] : { address: '10.0.0.5', family: 4 });
  await assert.rejects(
    () => resolveRedditUrl('https://redd.it/abc123', { lookup, env: {}, fetch: async () => { called = true; } }),
    (err) => err instanceof SsrfError && /blocked address 10\.0\.0\.5/.test(err.message),
  );
  assert.equal(called, false);
});
