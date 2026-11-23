import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server.js';
import { createCache } from '../lib/cache.js';
import { createAuth } from '../lib/auth.js';
import { createImageStore } from '../lib/image-store.js';

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

const IMG_BASE = 'https://md.example.org';

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

// Stored uploads (store=true): the conversion is kept as a row without a URL.
describe('POST /api/file?store=true', () => {
  const SHARE = /^[0-9a-f]{32}$/;
  const CAPTION_FORM = '# Report\n\nText.\n\n> Figure 1: a chart';

  async function withServer(app, fn) {
    const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
    try {
      return await fn(`http://localhost:${server.address().port}`);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  }

  const upload = (base, query, headers = {}, body = Buffer.from('%PDF-1.4')) =>
    fetch(`${base}/api/file?${query}`, { method: 'POST', headers: { 'Content-Type': 'application/pdf', ...headers }, body });

  function listFiles(root) {
    const out = [];
    for (const shard of fs.existsSync(root) ? fs.readdirSync(root) : []) out.push(...fs.readdirSync(path.join(root, shard)));
    return out;
  }

  // An extractFile stand-in that behaves like the OCR branch of lib/web.js.
  function fakeOcrExtract(calls) {
    return async (buf, opts) => {
      calls.push(opts);
      const dataUri = `data:image/jpeg;base64,${Buffer.from([1, 2, 3, 4]).toString('base64')}`;
      const hosted = opts.hostImages ? await opts.hostImages([{ id: 'img-0.jpeg', dataUri }]) : new Map();
      const imgUrl = hosted.get('img-0.jpeg');
      const markdown = imgUrl ? `# Report\n\nText.\n\n![Figure 1](${imgUrl})` : CAPTION_FORM;
      return {
        markdown, title: 'Report', source: 'pdf-ocr',
        metadata: { title: 'Report', sourceUrl: null, quality: 0.9, contentLength: markdown.length },
        ...(imgUrl ? { ocrFallbackMarkdown: CAPTION_FORM } : {}),
      };
    };
  }

  it('keeps the conversion: share id in the answer, /s/:id serves it, history lists it by file name', async () => {
    const cache = createCache(':memory:');
    const app = createApp({ cache, extractFile: async () => FAKE });
    await withServer(app, async (base) => {
      const res = await upload(base, 'store=true&format=json&filename=report.pdf');
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.match(body.shareId, SHARE);
      assert.equal(res.headers.get('x-share-id'), body.shareId);

      const shared = await fetch(`${base}/s/${body.shareId}`);
      assert.equal(shared.status, 200);
      assert.equal(await shared.text(), FAKE.markdown);

      const history = await (await fetch(`${base}/api/history`)).json();
      assert.equal(history.length, 1);
      assert.equal(history[0].title, 'report.pdf');
      assert.equal(history[0].url, null);
      assert.equal(history[0].share_id, body.shareId);
      assert.equal(cache.db.prepare('SELECT url FROM extraction_log').get().url, 'local-file');
    });
  });

  it('store=1 works too, and the share id lands in the frontmatter', async () => {
    const app = createApp({ cache: createCache(':memory:'), extractFile: async () => FAKE });
    await withServer(app, async (base) => {
      const body = await (await upload(base, 'store=1&format=json&frontmatter=true')).json();
      assert.match(body.shareId, SHARE);
      assert.ok(body.markdown.includes(`share_id: "${body.shareId}"`) || body.markdown.includes(`share_id: ${body.shareId}`), body.markdown);
    });
  });

  it('without store nothing is kept and shareId stays null', async () => {
    const cache = createCache(':memory:');
    const app = createApp({ cache, extractFile: async () => FAKE });
    await withServer(app, async (base) => {
      const res = await upload(base, 'format=json&filename=report.pdf');
      assert.equal((await res.json()).shareId, null);
      assert.equal(res.headers.get('x-share-id'), null);
      assert.deepEqual(await (await fetch(`${base}/api/history`)).json(), []);
    });
  });

  it('the uploadStore override false ignores store=true', async () => {
    const cache = createCache(':memory:');
    const app = createApp({ cache, uploadStore: false, extractFile: async () => FAKE });
    await withServer(app, async (base) => {
      const body = await (await upload(base, 'store=true&format=json')).json();
      assert.equal(body.shareId, null);
      assert.deepEqual(await (await fetch(`${base}/api/history`)).json(), []);
    });
  });

  it('without a cache store=true is ignored too', async () => {
    const app = createApp({ extractFile: async () => FAKE });
    await withServer(app, async (base) => {
      assert.equal((await (await upload(base, 'store=true&format=json')).json()).shareId, null);
    });
  });

  it('uploading the same file twice yields two different share ids', async () => {
    const app = createApp({ cache: createCache(':memory:'), extractFile: async () => FAKE });
    await withServer(app, async (base) => {
      const a = await (await upload(base, 'store=true&format=json&filename=report.pdf')).json();
      const b = await (await upload(base, 'store=true&format=json&filename=report.pdf')).json();
      assert.notEqual(a.shareId, b.shareId);
      assert.equal((await fetch(`${base}/s/${a.shareId}`)).status, 200);
      assert.equal((await fetch(`${base}/s/${b.shareId}`)).status, 200);
      assert.equal((await (await fetch(`${base}/api/history`)).json()).length, 2);
    });
  });

  it('a stored row without a file name falls back to the extracted title', async () => {
    const cache = createCache(':memory:');
    const app = createApp({ cache, extractFile: async () => FAKE });
    await withServer(app, async (base) => {
      await upload(base, 'store=true');
      assert.equal((await (await fetch(`${base}/api/history`)).json())[0].title, 'Report');
    });
  });

  describe('hosted figures', () => {
    let root;
    let store;
    let cache;
    beforeEach(() => {
      root = fs.mkdtempSync(path.join(os.tmpdir(), 'pullmd-upload-'));
      store = createImageStore(root);
      cache = createCache(':memory:', { onAssetsRemoved: (assets) => store.remove(assets) });
      mock.method(console, 'warn', () => {});
    });
    afterEach(() => {
      mock.restoreAll();
      fs.rmSync(root, { recursive: true, force: true });
    });

    const query = (extra = '') => `store=true&pdf=ocr&pdf_images=hosted&format=json&filename=report.pdf${extra}`;

    it('links hosted figures that resolve, and deleting the row removes them', async () => {
      const calls = [];
      const app = createApp({ cache, imageStore: store, imagePublicUrl: IMG_BASE, extractFile: fakeOcrExtract(calls) });
      await withServer(app, async (base) => {
        const body = await (await upload(base, query())).json();
        const m = /\/img\/([0-9a-f]{32})\.jpeg/.exec(body.markdown);
        assert.ok(m, body.markdown);
        assert.ok(body.markdown.includes(`${IMG_BASE}/img/`), body.markdown);
        assert.equal(calls[0].pdfImages, 'hosted');
        assert.equal(typeof calls[0].hostImages, 'function');
        assert.equal((await fetch(`${base}/img/${m[1]}.jpeg`)).status, 200);
        assert.equal(cache.getByShareId(body.shareId).markdown, body.markdown);
        assert.equal(listFiles(root).length, 1);

        const rowId = (await (await fetch(`${base}/api/history`)).json())[0].id;
        const del = await fetch(`${base}/api/cache/${rowId}`, { method: 'DELETE' });
        assert.equal(del.status, 200);
        assert.equal((await fetch(`${base}/img/${m[1]}.jpeg`)).status, 404);
        assert.deepEqual(listFiles(root), []);
      });
    });

    it('without store the mode degrades to caption and no hosting callback is passed', async () => {
      const calls = [];
      const app = createApp({ cache, imageStore: store, imagePublicUrl: IMG_BASE, extractFile: fakeOcrExtract(calls) });
      await withServer(app, async (base) => {
        const body = await (await upload(base, 'pdf=ocr&pdf_images=hosted&format=json')).json();
        assert.equal(calls[0].pdfImages, 'caption');
        assert.equal('hostImages' in calls[0], false);
        assert.equal(body.markdown, CAPTION_FORM);
        assert.deepEqual(listFiles(root), []);
      });
    });

    it('without PUBLIC_URL the mode degrades to caption and no file is written', async () => {
      const calls = [];
      const app = createApp({ cache, imageStore: store, imagePublicUrl: '', extractFile: fakeOcrExtract(calls) });
      await withServer(app, async (base) => {
        const body = await (await upload(base, query())).json();
        assert.equal(calls[0].pdfImages, 'caption');
        assert.equal('hostImages' in calls[0], false);
        assert.equal(body.markdown, CAPTION_FORM);
        assert.deepEqual(listFiles(root), []);
      });
    });

    it('with store but without an image store the mode degrades to caption', async () => {
      const calls = [];
      const app = createApp({ cache, extractFile: fakeOcrExtract(calls) });
      await withServer(app, async (base) => {
        await upload(base, query());
        assert.equal(calls[0].pdfImages, 'caption');
        assert.equal('hostImages' in calls[0], false);
      });
    });

    it('passes caption and strip through unchanged', async () => {
      const calls = [];
      const app = createApp({ cache, imageStore: store, imagePublicUrl: IMG_BASE, extractFile: fakeOcrExtract(calls) });
      await withServer(app, async (base) => {
        await upload(base, 'pdf=ocr&pdf_images=caption');
        await upload(base, 'pdf=ocr');
        assert.deepEqual(calls.map((c) => c.pdfImages), ['caption', 'strip']);
      });
    });

    it('when the row cannot be stored the files go away and the caption form is served', async () => {
      mock.method(cache, 'put', () => { throw new Error('disk full'); });
      const app = createApp({ cache, imageStore: store, imagePublicUrl: IMG_BASE, extractFile: fakeOcrExtract([]) });
      await withServer(app, async (base) => {
        const res = await upload(base, query());
        assert.equal(res.status, 200);
        const body = await res.json();
        assert.equal(body.shareId, null);
        assert.equal(body.markdown, CAPTION_FORM);
        assert.deepEqual(listFiles(root), []);
      });
    });

    it('a failing extraction removes what it already hosted', async () => {
      mock.method(console, 'error', () => {});
      const app = createApp({
        cache, imageStore: store, imagePublicUrl: IMG_BASE,
        extractFile: async (buf, opts) => {
          await opts.hostImages([{ id: 'img-0.jpeg', dataUri: `data:image/jpeg;base64,${Buffer.from([1, 2]).toString('base64')}` }]);
          throw new Error('ocr broke');
        },
      });
      await withServer(app, async (base) => {
        const res = await upload(base, query());
        assert.equal(res.status, 502);
        assert.deepEqual(listFiles(root), []);
        assert.deepEqual(await (await fetch(`${base}/api/history`)).json(), []);
      });
    });
  });

  describe('multi-user history', () => {
    it('a stored upload shows up only in the uploader\'s history', async () => {
      const cache = createCache(':memory:');
      const auth = createAuth({
        db: cache.db, mode: 'multi-user',
        env: { PULLMD_ADMIN_EMAIL: 'a@b.c', PULLMD_ADMIN_PASSWORD: 'pw1234567' },
        argon2Opts: { timeCost: 1, memoryCost: 1024, parallelism: 1 },
      });
      await auth.runMigration();
      const admin = cache.db.prepare('SELECT id FROM users WHERE is_admin = 1').get();
      const demo = await auth.createUser({ email: 'demo@x.y', password: 'pw1234567', isAdmin: false });
      const asAdmin = { Cookie: `pullmd_session=${auth.createSession(admin.id).token}` };
      const asDemo = { Cookie: `pullmd_session=${auth.createSession(demo.id).token}` };
      const app = createApp({ cache, auth, extractFile: async () => FAKE });
      await withServer(app, async (base) => {
        const body = await (await upload(base, 'store=true&format=json&filename=mine.pdf', asDemo)).json();
        assert.match(body.shareId, SHARE);
        const own = await (await fetch(`${base}/api/history`, { headers: asDemo })).json();
        assert.deepEqual(own.map((r) => r.title), ['mine.pdf']);
        assert.deepEqual(await (await fetch(`${base}/api/history`, { headers: asAdmin })).json(), []);
        assert.equal((await (await fetch(`${base}/api/archive`, { headers: asAdmin })).json()).total, 0);
        assert.equal((await (await fetch(`${base}/api/archive`, { headers: asDemo })).json()).total, 1);
      });
    });
  });
});
