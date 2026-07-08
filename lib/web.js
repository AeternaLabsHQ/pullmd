import { Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';
import { NodeHtmlMarkdown } from 'node-html-markdown';
import { extractMetadata } from './metadata.js';
import { safeFetch } from './ssrf.js';
import { pickBest, qualityScore } from './scoring.js';
import { renderDecision } from './render-decision.js';
import { renderViaSidecar } from './playwright-client.js';
import { pickUserAgent, maybeRefreshUaPool } from './user-agent.js';
import { preprocess } from './preprocess.js';
import { matchRecipes, matchRecipesAgainst, applyPreprocessActions, mergeRecipes } from './recipes.js';
import { convertViaMarkitdown, convertYoutubeViaSidecar } from './markitdown-client.js';
import { isYoutubeUrl, normalizeYoutubeWatchUrl } from './youtube.js';
import { captionImage } from './llm/vision.js';
import { transcribeAudio } from './llm/stt.js';
import { ocrPdf } from './llm/pdf-ocr.js';

const MARKITDOWN_CONTENT_TYPES = new Set([
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/epub+zip',
  'application/zip',
  'text/csv',
  'application/json',
  'application/xml',
  'text/xml',
]);

const MARKITDOWN_EXT_RE = /\.(pdf|docx|pptx|xlsx?|epub|zip|csv|json|xml)$/i;

/**
 * Decide whether a fetched resource is a document markitdown should convert
 * (rather than an HTML page for the Readability pipeline). Matches on the
 * content-type allowlist; for missing / octet-stream content-types it falls
 * back to sniffing the URL path extension.
 *
 * Only matches document types (MARKITDOWN_CONTENT_TYPES / MARKITDOWN_EXT_RE).
 * Image/audio are handled by the Node LLM layer (mediaKindFor).
 */
function isMarkitdownTarget(contentType, url) {
  const ct = (contentType || '').split(';')[0].trim().toLowerCase();
  if (MARKITDOWN_CONTENT_TYPES.has(ct)) return true;
  if (ct === '' || ct === 'application/octet-stream') {
    let pathname;
    try { pathname = new URL(url).pathname; } catch { return false; }
    if (MARKITDOWN_EXT_RE.test(pathname)) return true;
  }
  return false;
}

const IMAGE_CONTENT_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp', 'image/tiff']);
const AUDIO_CONTENT_TYPES = new Set(['audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/x-wav', 'audio/mp4', 'audio/ogg', 'audio/flac', 'audio/aac', 'audio/webm']);
const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|bmp|tiff?)$/i;
const AUDIO_EXT_RE = /\.(mp3|wav|m4a|ogg|flac|aac)$/i;

/** 'image' | 'audio' | null. pathHint is a URL pathname or a filename. */
function mediaKindFor(contentType, pathHint) {
  const ct = (contentType || '').split(';')[0].trim().toLowerCase();
  if (IMAGE_CONTENT_TYPES.has(ct)) return 'image';
  if (AUDIO_CONTENT_TYPES.has(ct)) return 'audio';
  if (ct === '' || ct === 'application/octet-stream') {
    const p = pathHint || '';
    if (IMAGE_EXT_RE.test(p)) return 'image';
    if (AUDIO_EXT_RE.test(p)) return 'audio';
  }
  return null;
}

/** A PDF by content-type or by .pdf path/filename hint. */
function isPdf(contentType, pathHint) {
  const ct = (contentType || '').split(';')[0].trim().toLowerCase();
  if (ct === 'application/pdf') return true;
  if (ct === '' || ct === 'application/octet-stream') return /\.pdf$/i.test(pathHint || '');
  return false;
}

function emptyMetadata() {
  return {
    title: null, description: null, canonical: null, author: null,
    publishedTime: null, modifiedTime: null,
    ogTitle: null, ogDescription: null, ogImage: null,
    ogSiteName: null, ogType: null,
    twitterCard: null, twitterTitle: null, twitterDescription: null, twitterImage: null,
    language: null, sourceUrl: null, statusCode: null,
  };
}

/** Copy usage/audio/image fields from an LLM adapter result into metadata. */
function applyMediaUsage(metadata, media) {
  if (media.usage) {
    metadata.llmModel = media.usage.model || null;
    if (media.usage.total_tokens !== undefined) metadata.llmTokens = media.usage.total_tokens;
    if (media.usage.prompt_tokens !== undefined) metadata.llmPromptTokens = media.usage.prompt_tokens;
    if (media.usage.completion_tokens !== undefined) metadata.llmCompletionTokens = media.usage.completion_tokens;
  }
  if (media.audioSeconds != null) metadata.audioSeconds = media.audioSeconds;
  if (media.imageSize) metadata.imageSize = media.imageSize;
  if (media.pdfPages != null) metadata.pdfPages = media.pdfPages;
}

