import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { verifyPkceS256 } from '../lib/oauth/pkce.js';

function makeChallenge(verifier) {
  return createHash('sha256').update(verifier).digest('base64url');
}

describe('PKCE S256 verifier', () => {
  it('returns true for matching verifier+challenge pair', () => {
    const verifier = randomBytes(32).toString('base64url');
    const challenge = makeChallenge(verifier);
    assert.equal(verifyPkceS256(verifier, challenge), true);
  });

  it('returns false for mismatched verifier', () => {
    const challenge = makeChallenge(randomBytes(32).toString('base64url'));
    assert.equal(verifyPkceS256('wrong-verifier', challenge), false);
  });

  it('returns false for empty inputs', () => {
    assert.equal(verifyPkceS256('', 'x'), false);
    assert.equal(verifyPkceS256('x', ''), false);
    assert.equal(verifyPkceS256(null, 'x'), false);
    assert.equal(verifyPkceS256('x', undefined), false);
  });

  it('rejects verifier shorter than 43 chars (RFC 7636 §4.1)', () => {
    const short = 'a'.repeat(42);
    const challenge = makeChallenge(short);
    assert.equal(verifyPkceS256(short, challenge), false);
  });

  it('rejects verifier longer than 128 chars', () => {
    const long = 'a'.repeat(129);
    const challenge = makeChallenge(long);
    assert.equal(verifyPkceS256(long, challenge), false);
  });

  it('rejects verifier with disallowed chars', () => {
    const verifier = 'a'.repeat(43) + '@!#';
    const challenge = makeChallenge(verifier);
    assert.equal(verifyPkceS256(verifier, challenge), false);
  });
});
