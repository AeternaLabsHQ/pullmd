// Content-line parser shared by iCalendar (RFC 5545) and vCard (RFC 6350,
// plus the vCard 2.1 quirks still written by phones and Outlook):
// unfolding, NAME;PARAM=VAL:value splitting, text unescaping,
// QUOTED-PRINTABLE + CHARSET, and the BEGIN/END component tree.
import { decodeTextFile } from './text-decode.js';

/**
 * Unfold at byte level so a fold inside a multi-byte UTF-8 sequence rejoins
 * before decoding (RFC 5545 folds at 75 octets, not characters).
 */
function unfoldAndDecode(buffer) {
  const buf = Buffer.from(buffer);
  const utf16 = (buf[0] === 0xff && buf[1] === 0xfe) || (buf[0] === 0xfe && buf[1] === 0xff);
  if (utf16) return decodeTextFile(buf).replace(/\r?\n[ \t]/g, '');
  const unfolded = buf.toString('latin1').replace(/\r?\n[ \t]/g, '');
  return decodeTextFile(Buffer.from(unfolded, 'latin1'));
}

/** Index of the first unquoted colon (the name/value separator), or -1. */
function headEnd(line) {
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') quoted = !quoted;
    else if (c === ':' && !quoted) return i;
  }
  return -1;
}

