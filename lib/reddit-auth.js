/**
 * Reddit OAuth2 client_credentials helper.
 *
 * If REDDIT_CLIENT_ID and REDDIT_CLIENT_SECRET are set, this module:
 *   - obtains a Bearer token via Reddit's /api/v1/access_token endpoint
 *   - caches the token in memory until ~1 minute before expiry
 *   - returns Reddit URLs rewritten to oauth.reddit.com
 *
 * If credentials are absent, redditFetch falls back to public www.reddit.com
 * with just the User-Agent — same behavior as before this module was added.
 *
 * Reddit requires a unique User-Agent. Configure via REDDIT_USER_AGENT.
 */

const TOKEN_ENDPOINT = 'https://www.reddit.com/api/v1/access_token';
const REFRESH_LEEWAY_MS = 60_000;

let tokenCache = null;

/**
 * Reddit refused the configured app credentials at the token endpoint
 * (401/403). Carries an actionable message instead of a bare status (#98).
 */
export class RedditAuthError extends Error {
  constructor(status) {
    super(`Reddit rejected the configured API credentials (REDDIT_CLIENT_ID / REDDIT_CLIENT_SECRET), token request returned ${status}`);
    this.name = 'RedditAuthError';
    this.status = status;
  }
}

export function isAuthConfigured(env = process.env) {
  return Boolean(env.REDDIT_CLIENT_ID && env.REDDIT_CLIENT_SECRET);
}

export function getUserAgent(env = process.env) {
  return env.REDDIT_USER_AGENT || 'PullMD/1.0 (URL-to-Markdown service)';
}

async function fetchToken(env, fetchFn) {
  const auth = Buffer.from(`${env.REDDIT_CLIENT_ID}:${env.REDDIT_CLIENT_SECRET}`).toString('base64');
  const res = await fetchFn(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${auth}`,
      'User-Agent': getUserAgent(env),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  if (res.status === 401 || res.status === 403) throw new RedditAuthError(res.status);
  if (!res.ok) throw new Error(`Reddit token request failed: ${res.status}`);
  const data = await res.json();
  return {
    token: data.access_token,
    expiresAt: Date.now() + (data.expires_in * 1000),
  };
}

export async function getToken({ env = process.env, fetchFn = globalThis.fetch } = {}) {
  if (!isAuthConfigured(env)) return null;
  if (tokenCache && tokenCache.expiresAt - REFRESH_LEEWAY_MS > Date.now()) {
    return tokenCache.token;
  }
  tokenCache = await fetchToken(env, fetchFn);
  return tokenCache.token;
}

export function clearTokenCache() {
  tokenCache = null;
}

/**
 * Reddit-aware fetch. Auto-rewrites www.reddit.com URLs to oauth.reddit.com
 * when credentials are configured, attaches Bearer token, and adds proper
 * User-Agent. Otherwise behaves like a normal fetch with just User-Agent.
 *
 * @param {string} url        Reddit URL (any subdomain)
 * @param {object} [opts]     Standard fetch options
 * @param {object} [internal] Test injection: { env, fetchFn }
 */
export async function redditFetch(url, opts = {}, { env = process.env, fetchFn = globalThis.fetch } = {}) {
  const headers = { 'User-Agent': getUserAgent(env), ...(opts.headers || {}) };

  if (isAuthConfigured(env)) {
    const token = await getToken({ env, fetchFn });
    headers['Authorization'] = `Bearer ${token}`;
    const u = new URL(url);
    if (/^(www\.|old\.|new\.)?reddit\.com$/.test(u.hostname)) {
      u.hostname = 'oauth.reddit.com';
      url = u.href;
    }
  }

  return fetchFn(url, { ...opts, headers });
}
