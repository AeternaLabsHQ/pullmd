// RTF (.rtf) to Markdown, in-process, no dependencies. Two readers share one
// tokenizer/interpreter:
//
// - rtfToHtmlIfEncapsulated(): RTF written from HTML (\fromhtml1 - Outlook's
//   compressed RTF bodies, some mail exports) is de-encapsulated to the
//   original HTML per [MS-OXRTFEX] section 2.2.3.2.
// - rtfToMarkdown(): regular RTF (Word, LibreOffice, WordPad, TextEdit) is
//   interpreted directly: paragraphs, headings (by style outline level),
//   bold/italic, hyperlinks, lists, tables.
//
// Group nesting is tracked with an explicit stack (bounded), so crafted input
// cannot exhaust the call stack. Strings passed in are "binary strings" (one
// char per byte, e.g. buffer.toString('latin1')); bytes are decoded with the
// document / font code page. Characters above U+00FF (an already-decoded
// string) are taken as they are.
import { unprocessable } from './mail-render.js';
import { filenameStem, splitOuterWs, trimEndChars } from './text-decode.js';

const MIN_HTML_CONTENT_CHARS = 200;
const MAX_DEPTH = 256;

export function isRtfFile(contentType, filename) {
  if (/\.rtf$/i.test(filename || '')) return true;
  if (/\.[^./\\]+$/.test(filename || '')) return false;
  return /^(application\/rtf|application\/x-rtf|text\/rtf|text\/richtext)\b/i.test(contentType || '');
}

// ---------------------------------------------------------------- code pages

/** Windows code page -> WHATWG encoding label (Node's TextDecoder, full ICU). */
function encodingForCodepage(cp) {
  if (!cp || cp === 65001) return 'utf-8';
  if (cp >= 1250 && cp <= 1258) return `windows-${cp}`;
  if (cp >= 28591 && cp <= 28605) return `iso-8859-${cp - 28590}`;
  return {
    20127: 'us-ascii', 932: 'shift_jis', 936: 'gbk', 949: 'euc-kr', 950: 'big5',
    50220: 'iso-2022-jp', 51932: 'euc-jp', 54936: 'gb18030', 20866: 'koi8-r', 21866: 'koi8-u',
    874: 'windows-874', 866: 'ibm866', 10000: 'macintosh', 10007: 'x-mac-cyrillic',
    // No WHATWG decoder for the DOS code pages; Windows-1252 is the closest.
    437: 'windows-1252', 850: 'windows-1252',
  }[cp] || 'windows-1252';
}

// \fcharsetN -> code page (RTF spec, font table).
const CHARSET_CP = {
  0: 1252, 2: 1252, 77: 10000, 128: 932, 129: 949, 134: 936, 136: 950,
  161: 1253, 162: 1254, 163: 1258, 177: 1255, 178: 1256, 186: 1257,
  204: 1251, 222: 874, 238: 1250, 254: 437, 255: 437,
};

const decoders = new Map();
function decodeBytes(bytes, cp) {
  const label = encodingForCodepage(cp);
  let dec = decoders.get(label);
  if (!dec) {
    try { dec = new TextDecoder(label); } catch { dec = new TextDecoder('windows-1252'); }
    decoders.set(label, dec);
  }
  return dec.decode(Uint8Array.from(bytes));
}

// ---------------------------------------------------------------- tokenizer

const isLetter = (c) => (c >= 97 && c <= 122) || (c >= 65 && c <= 90);
const isDigit = (c) => c >= 48 && c <= 57;
const HEX = /^[0-9a-fA-F]{2}$/;

class Lexer {
  constructor(s) {
    this.s = s;
    this.i = 0;
  }

  /** Next token: open, close, word {name, param}, hex {byte}, star, sym {ch}, text {text}; null at end. */
  next() {
    const s = this.s;
    for (;;) {
      if (this.i >= s.length) return null;
      const c = s.charCodeAt(this.i);
      if (c === 0x7b) { this.i++; return { type: 'open' }; }
      if (c === 0x7d) { this.i++; return { type: 'close' }; }
      if (c === 0x0d || c === 0x0a) { this.i++; continue; }
      if (c === 0x5c) return this.control();
      let j = this.i;
      while (j < s.length) {
        const d = s.charCodeAt(j);
        if (d === 0x7b || d === 0x7d || d === 0x5c || d === 0x0d || d === 0x0a) break;
        j++;
      }
      const text = s.slice(this.i, j);
      this.i = j;
      return { type: 'text', text };
    }
  }

