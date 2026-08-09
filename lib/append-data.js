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
