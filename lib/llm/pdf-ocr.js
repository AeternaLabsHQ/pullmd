import { resolveProvider, mapUsage, abortController } from './providers.js';

const TIMEOUT_MS = 120_000;
const DEFAULT_MODEL = 'mistral-ocr-latest';
const MAX_PDF_BYTES = 50 * 1024 * 1024;

// Figures the OCR endpoint reports: skip tiny ones (icons, rules) and cap the count.
export const OCR_IMAGE_MIN_SIZE = 50;
export const OCR_IMAGE_LIMIT = 40;

// Per-figure annotation the OCR endpoint fills in (caption and hosted modes).
// Each figure is annotated on its own, without the page text, so the language
// is stated explicitly: "the language of the document" made the model guess,
// and diagrams with little text came back in arbitrary languages.
function figureSchema(lang) {
  const language = lang === 'en' ? 'English' : 'German';
  return {
    type: 'json_schema',
    json_schema: {
      name: 'figure',
      strict: true,
      schema: {
        type: 'object',
        title: 'Figure',
        properties: {
          image_type: { type: 'string', description: 'Kind of figure, e.g. line chart, schematic, photo, logo.' },
          description: { type: 'string', description: `What the figure shows: axes, key values, trends, structure. At most 3 sentences. Write it in ${language}.` },
        },
        required: ['image_type', 'description'],
        additionalProperties: false,
      },
    },
  };
}

// image_annotation arrives as a JSON string; anything unusable means "no caption".
function parseAnnotation(raw) {
  if (typeof raw !== 'string') return undefined;
  let obj;
  try { obj = JSON.parse(raw); } catch { return undefined; }
  if (!obj || typeof obj.description !== 'string') return undefined;
  const annotation = { description: obj.description };
  if (typeof obj.image_type === 'string') annotation.imageType = obj.image_type;
  return annotation;
}

function parseFigures(pages) {
  const figures = [];
  for (const page of pages) {
    if (!Array.isArray(page?.images)) continue;
    for (const img of page.images) {
      if (!img || typeof img.id !== 'string') continue;
      const span = (a, b) => (Number.isFinite(a) && Number.isFinite(b) ? b - a : null);
      const figure = { id: img.id, width: span(img.top_left_x, img.bottom_right_x), height: span(img.top_left_y, img.bottom_right_y) };
      if (typeof img.image_base64 === 'string' && img.image_base64) figure.dataUri = img.image_base64;
      const annotation = parseAnnotation(img.image_annotation);
      if (annotation) figure.annotation = annotation;
      figures.push(figure);
    }
  }
  return figures;
}

/**
 * High-quality PDF -> Markdown via a vendor-neutral OCR endpoint (Mistral OCR
 * shape). Pass either `buffer` (sent as a base64 data-URI) or `url` (passed
 * straight through as document_url, no download).
 * `images` selects what to ask for besides text: 'strip' (default, nothing),
 * 'caption' (a description per figure) or 'hosted' (description plus the image bytes).
 * @returns {Promise<{markdown:string, usage:object|null, pdfPages:number|null,
 *          images:Array<{id:string, width:number|null, height:number|null, dataUri?:string,
 *          annotation?:{imageType?:string, description:string}}>}|null>}
 *          null when no PDF-OCR provider is configured (caller falls back to markitdown).
 */
export async function ocrPdf(opts = {}) {
  const { buffer, url, mimetype = 'application/pdf', images = 'strip', lang, fetch: fetchFn = globalThis.fetch } = opts;
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
  const body = { model: mdl, document, image_min_size: OCR_IMAGE_MIN_SIZE, image_limit: OCR_IMAGE_LIMIT };
  if (images === 'caption' || images === 'hosted') body.bbox_annotation_format = figureSchema(lang);
  if (images === 'hosted') body.include_image_base64 = true;
  const { signal, cleanup } = abortController(opts, TIMEOUT_MS);
  try {
    const res = await fetchFn(`${base}/ocr`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
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
    return { markdown, usage: mapUsage(data?.usage ?? null, data?.model || mdl), pdfPages, images: parseFigures(pages) };
  } catch (err) {
    // Our own deadline fired (not the caller's signal): say so instead of
    // the bare "This operation was aborted" (#98).
    if (err?.name === 'AbortError' && !opts.signal?.aborted) {
      throw new Error(`pdf ocr timed out after ${TIMEOUT_MS / 1000} s`);
    }
    throw err;
  } finally { cleanup(); }
}
