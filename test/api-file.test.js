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

function postFile(app, path, body, headers = {}) {
  return request(app, path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/pdf', ...headers },
    body,
  });
}

const FAKE = {
  markdown: '# Report\n\nConverted body.',
  title: 'Report', source: 'markitdown',
  metadata: { title: 'Report', sourceUrl: null, quality: 0.8, contentLength: 400 },
};

describe('POST /api/file - happy paths', () => {
  it('returns markdown with X-Source header, no share id', async () => {
    const app = createApp({ extractFile: async () => FAKE });
    const res = await postFile(app, '/api/file', Buffer.from('%PDF-1.4'));
    assert.equal(res.status, 200);
    assert.ok(res.headers['content-type'].includes('text/markdown'));
    assert.equal(res.headers['x-source'], 'markitdown');
    assert.equal(res.headers['x-share-id'], undefined);
    assert.ok(res.body.includes('# Report'));
  });

  it('forwards filename (X-Filename header) and content-type to extractFile', async () => {
    let received;
    const app = createApp({ extractFile: async (buf, opts) => { received = { len: buf.length, ...opts }; return FAKE; } });
    await postFile(app, '/api/file', Buffer.from('%PDF'), { 'X-Filename': encodeURIComponent('über.pdf') });
    assert.equal(received.filename, 'über.pdf');
    assert.equal(received.contentType, 'application/pdf');
    assert.ok(received.len > 0);
  });

  it('returns the JSON envelope when format=json', async () => {
    const app = createApp({ extractFile: async () => FAKE });
    const res = await postFile(app, '/api/file?format=json', Buffer.from('%PDF'));
    const json = JSON.parse(res.body);
    assert.equal(json.source, 'markitdown');
    assert.equal(json.shareId, null);
  });

  it('sets X-Quality from the result metadata', async () => {
    const app = createApp({ extractFile: async () => FAKE });
    const res = await postFile(app, '/api/file', Buffer.from('%PDF'));
    assert.equal(res.headers['x-quality'], '0.8');
  });

  it('strips markdown when format=text', async () => {
    const app = createApp({ extractFile: async () => FAKE });
    const res = await postFile(app, '/api/file?format=text', Buffer.from('%PDF'));
    assert.equal(res.status, 200);
    assert.ok(res.headers['content-type'].includes('text/plain'));
    assert.ok(!res.body.includes('# '));
  });

  it('prepends frontmatter when frontmatter=true', async () => {
    const app = createApp({ extractFile: async () => FAKE });
    const res = await postFile(app, '/api/file?frontmatter=true', Buffer.from('%PDF'));
    assert.ok(res.body.startsWith('---\n'));
    assert.ok(res.body.includes('source: markitdown'));
  });

  it('emits llm usage + image_size in frontmatter for markitdown source', async () => {
    const app = createApp({ extractFile: async () => ({ markdown: '# I\n\ncaption', title: 'I', source: 'markitdown', metadata: { quality: 0.8, llmModel: 'gpt-4o-mini', llmTokens: 99, llmPromptTokens: 80, llmCompletionTokens: 19, imageSize: '100x50' } }) });
    const res = await postFile(app, '/api/file?frontmatter=true', Buffer.from('%PDF'));
    assert.ok(res.body.includes('llm_model: gpt-4o-mini'));
    assert.ok(res.body.includes('llm_tokens: 99'));
    assert.ok(res.body.includes('llm_prompt_tokens: 80'));
    assert.ok(res.body.includes('llm_completion_tokens: 19'));
    assert.ok(res.body.includes('image_size: 100x50'));
  });

  it('sets X-Source: image-caption and emits llm_model + image_size in frontmatter for image-caption source', async () => {
    const FAKE_IMAGE = {
      markdown: '# pic.png\n\n## Description\n\nA cat.',
      title: 'pic.png',
      source: 'image-caption',
      metadata: { quality: 0.5, imageSize: '1x1', llmModel: 'gpt-4o-mini', llmTokens: 50 },
    };
    const app = createApp({ extractFile: async () => FAKE_IMAGE });
    const resPlain = await postFile(app, '/api/file', Buffer.from('\x89PNG'));
    assert.equal(resPlain.headers['x-source'], 'image-caption');

    const resFm = await postFile(app, '/api/file?frontmatter=true', Buffer.from('\x89PNG'));
    assert.ok(resFm.body.includes('image_size:'), 'expected image_size in frontmatter');
    assert.ok(resFm.body.includes('llm_model:'), 'expected llm_model in frontmatter');
  });

  it('sets X-Source: pdf-ocr and emits pdf_pages + llm_model in frontmatter when ?pdf=ocr', async () => {
    const FAKE_PDF_OCR = {
      markdown: '# doc.pdf\n\n| a | b |',
      title: 'doc.pdf',
      source: 'pdf-ocr',
      metadata: { quality: 0.6, pdfPages: 3, llmModel: 'mistral-ocr-latest' },
    };
    const app = createApp({ extractFile: async () => FAKE_PDF_OCR });
    const resPlain = await postFile(app, '/api/file?pdf=ocr', Buffer.from('%PDF-1.4'));
    assert.equal(resPlain.headers['x-source'], 'pdf-ocr');

    const resFm = await postFile(app, '/api/file?pdf=ocr&frontmatter=true', Buffer.from('%PDF-1.4'));
    assert.ok(resFm.body.includes('pdf_pages:'), 'expected pdf_pages in frontmatter');
    assert.ok(resFm.body.includes('llm_model:'), 'expected llm_model in frontmatter');
  });

  it('sets X-Source: audio-transcript and emits audio_seconds + llm_model in frontmatter for audio source', async () => {
    const FAKE_AUDIO = {
      markdown: '# clip.mp3\n\n### Audio Transcript\n\nHello.',
      title: 'clip.mp3',
      source: 'audio-transcript',
      metadata: { quality: 0.5, audioSeconds: 4.2, llmModel: 'whisper-1' },
    };
    const app = createApp({ extractFile: async () => FAKE_AUDIO });
    const resPlain = await postFile(app, '/api/file', Buffer.from('ID3'), { 'Content-Type': 'audio/mpeg' });
    assert.equal(resPlain.headers['x-source'], 'audio-transcript');

    const resFm = await postFile(app, '/api/file?frontmatter=true', Buffer.from('ID3'), { 'Content-Type': 'audio/mpeg' });
    assert.ok(resFm.body.includes('audio_seconds:'), 'expected audio_seconds in frontmatter');
    assert.ok(resFm.body.includes('llm_model:'), 'expected llm_model in frontmatter');
  });
});

