import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { fetch as undiciFetch } from 'undici';
import { safeFetch, pinnedDispatcher, SsrfError } from '../lib/ssrf.js';

// A loopback server stands in for an internal service. It is reachable only
// when the address policy lets 127.0.0.1 through (PULLMD_ALLOWED_HOSTS).
const hits = [];
const server = http.createServer((req, res) => {
  hits.push(req.headers.host);
  if (req.url === '/hop') { res.writeHead(302, { location: '/final' }); res.end(); return; }
  res.end('internal-ok');
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
after(() => server.close());

function countingLookup(answers) {
  const calls = [];
  const fn = async (host) => {
    calls.push(host);
    const ips = answers[host];
    if (!ips) { const e = new Error('ENOTFOUND'); e.code = 'ENOTFOUND'; throw e; }
    return ips.map((address) => ({ address, family: 4 }));
  };
  fn.calls = calls;
  return fn;
}

test('the socket connects to the address the policy checked, without a second DNS query', async () => {
  // pinned.test does not exist in DNS; only the pinned record can reach the server.
  const lookup = countingLookup({ 'pinned.test': ['127.0.0.1'] });
  const guarded = safeFetch(undefined, { lookup, env: { PULLMD_ALLOWED_HOSTS: '127.0.0.1' } });
  const res = await guarded(`http://pinned.test:${port}/`);
  assert.equal(await res.text(), 'internal-ok');
  assert.deepEqual(lookup.calls, ['pinned.test']);
  assert.equal(hits.at(-1), `pinned.test:${port}`);
});

test('redirect hops are pinned as well', async () => {
  const lookup = countingLookup({ 'hop.test': ['127.0.0.1'] });
  const guarded = safeFetch(undefined, { lookup, env: { PULLMD_ALLOWED_HOSTS: '127.0.0.1' } });
  const res = await guarded(`http://hop.test:${port}/hop`);
  assert.equal(await res.text(), 'internal-ok');
  assert.deepEqual(lookup.calls, ['hop.test', 'hop.test']);
});

test('a name that rebinds to a blocked address after the check is refused at connect time', async () => {
  // First answer passes the check, the second (seen only by the connector)
  // points inward. With pinning the connector never asks; the dispatcher's
  // own lookup still validates whatever it is handed.
  const before = hits.length;
  const lookup = countingLookup({ 'rebind.test': ['127.0.0.1'] });
  const dispatcher = pinnedDispatcher(new Map(), { lookup, env: {} });
  await assert.rejects(
    () => undiciFetch(`http://rebind.test:${port}/`, { dispatcher }),
    (err) => err.cause instanceof SsrfError && /127\.0\.0\.1/.test(err.cause.message),
  );
  assert.equal(hits.length, before);
  await dispatcher.close();
});

test('safeFetch surfaces a connect-time refusal as SsrfError', async () => {
  const lookup = countingLookup({ 'late.test': ['93.184.216.34'] });
  const fetchFn = async () => { throw new TypeError('fetch failed', { cause: new SsrfError('blocked address 127.0.0.1 for host late.test') }); };
  const guarded = safeFetch(fetchFn, { lookup, env: {} });
  await assert.rejects(() => guarded('http://late.test/'), (err) => err instanceof SsrfError && /late\.test/.test(err.message));
});
