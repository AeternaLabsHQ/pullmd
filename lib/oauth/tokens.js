import { SignJWT, jwtVerify } from 'jose';
import { randomBytes, createHash } from 'node:crypto';

const ACCESS_TOKEN_TTL_SEC = 3600; // 1h
const REFRESH_TOKEN_TTL_SEC = 30 * 24 * 3600; // 30d

export function createTokens({ secret, issuer, audience }) {
  if (!secret || typeof secret !== 'string' || secret.length < 32) {
    throw new Error('OAUTH_JWT_SECRET must be at least 32 characters');
  }
  if (!issuer) throw new Error('createTokens: issuer is required');
  if (!audience) throw new Error('createTokens: audience is required');

  const key = new TextEncoder().encode(secret);

  async function issueAccessToken({ sub, scope }) {
    return await new SignJWT({ scope })
      .setProtectedHeader({ alg: 'HS256', typ: 'at+jwt' })
      .setIssuer(issuer)
      .setAudience(audience)
      .setSubject(String(sub))
      .setIssuedAt()
      .setExpirationTime(`${ACCESS_TOKEN_TTL_SEC}s`)
      .setJti(randomBytes(16).toString('hex'))
      .sign(key);
  }

  async function verifyAccessToken(jwt) {
    const { payload } = await jwtVerify(jwt, key, {
      issuer,
      audience,
      algorithms: ['HS256'],
    });
    return payload;
  }

  function generateRefreshToken() {
    const body = randomBytes(32).toString('base64url');
    const token = `pmd_rt_${body}`;
    return { token, tokenHash: hashRefreshToken(token) };
  }

  function hashRefreshToken(token) {
    return createHash('sha256').update(token).digest('hex');
  }

  return {
    ACCESS_TOKEN_TTL_SEC,
    REFRESH_TOKEN_TTL_SEC,
    issueAccessToken,
    verifyAccessToken,
    generateRefreshToken,
    hashRefreshToken,
  };
}
