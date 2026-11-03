// Decode an uploaded text file: UTF-8 (BOM-aware, also UTF-16 by BOM), and
// Windows-1252 when the bytes are not valid UTF-8 (old Windows editors,
// many .srt files).
export function decodeTextFile(buffer) {
  const buf = Buffer.from(buffer);
  if (buf[0] === 0xff && buf[1] === 0xfe) return new TextDecoder('utf-16le').decode(buf.subarray(2));
  if (buf[0] === 0xfe && buf[1] === 0xff) return new TextDecoder('utf-16be').decode(buf.subarray(2));
  const body = (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) ? buf.subarray(3) : buf;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(body);
  } catch {
    return new TextDecoder('windows-1252').decode(body);
  }
}

/** "My Notes.final.md" -> "My Notes.final" */
export function filenameStem(filename) {
  const base = String(filename || '').split(/[\\/]/).pop();
  return base.replace(/\.[^.]+$/, '') || base;
}

/** Reject binary junk posing as text (NUL bytes survive any decoding). */
export function looksBinary(text) {
  return text.slice(0, 8192).includes('\u0000');
}

// Whitespace helpers. Regexes anchored at the end (/\s+$/, /[ \t]+\n/,
// /^(\s*)(.*?)(\s*)$/) backtrack quadratically in V8 when a long run of
// whitespace is followed by something else; uploads are untrusted, so the
// readers use these index scans instead.

/** s without trailing characters from `chars` (like s.replace(/[chars]+$/, '')). */
export function trimEndChars(s, chars) {
  const str = String(s ?? '');
  let end = str.length;
  while (end > 0 && chars.includes(str[end - 1])) end--;
  return end === str.length ? str : str.slice(0, end);
}

const isJsWhitespace = (c) => c.trim() === '';

/**
 * Split into [leading whitespace, core, trailing whitespace]; an all-blank
 * string is [s, '', ''] (as /^(\s*)([\s\S]*?)(\s*)$/ would split it).
 * @param {(c: string) => boolean} [isWs]  whitespace test (default: \s)
 */
export function splitOuterWs(s, isWs = isJsWhitespace) {
  const str = String(s ?? '');
  let start = 0;
  while (start < str.length && isWs(str[start])) start++;
  if (start === str.length) return [str, '', ''];
  let end = str.length;
  while (end > start && isWs(str[end - 1])) end--;
  return [str.slice(0, start), str.slice(start, end), str.slice(end)];
}

/** Drop spaces and tabs at the end of every line but the last (like s.replace(/[ \t]+\n/g, '\n')). */
export function trimLineEnds(s) {
  const lines = String(s ?? '').split('\n');
  for (let k = 0; k < lines.length - 1; k++) lines[k] = trimEndChars(lines[k], ' \t');
  return lines.join('\n');
}

/**
 * First ATX heading line ("# Title ##") in Markdown text, or null.
 * @returns {{index: number, text: string}|null}  text trimmed, closing #s removed
 */
export function firstAtxHeading(text) {
  const m = /^#[ \t]+(.+)$/m.exec(String(text ?? ''));
  if (!m) return null;
  const inner = trimEndChars(m[1], ' \t#') || m[1][0];
  return { index: m.index, text: inner.trim() };
}

/**
 * Remove <name ...>...</name> elements (case-insensitive) in linear time.
 * An element without a closing tag is left as it is, as the lazy regex
 * /<(name)\b[\s\S]*?<\/\1>/gi (quadratic on unclosed tags) left it.
 */
export function removeElements(html, names) {
  const str = String(html ?? '');
  const open = new RegExp(`<(${names.join('|')})\\b`, 'gi');
  let out = '';
  let pos = 0;
  // A name whose closing tag is missing once has none further on either:
  // each name's closing tag is searched to the end at most once.
  const unclosed = new Set();
  for (let m = open.exec(str); m; m = open.exec(str)) {
    const name = m[1].toLowerCase();
    if (unclosed.has(name)) continue;
    const close = new RegExp(`</${name}>`, 'gi');
    close.lastIndex = open.lastIndex;
    if (!close.exec(str)) { unclosed.add(name); continue; }
    out += str.slice(pos, m.index);
    pos = close.lastIndex;
    open.lastIndex = pos;
  }
  return pos === 0 ? str : out + str.slice(pos);
}
