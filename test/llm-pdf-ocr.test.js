import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ocrPdf } from '../lib/llm/pdf-ocr.js';

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
