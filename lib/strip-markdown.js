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

export function stripMarkdown(md) {
  return unparkEscapes(parkEscapes(md)
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/\*(.+?)\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/_(.+?)_/g, '$1')
    .replace(/~~(.+?)~~/g, '$1')
    .replace(/!\[.*?\]\((.+?)\)/g, '$1')
    .replace(/\[(.+?)\]\((.+?)\)/g, '$1 ($2)')
    .replace(/^>\s?/gm, '')
    .replace(/^[-*+]\s+/gm, '- ')
    .replace(/^---+$/gm, '---')
    .trim());
}
