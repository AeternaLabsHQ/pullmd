import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server.js';
import { createCache } from '../lib/cache.js';

async function request(app, path, opts = {}) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const port = server.address().port;
      fetch(`http://localhost:${port}${path}`, opts)
        .then(async (res) => {
          const text = await res.text();
          server.close();
          resolve({ status: res.status, headers: Object.fromEntries(res.headers), body: text });
        })
        .catch((err) => { server.close(); reject(err); });
    });
  });
}

// A page well above the 800-token short-circuit threshold (originalTokens > 800
// means length > 3200 chars), with 3 headings (section mode) and a distinctive
// query term ("zebra") confined to one section so BM25 picks it cleanly.
function fillerParagraph(seed, sentences = 25) {
  const words = ['lorem', 'ipsum', 'dolor', 'sit', 'amet', 'consectetur', 'adipiscing', 'elit', 'sed', 'do'];
  const lines = [];
  for (let i = 0; i < sentences; i++) {
    lines.push(`${seed} ${words[i % words.length]} ${words[(i + 3) % words.length]} ${words[(i + 5) % words.length]} filler sentence number ${i} to pad this section out nicely.`);
  }
  return lines.join(' ');
}

function bigMarkdown() {
  return [
    '# Big Article',
    '',
    '## Introduction',
    '',
    fillerParagraph('intro'),
    '',
    '## Zebra Migration Patterns',
    '',
    'Zebra herds migrate across the savanna in search of water. Zebra behavior fascinates researchers studying zebra movement.',
    '',
    fillerParagraph('wildlife'),
    '',
    '## Conclusion',
    '',
    fillerParagraph('summary'),
  ].join('\n');
}

function smallMarkdown() {
  return '# Small Page\n\nJust a short paragraph, well under the extraction threshold.';
}

describe('GET /api - query-extract: byte-identical without query', () => {
  it('web path: response unchanged, no X-Extracted header', async () => {
    const app = createApp({
      extractWeb: async () => ({ markdown: bigMarkdown(), title: 'Big Article', source: 'readability' }),
      cache: createCache(':memory:'),
    });
    const res = await request(app, '/api?url=https://example.com/article');
    assert.equal(res.status, 200);
    assert.equal(res.headers['x-extracted'], undefined);
    assert.equal(res.headers['x-extract-confidence'], undefined);
    assert.ok(res.body.includes('## Zebra Migration Patterns'));
  });

  it('reddit path: response unchanged, no X-Extracted header', async () => {
    const app = createApp({
      extractPost: async () => bigMarkdown(),
      cache: createCache(':memory:'),
    });
    const res = await request(app, '/api?url=https://www.reddit.com/r/test/comments/abc/title/');
    assert.equal(res.status, 200);
    assert.equal(res.headers['x-extracted'], undefined);
  });

  it('hn path: response unchanged, no X-Extracted header', async () => {
    const app = createApp({
      extractHn: async () => bigMarkdown(),
      cache: createCache(':memory:'),
    });
    const res = await request(app, '/api?url=https://news.ycombinator.com/item?id=1');
    assert.equal(res.status, 200);
    assert.equal(res.headers['x-extracted'], undefined);
  });

  it('cache-hit path: response unchanged, no X-Extracted header', async () => {
    const cache = createCache(':memory:');
    const app = createApp({
      extractWeb: async () => ({ markdown: bigMarkdown(), title: 'Big Article', source: 'readability' }),
      cache,
    });
    const first = await request(app, '/api?url=https://example.com/article');
    assert.equal(first.status, 200);
    const second = await request(app, '/api?url=https://example.com/article');
    assert.equal(second.status, 200);
    assert.equal(second.headers['x-extracted'], undefined);
    assert.equal(second.body, first.body);
  });
});

