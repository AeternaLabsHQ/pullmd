import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createTokens } from '../lib/oauth/tokens.js';

const SECRET = 'test-secret-must-be-at-least-32-bytes-long-xxxxxxxxxxxxxxxx';
const ISS = 'https://pullmd.example';
const AUD = 'https://pullmd.example/mcp';

function tk() {
  return createTokens({ secret: SECRET, issuer: ISS, audience: AUD });
}

describe('access tokens (JWT, HS256)', () => {
  it('issues a verifiable JWT with sub/scope claims', async () => {
    const t = tk();
    const jwt = await t.issueAccessToken({ sub: 42, scope: 'mcp:full' });
    const payload = await t.verifyAccessToken(jwt);
    assert.equal(payload.sub, '42');
    assert.equal(payload.scope, 'mcp:full');
    assert.equal(payload.iss, ISS);
    assert.equal(payload.aud, AUD);
    assert.ok(payload.jti);
    assert.ok(payload.exp > Math.floor(Date.now() / 1000));
  });

  it('rejects token with wrong audience', async () => {
    const t = tk();
    const jwt = await t.issueAccessToken({ sub: 1, scope: 'mcp:full' });
    const otherAud = createTokens({ secret: SECRET, issuer: ISS, audience: 'https://other/mcp' });
    await assert.rejects(() => otherAud.verifyAccessToken(jwt), /aud/i);
  });

  it('rejects token signed with different secret', async () => {
    const t = tk();
    const jwt = await t.issueAccessToken({ sub: 1, scope: 'mcp:full' });
    const otherSecret = createTokens({
      secret: 'different-secret-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
      issuer: ISS, audience: AUD,
    });
    await assert.rejects(() => otherSecret.verifyAccessToken(jwt), /signature/i);
  });

  it('rejects token without alg HS256 (alg-confusion guard)', async () => {
    const t = tk();
    // Hand-craft a "none" token
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({ sub: 1, iss: ISS, aud: AUD, exp: Math.floor(Date.now() / 1000) + 60 })).toString('base64url');
    const noneToken = `${header}.${payload}.`;
    await assert.rejects(() => t.verifyAccessToken(noneToken));
  });
});

describe('refresh tokens (opaque, hashed)', () => {
  it('generates token + hash, never the same hash twice', () => {
    const t = tk();
    const a = t.generateRefreshToken();
    const b = t.generateRefreshToken();
    assert.notEqual(a.token, b.token);
    assert.notEqual(a.tokenHash, b.tokenHash);
    assert.equal(a.tokenHash.length, 64); // sha256 hex
  });

  it('hashRefreshToken is deterministic', () => {
    const t = tk();
    const { token } = t.generateRefreshToken();
    assert.equal(t.hashRefreshToken(token), t.hashRefreshToken(token));
  });

  it('refresh token format: prefix pmd_rt_ + url-safe body', () => {
    const t = tk();
    const { token } = t.generateRefreshToken();
    assert.match(token, /^pmd_rt_[A-Za-z0-9_-]{43,}$/);
  });
});
