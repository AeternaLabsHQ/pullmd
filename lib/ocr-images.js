// Pure helpers for Mistral OCR figures: rewrite the `![id](id)` placeholders in
// the OCR markdown into text lines, description blocks or hosted image links,
// and decode the base64 payloads Mistral returns. No I/O.

export const IMAGE_EXT = {
  'image/jpeg': 'jpeg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

const LABELS = { de: 'Abbildung', en: 'Figure' };
const MAX_DESCRIPTION = 600;
const PLACEHOLDER_ID = /^img-\d+\.[a-z0-9]+$/i;
// Only the exact shape ![X](X) can be a placeholder: alt and target identical.
const IMAGE_LINK = /!\[([^\]\n]*)\]\(([^)\s]*)\)/g;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const DATA_URI = /^data:([^;,]+)(?:;[^;,]*)*;base64,(.*)$/is;

export function parseDataUri(dataUri) {
  if (typeof dataUri !== 'string') return null;
  let mime = 'image/jpeg';
  let payload = dataUri.trim();
  if (/^data:/i.test(payload)) {
    const m = DATA_URI.exec(payload);
    if (!m) return null;
    mime = m[1].trim().toLowerCase();
    payload = m[2];
  }
  if (!Object.hasOwn(IMAGE_EXT, mime)) return null;
  payload = payload.replace(/\s+/g, '');
  if (!BASE64.test(payload)) return null;
  const bytes = Buffer.from(payload, 'base64');
  if (bytes.length === 0) return null;
  return { mime, bytes };
}

// One line, no characters that could break out of alt text, a code span or the
// link target, and no raw HTML or autolinks (the text is model output over
// attacker-controlled PDF content).
function flattenDescription(text) {
  if (typeof text !== 'string') return '';
  return text
    .replace(/[[\]`<>\\]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_DESCRIPTION)
    .trim();
}

function dimensions(img) {
  const { width, height } = img;
  if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
    return `${width}×${height}`;
  }
  return null;
}

/**
 * Rewrite OCR image placeholders.
 * opts.mode: 'strip' | 'caption' | 'hosted' (anything else means strip).
 * Degrades per image: hosted needs a URL in opts.urlById, else caption; caption
 * needs an annotation description, else strip.
 */
export function rewriteOcrImages(markdown, images, opts = {}) {
  const { mode, lang, urlById } = opts;
  const label = LABELS[lang] || LABELS.de;
  const byId = new Map();
  for (const img of Array.isArray(images) ? images : []) {
    if (img && typeof img.id === 'string') byId.set(img.id, img);
  }

  return markdown.replace(IMAGE_LINK, (match, alt, target) => {
    if (alt !== target) return match;
    const img = byId.get(target);
    if (!img && !PLACEHOLDER_ID.test(target)) return match;

    const dims = img ? dimensions(img) : null;
    const description = img ? flattenDescription(img.annotation?.description) : '';
    const url = mode === 'hosted' ? urlById?.get(target) : null;

    if (url) {
      return `![${description || (dims ? `${target}, ${dims}` : target)}](${url})`;
    }
    if ((mode === 'hosted' || mode === 'caption') && description) {
      return `> **${label}** (${dims ? `${target}, ${dims}` : target}): ${description}`;
    }
    return `*[${label}: ${dims ? `${target}, ${dims} px` : target}]*`;
  });
}
