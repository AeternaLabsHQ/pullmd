import { Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';
import { NodeHtmlMarkdown } from 'node-html-markdown';
import { extractMetadata } from './metadata.js';
import { pickBest, qualityScore } from './scoring.js';
import { renderDecision } from './render-decision.js';
import { renderViaSidecar } from './playwright-client.js';
import { pickUserAgent, maybeRefreshUaPool } from './user-agent.js';
import { preprocess } from './preprocess.js';
import { matchRecipes, matchRecipesAgainst, applyPreprocessActions } from './recipes.js';

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

function formatHeader(title, url, date) {
  const domain = new URL(url).hostname.replace(/^www\./, '');
  const now = new Date();
  const fetched = now.toISOString().slice(0, 16).replace('T', ' ');
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
 * Read an HTTP response body as a string, honoring the source charset.
 *
 * Real `fetch()` Responses expose `arrayBuffer()`; some test mocks only
 * provide `text()` — for those we trust the pre-decoded string (UTF-8).
 */
async function decodeBody(res, contentTypeHeader = '') {
  if (typeof res.arrayBuffer === 'function') {
    try {
      const buffer = Buffer.from(await res.arrayBuffer());
      const charset = detectCharset(buffer, contentTypeHeader);
      try {
        return new TextDecoder(charset, { fatal: false }).decode(buffer);
      } catch {
        return new TextDecoder('utf-8', { fatal: false }).decode(buffer);
      }
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
}

async function convertWithReadability(url, html, comments, statusCode, fetchFn, extractor, recipe) {
  let cleanedHtml = preprocess(html);
  if (recipe?.preprocess?.length) {
    cleanedHtml = applyPreprocessActions(cleanedHtml, recipe.preprocess);
  }
  const { document } = parseHTML(cleanedHtml);

  const title = document.querySelector('title')?.textContent?.trim() || new URL(url).hostname;
  const date = extractDate(document);

  const metadata = extractMetadata(cleanedHtml);
  metadata.sourceUrl = url;
  metadata.statusCode = statusCode;

  cleanDom(document, recipe?.removeSelectors || []);

  // Comments path: skip Readability and Trafilatura, use cleaned body
  if (comments) {
    const contentHtml = document.querySelector('body')?.innerHTML || cleanedHtml;
    const markdown = nhm.translate(contentHtml);
    metadata.quality = qualityScore(markdown, { rawHtml: cleanedHtml });
    return { markdown: formatHeader(title, url, date) + markdown, title, source: 'readability', metadata };
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

  return {
    markdown: formatHeader(title, url, date) + chosenMd,
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
  const rawFetchFn = options.fetch || globalThis.fetch;
  const fetchFn = withTimeout(rawFetchFn);

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
  const body = await decodeBody(res, ct);

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
