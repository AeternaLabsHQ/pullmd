import { assertUrlAllowed, SsrfError } from './ssrf.js';
import { readBodyCapped } from './fetch-body.js';

const SIDECAR_TIMEOUT_MS = 25_000;

/**
 * Send a URL to the Playwright sidecar and get back the rendered DOM as HTML.
 *
 * @param {string} url
 * @param {object} [opts]
 * @param {AbortSignal} [opts.signal]  External cancel (e.g. SSE client disconnect)
 * @param {typeof fetch} [opts.fetch]  Injectable for tests
 * @returns {Promise<string>} rendered HTML
 */
async function sidecarDetail(res) {
  try {
    const parsed = await res.json();
    return parsed && typeof parsed.detail === 'object' ? parsed.detail : null;
  } catch {
    return null;
  }
}

export async function renderViaSidecar(url, { signal, fetch: fetchFn = globalThis.fetch, waitFor, waitTimeoutMs, mobileUa, userAgent } = {}) {
  if (!process.env.PLAYWRIGHT_URL) throw new Error('Playwright sidecar not configured (PLAYWRIGHT_URL env)');

  // SSRF guard, first hop: fail fast here before paying for a render. The
  // sidecar enforces the same policy on every request Chromium makes after
  // that (redirects, meta refresh, scripts, iframes, subresources), because
  // none of those come back through Node (GHSA-26wr-prg5-vr77). It gets the
  // allowlist in the request body so both layers apply the same exceptions.
  await assertUrlAllowed(url);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), SIDECAR_TIMEOUT_MS);
  const onAbort = () => ctrl.abort();
  if (signal) {
    if (signal.aborted) ctrl.abort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }

  const body = { url };
  if (waitFor !== undefined)       body.waitFor = waitFor;
  if (waitTimeoutMs !== undefined) body.waitTimeoutMs = waitTimeoutMs;
  if (mobileUa !== undefined)      body.mobileUa = mobileUa;
  if (userAgent !== undefined)     body.userAgent = userAgent;
  if (process.env.PULLMD_ALLOWED_HOSTS) body.allowedHosts = process.env.PULLMD_ALLOWED_HOSTS;

  try {
    const res = await fetchFn(process.env.PLAYWRIGHT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (res.status === 403) {
      // The sidecar refused a navigation the policy forbids. Same error type
      // as the first-hop check so the callers map it to 403 / "URL not allowed".
      const detail = await sidecarDetail(res);
      if (detail?.code === 'ssrf_blocked') {
        throw new SsrfError(`${detail.reason || 'blocked by render policy'} (via ${detail.url || url})`);
      }
    }
    if (!res.ok) throw new Error(`Sidecar returned ${res.status}`);
    // Bounded read; the abort timer above stays armed until the body is in.
    // TextDecoder drops a leading BOM like Response.text() does.
    const bytes = await readBodyCapped(res, { signal: ctrl.signal });
    return bytes ? new TextDecoder().decode(bytes) : await res.text();
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}
