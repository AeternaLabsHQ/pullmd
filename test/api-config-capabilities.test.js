import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from './helpers/fake-dns.js';

const ENV_KEYS = [
  'TRAFILATURA_URL',
  'PLAYWRIGHT_URL',
  'PULLMD_VISION_API_KEY',
  'PULLMD_LLM_API_KEY',
  'PULLMD_EMBEDDED_IMAGES',
];
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

function setEnv(values) {
  for (const k of ENV_KEYS) delete process.env[k];
  for (const [k, v] of Object.entries(values)) process.env[k] = v;
}

async function withServer(app, fn) {
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  try {
    return await fn(`http://localhost:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function configFor(values) {
  setEnv(values);
  return withServer(createApp({}), async (base) => (await fetch(`${base}/api/config`)).json());
}

describe('GET /api/config capability flags', () => {
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
  });

  it('trafilatura follows TRAFILATURA_URL', async () => {
    assert.equal((await configFor({ TRAFILATURA_URL: 'http://trafilatura:8000/extract' })).trafilatura, true);
    assert.equal((await configFor({})).trafilatura, false);
  });

  it('playwright follows PLAYWRIGHT_URL', async () => {
    assert.equal((await configFor({ PLAYWRIGHT_URL: 'http://playwright:8000/render' })).playwright, true);
    assert.equal((await configFor({})).playwright, false);
  });

  it('embeddedImages needs a vision key and a mode other than off', async () => {
    assert.equal((await configFor({ PULLMD_VISION_API_KEY: 'k' })).embeddedImages, true);
    assert.equal((await configFor({ PULLMD_VISION_API_KEY: 'k', PULLMD_EMBEDDED_IMAGES: 'off' })).embeddedImages, false);
    assert.equal((await configFor({})).embeddedImages, false);
  });
});
