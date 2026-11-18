// Budget check for HTML/XML before a DOM is built from it.
//
// htmlparser2 (behind linkedom, and behind cheerio in XML mode) keeps its
// open-element stack as an array and inserts every new tag at the front, so
// each open tag costs time in proportion to the current depth. Deeply nested
// markup therefore parses in quadratic time. This module runs the same
// tokenizer with no DOM and stops as soon as a budget is exceeded, so the
// cost of the check itself is bounded by the depth sum.
//
// HTML is checked twice on its way through the web pipeline:
// - the raw input, before cheerio parses it with parse5 (loadHtml), against
//   RAW_HTML_LIMITS. htmlparser2 does not imply the end tags a browser does
//   (`<p><b>x<p>` keeps the <b> open), so legacy markup that parses flat in
//   parse5 looks deep to this tokenizer. The raw check therefore has no depth
//   cap of its own; the depth sum bounds both the cost and the depth.
//   Inside <svg> and <math> it also measures the markup in elements that
//   htmlparser2 reads as raw text but parse5 parses (see FOREIGN_RAW_TEXT).
// - the parse5-normalised markup preprocess() returns, before linkedom parses
//   it (parseHtmlDocument), against the strict WEB_HTML_LIMITS: there the
//   tokenizer sees the tree a browser would build.
// The later stages (linkedom, Readability, node-html-markdown) cost time per
// DOM node plus a share that grows with depth; the strict budgets bound those.
// What still slips through runs in a conversion worker with a time and memory
// limit (lib/convert-pool.js).

import { Parser } from 'htmlparser2';
import * as cheerio from 'cheerio';
import { parseHTML } from 'linkedom';
import { unprocessable } from './mail-render.js';

export const MAX_NESTING_DEPTH = 256;
/** Sum of the stack depth at every open tag (HTML web paths). */
export const MAX_DEPTH_SUM = 10_000_000;
/** Elements per document (HTML web paths). */
export const MAX_HTML_ELEMENTS = 100_000;
/** Text nodes the DOM will hold, counting the split at each escaped character (HTML web paths). */
export const MAX_TEXT_NODES = 200_000;
/**
 * Child nodes of one element (HTML web paths). linkedom's innerHTML setter
 * spreads the parsed children into replaceChildren(), which overflows the
 * call stack at about 125k direct children (measured with Readability's
 * retry re-parse of body.innerHTML, Node 22 default stack). Elements and
 * text nodes both count, so the element budget alone does not bound it.
 */
export const MAX_CHILD_NODES = 100_000;

/**
 * Attributes per document (HTML web paths). Readability and linkedom spend
 * time and memory per attribute, and bare names cost two bytes of input
 * each: one element with 160k attributes took 5 s, 10 MB of them ran the
 * process out of memory. At 200k: about 6 s and 600 MB RSS. Twice the
 * element budget, so an average of two per element at that cap.
 */
export const MAX_ATTRIBUTES = 200_000;

/**
 * Depth sum for raw HTML (RAW_HTML_LIMITS). 2000 paragraphs of `<p><b>text`
 * reach 8M in the tokenizer (two levels per paragraph, as htmlparser2 never
 * closes the <b>), `<dt><b>..<dd>` 12M, 2000 table rows of
 * `<td><font>..<td><font>` 50M. 100M admits a chain of about 14000 nested
 * elements, which parse5 parses in about 2 s; the check itself stops 100k
 * nested elements in about 20 ms.
 */
export const MAX_RAW_DEPTH_SUM = 100_000_000;

/** inspectMarkup() options for HTML that goes through the web extraction pipeline. */
export const WEB_HTML_LIMITS = Object.freeze({
  maxDepthSum: MAX_DEPTH_SUM,
  maxElements: MAX_HTML_ELEMENTS,
  maxTextNodes: MAX_TEXT_NODES,
  maxChildren: MAX_CHILD_NODES,
  maxAttributes: MAX_ATTRIBUTES,
});

/**
 * inspectMarkup() options for raw HTML, before parse5 or linkedom normalises
 * it: no depth cap, a higher depth sum, the same counts (end tags do not
 * change those).
 */
export const RAW_HTML_LIMITS = Object.freeze({
  ...WEB_HTML_LIMITS,
  maxDepth: Infinity,
  maxDepthSum: MAX_RAW_DEPTH_SUM,
  foreignRawText: true,
});

const TOO_COMPLEX_MESSAGE = 'Document is nested too deeply or has too many elements';
const TOO_COMPLEX_CODE = 'document_too_complex';

/**
 * The 422 error every budget check throws. `limit` names the exceeded budget
 * (logs, tests); the HTTP layer answers only error and code.
 *
 * @param {string} limit
 */
