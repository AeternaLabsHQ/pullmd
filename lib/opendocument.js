// OpenDocument uploads (.odt, .ods, .odp) to Markdown, without the
// markitdown sidecar: the files are ZIP packages with an XML body, read
// with lib/zip.js and walked as a cheerio XML DOM.
//
// - Text documents: headings, paragraphs, nested lists, tables, links,
//   bold/italic from automatic styles, footnotes.
// - Spreadsheets: one "## Sheet" section with a table per non-empty sheet.
//   Repeated rows/columns (LibreOffice writes 1048576 x 16384 for the
//   unused rest of a sheet) are trimmed before expansion and capped.
// - Presentations: one "## Slide title" section per slide, speaker notes
//   as a blockquote after the slide body.
import { load } from 'cheerio';
import { readZipEntries, readZipEntry, ZipError } from './zip.js';
import { filenameStem, splitOuterWs } from './text-decode.js';
import { unprocessable } from './mail-render.js';

const EXT_RE = /\.(odt|ods|odp)$/i;
const MIME_RE = /^application\/vnd\.oasis\.opendocument\.(text|spreadsheet|presentation)\b/i;
const MAX_ROWS = 10000;
const MAX_COLS = 1000;
// A 32 MB content.xml of minimal elements already takes ~1 GB as a DOM.
const MAX_XML_BYTES = 32 * 1024 * 1024;
// Document-wide output budget. Repeat counts (rows, columns, text:s) and
// nested tables multiply content, so the per-table caps alone would still
// allow 10000 x 1000 cells of 1 KB each, per table.
const MAX_TOTAL_CELLS = 500_000;
const MAX_TOTAL_CHARS = 50_000_000;
const MAX_TOTAL_SPACES = 1_000_000;

// Placeholders for whitespace that must survive whitespace collapsing
// (text:s, text:tab) and for hard line breaks (text:line-break).
const SP = '\uE000';
const TAB = '\uE001';
const BR = '\uE002';
const WS_CLASS = `\\s${SP}${TAB}`;
const isWsOrPlaceholder = (c) => c === SP || c === TAB || c.trim() === '';

// Link targets that are passed through; other schemes (javascript:, data:,
// file:, ...) keep only the link text.
const SAFE_SCHEME = /^(https?|mailto|ftp):/i;
const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

const LABELS = {
  de: { notes: 'Notizen', slide: 'Folie' },
  en: { notes: 'Notes', slide: 'Slide' },
};

const NOT_ODF = 'Not an OpenDocument file (.odt, .ods, .odp). / Keine OpenDocument-Datei (.odt, .ods, .odp).';
const ENCRYPTED = 'This document is password-protected. Remove the password and upload it again. / Dieses Dokument ist passwortgeschützt. Entferne das Passwort und lade es erneut hoch.';
const TOO_LARGE = 'This document is too large to convert. / Dieses Dokument ist zu groß für die Umwandlung.';

// Generated or bookkeeping content that would only duplicate or clutter.
const SKIP_TAGS = new Set([
  'office:annotation', 'office:annotation-end', 'office:forms',
  'text:table-of-content', 'text:illustration-index', 'text:table-index',
  'text:object-index', 'text:user-index', 'text:alphabetical-index', 'text:bibliography',
  'text:tracked-changes', 'text:sequence-decls', 'text:variable-decls',
  'text:user-field-decls', 'text:dde-connection-decls',
  'text:bookmark', 'text:bookmark-start', 'text:bookmark-end',
  'text:reference-mark', 'text:reference-mark-start', 'text:reference-mark-end',
  'text:soft-page-break', 'text:note-citation',
  'table:table-columns', 'table:table-column', 'table:table-header-columns', 'table:table-column-group',
  'table:named-expressions', 'table:database-ranges', 'table:calculation-settings',
  'table:content-validations', 'table:label-ranges', 'table:shapes',
  'draw:image', 'draw:object', 'draw:object-ole', 'draw:plugin', 'draw:page-thumbnail',
  'svg:title', 'svg:desc', 'presentation:notes', 'office:event-listeners',
]);

export function isOpenDocumentFile(contentType, filename) {
  if (EXT_RE.test(filename || '')) return true;
  if (/\.[^./\\]+$/.test(filename || '')) return false;
  return MIME_RE.test(contentType || '');
}

