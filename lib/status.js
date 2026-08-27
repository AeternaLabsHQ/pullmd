import { PULLMD_VERSION } from './distrib.js';

const DEFAULT_TIMEOUT_MS = 2_000;
const DEFAULT_TTL_MS = 5_000;

// Every sidecar exposes GET /health next to its working endpoint, so the
// configured URL is enough to reach both.
const SIDECARS = [
  { name: 'trafilatura', envVar: 'TRAFILATURA_URL' },
  { name: 'playwright',  envVar: 'PLAYWRIGHT_URL' },
  { name: 'markitdown',  envVar: 'MARKITDOWN_URL' },
];

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
async function probe(endpoint, { fetch: fetchFn, timeoutMs }) {
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
  try {
    const body = await res.json();
    if (body && body.ok === false) return { status: 'down', error: 'unhealthy', latencyMs };
  } catch {
    // Not JSON. It answered, that is all this endpoint promises to check.
  }
  return { status: 'ok', latencyMs };
}

async function collect({ fetch: fetchFn, env, timeoutMs, version }) {
  const entries = await Promise.all(SIDECARS.map(async ({ name, envVar }) => {
    const endpoint = env[envVar];
    if (!endpoint) return [name, { status: 'not-configured' }];
    return [name, await probe(endpoint, { fetch: fetchFn, timeoutMs })];
  }));

  const services = Object.fromEntries(entries);
  const ok = Object.values(services).every((svc) => svc.status !== 'down');
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
