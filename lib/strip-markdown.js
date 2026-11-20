/**
 * Markdown → plain text for `format=text` responses.
 *
 * Backslash escapes (`\[`, `\_`, `\*`, …) come from both extractors:
 * node-html-markdown on the Readability path, and Trafilatura since 2.3
 * (issue #60). In plain text they are noise, so they resolve to the bare
 * character. They are parked as private-use code points first, so the
 * emphasis and link patterns below cannot mistake an escaped `\*` or `\[`
 * for markup. Code spans and fenced blocks keep their backslashes:
 * CommonMark does not apply escapes there.
 */

// Any ASCII punctuation character may be backslash-escaped (CommonMark 2.4).
const ESCAPE = /\\([!-\/:-@\[-`{-~])/g;
const CODE = /((?<!\\)```[\s\S]*?```|(?<!\\)`[^`\n]*`)/;
const PARK_BASE = 0xE000;
const PARKED = /[-]/g;

function parkEscapes(md) {
  return md
    .split(CODE)
    .map((part, i) => (i % 2 ? part : part.replace(ESCAPE, (_, ch) => String.fromCharCode(PARK_BASE + ch.charCodeAt(0)))))
    .join('');
}

function unparkEscapes(text) {
  return text.replace(PARKED, (ch) => String.fromCharCode(ch.charCodeAt(0) - PARK_BASE));
}

// `.` in the old link patterns stopped at these, so a link never spans lines.
const LINE_END = /[\n\r\u2028\u2029]/g;

/**
 * Links and images, in one left-to-right scan per pass.
 *
 * Same result as the regex pair
 *   images: /!\[.*?\]\((.+?)\)/g       -> '$1'
 *   links:  /\[(.+?)\]\((.+?)\)/g      -> '$1 ($2)'
 * (images first, then links on the result), without their backtracking:
 * on text such as a long run of `[a](` the regexes retried every opener
 * against every later `](` and took minutes on a few kilobytes.
 *
 * For an opener at i (`![` or `[`), the lazy regex settles on the first
 * `](` at j >= i + 2 on the same line, and on the first `)` at k >= j + 3 on
 * the same line (the URL group takes at least one character). If that `)`
 * is missing, no later `](` can do better, so the opener fails, and so does
 * every later opener on that line. Both searches only move forward, so the
 * whole pass is linear.
 */
function replaceLinks(s, images) {
  const opener = images ? '![' : '[';
  let out = '';
  let last = 0;
  let lineEnd = -1;   // first line terminator at or after the current opener
  let j = -1;         // cached first `](` at or after the last searched start
  let k = -1;         // cached first `)` at or after the last searched start
  let i = s.indexOf(opener);
  while (i !== -1) {
    if (i > lineEnd) {
      LINE_END.lastIndex = i;
      lineEnd = LINE_END.exec(s) ? LINE_END.lastIndex - 1 : s.length;
    }
    if (j < i + 2) j = s.indexOf('](', i + 2);
    if (j === -1) break;
    let next;
    if (j >= lineEnd) {
      next = lineEnd + 1;
    } else {
      if (k < j + 3) k = s.indexOf(')', j + 3);
      if (k === -1) break;
      if (k >= lineEnd) {
        next = lineEnd + 1;
      } else {
        const url = s.slice(j + 2, k);
        out += s.slice(last, i) + (images ? url : `${s.slice(i + 1, j)} (${url})`);
        last = next = k + 1;
      }
    }
    i = s.indexOf(opener, next);
  }
  return last === 0 ? s : out + s.slice(last);
}

export function stripMarkdown(md) {
  const emphasisFree = parkEscapes(md)
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/\*(.+?)\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/_(.+?)_/g, '$1')
    .replace(/~~(.+?)~~/g, '$1');
  return unparkEscapes(replaceLinks(replaceLinks(emphasisFree, true), false)
    .replace(/^>\s?/gm, '')
    .replace(/^[-*+]\s+/gm, '- ')
    .replace(/^---+$/gm, '---')
    .trim());
}
