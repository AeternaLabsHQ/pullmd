import net from 'node:net';
import { lookup as dnsLookup } from 'node:dns/promises';

export class SsrfError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SsrfError';
    this.code = 'SSRF_BLOCKED';
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

  // Block blocked-v4 ranges reached via IPv6 transition addressing (NAT64,
  // 6to4, IPv4-compatible). Per blocked v4 subnet we add the matching embedded
  // v6 subnet, so a NAT64 host still resolves legit public v4 (its embeddings
  // are not blocked) while metadata/private v4 stays blocked in every form.
  for (const [addr, prefix] of v4) {
    const [a, b, c, d] = addr.split('.').map(Number);
    const hi = ((a << 8) | b).toString(16);
    const lo = ((c << 8) | d).toString(16);
    // NAT64 well-known prefix 64:ff9b::/96 - v4 in the low 32 bits
    bl.addSubnet(`64:ff9b:0:0:0:0:${hi}:${lo}`, 96 + prefix, 'ipv6');
    // IPv4-compatible ::/96 (deprecated) - v4 in the low 32 bits
    bl.addSubnet(`0:0:0:0:0:0:${hi}:${lo}`, 96 + prefix, 'ipv6');
    // 6to4 2002::/16 - v4 in bits 16-48
    bl.addSubnet(`2002:${hi}:${lo}:0:0:0:0:0`, 16 + prefix, 'ipv6');
  }

  return bl;
}

const DEFAULT_BLOCKLIST = buildBlockList();

// net.BlockList decodes IPv4-mapped IPv6 (::ffff:a.b.c.d) against ipv4 rules,
// so a single check(ip, family) call is sufficient.
export function isBlockedIp(ip) {
  const family = net.isIP(ip);
  if (family === 0) return true; // not a parseable IP -> treat as unsafe
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

  let addresses;
  if (net.isIP(host) !== 0) {
    addresses = [host];
  } else {
    let records;
    try {
      records = await lookup(host, { all: true });
    } catch {
      throw new SsrfError(`could not resolve host: ${host}`);
    }
    addresses = records.map((r) => r.address);
  }
  if (addresses.length === 0) throw new SsrfError(`host did not resolve: ${host}`);

  for (const ip of addresses) {
    if (ipAllowed(ip, allow)) continue;
    if (isBlockedIp(ip)) {
      throw new SsrfError(`blocked address ${ip} for host ${host}`);
    }
  }
  return { url, addresses };
}

export function safeFetch(fetchFn, { lookup = dnsLookup, env = process.env, maxRedirects = 5 } = {}) {
  return async function guardedFetch(rawUrl, init = {}) {
    let currentUrl = typeof rawUrl === 'string' ? rawUrl : String(rawUrl);
    for (let hop = 0; hop <= maxRedirects; hop++) {
      await assertUrlAllowed(currentUrl, { lookup, env });
      const res = await fetchFn(currentUrl, { ...init, redirect: 'manual' });
      const status = res.status;
      const location = status >= 300 && status < 400 ? res.headers.get('location') : null;
      if (!location) return res;
      currentUrl = new URL(location, currentUrl).toString();
    }
    throw new SsrfError(`too many redirects (>${maxRedirects})`);
  };
}