export function tooComplexError(limit) {
  return Object.assign(unprocessable(TOO_COMPLEX_MESSAGE, TOO_COMPLEX_CODE), { limit });
}

// Raw-text elements: cheerio does not escape their content and linkedom does
// not decode it, so characters in them never split a text node.
const RAW_TEXT_TAGS = new Set(['script', 'style', 'textarea']);

// Elements htmlparser2's tokenizer always reads as raw text. Inside <svg> or
// <math>, parse5 treats them as foreign elements and parses their content as
// markup (an HTML tag such as <div> breaks out of foreign content and nests
// from there), so a tree hidden in them never reaches the tokenizer's stack.
// The integration points (<foreignObject>, <mtext>, ...) switch parse5 back
// to HTML rules; measuring their raw-text children as well only over-counts.
const FOREIGN_RAW_TEXT = new Set(['script', 'style', 'title', 'textarea', 'xmp']);
const FOREIGN_ROOTS = new Set(['svg', 'math']);
// Raw-text elements nested in the measured content of raw-text elements:
// real markup has one level, a deeper chain only costs recursion.
const MAX_FOREIGN_RAW_TEXT_LEVELS = 8;

// linkedom creates a separate text node for every decoded character
// reference, and cheerio writes `&`, `<`, `>` and U+00A0 back as references.
function splitPoints(data) {
  let n = 0;
  for (let i = 0; i < data.length; i++) {
    const c = data.charCodeAt(i);
    if (c === 38 || c === 60 || c === 62 || c === 160) n++;
  }
  return n;
}

/**
 * Tokenize `markup` and measure it without building a DOM. Uses the parser's
 * own stack, so implied closes (`<p>`, `<li>`) do not add depth.
 *
 * @param {string} markup
 * @param {object} [options]
 * @param {boolean} [options.xml=false]  XML mode (feeds, OpenDocument)
 * @param {number} [options.maxDepth=MAX_NESTING_DEPTH]
 * @param {number} [options.maxElements=Infinity]
 * @param {number} [options.maxDepthSum=Infinity]  sum of the depth at every open tag
 * @param {number} [options.maxTextNodes=Infinity] text nodes incl. splits at escaped characters
 * @param {number} [options.maxChildren=Infinity] child nodes of any one element (elements, text nodes, comments)
 * @param {number} [options.maxNodes=Infinity] every node the DOM will hold, plus every attribute
 *   (each is a property on its element, and bare names cost almost no input): elements, text nodes (with
 *   the splits counted in textNodes), comments, processing instructions and directives, CDATA sections
 * @param {number} [options.maxAttributes=Infinity] attributes in the whole document
 * @param {boolean} [options.foreignRawText=false] HTML only: also measure the content of
 *   FOREIGN_RAW_TEXT elements inside <svg>/<math> as markup nested at their depth (for input
 *   parse5 will parse)
 * @returns {{ depth: number, elements: number, depthSum: number, textNodes: number, children: number, nodes: number, attributes: number }}
 * @throws a 422 error with code 'document_too_complex' when a budget is exceeded
 */