// ---------------------------------------------------------------- DOM helpers

const isTag = (n) => n && n.type === 'tag';
// arr.push(...items) overflows the stack beyond ~120k items.
const pushAll = (arr, items) => { for (const it of items) arr.push(it); };
const tags = (n) => (n?.children || []).filter(isTag);
const child = (n, name) => tags(n).find((c) => c.name === name) || null;
const attr = (n, name) => n?.attribs?.[name];

function findFirst(node, name) {
  const stack = [node];
  while (stack.length) {
    const n = stack.pop();
    if (isTag(n) && n.name === name) return n;
    const kids = n.children || [];
    for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]);
  }
  return null;
}

function findAll(node, name, out = []) {
  for (const c of tags(node)) {
    if (c.name === name) out.push(c);
    else findAll(c, name, out);
  }
  return out;
}

/** Plain text of a node (titles, meta), whitespace collapsed. */
function textOf(node) {
  let s = '';
  const walk = (n) => {
    if (n.type === 'text') { s += n.data; return; }
    if (!isTag(n) || SKIP_TAGS.has(n.name) || n.name === 'text:note') return;
    if (n.name === 'text:s' || n.name === 'text:tab' || n.name === 'text:line-break') { s += ' '; return; }
    if (n.name === 'text:p' || n.name === 'text:h') s += ' ';
    (n.children || []).forEach(walk);
  };
  walk(node);
  return s.replace(/\s+/g, ' ').trim();
}

// ---------------------------------------------------------------- styles

function collectStyles(root, styles, listStyles, auto) {
  if (!root) return;
  for (const s of findAll(root, 'style:style')) {
    const name = attr(s, 'style:name');
    if (!name) continue;
    const tp = child(s, 'style:text-properties');
    const w = attr(tp, 'fo:font-weight');
    const st = attr(tp, 'fo:font-style');
    styles.set(name, {
      bold: w === undefined ? undefined : (w === 'bold' || Number(w) >= 600),
      italic: st === undefined ? undefined : (st === 'italic' || st === 'oblique'),
      parent: attr(s, 'style:parent-style-name'),
      auto,
    });
  }
  for (const l of findAll(root, 'text:list-style')) {
    const name = attr(l, 'style:name');
    if (!name) continue;
    const levels = {};
    for (const lv of tags(l)) {
      const level = Number(attr(lv, 'text:level')) || 1;
      if (lv.name === 'text:list-level-style-number') {
        // A number style without a format (style:num-format="") shows nothing.
        levels[level] = attr(lv, 'style:num-format') ? 'number' : 'none';
      } else if (lv.name === 'text:list-level-style-bullet') {
        levels[level] = 'bullet';
      }
    }
    listStyles.set(name, levels);
  }
}

// true/false when the style (or a parent) sets the property, undefined when
// it is silent - a span with font-weight="normal" switches off a bold
// paragraph, a span without a weight inherits it.
function resolveFormat(styles, name, prop) {
  for (let i = 0, n = name; n && i < 20; i++) {
    const s = styles.get(n);
    if (!s) return undefined;
    if (s[prop] !== undefined) return s[prop];
    n = s.parent;
  }
  return undefined;
}

function isTitleStyle(styles, name) {
  for (let i = 0, n = name; n && i < 20; i++) {
    if (n === 'Title') return true;
    n = styles.get(n)?.parent;
  }
  return false;
}

// ---------------------------------------------------------------- inline

