import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server.js';
import { createCache } from '../lib/cache.js';

// Same harness shape as server-query-extract.test.js.
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

const ARTICLE = '# A Long Read\n\nBody text that is long enough to be a real page.';

describe('X-Suggested-Filename: GET /api', () => {
  it('is set on a fresh web conversion, from the title', async () => {
    const app = createApp({
      extractWeb: async () => ({ markdown: ARTICLE, title: 'A Long Read', source: 'readability', metadata: { title: 'A Long Read' } }),
      cache: createCache(':memory:'),
    });
    const res = await request(app, '/api?url=https://example.com/article');
    assert.equal(res.status, 200);
    assert.equal(res.headers['x-suggested-filename'], 'a-long-read.md');
  });

  it('survives the cache hit with the same value', async () => {
    const cache = createCache(':memory:');
    const app = createApp({
      extractWeb: async () => ({ markdown: ARTICLE, title: 'A Long Read', source: 'readability', metadata: { title: 'A Long Read' } }),
      cache,
    });
    const first = await request(app, '/api?url=https://example.com/article');
    const second = await request(app, '/api?url=https://example.com/article');
    assert.equal(second.status, 200);
    assert.equal(second.headers['x-source'], 'readability');
    assert.equal(second.headers['x-suggested-filename'], first.headers['x-suggested-filename']);
    assert.equal(second.headers['x-suggested-filename'], 'a-long-read.md');
  });

  it('uses the YT- scheme for YouTube conversions', async () => {
    const app = createApp({
      extractWeb: async () => ({ markdown: '# Never Gonna\n\nTranscript.', title: 'Never Gonna', source: 'youtube', metadata: { title: 'Never Gonna' } }),
      cache: createCache(':memory:'),
    });
    const res = await request(app, '/api?url=' + encodeURIComponent('https://www.youtube.com/watch?v=dQw4w9WgXcQ'));
    assert.equal(res.headers['x-suggested-filename'], 'YT-never-gonna-dQw4w9WgXcQ.md');
  });

  it('uses the original basename for file-based sources', async () => {
    const app = createApp({
      extractWeb: async () => ({ markdown: '# Foto\n\nA caption.', title: 'example.com', source: 'image-caption', metadata: { title: 'example.com' } }),
      cache: createCache(':memory:'),
    });
    const res = await request(app, '/api?url=' + encodeURIComponent('https://example.com/pics/Urlaubsfoto%202.jpg?w=100'));
    assert.equal(res.status, 200);
    assert.equal(res.headers['x-suggested-filename'], 'urlaubsfoto-2.md');
  });

  it('is set on the reddit path', async () => {
    const app = createApp({
      extractPost: async () => '# TIL something\n\nPost body.',
      cache: createCache(':memory:'),
    });
    const res = await request(app, '/api?url=https://www.reddit.com/r/todayilearned/comments/abc/til/');
    assert.equal(res.headers['x-suggested-filename'], 'til-something.md');
  });

  it('is set on the hackernews path', async () => {
    const app = createApp({
      extractHn: async () => '# Show HN: a thing\n\nDiscussion.',
      cache: createCache(':memory:'),
    });
    const res = await request(app, '/api?url=https://news.ycombinator.com/item?id=1');
    assert.equal(res.headers['x-suggested-filename'], 'show-hn-a-thing.md');
  });

  it('is set on format=text responses too', async () => {
    const app = createApp({
      extractWeb: async () => ({ markdown: ARTICLE, title: 'A Long Read', source: 'readability', metadata: { title: 'A Long Read' } }),
      cache: createCache(':memory:'),
    });
    const res = await request(app, '/api?url=https://example.com/article&format=text');
    assert.equal(res.headers['x-suggested-filename'], 'a-long-read.md');
  });

  it('respects an injected date prefix', async () => {
    const app = createApp({
      extractWeb: async () => ({ markdown: ARTICLE, title: 'A Long Read', source: 'readability', metadata: { title: 'A Long Read' } }),
      cache: createCache(':memory:'),
      filenameDatePrefix: 'YYYY-MM-DD-',
    });
    const res = await request(app, '/api?url=https://example.com/article');
    assert.match(res.headers['x-suggested-filename'], /^\d{4}-\d{2}-\d{2}-a-long-read\.md$/);
  });
});

describe('X-Suggested-Filename: POST /api/html', () => {
  it('is set from the extracted title', async () => {
    const app = createApp({
      extractHtml: async () => ({
        markdown: ARTICLE, title: 'A Long Read', source: 'readability',
        metadata: { title: 'A Long Read', contentLength: 900 },
      }),
    });
    const res = await request(app, '/api/html', {
      method: 'POST',
      headers: { 'Content-Type': 'text/html' },
      body: '<html><body><p>hi</p></body></html>',
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers['x-suggested-filename'], 'a-long-read.md');
  });

  it('falls back to the uploaded file name when there is no title', async () => {
    const app = createApp({
      extractHtml: async () => ({ markdown: ARTICLE, title: null, source: 'readability', metadata: { title: null, contentLength: 900 } }),
    });
    const res = await request(app, '/api/html', {
      method: 'POST',
      headers: { 'Content-Type': 'text/html', 'X-Filename': encodeURIComponent('Mein Artikel.html') },
      body: '<html><body><p>hi</p></body></html>',
    });
    assert.equal(res.headers['x-suggested-filename'], 'mein-artikel.md');
  });
});

describe('X-Suggested-Filename: GET /s/:id', () => {
  it('is set from the stored row', async () => {
    const cache = createCache(':memory:');
    const app = createApp({
      extractWeb: async () => ({ markdown: ARTICLE, title: 'A Long Read', source: 'readability', metadata: { title: 'A Long Read' } }),
      cache,
    });
    const conv = await request(app, '/api?url=https://example.com/article');
    const shareId = conv.headers['x-share-id'];
    assert.ok(shareId, '/api must hand out a share id');

    const res = await request(app, '/s/' + shareId);
    assert.equal(res.status, 200);
    assert.equal(res.headers['x-suggested-filename'], 'a-long-read.md');
  });

  it('falls back to the share id when the row has no usable title', async () => {
    const cache = createCache(':memory:');
    const shareId = cache.put({ url: 'https://example.com/', title: '', markdown: 'Body without an H1.', source: 'readability', client: 'api' });
    const app = createApp({ cache });
    const res = await request(app, '/s/' + shareId);
    assert.equal(res.headers['x-suggested-filename'], shareId + '.md');
  });
});