const TRAFILATURA_URL = process.env.TRAFILATURA_URL;
const TRAFILATURA_TIMEOUT_MS = 8_000;

async function runTrafilatura(html, fetchFn = globalThis.fetch) {
  if (!TRAFILATURA_URL) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TRAFILATURA_TIMEOUT_MS);
  try {
    const res = await fetchFn(TRAFILATURA_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ html }),
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    const text = await res.text();
    return text || null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

const nhm = new NodeHtmlMarkdown({
  codeBlockStyle: 'fenced',
  bulletMarker: '-',
});

function extractDate(document) {
  const selectors = [
    'meta[property="article:published_time"]',
    'meta[name="date"]',
    'meta[name="publish_date"]',
    'meta[property="og:published_time"]',
    'time[datetime]',
  ];
  for (const sel of selectors) {
    const el = document.querySelector(sel);
    const value = el?.getAttribute('content') || el?.getAttribute('datetime');
    if (value) {
      const d = new Date(value);
      if (!isNaN(d)) {
        return d.toLocaleDateString('de-DE', { day: 'numeric', month: 'long', year: 'numeric' });
      }
    }
  }
  return null;
}

function formatHeader(title, url, date, filename) {
  // Clean body by default: just the H1 title. Source/date live in the frontmatter.
  // Set PULLMD_SOURCE_HEADER=true to restore the legacy inline source header.
  if (!process.env.PULLMD_SOURCE_HEADER) {
    return `# ${title}\n\n`;
  }
  const now = new Date();
  const fetched = now.toISOString().slice(0, 16).replace('T', ' ');
  if (!url) {
    let header = `# ${title}\n\n**${filename || 'local file'}** · ${fetched}`;
    if (date) header += ` · ${date}`;
    return header + '\n\n';
  }
  const domain = new URL(url).hostname.replace(/^www\./, '');
  let header = `# ${title}\n\n**${domain}** · ${fetched}`;
  if (date) header += ` · ${date}`;
  header += `\n${url}\n\n`;
  return header;
}

/**
 * Detect the source charset of an HTTP body when the Content-Type header
 * doesn't carry a charset= parameter. Many ISO-8859-1 / Windows-1252 sites
 * (e.g. winfuture.de) only declare encoding inside the document.
 *
 * Resolution order: Content-Type header → BOM → <meta charset> →
 * <meta http-equiv="Content-Type"> → utf-8 fallback.
 */
