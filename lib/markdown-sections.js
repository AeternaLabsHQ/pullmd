/**
 * Pure, dependency-free markdown block parser and heading-tree builder.
 *
 * No HTTP, no cache, no imports from server.js — this module only turns a
 * markdown string into a flat list of top-level blocks (`parseBlocks`) and
 * groups those blocks into a heading-nested section tree (`buildSectionTree`).
 * It is the foundation for the (later, opt-in) query-extract feature, which
 * BM25-scores the sections this module produces.
 */

const FENCE_OPEN_RE = /^ {0,3}(`{3,}|~{3,})/;
const FENCE_OPEN_ANY_INDENT_RE = /^\s*(`{3,}|~{3,})/;
const INDENTED_CODE_RE = /^ {4,}\S/;
const HEADING_RE = /^ {0,3}(#{1,6})(?:\s|$)/;
const TABLE_DELIM_RE = /^\s*\|?[\s:|-]+\|[\s:|-]*$/;
const LIST_START_RE = /^\s{0,3}([-*+]|\d{1,9}[.)])\s/;
const INDENTED_LINE_RE = /^[ \t]+\S/;
const BLOCKQUOTE_START_RE = /^ {0,3}>/;
const HTML_START_RE = /^\s{0,3}<[a-zA-Z!/]/;

function isBlank(line) {
  return line.trim() === '';
}

function fenceOpenMatch(line, re) {
  return line.match(re);
}

/**
 * Finds the close line index of a fence opened at `start`, scanning with `openRe` for the
 * char/length. The closing fence's leading-indent tolerance mirrors the opening one: `{0,3}`
 * (CommonMark) for top-level fences matched via `FENCE_OPEN_RE`, unlimited whitespace for
 * fences nested inside list items matched via `FENCE_OPEN_ANY_INDENT_RE` — otherwise a
 * closing fence indented 4+ spaces would never match and the fence would run to EOF.
 */
function findFenceClose(lines, start, openRe) {
  const m = fenceOpenMatch(lines[start], openRe);
  const fenceChar = m[1][0];
  const fenceLen = m[1].length;
  const closeIndent = openRe === FENCE_OPEN_ANY_INDENT_RE ? '\\s*' : ' {0,3}';
  const closeRe = new RegExp(`^${closeIndent}${fenceChar}{${fenceLen},}\\s*$`);
  for (let i = start + 1; i < lines.length; i++) {
    if (closeRe.test(lines[i])) return i;
  }
  return lines.length - 1;
}

function isTableStart(lines, i) {
  const line = lines[i];
  return !isBlank(line) && line.includes('|') && i + 1 < lines.length && TABLE_DELIM_RE.test(lines[i + 1]);
}

function isListStart(line) {
  return LIST_START_RE.test(line);
}

function isBlockquoteStart(line) {
  return BLOCKQUOTE_START_RE.test(line);
}

function isHtmlStart(line) {
  return HTML_START_RE.test(line);
}

/** True if `lines[idx]` should start a new block (used to stop paragraph/list growth). */
function startsNewBlock(lines, idx) {
  const line = lines[idx];
  if (isBlank(line)) return true;
  if (FENCE_OPEN_RE.test(line)) return true;
  if (HEADING_RE.test(line)) return true;
  if (isTableStart(lines, idx)) return true;
  if (isListStart(line)) return true;
  if (isBlockquoteStart(line)) return true;
  if (isHtmlStart(line)) return true;
  return false;
}

function scanFence(lines, start) {
  const end = findFenceClose(lines, start, FENCE_OPEN_RE);
  return { type: 'code', startLine: start, endLine: end };
}

function scanIndentedCode(lines, start) {
  let i = start;
  while (i + 1 < lines.length) {
    const next = lines[i + 1];
    if (isBlank(next)) {
      let j = i + 1;
      while (j < lines.length && isBlank(lines[j])) j++;
      if (j < lines.length && INDENTED_CODE_RE.test(lines[j])) {
        i = j;
        continue;
      }
      break;
    }
    if (INDENTED_CODE_RE.test(next)) {
      i++;
      continue;
    }
    break;
  }
  return { type: 'code', startLine: start, endLine: i };
}

function scanTable(lines, start) {
  let end = start + 1; // delimiter row is always part of the table
  let j = start + 2;
  while (j < lines.length && !isBlank(lines[j]) && lines[j].includes('|')) {
    end = j;
    j++;
  }
  return { type: 'table', startLine: start, endLine: end };
}

function scanList(lines, start) {
  let i = start;
  while (i + 1 < lines.length) {
    const next = lines[i + 1];
    if (isBlank(next)) {
      let j = i + 1;
      while (j < lines.length && isBlank(lines[j])) j++;
      if (j < lines.length && (isListStart(lines[j]) || INDENTED_LINE_RE.test(lines[j]))) {
        i = j - 1;
        continue;
      }
      break;
    }
    const isContinuation = isListStart(next) || INDENTED_LINE_RE.test(next);
    if (isContinuation && FENCE_OPEN_ANY_INDENT_RE.test(next)) {
      // Consume the whole fenced block atomically so blank lines inside it
      // (e.g. inside a fenced code sample nested in a list item) don't get
      // misread as list-terminating blank lines.
      i = findFenceClose(lines, i + 1, FENCE_OPEN_ANY_INDENT_RE);
      continue;
    }
    if (isContinuation) {
      i++;
      continue;
    }
    break;
  }
  return { type: 'list', startLine: start, endLine: i };
}

