import { resolveProvider } from './providers.js';
import { createRateLimiter } from '../oauth/rate-limit.js';

const DEFAULT_PER_HOUR = 30;

/**
 * Hourly budget for the tiers that call a paid provider (image caption, audio
 * transcription, PDF OCR). `PULLMD_LLM_RATE_LIMIT` sets the requests per hour;
 * 0 turns the budget off. Unset or unparsable values use the default.
 */
export function readLlmRateLimit(env = process.env) {
  const raw = String(env.PULLMD_LLM_RATE_LIMIT ?? '').trim();
  if (!/^\d+$/.test(raw)) return DEFAULT_PER_HOUR;
  return Number(raw);
}

const PROVIDER_FOR = {
  image: () => resolveProvider('VISION').apiKey,
  audio: () => resolveProvider('STT').apiKey,
  pdf: () => resolveProvider('PDF_OCR', { sharedFallback: false }).apiKey,
};

function providerConfigured(kind) {
  return !!PROVIDER_FOR[kind]?.();
}

/**
 * Per-request budget check. `forRequest(req)` returns `(kind) => boolean`,
 * consulted by the extractors right before a provider call. The key is the
 * logged-in user when there is one, else the client address (`req.ip`, which
 * honours the trust proxy setting). A tier without a configured provider
 * never consumes budget - its fallback is the same path either way.
 */
export function createLlmBudget({ limiter, perHour = readLlmRateLimit(), isConfigured = providerConfigured } = {}) {
  if (!limiter && perHour === 0) {
    return { forRequest: () => () => true };
  }
  const rl = limiter || createRateLimiter({ windowMs: 60 * 60_000, max: perHour });
  return {
    forRequest(req) {
      const key = req.user?.id != null ? `user:${req.user.id}` : `ip:${rl.keyFor(req)}`;
      return (kind) => !isConfigured(kind) || rl.check(key);
    },
  };
}
