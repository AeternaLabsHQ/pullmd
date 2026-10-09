// One-time operator notice for instances that sit behind a reverse proxy
// without PULLMD_TRUST_PROXY. Express then ignores the forwarding headers,
// so req.ip is the proxy's address and every client lands in the same
// rate-limit bucket. Logging only; request handling is unchanged.

export const FORWARDED_HEADER_NOTICE =
  'Requests arrive through a proxy but PULLMD_TRUST_PROXY is not set: all clients share one rate-limit bucket and the client address is the proxy\'s. See MIGRATION.md.';

const FORWARDING_HEADERS = ['x-forwarded-for', 'forwarded', 'x-forwarded-proto'];

/**
 * Returns a middleware that logs FORWARDED_HEADER_NOTICE the first time a
 * request carries a forwarding header, and never again for this instance.
 * Install it only when trust proxy is off.
 */
export function createForwardedHeaderNotice({ warn = (...args) => console.warn(...args) } = {}) {
  let logged = false;
  return function forwardedHeaderNotice(req, res, next) {
    if (!logged && FORWARDING_HEADERS.some((h) => req.headers[h] !== undefined)) {
      logged = true;
      warn(FORWARDED_HEADER_NOTICE);
    }
    next();
  };
}
