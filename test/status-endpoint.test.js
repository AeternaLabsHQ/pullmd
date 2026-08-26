import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server.js';

async function get(app, path) {
  const server = app.listen(0);
  try {
    const res = await fetch(`http://localhost:${server.address().port}${path}`);
    return { status: res.status, body: await res.json() };
  } finally {
    server.close();
  }
}

const HEALTHY = {
  ok: true,
  version: '9.9.9',
  services: {
    trafilatura: { status: 'ok', latencyMs: 2 },
    playwright: { status: 'ok', latencyMs: 3 },
    markitdown: { status: 'not-configured' },
  },
};

describe('GET /api/status', () => {
  it('returns 200 and the service map when everything is healthy', async () => {
    const app = createApp({ cache: null, statusChecker: async () => HEALTHY });
    const res = await get(app, '/api/status');

    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.version, '9.9.9');
    assert.equal(res.body.services.playwright.status, 'ok');
  });

  it('returns 503 when a configured sidecar is down', async () => {
    // The whole point of the endpoint: a plain HTTP monitor must catch this,
    // not just a keyword monitor.
    const degraded = {
      ...HEALTHY,
      ok: false,
      services: { ...HEALTHY.services, playwright: { status: 'down', error: 'unreachable' } },
    };
    const app = createApp({ cache: null, statusChecker: async () => degraded });
    const res = await get(app, '/api/status');

    assert.equal(res.status, 503);
    assert.equal(res.body.ok, false);
    assert.equal(res.body.services.playwright.error, 'unreachable');
  });

  it('reports 503 rather than 500 when the check itself throws', async () => {
    const app = createApp({
      cache: null,
      statusChecker: async () => { throw new Error('boom'); },
    });
    const res = await get(app, '/api/status');

    assert.equal(res.status, 503);
    assert.equal(res.body.ok, false);
  });

  it('is reachable without authentication', async () => {
    // Monitors poll it unauthenticated; auth-mode instances must not gate it.
    const app = createApp({
      cache: null,
      statusChecker: async () => HEALTHY,
      auth: {
        mode: 'single-admin',
        middleware: () => (req, res, next) => next(),
        mountAuthRoutes: () => {},
        requireAuth: () => (req, res) => res.status(401).json({ error: 'unauthorized' }),
      },
    });
    const res = await get(app, '/api/status');

    assert.equal(res.status, 200);
  });
});
