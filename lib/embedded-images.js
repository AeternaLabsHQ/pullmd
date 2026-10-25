/**
 * Embedded image transcripts - config, prompt, caption parsing and rendering.
 *
 * Generic on purpose: Reddit post images are the first user, other extractors
 * can follow. Config, prompt, parsing and rendering are pure helpers;
 * transcribeImages is the download and caption loop (no cache access - the
 * caller passes earlier results in and stores the returned ones).
 *
 * Env switches:
 *   PULLMD_EMBEDDED_IMAGES      off | on-request (default) | always
 *   PULLMD_EMBEDDED_IMAGES_MAX  images transcribed per post, 1-20, default 4
 */
import { resolveProvider } from './llm/providers.js';
import { captionImage } from './llm/vision.js';
import { safeFetch, SsrfError } from './ssrf.js';
import { readBodyCapped, ResponseTooLargeError } from './fetch-body.js';

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

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 15_000;
const CAPTION_MAX_TOKENS = 2000;

class HostNotAllowedError extends Error {
  constructor(host) {
    super(`host not allowed for embedded images: ${host}`);
    this.name = 'HostNotAllowedError';
  }
}

/** Permanent miss: retrying cannot help (gone, wrong type, too large, blocked). */
class PermanentMiss extends Error {}

/** fetchFn that refuses any URL (first request or redirect hop) off the host allowlist. */
function hostGuarded(fetchFn) {
  return (url, init) => {
    const host = new URL(url).hostname.toLowerCase();
    if (!EMBEDDED_IMAGE_HOSTS.has(host)) throw new HostNotAllowedError(host);
    return fetchFn(url, init);
  };
}

async function discardBody(res) {
  try { await res.body?.cancel?.(); } catch { /* already closed */ }
}

/** Download one image. Throws PermanentMiss for hopeless cases, anything else is transient. */
async function downloadImage(guardedFetch, url, signal) {
  let res;
  try {
    res = await guardedFetch(url, { signal, headers: { Accept: 'image/*' } });
  } catch (err) {
    if (err instanceof HostNotAllowedError || err instanceof SsrfError) throw new PermanentMiss(err.message);
    throw err;
  }
  // 408 and 429 say "try again later", not "this image is gone".
  if (res.status >= 500 || res.status === 408 || res.status === 429) {
    await discardBody(res);
    throw new Error(`download failed with HTTP ${res.status}`);
  }
  if (!res.ok) {
    await discardBody(res);
    throw new PermanentMiss(`download failed with HTTP ${res.status}`);
  }
  const mimetype = String(res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
  if (!mimetype.startsWith('image/')) {
    await discardBody(res);
    throw new PermanentMiss(`not an image (content-type ${mimetype || 'missing'})`);
  }
  let buffer;
  try {
    buffer = await readBodyCapped(res, { maxBytes: MAX_IMAGE_BYTES, signal });
  } catch (err) {
    if (err instanceof ResponseTooLargeError) throw new PermanentMiss(err.message);
    throw err;
  }
  if (!buffer || buffer.length === 0) throw new Error('empty image body');
  return { buffer, mimetype };
}

function addUsage(total, usage) {
  if (!usage) return total;
  const sum = total ?? { model: usage.model, prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  sum.prompt_tokens += usage.prompt_tokens ?? 0;
  sum.completion_tokens += usage.completion_tokens ?? 0;
  sum.total_tokens += usage.total_tokens ?? 0;
  return sum;
}

/**
 * Download and transcribe up to `max` images, sequentially.
 *
 * Results already in `previous` (a transcript or a `{ failed: true }` marker)
 * are copied without any I/O or budget. Misses come in two kinds: permanent
 * ones (4xx, not an image, too large, host or SSRF rejection) are returned as
 * `{ failed: true }` so the caller can cache them and never retry; transient
 * ones (budget, deadline, 5xx/network, provider error, empty reply) leave the
 * key out and set `transientMiss`, so the caller can skip caching.
 *
 * Budget (`llmAllowed`) is consumed only after a successful download, right
 * before the provider call. A refused budget stops the loop.
 *
 * @param {{url: string, key: string}[]} images
 * @returns {Promise<{
 *   transcripts: Object<string, {description: string, transcript: string|null}|{failed: true}>,
 *   transientMiss: boolean,
 *   budgetDeferred: boolean,
 *   usage: {model: string, prompt_tokens: number, completion_tokens: number, total_tokens: number}|null,
 * }>}
 */
export async function transcribeImages(images, {
  llmAllowed = () => true,
  captionFn = captionImage,
  fetchFn = globalThis.fetch,
  lang = 'de',
  max = readEmbeddedImagesMax(),
  deadlineMs = 90_000,
  previous = {},
  ssrfOpts,
} = {}) {
  const transcripts = {};
  let transientMiss = false;
  let budgetDeferred = false;
  let usage = null;

  const endsAt = Date.now() + deadlineMs;
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(new Error('embedded image deadline reached')), deadlineMs);
  const guardedFetch = safeFetch(hostGuarded(fetchFn), ssrfOpts);
  const prompt = buildImagePrompt(lang);
  const seen = new Set();

  try {
    for (const { url, key } of images.slice(0, max)) {
      if (seen.has(key)) continue;
      seen.add(key);

      const prior = previous[key];
      if (prior) { transcripts[key] = prior; continue; }

      if (deadline.signal.aborted || Date.now() >= endsAt) { transientMiss = true; break; }

      try {
        const dlSignal = AbortSignal.any([deadline.signal, AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS)]);
        const { buffer, mimetype } = await downloadImage(guardedFetch, url, dlSignal);

        if (!llmAllowed('image')) {
          transientMiss = true;
          budgetDeferred = true;
          break;
        }

        const result = await captionFn(buffer, { mimetype, prompt, raw: true, maxTokens: CAPTION_MAX_TOKENS, signal: deadline.signal });
        if (!result) throw new Error('no caption (no vision provider)');
        usage = addUsage(usage, result.usage);
        const parsed = parseCaption(result.markdown);
        if (!parsed) throw new Error('empty caption');
        transcripts[key] = parsed;
      } catch (err) {
        if (err instanceof PermanentMiss) {
          console.warn('[embedded-images]', url, `skipped permanently: ${err.message}`);
          transcripts[key] = { failed: true };
        } else {
          console.warn('[embedded-images]', url, `failed, will retry later: ${err?.message ?? err}`);
          transientMiss = true;
        }
      }
    }
  } finally {
    clearTimeout(timer);
  }

  return { transcripts, transientMiss, budgetDeferred, usage };
}
