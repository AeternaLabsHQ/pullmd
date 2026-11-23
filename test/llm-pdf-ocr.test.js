import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ocrPdf, OCR_IMAGE_MIN_SIZE, OCR_IMAGE_LIMIT } from '../lib/llm/pdf-ocr.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/mistral-ocr-images.json', import.meta.url), 'utf8'));

const save = () => ({ k: process.env.PULLMD_PDF_OCR_API_KEY, b: process.env.PULLMD_PDF_OCR_BASE_URL, m: process.env.PULLMD_PDF_OCR_MODEL, lk: process.env.PULLMD_LLM_API_KEY });
const restore = (s) => {
  for (const [env, v] of [['PULLMD_PDF_OCR_API_KEY', s.k], ['PULLMD_PDF_OCR_BASE_URL', s.b], ['PULLMD_PDF_OCR_MODEL', s.m], ['PULLMD_LLM_API_KEY', s.lk]]) {
    if (v === undefined) delete process.env[env]; else process.env[env] = v;
  }
};

describe('ocrPdf', () => {
  it('returns null when no provider is configured', async () => {
    const s = save(); delete process.env.PULLMD_PDF_OCR_API_KEY; delete process.env.PULLMD_LLM_API_KEY;
    assert.equal(await ocrPdf({ buffer: Buffer.from('%PDF'), fetch: async () => { throw new Error('no'); } }), null);
    restore(s);
  });

  it('returns null when only PULLMD_LLM_API_KEY is set (no shared fallback for PDF-OCR)', async () => {
    const s = save();
    delete process.env.PULLMD_PDF_OCR_API_KEY;
    process.env.PULLMD_LLM_API_KEY = 'shared-key';
    assert.equal(await ocrPdf({ buffer: Buffer.from('%PDF'), fetch: async () => { throw new Error('should not call fetch'); } }), null);
    restore(s);
  });

  it('POSTs a base64 data-URI document and returns concatenated page markdown + pdfPages + model', async () => {
    const s = save(); process.env.PULLMD_PDF_OCR_API_KEY = 'k'; process.env.PULLMD_PDF_OCR_BASE_URL = 'https://ocr/v1'; delete process.env.PULLMD_PDF_OCR_MODEL; delete process.env.PULLMD_LLM_API_KEY;
    let captured;
    const fetchFn = async (url, opts) => { captured = { url, opts }; return { ok: true, json: async () => ({ model: 'mistral-ocr-latest', pages: [{ markdown: '# Page 1\n\n| a | b |' }, { markdown: 'Page 2 text' }], usage_info: { pages_processed: 2 } }) }; };
    const r = await ocrPdf({ buffer: Buffer.from('%PDF-1.4'), mimetype: 'application/pdf', fetch: fetchFn });
    assert.equal(captured.url, 'https://ocr/v1/ocr');
    assert.equal(captured.opts.headers.Authorization, 'Bearer k');
    const sent = JSON.parse(captured.opts.body);
    assert.equal(sent.model, 'mistral-ocr-latest');
    assert.equal(sent.document.type, 'document_url');
    assert.ok(sent.document.document_url.startsWith('data:application/pdf;base64,'));
    assert.equal(r.markdown, '# Page 1\n\n| a | b |\n\nPage 2 text');
    assert.equal(r.pdfPages, 2);
    assert.deepEqual(r.usage, { model: 'mistral-ocr-latest' });
    restore(s);
  });

  it('sends a plain document_url when given a url (no download)', async () => {
    const s = save(); process.env.PULLMD_PDF_OCR_API_KEY = 'k'; delete process.env.PULLMD_LLM_API_KEY;
    let captured;
    await ocrPdf({ url: 'https://example.com/doc.pdf', fetch: async (u, o) => { captured = { url: u, opts: o }; return { ok: true, json: async () => ({ pages: [{ markdown: 'x' }] }) }; } });
    assert.ok(captured.url.endsWith('/ocr'));
    assert.equal(JSON.parse(captured.opts.body).document.document_url, 'https://example.com/doc.pdf');
    restore(s);
  });

  it('throws on a non-ok response (with body detail)', async () => {
    const s = save(); process.env.PULLMD_PDF_OCR_API_KEY = 'k'; delete process.env.PULLMD_LLM_API_KEY;
    await assert.rejects(
      () => ocrPdf({ buffer: Buffer.from('%PDF'), fetch: async () => ({ ok: false, status: 429, text: async () => 'rate limited' }) }),
      /pdf ocr failed \(429\): rate limited/
    );
    restore(s);
  });
});

