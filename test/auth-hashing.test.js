import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword, verifyPassword } from '../lib/auth.js';

const fastOpts = { timeCost: 1, memoryCost: 1024, parallelism: 1 };

describe('password hashing', () => {
  it('hashes and verifies a password', async () => {
    const hash = await hashPassword('correct-horse-battery', fastOpts);
    assert.ok(hash.startsWith('$argon2id$'), 'must be argon2id');
    assert.equal(await verifyPassword(hash, 'correct-horse-battery'), true);
  });

  it('rejects a wrong password', async () => {
    const hash = await hashPassword('right', fastOpts);
    assert.equal(await verifyPassword(hash, 'wrong'), false);
  });

  it('produces different hashes for the same password (salt is random)', async () => {
    const a = await hashPassword('same', fastOpts);
    const b = await hashPassword('same', fastOpts);
    assert.notEqual(a, b);
  });

  it('verifyPassword returns false for malformed hash without throwing', async () => {
    assert.equal(await verifyPassword('not-a-real-hash', 'whatever'), false);
  });
});

describe('login miss timing', () => {
  it('decoy hash is a real argon2 hash', async () => {
    const { createCache } = await import('../lib/cache.js');
    const { createAuth } = await import('../lib/auth.js');
    const argon2 = (await import('argon2')).default;
    const cache = createCache(':memory:');
    const auth = createAuth({ db: cache.db, mode: 'multi-user', env: {}, argon2Opts: fastOpts });
    const hash = await auth._decoyHash;
    assert.equal(typeof hash, 'string');
    assert.equal(await argon2.verify(hash, 'x'), false);
    assert.match(hash, /m=1024/);
    assert.match(hash, /t=1/);
  });

  it('authenticate unknown email runs a full verify', async () => {
    const { createCache } = await import('../lib/cache.js');
    const { createAuth } = await import('../lib/auth.js');
    // Heavier than fastOpts, so a verify clearly dominates the noise.
    const opts = { timeCost: 2, memoryCost: 16384, parallelism: 1 };
    const cache = createCache(':memory:');
    const auth = createAuth({ db: cache.db, mode: 'multi-user', env: {}, argon2Opts: opts });
    await auth.createUser({ email: 'known@x.y', password: 'right-password' });
    await auth._decoyHash;
    const median = (xs) => xs.sort((a, b) => a - b)[Math.floor(xs.length / 2)];
    async function time(email) {
      const out = [];
      for (let i = 0; i < 5; i++) {
        const t0 = process.hrtime.bigint();
        assert.equal(await auth.authenticate(email, 'wrong-password'), null);
        out.push(Number(process.hrtime.bigint() - t0) / 1e6);
      }
      return median(out);
    }
    const known = await time('known@x.y');
    const unknown = await time('ghost@x.y');
    assert.ok(unknown >= known * 0.5, `unknown ${unknown.toFixed(2)} ms vs known ${known.toFixed(2)} ms`);
  });
});
