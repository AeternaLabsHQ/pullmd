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

function parseSse(text) {
  const m = text.match(/^data: (.+)$/m);
  return m ? JSON.parse(m[1]) : null;
}

// Each `request()` call spins up a fresh listener on a random port, so
// share_url ports differ call-to-call even when nothing else changed.
// Normalize that one line away before comparing two responses byte-for-byte.
function normalizePort(text) {
  return text.replace(/^share_url: http:\/\/localhost:\d+\//m, 'share_url: http://localhost:PORT/');
}

const MCP_HEADERS = { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream' };

async function callTool(app, name, args, id = 1) {
  const res = await request(app, '/mcp', {
    method: 'POST',
    headers: MCP_HEADERS,
    body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }),
  });
  return parseSse(res.body);
}

async function listTools(app) {
  const res = await request(app, '/mcp', {
    method: 'POST',
    headers: MCP_HEADERS,
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });
  return parseSse(res.body);
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

describe('MCP read_url - query-extract: tool schema', () => {
  it('exposes query and max_tokens params on read_url', async () => {
    const app = createApp({ cache: createCache(':memory:') });
    const j = await listTools(app);
    const readUrl = j.result.tools.find(t => t.name === 'read_url');
    assert.ok(readUrl, 'read_url tool must be registered');
    const props = readUrl.inputSchema.properties;
    assert.ok(props.query, 'query param must be present');
    assert.ok(props.max_tokens, 'max_tokens param must be present');
  });
});

describe('MCP read_url - query-extract: byte-identical without query', () => {
  it('web path: output unchanged, no marker', async () => {
    const app = createApp({
      extractWeb: async () => ({ markdown: bigMarkdown(), title: 'Big Article', source: 'readability', metadata: { quality: 0.8 } }),
      cache: createCache(':memory:'),
    });
    const j = await callTool(app, 'read_url', { url: 'https://example.com/article' });
    const text = j.result.content[0].text;
    assert.ok(text.includes('## Introduction'));
    assert.ok(text.includes('## Zebra Migration Patterns'));
    assert.ok(text.includes('## Conclusion'));
    assert.ok(!text.includes('query-extract'));
  });

  it('cache-hit path: output unchanged, no marker', async () => {
    const cache = createCache(':memory:');
    const app = createApp({
      extractWeb: async () => ({ markdown: bigMarkdown(), title: 'Big Article', source: 'readability', metadata: { quality: 0.8 } }),
      cache,
    });
    // Prime the cache, then compare two subsequent cache-hit calls (both
    // cached:true) so the diff isolates query-extract's effect rather than
    // the unrelated fresh-vs-cached-hit fields (share_url port, cached flag).
    await callTool(app, 'read_url', { url: 'https://example.com/article' }, 1);
    const second = await callTool(app, 'read_url', { url: 'https://example.com/article' }, 2);
    const third = await callTool(app, 'read_url', { url: 'https://example.com/article' }, 3);
    assert.equal(normalizePort(third.result.content[0].text), normalizePort(second.result.content[0].text));
    assert.ok(third.result.content[0].text.includes('## Introduction'));
    assert.ok(third.result.content[0].text.includes('## Zebra Migration Patterns'));
    assert.ok(third.result.content[0].text.includes('## Conclusion'));
    assert.ok(!third.result.content[0].text.includes('query-extract'));
  });
});

describe('MCP read_url - query-extract: whitespace-only query is inactive', () => {
  it('query: " " is byte-identical to no query at all (no marker, no extract fields)', async () => {
    const app = createApp({
      extractWeb: async () => ({ markdown: bigMarkdown(), title: 'Big Article', source: 'readability', metadata: { quality: 0.8 } }),
      cache: createCache(':memory:'),
    });
    // Prime the cache, then compare two subsequent cache-hit calls (both
    // cached:true) so the diff isolates the whitespace-query gate rather than
    // the unrelated fresh-vs-cached-hit `cached` field.
    await callTool(app, 'read_url', { url: 'https://example.com/article' }, 1);
    const noQuery = await callTool(app, 'read_url', { url: 'https://example.com/article' }, 2);
    const whitespaceQuery = await callTool(app, 'read_url', { url: 'https://example.com/article', query: ' ' }, 3);
    assert.equal(normalizePort(whitespaceQuery.result.content[0].text), normalizePort(noQuery.result.content[0].text));
    assert.ok(!whitespaceQuery.result.content[0].text.includes('query-extract'));
  });
});

describe('MCP read_url - query-extract: fresh web path with query', () => {
  it('extracts the relevant section only', async () => {
    const app = createApp({
      extractWeb: async () => ({ markdown: bigMarkdown(), title: 'Big Article', source: 'readability', metadata: { quality: 0.8 } }),
      cache: createCache(':memory:'),
    });
    const j = await callTool(app, 'read_url', { url: 'https://example.com/article', query: 'zebra' });
    const text = j.result.content[0].text;
    assert.ok(text.includes('Zebra herds migrate'));
    assert.ok(!text.includes('## Introduction'));
  });

  it('frontmatter=true carries the five extract fields', async () => {
    const app = createApp({
      extractWeb: async () => ({ markdown: bigMarkdown(), title: 'Big Article', source: 'readability', metadata: { quality: 0.8 } }),
      cache: createCache(':memory:'),
    });
    const j = await callTool(app, 'read_url', { url: 'https://example.com/article', query: 'zebra', frontmatter: true });
    const text = j.result.content[0].text;
    assert.ok(text.startsWith('---\n'));
    const fmEnd = text.indexOf('\n---\n', 4);
    const fm = text.slice(4, fmEnd);
    assert.match(fm, /^extracted: true$/m);
    assert.match(fm, /^extract_confidence: (high|medium)$/m);
    assert.match(fm, /^sections_selected: \d+$/m);
    assert.match(fm, /^original_tokens: \d+$/m);
    assert.match(fm, /^returned_tokens: \d+$/m);
  });

  it('respects max_tokens', async () => {
    const app = createApp({
      extractWeb: async () => ({ markdown: bigMarkdown(), title: 'Big Article', source: 'readability', metadata: { quality: 0.8 } }),
      cache: createCache(':memory:'),
    });
    const j = await callTool(app, 'read_url', { url: 'https://example.com/article', query: 'zebra', max_tokens: 64, frontmatter: true });
    const text = j.result.content[0].text;
    const returnedMatch = text.match(/^returned_tokens: (\d+)$/m);
    assert.ok(returnedMatch);
    assert.ok(Number(returnedMatch[1]) <= 200, 'a tight max_tokens budget should keep the returned excerpt small');
  });
});

describe('MCP read_url - query-extract: no-match marker', () => {
  it('prepends the no-match marker when there is no match (confidence low)', async () => {
    const app = createApp({
      extractWeb: async () => ({ markdown: bigMarkdown(), title: 'Big Article', source: 'readability', metadata: { quality: 0.8 } }),
      cache: createCache(':memory:'),
    });
    const j = await callTool(app, 'read_url', { url: 'https://example.com/article', query: 'xyzzyquokkanomatch' });
    const text = j.result.content[0].text;
    assert.ok(text.includes('<!-- query-extract: no match; returning full page -->'));
    assert.ok(text.includes('## Introduction'));
    assert.ok(text.includes('## Zebra Migration Patterns'));
    assert.ok(text.includes('## Conclusion'));
  });

  it('does NOT prepend the marker for the small-page short-circuit (confidence null)', async () => {
    const app = createApp({
      extractWeb: async () => ({ markdown: smallMarkdown(), title: 'Small Page', source: 'readability', metadata: { quality: 0.8 } }),
      cache: createCache(':memory:'),
    });
    const j = await callTool(app, 'read_url', { url: 'https://example.com/small', query: 'anything' });
    const text = j.result.content[0].text;
    assert.ok(!text.includes('query-extract'));
    assert.ok(text.includes('Just a short paragraph'));
  });
});

describe('MCP read_url - query-extract: cache-hit path with query', () => {
  it('extracts the cached full markdown without re-fetching', async () => {
    let calls = 0;
    const cache = createCache(':memory:');
    const app = createApp({
      extractWeb: async () => {
        calls++;
        return { markdown: bigMarkdown(), title: 'Big Article', source: 'readability', metadata: { quality: 0.8 } };
      },
      cache,
    });
    await callTool(app, 'read_url', { url: 'https://example.com/article' }, 1);
    assert.equal(calls, 1);

    const second = await callTool(app, 'read_url', { url: 'https://example.com/article', query: 'zebra' }, 2);
    assert.equal(calls, 1, 'served from cache, extraction is local');
    const text = second.result.content[0].text;
    assert.ok(text.includes('Zebra herds migrate'));
    assert.ok(!text.includes('## Introduction'));
  });
});

describe('MCP read_url - query-extract: cache purity', () => {
  it('a query request does not poison the cached full markdown', async () => {
    const cache = createCache(':memory:');
    const app = createApp({
      extractWeb: async () => ({ markdown: bigMarkdown(), title: 'Big Article', source: 'readability', metadata: { quality: 0.8 } }),
      cache,
    });
    const withQuery = await callTool(app, 'read_url', { url: 'https://example.com/article', query: 'zebra' }, 1);
    assert.ok(withQuery.result.content[0].text.includes('Zebra herds migrate'));
    assert.ok(!withQuery.result.content[0].text.includes('## Introduction'));

    const withoutQuery = await callTool(app, 'read_url', { url: 'https://example.com/article' }, 2);
    const text = withoutQuery.result.content[0].text;
    assert.ok(text.includes('## Introduction'));
    assert.ok(text.includes('## Zebra Migration Patterns'));
    assert.ok(text.includes('## Conclusion'));
  });

  it('cache row put on a fresh fetch stores the full, unextracted markdown even when query is present', async () => {
    const cache = createCache(':memory:');
    const app = createApp({
      extractWeb: async () => ({ markdown: bigMarkdown(), title: 'Big Article', source: 'readability', metadata: { quality: 0.8 } }),
      cache,
    });
    await callTool(app, 'read_url', { url: 'https://example.com/article', query: 'zebra' }, 1);
    const cached = cache.get('https://example.com/article');
    assert.ok(cached);
    assert.ok(cached.markdown.includes('## Introduction'), 'cache must hold the full page, not the extracted excerpt');
    assert.ok(!cached.markdown.includes('query-extract'), 'cache must never contain the no-match marker');
  });
});

describe('MCP read_url - query-extract: reddit path with query', () => {
  it('extracts the relevant section only', async () => {
    const app = createApp({
      extractPost: async () => bigMarkdown(),
      cache: createCache(':memory:'),
    });
    const j = await callTool(app, 'read_url', { url: 'https://www.reddit.com/r/test/comments/abc/title/', query: 'zebra' });
    const text = j.result.content[0].text;
    assert.ok(text.includes('Zebra herds migrate'));
    assert.ok(!text.includes('## Introduction'));
  });
});

describe('MCP read_url - query-extract: get_share and list_recent untouched', () => {
  it('get_share ignores query-like args and returns the full frontmatter unchanged', async () => {
    const cache = createCache(':memory:');
    const shareId = cache.put({ url: 'https://example.com/z', title: 'Z', markdown: '# Z\n\nBody', source: 'readability', client: 'api' });
    const app = createApp({ cache });
    const j = await callTool(app, 'get_share', { id: shareId });
    const text = j.result.content[0].text;
    assert.ok(text.startsWith('---\n'));
    assert.match(text, /^share_id: /m);
    assert.ok(!text.includes('extracted:'));
  });

  it('list_recent output shape unchanged', async () => {
    const cache = createCache(':memory:');
    cache.put({ url: 'https://example.com/a', title: 'A', markdown: '# A', source: 'readability', client: 'api' });
    const app = createApp({ cache });
    const j = await callTool(app, 'list_recent', {});
    const items = JSON.parse(j.result.content[0].text);
    assert.equal(items.length, 1);
    assert.deepEqual(Object.keys(items[0]).sort(), ['created_at', 'share_id', 'share_url', 'source', 'title', 'url'].sort());
  });
});
