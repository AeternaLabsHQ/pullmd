/**
 * Outbound User-Agent rotation for the static web fetch path.
 *
 * The pool is initialised from a built-in seed list of currently-popular
 * desktop browsers. On first use (and every UA_POOL_TTL_MS thereafter) the
 * pool is refreshed in the background from a JSON feed of real-world UAs
 * — by default Sebastian Kuhbach's repo, configurable via env. If the feed
 * is unreachable we keep whatever pool we currently have.
 *
 * Environment:
 *   PULLMD_USER_AGENT     If set, every request uses this single UA. Disables rotation.
 *   PULLMD_UA_FEED_URL    Override the live-refresh feed URL. Set to an empty
 *                         string to disable live refresh entirely (seed-only).
 */

// Static seed pool — update at each release or every ~3 months.
// Last updated: 2026-10-09
// Source: https://github.com/WinFuture23/real-world-user-agents
// Desktop only (mobile UAs can trigger different page variants).
const UA_SEED_POOL = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36 Edg/152.0.0.0',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:153.0) Gecko/20100101 Firefox/153.0',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64; rv:157.0) Gecko/20100101 Firefox/157.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.0.1 Safari/605.1.15',
];

const DEFAULT_FEED_URL =
  'https://raw.githubusercontent.com/WinFuture23/real-world-user-agents/refs/heads/main/user-agents.json';
const UA_POOL_TTL_MS = 48 * 60 * 60 * 1000;
const FEED_TIMEOUT_MS = 5_000;

let uaPool = [...UA_SEED_POOL];
let uaPoolFetchedAt = 0;
let refreshInFlight = null;

async function refreshUaPoolNow(fetchFn = globalThis.fetch) {
  const feedEnv = process.env.PULLMD_UA_FEED_URL;
  if (feedEnv === '') return;
  const url = feedEnv || DEFAULT_FEED_URL;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FEED_TIMEOUT_MS);
  try {
    const r = await fetchFn(url, { signal: ctrl.signal });
    if (!r.ok) return;
    const json = await r.json();
    const uas = (Array.isArray(json?.user_agents) ? json.user_agents : [])
      .filter((o) => o && o.device_type === 'computer' && typeof o.ua === 'string' && o.ua.startsWith('Mozilla/'))
      .map((o) => o.ua);
    if (uas.length >= 5) {
      uaPool = uas;
      uaPoolFetchedAt = Date.now();
    }
  } catch {
    // Feed unreachable / parse error — keep existing pool.
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Trigger a background refresh of the UA pool if the TTL has expired.
 * Cheap to call repeatedly: TTL check is synchronous; refresh is fire-and-forget
 * via an in-flight lock so concurrent callers share a single request.
 *
 * Callers don't need to await — but the returned promise resolves once the
 * refresh attempt completes (used by tests).
 */
export function maybeRefreshUaPool({ fetch: fetchFn } = {}) {
  if (Date.now() - uaPoolFetchedAt < UA_POOL_TTL_MS) {
    return refreshInFlight || Promise.resolve();
  }
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = refreshUaPoolNow(fetchFn).finally(() => {
    refreshInFlight = null;
  });
  return refreshInFlight;
}

/**
 * Pick a User-Agent for the next outbound request.
 *
 * If PULLMD_USER_AGENT is set, it always wins (operator override / CI pin).
 * Otherwise a random entry from the current pool is returned.
 */
export function pickUserAgent() {
  const override = process.env.PULLMD_USER_AGENT;
  if (override) return override;
  return uaPool[Math.floor(Math.random() * uaPool.length)];
}

// Test helpers — not part of the public API.
export function _resetUaPoolForTest() {
  uaPool = [...UA_SEED_POOL];
  uaPoolFetchedAt = 0;
  refreshInFlight = null;
}
export function _setUaPoolFetchedAt(ts) {
  uaPoolFetchedAt = ts;
}
export function _getUaPool() {
  return [...uaPool];
}
export const _UA_SEED_POOL = UA_SEED_POOL;
