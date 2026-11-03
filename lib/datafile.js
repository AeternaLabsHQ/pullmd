// Structured text uploads: CSV/TSV become a Markdown table, JSON is
// pretty-printed into a code block, RSS/Atom feeds are rendered as a list of
// entries, any other XML is passed through as a code block.
import * as cheerio from 'cheerio';
import { decodeTextFile, filenameStem, looksBinary, removeElements, trimEndChars, trimLineEnds } from './text-decode.js';
import { formatMailDate, unprocessable } from './mail-render.js';

const EXT_KIND = {
  csv: 'csv',
  tsv: 'tsv', tab: 'tsv',
  json: 'json', jsonl: 'json', ndjson: 'json', geojson: 'json',
  xml: 'xml', rss: 'xml', atom: 'xml',
};

const CT_KIND = {
  'text/csv': 'csv',
  'application/csv': 'csv',
  'text/tab-separated-values': 'tsv',
  'application/json': 'json',
  'application/ld+json': 'json',
  'application/geo+json': 'json',
  'application/x-ndjson': 'json',
  'application/xml': 'xml',
  'text/xml': 'xml',
  'application/rss+xml': 'xml',
  'application/atom+xml': 'xml',
  'application/rdf+xml': 'xml',
};

/** @returns {'csv'|'tsv'|'json'|'xml'|null} */
export function dataFileKind(contentType, filename) {
  const ext = String(filename || '').match(/\.([^./\\]+)$/);
  if (ext) return EXT_KIND[ext[1].toLowerCase()] || null;
  const ct = (contentType || '').split(';')[0].trim().toLowerCase();
  return CT_KIND[ct] || null;
}

/**
 * Code fence that cannot be closed early by the content: one backtick longer
 * than the longest backtick run inside, at least three.
 */
export function fence(text, lang = '') {
  const body = trimEndChars(text, '\n');
  let longest = 0;
  for (const m of body.matchAll(/`+/g)) longest = Math.max(longest, m[0].length);
  const ticks = '`'.repeat(Math.max(3, longest + 1));
  return `${ticks}${lang || ''}\n${body}\n${ticks}`;
}

// ---------------------------------------------------------------- CSV / TSV

const DELIMITERS = [',', ';', '\t', '|'];

/** Count each candidate delimiter outside quotes, per line, on the first lines. */
function sniffDelimiter(text) {
  const counts = DELIMITERS.map(() => []);
  let line = DELIMITERS.map(() => 0);
  let inQuotes = false;
  let lines = 0;
  let nonEmpty = false;
  for (let i = 0; i < text.length && lines < 10; i++) {
    const c = text[i];
    if (c === '"') { inQuotes = !inQuotes; nonEmpty = true; continue; }
    if (inQuotes) continue;
    if (c === '\n') {
      if (nonEmpty) { line.forEach((n, k) => counts[k].push(n)); lines++; }
      line = DELIMITERS.map(() => 0);
      nonEmpty = false;
      continue;
    }
    nonEmpty = true;
    const k = DELIMITERS.indexOf(c);
    if (k !== -1) line[k]++;
  }
  if (nonEmpty && lines < 10) line.forEach((n, k) => counts[k].push(n));

  let best = null;
  let bestScore = 0;
  DELIMITERS.forEach((d, k) => {
    const c = counts[k];
    if (!c.length || c[0] === 0) return;
    const consistent = c.every((n) => n === c[0]);
    // Consistent column counts win over a higher but ragged count.
    const score = (consistent ? 1000 : 0) + c[0];
    if (score > bestScore) { best = d; bestScore = score; }
  });
  return best || ',';
}

/** RFC 4180 parser: quoted fields, "" escapes, delimiters and newlines inside quotes. */
export function parseDelimited(text, delimiter) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let atFieldStart = true;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else field += c;
      continue;
    }
    if (c === '"' && atFieldStart) { inQuotes = true; atFieldStart = false; continue; }
    if (c === delimiter) { row.push(field); field = ''; atFieldStart = true; continue; }
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; atFieldStart = true; continue; }
    field += c;
    atFieldStart = false;
  }
  if (field !== '' || row.length || !atFieldStart) { row.push(field); rows.push(row); }
  return rows;
}

