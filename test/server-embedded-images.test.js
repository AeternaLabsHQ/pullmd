import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server.js';
import { createCache } from '../lib/cache.js';
import { createLlmBudget } from '../lib/llm/budget.js';

// Server wiring for embedded image transcripts on Reddit: the `images`
// param, cache validity, transcript reuse across the 1-hour window and
// noStore results that must not be cached.

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

async function request(app, path) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const port = server.address().port;
      fetch(`http://localhost:${port}${path}`)
        .then(async (res) => {
          const body = await res.text();
          server.close();
          resolve({ status: res.status, headers: res.headers, body });
        })
        .catch((err) => { server.close(); reject(err); });
    });
  });
}

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

const api = (url, qs = '') => `/api?url=${encodeURIComponent(url)}&comments=false${qs}`;

describe('/api images param (Reddit)', () => {
  const cases = [
    { env: {}, qs: '', want: 'off', name: 'default env, no param -> off' },
    { env: {}, qs: '&images=on', want: 'on', name: 'default env, images=on -> on' },
    { env: { PULLMD_EMBEDDED_IMAGES: 'off' }, qs: '&images=on', want: 'off', name: 'instance off overrides images=on' },
    { env: { PULLMD_EMBEDDED_IMAGES: 'always' }, qs: '', want: 'on', name: 'always -> on' },
  ];
  for (const c of cases) {
    it(c.name, async () => {
      await withEnv(c.env, async () => {
        const stub = recordingStub();
        const { app } = makeApp(stub);
        const res = await request(app, api(REDDIT, c.qs));
        assert.equal(res.status, 200);
        assert.equal(stub.calls.length, 1);
        assert.equal(stub.calls[0].images, c.want);
        assert.equal(typeof stub.calls[0].llmAllowed, 'function');
        assert.equal(stub.calls[0].previousTranscripts, null);
      });
    });
  }

  it('images=maybe on a Reddit URL -> 400', async () => {
    await withEnv({}, async () => {
      const stub = recordingStub();
      const { app } = makeApp(stub);
      const res = await request(app, api(REDDIT, '&images=maybe'));
      assert.equal(res.status, 400);
      assert.deepEqual(JSON.parse(res.body), { error: 'invalid images parameter (expected on or off)' });
      assert.equal(stub.calls.length, 0);
    });
  });

  it('images=maybe on a web URL is ignored', async () => {
    await withEnv({}, async () => {
      const stub = recordingStub();
      const { app } = makeApp(stub, {
        extractWeb: async () => ({ markdown: '# Web', title: 'Web', source: 'readability', metadata: {} }),
      });
      const res = await request(app, api(WEB, '&images=maybe'));
      assert.notEqual(res.status, 400);
      assert.equal(res.status, 200);
    });
  });

  it('noStore result: served, not cached, no share id', async () => {
    await withEnv({}, async () => {
      const stub = recordingStub({ noStore: true });
      const { app, cache } = makeApp(stub);
      const res = await request(app, api(REDDIT, '&images=on'));
      assert.equal(res.status, 200);
      assert.match(res.body, /# Test Post/);
      assert.equal(res.headers.get('x-share-id'), null);
      assert.equal(cache.get(REDDIT), null);
      assert.equal(cache.getMetadataAnyAge(REDDIT), null);
    });
  });

  it('passes imageTranscripts of a row older than 1 hour as previousTranscripts', async () => {
    await withEnv({}, async () => {
      const stub = recordingStub();
      const { app, cache } = makeApp(stub);
      const imageTranscripts = { 'https://i.redd.it/a.png': { description: 'A cat', transcript: null } };
      cache.put({ url: REDDIT, title: 'Old', markdown: '# Old', source: 'reddit', metadata: { imageTranscripts } });
      cache.db.prepare("UPDATE conversions SET created_at = datetime('now', '-2 hours') WHERE url = ?").run(REDDIT);
      const res = await request(app, api(REDDIT, '&images=on'));
      assert.equal(res.status, 200);
      assert.equal(stub.calls.length, 1);
      assert.deepEqual(stub.calls[0].previousTranscripts, imageTranscripts);
    });
  });
});

describe('/api cache hit validity for images', () => {
  function seeded(imagesTranscribed) {
    const stub = recordingStub();
    const { app, cache } = makeApp(stub);
    cache.put({ url: REDDIT, title: 'Cached', markdown: '# Cached\n\nOld body.', source: 'reddit', metadata: { imagesTranscribed } });
    return { stub, app };
  }
  const VISION = { PULLMD_VISION_API_KEY: 'test-key' };

  it("row '0/1', vision configured, images=on -> miss (re-extract)", async () => {
    await withEnv(VISION, async () => {
      const { stub, app } = seeded('0/1');
      const res = await request(app, api(REDDIT, '&images=on'));
      assert.equal(res.status, 200);
      assert.equal(stub.calls.length, 1);
      assert.equal(stub.calls[0].images, 'on');
    });
  });

  it("row '1/1', images=on -> hit", async () => {
    await withEnv(VISION, async () => {
      const { stub, app } = seeded('1/1');
      const res = await request(app, api(REDDIT, '&images=on'));
      assert.equal(res.status, 200);
      assert.equal(stub.calls.length, 0);
      assert.match(res.body, /Old body/);
    });
  });

  it("row '0/1', images=off -> hit", async () => {
    await withEnv(VISION, async () => {
      const { stub, app } = seeded('0/1');
      const res = await request(app, api(REDDIT, '&images=off'));
      assert.equal(res.status, 200);
      assert.equal(stub.calls.length, 0);
    });
  });
});

describe('/api/stream images param', () => {
  it('images=on reaches extractPost', async () => {
    await withEnv({}, async () => {
      const stub = recordingStub();
      const { app } = makeApp(stub);
      const res = await request(app, `/api/stream?url=${encodeURIComponent(REDDIT)}&comments=false&images=on`);
      assert.equal(res.status, 200);
      assert.match(res.body, /event: result/);
      assert.equal(stub.calls.length, 1);
      assert.equal(stub.calls[0].images, 'on');
    });
  });

  it('images=maybe on a Reddit URL -> 400', async () => {
    await withEnv({}, async () => {
      const stub = recordingStub();
      const { app } = makeApp(stub);
      const res = await request(app, `/api/stream?url=${encodeURIComponent(REDDIT)}&images=maybe`);
      assert.equal(res.status, 400);
      assert.deepEqual(JSON.parse(res.body), { error: 'invalid images parameter (expected on or off)' });
      assert.equal(stub.calls.length, 0);
    });
  });

  it('noStore result: no share id, not cached', async () => {
    await withEnv({}, async () => {
      const stub = recordingStub({ noStore: true });
      const { app, cache } = makeApp(stub);
      const res = await request(app, `/api/stream?url=${encodeURIComponent(REDDIT)}&comments=false&images=on`);
      assert.match(res.body, /"shareId":null/);
      assert.equal(cache.get(REDDIT), null);
    });
  });

  it("cache row '0/1' with vision and images=on -> miss", async () => {
    await withEnv({ PULLMD_VISION_API_KEY: 'test-key' }, async () => {
      const stub = recordingStub();
      const { app, cache } = makeApp(stub);
      cache.put({ url: REDDIT, title: 'Cached', markdown: '# Cached', source: 'reddit', metadata: { imagesTranscribed: '0/1' } });
      await request(app, `/api/stream?url=${encodeURIComponent(REDDIT)}&comments=false&images=on`);
      assert.equal(stub.calls.length, 1);
    });
  });
});

describe('/s/:id refresh with embedded images', () => {
  it('noStore + budgetDeferred: serves the old markdown and restarts the refresh clock', async () => {
    await withEnv({}, async () => {
      const imageTranscripts = { 'https://i.redd.it/a.png': { description: 'A cat', transcript: null } };
      const stub = recordingStub({ noStore: true, budgetDeferred: true, markdown: '# New\n\nNew body.' });
      const { app, cache } = makeApp(stub);
      const shareId = cache.put({ url: REDDIT, title: 'Old', markdown: '# Old\n\nOld body.', source: 'reddit', metadata: { imageTranscripts } });
      cache.db.prepare("UPDATE conversions SET created_at = datetime('now', '-2 hours') WHERE url = ?").run(REDDIT);

      const res = await request(app, `/s/${shareId}`);
      assert.equal(res.status, 200);
      assert.equal(res.body, '# Old\n\nOld body.');
      assert.equal(stub.calls.length, 1);
      assert.equal(stub.calls[0].images, 'off');
      assert.equal(typeof stub.calls[0].llmAllowed, 'function');
      assert.deepEqual(stub.calls[0].previousTranscripts, imageTranscripts);

      const row = cache.db.prepare("SELECT markdown, created_at > datetime('now', '-5 minutes') AS fresh FROM conversions WHERE url = ?").get(REDDIT);
      assert.equal(row.markdown, '# Old\n\nOld body.');
      assert.equal(row.fresh, 1);
    });
  });

  it('noStore without budgetDeferred: old markdown, clock untouched', async () => {
    await withEnv({}, async () => {
      const stub = recordingStub({ noStore: true });
      const { app, cache } = makeApp(stub);
      const shareId = cache.put({ url: REDDIT, title: 'Old', markdown: '# Old', source: 'reddit' });
      cache.db.prepare("UPDATE conversions SET created_at = datetime('now', '-2 hours') WHERE url = ?").run(REDDIT);
      const res = await request(app, `/s/${shareId}`);
      assert.equal(res.body, '# Old');
      const row = cache.db.prepare("SELECT created_at > datetime('now', '-5 minutes') AS fresh FROM conversions WHERE url = ?").get(REDDIT);
      assert.equal(row.fresh, 0);
    });
  });

  it('always mode: refresh asks for images on', async () => {
    await withEnv({ PULLMD_EMBEDDED_IMAGES: 'always' }, async () => {
      const stub = recordingStub();
      const { app, cache } = makeApp(stub);
      const shareId = cache.put({ url: REDDIT, title: 'Old', markdown: '# Old', source: 'reddit' });
      cache.db.prepare("UPDATE conversions SET created_at = datetime('now', '-2 hours') WHERE url = ?").run(REDDIT);
      await request(app, `/s/${shareId}`);
      assert.equal(stub.calls[0].images, 'on');
    });
  });
});
