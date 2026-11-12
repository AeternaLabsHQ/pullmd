/**
 * Scoring heuristics to pick between Readability and Trafilatura outputs.
 *
 * Based on P2.1 comparison eval (docs/eval/p2-1/REPORT.md):
 * - Trafilatura wins on thin/listing pages where Readability fails
 * - Readability wins on API docs and structured tabular content
 * - Goal: pick whichever extractor produced the better result for THIS page
 */

const TABLE_LINE_RE = /^\|.+\|$/gm;
const HEADING_RE = /^#{1,6} /gm;
const FENCE_RE = /^```/gm;
// {40} rather than {40,}: only the match count matters, and an unbounded
// quantifier over a multi-megabyte single line overflows the regex stack (#98).
const PARAGRAPH_RE = /(?:^|\n\n)[A-Za-zÀ-ÿ0-9][^\n]{40}/g;
const ARTICLE_OR_MAIN_RE = /<(article|main)\b/i;

export function metrics(md) {
  if (!md) return { len: 0, headings: 0, tables: 0, codeBlocks: 0, paragraphs: 0 };
  return {
    len: md.length,
    headings: (md.match(HEADING_RE) || []).length,
    tables: (md.match(TABLE_LINE_RE) || []).length,
    codeBlocks: ((md.match(FENCE_RE) || []).length / 2) | 0,
    paragraphs: (md.match(PARAGRAPH_RE) || []).length,
  };
}

/**
 * Picks between two markdown candidates.
 *
 * @param {string} readabilityMd  Readability + node-html-markdown output
 * @param {string} trafilaturaMd  Trafilatura output (may be empty if sidecar failed)
 * @param {boolean} [readabilityFellBack] true if readability fell back to cleaned body (signal: the readability output is body-soup, not real article)
 * @returns {{winner: 'readability'|'trafilatura', reason: string, score: number}}
 */
export function pickBest(readabilityMd, trafilaturaMd, readabilityFellBack = false) {
  const r = metrics(readabilityMd);
  const t = metrics(trafilaturaMd);

  // No trafilatura output → readability by default
  if (t.len === 0) {
    return { winner: 'readability', reason: 'trafilatura empty', score: scoreOf(r) };
  }

  // Readability fell back to body-soup AND trafilatura returned real content → trafilatura
  // (length comparison is unreliable here because body-soup can be larger than real content)
  if (readabilityFellBack && t.len >= 500) {
    return { winner: 'trafilatura', reason: 'readability fell back to body, trafilatura has content', score: scoreOf(t) };
  }

  // Readability returned essentially nothing AND trafilatura has substantial content
  if (r.len < 500 && t.len > 1000) {
    return { winner: 'trafilatura', reason: 'readability thin (<500c), trafilatura substantial', score: scoreOf(t) };
  }

  // Readability has many tables and trafilatura dropped them → readability (API docs / Wikipedia)
  if (r.tables >= 3 && t.tables < r.tables - 2) {
    return { winner: 'readability', reason: `tables preserved (${r.tables} vs ${t.tables})`, score: scoreOf(r) };
  }

  // Both have content. Pick longer one if it has at least one heading (avoids picking nav-soup).
  if (t.len > r.len * 1.2 && t.headings >= 1) {
    return { winner: 'trafilatura', reason: `longer with structure (${t.len}c vs ${r.len}c)`, score: scoreOf(t) };
  }

  if (r.len > t.len * 1.2 && r.headings >= 1) {
    return { winner: 'readability', reason: `longer with structure (${r.len}c vs ${t.len}c)`, score: scoreOf(r) };
  }

  // Default: readability (current pipeline, known-stable baseline)
  return { winner: 'readability', reason: 'comparable, prefer baseline', score: scoreOf(r) };
}

/**
 * Internal score used by pickBest to compare extractor outputs.
 * Returns 0..1 based on length and structural elements only.
 */
export function scoreOf(m) {
  if (m.len === 0) return 0;
  const lenScore = Math.min(m.len / 5000, 1);
  const structScore = Math.min(
    (m.headings >= 1 ? 0.5 : 0) +
    (m.tables >= 1 ? 0.25 : 0) +
    (m.codeBlocks >= 1 ? 0.25 : 0),
    1
  );
  return Math.round((lenScore * 0.6 + structScore * 0.4) * 100) / 100;
}

/**
 * Public quality score 0.0–1.0 — exposed as X-Quality header and metadata.quality.
 *
 * Heuristic from briefing (P2.2):
 *   +0.3 if extracted markdown > 500 chars
 *   +0.2 if extracted/raw HTML ratio > 2% (not stripped too aggressively)
 *   +0.2 if raw HTML had <article> or <main> tag
 *   +0.15 if at least one heading
 *   +0.15 if at least three paragraphs
 *
 * @param {string} markdown   The extracted markdown
 * @param {object} [opts]
 * @param {string} [opts.rawHtml]   Raw HTML, used for ratio + article-tag checks (omit for non-web sources like Reddit)
 * @returns {number} score 0.0–1.0, rounded to 2 decimals
 */
export function qualityScore(markdown, { rawHtml = null } = {}) {
  if (!markdown) return 0;
  const m = metrics(markdown);
  let score = 0;
  if (m.len > 500) score += 0.3;
  if (rawHtml) {
    if (rawHtml.length > 0 && m.len / rawHtml.length > 0.02) score += 0.2;
    if (ARTICLE_OR_MAIN_RE.test(rawHtml)) score += 0.2;
  } else {
    // Non-HTML sources (Reddit, Cloudflare markdown): clean by construction —
    // grant both web-only bonuses unconditionally so a substantial response can reach 1.0
    score += 0.4;
  }
  if (m.headings >= 1) score += 0.15;
  if (m.paragraphs >= 3) score += 0.15;
  return Math.min(Math.round(score * 100) / 100, 1);
}
