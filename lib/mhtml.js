// MHTML (.mhtml / .mht, "Save page as > Webpage, single file") to Markdown.
// The archive is MIME, so postal-mime unpacks it; the HTML root part then
// goes through the same extraction as POST /api/html. The original page URL
// (Snapshot-Content-Location / Content-Location) becomes the result's URL, so
// site recipes apply as for a live fetch.
import PostalMime from 'postal-mime';
import { unprocessable } from './mail-render.js';

const MIN_CONTENT_CHARS = 200;

export function isMhtmlFile(contentType, filename) {
  if (/\.mht(ml)?$/i.test(filename || '')) return true;
  if (/\.[^./\\]+$/.test(filename || '')) return false;
  return /^(multipart\/related|application\/x-mimearchive)\b/i.test(contentType || '');
}

function httpUrl(value) {
  if (!value) return null;
  try {
    const u = new URL(String(value).trim());
    return (u.protocol === 'http:' || u.protocol === 'https:') ? u.href : null;
  } catch {
    return null;
  }
}

function headerValue(email, name) {
  return email.headers?.find((h) => h.key === name)?.value;
}

/**
 * @param {Buffer} buffer
 * @param {object} [options]  filename, extractor, extractHtml (tests)
 */
export async function extractMhtml(buffer, options = {}) {
  const { filename, extractor } = options;
  const archive = await PostalMime.parse(buffer);
  let html = archive.html;
  // Some savers mark the root part as an attachment.
  if (!html) {
    const part = (archive.attachments || []).find((a) => /^text\/html\b/i.test(a.mimeType || ''));
    if (part) html = Buffer.from(part.content).toString('utf8');
  }
  if (!html || !html.trim()) {
    throw unprocessable('No HTML page found in this MHTML file. / Keine HTML-Seite in dieser MHTML-Datei gefunden.', 'not_mhtml');
  }

  const url = httpUrl(headerValue(archive, 'snapshot-content-location'))
    || httpUrl(headerValue(archive, 'content-location'));

  const extractHtml = options.extractHtml || (await import('./web.js')).extractHtml;
  const result = await extractHtml(html, { url: url || undefined, filename, extractor });
  if ((result.metadata?.contentLength ?? 0) < MIN_CONTENT_CHARS) {
    throw unprocessable('Extraction found almost no content in this saved page. Submit the original URL instead. / Die Extraktion fand kaum Inhalt in dieser gespeicherten Seite. Bitte übermittle stattdessen die Original-URL.', 'too_little_content');
  }
  if (url && result.metadata && !result.metadata.sourceUrl) result.metadata.sourceUrl = url;
  return result;
}