function escapeText(s) {
  return s
    .replace(/[*`]/g, '\\$&')
    // Underscores inside words never emphasise; only escape the others.
    .replace(/_/g, (m, off, str) => (/\w/.test(str[off - 1] || '') && /\w/.test(str[off + 1] || '') ? m : '\\_'))
    .replace(/[[\]]/g, '\\$&');
}

/** Collect formatted runs: {t, b, i} with already-escaped Markdown text. */
function collectRuns(node, ctx, fmt, runs) {
  for (const n of node.children || []) {
    if (n.type === 'text') {
      runs.push({ t: escapeText(n.data.replace(/[ \t\r\n]+/g, ' ')), ...fmt });
      continue;
    }
    if (!isTag(n) || SKIP_TAGS.has(n.name)) continue;
    switch (n.name) {
      case 'text:s': {
        // Runs of spaces are kept as written up to a document-wide budget;
        // past it (crafted files: 100 spaces per 22-byte element) one each.
        let count = Math.min(Number(attr(n, 'text:c')) || 1, 100);
        if (ctx.budget.spaces + count > MAX_TOTAL_SPACES) count = 1;
        ctx.budget.spaces += count;
        runs.push({ t: SP.repeat(count), ...fmt });
        break;
      }
      case 'text:tab':
        runs.push({ t: TAB, ...fmt });
        break;
      case 'text:line-break':
        runs.push({ t: BR, ...fmt });
        break;
      case 'text:span': {
        const style = attr(n, 'text:style-name');
        const next = {
          b: resolveFormat(ctx.styles, style, 'bold') ?? fmt.b,
          i: resolveFormat(ctx.styles, style, 'italic') ?? fmt.i,
        };
        collectRuns(n, ctx, next, runs);
        break;
      }
      case 'text:a': {
        const inner = serializeRuns(collectRuns(n, ctx, { b: false, i: false }, [])).replace(new RegExp(BR, 'g'), ' ');
        const href = attr(n, 'xlink:href') || '';
        if (!inner.replace(new RegExp(`[${WS_CLASS}]`, 'g'), '')) break;
        // Browsers drop control characters and whitespace when they parse a
        // scheme ("java\nscript:"), so test the scheme without them.
        const probe = href.replace(/[\x00-\x20\x7f]/g, '');
        if (!href || href.startsWith('#') || (HAS_SCHEME.test(probe) && !SAFE_SCHEME.test(probe))) {
          runs.push({ t: inner, ...fmt });
        } else {
          const dest = /[\s()<>]/.test(href) ? `<${href.replace(/[<>]/g, encodeURIComponent)}>` : href;
          runs.push({ t: `[${inner}](${dest})`, ...fmt });
        }
        break;
      }
      case 'text:note': {
        const body = child(n, 'text:note-body');
        const text = body ? joinLines(renderBlocks(tags(body), ctx).join(' ')) : '';
        if (!text) break;
        ctx.notes.push(text);
        runs.push({ t: `[^${ctx.notes.length}]`, b: false, i: false });
        break;
      }
      case 'draw:frame':
      case 'draw:a':
      case 'draw:g':
      case 'draw:custom-shape':
      case 'draw:rect': {
        // Text boxes anchored in a paragraph: keep their text inline.
        const box = findFirst(n, 'draw:text-box');
        const text = box ? joinLines(renderBlocks(tags(box), ctx).join(' ')) : '';
        if (text) runs.push({ t: ` ${text} `, b: false, i: false });
        break;
      }
      default:
        // Fields (dates, page numbers, references), ruby, meta: their text.
        collectRuns(n, ctx, fmt, runs);
    }
  }
  return runs;
}

// Whitespace runs that hold a line break become one space: what
// replace(/\s*\n\s*/g, ' ') did, without its quadratic backtracking.
function joinLines(s) {
  return s.replace(/\s+/g, (m) => (m.includes('\n') ? ' ' : m));
}

// Spaces before a line break plus the break -> repl: what
// replace(/ *\n/g, repl) did, without its quadratic backtracking.
function replaceBreaks(s, repl) {
  return s.replace(/ +\n?|\n/g, (m) => (m.endsWith('\n') ? repl : m));
}

function wrap(s, marker) {
  const [lead, core, trail] = splitOuterWs(s, isWsOrPlaceholder);
  if (!core || core === BR) return s;
  return `${lead}${marker}${core}${marker}${trail}`;
}

function serializeRuns(runs) {
  let out = '';
  let i = 0;
  while (i < runs.length) {
    const b = runs[i].b;
    let group = '';
    while (i < runs.length && runs[i].b === b) {
      const it = runs[i].i;
      let sub = '';
      while (i < runs.length && runs[i].b === b && runs[i].i === it) sub += runs[i++].t;
      group += it ? wrap(sub, '*') : sub;
    }
    out += b ? wrap(group, '**') : group;
  }
  return out;
}

/** Escape what would turn a plain line into a block construct. */
function escapeLineStart(line) {
  return line
    .replace(/^(#{1,6})(?=\s|$)/, '\\$1')
    .replace(/^>/, '\\>')
    .replace(/^([-+])(?=\s)/, '\\$1')
    .replace(/^(\d{1,9})([.)])(?=\s)/, '$1\\$2')
    .replace(/^(=+|-{3,})\s*$/, '\\$1');
}

function finishLine(s) {
  return s
    .replace(/ {2,}/g, ' ')
    .split(BR)
    .map((l) => escapeLineStart(l.replace(new RegExp(SP, 'g'), ' ').replace(new RegExp(TAB, 'g'), '\t').trim()))
    .filter((l, idx, arr) => l || (idx > 0 && idx < arr.length - 1))
    .join('  \n')
    .trim();
}

function paragraphText(node, ctx, { heading = false } = {}) {
  let fmt = { b: false, i: false };
  const style = attr(node, 'text:style-name');
  // Direct (automatic) paragraph formatting only: named paragraph styles
  // such as "Table Heading" or "Heading 1" are bold by design.
  if (!heading && ctx.styles.get(style)?.auto) {
    fmt = { b: ctx.styles.get(style).bold === true, i: ctx.styles.get(style).italic === true };
  }
  return finishLine(serializeRuns(collectRuns(node, ctx, fmt, [])));
}

// ---------------------------------------------------------------- blocks

function renderList(list, ctx, depth, indent, inheritedStyle) {
  const styleName = attr(list, 'text:style-name') || inheritedStyle;
  const kind = ctx.listStyles.get(styleName)?.[depth + 1];
  const ordered = kind === 'number';
  let counter = 0;
  const lines = [];
  for (const item of tags(list)) {
    if (item.name !== 'text:list-item' && item.name !== 'text:list-header') continue;
    const header = item.name === 'text:list-header';
    let marker = null;
    let contIndent = indent;
    for (const c of tags(item)) {
      if (c.name === 'text:list') {
        pushAll(lines, renderList(c, ctx, depth + 1, marker ? contIndent : indent + '  ', styleName));
        continue;
      }
      const blocks = (c.name === 'text:p' || c.name === 'text:h')
        ? [paragraphText(c, ctx)].filter(Boolean)
        : renderBlocks([c], ctx);
      for (const block of blocks) {
        if (!marker) {
          marker = header ? '' : ordered ? `${++counter}. ` : '- ';
          contIndent = indent + ' '.repeat(marker.length || 2);
          const [first, ...rest] = block.split('\n');
          lines.push(indent + marker + first);
          pushAll(lines, rest.map((l) => (l ? contIndent + l : l)));
        } else {
          pushAll(lines, block.split('\n').map((l) => (l ? contIndent + l : l)));
        }
      }
    }
  }
  return lines;
}

function charge(ctx, cells, chars) {
  ctx.budget.cells += cells;
  ctx.budget.chars += chars;
  if (ctx.budget.cells > MAX_TOTAL_CELLS || ctx.budget.chars > MAX_TOTAL_CHARS) {
    throw unprocessable(TOO_LARGE, 'document_too_large');
  }
}

/**
 * Expand a table:table into a 2D array of cell strings. Trailing empty
 * cells and rows are dropped before repeat counts are expanded, and the
 * expansion is capped, so "repeat 1048576 times" costs nothing. Every
 * expanded row is charged to the document budget.
 */
function tableRows(table, cellText, ctx) {
  const rows = [];
  let pendingEmpty = 0;
  const walkRows = (node) => {
    for (const n of tags(node)) {
      if (rows.length >= MAX_ROWS) return;
      if (n.name === 'table:table-row') {
        const cells = [];
        for (const c of tags(n)) {
          if (c.name !== 'table:table-cell' && c.name !== 'table:covered-table-cell') continue;
          const repeat = Math.max(1, Number(attr(c, 'table:number-columns-repeated')) || 1);
          cells.push({ text: c.name === 'table:covered-table-cell' ? '' : cellText(c), repeat });
        }
        while (cells.length && !cells[cells.length - 1].text) cells.pop();
        const repeat = Math.max(1, Number(attr(n, 'table:number-rows-repeated')) || 1);
        if (!cells.length) {
          // Leading empty rows would make an empty header row: drop them.
          if (rows.length) pendingEmpty += repeat;
          continue;
        }
        const row = [];
        let rowChars = 0;
        for (const c of cells) {
          for (let k = 0; k < c.repeat && row.length < MAX_COLS; k++) {
            row.push(c.text);
            rowChars += c.text.length + 3;
          }
        }
        for (let k = 0; k < pendingEmpty && rows.length < MAX_ROWS; k++) rows.push([]);
        pendingEmpty = 0;
        for (let k = 0; k < repeat && rows.length < MAX_ROWS; k++) {
          charge(ctx, row.length, rowChars);
          rows.push(row);
        }
      } else if (['table:table-header-rows', 'table:table-rows', 'table:table-row-group'].includes(n.name)) {
        walkRows(n);
      }
    }
  };
  walkRows(table);
  return rows;
}

function markdownTable(rows, ctx) {
  let width = 0;
  let cells = 0;
  for (const r of rows) {
    if (r.length > width) width = r.length;
    cells += r.length;
  }
  if (!rows.length || width < 1) return '';
  // Short rows are padded to the widest one.
  const padding = rows.length * width - cells;
  charge(ctx, padding, 3 * padding);
  const line = (r) => `| ${Array.from({ length: width }, (_, k) => r[k] || '').join(' | ')} |`;
  return [line(rows[0]), `|${' --- |'.repeat(width)}`, ...rows.slice(1).map(line)].join('\n');
}

function cellEscape(s) {
  return replaceBreaks(s.replace(/\|/g, '\\|'), '<br>').trim();
}

function renderTable(table, ctx) {
  const rows = tableRows(table, (cell) => cellEscape(renderBlocks(tags(cell), ctx).join('\n')), ctx);
  return rows.length ? markdownTable(rows, ctx) : '';
}

/** Render block-level children (paragraphs, headings, lists, tables). */
function renderBlocks(nodes, ctx) {
  const out = [];
  let prev = null;
  for (const n of nodes) {
    if (!isTag(n) || SKIP_TAGS.has(n.name) || n === ctx.skipNode) continue;
    const before = out.length;
    renderBlock(n, prev);
    if (out.length !== before || n.name === 'text:list') prev = n;
  }
  return out;

  function renderBlock(n, prev) {
    switch (n.name) {
      case 'text:h': {
        const text = replaceBreaks(paragraphText(n, ctx, { heading: true }), ' ');
        if (!text) break;
        const level = Math.min(Math.max(Number(attr(n, 'text:outline-level')) || 1, 1) + ctx.headingShift, 6);
        out.push(`${'#'.repeat(level)} ${text.replace(/^\\(?=#)/, '')}`);
        break;
      }
      case 'text:p': {
        const text = paragraphText(n, ctx);
        if (text) out.push(text);
        break;
      }
      case 'text:list': {
        const lines = renderList(n, ctx, 0, '', undefined);
        if (!lines.some((l) => l.trim())) break;
        // LibreOffice splits a list where a sub-list follows: the next list
        // starts with an item that holds only the sub-list. Keep it attached.
        const firstItem = tags(n).find((c) => c.name === 'text:list-item');
        const continues = firstItem && tags(firstItem)[0]?.name === 'text:list';
        if (continues && prev?.name === 'text:list' && out.length) out[out.length - 1] += '\n' + lines.join('\n');
        else out.push(lines.join('\n'));
        break;
      }
      case 'table:table': {
        const md = renderTable(n, ctx);
        if (md) out.push(md);
        break;
      }
      default:
        // text:section, draw:frame / draw:text-box, shapes, unknown wrappers.
        pushAll(out, renderBlocks(tags(n), ctx));
    }
  }
}

// ---------------------------------------------------------------- per kind

function renderText(body, ctx, meta) {
  // A leading heading or "Title" paragraph is the document title: use it
  // when the metadata has none, and drop it when it repeats the title.
  const first = tags(body).find((n) => {
    if (SKIP_TAGS.has(n.name)) return false;
    if (n.name !== 'text:p' && n.name !== 'text:h') return true;
    return Boolean(textOf(n));
  });
  const firstIsTitle = first && (first.name === 'text:h' || (first.name === 'text:p' && isTitleStyle(ctx.styles, attr(first, 'text:style-name'))));
  let title = meta.title;
  if (firstIsTitle) {
    const t = textOf(first);
    if (!title) title = t;
    if (t === title) ctx.skipNode = first;
  }
  if (!title) {
    const h = findFirst(body, 'text:h');
    if (h) title = textOf(h) || null;
  }
  // Headings sit under the "# Title" line. Only shift them down a level when
  // a level-1 heading is left after dropping the title one; otherwise the
  // document's level 2 already is our "##".
  const hasLevelOne = (n) => isTag(n) && n !== ctx.skipNode && (
    (n.name === 'text:h' && (Number(attr(n, 'text:outline-level')) || 1) <= 1) ||
    (n.children || []).some(hasLevelOne));
  ctx.headingShift = (n => tags(n).some(hasLevelOne))(body) ? 1 : 0;
  return { title, blocks: renderBlocks(tags(body), ctx) };
}

function renderSpreadsheet(body, ctx) {
  const blocks = [];
  for (const sheet of tags(body).filter((n) => n.name === 'table:table')) {
    const rows = tableRows(sheet, (cell) => {
      const paras = tags(cell).filter((p) => p.name === 'text:p' || p.name === 'text:h');
      return cellEscape(paras.map((p) => paragraphText(p, ctx)).filter(Boolean).join(' '));
    }, ctx);
    if (!rows.length) continue;
    const name = attr(sheet, 'table:name') || '';
    blocks.push(`## ${name}`.trim(), markdownTable(rows, ctx));
  }
  return { title: null, blocks };
}

const NON_CONTENT_CLASSES = new Set(['title', 'header', 'footer', 'date-time', 'page-number', 'page', 'handout']);

function renderPresentation(body, ctx) {
  const labels = LABELS[ctx.lang] || LABELS.en;
  const blocks = [];
  let firstTitle = null;
  const pages = tags(body).filter((n) => n.name === 'draw:page');
  pages.forEach((page, idx) => {
    const titleFrame = findAll(page, 'draw:frame').find((f) => attr(f, 'presentation:class') === 'title');
    let title = titleFrame ? textOf(titleFrame) : '';
    if (title && !firstTitle) firstTitle = title;
    if (!title) {
      const name = attr(page, 'draw:name') || '';
      title = name && !/^(page|slide|folie)\s*\d+$/i.test(name) ? name : `${labels.slide} ${idx + 1}`;
    }
    const content = tags(page).filter((n) => {
      if (n.name === 'presentation:notes') return false;
      return !NON_CONTENT_CLASSES.has(attr(n, 'presentation:class'));
    });
    const parts = renderBlocks(content, ctx);
    const notes = child(page, 'presentation:notes');
    const noteFrames = notes ? tags(notes).filter((n) => attr(n, 'presentation:class') !== 'page') : [];
    const noteText = renderBlocks(noteFrames, ctx).join('\n\n');
    blocks.push(`## ${title.replace(/^#/, '\\#')}`);
    pushAll(blocks, parts);
    if (noteText) {
      blocks.push(`*${labels.notes}:*`);
      blocks.push(noteText.split('\n').map((l) => (l ? `> ${l}` : '>')).join('\n'));
    }
  });
  return { title: firstTitle, blocks };
}

// ---------------------------------------------------------------- meta

function isoDate(s) {
  if (!s) return undefined;
  let v = s.trim().replace(/(\.\d{3})\d+/, '$1');
  // ODF dates usually carry no zone; read them as UTC so the result does
  // not depend on the server's time zone.
  if (/T\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(v)) v += 'Z';
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

function readMeta(xml) {
  if (!xml) return {};
  const $ = load(xml, { xml: true });
  const root = $.root()[0];
  const text = (name) => {
    const n = findFirst(root, name);
    return n ? textOf(n) || undefined : undefined;
  };
  return {
    title: text('dc:title'),
    author: text('dc:creator') || text('meta:initial-creator'),
    publishedTime: isoDate(text('dc:date')) || isoDate(text('meta:creation-date')),
  };
}

// ---------------------------------------------------------------- entry

function readEntry(buffer, entries, name) {
  try {
    return readZipEntry(buffer, name, { entries, maxBytes: MAX_XML_BYTES });
  } catch (err) {
    if (err instanceof ZipError && err.code === 'zip_too_large') throw unprocessable(TOO_LARGE, 'document_too_large');
    throw err;
  }
}

/**
 * @param {Buffer} buffer
 * @param {object} [options]
 * @param {string} [options.filename]
 * @param {'de'|'en'} [options.lang]
 */
export async function extractOpenDocument(buffer, options = {}) {
  const { filename, lang = 'en' } = options;
  let entries;
  try {
    entries = readZipEntries(buffer);
  } catch (err) {
    if (err instanceof ZipError) throw unprocessable(NOT_ODF, 'not_opendocument');
    throw err;
  }
  const names = new Set(entries.map((e) => e.name));
  if (!names.has('content.xml')) throw unprocessable(NOT_ODF, 'not_opendocument');

  const manifest = names.has('META-INF/manifest.xml')
    ? readEntry(buffer, entries, 'META-INF/manifest.xml').toString('utf8') : '';
  if (manifest.includes('manifest:encryption-data')) throw unprocessable(ENCRYPTED, 'encrypted_document');

  let contentXml;
  try {
    contentXml = readEntry(buffer, entries, 'content.xml').toString('utf8');
  } catch (err) {
    if (err instanceof ZipError) throw unprocessable(ENCRYPTED, 'encrypted_document');
    throw err;
  }
  const $ = load(contentXml, { xml: true });
  const root = tags($.root()[0]).find((n) => n.name === 'office:document-content');
  if (!root) throw unprocessable(ENCRYPTED, 'encrypted_document');

  const mimetype = names.has('mimetype') ? readEntry(buffer, entries, 'mimetype').toString('utf8').trim() : '';
  const officeBody = child(root, 'office:body');
  const bodies = {
    text: child(officeBody, 'office:text'),
    spreadsheet: child(officeBody, 'office:spreadsheet'),
    presentation: child(officeBody, 'office:presentation') || child(officeBody, 'office:drawing'),
  };
  const hinted = mimetype.match(/opendocument\.(text|spreadsheet|presentation)/)?.[1]
    || (filename || '').match(EXT_RE)?.[1]?.toLowerCase().replace(/^odt$/, 'text').replace(/^ods$/, 'spreadsheet').replace(/^odp$/, 'presentation');
  const kind = (hinted && bodies[hinted]) ? hinted : Object.keys(bodies).find((k) => bodies[k]);
  if (!kind) throw unprocessable(NOT_ODF, 'not_opendocument');

  const ctx = {
    styles: new Map(), listStyles: new Map(), notes: [], lang: lang === 'de' ? 'de' : 'en', skipNode: null, headingShift: 1,
    budget: { cells: 0, chars: 0, spaces: 0 },
  };
  let meta;
  let rendered;
  try {
    if (names.has('styles.xml')) {
      const stylesXml = readEntry(buffer, entries, 'styles.xml').toString('utf8');
      collectStyles(load(stylesXml, { xml: true }).root()[0], ctx.styles, ctx.listStyles, false);
    }
    collectStyles(child(root, 'office:automatic-styles'), ctx.styles, ctx.listStyles, true);
    meta = readMeta(names.has('meta.xml') ? readEntry(buffer, entries, 'meta.xml').toString('utf8') : '');
    rendered = kind === 'text' ? renderText(bodies.text, ctx, meta)
      : kind === 'spreadsheet' ? renderSpreadsheet(bodies.spreadsheet, ctx)
        : renderPresentation(bodies.presentation, ctx);
  } catch (err) {
    // The walkers recurse; absurdly deep nesting (crafted files) overflows
    // the stack. Report it as an unreadable document, not a server error.
    if (err instanceof RangeError) {
      if (/string length/i.test(err.message)) throw unprocessable(TOO_LARGE, 'document_too_large');
      throw unprocessable(NOT_ODF, 'not_opendocument');
    }
    throw err;
  }

  const title = meta.title || rendered.title || filenameStem(filename) || 'OpenDocument';
  let body = rendered.blocks.join('\n\n');
  if (ctx.notes.length) body += '\n\n' + ctx.notes.map((n, k) => `[^${k + 1}]: ${n}`).join('\n');
  body = body.replace(/\n{3,}/g, '\n\n').trim();

  const metadata = { title, sourceUrl: null, contentLength: body.length };
  if (meta.author) metadata.author = meta.author;
  if (meta.publishedTime) metadata.publishedTime = meta.publishedTime;
  return {
    markdown: `# ${title}\n\n${body ? body + '\n' : ''}`,
    title,
    source: 'opendocument',
    metadata,
  };
}
