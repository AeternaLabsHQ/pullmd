/**
 * Pure, opt-in query-extract orchestrator.
 *
 * Given the full converted markdown body of a page and a user query, returns
 * only the BM25-relevant sections (or blocks) of that page, reassembled in
 * document order with an elision marker between non-contiguous regions. This
 * is the heart of the query-extract feature; call sites gate it on a non-empty
 * query and never write its output back to the cache.
 *
 * No HTTP, no cache, no imports from server.js — this module composes only
 * `lib/markdown-sections.js` (block parser + section tree) and `lib/bm25.js`
 * (tokenizer + scorer). Its output text is built exclusively from input block
 * texts, ancestor-heading breadcrumb lines, and the elision marker; it never
 * invents prose, and it never splits an atomic block (code fence, table, list,
 * blockquote) because it only ever concatenates whole block texts.
 */

import { parseBlocks, buildSectionTree } from './markdown-sections.js';
import { tokenize, scoreBm25 } from './bm25.js';

const MIN_SHORT_CIRCUIT_TOKENS = 800;
const SHORT_CIRCUIT_FACTOR = 1.25;
const CANDIDATE_RATIO = 0.1; // a candidate must score >= 0.1 * bestScore
const THIN_SECTION_TOKENS = 40; // local content below this appends child sections
const COVERAGE_HIGH = 0.5; // >= half the query terms covered -> 'high'

/**
 * Estimates the token count of a string as `Math.ceil(text.length / 4)`.
 *
 * A deliberately crude, dependency-free heuristic (roughly four characters per
 * token) used for budget/short-circuit decisions and the reported
 * `originalTokens`/`returnedTokens`.
 *
 * @param {string} text  Text to estimate.
 * @returns {number} Estimated token count; `0` for empty/falsy input.
 */
