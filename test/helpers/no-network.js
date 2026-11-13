// Test preload (`node --import ./test/helpers/no-network.js --test`, wired
// into `npm test`): the suite must run without name resolution and without
// network. Every DNS lookup of a name outside localhost and every TCP
// connection to a non-loopback address fails with a "[no-network]" error, and
// the test file's process then exits non-zero even when the test swallowed
// the error (the SSRF guard turns lookup failures into a generic "could not
// resolve host"). Tests inject a lookup instead, see test/helpers/fake-dns.js.
import dns from 'node:dns';
import net from 'node:net';
import { syncBuiltinESMExports } from 'node:module';

// lib/user-agent.js refreshes its UA pool from a public feed in the
// background on the first extractWeb call. Tests never want that request;
// the empty value is the documented operator switch that disables it.
// user-agent.test.js sets the variable itself.
process.env.PULLMD_UA_FEED_URL ??= '';

const LOCAL_NAMES = new Set(['localhost', 'ip6-localhost']);
const blocked = new Set();

function isLocalName(hostname) {
  const h = String(hostname).toLowerCase().replace(/\.$/, '');
  return LOCAL_NAMES.has(h) || h.endsWith('.localhost');
}

function isLoopbackIp(ip) {
  const family = net.isIP(ip);
  if (family === 4) return ip.startsWith('127.');
  if (family === 6) return ip === '::1' || /^::ffff:127\./i.test(ip);
  return false;
}

function blockedError(what) {
  blocked.add(what);
  const err = new Error(`[no-network] ${what} during tests; inject a lookup (test/helpers/fake-dns.js) or a fetch`);
  err.code = 'ENOTFOUND';
  const caller = new Error().stack.split('\n').slice(3, 9).join('\n');
  process.stderr.write(`${err.message}\n${caller}\n`);
  return err;
}

const realLookup = dns.lookup;
const realPromisesLookup = dns.promises.lookup;

dns.lookup = function lookup(hostname, options, callback) {
  if (net.isIP(hostname) || isLocalName(hostname)) return realLookup.call(this, hostname, options, callback);
  const cb = typeof options === 'function' ? options : callback;
  const err = blockedError(`DNS lookup of "${hostname}"`);
  process.nextTick(() => cb(err));
  return {};
};

dns.promises.lookup = async function lookup(hostname, options) {
  if (net.isIP(hostname) || isLocalName(hostname)) return realPromisesLookup.call(this, hostname, options);
  throw blockedError(`DNS lookup of "${hostname}"`);
};

syncBuiltinESMExports();

// TCP: a connection may only go to loopback. A hostname is resolved by the
// socket's own lookup (an injected one, e.g. the SSRF guard's pinned
// dispatcher, or dns.lookup above); its answers are checked before connecting.
const realConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function connect(...args) {
  // net.connect() hands over an already normalized [options, cb] array.
  const [options, cb] = Array.isArray(args[0]) ? args[0] : net._normalizeArgs(args);
  if (options.path) return realConnect.call(this, ...args);
  const host = options.host ?? 'localhost';
  if (net.isIP(host)) {
    if (isLoopbackIp(host)) return realConnect.call(this, ...args);
    const err = blockedError(`connection to ${host}:${options.port}`);
    process.nextTick(() => this.destroy(err));
    return this;
  }
  const innerLookup = options.lookup || dns.lookup;
  const lookup = (hostname, lookupOpts, callback) => {
    innerLookup(hostname, lookupOpts, (err, address, family) => {
      if (err) return callback(err);
      const addresses = Array.isArray(address) ? address.map((a) => a.address) : [address];
      const outside = addresses.find((a) => !isLoopbackIp(a));
      if (outside) return callback(blockedError(`connection to ${hostname} (${outside}):${options.port}`));
      callback(null, address, family);
    });
  };
  return realConnect.call(this, { ...options, lookup }, cb);
};

process.on('exit', (code) => {
  if (blocked.size === 0) return;
  process.stderr.write(`[no-network] blocked in ${process.argv[1] || 'process'}: ${[...blocked].join(', ')}\n`);
  if (code === 0) process.exitCode = 1;
});