  control() {
    const s = this.s;
    this.i++; // backslash
    if (this.i >= s.length) return null;
    const c = s.charCodeAt(this.i);
    if (isLetter(c)) {
      let j = this.i;
      while (j < s.length && j - this.i < 32 && isLetter(s.charCodeAt(j))) j++;
      const name = s.slice(this.i, j);
      let param = null;
      let k = j;
      if (s[k] === '-' && isDigit(s.charCodeAt(k + 1))) k++;
      while (k < s.length && k - j < 11 && isDigit(s.charCodeAt(k))) k++;
      if (k > j) {
        param = Math.max(-2147483648, Math.min(2147483647, parseInt(s.slice(j, k), 10)));
      }
      if (s[k] === ' ') k++;
      this.i = k;
      if (name === 'bin' && param > 0) this.i = Math.min(s.length, this.i + param);
      return { type: 'word', name, param };
    }
    this.i++;
    const ch = s[this.i - 1];
    if (ch === "'") {
      const hh = s.slice(this.i, this.i + 2);
      if (HEX.test(hh)) {
        this.i += 2;
        return { type: 'hex', byte: parseInt(hh, 16) };
      }
      return { type: 'sym', ch: "'" };
    }
    if (ch === '*') return { type: 'star' };
    if (ch === '{' || ch === '}' || ch === '\\') return { type: 'text', text: ch };
    if (ch === '\r' || ch === '\n') return { type: 'word', name: 'par', param: null };
    return { type: 'sym', ch };
  }

  /** Skip to the end of the current group (the matching close brace is consumed). */
  skipGroup() {
    const s = this.s;
    let depth = 1;
    while (this.i < s.length) {
      const c = s.charCodeAt(this.i);
      if (c === 0x5c) {
        const n = s.charCodeAt(this.i + 1);
        if (isLetter(n)) {
          // \binN carries raw bytes that may contain braces.
          const m = /^bin(-?\d{1,10}) ?/.exec(s.slice(this.i + 1, this.i + 17));
          if (m) {
            this.i += 1 + m[0].length + Math.max(0, parseInt(m[1], 10));
            continue;
          }
        }
        this.i += 2;
        continue;
      }
      this.i++;
      if (c === 0x7b) depth++;
      else if (c === 0x7d && --depth === 0) return;
    }
  }
}

// Control words that stand for one character (both readers).
const CHAR_WORDS = {
  lquote: '\u2018', rquote: '\u2019', ldblquote: '\u201c', rdblquote: '\u201d',
  bullet: '\u2022', endash: '\u2013', emdash: '\u2014',
  enspace: '\u2002', emspace: '\u2003', qmspace: '\u2005',
};

// Destinations that never carry visible document text.
const SKIP_DESTS = new Set([
  'colortbl', 'stylesheet', 'listtable', 'listoverridetable', 'info', 'pict', 'object',
  'header', 'headerl', 'headerr', 'headerf', 'footer', 'footerl', 'footerr', 'footerf',
  'footnote', 'annotation', 'atnid', 'atnauthor', 'atndate', 'atnref', 'themedata',
  'colorschememapping', 'datastore', 'latentstyles', 'rsidtbl', 'revtbl', 'filetbl',
  'xmlnstbl', 'generator', 'mmathPr', 'pgdsctbl', 'userprops', 'template', 'docvar',
  'nonshppict', 'shp', 'shpinst', 'shppict', 'do', 'xe', 'tc', 'txe', 'pn', 'pntxta',
  'pntxtb', 'listpicture', 'fchars', 'lchars', 'pgptbl', 'protusertbl', 'wgrffmtfilter',
  'ftnsep', 'ftnsepc', 'ftncn', 'aftnsep', 'aftnsepc', 'aftncn', 'bkmkstart', 'bkmkend',
  'fontemb', 'fontfile', 'falt', 'panose', 'company', 'operator',
]);

/**
 * Shared interpreter: group stack, \uc skipping, font table, code pages,
 * \'hh byte runs. The handler gets decoded text and the remaining control
 * words.
 *
 * handler.dest(name, state, star) -> 'skip' | true (handled) | false (not a destination)
 * handler.word(name, param, state)
 * handler.text(str, state)
 * handler.sym(ch, state)
 * handler.groupStart(state, parent) / handler.groupEnd(closed, parent)
 * handler.codepage(state) -> code page for \'hh / 8-bit text in this state
 */
