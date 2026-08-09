/**
 * Append blocks: pull structured data out of an embedded JSON <script> and
 * render it as a fenced JSON block at the end of the document.
 *
 * Site recipes increasingly face pages that render their numbers client-side
 * from an SSR state blob (Angular `ng-state`, Next.js `__NEXT_DATA__`) and
 * leave nothing addressable in the DOM but an SVG chart. `select.content`
 * cannot reach those values; this module addresses the DATA instead of its
 * presentation.
 *
 * Semantics are fixed and deliberate:
 *
 *  - Paths are ARRAYS OF SEGMENTS, not dot-paths. Real-world state blobs use
 *    keys like `p_city_local/forecast` and full API URLs containing dots,
 *    slashes, `?` and `=`. A segment array needs no escaping grammar.
 *  - A string segment indexes an object, an integer segment indexes an array.
 *    Arrays are NOT collapsed to their first element (unlike resolvePath in
 *    jsonld.js) because the array is usually the target.
 *  - An unresolved field omits its key rather than writing null.
 *  - Nothing in here ever throws out: every failure resolves to null/empty so
 *    the content pipeline is never affected.
 */

import * as cheerio from 'cheerio';

/**
 * Parse the first script element matching `selector` as JSON.
 * @param {import('cheerio').CheerioAPI} $
 * @param {string} selector
 * @returns {object|Array|null} null when absent, empty, or malformed
 */
export function parseJsonScript($, selector) {
  let raw;
  try {
    raw = $(selector).first().text();
  } catch {
    return null; // invalid selector must never break extraction
  }
  if (!raw || !raw.trim()) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Walk a segment array into a parsed value.
 * @param {*} value
 * @param {Array<string|number>} segments
 * @returns {*} undefined when any step fails to resolve
 */
export function resolveSegments(value, segments) {
  if (value == null || !Array.isArray(segments) || segments.length === 0) return undefined;
  let cur = value;
  for (const seg of segments) {
    if (cur == null || typeof cur !== 'object') return undefined;
    if (typeof seg === 'number') {
      if (!Array.isArray(cur)) return undefined;
      cur = cur[seg];
    } else {
      cur = cur[seg];
    }
    if (cur === undefined) return undefined;
  }
  return cur;
}

/**
 * Project a resolved value into output rows.
 *
 * With `fields`: a single object becomes a one-row list, non-object rows are
 * skipped, each row is projected and renamed in field order.
 * Without `fields`: the value passes through unchanged, arrays capped at limit.
 *
 * @param {*} value
 * @param {Record<string, Array<string|number>>} [fields]
 * @param {number} limit
 * @returns {*}
 */
export function projectRows(value, fields, limit) {
  if (value === undefined || value === null) return [];
  if (!fields) {
    return Array.isArray(value) ? value.slice(0, limit) : value;
  }
  const rows = Array.isArray(value) ? value : [value];
  const out = [];
  for (const row of rows) {
    if (out.length >= limit) break;
    if (row === null || typeof row !== 'object' || Array.isArray(row)) continue;
    const projected = {};
    for (const [name, segments] of Object.entries(fields)) {
      const v = resolveSegments(row, segments);
      if (v !== undefined) projected[name] = v;
    }
    out.push(projected);
  }
  return out;
}

/** Serialized-size caps. Deliberately NOT configurable: this is the only place
 *  where a recipe could grow the output without bound. */
const BLOCK_BYTE_CAP = 64 * 1024;
const DOC_BYTE_CAP = 128 * 1024;
const MIN_USEFUL_BUDGET = 1024;

/** Load a cheerio instance from an HTML string, or pass through an existing one. */
function toCheerio(htmlOr$) {
  return typeof htmlOr$ === 'function' ? htmlOr$ : cheerio.load(htmlOr$);
}

/**
 * Serialize rows as one JSON object per line inside a `[` / `]` envelope,
 * dropping rows from the end until the result fits `budget` bytes.
 *
 * Uses a binary search over the row count rather than a fixed-percentage
 * step: a coarse step can overshoot and leave the block well under its own
 * cap, which then starves later blocks of document budget they should
 * still have had. The search converges to the largest row count whose
 * serialized body still fits, so the block uses as much of its budget as
 * the row boundaries allow.
 *
 * @returns {{ body: string, kept: number, total: number }}
 */
function serializeRows(rows, budget) {
  const list = Array.isArray(rows) ? rows : [rows];
  const lines = list.map((r) => JSON.stringify(r));
  const total = lines.length;
  const bodyFor = (n) => `[\n${lines.slice(0, n).join(',\n')}\n]`;

  let kept = total;
  let body = bodyFor(kept);
  if (Buffer.byteLength(body, 'utf8') > budget) {
    let lo = 0; // largest row count confirmed to fit the budget
    let hi = total; // smallest row count confirmed NOT to fit
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (Buffer.byteLength(bodyFor(mid), 'utf8') <= budget) {
        lo = mid;
      } else {
        hi = mid - 1;
      }
    }
    kept = lo;
    body = bodyFor(kept);
  }
  return { body, kept, total };
}

