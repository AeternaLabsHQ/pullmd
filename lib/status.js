import { PULLMD_VERSION } from './distrib.js';

const DEFAULT_TIMEOUT_MS = 2_000;
const DEFAULT_TTL_MS = 5_000;

// Lowest address-policy revision a Playwright sidecar must report in its
// /health (`policy.ssrf`, see playwright-sidecar/ssrf.py). A sidecar from
// before v3.15.2 reports none and ignores the allowedHosts pullmd sends: it
// renders, but Chromium follows redirects into internal hosts
// (GHSA-26wr-prg5-vr77). Nothing on the render path can notice, so this is
// where a new pullmd next to an old pullmd-playwright becomes visible.
export const MIN_PLAYWRIGHT_POLICY = 1;

// Every sidecar exposes GET /health next to its working endpoint, so the
// configured URL is enough to reach both. Only Playwright fetches on its own;
// the others get their input from Node, which applies the policy itself.
const SIDECARS = [
  { name: 'trafilatura', envVar: 'TRAFILATURA_URL' },
  { name: 'playwright',  envVar: 'PLAYWRIGHT_URL', minPolicy: MIN_PLAYWRIGHT_POLICY },
  { name: 'markitdown',  envVar: 'MARKITDOWN_URL' },
];

function enforcesPolicy(body, minPolicy) {
  const revision = body?.policy?.ssrf;
  return Number.isInteger(revision) && revision >= minPolicy;
}

/** Turn a sidecar's working endpoint into its health endpoint. */
export function healthUrl(endpoint) {
  const url = new URL(endpoint);
  url.pathname = url.pathname.replace(/[^/]*$/, 'health');
  url.search = '';
  url.hash = '';
  return url.toString();
}

// Failure reasons stay a small closed vocabulary on purpose: /api/status is
// public, and a raw error message would put the internal sidecar hostname
// ("getaddrinfo ENOTFOUND playwright") into it.
async function probe(endpoint, { fetch: fetchFn, timeoutMs, minPolicy }) {
  let target;
  try {
    target = healthUrl(endpoint);
  } catch {
    return { status: 'down', error: 'misconfigured' };
  }

  const started = Date.now();
  let res;
  try {
    res = await fetchFn(target, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return { status: 'down', error: timedOut ? 'timeout' : 'unreachable' };
  }
  const latencyMs = Date.now() - started;

  if (!res.ok) return { status: 'down', error: `http ${res.status}`, latencyMs };

  // A sidecar that answers 200 but reports ok:false is up yet unusable - the
  // Playwright sidecar does exactly that when Chromium failed to launch.
  let body = null;
  try {
    body = await res.json();
  } catch {
    // Not JSON. It answered, that is all this endpoint promises to check -
    // unless a policy is expected, which an unreadable body cannot confirm.
  }
  if (body && body.ok === false) return { status: 'down', error: 'unhealthy', latencyMs };
  if (minPolicy && !enforcesPolicy(body, minPolicy)) {
    return { status: 'degraded', error: 'policy-missing', latencyMs };
  }
  return { status: 'ok', latencyMs };
}

async function collect({ fetch: fetchFn, env, timeoutMs, version }) {
  const entries = await Promise.all(SIDECARS.map(async ({ name, envVar, minPolicy }) => {
    const endpoint = env[envVar];
    if (!endpoint) return [name, { status: 'not-configured' }];
    return [name, await probe(endpoint, { fetch: fetchFn, timeoutMs, minPolicy })];
  }));

  const services = Object.fromEntries(entries);
  const ok = Object.values(services)
    .every((svc) => svc.status === 'ok' || svc.status === 'not-configured');
  return { ok, version, services };
}

/**
 * Build the /api/status probe. Results are cached briefly and concurrent
 * callers share one round of probes, so a monitor (or a hammering client)
 * cannot turn one public request into three internal ones each time.
 *
 * @param {object} [opts]
 * @param {typeof fetch} [opts.fetch]  injectable for tests
 * @param {object} [opts.env]          defaults to process.env (read per call)
 * @param {number} [opts.timeoutMs]    per-sidecar probe timeout
 * @param {number} [opts.ttlMs]        cache lifetime
 * @param {() => number} [opts.now]    injectable clock
 * @param {string} [opts.version]
 * @returns {() => Promise<{ok: boolean, version: string, services: object}>}
 */
export function createStatusChecker({
  fetch: fetchFn = globalThis.fetch,
  env = process.env,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  ttlMs = DEFAULT_TTL_MS,
  now = Date.now,
  version = PULLMD_VERSION,
} = {}) {
  let cached = null;
  let inflight = null;

  return async function checkStatus() {
    if (cached && now() - cached.at < ttlMs) return cached.value;
    if (inflight) return inflight;

    inflight = collect({ fetch: fetchFn, env, timeoutMs, version })
      .then((value) => {
        cached = { at: now(), value };
        return value;
      })
      .finally(() => { inflight = null; });

    return inflight;
  };
}
