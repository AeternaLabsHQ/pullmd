import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createCache } from '../lib/cache.js';
import { createAuth, detectAuthMisconfig, formatBootstrapError, openPaidTiersWarning } from '../lib/auth.js';

const fastOpts = { timeCost: 1, memoryCost: 1024, parallelism: 1 };

function captureWarn(fn) {
  const lines = [];
  const result = fn((...args) => lines.push(args.join(' ')));
  return { result, lines };
}

describe('detectAuthMisconfig', () => {
  it('returns false when no PULLMD_AUTH_TOKEN is set', () => {
    assert.equal(detectAuthMisconfig({}), false);
    assert.equal(detectAuthMisconfig({ PULLMD_AUTH_MODE: 'disabled' }), false);
    assert.equal(detectAuthMisconfig({ PULLMD_AUTH_MODE: 'multi-user' }), false);
  });

  it('returns true when PULLMD_AUTH_TOKEN is set but mode is disabled', () => {
    assert.equal(detectAuthMisconfig({ PULLMD_AUTH_TOKEN: 'tok', PULLMD_AUTH_MODE: 'disabled' }), true);
  });

  it('returns true when PULLMD_AUTH_TOKEN is set but mode is missing', () => {
    assert.equal(detectAuthMisconfig({ PULLMD_AUTH_TOKEN: 'tok' }), true);
  });

  it('returns true when PULLMD_AUTH_TOKEN is set but mode is unknown junk', () => {
    assert.equal(detectAuthMisconfig({ PULLMD_AUTH_TOKEN: 'tok', PULLMD_AUTH_MODE: 'wat' }), true);
  });

  it('returns false when PULLMD_AUTH_TOKEN is set and mode is single-admin', () => {
    assert.equal(detectAuthMisconfig({ PULLMD_AUTH_TOKEN: 'tok', PULLMD_AUTH_MODE: 'single-admin' }), false);
  });

  it('returns false when PULLMD_AUTH_TOKEN is set and mode is multi-user', () => {
    assert.equal(detectAuthMisconfig({ PULLMD_AUTH_TOKEN: 'tok', PULLMD_AUTH_MODE: 'multi-user' }), false);
  });
});

describe('createAuth: isMisconfigured + console warning', () => {
  it('exposes isMisconfigured=true and logs the banner when token+disabled', () => {
    const cache = createCache(':memory:');
    const { result: auth, lines } = captureWarn((logger) =>
      createAuth({
        db: cache.db, mode: 'disabled',
        env: { PULLMD_AUTH_TOKEN: 'legacy-tok' },
        argon2Opts: fastOpts,
        warnLogger: logger,
      })
    );
    assert.equal(auth.isMisconfigured, true);
    const joined = lines.join('\n');
    assert.match(joined, /PULLMD_AUTH_TOKEN is set but PULLMD_AUTH_MODE is not/);
    assert.match(joined, /UNAUTHENTICATED/);
    assert.match(joined, /MIGRATION\.md/);
    // Visual ASCII bar must be there to make the warning unmissable in logs.
    assert.match(joined, /={20,}/);
  });

  it('does NOT log or flag in single-admin mode (token is wired up)', () => {
    const cache = createCache(':memory:');
    const { result: auth, lines } = captureWarn((logger) =>
      createAuth({
        db: cache.db, mode: 'single-admin',
        env: { PULLMD_AUTH_TOKEN: 'legacy-tok', PULLMD_ADMIN_EMAIL: 'a@b.c', PULLMD_ADMIN_PASSWORD: 'pw1234567' },
        argon2Opts: fastOpts,
        warnLogger: logger,
      })
    );
    assert.equal(auth.isMisconfigured, false);
    assert.equal(lines.length, 0);
  });

  it('does NOT log or flag when there is no token at all', () => {
    const cache = createCache(':memory:');
    const { result: auth, lines } = captureWarn((logger) =>
      createAuth({
        db: cache.db, mode: 'disabled',
        env: {},
        argon2Opts: fastOpts,
        warnLogger: logger,
      })
    );
    assert.equal(auth.isMisconfigured, false);
    assert.equal(lines.length, 0);
  });
});

describe('formatBootstrapError', () => {
  it('formats single-admin bootstrap error with var names and bar', () => {
    const out = formatBootstrapError('single-admin');
    assert.match(out, /={20,}/);
    assert.match(out, /PULLMD_AUTH_MODE=single-admin requires bootstrap credentials/);
    assert.match(out, /PULLMD_ADMIN_EMAIL/);
    assert.match(out, /PULLMD_ADMIN_PASSWORD/);
    assert.match(out, /min 8 characters/);
    assert.match(out, /MIGRATION\.md/);
  });

  it('formats multi-user bootstrap error with the same shape', () => {
    const out = formatBootstrapError('multi-user');
    assert.match(out, /PULLMD_AUTH_MODE=multi-user requires bootstrap credentials/);
    assert.match(out, /PULLMD_ADMIN_EMAIL/);
    assert.match(out, /PULLMD_ADMIN_PASSWORD/);
  });
});

describe('openPaidTiersWarning', () => {
  it('warns when a provider key is set and auth is disabled', () => {
    const w = openPaidTiersWarning({ PULLMD_LLM_API_KEY: 'k' }, 'disabled');
    assert.match(w, /PULLMD_LLM_API_KEY is set while PULLMD_AUTH_MODE is disabled/);
    assert.match(w, /PULLMD_LLM_RATE_LIMIT \(30 provider calls per hour/);
    assert.match(w, /127\.0\.0\.1/);
  });

  it('lists every key that is set', () => {
    const w = openPaidTiersWarning({ PULLMD_VISION_API_KEY: 'a', PULLMD_PDF_OCR_API_KEY: 'b' }, 'disabled');
    assert.match(w, /PULLMD_VISION_API_KEY, PULLMD_PDF_OCR_API_KEY are set/);
  });

  it('says so when the budget is off', () => {
    const w = openPaidTiersWarning({ PULLMD_STT_API_KEY: 'k', PULLMD_LLM_RATE_LIMIT: '0' }, 'disabled');
    assert.match(w, /with no limit \(PULLMD_LLM_RATE_LIMIT=0\)/);
  });

  it('stays quiet without keys or with sign-in', () => {
    assert.equal(openPaidTiersWarning({}, 'disabled'), null);
    assert.equal(openPaidTiersWarning({ PULLMD_LLM_API_KEY: 'k' }, 'single-admin'), null);
    assert.equal(openPaidTiersWarning({ PULLMD_LLM_API_KEY: 'k' }, 'multi-user'), null);
  });

  it('is logged by createAuth', () => {
    const cache = createCache(':memory:');
    const { lines } = captureWarn((logger) =>
      createAuth({ db: cache.db, mode: 'disabled', env: { PULLMD_VISION_API_KEY: 'k' }, argon2Opts: fastOpts, warnLogger: logger })
    );
    assert.equal(lines.length, 1);
    assert.match(lines[0], /^\[auth\] PULLMD_VISION_API_KEY is set/);
  });
});
