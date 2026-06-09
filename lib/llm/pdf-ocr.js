import { resolveProvider, mapUsage, abortController } from './providers.js';

const TIMEOUT_MS = 120_000;
const DEFAULT_MODEL = 'mistral-ocr-latest';
const MAX_PDF_BYTES = 50 * 1024 * 1024;

/**
 * High-quality PDF -> Markdown via a vendor-neutral OCR endpoint (Mistral OCR
 * shape). Pass either `buffer` (sent as a base64 data-URI) or `url` (passed
 * straight through as document_url, no download).
 * @returns {Promise<{markdown:string, usage:object|null, pdfPages:number|null}|null>}
 *          null when no PDF-OCR provider is configured (caller falls back to markitdown).
 */
export async function ocrPdf(opts = {}) {
  const { buffer, url, mimetype = 'application/pdf', fetch: fetchFn = globalThis.fetch } = opts;
  const { apiKey, baseUrl, model } = resolveProvider('PDF_OCR', { sharedFallback: false });
  if (!apiKey) return null;

  let document;
  if (buffer) {
    if (buffer.length > MAX_PDF_BYTES) throw new Error('pdf too large for OCR (max 50 MB)');
    document = { type: 'document_url', document_url: `data:${mimetype};base64,${buffer.toString('base64')}` };
  } else if (url) {
    document = { type: 'document_url', document_url: url };
  } else {
    return null;
  }

  const base = (baseUrl || 'https://api.mistral.ai/v1').replace(/\/$/, '');
  const mdl = model || DEFAULT_MODEL;
  const { signal, cleanup } = abortController(opts, TIMEOUT_MS);
  try {
    const res = await fetchFn(`${base}/ocr`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model: mdl, document }),
      signal,
    });
    if (!res.ok) {
      let detail = '';
      try { detail = (await res.text())?.slice(0, 200) || ''; } catch { detail = ''; }
      throw new Error(`pdf ocr failed (${res.status})${detail ? ': ' + detail : ''}`);
    }
    const data = await res.json();
    const pages = Array.isArray(data?.pages) ? data.pages : [];
    const markdown = pages.map((p) => p?.markdown || '').join('\n\n').trim();
    const pdfPages = data?.usage_info?.pages_processed ?? (pages.length || null);
    return { markdown, usage: mapUsage(data?.usage ?? null, data?.model || mdl), pdfPages };
  } finally { cleanup(); }
}
