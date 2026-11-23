import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { extractFile } from '../lib/web.js';
import { extractWeb } from './helpers/fake-dns.js';

const PDF = Buffer.from('%PDF-1.4 fake');
const pdfFetch = async () => ({
  ok: true, status: 200,
  headers: { get: (h) => (h.toLowerCase() === 'content-type' ? 'application/pdf' : null) },
  arrayBuffer: async () => PDF.buffer.slice(PDF.byteOffset, PDF.byteOffset + PDF.byteLength),
});

const OCR_RESULT = {
  markdown: 'a\n\n![img-0.jpeg](img-0.jpeg)\n\nb',
  images: [{ id: 'img-0.jpeg', width: 10, height: 20, annotation: { description: 'A chart' } }],
  usage: null,
  pdfPages: 1,
};

const HOSTED = new Map([['img-0.jpeg', 'https://h/img/aa.jpeg']]);

// Both entry points, driven the same way.
const runners = {
  extractWeb: (opts) => extractWeb('https://example.com/doc.pdf', { fetch: pdfFetch, pdfOcr: true, ...opts }),
  extractFile: (opts) => extractFile(PDF, {
    filename: 'doc.pdf', contentType: 'application/pdf', pdfOcr: true,
    markitdownClient: async () => { throw new Error('should not call markitdown'); },
    ...opts,
  }),
};

for (const [name, run] of Object.entries(runners)) {
  describe(`${name} - OCR figures`, () => {
    function recorder() {
      const calls = [];
      return { calls, ocrFn: async (o) => { calls.push(o); return { ...OCR_RESULT }; } };
    }

    it('default strips placeholders to a text line and asks OCR for strip', async () => {
      const { calls, ocrFn } = recorder();
      const r = await run({ ocrFn });
      assert.equal(r.source, 'pdf-ocr');
      assert.ok(r.markdown.includes('*[Abbildung: img-0.jpeg, 10×20 px]*'));
      assert.ok(!r.markdown.includes('](img-0.jpeg)'));
      assert.equal(calls[0].images, 'strip');
      assert.equal(r.ocrFallbackMarkdown, undefined);
    });

    it('caption mode writes the description block and passes caption to OCR', async () => {
      const { calls, ocrFn } = recorder();
      const r = await run({ ocrFn, pdfImages: 'caption' });
      assert.ok(r.markdown.includes('> **Abbildung** (img-0.jpeg, 10×20): A chart'));
      assert.ok(!r.markdown.includes('](img-0.jpeg)'));
      assert.equal(calls[0].images, 'caption');
    });

    it('English lang selects the English label and asks OCR for English descriptions', async () => {
      const { calls, ocrFn } = recorder();
      const r = await run({ ocrFn, pdfImages: 'caption', lang: 'en' });
      assert.ok(r.markdown.includes('> **Figure** (img-0.jpeg, 10×20): A chart'));
      assert.equal(calls[0].lang, 'en');
    });

    it('hosted mode links the hosted URL and carries a caption fallback document', async () => {
      const { calls, ocrFn } = recorder();
      let hosted = null;
      const r = await run({
        ocrFn, pdfImages: 'hosted',
        hostImages: async (images) => { hosted = images; return HOSTED; },
      });
      assert.ok(r.markdown.includes('![A chart](https://h/img/aa.jpeg)'));
      assert.equal(calls[0].images, 'hosted');
      assert.equal(hosted.length, 1);
      assert.equal(hosted[0].id, 'img-0.jpeg');
      // Fallback is the complete document (same header), in caption form.
      assert.ok(r.ocrFallbackMarkdown.includes('> **Abbildung** (img-0.jpeg, 10×20): A chart'));
      assert.ok(!r.ocrFallbackMarkdown.includes('https://h/img/aa.jpeg'));
      assert.equal(
        r.ocrFallbackMarkdown.split('\n\na\n\n')[0],
        r.markdown.split('\n\na\n\n')[0],
      );
    });

    it('hosted mode without hostImages degrades to caption', async () => {
      const { ocrFn } = recorder();
      const r = await run({ ocrFn, pdfImages: 'hosted' });
      assert.ok(r.markdown.includes('> **Abbildung** (img-0.jpeg, 10×20): A chart'));
      assert.equal(r.ocrFallbackMarkdown, undefined);
    });

    it('hostImages throwing degrades to caption and the conversion succeeds', async () => {
      const { ocrFn } = recorder();
      const r = await run({
        ocrFn, pdfImages: 'hosted',
        hostImages: async () => { throw new Error('store full'); },
      });
      assert.equal(r.source, 'pdf-ocr');
      assert.ok(r.markdown.includes('> **Abbildung** (img-0.jpeg, 10×20): A chart'));
      assert.equal(r.ocrFallbackMarkdown, undefined);
    });

    it('hostImages returning a non-Map counts as empty', async () => {
      const { ocrFn } = recorder();
      const r = await run({ ocrFn, pdfImages: 'hosted', hostImages: async () => ({ 'img-0.jpeg': 'https://h/x' }) });
      assert.ok(r.markdown.includes('> **Abbildung**'));
      assert.ok(!r.markdown.includes('https://h/x'));
    });

    it('does not call hostImages unless the mode is hosted', async () => {
      const { ocrFn } = recorder();
      const r = await run({
        ocrFn, pdfImages: 'caption',
        hostImages: async () => { throw new Error('must not be called'); },
      });
      assert.ok(r.markdown.includes('> **Abbildung**'));
    });

    it('treats an unknown mode as strip and an OCR result without images as empty', async () => {
      const calls = [];
      const r = await run({
        pdfImages: 'bogus',
        ocrFn: async (o) => { calls.push(o); return { markdown: 'a\n\n![img-0.jpeg](img-0.jpeg)\n\nb', usage: null, pdfPages: 1 }; },
      });
      assert.equal(calls[0].images, 'strip');
      assert.ok(r.markdown.includes('*[Abbildung: img-0.jpeg]*'));
      assert.ok(!r.markdown.includes('](img-0.jpeg)'));
    });
  });
}