describe('GET /api - query-extract: web path with query', () => {
  it('extracts body and sets headers', async () => {
    const app = createApp({
      extractWeb: async () => ({ markdown: bigMarkdown(), title: 'Big Article', source: 'readability' }),
      cache: createCache(':memory:'),
    });
    const res = await request(app, '/api?url=https://example.com/article&query=zebra');
    assert.equal(res.status, 200);
    assert.equal(res.headers['x-extracted'], 'true');
    assert.ok(['high', 'medium'].includes(res.headers['x-extract-confidence']));
    assert.ok(res.headers['x-extract-sections'] !== undefined);
    assert.ok(res.headers['x-extract-original-tokens'] !== undefined);
    assert.ok(res.headers['x-extract-returned-tokens'] !== undefined);
    assert.ok(res.body.includes('Zebra herds migrate'));
    assert.ok(!res.body.includes('## Introduction'));
  });

  it('format=json carries the extract object', async () => {
    const app = createApp({
      extractWeb: async () => ({ markdown: bigMarkdown(), title: 'Big Article', source: 'readability' }),
      cache: createCache(':memory:'),
    });
    const res = await request(app, '/api?url=https://example.com/article&query=zebra&format=json');
    assert.equal(res.status, 200);
    const json = JSON.parse(res.body);
    assert.ok(json.extract);
    assert.equal(json.extract.extracted, true);
    assert.ok(['high', 'medium'].includes(json.extract.confidence));
    assert.equal(typeof json.extract.sectionsSelected, 'number');
    assert.equal(typeof json.extract.originalTokens, 'number');
    assert.equal(typeof json.extract.returnedTokens, 'number');
  });

  it('frontmatter=true carries the extract fields', async () => {
    const app = createApp({
      extractWeb: async () => ({ markdown: bigMarkdown(), title: 'Big Article', source: 'readability' }),
      cache: createCache(':memory:'),
    });
    const res = await request(app, '/api?url=https://example.com/article&query=zebra&frontmatter=true');
    assert.equal(res.status, 200);
    assert.ok(res.body.startsWith('---\n'));
    assert.ok(res.body.includes('extracted: true'));
    assert.ok(/extract_confidence: (high|medium)/.test(res.body));
    assert.ok(/sections_selected: \d+/.test(res.body));
    assert.ok(/original_tokens: \d+/.test(res.body));
    assert.ok(/returned_tokens: \d+/.test(res.body));
  });

  it('format=text applies extraction before stripMarkdown', async () => {
    const app = createApp({
      extractWeb: async () => ({ markdown: bigMarkdown(), title: 'Big Article', source: 'readability' }),
      cache: createCache(':memory:'),
    });
    const res = await request(app, '/api?url=https://example.com/article&query=zebra&format=text');
    assert.equal(res.status, 200);
    assert.ok(res.headers['content-type'].includes('text/plain'));
    assert.ok(res.body.includes('Zebra herds migrate'));
    assert.ok(!res.body.includes('## Introduction'));
    assert.ok(!res.body.includes('#'));
  });

  it('no-match query returns full body, X-Extracted: false, confidence low', async () => {
    const app = createApp({
      extractWeb: async () => ({ markdown: bigMarkdown(), title: 'Big Article', source: 'readability' }),
      cache: createCache(':memory:'),
    });
    const res = await request(app, '/api?url=https://example.com/article&query=xyzzyquokkanomatch');
    assert.equal(res.status, 200);
    assert.equal(res.headers['x-extracted'], 'false');
    assert.equal(res.headers['x-extract-confidence'], 'low');
    assert.ok(res.body.includes('## Introduction'));
    assert.ok(res.body.includes('## Zebra Migration Patterns'));
    assert.ok(res.body.includes('## Conclusion'));
  });

  it('small page below threshold returns full body, X-Extracted: false, no confidence header', async () => {
    const app = createApp({
      extractWeb: async () => ({ markdown: smallMarkdown(), title: 'Small Page', source: 'readability' }),
      cache: createCache(':memory:'),
    });
    const res = await request(app, '/api?url=https://example.com/small&query=anything');
    assert.equal(res.status, 200);
    assert.equal(res.headers['x-extracted'], 'false');
    assert.equal(res.headers['x-extract-confidence'], undefined);
    assert.ok(res.body.includes('Just a short paragraph'));
  });
});