/** Split on a separator outside double quotes. */
function splitUnquoted(s, sep) {
  const out = [];
  let quoted = false;
  let cur = '';
  for (const c of s) {
    if (c === '"') { quoted = !quoted; cur += c; continue; }
    if (c === sep && !quoted) { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  out.push(cur);
  return out;
}

function stripQuotes(v) {
  return v.length >= 2 && v.startsWith('"') && v.endsWith('"') ? v.slice(1, -1) : v;
}

function isQuotedPrintableHead(head) {
  return /;(?:ENCODING=)?QUOTED-PRINTABLE(?=;|$)/i.test(head);
}

function parseParams(parts) {
  const params = {};
  for (const part of parts) {
    if (!part) continue;
    const eq = part.indexOf('=');
    let name;
    let values;
    if (eq === -1) {
      // vCard 2.1 bare parameters: TEL;HOME;VOICE: / NOTE;QUOTED-PRINTABLE:
      const bare = part.trim().toUpperCase();
      if (bare === 'QUOTED-PRINTABLE' || bare === 'BASE64' || bare === '8BIT' || bare === '7BIT') {
        name = 'ENCODING';
      } else {
        name = 'TYPE';
      }
      values = [part.trim()];
    } else {
      name = part.slice(0, eq).trim().toUpperCase();
      values = splitUnquoted(part.slice(eq + 1), ',').map((v) => stripQuotes(v.trim()));
    }
    const list = (params[name] ||= []);
    for (const v of values) list.push(v);
  }
  return params;
}

function decodeQuotedPrintable(value, charset) {
  const bytes = [];
  const s = value.replace(/=\r?\n/g, '');
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '=' && /^[0-9A-Fa-f]{2}$/.test(s.slice(i + 1, i + 3))) {
      bytes.push(parseInt(s.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      // Literal characters (already decoded text) keep their UTF-8 bytes.
      const ch = String.fromCodePoint(s.codePointAt(i));
      bytes.push(...Buffer.from(ch, 'utf8'));
      i += ch.length - 1;
    }
  }
  const buf = Buffer.from(bytes);
  const label = (charset || 'utf-8').toLowerCase();
  try {
    return new TextDecoder(label, { fatal: true }).decode(buf);
  } catch {
    try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch { /* fall through */ }
    return new TextDecoder('windows-1252').decode(buf);
  }
}

/** RFC 5545 / 6350 text unescaping: \n \N \, \; \\ (and the stray \: some writers emit). */
export function unescapeText(s) {
  return String(s ?? '').replace(/\\([nN,;:\\])/g, (_, c) => (c === 'n' || c === 'N' ? '\n' : c));
}

/** Split a structured value (N, ADR, ORG) on unescaped separators, then unescape each part. */
export function splitStructured(raw, sep = ';') {
  const out = [];
  let cur = '';
  const s = String(raw ?? '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\' && i + 1 < s.length) { cur += c + s[i + 1]; i++; continue; }
    if (c === sep) { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  out.push(cur);
  return out.map(unescapeText);
}

/**
 * Parse one logical content line.
 * @returns {{name:string, group:string|null, params:object, raw:string, value:string}|null}
 */
export function parseContentLine(line) {
  const idx = headEnd(line);
  if (idx <= 0) return null;
  const head = line.slice(0, idx);
  let raw = line.slice(idx + 1);
  const [nameWithGroup, ...paramParts] = splitUnquoted(head, ';');
  const dot = nameWithGroup.lastIndexOf('.');
  const group = dot === -1 ? null : nameWithGroup.slice(0, dot);
  const name = nameWithGroup.slice(dot + 1).trim().toUpperCase();
  if (!/^[A-Z0-9-]+$/.test(name)) return null;
  const params = parseParams(paramParts);
  const encoding = (params.ENCODING?.[0] || '').toUpperCase();
  if (encoding === 'QUOTED-PRINTABLE') {
    raw = decodeQuotedPrintable(raw, params.CHARSET?.[0]);
  }
  return { name, group, params, raw, value: unescapeText(raw) };
}

const MAX_DEPTH = 64;

/**
 * Parse an iCalendar / vCard file into a component tree.
 * @param {Buffer|Uint8Array|string} input
 * @returns {{name:string, props:Array, children:Array}}  root (name 'ROOT')
 */
export function parseVFormat(input) {
  const text = typeof input === 'string' ? input.replace(/\r?\n[ \t]/g, '') : unfoldAndDecode(input);
  const physical = text.split(/\r\n|\n|\r/);

  // vCard 2.1 quoted-printable: a trailing "=" is a soft line break and the
  // continuation line carries no leading whitespace.
  const lines = [];
  for (let i = 0; i < physical.length; i++) {
    let line = physical[i];
    const idx = headEnd(line);
    if (idx > 0 && isQuotedPrintableHead(line.slice(0, idx)) && line.endsWith('=')) {
      // Collect the pieces and join once (appending to the growing line is
      // quadratic with many soft breaks).
      const parts = [];
      while (line.endsWith('=') && i + 1 < physical.length) {
        parts.push(line.slice(0, -1));
        line = physical[++i];
      }
      parts.push(line);
      line = parts.join('');
    }
    lines.push(line);
  }

  const root = { name: 'ROOT', props: [], children: [] };
  const stack = [root];
  const names = ['ROOT']; // stack[k].name, for the END lookup
  for (const line of lines) {
    if (!line.trim()) continue;
    const prop = parseContentLine(line);
    if (!prop) continue;
    const top = stack[stack.length - 1];
    if (prop.name === 'BEGIN') {
      // Real files nest three or four levels deep. Deeper BEGINs are
      // ignored (their properties land in the enclosing component), which
      // keeps the END lookup and the tree walks bounded.
      if (stack.length > MAX_DEPTH) continue;
      const comp = { name: prop.value.trim().toUpperCase(), props: [], children: [] };
      top.children.push(comp);
      stack.push(comp);
      names.push(comp.name);
    } else if (prop.name === 'END') {
      const name = prop.value.trim().toUpperCase();
      // Pop to the matching BEGIN; ignore stray ENDs.
      const at = names.lastIndexOf(name);
      if (at > 0) { stack.length = at; names.length = at; }
    } else {
      top.props.push(prop);
    }
  }
  return root;
}

/** Depth-first list of components with one of the given names. */
export function findComponents(node, names) {
  const wanted = new Set(names);
  const out = [];
  const walk = (n) => {
    for (const c of n.children) {
      if (wanted.has(c.name)) out.push(c);
      walk(c);
    }
  };
  walk(node);
  return out;
}

export function getProp(comp, name) {
  return comp.props.find((p) => p.name === name) || null;
}

export function getProps(comp, name) {
  return comp.props.filter((p) => p.name === name);
}

/** First value of a parameter, or undefined. */
export function param(prop, name) {
  return prop?.params?.[name]?.[0];
}