function scanBlockquote(lines, start) {
  let i = start;
  while (i + 1 < lines.length && isBlockquoteStart(lines[i + 1])) i++;
  return { type: 'blockquote', startLine: start, endLine: i };
}

function scanHtml(lines, start) {
  let i = start;
  while (i + 1 < lines.length && !isBlank(lines[i + 1])) i++;
  return { type: 'html', startLine: start, endLine: i };
}

function scanParagraph(lines, start) {
  let i = start;
  while (i + 1 < lines.length && !startsNewBlock(lines, i + 1)) i++;
  return { type: 'paragraph', startLine: start, endLine: i };
}

/**
 * Parses a markdown string into a flat list of top-level blocks.
 *
 * Line-based, dependency-free, and pinned to a simplified subset of
 * CommonMark (ATX headings only, no setext; see module rules in
 * `.superpowers/sdd/task-1-brief.md`). Code fences (``` / ~~~) fully mask
 * their contents — no nested recognition of headings/tables/etc inside a
 * fence. An unclosed fence runs to end of document.
 *
 * @param {string} markdown  Raw markdown text.
 * @returns {Array<{type: 'heading'|'paragraph'|'code'|'table'|'list'|'blockquote'|'html',
 *                   level?: number, startLine: number, endLine: number, text: string}>}
 *   Blocks in document order. `startLine`/`endLine` are 0-based inclusive line
 *   indices into `markdown.split(/\r?\n/)`. `text` is the verbatim source text
 *   for that line range (joined with `\n`), so joining all block texts with
 *   `'\n\n'` reproduces the source document up to blank-line normalization.
 */
export function parseBlocks(markdown) {
  const lines = markdown.split(/\r?\n/);
  const blocks = [];
  let i = 0;
  let afterBlank = true; // start of document counts as "after a blank line"

  while (i < lines.length) {
    const line = lines[i];
    if (isBlank(line)) {
      i++;
      afterBlank = true;
      continue;
    }

    let block;
    if (FENCE_OPEN_RE.test(line)) {
      block = scanFence(lines, i);
    } else if (afterBlank && INDENTED_CODE_RE.test(line)) {
      block = scanIndentedCode(lines, i);
    } else if (HEADING_RE.test(line)) {
      const level = line.match(HEADING_RE)[1].length;
      block = { type: 'heading', level, startLine: i, endLine: i };
    } else if (isTableStart(lines, i)) {
      block = scanTable(lines, i);
    } else if (isListStart(line)) {
      block = scanList(lines, i);
    } else if (isBlockquoteStart(line)) {
      block = scanBlockquote(lines, i);
    } else if (isHtmlStart(line)) {
      block = scanHtml(lines, i);
    } else {
      block = scanParagraph(lines, i);
    }

    block.text = lines.slice(block.startLine, block.endLine + 1).join('\n');
    blocks.push(block);
    i = block.endLine + 1;
    afterBlank = false;
  }

  return blocks;
}

/**
 * Groups a flat block list into a heading-nested section tree.
 *
 * One section per heading block, holding that heading plus all following
 * blocks up to (not including) the next heading of the same or shallower
 * level. A synthetic level-0 root section (`heading: null`) holds any
 * pre-first-heading content and is the ancestor of all top-level sections.
 * Skipped heading levels (e.g. an `###` directly after an `#`) nest under
 * the nearest preceding shallower heading, per document structure rather
 * than strict level adjacency.
 *
 * @param {ReturnType<typeof parseBlocks>} blocks  Blocks as produced by {@link parseBlocks}.
 * @returns {{sections: Array<{heading: object|null, level: number, blocks: Array,
 *             parent: object|null, children: Array, order: number}>, headingCount: number}}
 *   `sections[0]` is always the synthetic root. Each section's `blocks` holds
 *   only its own local (non-descendant) content.
 */
export function buildSectionTree(blocks) {
  const root = { heading: null, level: 0, blocks: [], parent: null, children: [], order: 0 };
  const sections = [root];
  const stack = [root];
  let headingCount = 0;

  for (const block of blocks) {
    if (block.type === 'heading') {
      headingCount++;
      while (stack[stack.length - 1].level >= block.level) stack.pop();
      const parent = stack[stack.length - 1];
      const section = {
        heading: block,
        level: block.level,
        blocks: [],
        parent,
        children: [],
        order: sections.length,
      };
      parent.children.push(section);
      sections.push(section);
      stack.push(section);
    } else {
      stack[stack.length - 1].blocks.push(block);
    }
  }

  return { sections, headingCount };
}