export function estimateTokens(text) {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

/** Whole-page result object; `markdown` is the EXACT input string (no re-serialization). */
function wholePage(markdown, originalTokens, confidence) {
  return {
    markdown,
    extracted: false,
    confidence,
    sectionsSelected: 0,
    originalTokens,
    returnedTokens: originalTokens,
  };
}

/** Text scored for a section: its heading line (if any) plus its local block texts. */
function sectionDocText(section) {
  const parts = [];
  if (section.heading) parts.push(section.heading.text);
  for (const block of section.blocks) parts.push(block.text);
  return parts.join('\n');
}

/** Estimated tokens of a section's LOCAL content, excluding the heading line. */
function sectionLocalTokens(section) {
  return estimateTokens(section.blocks.map(b => b.text).join('\n\n'));
}

/** Estimated tokens of a section rendered alone: heading line + local blocks. */
function sectionUnitTokens(section) {
  const parts = [];
  if (section.heading) parts.push(section.heading.text);
  for (const block of section.blocks) parts.push(block.text);
  return estimateTokens(parts.join('\n\n'));
}

/** Ancestor heading blocks of a section, in document order (root excluded). */
function ancestorHeadings(section) {
  const chain = [];
  for (let cur = section.parent; cur; cur = cur.parent) {
    if (cur.heading) chain.push(cur.heading);
  }
  return chain.reverse();
}

/** All blocks in a section's subtree, in document order (heading first, then local, then children). */
function subtreeBlocks(section) {
  const out = [];
  if (section.heading) out.push(section.heading);
  for (const block of section.blocks) out.push(block);
  for (const child of section.children) out.push(...subtreeBlocks(child));
  return out;
}

/**
 * Reassembles selected blocks into the final markdown and result object.
 *
 * Blocks are deduped by identity and sorted by original document order. Regions
 * are maximal runs of blocks contiguous in the ORIGINAL block sequence; region
 * texts are joined with `'\n\n'`, and consecutive regions are separated by the
 * elision marker (`region\n\n{marker}\n\nregion`). Confidence is `'high'` when
 * the top-ranked selected unit's token set covers >= half the unique query
 * terms, else `'medium'`.
 */
function assemble({
  selectedBlocks,
  blockIndex,
  elisionMarker,
  queryTerms,
  topUnitTokens,
  sectionsSelected,
  originalTokens,
}) {
  const uniqueBlocks = [...new Set(selectedBlocks)].sort(
    (a, b) => blockIndex.get(a) - blockIndex.get(b),
  );

  const regions = [];
  let current = null;
  for (const block of uniqueBlocks) {
    const idx = blockIndex.get(block);
    if (current && idx === current.lastIdx + 1) {
      current.texts.push(block.text);
      current.lastIdx = idx;
    } else {
      current = { texts: [block.text], lastIdx: idx };
      regions.push(current);
    }
  }

  const regionTexts = regions.map(r => r.texts.join('\n\n'));
  const markdown = regionTexts.join(`\n\n${elisionMarker}\n\n`);

  const covered = queryTerms.filter(t => topUnitTokens.has(t)).length;
  const coverage = queryTerms.length > 0 ? covered / queryTerms.length : 0;
  const confidence = coverage >= COVERAGE_HIGH ? 'high' : 'medium';

  return {
    markdown,
    extracted: true,
    confidence,
    sectionsSelected: sectionsSelected == null ? regions.length : sectionsSelected,
    originalTokens,
    returnedTokens: estimateTokens(markdown),
  };
}

/**
 * Selects a contiguous window around the top-scoring block plus further
 * candidate blocks, respecting the token budget. A single block larger than the
 * budget is emitted whole (atomicity beats budget). Returns the selected block
 * set and the top block (highest score, lowest index on ties).
 */
function selectBlockWindow(blocks, scores, bestScore, maxTokens) {
  let topIndex = 0;
  for (let i = 1; i < blocks.length; i++) {
    if (scores[i] > scores[topIndex]) topIndex = i;
  }

  const selected = new Set([blocks[topIndex]]);
  let total = estimateTokens(blocks[topIndex].text);
  let left = topIndex;
  let right = topIndex;

  // Grow a contiguous window, preferring the following block, then the
  // preceding block, while the running total stays within budget.
  for (;;) {
    let progressed = false;
    if (right + 1 < blocks.length) {
      const cost = estimateTokens(blocks[right + 1].text);
      if (total + cost <= maxTokens) {
        right += 1;
        total += cost;
        selected.add(blocks[right]);
        progressed = true;
      }
    }
    if (left - 1 >= 0) {
      const cost = estimateTokens(blocks[left - 1].text);
      if (total + cost <= maxTokens) {
        left -= 1;
        total += cost;
        selected.add(blocks[left]);
        progressed = true;
      }
    }
    if (!progressed) break;
  }

  // If budget remains, add further candidate blocks individually, in score order.
  const further = blocks
    .map((block, i) => ({ block, i, score: scores[i] }))
    .filter(x => !selected.has(x.block) && x.score > 0 && x.score >= CANDIDATE_RATIO * bestScore)
    .sort((a, b) => b.score - a.score || a.i - b.i);
  for (const { block } of further) {
    const cost = estimateTokens(block.text);
    if (total + cost <= maxTokens) {
      selected.add(block);
      total += cost;
    }
  }

  return { selected, topBlock: blocks[topIndex] };
}

/** Block mode over a full block list (heading-poor page): step 5 of the algorithm. */
function runBlockMode(blocks, blockIndex, queryTerms, maxTokens, elisionMarker, markdown, originalTokens) {
  const docs = blocks.map(b => tokenize(b.text));
  const scores = scoreBm25(queryTerms, docs);
  const bestScore = Math.max(0, ...scores);
  if (bestScore <= 0) return wholePage(markdown, originalTokens, 'low');

  const { selected, topBlock } = selectBlockWindow(blocks, scores, bestScore, maxTokens);
  return assemble({
    selectedBlocks: [...selected],
    blockIndex,
    elisionMarker,
    queryTerms,
    topUnitTokens: new Set(tokenize(topBlock.text)),
    sectionsSelected: null, // block mode: sectionsSelected = output region count
    originalTokens,
  });
}

/**
 * Oversized-top-section descent: run block mode over the section's subtree
 * blocks instead of emitting the whole section, then force-keep the section's
 * heading and ancestor breadcrumb (context beats budget for those lines).
 */
function runOversizedDescent(section, blockIndex, queryTerms, maxTokens, elisionMarker, markdown, originalTokens) {
  const subtree = subtreeBlocks(section);
  const docs = subtree.map(b => tokenize(b.text));
  const scores = scoreBm25(queryTerms, docs);
  const bestScore = Math.max(0, ...scores);

  const selected = new Set();
  let topBlock = subtree[0];
  if (bestScore > 0) {
    const win = selectBlockWindow(subtree, scores, bestScore, maxTokens);
    for (const block of win.selected) selected.add(block);
    topBlock = win.topBlock;
  }

  // Keep the section heading + breadcrumb regardless of budget.
  for (const heading of ancestorHeadings(section)) selected.add(heading);
  if (section.heading) selected.add(section.heading);

  return assemble({
    selectedBlocks: [...selected],
    blockIndex,
    elisionMarker,
    queryTerms,
    topUnitTokens: new Set(tokenize(topBlock.text)),
    sectionsSelected: null,
    originalTokens,
  });
}

/** Section mode (>= 2 headings): step 4 of the algorithm. */
function runSectionMode(sections, blockIndex, queryTerms, maxTokens, elisionMarker, markdown, originalTokens) {
  // Corpus: every non-root section, plus the root only if it has content.
  const corpus = sections.filter(s => s.heading !== null || s.blocks.length > 0);
  const docs = corpus.map(s => tokenize(sectionDocText(s)));
  const scores = scoreBm25(queryTerms, docs);
  const bestScore = Math.max(0, ...scores);
  if (bestScore <= 0) return wholePage(markdown, originalTokens, 'low');

  const candidates = corpus
    .map((section, i) => ({ section, score: scores[i] }))
    .filter(c => c.score > 0 && c.score >= CANDIDATE_RATIO * bestScore)
    .sort((a, b) => b.score - a.score || a.section.order - b.section.order);

  const top = candidates[0];

  // Oversized top section -> descend to block mode over its subtree.
  if (sectionUnitTokens(top.section) > maxTokens) {
    return runOversizedDescent(top.section, blockIndex, queryTerms, maxTokens, elisionMarker, markdown, originalTokens);
  }

  const emitted = new Set();
  const emittedOrder = [];
  const committedSections = new Set();
  let running = 0;

  const addBlock = block => {
    if (block && !emitted.has(block)) {
      emitted.add(block);
      emittedOrder.push(block);
      running += estimateTokens(block.text);
    }
  };

  const commitSection = section => {
    for (const heading of ancestorHeadings(section)) addBlock(heading); // breadcrumb
    addBlock(section.heading);
    for (const block of section.blocks) addBlock(block);
    committedSections.add(section);

    // Thin section rule: augment with child sections while budget allows.
    if (sectionLocalTokens(section) < THIN_SECTION_TOKENS) {
      for (const child of section.children) {
        const childBlocks = subtreeBlocks(child).filter(b => !emitted.has(b));
        const cost = childBlocks.reduce((sum, b) => sum + estimateTokens(b.text), 0);
        if (running + cost > maxTokens) break;
        for (const block of childBlocks) addBlock(block);
        committedSections.add(child);
      }
    }
  };

  // Always take the top candidate; take further candidates while budget holds.
  commitSection(top.section);
  for (let i = 1; i < candidates.length; i++) {
    const { section } = candidates[i];
    const newBlocks = [];
    for (const heading of ancestorHeadings(section)) if (!emitted.has(heading)) newBlocks.push(heading);
    if (section.heading && !emitted.has(section.heading)) newBlocks.push(section.heading);
    for (const block of section.blocks) if (!emitted.has(block)) newBlocks.push(block);
    const cost = newBlocks.reduce((sum, b) => sum + estimateTokens(b.text), 0);
    if (running + cost > maxTokens) break;
    commitSection(section);
  }

  return assemble({
    selectedBlocks: emittedOrder,
    blockIndex,
    elisionMarker,
    queryTerms,
    topUnitTokens: new Set(tokenize(sectionDocText(top.section))),
    sectionsSelected: committedSections.size,
    originalTokens,
  });
}

/**
 * Extracts the query-relevant markdown of a page, or returns the whole page
 * unchanged when extraction does not apply.
 *
 * The input `markdown` is the pre-frontmatter converted body (call sites
 * guarantee this; YAML frontmatter is not handled here). When `extracted` is
 * `false`, `result.markdown` is the EXACT input string.
 *
 * @param {string} markdown  Full converted markdown body of the page.
 * @param {string} query  User query; tokenized and deduped for BM25 scoring.
 * @param {{maxTokens?: number, elisionMarker?: string}} [opts]
 *   `maxTokens` is the extraction budget (default 600); `elisionMarker` is the
 *   text placed between non-contiguous output regions (default `'<!-- … -->'`).
 * @returns {{markdown: string, extracted: boolean,
 *            confidence: 'high'|'medium'|'low'|null, sectionsSelected: number,
 *            originalTokens: number, returnedTokens: number}}
 *   `confidence` is `null` only for the small-page short-circuit and `'low'`
 *   only for the empty-query / no-match whole-page fallbacks.
 */
export function queryExtract(markdown, query, opts = {}) {
  const { maxTokens = 600, elisionMarker = '<!-- … -->' } = opts;

  const originalTokens = estimateTokens(markdown);
  const threshold = Math.max(MIN_SHORT_CIRCUIT_TOKENS, Math.floor(maxTokens * SHORT_CIRCUIT_FACTOR));
  if (originalTokens <= threshold) return wholePage(markdown, originalTokens, null);

  // Cap deduped query terms: without this, a long adversarial query makes
  // BM25 scoring O(terms x blocks), which is a CPU DoS vector on huge,
  // heading-poor pages (block mode scores every block against every term).
  const queryTerms = [...new Set(tokenize(query))].slice(0, 64);
  if (queryTerms.length === 0) return wholePage(markdown, originalTokens, 'low');

  const blocks = parseBlocks(markdown);
  const { sections, headingCount } = buildSectionTree(blocks);
  const blockIndex = new Map(blocks.map((block, i) => [block, i]));

  if (headingCount >= 2) {
    return runSectionMode(sections, blockIndex, queryTerms, maxTokens, elisionMarker, markdown, originalTokens);
  }
  return runBlockMode(blocks, blockIndex, queryTerms, maxTokens, elisionMarker, markdown, originalTokens);
}