export function inspectMarkup(markup, {
  xml = false,
  maxDepth = MAX_NESTING_DEPTH,
  maxElements = Infinity,
  maxDepthSum = Infinity,
  maxTextNodes = Infinity,
  maxChildren = Infinity,
  maxNodes = Infinity,
  maxAttributes = Infinity,
  foreignRawText = false,
} = {}, level = 0) {
  let depth = 0;
  let elements = 0;
  let depthSum = 0;
  let textNodes = 0;
  let children = 0;
  let nodes = 0;
  let attributes = 0;
  let rawText = null;
  // A FOREIGN_RAW_TEXT element inside <svg>/<math>: its name, depth and text.
  let foreign = null;
  // Elements alone do not bound the DOM: comments, processing instructions
  // and text between them cost a node each as well.
  const addNodes = (n) => {
    nodes += n;
    if (nodes > maxNodes) throw tooComplexError('nodes');
  };
  // Child nodes per open element, indexed by stack depth (0 = the document).
  // Only the depth cap bounds its length.
  const childCounts = [0];
  const addChildren = (d, n) => {
    const c = (childCounts[d] || 0) + n;
    childCounts[d] = c;
    if (c > children) children = c;
    if (c > maxChildren) throw tooComplexError('children');
  };
  const handlers = {
    onopentagname(name) {
      elements++;
      // parser.stack is htmlparser2-internal: the open elements, innermost
      // first, already including this tag (test/parse-guard.test.js pins it).
      const d = parser.stack.length;
      if (d > depth) depth = d;
      depthSum += d;
      if (depth > maxDepth) throw tooComplexError('depth');
      if (elements > maxElements) throw tooComplexError('elements');
      if (depthSum > maxDepthSum) throw tooComplexError('depthSum');
      addNodes(1);
      // A void element (<br>, <img>) is not pushed, so d is its parent's depth.
      if (parser.stack[0] === name) {
        childCounts[d] = 0;
        addChildren(d - 1, 1);
      } else {
        addChildren(d, 1);
      }
      if (!xml && rawText === null && RAW_TEXT_TAGS.has(name)) rawText = name;
      if (foreignRawText && !xml && FOREIGN_RAW_TEXT.has(name) && parser.stack.some((n) => FOREIGN_ROOTS.has(n))) {
        foreign = { name, depth: d, text: '' };
      }
    },
    onclosetag(name) {
      if (name === rawText) rawText = null;
      if (foreign && name === foreign.name) {
        const { depth: d, text } = foreign;
        foreign = null;
        if (/<[a-z]/i.test(text)) addNested(text, d);
      }
    },
    ontext(data) {
      if (foreign) foreign.text += data;
      const n = rawText === null ? 1 + splitPoints(data) : 1;
      textNodes += n;
      if (textNodes > maxTextNodes) throw tooComplexError('textNodes');
      addNodes(n);
      addChildren(parser.stack.length, n);
    },
    onattribute() {
      attributes++;
      if (attributes > maxAttributes) throw tooComplexError('attributes');
      addNodes(1);
    },
    oncomment() {
      addNodes(1);
      addChildren(parser.stack.length, 1);
    },
    // <?pi?> and <!DOCTYPE ...> (directives), neither counted as a child.
    onprocessinginstruction() {
      addNodes(1);
    },
    // XML mode only (HTML reads CDATA as a comment); its text arrives via ontext.
    oncdatastart() {
      addNodes(1);
    },
  };
  // The content of a raw-text element in foreign content, measured as markup
  // nested at depth d inside the remaining budgets.
  const addNested = (text, d) => {
    if (level >= MAX_FOREIGN_RAW_TEXT_LEVELS) throw tooComplexError('depth');
    const r = inspectMarkup(text, {
      maxDepth: maxDepth - d,
      maxElements: maxElements - elements,
      maxDepthSum: maxDepthSum - depthSum,
      maxTextNodes: maxTextNodes - textNodes,
      maxChildren,
      maxNodes: maxNodes - nodes,
      maxAttributes: maxAttributes - attributes,
      foreignRawText,
    }, level + 1);
    elements += r.elements;
    depthSum += r.depthSum + r.elements * d;
    if (d + r.depth > depth) depth = d + r.depth;
    textNodes += r.textNodes;
    attributes += r.attributes;
    if (r.children > children) children = r.children;
    if (depth > maxDepth) throw tooComplexError('depth');
    if (elements > maxElements) throw tooComplexError('elements');
    if (depthSum > maxDepthSum) throw tooComplexError('depthSum');
    if (textNodes > maxTextNodes) throw tooComplexError('textNodes');
    if (attributes > maxAttributes) throw tooComplexError('attributes');
    addNodes(r.nodes);
  };
  const parser = new Parser(handlers, { xmlMode: xml, decodeEntities: false });
  parser.write(String(markup ?? ''));
  parser.end();
  return { depth, elements, depthSum, textNodes, children, nodes, attributes };
}

/** True for the error inspectMarkup() throws. */
export function isTooComplex(err) {
  return err?.code === TOO_COMPLEX_CODE;
}

/**
 * cheerio.load() (parse5, as on any cheerio HTML load) behind the raw-input
 * check. Every cheerio HTML load in the web pipeline goes through this.
 *
 * @param {string} html
 * @param {import('cheerio').CheerioOptions} [options]  passed to cheerio.load()
 */
export function loadHtml(html, options) {
  inspectMarkup(html, RAW_HTML_LIMITS);
  return cheerio.load(html, options);
}

/**
 * linkedom parseHTML() behind a budget check. By default the strict check, for
 * markup that parse5 has already normalised (preprocess() output and what is
 * derived from it). `raw: true` applies the raw-input check instead, for the
 * places that hand linkedom input nothing has normalised yet (mail bodies,
 * an upload before preprocess()).
 *
 * @param {string} html
 * @param {{ raw?: boolean }} [options]
 * @returns {ReturnType<typeof parseHTML>}
 */
export function parseHtmlDocument(html, { raw = false } = {}) {
  inspectMarkup(html, raw ? RAW_HTML_LIMITS : WEB_HTML_LIMITS);
  return parseHTML(html);
}