function tableCell(value) {
  return value
    .replace(/\|/g, '\\|')
    .replace(/\n/g, '<br>')
    .trim();
}

function delimitedToTable(text, kind) {
  let delimiter = kind === 'tsv' ? '\t' : null;
  // Excel's "sep=;" first line names the delimiter.
  const sep = text.match(/^sep=(.)[ \t]*(?:\n|$)/i);
  if (sep) {
    delimiter = sep[1];
    text = text.slice(sep[0].length);
  }
  if (!delimiter) delimiter = sniffDelimiter(text);

  const rows = parseDelimited(text, delimiter);
  while (rows.length && rows[rows.length - 1].every((c) => c.trim() === '')) rows.pop();
  if (!rows.length) return null;

  // A loop, not Math.max(...rows): a spread of 100k+ rows overflows the stack.
  let width = 0;
  let cellCount = 0;
  for (const r of rows) {
    if (r.length > width) width = r.length;
    cellCount += r.length;
  }
  // Every row is padded to the widest one: one 1M-column row on top of 1M
  // short rows would make a 10^12-cell table.
  if (rows.length * width > 2 * cellCount + 1_000_000) {
    throw unprocessable('This table is too large to convert. / Diese Tabelle ist zu groß für die Umwandlung.', 'document_too_large');
  }
  const line = (r) => {
    const cells = [];
    for (let i = 0; i < width; i++) cells.push(tableCell(r[i] ?? ''));
    return `| ${cells.join(' | ')} |`;
  };
  const out = [line(rows[0]), `| ${Array(width).fill('---').join(' | ')} |`];
  for (const r of rows.slice(1)) out.push(line(r));
  return { table: out.join('\n'), rows: rows.length - 1, columns: width };
}

// ---------------------------------------------------------------- JSON

const MAX_REINDENT_DEPTH = 64;

/**
 * Re-indent valid single-line JSON token by token instead of
 * JSON.stringify(JSON.parse()), so big integers, number spelling and
 * duplicate keys stay exactly as they were.
 * @returns {string|null}  null when the result would blow up (deep nesting
 *   costs two spaces per level on every line): keep the text as it is then.
 */
function reindentJson(text) {
  let out = '';
  let depth = 0;
  const budget = Math.max(1_000_000, 4 * text.length);
  const nl = () => '\n' + '  '.repeat(depth);
  for (let i = 0; i < text.length; i++) {
    if (depth > MAX_REINDENT_DEPTH || out.length > budget) return null;
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j;
    } else if (c === '{' || c === '[') {
      let j = i + 1;
      while (/\s/.test(text[j] || '')) j++;
      if (text[j] === (c === '{' ? '}' : ']')) { out += c + text[j]; i = j; continue; }
      depth++;
      out += c + nl();
    } else if (c === '}' || c === ']') {
      depth--;
      out += nl() + c;
    } else if (c === ',') {
      out += ',' + nl();
    } else if (c === ':') {
      out += ': ';
    } else if (!/\s/.test(c)) {
      out += c;
    }
  }
  return out;
}

const MAX_PARSE_VALUES = 2_000_000;

/**
 * Cheap pre-scan before JSON.parse, which builds every value: millions of
 * (nested) arrays or objects exhaust memory. true when brackets outside
 * strings nest deeper than MAX_REINDENT_DEPTH or the text holds more than
 * MAX_PARSE_VALUES containers and separators.
 */
function tooBigToParse(text) {
  let depth = 0;
  let values = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 0x22) { // "
      for (i++; i < text.length && text.charCodeAt(i) !== 0x22; i++) if (text.charCodeAt(i) === 0x5c) i++;
    } else if (c === 0x5b || c === 0x7b) { // [ {
      if (++depth > MAX_REINDENT_DEPTH || ++values > MAX_PARSE_VALUES) return true;
    } else if (c === 0x5d || c === 0x7d) { // ] }
      depth--;
    } else if (c === 0x2c && ++values > MAX_PARSE_VALUES) { // ,
      return true;
    }
  }
  return false;
}