function interpret(input, handler) {
  const lex = new Lexer(input);
  const doc = { cp: 1252, deff: null, fonts: new Map() };
  let state = { uc: 1, font: null, dest: 'body', fontDef: null };
  const stack = [];
  let skip = 0;            // \uc fallback characters still to drop
  let groupStart = false;  // directly after '{'
  let star = false;        // '\*' seen at the start of this group

  let bytes = [];
  let bytesCp = null;
  const flush = () => {
    if (!bytes.length) return;
    const text = decodeBytes(bytes, bytesCp);
    bytes = [];
    handler.text(text, state);
  };
  const cpOf = (st) => {
    const viaHandler = handler.codepage ? handler.codepage(st, doc) : undefined;
    if (viaHandler) return viaHandler;
    const f = st.font ?? doc.deff;
    return (f != null && doc.fonts.get(f)?.cp) || doc.cp;
  };
  const addByte = (b) => {
    const cp = cpOf(state);
    if (bytes.length && cp !== bytesCp) flush();
    bytesCp = cp;
    bytes.push(b);
  };
  const addText = (text) => {
    for (let k = 0; k < text.length; k++) {
      const code = text.charCodeAt(k);
      if (code <= 0xff) {
        addByte(code);
      } else {
        // Already-decoded input: pass the run through as it is.
        let e = k;
        while (e < text.length && text.charCodeAt(e) > 0xff) e++;
        flush();
        handler.text(text.slice(k, e), state);
        k = e - 1;
      }
    }
  };

  const endGroup = () => {
    const closed = state;
    state = stack.pop() || state;
    handler.groupEnd?.(closed, state);
  };

  for (let tok = lex.next(); tok; tok = lex.next()) {
    if (tok.type === 'hex' || tok.type === 'text') {
      // fall through below
    } else {
      flush();
    }
    if (skip > 0) {
      if (tok.type === 'open' || tok.type === 'close') {
        skip = 0;
      } else if (tok.type === 'text') {
        if (tok.text.length <= skip) { skip -= tok.text.length; continue; }
        tok = { type: 'text', text: tok.text.slice(skip) };
        skip = 0;
      } else {
        skip--;
        continue;
      }
    }

    switch (tok.type) {
      case 'open': {
        if (stack.length >= MAX_DEPTH) {
          // Deeper groups are dropped whole (no real document nests this far).
          lex.skipGroup();
          groupStart = false;
          star = false;
          continue;
        }
        const parent = state;
        stack.push(parent);
        state = { ...parent, fontDef: null };
        handler.groupStart?.(state, parent);
        groupStart = true;
        star = false;
        continue;
      }
      case 'close':
        endGroup();
        break;
      case 'star':
        if (groupStart) { star = true; continue; }
        break;
      case 'hex':
        if (state.dest !== 'skip') addByte(tok.byte);
        break;
      case 'text':
        if (state.dest === 'fonttbl') {
          // "Font Name;" - nothing to keep beyond the code page.
        } else if (state.dest !== 'skip') {
          addText(tok.text);
        }
        break;
      case 'sym':
        if (state.dest !== 'skip' && state.dest !== 'fonttbl') handler.sym(tok.ch, state);
        break;
      case 'word': {
        const { name, param } = tok;
        // Destinations first: they decide what the rest of the group is.
        if (name === 'fonttbl') {
          state.dest = 'fonttbl';
          break;
        }
        const d = handler.dest(name, state, star);
        if (d === 'skip') {
          lex.skipGroup();
          endGroup();
          break;
        }
        if (d) break;
        if (star && groupStart) {
          // Unknown ignorable destination.
          lex.skipGroup();
          endGroup();
          break;
        }
        if (state.dest === 'fonttbl') {
          if (name === 'f' && param != null) {
            state.fontDef = { cp: null };
            doc.fonts.set(param, state.fontDef);
          } else if (name === 'fcharset' && state.fontDef && param != null) {
            if (state.fontDef.cp == null && param !== 1) state.fontDef.cp = CHARSET_CP[param] ?? null;
          } else if (name === 'cpg' && state.fontDef && param > 0) {
            state.fontDef.cp = param;
          }
          break;
        }
        switch (name) {
          case 'ansicpg': if (param > 0) doc.cp = param; break;
          case 'ansi': break;
          case 'mac': doc.cp = 10000; break;
          case 'pc': doc.cp = 437; break;
          case 'pca': doc.cp = 850; break;
          case 'deff': doc.deff = param; break;
          case 'f': state.font = param; break;
          case 'uc': state.uc = Math.max(0, Math.min(param ?? 1, 16)); break;
          case 'u':
            if (param != null && state.dest !== 'skip') {
              handler.text(String.fromCharCode(param < 0 ? param + 65536 : param & 0xffff), state);
            }
            skip = state.uc;
            break;
          default:
            if (CHAR_WORDS[name] && state.dest !== 'skip') handler.text(CHAR_WORDS[name], state);
            else handler.word(name, param, state);
        }
        break;
      }
      default:
        break;
    }
    groupStart = false;
    star = false;
  }
  flush();
  return doc;
}

