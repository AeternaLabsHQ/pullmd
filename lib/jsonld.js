/**
 * schema.org JSON-LD extraction for the site-recipe frontmatter engine.
 *
 * Site recipes can pull values out of embedded `<script type="application/ld+json">`
 * blocks (and/or CSS selectors) and inject them as custom frontmatter fields.
 * The semantics here are fixed and documented for contributors:
 *
 *  - ALL ld+json blocks are parsed in document order; each in its own try/catch,
 *    so a malformed block is skipped without affecting the others.
 *  - Candidates come from: array roots (their elements), object roots (the root
 *    itself), and `@graph` arrays (their entries, after the root).
 *  - A candidate matches a configured `@type` when its `@type` equals it exactly
 *    (case-sensitive) or is an array that includes it. First match wins.
 *  - Dot-paths descend into the first element whenever a step is an array; the
 *    final value must be a primitive (string/number/boolean) or is unresolved.
 *
 * Extraction never throws out of this module: failures resolve to null / undefined
 * so the recipe layer and main content extraction are never affected.
 */

import { loadHtml } from './parse-guard.js';

/** Load a cheerio instance from an HTML string, or pass through an existing one. */
function toCheerio(htmlOr$) {
  return typeof htmlOr$ === 'function' ? htmlOr$ : loadHtml(htmlOr$);
}

/** Recursively collect candidate nodes from a parsed JSON-LD value. */
function pushCandidates(value, out) {
  if (Array.isArray(value)) {
    for (const item of value) pushCandidates(item, out);
    return;
  }
  if (value && typeof value === 'object') {
    out.push(value);
    if (Array.isArray(value['@graph'])) {
      for (const item of value['@graph']) pushCandidates(item, out);
    }
  }
}

/**
 * Parse every ld+json block in the document and return candidate nodes in
 * document order. Malformed blocks are skipped.
 * @param {string|import('cheerio').CheerioAPI} htmlOr$
 * @returns {object[]}
 */
export function collectJsonLdCandidates(htmlOr$) {
  const $ = toCheerio(htmlOr$);
  const candidates = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    const raw = $(el).text();
    if (!raw || !raw.trim()) return;
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return; // skip broken block, keep going
    }
    pushCandidates(parsed, candidates);
  });
  return candidates;
}

/** True when a node's `@type` equals `type` (exact) or is an array including it. */
function typeMatches(node, type) {
  const t = node && node['@type'];
  if (t === type) return true;
  return Array.isArray(t) && t.includes(type);
}

/**
 * Select the first JSON-LD node whose `@type` matches `type`.
 * @param {string|import('cheerio').CheerioAPI} htmlOr$
 * @param {string} type  schema.org @type (exact, case-sensitive)
 * @returns {object|null}
 */
export function extractJsonLd(htmlOr$, type) {
  if (!type) return null;
  let candidates;
  try {
    candidates = collectJsonLdCandidates(htmlOr$);
  } catch {
    return null;
  }
  for (const c of candidates) {
    if (typeMatches(c, type)) return c;
  }
  return null;
}

/**
 * Resolve a dot-path against a JSON-LD node. Arrays encountered at any step
 * (or as the final value) collapse to their first element. The final value
 * must be a string, number, or boolean, otherwise the path is unresolved.
 * @param {*} node
 * @param {string} dotPath
 * @returns {string|number|boolean|undefined}
 */
export function resolvePath(node, dotPath) {
  if (node == null || !dotPath) return undefined;
  let cur = node;
  for (const part of dotPath.split('.')) {
    if (Array.isArray(cur)) cur = cur[0];
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = cur[part];
    if (cur === undefined) return undefined;
  }
  if (Array.isArray(cur)) cur = cur[0];
  const t = typeof cur;
  if (t === 'string' || t === 'number' || t === 'boolean') return cur;
  return undefined;
}

/**
 * Compute recipe-defined frontmatter field values from a document.
 *
 * Fields sourced via `jsonld` read from the node selected by `spec.jsonld.type`;
 * fields sourced via `selector` take the trimmed text of the first match.
 * Unresolved / empty values are silently omitted. Never throws.
 *
 * @param {string|import('cheerio').CheerioAPI} htmlOr$
 * @param {{ jsonld?: { type: string }, fields: Record<string, {jsonld?: string, selector?: string}> }} spec
 * @returns {Record<string, string|number|boolean>}
 */
export function extractRecipeFrontmatter(htmlOr$, spec) {
  const out = {};
  if (!spec || !spec.fields || Object.keys(spec.fields).length === 0) return out;

  let $;
  try {
    $ = toCheerio(htmlOr$);
  } catch {
    return out;
  }

  // The selected JSON-LD node is resolved lazily and cached across fields.
  let node;
  let nodeResolved = false;
  const jsonldNode = () => {
    if (!nodeResolved) {
      try { node = spec.jsonld ? extractJsonLd($, spec.jsonld.type) : null; }
      catch { node = null; }
      nodeResolved = true;
    }
    return node;
  };

  for (const [field, desc] of Object.entries(spec.fields)) {
    try {
      if (desc.jsonld !== undefined) {
        const n = jsonldNode();
        if (!n) continue;
        const value = resolvePath(n, desc.jsonld);
        if (value !== undefined) out[field] = value;
      } else if (desc.selector !== undefined) {
        const text = $(desc.selector).first().text().trim();
        if (text) out[field] = text;
      }
    } catch {
      // Never let one field's failure break the rest.
    }
  }
  return out;
}