function renderJson(text, filename) {
  const trimmed = text.trim();
  let title = null;
  let body = trimmed;
  const lines = /\.(jsonl|ndjson)$/i.test(filename || '');
  if (!lines) {
    let value;
    let parsed = false;
    // Too big: shown as it is (not re-indented, no title).
    if (!tooBigToParse(trimmed)) {
      try { value = JSON.parse(trimmed); parsed = true; } catch { /* keep raw text */ }
    }
    if (parsed) {
      if (!trimmed.includes('\n')) body = reindentJson(trimmed) ?? trimmed;
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        for (const key of ['title', 'name']) {
          if (typeof value[key] === 'string' && value[key].trim()) { title = value[key].trim().slice(0, 300); break; }
        }
      }
    }
  }
  return { title, body: fence(body, 'json') };
}

// ---------------------------------------------------------------- XML / feeds

const LABELS = {
  de: { untitled: 'Ohne Titel' },
  en: { untitled: 'Untitled' },
};

function localName(el) {
  return String(el?.tagName || el?.name || '').split(':').pop().toLowerCase();
}

/** First child element matching one of the names (full "prefix:name" or local name). */
function child($, el, names) {
  const kids = $(el).children().toArray();
  for (const name of names) {
    const hit = kids.find((k) => (name.includes(':')
      ? String(k.tagName).toLowerCase() === name
      : localName(k) === name && !String(k.tagName).includes(':')));
    if (hit) return hit;
  }
  return null;
}

function childText($, el, names) {
  const c = el ? child($, el, names) : null;
  return c ? $(c).text().trim() : '';
}

function isHttpUrl(value) {
  return /^https?:\/\/\S+$/i.test(String(value || '').trim());
}

