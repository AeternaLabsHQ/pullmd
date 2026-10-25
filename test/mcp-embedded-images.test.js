import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server.js';
import { createCache } from '../lib/cache.js';
import { createLlmBudget } from '../lib/llm/budget.js';

// MCP wiring for embedded image transcripts: the `images` param of
// read_url, cache validity and noStore handling, and the get_share refresh.
// Mirrors test/server-embedded-images.test.js for the /api surface.

const REDDIT = 'https://www.reddit.com/r/javascript/comments/abc123/test/';
const WEB = 'https://example.com/article';

const ENV_KEYS = ['PULLMD_EMBEDDED_IMAGES', 'PULLMD_EMBEDDED_IMAGES_MAX', 'PULLMD_VISION_API_KEY', 'PULLMD_LLM_API_KEY'];

/** Run fn with the given env (keys not listed are cleared), restoring afterwards. */
async function withEnv(vars, fn) {
  const prev = {};
  for (const k of ENV_KEYS) {
    prev[k] = process.env[k];
    if (vars[k] === undefined) delete process.env[k]; else process.env[k] = vars[k];
  }
  try {
    return await fn();
  } finally {
    for (const k of ENV_KEYS) {
      if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k];
    }
  }
}

async function request(app, path, opts = {}) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const port = server.address().port;
      fetch(`http://localhost:${port}${path}`, opts)
        .then(async (res) => {
          const text = await res.text();
          server.close();
          resolve({ status: res.status, body: text });
        })
        .catch((err) => { server.close(); reject(err); });
    });
  });
}

function parseSse(text) {
  const m = text.match(/^data: (.+)$/m);
  return m ? JSON.parse(m[1]) : null;
}