describe('GET /api - query-extract: cache interaction', () => {
  it('extractor called exactly once across a no-query then query request; second is served extracted from cache', async () => {
    let calls = 0;
    const cache = createCache(':memory:');
    const app = createApp({
      extractWeb: async () => {
        calls++;
        return { markdown: bigMarkdown(), title: 'Big Article', source: 'readability' };
      },
      cache,
    });
    const first = await request(app, '/api?url=https://example.com/article');
    assert.equal(first.status, 200);
    assert.equal(calls, 1);

    const second = await request(app, '/api?url=https://example.com/article&query=zebra');
    assert.equal(second.status, 200);
    assert.equal(calls, 1); // served from cache, extraction is local
    assert.equal(second.headers['x-extracted'], 'true');
    assert.ok(second.body.includes('Zebra herds migrate'));
  });

  it('cache purity: a query request does not poison the cached full markdown', async () => {
    const cache = createCache(':memory:');
    const app = createApp({
      extractWeb: async () => ({ markdown: bigMarkdown(), title: 'Big Article', source: 'readability' }),
      cache,
    });
    const withQuery = await request(app, '/api?url=https://example.com/article&query=zebra');
    assert.equal(withQuery.status, 200);
    assert.equal(withQuery.headers['x-extracted'], 'true');

    const withoutQuery = await request(app, '/api?url=https://example.com/article');
    assert.equal(withoutQuery.status, 200);
    assert.equal(withoutQuery.headers['x-extracted'], undefined);
    assert.ok(withoutQuery.body.includes('## Introduction'));
    assert.ok(withoutQuery.body.includes('## Zebra Migration Patterns'));
    assert.ok(withoutQuery.body.includes('## Conclusion'));
  });
});

describe('GET /api - query-extract: reddit and HN paths', () => {
  it('reddit path: query extracts', async () => {
    const app = createApp({
      extractPost: async () => bigMarkdown(),
      cache: createCache(':memory:'),
    });
    const res = await request(app, '/api?url=https://www.reddit.com/r/test/comments/abc/title/&query=zebra');
    assert.equal(res.status, 200);
    assert.equal(res.headers['x-extracted'], 'true');
    assert.ok(res.body.includes('Zebra herds migrate'));
    assert.ok(!res.body.includes('## Introduction'));
  });

  it('hn path: query extracts', async () => {
    const app = createApp({
      extractHn: async () => bigMarkdown(),
      cache: createCache(':memory:'),
    });
    const res = await request(app, '/api?url=https://news.ycombinator.com/item?id=1&query=zebra');
    assert.equal(res.status, 200);
    assert.equal(res.headers['x-extracted'], 'true');
    assert.ok(res.body.includes('Zebra herds migrate'));
    assert.ok(!res.body.includes('## Introduction'));
  });
});

describe('GET /api - query-extract: max_tokens validation', () => {
  it('max_tokens=abc -> 400', async () => {
    const app = createApp({
      extractWeb: async () => ({ markdown: bigMarkdown(), title: 'Big Article', source: 'readability' }),
      cache: createCache(':memory:'),
    });
    const res = await request(app, '/api?url=https://example.com/article&query=zebra&max_tokens=abc');
    assert.equal(res.status, 400);
    const json = JSON.parse(res.body);
    assert.ok(json.error);
  });

  it('max_tokens=10 -> 400 (below minimum)', async () => {
    const app = createApp({
      extractWeb: async () => ({ markdown: bigMarkdown(), title: 'Big Article', source: 'readability' }),
      cache: createCache(':memory:'),
    });
    const res = await request(app, '/api?url=https://example.com/article&query=zebra&max_tokens=10');
    assert.equal(res.status, 400);
    const json = JSON.parse(res.body);
    assert.ok(json.error);
  });

  it('max_tokens=64 -> ok', async () => {
    const app = createApp({
      extractWeb: async () => ({ markdown: bigMarkdown(), title: 'Big Article', source: 'readability' }),
      cache: createCache(':memory:'),
    });
    const res = await request(app, '/api?url=https://example.com/article&query=zebra&max_tokens=64');
    assert.equal(res.status, 200);
  });

  it('max_tokens=abc WITHOUT query is not validated (byte-identical invariant: query-extract is fully gated on query)', async () => {
    const app = createApp({
      extractWeb: async () => ({ markdown: bigMarkdown(), title: 'Big Article', source: 'readability' }),
      cache: createCache(':memory:'),
    });
    const res = await request(app, '/api?url=https://example.com/article&max_tokens=abc');
    assert.equal(res.status, 200);
    assert.equal(res.headers['x-extracted'], undefined);
  });
});