/**
 * Render every append block of a recipe into markdown appended at document end.
 *
 * @param {string|import('cheerio').CheerioAPI} htmlOr$
 * @param {Array<object>} specs  validated append block specs
 * @returns {{ markdown: string, notes: string[] }} empty markdown when nothing resolved
 */
export function renderAppendBlocks(htmlOr$, specs) {
  const empty = { markdown: '', notes: [] };
  if (!Array.isArray(specs) || specs.length === 0) return empty;

  let $;
  try {
    $ = toCheerio(htmlOr$);
  } catch {
    return empty;
  }

  const parsedByScript = new Map();
  const parts = [];
  const notes = [];
  let spent = 0;

  for (const spec of specs) {
    try {
      if (!parsedByScript.has(spec.script)) {
        parsedByScript.set(spec.script, parseJsonScript($, spec.script));
      }
      const blob = parsedByScript.get(spec.script);
      if (blob == null) {
        console.warn(`[append] "${spec.title}": script ${spec.script} missing or not JSON`);
        continue;
      }

      const resolved = resolveSegments(blob, spec.path);
      if (resolved === undefined) {
        console.warn(`[append] "${spec.title}": path did not resolve`);
        continue;
      }

      const rows = projectRows(resolved, spec.fields, spec.limit);
      const count = Array.isArray(rows) ? rows.length : 1;
      if (count === 0) {
        console.warn(`[append] "${spec.title}": resolved to zero rows`);
        continue;
      }

      const budget = Math.min(BLOCK_BYTE_CAP, DOC_BYTE_CAP - spent);
      if (budget < MIN_USEFUL_BUDGET) {
        notes.push(`${spec.title} (übersprungen, Budget erschöpft)`);
        console.warn(`[append] "${spec.title}": document byte budget exhausted`);
        continue;
      }

      const { body, kept, total } = serializeRows(rows, budget);
      if (kept === 0) {
        notes.push(`${spec.title} (übersprungen, Budget erschöpft)`);
        continue;
      }

      const truncNote = kept < total ? `\n\nGekürzt: ${kept} von ${total} Zeilen ausgegeben.` : '';
      const block = `\n\n## ${spec.title}\n\n\`\`\`json\n${body}\n\`\`\`${truncNote}`;
      parts.push(block);
      spent += Buffer.byteLength(block, 'utf8');
      notes.push(kept < total ? `${spec.title} (${kept} von ${total} Zeilen)` : `${spec.title} (${kept} Zeilen)`);
    } catch (err) {
      // One bad block must never take down the others or the extraction.
      console.warn(`[append] "${spec?.title}" failed: ${err?.message ?? err}`);
    }
  }

  return { markdown: parts.join(''), notes };
}