function detectCharset(buffer, contentTypeHeader = '') {
  const ctMatch = contentTypeHeader.match(/charset\s*=\s*"?([\w-]+)"?/i);
  if (ctMatch) return ctMatch[1].toLowerCase();

  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) return 'utf-8';
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) return 'utf-16le';
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) return 'utf-16be';

  // Sniff the head as latin1 so high bytes don't break the regex; we only
  // care about ASCII tokens (<meta>, charset=, http-equiv=).
  const head = Buffer.from(buffer.subarray(0, Math.min(buffer.length, 2048))).toString('latin1');

  for (const m of head.matchAll(/<meta\b[^>]*>/gi)) {
    const tag = m[0];
    if (/http-equiv\s*=\s*["']?content-type/i.test(tag)) {
      const cs = tag.match(/content\s*=\s*["'][^"']*charset\s*=\s*([\w-]+)/i);
      if (cs) return cs[1].toLowerCase();
    }
    const cs = tag.match(/\bcharset\s*=\s*["']?([\w-]+)/i);
    if (cs) return cs[1].toLowerCase();
  }

  return 'utf-8';
}

/**
 * Decode a pre-read buffer to a string, honoring the source charset.
 * `res` is only used to access headers (not consumed).
 */
function decodeBytes(buffer, contentTypeHeader = '') {
  const charset = detectCharset(buffer, contentTypeHeader);
  try {
    return new TextDecoder(charset, { fatal: false }).decode(buffer);
  } catch {
    return new TextDecoder('utf-8', { fatal: false }).decode(buffer);
  }
}

/**
 * Read an HTTP response body as a string, honoring the source charset.
 *
 * Real `fetch()` Responses expose `arrayBuffer()`; some test mocks only
 * provide `text()` — for those we trust the pre-decoded string (UTF-8).
 */
async function decodeBody(res, contentTypeHeader = '') {
  if (typeof res.arrayBuffer === 'function') {
    try {
      const buffer = Buffer.from(await res.arrayBuffer());
      return decodeBytes(buffer, contentTypeHeader);
    } catch {
      // arrayBuffer() rejected — fall through to text()
    }
  }
  return await res.text();
}

const FETCH_TIMEOUT_MS = 15_000;

function withTimeout(fetchFn, timeoutMs = FETCH_TIMEOUT_MS) {
  return async (url, opts = {}) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetchFn(url, { ...opts, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  };
}

const REMOVE_SELECTORS = [
  'nav', 'header', 'footer', 'aside',
  '[role="navigation"]', '[role="banner"]', '[role="contentinfo"]', '[role="search"]',
  '.nav', '.navbar', '.menu', '.sidebar', '.breadcrumb', '.breadcrumbs',
  '.search', '.search-form', '.site-header', '.site-footer', '.site-nav',
  '.mega-menu', '.megamenu', '[class*="mega-menu"]', '[class*="megamenu"]',
  '[class*="global-nav"]', '[class*="search-panel"]',
  '#nav', '#header', '#footer', '#sidebar', '#menu',
  '.cookie-banner', '.cookie-notice',
  '.share-buttons', '.social-share', '[class*="share"]',
  '.related-posts', '.recommended',
  '.blog-sidebar', '.mobile-credits', '[id*="blog-name"]',
  '.post-author', '.post-date', '.category-link',
  'style', 'script', 'noscript', 'link', 'meta',
].join(', ');

// Strict UUID v4 — used to detect CMS-asset-ID leakage in <img alt>.
const UUID_ALT_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function cleanDom(document, extraRemoveSelectors = []) {
  const allRemove = extraRemoveSelectors.length > 0
    ? REMOVE_SELECTORS + ', ' + extraRemoveSelectors.join(', ')
    : REMOVE_SELECTORS;
  [...document.querySelectorAll(allRemove)].forEach(el => el.remove());

  // Surface readonly text-input values as <code> so click-to-copy slugs
  // (API model names, embed snippets, share links, …) survive extraction.
  for (const input of document.querySelectorAll('input[type="text"][readonly]')) {
    const value = input.getAttribute('value');
    if (value) {
      const code = document.createElement('code');
      code.textContent = value;
      input.replaceWith(code);
    }
  }

  // Drop CMS-asset-ID leakage in <img alt>: when the alt is a bare UUID,
  // it's a CMS slug, not a description. Keep the image (operator can still
  // see the URL) but stop the UUID from polluting the markdown.
  for (const img of document.querySelectorAll('img[alt]')) {
    if (UUID_ALT_RE.test(img.getAttribute('alt'))) {
      img.removeAttribute('alt');
    }
  }

  // Drop tracking pixels: a 1x1 (or smaller) image with both dimensions
  // declared is an invisible analytics beacon, not content. Readability keeps
  // these when they ride inline inside a content paragraph (e.g. theconversation
  // republish counter), so they'd otherwise surface as bogus markdown images.
  // Require BOTH width and height ≤ 1 so genuine 1xN/Nx1 banners are spared.
  for (const img of document.querySelectorAll('img[width][height]')) {
    const w = parseInt(img.getAttribute('width'), 10);
    const h = parseInt(img.getAttribute('height'), 10);
    if (Number.isFinite(w) && Number.isFinite(h) && w <= 1 && h <= 1) {
      img.remove();
    }
  }
}

// URL-bearing attributes per element. Relative values break once the
// markdown leaves the source origin (share page, PWA, MCP clients), and
// neither Readability (linkedom has no baseURI) nor Trafilatura (images
// stay relative even with url=) resolves them — so we do it here, once,
// before any extractor sees the HTML.
const URL_ATTRS = [
  ['img', ['src', 'srcset']],
  ['source', ['src', 'srcset']],
  ['a', ['href']],
  ['video', ['src', 'poster']],
  ['audio', ['src']],
];

const NON_RESOLVABLE_RE = /^(data:|mailto:|javascript:|tel:|#)/i;

function resolveAgainst(value, baseUrl) {
  const v = value.trim();
  if (!v || NON_RESOLVABLE_RE.test(v)) return null;
  try { return new URL(v, baseUrl).href; } catch { return null; }
}

function absolutifySrcset(value, baseUrl) {
  return value.split(',').map(part => {
    const m = part.trim().match(/^(\S+)(\s+\S+)?$/);
    if (!m) return part.trim();
    return (resolveAgainst(m[1], baseUrl) || m[1]) + (m[2] || '');
  }).join(', ');
}

function absolutifyUrls(document, baseUrl) {
  for (const [tag, attrs] of URL_ATTRS) {
    for (const el of document.querySelectorAll(tag)) {
      for (const attr of attrs) {
        const value = el.getAttribute(attr);
        if (!value) continue;
        if (attr === 'srcset') {
          el.setAttribute(attr, absolutifySrcset(value, baseUrl));
        } else {
          const abs = resolveAgainst(value, baseUrl);
          if (abs && abs !== value) el.setAttribute(attr, abs);
        }
      }
    }
  }
}

async function convertWithReadability(url, html, comments, statusCode, fetchFn, extractor, recipe, filename) {
  let cleanedHtml = preprocess(html);
  if (recipe?.preprocess?.length) {
    cleanedHtml = applyPreprocessActions(cleanedHtml, recipe.preprocess);
  }
  const { document } = parseHTML(cleanedHtml);

  if (url) {
    absolutifyUrls(document, url);
    // Re-serialize so the Trafilatura sidecar and the readability-fallback
    // re-parse see absolute URLs too.
    cleanedHtml = document.toString();
  }

  const title = document.querySelector('title')?.textContent?.trim()
    || (url ? new URL(url).hostname : (filename || 'Untitled'));
  const date = extractDate(document);

  const metadata = extractMetadata(cleanedHtml);
  metadata.sourceUrl = url ?? null;
  metadata.statusCode = statusCode;

  cleanDom(document, recipe?.removeSelectors || []);

  // Comments path: skip Readability and Trafilatura, use cleaned body
  if (comments) {
    const contentHtml = document.querySelector('body')?.innerHTML || cleanedHtml;
    const markdown = nhm.translate(contentHtml);
    metadata.quality = qualityScore(markdown, { rawHtml: cleanedHtml });
    metadata.contentLength = markdown.trim().length;
    return { markdown: formatHeader(title, url, date, filename) + markdown, title, source: 'readability', metadata };
  }

  const reader = new Readability(document);
  const article = reader.parse();

  let readabilityMd;
  let readabilityFellBack = false;
  if (article && article.content && article.content.length >= 200) {
    readabilityMd = nhm.translate(article.content);
  } else {
    const { document: doc2 } = parseHTML(cleanedHtml);
    cleanDom(doc2, recipe?.removeSelectors || []);
    readabilityMd = nhm.translate(doc2.querySelector('body')?.innerHTML || cleanedHtml);
    readabilityFellBack = true;
  }

  // Skip the Trafilatura sidecar entirely when the caller forced readability.
  const trafilaturaMd = extractor === 'readability'
    ? null
    : await runTrafilatura(cleanedHtml, fetchFn);

  let chosenMd;
  let source;
  let extractorReason;

  if (extractor === 'readability') {
    chosenMd = readabilityMd;
    source = readabilityFellBack ? 'readability-fallback' : 'readability';
    extractorReason = 'forced via extractor=readability';
  } else if (extractor === 'trafilatura' && trafilaturaMd) {
    chosenMd = trafilaturaMd;
    source = 'trafilatura';
    extractorReason = 'forced via extractor=trafilatura';
  } else {
    if (extractor === 'trafilatura' && !trafilaturaMd) {
      // Forced trafilatura but the sidecar is unavailable / returned empty —
      // fall through to pickBest and surface the fallback in the reason.
      const decision = pickBest(readabilityMd, '', readabilityFellBack);
      chosenMd = readabilityMd;
      source = readabilityFellBack ? 'readability-fallback' : 'readability';
      extractorReason = `extractor=trafilatura unavailable, fell back to ${source}: ${decision.reason}`;
    } else {
      const decision = pickBest(readabilityMd, trafilaturaMd || '', readabilityFellBack);
      chosenMd = decision.winner === 'trafilatura' ? trafilaturaMd : readabilityMd;
      source = decision.winner === 'trafilatura'
        ? 'trafilatura'
        : (readabilityFellBack ? 'readability-fallback' : 'readability');
      extractorReason = decision.reason;
    }
  }

  metadata.quality = qualityScore(chosenMd, { rawHtml: cleanedHtml });
  metadata.extractorReason = extractorReason;
  metadata.contentLength = chosenMd.trim().length;

  return {
    markdown: formatHeader(title, url, date, filename) + chosenMd,
    title,
    source,
    metadata,
  };
}

/**
 * Orchestrate web extraction: fetch → static extract → optionally Playwright re-render.
 *
 * Pipeline:
 *   1. Fetch the URL (Cloudflare-markdown short-circuit if Accept negotiates that).
 *   2. Run Readability+Trafilatura+pickBest on the static HTML.
 *   3. Consult `renderDecision`. If it says yes, call the Playwright sidecar via
 *      `renderClient(url, { signal })` and re-run extraction on the rendered DOM.
 *   4. On sidecar failure, return the degraded static result with a fallback note
 *      appended to `metadata.extractorReason` — the system is degradable, not breakable.
 *
 * @param {string} url
 * @param {object} [options]
 * @param {boolean} [options.comments=false]            Reddit-style comment formatting (skips Readability+Trafilatura)
 * @param {(stage: string, data?: object) => void} [options.emit]    Status callback ('fetching'|'extracting'|'rendering')
 * @param {AbortSignal} [options.signal]                Forwarded only to the sidecar call (not the initial fetch)
 * @param {'force'|'skip'} [options.render]             Manual override of renderDecision
 * @param {(url: string, opts: object) => Promise<string>} [options.renderClient]   Defaults to renderViaSidecar; injectable for tests
 * @param {(buf: Buffer, opts: object) => Promise<{markdown:string,title:string|null}|null>} [options.markitdownClient]  Defaults to convertViaMarkitdown; injectable for tests
 * @param {(html: string, opts: object) => Promise<{markdown:string,title:string|null,fields?:object}|null>} [options.youtubeClient]  Defaults to convertYoutubeViaSidecar; injectable for tests
 * @param {'links'|'plain'|'none'} [options.ytTimecodes]  YouTube transcript timecode style (per-request override)
 * @param {number} [options.ytChunk]  YouTube transcript block size in seconds; 0 = per original snippet
 * @param {typeof fetch} [options.fetch]                Injectable fetch
 */
export async function extractWeb(url, options = {}) {
  const {
    comments = false,
    emit = () => {},
    signal,
    render,                                 // 'force' | 'skip' | undefined
    extractor,                              // 'readability' | 'trafilatura' | 'playwright' | undefined
    renderClient = renderViaSidecar,        // injectable for tests
    markitdownClient = convertViaMarkitdown, // injectable for tests
    youtubeClient = convertYoutubeViaSidecar, // injectable for tests
    captionFn = captionImage,               // injectable for tests
    transcribeFn = transcribeAudio,         // injectable for tests
    pdfOcr,                                 // opt-in PDF OCR (query param)
    ocrFn = ocrPdf,                         // injectable for tests
    ytTimecodes,
    ytChunk,
  } = options;

  // Resolve recipes: tests may pass options.recipes directly; production reads
  // from the module-level cache populated by loadRecipes() at server boot.
  const recipe = options.recipes
    ? matchRecipesAgainst(options.recipes, new URL(url))
    : matchRecipes(new URL(url));

  // Hook 1: query-param wins over recipe; recipe wins over no-default
  const queryRender = (render === 'force' || render === 'skip') ? render : undefined;
  const effectiveExtractor = extractor || recipe.extractor;
  const effectiveRender = effectiveExtractor === 'playwright'
    ? 'force'
    : (queryRender ?? recipe.fetch.render);
  const effectivePdfOcr = pdfOcr || recipe.fetch.pdf === 'ocr';
  const rawFetchFn = options.fetch || globalThis.fetch;
  // SSRF guard: validate the target (and every redirect hop) before fetching,
  // then apply the per-request timeout. Blocked hosts throw SsrfError.
  const fetchFn = withTimeout(safeFetch(rawFetchFn));

  // Refresh the UA pool in the background if the TTL has expired. Synchronous
  // TTL check; the actual refresh (if any) does not block this request.
  void maybeRefreshUaPool();

  const userAgent = pickUserAgent();
  const headers = { 'User-Agent': userAgent };
  if (!comments) {
    headers['Accept'] = 'text/markdown, text/html;q=0.9, */*;q=0.8';
  }

  emit('fetching', { url });
  const res = await fetchFn(url, { headers });

  if (!res.ok) {
    throw new Error(`Page fetch failed with status ${res.status}`);
  }

  const statusCode = res.status || 200;
  const ct = res.headers.get('content-type') || '';

  // Read the body bytes ONCE upfront (when arrayBuffer is available and we're
  // not in comments mode). The media branch, the markitdown-document branch,
  // and the normal decode all reuse these same bytes — no second arrayBuffer()
  // call is ever made on any code path.
  const bodyBytes = (!comments && typeof res.arrayBuffer === 'function')
    ? Buffer.from(await res.arrayBuffer())
    : null;

  // Image / audio → Node LLM layer (when a provider is configured). Falls
  // through to normal extraction when no provider is set (no behaviour change).
  if (!comments) {
    let pathHint = '';
    try { pathHint = new URL(url).pathname; } catch { pathHint = ''; }
    const kind = mediaKindFor(ct, pathHint);
    if ((kind === 'image' || kind === 'audio') && bodyBytes != null) {
      const buf = bodyBytes;
      let media = null;
      try {
        media = kind === 'image'
          ? await captionFn(buf, { mimetype: ct, signal })
          : await transcribeFn(buf, { mimetype: ct, filename: pathHint.split('/').pop() || undefined, signal });
      } catch (e) {
        // Provider error (rate-limit, 5xx, oversized) → fall back to normal
        // extraction instead of failing the whole request. Mirrors the
        // null-provider fall-through below and the PDF-OCR branch.
        console.warn(`${kind} captioning failed, falling back to normal extraction:`, String(e?.message ?? e));
      }
      if (media) {
        const source = kind === 'image' ? 'image-caption' : 'audio-transcript';
        emit('extracting', { source });
        const title = (() => { try { return new URL(url).hostname; } catch { return kind === 'image' ? 'Image' : 'Audio'; } })();
        const trimmedMd = media.markdown.trim();
        const metadata = { ...emptyMetadata(), sourceUrl: url, statusCode, quality: qualityScore(trimmedMd) };
        metadata.contentLength = trimmedMd.length;
        applyMediaUsage(metadata, media);
        return { markdown: formatHeader(title, url, null) + trimmedMd, title, source, metadata };
      }
      // provider unset / returned null → fall through to normal extraction
    }
  }

  // High-quality PDF → OCR (opt-in + provider configured). Falls back to the
  // markitdown branch below on no-provider (null) or OCR failure.
  let pdfPathHint = '';
  try { pdfPathHint = new URL(url).pathname; } catch { pdfPathHint = ''; }
  if (!comments && bodyBytes != null && effectivePdfOcr && isPdf(ct, pdfPathHint)) {
    let ocr = null;
    let ocrErr = null;
    try { ocr = await ocrFn({ buffer: bodyBytes, mimetype: 'application/pdf', signal }); }
    catch (e) { ocrErr = String(e?.message ?? e); }
    if (ocr && ocr.markdown.trim()) {
      emit('extracting', { source: 'pdf-ocr' });
      let title; try { title = new URL(url).pathname.split('/').pop() || new URL(url).hostname; } catch { title = 'Document'; }
      const trimmedMd = ocr.markdown.trim();
      const metadata = { ...emptyMetadata(), sourceUrl: url, statusCode, quality: qualityScore(trimmedMd) };
      metadata.contentLength = trimmedMd.length;
      applyMediaUsage(metadata, ocr);
      return { markdown: formatHeader(title, url, null) + trimmedMd, title, source: 'pdf-ocr', metadata };
    }
    // null (unconfigured) or failed → fall through to markitdown
    if (ocrErr) emit('extracting', { source: 'markitdown', note: `pdf-ocr failed: ${ocrErr}` });
  }

  // Non-HTML document → markitdown sidecar (PDF, Office, EPUB, ZIP, CSV/JSON/XML).
  if (!comments && isMarkitdownTarget(ct, url) && bodyBytes != null) {
    emit('extracting', { source: 'markitdown' });
    // Pass just the basename (no query string) as the extension hint, not the full URL.
    let filename;
    try { filename = new URL(url).pathname.split('/').pop() || undefined; } catch { filename = undefined; }
    const converted = await markitdownClient(bodyBytes, { filename, contentType: ct, signal });
    if (!converted) {
      throw new Error('markitdown sidecar unavailable or could not convert this document');
    }
    const title = converted.title || (url ? new URL(url).hostname : 'Document');
    const trimmedMd = converted.markdown.trim();
    const markdown = formatHeader(title, url, null) + trimmedMd;
    const metadata = { ...emptyMetadata(), sourceUrl: url, statusCode, quality: qualityScore(trimmedMd) };
    metadata.contentLength = trimmedMd.length;
    applyMediaUsage(metadata, converted);
    return { markdown, title, source: 'markitdown', metadata };
  }

  const body = bodyBytes != null ? decodeBytes(bodyBytes, ct) : await decodeBody(res, ct);

  // Cloudflare returned native markdown
  if (!comments && ct.includes('text/markdown') && body.trim().length >= 20) {
    const titleMatch = body.match(/^#\s+(.+)$/m);
    const title = titleMatch ? titleMatch[1].trim() : new URL(url).hostname;
    const markdown = formatHeader(title, url, null) + body.trim();
    const metadata = {
      title, description: null, canonical: null, author: null,
      publishedTime: null, modifiedTime: null,
      ogTitle: null, ogDescription: null, ogImage: null,
      ogSiteName: null, ogType: null,
      twitterCard: null, twitterTitle: null, twitterDescription: null, twitterImage: null,
      language: null, sourceUrl: url, statusCode,
      quality: qualityScore(body),
    };
    emit('extracting', { source: 'cloudflare' });
    return { markdown, title, source: 'cloudflare', metadata };
  }

  // YouTube → dedicated sidecar endpoint. Degrades to the HTML pipeline below
  // if the sidecar is unreachable (no hard failure).
  if (!comments && !!process.env.MARKITDOWN_YOUTUBE && isYoutubeUrl(url)) {
    const yt = await youtubeClient(body, {
      sourceUrl: normalizeYoutubeWatchUrl(url),
      timecodes: ytTimecodes,
      chunk: ytChunk,
      signal,
    });
    if (yt) {
      emit('extracting', { source: 'youtube' });
      const f = yt.fields || {};
      const title = yt.title || new URL(url).hostname;
      const trimmedMd = yt.markdown.trim();
      const metadata = {
        ...emptyMetadata(),
        sourceUrl: url, statusCode,
        author: f.channel || null,
        publishedTime: f.published || null,
        quality: qualityScore(trimmedMd),
      };
      metadata.contentLength = trimmedMd.length;
      metadata.ytDuration = f.duration || null;
      metadata.ytViews = f.views || null;
      const markdown = formatHeader(title, url, null) + trimmedMd;
      const result = { markdown, title, source: 'youtube', metadata };
      // Surface the transcript state (ok|none|blocked|error) so the HTTP layer
      // can expose it via the X-Transcript-Status header for programmatic
      // consumers (e.g. the collector pipeline) that need to tell a transient
      // 429 block from a genuinely absent transcript.
      if (yt.transcriptStatus) result.transcriptStatus = yt.transcriptStatus;
      // Transient transcript failures (YouTube 429 / fetch error) must not be
      // cached as if they were the final answer — flag for the caller to skip
      // persistence so a later retry can pick up the now-available transcript.
      if (yt.transcriptStatus === 'blocked' || yt.transcriptStatus === 'error') {
        result.noStore = true;
      }
      return result;
    }
    // sidecar down → fall through to the normal HTML extraction below
  }

  // First pass: static extraction (Readability + Trafilatura + pickBest)
  const result = await convertWithReadability(url, body, comments, statusCode, rawFetchFn, effectiveExtractor, recipe);
  emit('extracting', { source: result.source });

  // Decide whether to render via Playwright sidecar
  const decision = renderDecision(result, effectiveRender);
  if (!decision.yes) return result;

  emit('rendering', { reason: decision.reason });

  // Second pass: render via sidecar, re-extract on rendered HTML
  try {
    const renderedHtml = await renderClient(url, {
      signal,
      waitFor:       recipe?.fetch?.wait_for,
      waitTimeoutMs: recipe?.fetch?.wait_timeout_ms,
      mobileUa:      recipe?.fetch?.mobile_ua,
      userAgent,
    });
    const rendered = await convertWithReadability(url, renderedHtml, comments, statusCode, rawFetchFn, effectiveExtractor, recipe);
    rendered.source = 'playwright';
    const renderReason = effectiveExtractor === 'playwright'
      ? 'forced via extractor=playwright'
      : `${decision.reason} → rendered via playwright`;
    rendered.metadata.extractorReason = renderReason;
    emit('extracting', { source: 'playwright' });
    return rendered;
  } catch (err) {
    const errMsg = String(err?.message ?? err);
    console.warn('Playwright fallback failed:', errMsg);
    const prevReason = result.metadata?.extractorReason || '';
    result.metadata.extractorReason =
      (prevReason ? prevReason + ' | ' : '') + `playwright fallback failed: ${errMsg}`;
    return result;
  }
}

/**
 * Convert uploaded document bytes (PDF/Office/EPUB/…) to Markdown via the
 * markitdown sidecar. No URL → the header shows the file name (like the
 * local-HTML path). No cache, no share link (privacy is enforced at the
 * route layer).
 *
 * @param {Buffer} buffer
 * @param {object} [options]
 * @param {string} [options.filename]
 * @param {string} [options.contentType]
 * @param {function} [options.markitdownClient]  injectable (tests)
 */
export async function extractFile(buffer, options = {}) {
  const {
    filename, contentType,
    markitdownClient = convertViaMarkitdown,
    captionFn = captionImage,
    transcribeFn = transcribeAudio,
    pdfOcr,
    ocrFn = ocrPdf,
  } = options;

  const kind = mediaKindFor(contentType, filename || '');

  if (kind === 'image') {
    let media = null;
    try { media = await captionFn(buffer, { mimetype: contentType, filename }); }
    catch (err) { console.warn('image captioning failed, falling back to markitdown:', String(err?.message ?? err)); }
    if (media) return fileResult(media, filename || 'Image', filename, 'image-caption');
  } else if (kind === 'audio') {
    let media = null;
    try { media = await transcribeFn(buffer, { mimetype: contentType, filename }); }
    catch (err) { console.warn('audio transcription failed, falling back to markitdown:', String(err?.message ?? err)); }
    if (media) return fileResult(media, filename || 'Audio', filename, 'audio-transcript');
  }

  if (pdfOcr && isPdf(contentType, filename || '')) {
    let ocr = null;
    try { ocr = await ocrFn({ buffer, mimetype: contentType || 'application/pdf' }); }
    catch (err) { console.warn('PDF-OCR failed, falling back to markitdown:', String(err?.message ?? err)); ocr = null; }
    if (ocr && ocr.markdown.trim()) return fileResult(ocr, filename || 'Document', filename, 'pdf-ocr');
  }

  // document (or media with no provider configured) → markitdown sidecar
  const converted = await markitdownClient(buffer, { filename, contentType });
  if (!converted) {
    throw new Error('markitdown sidecar unavailable or could not convert this document');
  }
  return fileResult(converted, converted.title || filename || 'Document', filename, 'markitdown');
}

/** Build the {markdown,title,source,metadata} shape shared by all extractFile paths. */
function fileResult(media, title, filename, source) {
  const trimmedMd = media.markdown.trim();
  const markdown = formatHeader(title, null, null, filename) + trimmedMd;
  const metadata = { ...emptyMetadata(), quality: qualityScore(trimmedMd) };
  metadata.contentLength = trimmedMd.length;
  applyMediaUsage(metadata, media);
  return { markdown, title, source, metadata };
}

/**
 * Replace base64-inlined images (SingleFile exports etc.) with their alt
 * text — a single inlined photo would otherwise bloat the markdown by
 * hundreds of KB of data: URI.
 */
function stripDataUriImages(html) {
  if (!html.includes('data:')) return html;
  const { document } = parseHTML(html);
  const imgs = [...document.querySelectorAll('img[src^="data:"]')];
  if (imgs.length === 0) return html;
  for (const img of imgs) {
    const alt = (img.getAttribute('alt') || '').trim();
    if (alt) img.replaceWith(document.createTextNode(alt));
    else img.remove();
  }
  return document.toString();
}

/**
 * Convert pre-fetched / locally saved HTML to markdown.
 *
 * Skips the fetch step of extractWeb() and — by design — the Playwright
 * sidecar (user-supplied HTML must never run in a server-side browser) and
 * the Cloudflare markdown shortcut. Recipes apply only when the original
 * URL is known.
 *
 * @param {string} html
 * @param {object} [options]
 * @param {string} [options.url]       Original source URL (enables recipes + linked header)
 * @param {string} [options.filename]  Shown in the header when no URL is given
 * @param {'readability'|'trafilatura'} [options.extractor]
 * @param {Array}  [options.recipes]   Injectable for tests (defaults to module cache)
 * @param {typeof fetch} [options.fetch]  Injectable fetch (only reaches the Trafilatura sidecar)
 */
export async function extractHtml(html, options = {}) {
  const { url, filename, extractor } = options;
  const recipe = url
    ? (options.recipes ? matchRecipesAgainst(options.recipes, new URL(url)) : matchRecipes(new URL(url)))
    : mergeRecipes([]);
  const effectiveExtractor = (extractor === 'readability' || extractor === 'trafilatura')
    ? extractor
    : recipe.extractor;
  const rawFetchFn = options.fetch || globalThis.fetch;
  return convertWithReadability(url || null, stripDataUriImages(html), false, null, rawFetchFn, effectiveExtractor, recipe, filename);
}
