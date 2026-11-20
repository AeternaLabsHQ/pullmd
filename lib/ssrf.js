import net from 'node:net';
import { lookup as dnsLookup } from 'node:dns/promises';
import { Agent, fetch as undiciFetch } from 'undici';

export class SsrfError extends Error {
  /** @param {{transient?: boolean}} [opts] transient: DNS trouble, not an address-policy verdict */
  constructor(message, { transient = false } = {}) {
    super(message);
    this.name = 'SsrfError';
    this.code = 'SSRF_BLOCKED';
    this.transient = transient;
  }
}

// IPv4 ranges that must never be reached via user-supplied URLs.
// 100.64.0.0/10 (CGNAT/shared) covers Alibaba metadata 100.100.100.200.
// 169.254.0.0/16 (link-local) covers cloud metadata 169.254.169.254.
const BLOCKED_V4 = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
  ['224.0.0.0', 4], ['240.0.0.0', 4], ['255.255.255.255', 32],
];

// IPv6 ranges. fc00::/7 (unique-local) covers AWS metadata fd00:ec2::254.
const BLOCKED_V6 = [
  ['::1', 128], ['::', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8], ['2001:db8::', 32],
];

function buildBlockList(v4 = BLOCKED_V4, v6 = BLOCKED_V6) {
  const bl = new net.BlockList();
  for (const [addr, prefix] of v4) bl.addSubnet(addr, prefix, 'ipv4');
  for (const [addr, prefix] of v6) bl.addSubnet(addr, prefix, 'ipv6');

  // Block the blocked v4 ranges reached via IPv6 transition addressing
  // (NAT64 well-known prefix, IPv4-translated, IPv4-compatible, 6to4). Each
  // blocked v4 subnet gets the matching embedded v6 subnet, so a NAT64 host
  // still reaches public v4 (its embeddings are not blocked) while private
  // and metadata v4 stays blocked in every form. NAT64 local-use
  // (64:ff9b:1::/48) is checked in isBlockedIp(), because operators put the
  // v4 address under prefixes of their own inside that /48.
  for (const [addr, prefix] of v4) {
    const [a, b, c, d] = addr.split('.').map(Number);
    const hi = ((a << 8) | b).toString(16);
    const lo = ((c << 8) | d).toString(16);
    // NAT64 well-known prefix 64:ff9b::/96 - v4 in the low 32 bits
    bl.addSubnet(`64:ff9b:0:0:0:0:${hi}:${lo}`, 96 + prefix, 'ipv6');
    // IPv4-translated ::ffff:0:0:0/96 (RFC 2765 SIIT) - v4 in the low 32 bits.
    // Not IPv4-mapped (::ffff:a.b.c.d): a 16-bit zero group sits between.
    bl.addSubnet(`0:0:0:0:ffff:0:${hi}:${lo}`, 96 + prefix, 'ipv6');
    // IPv4-compatible ::/96 (deprecated) - v4 in the low 32 bits
    bl.addSubnet(`0:0:0:0:0:0:${hi}:${lo}`, 96 + prefix, 'ipv6');
    // 6to4 2002::/16 - v4 in bits 16-48
    bl.addSubnet(`2002:${hi}:${lo}:0:0:0:0:0`, 16 + prefix, 'ipv6');
  }

  return bl;
}

const DEFAULT_BLOCKLIST = buildBlockList();