function startsAsRtf(s) {
  return /^\s*\{\\rtf/.test(s);
}

// ---------------------------------------------------------------- HTML de-encapsulation

/** [MS-OXRTFEX] 2.2.3.1: \fromhtml1 among the first 10 tokens, which are all '{' or control words. */
function isHtmlEncapsulated(s) {
  if (!/^\{\\rtf1?/.test(s)) return false;
  const lex = new Lexer(s);
  for (let n = 0; n < 10; n++) {
    const tok = lex.next();
    if (!tok) return false;
    if (tok.type !== 'open' && tok.type !== 'word') return false;
    if (tok.type === 'word' && tok.name === 'fromhtml') return tok.param === 1;
    if (tok.type === 'word' && tok.name === 'fromtext') return false;
  }
  return false;
}

/**
 * De-encapsulate the original HTML from RTF marked \fromhtml1
 * ([MS-OXRTFEX] 2.2.3.2). Returns null for RTF that does not carry HTML.
 * @param {string} rtf  binary string (one char per byte)
 */
export function rtfToHtmlIfEncapsulated(rtf) {
  let s = String(rtf || '');
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
  if (s.startsWith('\u00ef\u00bb\u00bf')) s = s.slice(3);
  s = s.replace(/^\s+/, '');
  if (!isHtmlEncapsulated(s)) return null;

  const out = [];
  interpret(s, {
    codepage(st, doc) {
      // HTMLTAG content uses the document code page, other text the font's.
      return st.dest === 'htmltag' ? doc.cp : undefined;
    },
    dest(name, st, star) {
      if (star) {
        if (name === 'htmltag') { st.dest = 'htmltag'; return true; }
        return 'skip'; // \mhtmltag and every other ignorable destination
      }
      if (st.dest === 'htmltag') return false;
      if (SKIP_DESTS.has(name)) return 'skip';
      return false;
    },
    word(name, param, st) {
      if (st.dest === 'htmltag') {
        if (name === 'par') out.push('\r\n');
        else if (name === 'tab') out.push('\t');
        return; // anything else inside CONTENT is ignored
      }
      if (name === 'htmlrtf') { st.htmlrtf = param !== 0; return; }
      if (st.htmlrtf) return;
      if (name === 'par' || name === 'line') out.push('\r\n');
      else if (name === 'tab') out.push('\t');
    },
    text(str, st) {
      if (st.dest === 'htmltag' || (st.dest === 'body' && !st.htmlrtf)) out.push(str);
    },
    sym(ch, st) {
      if (st.dest !== 'htmltag' && (st.dest !== 'body' || st.htmlrtf)) return;
      if (ch === '~') out.push('\u00a0');
      else if (ch === '_') out.push(st.dest === 'htmltag' ? '\u00ad' : '-');
    },
  });
  return out.join('');
}

// ---------------------------------------------------------------- RTF to Markdown

const escapeInline = (t) => t.replace(/[\\*_`[\]]/g, '\\$&');

// Indentation without line breaks: /^(\s*)/m would let one match run across
// blank lines and rescan them from every line start (quadratic).
function escapeLineStarts(md) {
  return md
    .replace(/^([^\S\r\n\u2028\u2029]*)(#{1,6}|[>+-])(?=\s|$)/gm, '$1\\$2')
    .replace(/^([^\S\r\n\u2028\u2029]*)(\d{1,9})([.)])(?=\s|$)/gm, '$1$2\\$3');
}

/**
 * Hard breaks and indentation inside a paragraph: trailing spaces/tabs go,
 * except that two or more before a newline become a Markdown hard break
 * ("  "); leading spaces/tabs on continuation lines go.
 */
function tidyParagraphLines(md) {
  const lines = md.split('\n');
  for (let k = 0; k < lines.length; k++) {
    let line = lines[k];
    if (k > 0) {
      let start = 0;
      while (start < line.length && (line[start] === ' ' || line[start] === '\t')) start++;
      line = line.slice(start);
    }
    const core = trimEndChars(line, ' \t');
    lines[k] = core + (k < lines.length - 1 && line.length - core.length >= 2 ? '  ' : '');
  }
  return lines.join('\n');
}

/**
 * Inline runs -> Markdown with ** / * nested correctly and never wrapped
 * around whitespace only.
 */
function composeInline(runs, { emphasis = true, br = '  \n' } = {}) {
  const segs = [];
  const add = (md, b, i) => {
    const last = segs[segs.length - 1];
    if (last && last.b === b && last.i === i) last.md += md;
    else segs.push({ md, b, i });
  };
  for (let k = 0; k < runs.length; k++) {
    const r = runs[k];
    if (r.br) { add(br, false, false); continue; }
    if (r.link) {
      const group = [];
      while (k < runs.length && runs[k].link === r.link) group.push(runs[k++]);
      k--;
      const allB = emphasis && group.every((g) => g.br || g.b);
      const allI = emphasis && group.every((g) => g.br || g.i);
      const inner = composeInline(group.map((g) => ({ ...g, link: null, b: g.b && !allB, i: g.i && !allI })), { emphasis, br: ' ' }).trim();
      if (!inner) continue;
      const url = r.link.replace(/[()\s]/g, (c) => encodeURIComponent(c));
      add(`[${inner}](${url})`, allB, allI);
      continue;
    }
    add(escapeInline(r.text), emphasis && r.b, emphasis && r.i);
  }

  // Whitespace-only segments take the style both neighbours share
  // (nearest non-whitespace segment on each side: one pass each way).
  const ws = segs.map((seg) => !seg.md.trim());
  const prevOf = new Array(segs.length);
  for (let k = 0, last = null; k < segs.length; k++) {
    prevOf[k] = last;
    if (!ws[k]) last = segs[k];
  }
  for (let k = segs.length - 1, next = null; k >= 0; k--) {
    if (!ws[k]) { next = segs[k]; continue; }
    const prev = prevOf[k];
    segs[k].b = !!(prev?.b && next?.b);
    segs[k].i = !!(prev?.i && next?.i);
  }
  const merged = [];
  for (const seg of segs) {
    const last = merged[merged.length - 1];
    if (last && last.b === seg.b && last.i === seg.i) last.md += seg.md;
    else merged.push({ ...seg });
  }

  let out = '';
  let pendingWs = '';
  const stack = [];
  const closeTo = (want) => {
    const k = stack.findIndex((m) => !want.includes(m));
    if (k === -1) return;
    while (stack.length > k) out += stack.pop();
  };
  for (const seg of merged) {
    const want = [seg.b && '**', seg.i && '*'].filter(Boolean);
    const [lead, core, trail] = splitOuterWs(seg.md);
    closeTo(want);
    if (!core) { pendingWs += seg.md; continue; }
    out += pendingWs + lead;
    for (const mk of want) {
      if (!stack.includes(mk)) { stack.push(mk); out += mk; }
    }
    out += core;
    pendingWs = trail;
  }
  closeTo([]);
  return out + pendingWs;
}

function convertRtfJoin(blocks) {
  let out = '';
  for (let k = 0; k < blocks.length; k++) {
    if (k) out += blocks[k].kind === 'list' && blocks[k - 1].kind === 'list' ? '\n' : '\n\n';
    out += blocks[k].md;
  }
  return out;
}

const LIST_ORDERED = /^\(?(\d{1,9})[.)]/;

/**
 * Regular RTF -> Markdown.
 * @param {string} rtf  binary string (one char per byte)
 * @returns {{ markdown: string, title: string, author: string, created: string|null }}
 */
export function rtfToMarkdown(rtf) {
  const { markdown, title, author, created } = convertRtf(rtf);
  return { markdown, title, author, created };
}

function convertRtf(rtf) {
  let s = String(rtf || '');
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
  if (s.startsWith('\u00ef\u00bb\u00bf')) s = s.slice(3);
  s = s.replace(/^\s+/, '');

  const info = { title: '', author: '', created: null };
  const styles = new Map();
  const blocks = [];
  let para = { style: 0, outline: null, intbl: false, ls: null, ilvl: 0 };
  let cur = { runs: [], listText: null };
  let cellParts = [];
  let row = [];
  let table = [];

  const runsHaveText = (runs) => runs.some((r) => r.text && r.text.trim());

  const headingLevel = () => {
    let ol = para.outline;
    const st = styles.get(para.style);
    if (ol == null && st) {
      if (st.outline != null) ol = st.outline;
      else {
        const m = /^(?:heading|überschrift|titre|titolo|título)\s*([1-6])\b/i.exec(st.name.trim());
        if (m) ol = Number(m[1]) - 1;
      }
    }
    return ol != null && ol >= 0 && ol < 6 ? ol + 1 : 0;
  };

  const flushTable = () => {
    if (row.length) { table.push(row); row = []; }
    if (!table.length) return;
    // A loop, not Math.max(...table): the spread overflows on 100k+ rows.
    let width = 0;
    let cellCount = 0;
    for (const r of table) {
      if (r.length > width) width = r.length;
      cellCount += r.length;
    }
    // Rows are padded to the widest one: refuse what would mostly be padding.
    if (table.length * width > 2 * cellCount + 1_000_000) {
      throw unprocessable('This table is too large to convert. / Diese Tabelle ist zu groß für die Umwandlung.', 'document_too_large');
    }
    const line = (cells) => `| ${Array.from({ length: width }, (_, k) => cells[k] ?? '').join(' | ')} |`;
    const md = [line(table[0]), `| ${Array(width).fill('---').join(' | ')} |`, ...table.slice(1).map(line)];
    blocks.push({ kind: 'table', md: md.join('\n') });
    table = [];
  };

  const cellText = (runs, header) => composeInline(runs, { emphasis: !header, br: '<br>' })
    .replace(/\s+/g, ' ').trim().replace(/\|/g, '\\|');

  const endParagraph = () => {
    const { runs, listText } = cur;
    cur = { runs: [], listText: null };
    if (para.intbl) {
      if (runsHaveText(runs)) cellParts.push(runs);
      return;
    }
    flushTable();
    if (!runsHaveText(runs)) return;
    const level = headingLevel();
    if (level) {
      const text = composeInline(runs, { emphasis: false, br: ' ' }).replace(/\s+/g, ' ').trim();
      blocks.push({ kind: 'heading', level, text, md: `${'#'.repeat(level)} ${text}` });
      return;
    }
    const body = escapeLineStarts(tidyParagraphLines(composeInline(runs).trim()));
    if (listText != null || (para.ls != null && para.ls > 0)) {
      const lt = (listText || '').trim();
      const om = LIST_ORDERED.exec(lt);
      const indent = '   '.repeat(Math.max(0, Math.min(para.ilvl || 0, 8)));
      const marker = om ? `${om[1]}. ` : '- ';
      blocks.push({ kind: 'list', md: indent + marker + body.replace(/\n/g, `\n${indent}   `) });
      return;
    }
    blocks.push({ kind: 'para', md: body });
  };

  const endCell = () => {
    if (runsHaveText(cur.runs)) cellParts.push(cur.runs);
    cur = { runs: [], listText: null };
    row.push(cellParts);
    cellParts = [];
  };
  const endRow = () => {
    if (runsHaveText(cur.runs)) endCell();
    if (row.length) {
      const header = table.length === 0;
      table.push(row.map((parts) => parts.map((p) => cellText(p, header)).filter(Boolean).join('<br>')));
    }
    row = [];
  };

  let entry = null; // stylesheet entry being read

  interpret(s, {
    dest(name, st, star) {
      const inInfo = st.dest === 'info';
      if (inInfo) {
        if (name === 'title' || name === 'author') { st.dest = `info:${name}`; return true; }
        if (name === 'creatim') { st.dest = 'creatim'; st.date = {}; return true; }
        if (/^(subject|keywords|doccomm|operator|company|manager|category|comment|hlinkbase|revtim|printim|buptim)$/.test(name)) return 'skip';
        return false;
      }
      if (name === 'info') { st.dest = 'info'; return true; }
      if (name === 'stylesheet') { st.dest = 'stylesheet'; return true; }
      if (name === 'fldinst') {
        if (st.field) { st.dest = 'fldinst'; return true; }
        return 'skip';
      }
      if (name === 'fldrslt') {
        if (st.field) {
          const m = /HYPERLINK\s+(?:\\l\s+)?"([^"]+)"|HYPERLINK\s+(\S+)/i.exec(st.field.inst);
          const url = (m?.[1] || m?.[2] || '').trim();
          st.link = /^(https?|mailto|ftp):/i.test(url) ? url : st.link;
        }
        st.dest = 'body';
        return true;
      }
      if (name === 'listtext' || name === 'pntext') {
        st.dest = 'listtext';
        cur.listText = cur.listText || '';
        return true;
      }
      if (name === 'object') { st.dest = 'object'; return true; }
      if (name === 'result' && st.dest === 'object') { st.dest = 'body'; return true; }
      if (star) return 'skip';
      if (st.dest === 'stylesheet') return false;
      if (SKIP_DESTS.has(name)) return 'skip';
      return false;
    },
    word(name, param, st) {
      switch (st.dest) {
        case 'stylesheet':
          if (!entry) return;
          if (name === 's') entry.s = param ?? 0;
          else if (name === 'outlinelevel') entry.outline = param;
          return;
        case 'creatim':
          if (['yr', 'mo', 'dy', 'hr', 'min'].includes(name)) st.date[name] = param;
          return;
        case 'listtext':
          if (name === 'tab') cur.listText += '\t';
          return;
        case 'body':
          break;
        default:
          return;
      }
      switch (name) {
        case 'par': case 'sect': case 'page': endParagraph(); break;
        case 'line': cur.runs.push({ br: true }); break;
        case 'tab': cur.runs.push({ text: ' ', b: !!st.b, i: !!st.i, link: st.link || null }); break;
        case 'b': st.b = param !== 0; break;
        case 'i': st.i = param !== 0; break;
        case 'plain': st.b = false; st.i = false; break;
        case 'pard': para = { style: 0, outline: null, intbl: false, ls: null, ilvl: 0 }; break;
        case 's': para.style = param ?? 0; break;
        case 'outlinelevel': para.outline = param; break;
        case 'intbl': para.intbl = true; break;
        case 'itap': para.intbl = (param ?? 1) > 0; break;
        case 'ls': para.ls = param; break;
        case 'ilvl': para.ilvl = param ?? 0; break;
        case 'cell': endCell(); break;
        case 'nestcell': if (runsHaveText(cur.runs)) cellParts.push(cur.runs); cur = { runs: [], listText: null }; break;
        case 'row': endRow(); break;
        case 'field': st.field = { inst: '' }; st.link = null; break;
        default: break;
      }
    },
    text(str, st) {
      switch (st.dest) {
        case 'body':
          cur.runs.push({ text: str, b: !!st.b, i: !!st.i, link: st.link || null });
          break;
        case 'fldinst': st.field.inst += str; break;
        case 'listtext': cur.listText += str; break;
        case 'info:title': info.title += str; break;
        case 'info:author': info.author += str; break;
        case 'stylesheet': if (entry) entry.name += str; break;
        default: break;
      }
    },
    sym(ch, st) {
      if (ch === '~') this.text('\u00a0', st);
      else if (ch === '_') this.text('-', st);
    },
    groupEnd(closed, parent) {
      if (closed.dest === 'creatim' && closed.date?.yr > 0) {
        const { yr, mo = 1, dy = 1, hr = 0, min = 0 } = closed.date;
        const d = new Date(Date.UTC(yr, Math.max(0, mo - 1), dy || 1, hr, min));
        if (!isNaN(d)) info.created = d.toISOString();
      }
      if (parent.dest === 'stylesheet' && entry) {
        // Skipped entries ({\*\cs15 ...} character styles) never got a name.
        entry.name = entry.name.replace(/;\s*$/, '').trim();
        if (closed.dest === 'stylesheet' && entry.name) styles.set(entry.s ?? 0, entry);
        entry = null;
      }
    },
    groupStart(st, parent) {
      if (parent.dest === 'stylesheet') entry = { s: 0, outline: null, name: '' };
    },
  });

  return finish();

  function finish() {
    if (runsHaveText(cur.runs) || cellParts.length) {
      if (para.intbl || cellParts.length) { endCell(); endRow(); } else endParagraph();
    }
    if (row.length) endRow();
    flushTable();
    return { markdown: convertRtfJoin(blocks), title: info.title.trim(), author: info.author.trim(), created: info.created, blocks };
  }
}

// ---------------------------------------------------------------- upload entry point

function bufferToRtfString(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || []);
  if (buf[0] === 0xff && buf[1] === 0xfe) return new TextDecoder('utf-16le').decode(buf.subarray(2));
  if (buf[0] === 0xfe && buf[1] === 0xff) return new TextDecoder('utf-16be').decode(buf.subarray(2));
  const body = (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) ? buf.subarray(3) : buf;
  return body.toString('latin1').replace(/^\s+/, '');
}

function htmlTitle(html) {
  // Opener and closer found separately: a lazy /<title>([\s\S]*?)<\/title>/
  // rescans to the end for every unclosed <title>.
  const open = /<title\b[^<>]*>/i.exec(html);
  if (!open) return '';
  const close = /<\/title\s*>/ig;
  close.lastIndex = open.index + open[0].length;
  const end = close.exec(html);
  if (!end) return '';
  return html.slice(open.index + open[0].length, end.index).replace(/<[^<>]*>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();
}

async function webModule() {
  return import('./web.js');
}

/** Encapsulated HTML through the regular extraction, short fragments directly. */
async function htmlBody(html, { filename, extractHtml, htmlFragmentToMarkdown }) {
  try {
    const fn = extractHtml || (await webModule()).extractHtml;
    const result = await fn(html, { filename });
    if ((result.metadata?.contentLength ?? 0) >= MIN_HTML_CONTENT_CHARS) {
      // The HTML pipeline opens with its own "# <title>" line (plus a
      // "**file** · date" line with PULLMD_SOURCE_HEADER).
      const body = result.markdown.replace(/^# [^\n]*\n+(?:\*\*[^\n]*\*\* · [^\n]*\n+)?/, '');
      return { body, quality: result.metadata?.quality };
    }
  } catch (err) {
    console.warn('RTF-encapsulated HTML failed to convert:', err.message);
  }
  const fn = htmlFragmentToMarkdown || (await webModule()).htmlFragmentToMarkdown;
  return { body: fn(html) };
}

/**
 * @param {Buffer} buffer  raw .rtf bytes
 * @param {object} [options]  filename, extractHtml / htmlFragmentToMarkdown (tests)
 */
export async function extractRtf(buffer, options = {}) {
  const { filename } = options;
  const rtf = bufferToRtfString(buffer);
  if (!startsAsRtf(rtf)) {
    throw unprocessable('Not an RTF file. / Keine RTF-Datei.', 'not_rtf');
  }

  let body;
  let title = '';
  let author;
  let publishedTime;
  let quality;
  const html = rtfToHtmlIfEncapsulated(rtf);
  if (html && html.trim()) {
    const r = await htmlBody(html, options);
    // Images in encapsulated HTML point at files that were never part of
    // the RTF (1.jpg, cid:...) - drop them, keep web images.
    body = r.body.replace(/!\[[^\]\n]*\]\((?!https?:\/\/)[^)\n]*\)[ \t]*/g, '').replace(/\n{3,}/g, '\n\n').trim();
    quality = r.quality;
    title = htmlTitle(html) || '';
  } else {
    const r = convertRtf(rtf);
    title = r.title;
    author = r.author || undefined;
    publishedTime = r.created || undefined;
    // A leading H1 is the document title: use it instead of repeating it.
    const first = r.blocks[0];
    if (first?.kind === 'heading' && first.level === 1 && (!title || first.text === title)) {
      if (!title) title = first.text;
      r.blocks.shift();
      body = r.blocks.length ? convertRtfJoin(r.blocks) : '';
    } else {
      body = r.markdown;
    }
  }

  body = String(body || '').replace(/\r\n?/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  if (!body) {
    throw unprocessable('The RTF file contains no text. / Die RTF-Datei enthält keinen Text.', 'empty_file');
  }
  title = (title || '').replace(/\s+/g, ' ').trim() || filenameStem(filename) || 'RTF';

  return {
    markdown: `# ${title}\n\n${body}\n`,
    title,
    source: 'rtf',
    metadata: {
      title,
      sourceUrl: null,
      author,
      publishedTime,
      quality,
      contentLength: body.length,
    },
  };
}
