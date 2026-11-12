import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server.js';
import { createCache } from '../lib/cache.js';
import { SsrfError } from '../lib/ssrf.js';

const MCP_HEADERS = { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream' };

async function callReadUrl(app, args) {
  const server = app.listen(0);
  try {
    const res = await fetch(`http://localhost:${server.address().port}/mcp`, {
      method: 'POST',
      headers: MCP_HEADERS,
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'read_url', arguments: args } }),
    });
    const m = (await res.text()).match(/^data: (.+)$/m);
    assert.ok(m, 'expected an SSE data line');
    return JSON.parse(m[1]);
  } finally {
    server.close();
  }
}

// The address guard has to hold on the MCP path too, not only on /api:
// read_url is the entry point agents use.
describe('MCP read_url - address policy', () => {
  function appWithSpies() {
    const calls = { web: 0, reddit: 0 };
    const cache = createCache(':memory:');
    const app = createApp({
      cache,
      extractWeb: async () => { calls.web++; return { markdown: '# leaked', title: 'leaked', source: 'readability', metadata: {} }; },
      extractPost: async () => { calls.reddit++; return '# leaked'; },
    });
    return { app, cache, calls };
  }

  const blocked = [
    ['loopback literal', 'http://127.0.0.1:8080/admin'],
    ['private range literal', 'http://10.0.0.5/'],
    ['cloud metadata address', 'http://169.254.169.254/latest/meta-data/'],
    ['IPv6 loopback', 'http://[::1]/'],
    ['non-http scheme', 'file:///etc/passwd'],
  ];

  for (const [label, url] of blocked) {
    it(`refuses a ${label} before any extractor runs`, async () => {
      const { app, cache, calls } = appWithSpies();
      const j = await callReadUrl(app, { url });
      assert.equal(j.result.isError, true);
      assert.match(j.result.content[0].text, /^URL not allowed: /);
      assert.ok(!j.result.content[0].text.includes('leaked'));
      assert.deepEqual(calls, { web: 0, reddit: 0 });
      assert.equal(cache.get(url), null, 'a refused URL must not leave a cache row');
    });
  }

  it('reports a guard hit on a later hop (redirect, render navigation) as a tool error', async () => {
    const cache = createCache(':memory:');
    // IP literal: passes the first check without a DNS lookup.
    const url = 'http://8.8.8.8/redirects-inward';
    const app = createApp({
      cache,
      extractWeb: async () => { throw new SsrfError('blocked address 172.20.0.4 for host internal-secret'); },
    });
    const j = await callReadUrl(app, { url });
    assert.equal(j.result.isError, true);
    assert.match(j.result.content[0].text, /^URL not allowed: .*internal-secret/);
    assert.equal(cache.get(url), null);
  });
});
