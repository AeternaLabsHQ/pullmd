// Fake DNS for tests, so the suite never depends on real name resolution.
//
// The SSRF guard (lib/ssrf.js) resolves every hostname before a request and
// checks the answers against its address policy. Production entry points take
// that resolver as an injected `lookup`; this module supplies a fake one and
// re-exports the entry points with it preset:
//
//   import { createApp } from './helpers/fake-dns.js';   // instead of ../server.js
//
// The guard itself still runs: only the DNS answer is faked. A test that
// needs a specific answer (private address, NXDOMAIN, rebinding sequence)
// passes its own `lookup`, e.g. createFakeLookup({ 'intranet.test': '10.0.0.5' }),
// which takes precedence over the preset.
import { createApp as realCreateApp } from '../../server.js';
import { extractWeb as realExtractWeb } from '../../lib/web.js';
import { renderViaSidecar as realRenderViaSidecar } from '../../lib/playwright-client.js';
import { resolveRedditUrl as realResolveRedditUrl } from '../../lib/reddit.js';

// Public and outside every range lib/ssrf.js blocks (the documentation
// ranges 192.0.2.0/24, 198.51.100.0/24, 203.0.113.0/24 are blocked).
export const PUBLIC_TEST_ADDRESS = '93.184.216.34';

function nxdomain(hostname) {
  const err = new Error(`getaddrinfo ENOTFOUND ${hostname}`);
  err.code = 'ENOTFOUND';
  err.hostname = hostname;
  return err;
}

function answer(records, options) {
  return options?.all ? records : records[0];
}

function toRecords(value) {
  const list = Array.isArray(value) ? value : [value];
  return list.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
}

/**
 * dns.promises.lookup stand-in. Names under localhost resolve to loopback
 * (as the real resolver does, so "localhost is blocked" stays meaningful),
 * names under .invalid do not resolve, everything else gets PUBLIC_TEST_ADDRESS.
 */
export async function publicLookup(hostname, options) {
  const host = String(hostname).toLowerCase().replace(/\.$/, '');
  if (host === 'localhost' || host.endsWith('.localhost')) {
    return answer([{ address: '127.0.0.1', family: 4 }, { address: '::1', family: 6 }], options);
  }
  if (host === 'invalid' || host.endsWith('.invalid')) throw nxdomain(hostname);
  return answer(toRecords(PUBLIC_TEST_ADDRESS), options);
}

/**
 * Build a lookup with fixed answers per hostname. A value is an address, an
 * array of addresses, null (NXDOMAIN) or a function (hostname, options) that
 * returns either. Unlisted names fall back to publicLookup.
 */
export function createFakeLookup(answers = {}) {
  const table = new Map(Object.entries(answers).map(([k, v]) => [k.toLowerCase(), v]));
  return async function fakeLookup(hostname, options) {
    const key = String(hostname).toLowerCase();
    if (!table.has(key)) return publicLookup(hostname, options);
    let value = table.get(key);
    if (typeof value === 'function') value = await value(hostname, options);
    if (value === null || (Array.isArray(value) && value.length === 0)) throw nxdomain(hostname);
    return answer(toRecords(value), options);
  };
}

export function createApp(overrides = {}) {
  return realCreateApp({ lookup: publicLookup, ...overrides });
}

export function extractWeb(url, options = {}) {
  return realExtractWeb(url, { lookup: publicLookup, ...options });
}

export function renderViaSidecar(url, options = {}) {
  return realRenderViaSidecar(url, { lookup: publicLookup, ...options });
}

export function resolveRedditUrl(input, ssrfOpts = {}) {
  return realResolveRedditUrl(input, { lookup: publicLookup, ...ssrfOpts });
}
