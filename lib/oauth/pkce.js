import { createHash, timingSafeEqual } from 'node:crypto';

const VERIFIER_RE = /^[A-Za-z0-9\-._~]{43,128}$/;

export function verifyPkceS256(verifier, challenge) {
  if (typeof verifier !== 'string' || typeof challenge !== 'string') return false;
  if (!verifier || !challenge) return false;
  if (!VERIFIER_RE.test(verifier)) return false;

  const computed = createHash('sha256').update(verifier).digest('base64url');
  const a = Buffer.from(computed);
  const b = Buffer.from(challenge);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
