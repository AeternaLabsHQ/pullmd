// Same-origin check for browser form posts (login, signup, logout, OAuth
// consent).
//
// The comparison is on the hostname only, never the scheme or port: an
// instance can run as plain HTTP behind a TLS-terminating tunnel, where the
// browser sends `Origin: https://host` while Express sees an http request.
//
// A post is accepted when
//   - neither Origin nor Referer is present (non-browser clients), or
//   - the Origin (or, without one, the Referer) names the request's own host
//     (`req.hostname`, which honours X-Forwarded-Host only under
//     PULLMD_TRUST_PROXY) or the host of PUBLIC_URL.
// An opaque `Origin: null` without a usable Referer, or an unparsable header,
// is refused.

function hostOf(value) {
  try {
    return new URL(value).hostname.toLowerCase() || null;
  } catch {
    return null;
  }
}

export function sameOriginForm({ publicUrl } = {}) {
  const publicHost = publicUrl ? hostOf(publicUrl) : null;

  return (req, res, next) => {
    const origin = req.get('origin');
    const referer = req.get('referer');
    const source = origin && origin !== 'null' ? origin : referer;

    if (!source) {
      if (!origin) return next();
      return reject(res);
    }

    const host = hostOf(source);
    const own = (req.hostname || '').toLowerCase();
    if (host && ((own && host === own) || (publicHost && host === publicHost))) {
      return next();
    }
    return reject(res);
  };
}

function reject(res) {
  return res.status(403)
    .set('Content-Type', 'text/plain; charset=utf-8')
    .send('Forbidden: form posts are accepted from this site only.');
}