describe('ocrPdf - provider timeout (#98)', () => {
  const hanging = async (url, opts) => new Promise((_, reject) => {
    opts.signal.addEventListener('abort', () => reject(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' })));
  });

  it('names the timeout when the provider never answers', async () => {
    const s = save(); process.env.PULLMD_PDF_OCR_API_KEY = 'k'; delete process.env.PULLMD_LLM_API_KEY;
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      const p = ocrPdf({ buffer: Buffer.from('%PDF'), fetch: hanging });
      mock.timers.tick(120000);
      await assert.rejects(p, /pdf ocr timed out after 120 s/);
    } finally { mock.timers.reset(); restore(s); }
  });

  it('keeps the abort error when the caller cancelled', async () => {
    const s = save(); process.env.PULLMD_PDF_OCR_API_KEY = 'k'; delete process.env.PULLMD_LLM_API_KEY;
    const ctrl = new AbortController();
    const p = ocrPdf({ buffer: Buffer.from('%PDF'), fetch: hanging, signal: ctrl.signal });
    ctrl.abort();
    await assert.rejects(p, (err) => err.name === 'AbortError');
    restore(s);
  });
});

describe('ocrPdf - figures', () => {
  // Runs ocrPdf against a mocked endpoint; returns the parsed request body and the result.
  const run = async (opts, response) => {
    const s = save(); process.env.PULLMD_PDF_OCR_API_KEY = 'k'; delete process.env.PULLMD_LLM_API_KEY;
    let sent;
    try {
      const r = await ocrPdf({
        buffer: Buffer.from('%PDF'),
        fetch: async (u, o) => { sent = JSON.parse(o.body); return { ok: true, json: async () => response }; },
        ...opts,
      });
      return { sent, r };
    } finally { restore(s); }
  };
  const withAnnotation = (image_annotation) => ({ pages: [{ markdown: 'x', images: [{ id: 'img-0.jpeg', top_left_x: 0, top_left_y: 0, bottom_right_x: 10, bottom_right_y: 20, image_annotation }] }] });

  it('exports the request constants', () => {
    assert.equal(OCR_IMAGE_MIN_SIZE, 50);
    assert.equal(OCR_IMAGE_LIMIT, 40);
  });

  it('always sends image_min_size and image_limit', async () => {
    for (const images of [undefined, 'strip', 'caption', 'hosted']) {
      const { sent } = await run({ images }, fixture);
      assert.equal(sent.image_min_size, 50);
      assert.equal(sent.image_limit, 40);
    }
  });

  it('strip (default) requests neither image data nor annotations', async () => {
    for (const images of [undefined, 'strip', 'bogus']) {
      const { sent } = await run({ images }, fixture);
      assert.equal('include_image_base64' in sent, false);
      assert.equal('bbox_annotation_format' in sent, false);
    }
  });

  it('caption requests a strict figure schema but no image bytes', async () => {
    const { sent } = await run({ images: 'caption' }, fixture);
    assert.equal('include_image_base64' in sent, false);
    const fmt = sent.bbox_annotation_format;
    assert.equal(fmt.type, 'json_schema');
    assert.equal(fmt.json_schema.name, 'figure');
    assert.equal(fmt.json_schema.strict, true);
    assert.deepEqual(fmt.json_schema.schema.required, ['image_type', 'description']);
    assert.equal(fmt.json_schema.schema.properties.image_type.type, 'string');
    assert.equal(fmt.json_schema.schema.properties.description.type, 'string');
  });

  it('hosted requests image bytes and the figure schema', async () => {
    const { sent } = await run({ images: 'hosted' }, fixture);
    assert.equal(sent.include_image_base64, true);
    assert.equal(sent.bbox_annotation_format.type, 'json_schema');
  });

  it('parses figures from the response', async () => {
    const { r } = await run({ images: 'hosted' }, fixture);
    assert.equal(r.images.length, 2);
    const [a, b] = r.images;
    const fa = fixture.pages[0].images[0];
    assert.equal(a.id, 'img-0.jpeg');
    assert.equal(a.width, fa.bottom_right_x - fa.top_left_x);
    assert.equal(a.height, fa.bottom_right_y - fa.top_left_y);
    assert.equal(a.dataUri, fa.image_base64);
    assert.match(a.dataUri, /^data:image\/jpeg;base64,/);
    assert.equal(a.annotation.imageType, 'multi-panel scientific figure');
    assert.equal(a.annotation.description, JSON.parse(fa.image_annotation).description);
    assert.equal(b.id, 'img-1.jpeg');
    assert.equal(b.annotation.imageType, 'line chart with schematic insets');
    // existing fields are untouched
    assert.equal(r.pdfPages, 2);
    assert.match(r.markdown, /!\[img-0\.jpeg\]\(img-0\.jpeg\)/);
  });

  it('leaves annotation undefined when image_annotation is not usable', async () => {
    for (const ann of [null, 'not json', '{"image_type":"chart"}', '{"description":42}', '[]', '"str"']) {
      const { r } = await run({ images: 'caption' }, withAnnotation(ann));
      assert.equal(r.images.length, 1);
      assert.equal(r.images[0].annotation, undefined, `annotation for ${ann}`);
    }
  });

  it('omits dataUri when the response has no image_base64', async () => {
    const { r } = await run({ images: 'caption' }, withAnnotation(null));
    assert.equal('dataUri' in r.images[0], false);
  });

  it('tolerates a missing image_type', async () => {
    const { r } = await run({ images: 'caption' }, withAnnotation('{"description":"A plot."}'));
    assert.equal(r.images[0].annotation.description, 'A plot.');
    assert.equal(r.images[0].annotation.imageType, undefined);
  });

  it('returns an empty list for pages without images', async () => {
    const { r } = await run({}, { pages: [{ markdown: 'a' }, { markdown: 'b', images: null }] });
    assert.deepEqual(r.images, []);
  });

  it('uses null width/height when coordinates are missing', async () => {
    const { r } = await run({}, { pages: [{ markdown: 'a', images: [{ id: 'img-0.jpeg' }] }] });
    assert.equal(r.images[0].width, null);
    assert.equal(r.images[0].height, null);
  });
});
