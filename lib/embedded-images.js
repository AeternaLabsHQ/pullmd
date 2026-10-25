/**
 * Embedded image transcripts - config, prompt, caption parsing and rendering.
 *
 * Generic on purpose: Reddit post images are the first user, other extractors
 * can follow. This module holds only pure helpers (no network, no cache); the
 * download and caption loop lives next to them in a later step.
 *
 * Env switches:
 *   PULLMD_EMBEDDED_IMAGES      off | on-request (default) | always
 *   PULLMD_EMBEDDED_IMAGES_MAX  images transcribed per post, 1-20, default 4
 */
import { resolveProvider } from './llm/providers.js';

/** Hosts embedded images may be fetched from (checked on every redirect hop). */
export const EMBEDDED_IMAGE_HOSTS = new Set(['i.redd.it', 'preview.redd.it']);

const MODES = ['off', 'on-request', 'always'];
const DEFAULT_MODE = 'on-request';
const DEFAULT_MAX = 4;
const MAX_LIMIT = 20;

/** Instance-level switch. Invalid or unset values fall back to `on-request`. */
export function readEmbeddedImagesMode(env = process.env) {
  const raw = String(env.PULLMD_EMBEDDED_IMAGES ?? '').trim().toLowerCase();
  return MODES.includes(raw) ? raw : DEFAULT_MODE;
}

/**
 * Startup warning for a set-but-invalid PULLMD_EMBEDDED_IMAGES.
 * @returns {string|null} the warning to print, or null when there is nothing to say
 */
export function embeddedImagesModeWarning(env = process.env) {
  const raw = String(env.PULLMD_EMBEDDED_IMAGES ?? '').trim();
  if (!raw || MODES.includes(raw.toLowerCase())) return null;
  return `PULLMD_EMBEDDED_IMAGES="${raw}" is not valid (use off, on-request or always); `
    + `falling back to ${DEFAULT_MODE}.`;
}

/** Maximum images transcribed per post. Integers 1-20, anything else is the default. */
export function readEmbeddedImagesMax(env = process.env) {
  const raw = String(env.PULLMD_EMBEDDED_IMAGES_MAX ?? '').trim();
  if (!/^\d+$/.test(raw)) return DEFAULT_MAX;
  const n = Number(raw);
  return n >= 1 && n <= MAX_LIMIT ? n : DEFAULT_MAX;
}

/**
 * Parse the `images` request parameter.
 * @returns {'on'|'off'|undefined|null} undefined when absent or empty, null when invalid
 */
export function parseImagesParam(value) {
  if (value === undefined || value === null) return undefined;
  const v = String(value).trim().toLowerCase();
  if (v === '') return undefined;
  if (v === 'on' || v === 'true' || v === '1') return 'on';
  if (v === 'off' || v === 'false' || v === '0') return 'off';
  return null;
}

/**
 * Effective mode for one request: instance `off` wins over any request;
 * otherwise the param if given, else `always` -> on, `on-request` -> off.
 */
export function resolveEmbeddedImages(param, env = process.env) {
  const mode = readEmbeddedImagesMode(env);
  if (mode === 'off') return 'off';
  if (param === 'on' || param === 'off') return param;
  return mode === 'always' ? 'on' : 'off';
}

/** True when a vision provider key is available (VISION or the shared LLM fallback). */
export function visionConfigured() {
  return !!resolveProvider('VISION').apiKey;
}

const PROMPT = 'First, in one or two sentences, describe what this image shows and what it is '
  + '(for example "Screenshot of a chat with an AI assistant answering the question ..."), '
  + 'written in {LANG}. Then output a line containing only `---`. Then transcribe all legible '
  + 'text in the image verbatim, in its original language, preserving line breaks, speaker '
  + 'labels and list structure. If there is no text, output only the description and no `---` '
  + 'line. Do not add commentary or interpretation.';

/** Vision prompt; the description language follows `lang` ('de' or 'en'). */
export function buildImagePrompt(lang) {
  return PROMPT.replace('{LANG}', lang === 'de' ? 'German' : 'English');
}

/**
 * Split a model reply at the first line that is exactly `---`. Before it is the
 * description, after it the transcript (later `---` lines belong to the
 * transcript). No separator: everything is the description.
 * @returns {{description: string, transcript: string|null}|null} null for an empty reply
 */
export function parseCaption(text) {
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
  const sep = lines.findIndex((l) => l.trim() === '---');
  const description = (sep === -1 ? lines : lines.slice(0, sep)).join('\n').trim();
  const transcript = sep === -1 ? '' : lines.slice(sep + 1).join('\n').trim();
  if (!description && !transcript) return null;
  return { description, transcript: transcript || null };
}

const LABELS = {
  de: { description: 'Bildbeschreibung', transcript: 'Bildtranskript', missing: 'Bild nicht transkribiert' },
  en: { description: 'Image description', transcript: 'Image transcript', missing: 'Image not transcribed' },
};

const labelsFor = (lang) => (lang === 'de' ? LABELS.de : LABELS.en);

/** Prefix every line with `>` so no line can start a heading (keeps `\n## Kommentare` detection exact). */
function quote(text) {
  return text.replace(/\r\n?/g, '\n').split('\n').map((l) => (l.trim() ? `> ${l}` : '>')).join('\n');
}

/**
 * Markdown block for one image: description, then transcript, as a blockquote.
 * The labels mark the text as machine-derived from the image.
 */
export function renderImageBlock({ description, transcript }, lang) {
  const L = labelsFor(lang);
  const out = [];
  if (description) out.push(quote(`**[${L.description}]** ${description}`));
  if (transcript) out.push(quote(`**[${L.transcript}]**\n${transcript}`));
  return out.join('\n>\n');
}

/** One-line marker for an eligible image without a transcript. */
export function renderImageMarker(lang) {
  return `> **[${labelsFor(lang).missing}]**`;
}

/**
 * True when a cached row has fewer resolved images than this instance would
 * produce now, so a provider-backed request should re-extract instead of
 * serving it. `imagesResolved` counts transcribed plus permanently failed
 * images (a deleted image is never retried); it defaults to the transcribed count.
 */
export function cachedImagesIncomplete(metadata, env = process.env) {
  if (!visionConfigured()) return false;
  const m = /^(\d+)\/(\d+)$/.exec(String(metadata?.imagesTranscribed ?? ''));
  if (!m) return false;
  const done = Number(m[1]);
  const total = Number(m[2]);
  const resolved = Number.isFinite(metadata.imagesResolved) ? metadata.imagesResolved : done;
  return resolved < Math.min(total, readEmbeddedImagesMax(env));
}
