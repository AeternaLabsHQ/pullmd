export function createRateLimiter({ windowMs, max, now = () => Date.now() }) {
  // key -> array of request timestamps (ms)
  const buckets = new Map();

  function check(key) {
    const ts = now();
    const cutoff = ts - windowMs;
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
      const key = (req.headers['x-forwarded-for']?.split(',')[0].trim()) || req.ip || req.socket?.remoteAddress || 'unknown';
      if (check(key)) return next();
      res.set('Retry-After', String(retryAfterSeconds(key)));
      return res.status(429).json({ error: 'rate_limited' });
    };
  }

  return { check, retryAfterSeconds, middleware };
}
