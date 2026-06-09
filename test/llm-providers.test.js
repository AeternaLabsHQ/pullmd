import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveProvider, mapUsage, abortController } from '../lib/llm/providers.js';

const save = (...k) => { const s = {}; for (const n of k) s[n] = process.env[n]; return s; };
const restore = (s) => { for (const [n, v] of Object.entries(s)) { if (v === undefined) delete process.env[n]; else process.env[n] = v; } };

describe('resolveProvider', () => {
  it('reads per-modality vars', () => {
    const s = save('PULLMD_VISION_API_KEY', 'PULLMD_VISION_BASE_URL', 'PULLMD_VISION_MODEL', 'PULLMD_LLM_API_KEY', 'PULLMD_LLM_BASE_URL');
    delete process.env.PULLMD_LLM_API_KEY; delete process.env.PULLMD_LLM_BASE_URL;
    process.env.PULLMD_VISION_API_KEY = 'k1';
    process.env.PULLMD_VISION_BASE_URL = 'https://vision.example/v1';
    process.env.PULLMD_VISION_MODEL = 'm1';
    assert.deepEqual(resolveProvider('VISION'), { apiKey: 'k1', baseUrl: 'https://vision.example/v1', model: 'm1' });
    restore(s);
  });

  it('falls back to shared PULLMD_LLM_* for key+baseUrl, model undefined', () => {
    const s = save('PULLMD_STT_API_KEY', 'PULLMD_STT_BASE_URL', 'PULLMD_STT_MODEL', 'PULLMD_LLM_API_KEY', 'PULLMD_LLM_BASE_URL');
    delete process.env.PULLMD_STT_API_KEY; delete process.env.PULLMD_STT_BASE_URL; delete process.env.PULLMD_STT_MODEL;
    process.env.PULLMD_LLM_API_KEY = 'shared';
    process.env.PULLMD_LLM_BASE_URL = 'https://shared/v1';
    assert.deepEqual(resolveProvider('STT'), { apiKey: 'shared', baseUrl: 'https://shared/v1', model: undefined });
    restore(s);
  });

  it('returns apiKey undefined when nothing is configured', () => {
    const s = save('PULLMD_VISION_API_KEY', 'PULLMD_LLM_API_KEY');
    delete process.env.PULLMD_VISION_API_KEY; delete process.env.PULLMD_LLM_API_KEY;
    assert.equal(resolveProvider('VISION').apiKey, undefined);
    restore(s);
  });
});

describe('mapUsage', () => {
  it('keeps model + present token fields, null when empty', () => {
    assert.deepEqual(mapUsage({ prompt_tokens: 3, completion_tokens: 5, total_tokens: 8 }, 'm'),
      { model: 'm', prompt_tokens: 3, completion_tokens: 5, total_tokens: 8 });
    assert.equal(mapUsage(null, null), null);
    assert.deepEqual(mapUsage(null, 'm'), { model: 'm' });
  });
});

describe('abortController', () => {
  it('aborts immediately when the incoming signal is already aborted', () => {
    const ac = new AbortController(); ac.abort();
    const { signal, cleanup } = abortController({ signal: ac.signal }, 1000);
    assert.equal(signal.aborted, true);
    cleanup();
  });
});
