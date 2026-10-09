export function createRateLimiter({ windowMs, max, now = () => Date.now() }) {
  // key -> array of request timestamps (ms)
  const buckets = new Map();
  // On an unauthenticated public route the number of distinct client keys is
  // unbounded, so idle keys are swept once the Map passes a size threshold.
  const SWEEP_AT = 10_000;

  function sweep(cutoff) {
    for (const [k, arr] of buckets) {
      if (arr.length === 0 || arr[arr.length - 1] < cutoff) buckets.delete(k);
    }
  }

  function check(key) {
    const ts = now();
    const cutoff = ts - windowMs;
    if (buckets.size >= SWEEP_AT) sweep(cutoff);
    const arr = buckets.get(key) || [];
    const live = arr.filter(t => t >= cutoff);
    if (live.length >= max) {
      buckets.set(key, live);
      return false;
    }
    live.push(ts);
    buckets.set(key, live);
    return true;
  }

  function retryAfterSeconds(key) {
    const arr = buckets.get(key) || [];
    if (arr.length === 0) return 0;
    const oldest = arr[0];
    return Math.max(1, Math.ceil((oldest + windowMs - now()) / 1000));
  }

  function middleware() {
    return (req, res, next) => {
      const key = keyFor(req);
      if (check(key)) return next();
      res.set('Retry-After', String(retryAfterSeconds(key)));
      return res.status(429).json({ error: 'rate_limited' });
    };
  }

  // req.ip honours the app's `trust proxy` setting (PULLMD_TRUST_PROXY), so
  // forwarding headers count only when they come from a configured proxy.
  function keyFor(req) {
    return req.ip || req.socket?.remoteAddress || 'unknown';
  }

  return { check, retryAfterSeconds, middleware, keyFor, size: () => buckets.size };
}