// Linear on hostile input: no lazy scan to a closing tag, and tags stop at
// the next '<' (/<[^>]+>/ rescans to the end for every unclosed '<').
function stripTags(html) {
  const text = removeElements(html || '', ['script', 'style'])
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6])>/gi, '\n\n')
    .replace(/<[^<>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
  return trimLineEnds(text)
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function atomLink($, el) {
  const links = $(el).children().toArray().filter((k) => localName(k) === 'link');
  const pick = links.find((l) => !$(l).attr('rel') || $(l).attr('rel') === 'alternate') || links[0];
  if (!pick) return '';
  return ($(pick).attr('href') || $(pick).text() || '').trim();
}

/** HTML payload of an element: Atom knows type="text|html|xhtml", RSS is HTML. */
function htmlOf($, el) {
  if (!el) return '';
  const type = ($(el).attr('type') || '').toLowerCase();
  if (type === 'xhtml') return $(el).html() || '';
  if (type === 'text') return $(el).text().replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return $(el).text();
}

function linkTarget(url) {
  return url.trim().replace(/[ ()<>]/g, (c) => encodeURIComponent(c));
}

function renderFeed($, root, opts) {
  const { htmlFragmentToMarkdown, lang = 'de' } = opts;
  const L = LABELS[lang === 'en' ? 'en' : 'de'];
  const toMd = (html) => {
    const src = String(html || '').trim();
    if (!src) return '';
    let md = '';
    if (typeof htmlFragmentToMarkdown === 'function') {
      try { md = htmlFragmentToMarkdown(src); } catch { md = ''; }
    }
    if (!md || !md.trim()) md = stripTags(src);
    return md.trim();
  };

  // Atom type="text" is plain text already; everything else is HTML.
  const contentMd = (el) => {
    if (!el) return '';
    if (($(el).attr('type') || '').toLowerCase() === 'text') return $(el).text().trim();
    return toMd(htmlOf($, el));
  };

  const rootName = localName(root);
  const isAtom = rootName === 'feed';
  const channel = isAtom ? root : child($, root, ['channel']);
  let items;
  if (isAtom) items = $(root).children().toArray().filter((k) => localName(k) === 'entry');
  else if (rootName === 'rdf') items = $(root).children().toArray().filter((k) => localName(k) === 'item');
  else items = channel ? $(channel).children().toArray().filter((k) => localName(k) === 'item') : [];

  const feedTitle = channel ? stripTags(htmlOf($, child($, channel, ['title']))).replace(/\s+/g, ' ') : '';
  const feedLink = channel ? (isAtom ? atomLink($, channel) : childText($, channel, ['link'])) : '';
  const feedDesc = channel ? contentMd(child($, channel, isAtom ? ['subtitle'] : ['description'])) : '';
  const feedAuthor = isAtom && channel
    ? childText($, child($, channel, ['author']), ['name'])
    : '';

  const title = feedTitle || filenameStem(opts.filename) || 'Feed';
  let markdown = `# ${title}\n\n`;
  if (feedDesc) markdown += feedDesc + '\n\n';

  const sections = [];
  for (const item of items) {
    const rawTitle = stripTags(htmlOf($, child($, item, ['title']))).replace(/\s+/g, ' ').trim();
    const link = isAtom ? atomLink($, item) : (childText($, item, ['link']) || $(item).attr('rdf:about') || childText($, item, ['guid']));
    const dateRaw = childText($, item, ['pubdate', 'dc:date', 'published', 'updated', 'date']);
    const author = isAtom
      ? childText($, child($, item, ['author']), ['name'])
      : (childText($, item, ['dc:creator', 'author']));
    const bodyEl = child($, item, ['content:encoded', 'content', 'description', 'summary']);
    const body = contentMd(bodyEl);

    const label = (rawTitle || L.untitled).replace(/([[\]])/g, '\\$1');
    let section = isHttpUrl(link) ? `## [${label}](${linkTarget(link)})` : `## ${label}`;
    const date = dateRaw ? (formatMailDate(dateRaw, lang) || dateRaw) : '';
    const meta = [date, author].filter(Boolean).join(' · ');
    if (meta) section += `\n\n*${meta}*`;
    if (body) section += `\n\n${body}`;
    sections.push(section);
  }
  if (sections.length) markdown += sections.join('\n\n') + '\n';
  markdown = trimEndChars(markdown, '\n') + '\n';

  const body = markdown.slice(`# ${title}\n\n`.length);
  const metadata = { title, sourceUrl: isHttpUrl(feedLink) ? feedLink.trim() : null, contentLength: body.length };
  if (feedAuthor) metadata.author = feedAuthor;
  return { markdown, title, source: 'feed', metadata };
}

function findFeedRoot(text) {
  // Cheap pre-check before parsing large non-feed XML.
  if (!/<(?:[\w-]+:)?(?:rss|feed|RDF)\b/.test(text)) return null;
  const $ = cheerio.load(text, { xml: true });
  const root = $.root().children().toArray().find((n) => n.type === 'tag');
  if (!root) return null;
  const name = localName(root);
  if (name === 'rss' || name === 'feed') return { $, root };
  if (name === 'rdf' && $(root).children().toArray().some((k) => localName(k) === 'item' || localName(k) === 'channel')) {
    return { $, root };
  }
  return null;
}

// ---------------------------------------------------------------- entry point

/**
 * @param {Buffer} buffer
 * @param {object} [options]
 * @param {string} [options.filename]
 * @param {'csv'|'tsv'|'json'|'xml'} [options.kind]
 * @param {(html: string) => string} [options.htmlFragmentToMarkdown]  feed item bodies
 * @param {'de'|'en'} [options.lang]  date format in feeds
 */
export async function extractDataFile(buffer, options = {}) {
  const { filename } = options;
  const kind = options.kind || dataFileKind(null, filename) || 'csv';
  const text = decodeTextFile(buffer).replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  if (looksBinary(text)) {
    throw unprocessable('This does not look like a text file. / Das sieht nicht nach einer Textdatei aus.', 'not_text');
  }
  if (!text.trim()) {
    throw unprocessable('The file is empty. / Die Datei ist leer.', 'empty_file');
  }
  const stem = filenameStem(filename);

  if (kind === 'xml') {
    const feed = findFeedRoot(text);
    if (feed) return renderFeed(feed.$, feed.root, options);
  }

  let title = null;
  let body;
  if (kind === 'csv' || kind === 'tsv') {
    const t = delimitedToTable(text, kind);
    if (!t) throw unprocessable('The file is empty. / Die Datei ist leer.', 'empty_file');
    body = t.table;
  } else if (kind === 'json') {
    const j = renderJson(text, filename);
    title = j.title;
    body = j.body;
  } else {
    body = fence(text.replace(/^\n+/, '').trimEnd(), 'xml');
  }
  title = title || stem || (kind === 'json' ? 'JSON' : kind === 'xml' ? 'XML' : 'Table');
  return {
    markdown: `# ${title}\n\n${body}\n`,
    title,
    source: 'data',
    metadata: { title, sourceUrl: null, contentLength: body.length },
  };
}
