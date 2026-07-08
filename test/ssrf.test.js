import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isBlockedIp, parseAllowedHosts, assertUrlAllowed, safeFetch, SsrfError } from '../lib/ssrf.js';

// A stub resolver: maps hostname -> array of IPs, mimicking dns.lookup(host, {all:true}).
function stubLookup(map) {
  return async (host) => {
    const ips = map[host];
    if (!ips) { const e = new Error('ENOTFOUND'); e.code = 'ENOTFOUND'; throw e; }
    return ips.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
  };
}

test('isBlockedIp flags private, loopback, link-local, CGNAT and metadata ranges', () => {
  for (const ip of ['169.254.169.254', '100.100.100.200', '10.0.0.1', '127.0.0.1',
                    '192.168.1.1', '172.16.5.5', '0.0.0.0', '::1', 'fd00:ec2::254', 'fe80::1',
                    '::ffff:169.254.169.254']) {
    assert.equal(isBlockedIp(ip), true, `${ip} should be blocked`);
  }
});

test('isBlockedIp allows public addresses', () => {
  for (const ip of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '2606:4700:4700::1111', '::ffff:8.8.8.8']) {
    assert.equal(isBlockedIp(ip), false, `${ip} should be allowed`);
  }
});

test('isBlockedIp flags blocked v4 ranges embedded in IPv6 transition addressing', () => {
  for (const ip of [
    '64:ff9b::a9fe:a9fe', // NAT64 of 169.254.169.254 (metadata)
    '64:ff9b::a00:1', // NAT64 of 10.0.0.1 (private)
    '2002:a9fe:0::', // 6to4 of 169.254.0.0 (link-local)
    '::a9fe:a9fe', // IPv4-compatible of 169.254.169.254 (metadata)
  ]) {
    assert.equal(isBlockedIp(ip), true, `${ip} should be blocked`);
  }
});

test('isBlockedIp allows legit public v4 embedded in IPv6 transition addressing', () => {
  for (const ip of [
    '64:ff9b::808:808', // NAT64 of 8.8.8.8 (public)
    '2002:808:808::', // 6to4 of 8.8.8.8 (public)
    '2606:4700:4700::1111', // Cloudflare, unrelated to transition addressing
  ]) {
    assert.equal(isBlockedIp(ip), false, `${ip} should be allowed`);
  }
});

test('isBlockedIp handles dotted-quad textual form of NAT64 metadata embedding', () => {
  assert.equal(isBlockedIp('64:ff9b::169.254.169.254'), true);
});

test('assertUrlAllowed rejects non-http(s) schemes', async () => {
  await assert.rejects(() => assertUrlAllowed('file:///etc/passwd', { env: {} }), SsrfError);
  await assert.rejects(() => assertUrlAllowed('gopher://x/', { env: {} }), SsrfError);
});

test('assertUrlAllowed rejects a literal metadata IP', async () => {
  await assert.rejects(() => assertUrlAllowed('http://100.100.100.200/latest/user-data', { env: {} }), SsrfError);
});

test('assertUrlAllowed rejects a hostname resolving to a private IP', async () => {
  const lookup = stubLookup({ 'evil.example': ['169.254.169.254'] });
  await assert.rejects(() => assertUrlAllowed('http://evil.example/', { lookup, env: {} }), SsrfError);
});

test('assertUrlAllowed rejects if ANY resolved address is blocked', async () => {
  const lookup = stubLookup({ 'mixed.example': ['8.8.8.8', '127.0.0.1'] });
  await assert.rejects(() => assertUrlAllowed('http://mixed.example/', { lookup, env: {} }), SsrfError);
});

test('assertUrlAllowed allows a public host', async () => {
  const lookup = stubLookup({ 'example.com': ['93.184.216.34'] });
  const { url } = await assertUrlAllowed('https://example.com/page', { lookup, env: {} });
  assert.equal(url.hostname, 'example.com');
});

test('PULLMD_ALLOWED_HOSTS CIDR permits an otherwise-blocked address', async () => {
  const lookup = stubLookup({ 'wiki.internal': ['10.0.5.20'] });
  const env = { PULLMD_ALLOWED_HOSTS: '10.0.5.0/24' };
  const { url } = await assertUrlAllowed('http://wiki.internal/', { lookup, env });
  assert.equal(url.hostname, 'wiki.internal');
});

test('PULLMD_ALLOWED_HOSTS with an out-of-range CIDR prefix is skipped, not fatal', async () => {
  const env = { PULLMD_ALLOWED_HOSTS: '10.0.0.0/99' };
  await assert.rejects(() => assertUrlAllowed('http://10.0.0.5/', { env }), SsrfError);
});

test('PULLMD_ALLOWED_HOSTS hostname entry permits an otherwise-blocked host', async () => {
  const lookup = stubLookup({ 'localhost': ['127.0.0.1'] });
  const env = { PULLMD_ALLOWED_HOSTS: 'localhost' };
  const { url } = await assertUrlAllowed('http://localhost:9000/', { lookup, env });
  assert.equal(url.hostname, 'localhost');
});

test('safeFetch blocks the initial URL before any network call', async () => {
  let called = false;
  const fetchFn = async () => { called = true; return new Response('x'); };
  const guarded = safeFetch(fetchFn, { env: {} });
  await assert.rejects(() => guarded('http://169.254.169.254/'), SsrfError);
  assert.equal(called, false);
});

test('safeFetch re-validates redirect hops and blocks a redirect to metadata', async () => {
  const lookup = stubLookup({ 'public.example': ['93.184.216.34'] });
  const fetchFn = async () =>
    new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/' } });
  const guarded = safeFetch(fetchFn, { lookup, env: {}, maxRedirects: 5 });
  await assert.rejects(() => guarded('http://public.example/'), SsrfError);
});

test('safeFetch follows a redirect to another public URL', async () => {
  const lookup = stubLookup({ 'a.example': ['93.184.216.34'], 'b.example': ['1.1.1.1'] });
  let hop = 0;
  const fetchFn = async (u) => {
    hop++;
    if (hop === 1) return new Response(null, { status: 301, headers: { location: 'http://b.example/final' } });
    return new Response('ok', { status: 200 });
  };
  const guarded = safeFetch(fetchFn, { lookup, env: {} });
  const res = await guarded('http://a.example/');
  assert.equal(res.status, 200);
  assert.equal(await res.text(), 'ok');
});

test('safeFetch throws on redirect loop exceeding maxRedirects', async () => {
  const lookup = stubLookup({ 'loop.example': ['93.184.216.34'] });
  const fetchFn = async () =>
    new Response(null, { status: 302, headers: { location: 'http://loop.example/next' } });
  const guarded = safeFetch(fetchFn, { lookup, env: {}, maxRedirects: 3 });
  await assert.rejects(() => guarded('http://loop.example/'), SsrfError);
});