/** The eight 16-bit groups of a valid IPv6 literal (:: and a dotted-quad tail expanded). */
function ipv6Groups(ip) {
  let text = ip.toLowerCase().split('%')[0];
  const quad = text.match(/(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (quad) {
    const [a, b, c, d] = quad.slice(1).map(Number);
    text = `${text.slice(0, quad.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, tail] = text.includes('::') ? text.split('::') : [text, null];
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const fill = tail === null ? [] : Array(8 - left.length - right.length).fill('0');
  return [...left, ...fill, ...right].map((g) => parseInt(g, 16));
}

// NAT64 local-use prefix 64:ff9b:1::/48 (RFC 8215): operators carve their
// own prefixes out of it, so the low 32 bits of any address in it are
// checked as IPv4.
function nat64LocalUseV4(ip) {
  const g = ipv6Groups(ip);
  if (g[0] !== 0x64 || g[1] !== 0xff9b || g[2] !== 1) return null;
  return `${g[6] >> 8}.${g[6] & 255}.${g[7] >> 8}.${g[7] & 255}`;
}

// net.BlockList decodes IPv4-mapped IPv6 (::ffff:a.b.c.d) against ipv4 rules,
// so one check(ip, family) call covers that form.
export function isBlockedIp(ip) {
  const family = net.isIP(ip);
  if (family === 0) return true; // not a parseable IP -> treat as unsafe
  if (family === 6) {
    const v4 = nat64LocalUseV4(ip);
    if (v4 && DEFAULT_BLOCKLIST.check(v4, 'ipv4')) return true;
  }
  return DEFAULT_BLOCKLIST.check(ip, family === 4 ? 'ipv4' : 'ipv6');
}

export function parseAllowedHosts(value) {
  const hostnames = new Set();
  let blockList = null;
  if (!value) return { blockList, hostnames };
  for (const raw of value.split(',')) {
    const entry = raw.trim();
    if (!entry) continue;
    const slash = entry.indexOf('/');
    if (slash !== -1) {
      const addr = entry.slice(0, slash);
      const prefix = Number(entry.slice(slash + 1));
      const family = net.isIP(addr);
      const maxPrefix = family === 4 ? 32 : 128;
      if (family !== 0 && Number.isInteger(prefix) && prefix >= 0 && prefix <= maxPrefix) {
        blockList = blockList || new net.BlockList();
        blockList.addSubnet(addr, prefix, family === 4 ? 'ipv4' : 'ipv6');
      }
    } else if (net.isIP(entry) !== 0) {
      blockList = blockList || new net.BlockList();
      blockList.addAddress(entry, net.isIP(entry) === 4 ? 'ipv4' : 'ipv6');
    } else {
      hostnames.add(entry.toLowerCase());
    }
  }
  return { blockList, hostnames };
}

function ipAllowed(ip, allow) {
  if (!allow.blockList) return false;
  const family = net.isIP(ip);
  if (family === 0) return false;
  return allow.blockList.check(ip, family === 4 ? 'ipv4' : 'ipv6');
}

/**
 * Resolve `host` and check every answer against the address policy.
 * Returns dns.lookup-style records ({address, family}); throws SsrfError.
 */
async function resolveAndCheck(host, { lookup = dnsLookup, env = process.env } = {}) {
  const allow = parseAllowedHosts(env.PULLMD_ALLOWED_HOSTS);
  const allowlistedName = allow.hostnames.has(host.toLowerCase());

  let records;
  if (net.isIP(host) !== 0) {
    records = [{ address: host, family: net.isIP(host) }];
  } else {
    try {
      records = await lookup(host, { all: true });
    } catch {
      throw new SsrfError(`could not resolve host: ${host}`, { transient: true });
    }
    records = records.map((r) => ({ address: r.address, family: r.family || net.isIP(r.address) }));
  }
  if (records.length === 0) throw new SsrfError(`host did not resolve: ${host}`, { transient: true });
  if (allowlistedName) return records;

  for (const { address } of records) {
    if (ipAllowed(address, allow)) continue;
    if (isBlockedIp(address)) {
      throw new SsrfError(`blocked address ${address} for host ${host}`);
    }
  }
  return records;
}

export async function assertUrlAllowed(rawUrl, { lookup = dnsLookup, env = process.env } = {}) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new SsrfError(`invalid URL: ${String(rawUrl).slice(0, 80)}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new SsrfError(`scheme not allowed: ${url.protocol}`);
  }

  const allow = parseAllowedHosts(env.PULLMD_ALLOWED_HOSTS);
  const host = url.hostname.replace(/^\[|\]$/g, ''); // strip v6 brackets
  if (allow.hostnames.has(host.toLowerCase())) {
    return { url, addresses: [] };
  }

  const records = await resolveAndCheck(host, { lookup, env });
  return { url, addresses: records.map((r) => r.address), records };
}

/**
 * undici Agent whose connect-time lookup never answers with an address the
 * policy has not checked. `pins` maps a lowercase hostname to the records
 * assertUrlAllowed validated for it, so the socket goes to exactly that
 * address and no second DNS query happens (closes the check-then-connect gap
 * a rebinding name could exploit). A hostname without a pin is resolved here
 * and checked before the answer reaches the socket.
 */
export function pinnedDispatcher(pins, { lookup = dnsLookup, env = process.env } = {}) {
  const connectLookup = (hostname, options, callback) => {
    if (typeof options === 'function') { callback = options; options = {}; }
    const answer = (records) => {
      if (options?.all) callback(null, records);
      else callback(null, records[0].address, records[0].family);
    };
    const pinned = pins.get(hostname.toLowerCase());
    if (pinned?.length) { answer(pinned); return; }
    resolveAndCheck(hostname, { lookup, env }).then(answer, callback);
  };
  return new Agent({ connect: { lookup: connectLookup } });
}

// One shared Agent keeps connection pooling across requests, as the global
// fetch did. A pooled connection was opened through the pinned lookup, so it
// already goes to a checked address.
const SHARED_PINS = new Map();
let sharedDispatcher = null;

/**
 * Wrap a fetch so that the first URL and every redirect hop pass the address
 * policy. Without an explicit `fetchFn` undici's fetch is used with a
 * dispatcher pinned to the validated addresses; an injected fetchFn (tests,
 * sidecar stubs) receives the dispatcher in `init` and may ignore it.
 */
export function safeFetch(fetchFn, { lookup = dnsLookup, env = process.env, maxRedirects = 5 } = {}) {
  let pins, dispatcher;
  if (lookup === dnsLookup && env === process.env) {
    pins = SHARED_PINS;
    dispatcher = sharedDispatcher ||= pinnedDispatcher(SHARED_PINS);
  } else {
    pins = new Map();
    dispatcher = pinnedDispatcher(pins, { lookup, env });
  }
  const doFetch = fetchFn || undiciFetch;
  return async function guardedFetch(rawUrl, init = {}) {
    let currentUrl = typeof rawUrl === 'string' ? rawUrl : String(rawUrl);
    for (let hop = 0; hop <= maxRedirects; hop++) {
      const { url, records } = await assertUrlAllowed(currentUrl, { lookup, env });
      const pinKey = records?.length ? url.hostname.toLowerCase() : null;
      if (pinKey) pins.set(pinKey, records);
      let res;
      try {
        res = await doFetch(currentUrl, { ...init, redirect: 'manual', dispatcher });
      } catch (err) {
        if (err?.cause instanceof SsrfError) throw err.cause;
        throw err;
      } finally {
        // The socket is open once headers arrived; a concurrent request for
        // the same name that finds no pin is resolved and checked by the
        // connector itself.
        if (pinKey && pins.get(pinKey) === records) pins.delete(pinKey);
      }
      const status = res.status;
      const location = status >= 300 && status < 400 ? res.headers.get('location') : null;
      if (!location) return res;
      await res.body?.cancel().catch(() => {});
      currentUrl = new URL(location, currentUrl).toString();
    }
    throw new SsrfError(`too many redirects (>${maxRedirects})`);
  };
}