describe('POST /api/file - errors', () => {
  it('400 when the body is empty', async () => {
    const app = createApp({ extractFile: async () => FAKE });
    const res = await postFile(app, '/api/file', Buffer.alloc(0));
    assert.equal(res.status, 400);
  });

  it('502 when conversion throws', async () => {
    const app = createApp({ extractFile: async () => { throw new Error('sidecar down'); } });
    const res = await postFile(app, '/api/file', Buffer.from('%PDF'));
    assert.equal(res.status, 502);
    assert.ok(JSON.parse(res.body).error.includes('sidecar down'));
  });
});

describe('POST /api/file - privacy', () => {
  it('never writes a cache entry; telemetry uses the placeholder', async () => {
    const cache = createCache(':memory:');
    const app = createApp({ cache, extractFile: async () => FAKE });
    const res = await postFile(app, '/api/file?filename=secret.pdf', Buffer.from('%PDF'), { 'X-Filename': encodeURIComponent('secret-tax.pdf') });
    assert.equal(res.status, 200);
    const history = await request(app, '/api/history');
    assert.deepEqual(JSON.parse(history.body), []);
    const logged = cache.db.prepare('SELECT url FROM extraction_log').all();
    assert.equal(logged[0].url, 'local-file');
    assert.ok(!JSON.stringify(logged).includes('secret-tax'));
  });
});

describe('POST /api/file - size limit', () => {
  it('413 with a 25 MB message for bodies over the limit', async () => {
    const app = createApp({ extractFile: async () => FAKE });
    const big = Buffer.alloc(26 * 1024 * 1024, 0x41);
    const res = await postFile(app, '/api/file', big);
    assert.equal(res.status, 413);
    assert.ok(JSON.parse(res.body).error.includes('25 MB'));
  });
});
