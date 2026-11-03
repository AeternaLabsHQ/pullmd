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
