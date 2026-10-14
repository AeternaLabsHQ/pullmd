/**
 * HTML preprocessing applied before Mozilla Readability and Trafilatura see
 * the document. Generic — not site-specific — but motivated by patterns
 * observed on Future PLC's CMS (windowscentral, gamesradar, techradar,
 * tomshardware, pcgamer, t3, …) where extractors silently drop body
 * paragraphs. See issue #17 for the full analysis.
 *
 * Pattern 1  <p class="paywall" aria-hidden="true">…</p>
 *   The CSS overrides aria-hidden so humans see the text, but Readability
 *   and Trafilatura honor ARIA and discard the paragraph. Real paywalls
 *   return non-200 and don't reach this code path; the `paywall` class on
 *   a successful 200 is a metering hint, not a true gate. We strip the
 *   two attributes only — the element itself stays, scoped to <p> tags
 *   so the blast radius is limited.
 *
 * Pattern 2  <div class="… flw-widget-newsletter flw-article-recirculation-v1 …">…</div>
 *   Future PLC packs every flw-widget-* feature flag into the article-body
 *   container's class list. Readability's _unlikelyCandidates regex matches
 *   tokens like `recirculation`/`newsletter` and demotes the entire body.
 *   We strip those tokens, but only when the div has many substantial <p>
 *   descendants — that gates the fix to article-body containers and
 *   protects real newsletter widgets from being un-demoted.
 *
 * Pattern 3  <div class="w-embed"><table>…</table></div>
 *   Webflow wraps its generic "HTML Embed" component in `w-embed`, and sites
 *   use it for hand-built comparison tables. Trafilatura discards every
 *   element whose class contains the substring `embed` (meant for social
 *   embeds), so the whole table vanishes. We strip the `w-embed` token, but
 *   only when the div holds a <table>; icon and widget embeds keep it.
 */

import * as cheerio from 'cheerio';

// Tokens that mislead Readability when they appear on the body container.
// Both regexes share the same pattern; one is for testing, one for stripping.
const WIDGET_TOKEN_PATTERN =
  '\\b(?:flw-widget-newsletter|flw-article-recirculation(?:-v\\d+)?|widget-newsletter|recirculation)\\b';
const WIDGET_TOKEN_TEST = new RegExp(WIDGET_TOKEN_PATTERN);
const WIDGET_TOKEN_STRIP = new RegExp(WIDGET_TOKEN_PATTERN, 'g');

const SUBSTANTIAL_P_THRESHOLD = 80;
const ARTICLE_BODY_MIN_PARAGRAPHS = 5;

/**
 * Strip extractor-tripping markup from raw HTML.
 *
 * @param {string} html  Raw HTML as fetched
 * @returns {string}     HTML with Pattern 1-3 normalisations applied
 */
export function preprocess(html) {
  if (!html || typeof html !== 'string') return html;

  const $ = cheerio.load(html, { decodeEntities: false });

  // --- Pattern 1: paywall / aria-hidden paragraphs ---------------------------
  $('p.paywall, p[aria-hidden="true"]').each((_, el) => {
    const $el = $(el);
    if ($el.attr('aria-hidden') === 'true') $el.removeAttr('aria-hidden');
    const cls = $el.attr('class');
    if (cls && /\bpaywall\b/.test(cls)) {
      const next = cls.replace(/\bpaywall\b/g, '').replace(/\s+/g, ' ').trim();
      if (next) $el.attr('class', next);
      else $el.removeAttr('class');
    }
  });

  // --- Pattern 2: widget-tokens on article-body containers -------------------
  $('div').each((_, el) => {
    const $el = $(el);
    const cls = $el.attr('class');
    if (!cls || !WIDGET_TOKEN_TEST.test(cls)) return;

    let substantialPCount = 0;
    $el.find('p').each((_, p) => {
      if ($(p).text().trim().length >= SUBSTANTIAL_P_THRESHOLD) {
        substantialPCount++;
      }
    });
    if (substantialPCount < ARTICLE_BODY_MIN_PARAGRAPHS) return;

    const next = cls.replace(WIDGET_TOKEN_STRIP, '').replace(/\s+/g, ' ').trim();
    if (next) $el.attr('class', next);
    else $el.removeAttr('class');
  });

  // --- Pattern 3: Webflow w-embed wrapping a table ---------------------------
  $('div.w-embed').each((_, el) => {
    const $el = $(el);
    if ($el.find('table').length === 0) return;
    const next = $el.attr('class').replace(/(?:^|\s)w-embed(?=\s|$)/g, ' ').replace(/\s+/g, ' ').trim();
    if (next) $el.attr('class', next);
    else $el.removeAttr('class');
  });

  return $.html();
}