const MCP_HEADERS = { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream' };

async function rpc(app, method, params, id = 1) {
  const res = await request(app, '/mcp', {
    method: 'POST',
    headers: MCP_HEADERS,
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  });
  return parseSse(res.body);
}

const callTool = (app, name, args, id) => rpc(app, 'tools/call', { name, arguments: args }, id);
const textOf = (j) => j.result.content[0].text;

/** extractPost double that records its options. */
function recordingStub(result = {}) {
  const calls = [];
  const fn = async (url, opts) => {
    calls.push(opts);
    return { markdown: '# Test Post\n\nBody.', meta: { subreddit: 'r/javascript' }, ...result };
  };
  return { fn, calls };
}

function makeApp(stub, extra = {}) {
  const cache = extra.cache || createCache(':memory:');
  const llmBudget = createLlmBudget({ isConfigured: () => false });
  const app = createApp({ extractPost: stub.fn, cache, llmBudget, ...extra });
  return { app, cache };
}

describe('MCP read_url - images: tool schema', () => {
  it('exposes an images enum and mentions it in the tool description', async () => {
    const app = createApp({ cache: createCache(':memory:') });
    const j = await rpc(app, 'tools/list', {});
    const readUrl = j.result.tools.find(t => t.name === 'read_url');
    const images = readUrl.inputSchema.properties.images;
    assert.ok(images, 'images param must be present');
    assert.deepEqual(images.enum, ['on', 'off']);
    assert.match(images.description, /Reddit only/);
    assert.match(readUrl.description, /Reddit image posts: pass images: "on"/);
  });

  it('rejects an invalid images value at the schema', async () => {
    const stub = recordingStub();
    const { app } = makeApp(stub);
    const j = await callTool(app, 'read_url', { url: REDDIT, images: 'maybe' });
    assert.ok(j.error || j.result?.isError, 'invalid enum value must be an error');
    assert.equal(stub.calls.length, 0);
  });
});

describe('MCP read_url - images: extract options', () => {
  const cases = [
    { env: {}, args: {}, want: 'off', name: 'default env, no param -> off' },
    { env: {}, args: { images: 'on' }, want: 'on', name: 'default env, images on -> on' },
    { env: { PULLMD_EMBEDDED_IMAGES: 'off' }, args: { images: 'on' }, want: 'off', name: 'instance off overrides images on' },
    { env: { PULLMD_EMBEDDED_IMAGES: 'always' }, args: {}, want: 'on', name: 'always -> on' },
    { env: { PULLMD_EMBEDDED_IMAGES: 'always' }, args: { images: 'off' }, want: 'off', name: 'always, images off -> off' },
  ];
  for (const c of cases) {
    it(c.name, async () => {
      await withEnv(c.env, async () => {
        const stub = recordingStub();
        const { app } = makeApp(stub);
        const j = await callTool(app, 'read_url', { url: REDDIT, comments: false, ...c.args });
        assert.ok(!j.result.isError);
        assert.equal(stub.calls.length, 1);
        assert.equal(stub.calls[0].images, c.want);
        assert.equal(typeof stub.calls[0].llmAllowed, 'function');
        assert.equal(typeof stub.calls[0].imageStore?.get, 'function');
      });
    });
  }

  it('passes a cache-backed image store (also with nocache)', async () => {
    await withEnv({}, async () => {
      const stub = recordingStub();
      const { app, cache } = makeApp(stub);
      cache.putImageTranscript('a', { description: 'A cat', transcript: null });
      await callTool(app, 'read_url', { url: REDDIT, comments: false, images: 'on', nocache: true });
      assert.equal(stub.calls.length, 1);
      assert.deepEqual(stub.calls[0].imageStore.get('a'), { description: 'A cat', transcript: null });
    });
  });

  it('images on for a web URL is ignored', async () => {
    await withEnv({}, async () => {
      const stub = recordingStub();
      const { app } = makeApp(stub, {
        extractWeb: async () => ({ markdown: '# Web', title: 'Web', source: 'readability', metadata: {} }),
      });
      const j = await callTool(app, 'read_url', { url: WEB, images: 'on' });
      assert.ok(!j.result.isError);
      assert.match(textOf(j), /# Web/);
      assert.equal(stub.calls.length, 0);
    });
  });
});

describe('MCP read_url - images: noStore', () => {
  it('serves the result without a share id and without a cache row', async () => {
    await withEnv({}, async () => {
      const stub = recordingStub({ noStore: true });
      const { app, cache } = makeApp(stub);
      const j = await callTool(app, 'read_url', { url: REDDIT, comments: false, images: 'on' });
      const text = textOf(j);
      assert.match(text, /# Test Post/);
      assert.doesNotMatch(text, /^share_id: \S/m);
      assert.doesNotMatch(text, /^share_url: \S/m);
      assert.equal(cache.get(REDDIT), null);
      assert.equal(cache.db.prepare('SELECT COUNT(*) AS n FROM conversions').get().n, 0);
    });
  });

  it('a normal result is still cached with a share id', async () => {
    await withEnv({}, async () => {
      const stub = recordingStub();
      const { app, cache } = makeApp(stub);
      const j = await callTool(app, 'read_url', { url: REDDIT, comments: false, images: 'on' });
      assert.match(textOf(j), /^share_id: [0-9a-f]{32}$/m);
      assert.ok(cache.get(REDDIT));
    });
  });
});

describe('MCP read_url - images: cache validity', () => {
  const VISION = { PULLMD_VISION_API_KEY: 'test-key' };
  function seeded(imagesTranscribed) {
    const stub = recordingStub();
    const { app, cache } = makeApp(stub);
    cache.put({ url: REDDIT, title: 'Cached', markdown: '# Cached\n\nOld body.', source: 'reddit', metadata: { imagesTranscribed } });
    return { stub, app };
  }

  it("row '0/1', vision configured, images on -> miss (re-extract)", async () => {
    await withEnv(VISION, async () => {
      const { stub, app } = seeded('0/1');
      const j = await callTool(app, 'read_url', { url: REDDIT, comments: false, images: 'on' });
      assert.ok(!j.result.isError);
      assert.equal(stub.calls.length, 1);
      assert.equal(stub.calls[0].images, 'on');
    });
  });

  it("row '1/1', images on -> hit", async () => {
    await withEnv(VISION, async () => {
      const { stub, app } = seeded('1/1');
      const j = await callTool(app, 'read_url', { url: REDDIT, comments: false, images: 'on' });
      assert.equal(stub.calls.length, 0);
      assert.match(textOf(j), /Old body/);
    });
  });

  it("row '0/1', images off -> hit", async () => {
    await withEnv(VISION, async () => {
      const { stub, app } = seeded('0/1');
      await callTool(app, 'read_url', { url: REDDIT, comments: false, images: 'off' });
      assert.equal(stub.calls.length, 0);
    });
  });

  it("row '0/1', no vision provider -> hit", async () => {
    await withEnv({}, async () => {
      const { stub, app } = seeded('0/1');
      await callTool(app, 'read_url', { url: REDDIT, comments: false, images: 'on' });
      assert.equal(stub.calls.length, 0);
    });
  });
});

describe('MCP get_share - refresh with embedded images', () => {
  function stale(cache, md = '# Old\n\nOld body.', metadata) {
    const shareId = cache.put({ url: REDDIT, title: 'Old', markdown: md, source: 'reddit', metadata });
    cache.db.prepare("UPDATE conversions SET created_at = datetime('now', '-2 hours') WHERE url = ?").run(REDDIT);
    return shareId;
  }

  it('noStore + budgetDeferred: keeps the old markdown and restarts the refresh clock', async () => {
    await withEnv({}, async () => {
      const stub = recordingStub({ noStore: true, budgetDeferred: true, markdown: '# New\n\nNew body.' });
      const { app, cache } = makeApp(stub);
      const shareId = stale(cache);

      const j = await callTool(app, 'get_share', { id: shareId });
      const text = textOf(j);
      assert.match(text, /Old body/);
      assert.doesNotMatch(text, /New body/);
      assert.match(text, /^refreshed: false$/m);
      assert.equal(stub.calls.length, 1);
      assert.equal(stub.calls[0].images, 'off');
      assert.equal(typeof stub.calls[0].llmAllowed, 'function');
      assert.equal(typeof stub.calls[0].imageStore?.get, 'function');

      const row = cache.db.prepare("SELECT markdown, created_at > datetime('now', '-5 minutes') AS fresh FROM conversions WHERE url = ?").get(REDDIT);
      assert.equal(row.markdown, '# Old\n\nOld body.');
      assert.equal(row.fresh, 1);
    });
  });

  it('noStore without budgetDeferred: old markdown, clock untouched', async () => {
    await withEnv({}, async () => {
      const stub = recordingStub({ noStore: true });
      const { app, cache } = makeApp(stub);
      const shareId = stale(cache);
      const j = await callTool(app, 'get_share', { id: shareId });
      assert.match(textOf(j), /Old body/);
      const row = cache.db.prepare("SELECT created_at > datetime('now', '-5 minutes') AS fresh FROM conversions WHERE url = ?").get(REDDIT);
      assert.equal(row.fresh, 0);
    });
  });

  it('always mode: refresh asks for images on', async () => {
    await withEnv({ PULLMD_EMBEDDED_IMAGES: 'always' }, async () => {
      const stub = recordingStub();
      const { app, cache } = makeApp(stub);
      const shareId = stale(cache);
      const j = await callTool(app, 'get_share', { id: shareId });
      assert.match(textOf(j), /New body|Body\./);
      assert.equal(stub.calls[0].images, 'on');
    });
  });
});
