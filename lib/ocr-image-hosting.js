// Glue between the OCR figure rewriter (lib/web.js hostImages callback) and the
// file store (lib/image-store.js): decodes the base64 figures, enforces the
// size caps, writes the files and reports the URLs and the asset rows the
// caller has to store with the conversion. Image handling never fails a
// conversion: anything that cannot be hosted is skipped and degrades to a
// caption in the rewriter.

import { randomBytes } from 'node:crypto';
import { parseDataUri, IMAGE_EXT } from './ocr-images.js';

export const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 20 * 1024 * 1024;

/**
 * Value of the pdf_images request parameter -> mode. Unknown values mean
 * 'strip'; 'hosted' needs the instance to have hosting enabled and degrades to
 * 'caption' without it.
 * @returns {'strip'|'caption'|'hosted'}
 */
export function parsePdfImages(value, hostingEnabled) {
  if (value === 'caption') return 'caption';
  if (value === 'hosted') return hostingEnabled ? 'hosted' : 'caption';
  return 'strip';
}

/**
 * One hosting run per conversion. `assets` is filled by hostImages and handed
 * to cache.put; if the conversion is not stored after all, rollback() removes
 * the files again.
 * @param {{ store: { write: Function, remove: Function }, publicUrl: string }} deps
 * @returns {{ hostImages: (images: object[]) => Promise<Map<string,string>>,
 *   assets: Array<{ id: string, mime: string, size: number }>, rollback: () => void }}
 */
export function beginHosting({ store, publicUrl }) {
  const base = String(publicUrl).replace(/\/+$/, '');
  const assets = [];
  let total = 0;

  async function hostImages(images) {
    const urlById = new Map();
    for (const image of images || []) {
      if (!image || typeof image.id !== 'string') continue;
      const parsed = parseDataUri(image.dataUri);
      if (!parsed) continue;
      const size = parsed.bytes.length;
      if (size > MAX_IMAGE_BYTES || total + size > MAX_TOTAL_BYTES) continue;
      const id = randomBytes(16).toString('hex');
      try {
        store.write(id, parsed.mime, parsed.bytes);
      } catch (err) {
        console.warn('hosting an OCR image failed, skipping it:', String(err?.message ?? err));
        continue;
      }
      total += size;
      assets.push({ id, mime: parsed.mime, size });
      urlById.set(image.id, `${base}/img/${id}.${IMAGE_EXT[parsed.mime]}`);
    }
    return urlById;
  }

  function rollback() {
    store.remove(assets);
    assets.length = 0;
    total = 0;
  }

  return { hostImages, assets, rollback };
}

const errMessage = (err) => String(err?.message ?? err);

/**
 * pdf_images of a URL conversion: the mode for the extractor plus, for
 * 'hosted', a hosting run whose files the caller keeps or rolls back.
 * `enabled` says whether the instance can host at all (store and cache).
 */
export function planPdfImages(raw, { enabled, store, publicUrl }) {
  const pdfImages = parsePdfImages(raw, enabled);
  const hosting = pdfImages === 'hosted' ? beginHosting({ store, publicUrl }) : null;
  return { pdfImages, hosting };
}

/**
 * Runs the extractor for a web conversion. Whatever it hosted is removed
 * again when it throws: nothing refers to those files yet.
 */
export async function extractWithHosting(hosting, run) {
  try {
    return await run();
  } catch (err) {
    hosting?.rollback();
    throw err;
  }
}

/**
 * Stores a web conversion and returns { shareId, markdown }, the markdown
 * being what the response must carry. When hosted figures could not be
 * stored with the row (noStore result, or put threw), their files are
 * removed and the response falls back to the caption form: it never links
 * an /img/ file without an asset row. Without hosting a put error propagates.
 * @param {{ cache: object|null, result: object, hosting: object|null,
 *   url: string, client: string, userId: number|null }} args
 */
export function storeWebResult({ cache, result, hosting, url, client, userId }) {
  const hosted = !!hosting && hosting.assets.length > 0;
  const row = { url, title: result.title, source: result.source, client, user_id: userId, metadata: result.metadata };
  if (!cache || result.noStore) {
    if (hosted) hosting.rollback();
    return { shareId: null, markdown: hosted ? (result.ocrFallbackMarkdown ?? result.markdown) : result.markdown };
  }
  try {
    const { shareId } = cache.put({ ...row, markdown: result.markdown, assets: hosted ? hosting.assets : [] });
    return { shareId, markdown: result.markdown };
  } catch (err) {
    if (!hosted) throw err;
    console.warn('storing hosted OCR images failed, serving captions instead:', errMessage(err));
    hosting.rollback();
  }
  const markdown = result.ocrFallbackMarkdown ?? result.markdown;
  try {
    return { shareId: cache.put({ ...row, markdown }).shareId, markdown };
  } catch (err) {
    console.warn('cache.put failed for the caption fallback:', errMessage(err));
    return { shareId: null, markdown };
  }
}
