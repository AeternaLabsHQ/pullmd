// Budget check for HTML/XML before a DOM is built from it.
//
// htmlparser2 (behind cheerio and linkedom) keeps its open-element stack as an
// array and inserts every new tag at the front, so each open tag costs time in
// proportion to the current depth. Deeply nested markup therefore parses in
// quadratic time and blocks the event loop. This module runs the same
// tokenizer with no DOM and stops as soon as a budget is exceeded: the depth
// cap keeps every insert bounded, so the check itself stays linear.
//
// The later stages (linkedom, Readability, node-html-markdown) then cost time
// per DOM node, plus a share that grows with the depth of each node. The web
// budgets below bound those three measures for the HTML pipeline.

import { Parser } from 'htmlparser2';
import * as cheerio from 'cheerio';
import { unprocessable } from './mail-render.js';

export const MAX_NESTING_DEPTH = 256;
/** Sum of the stack depth at every open tag (HTML web paths). */
export const MAX_DEPTH_SUM = 10_000_000;
/** Elements per document (HTML web paths). */
export const MAX_HTML_ELEMENTS = 150_000;
/** Text nodes the DOM will hold, counting the split at each escaped character (HTML web paths). */
export const MAX_TEXT_NODES = 400_000;

/** inspectMarkup() options for HTML that goes through the web extraction pipeline. */
export const WEB_HTML_LIMITS = Object.freeze({
  maxDepthSum: MAX_DEPTH_SUM,
  maxElements: MAX_HTML_ELEMENTS,
  maxTextNodes: MAX_TEXT_NODES,
});

const TOO_COMPLEX_MESSAGE = 'Document is nested too deeply or has too many elements';
const TOO_COMPLEX_CODE = 'document_too_complex';

// Raw-text elements: cheerio does not escape their content and linkedom does
// not decode it, so characters in them never split a text node.
const RAW_TEXT_TAGS = new Set(['script', 'style', 'textarea']);

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
 * @returns {{ depth: number, elements: number, depthSum: number, textNodes: number }}
 * @throws a 422 error with code 'document_too_complex' when a budget is exceeded
 */
export function inspectMarkup(markup, {
  xml = false,
  maxDepth = MAX_NESTING_DEPTH,
  maxElements = Infinity,
  maxDepthSum = Infinity,
  maxTextNodes = Infinity,
} = {}) {
  let depth = 0;
  let elements = 0;
  let depthSum = 0;
  let textNodes = 0;
  let rawText = null;
  const tooComplex = () => unprocessable(TOO_COMPLEX_MESSAGE, TOO_COMPLEX_CODE);
  const handlers = {
    onopentagname(name) {
      elements++;
      // parser.stack is htmlparser2-internal: the open elements, innermost
      // first, already including this tag (test/parse-guard.test.js pins it).
      const d = parser.stack.length;
      if (d > depth) depth = d;
      depthSum += d;
      if (depth > maxDepth || elements > maxElements || depthSum > maxDepthSum) throw tooComplex();
      if (!xml && rawText === null && RAW_TEXT_TAGS.has(name)) rawText = name;
    },
    onclosetag(name) {
      if (name === rawText) rawText = null;
    },
    ontext(data) {
      textNodes += rawText === null ? 1 + splitPoints(data) : 1;
      if (textNodes > maxTextNodes) throw tooComplex();
    },
  };
  const parser = new Parser(handlers, { xmlMode: xml, decodeEntities: false });
  parser.write(String(markup ?? ''));
  parser.end();
  return { depth, elements, depthSum, textNodes };
}

/** True for the error inspectMarkup() throws. */
export function isTooComplex(err) {
  return err?.code === TOO_COMPLEX_CODE;
}

/**
 * cheerio.load() for HTML through htmlparser2 instead of cheerio's default
 * parse5, so the tree is built by the same parser inspectMarkup() measures
 * (parse5 nests content that htmlparser2 reads as raw text, e.g. inside
 * <svg><title>). Text and attributes are decoded as with parse5; $.html()
 * escapes only what HTML needs (&, <, >, quotes in attributes) and keeps
 * other characters as they are. The tree gets the html > head + body
 * skeleton parse5 would add (see ensureDocumentShape).
 *
 * @param {string} html
 */
export function loadHtml(html) {
  const $ = cheerio.load(html, { xml: { xmlMode: false, decodeEntities: true, encodeEntities: 'utf8' } });
  ensureDocumentShape($);
  return $;
}

// Elements the HTML parsing algorithm places in <head> while no body content
// has been seen yet.
const HEAD_TAGS = new Set(['base', 'link', 'meta', 'noscript', 'script', 'style', 'template', 'title']);

const isTag = (n, name) => n.type === 'tag' && n.name === name;
const isBlank = (n) => n.type === 'text' && !n.data.trim();
const isHeadish = (n) => (n.type === 'tag' || n.type === 'script' || n.type === 'style') && HEAD_TAGS.has(n.name);

/**
 * Give the tree a single html element with head and body, as a browser (and
 * parse5) would. htmlparser2 adds no implied elements, which matters twice:
 * linkedom leaves content outside an implied empty <body>, where Readability
 * cannot find it, and cheerio's selector engine is quadratic in the number of
 * top-level nodes. Leading head-type elements go into <head>, all other
 * content into <body>, in document order.
 */
export function ensureDocumentShape($) {
  const root = $.root()[0];
  const htmlEl = root.children.find((n) => isTag(n, 'html')) || null;
  const rootRest = root.children.filter((n) => n !== htmlEl && n.type !== 'directive');
  if (htmlEl && rootRest.every(isBlank)) {
    const kids = htmlEl.children;
    if (kids.some((n) => isTag(n, 'body')) && kids.every((n) => isTag(n, 'head') || isTag(n, 'body') || isBlank(n) || n.type === 'comment')) return;
  }

  // Rebuilt by assigning child arrays directly: moving nodes one by one with
  // cheerio's append() splices the old parent each time (quadratic).
  const front = root.children.filter((n) => n.type === 'directive');
  const content = [];
  for (const n of root.children) {
    if (n === htmlEl) content.push(...htmlEl.children.filter((k) => k.type !== 'directive'));
    else if (n.type !== 'directive') content.push(n);
  }
  const oldHead = content.find((n) => isTag(n, 'head')) || null;
  const oldBody = content.find((n) => isTag(n, 'body')) || null;
  const head = oldHead || $('<head></head>')[0];
  const body = oldBody || $('<body></body>')[0];
  const headAdd = [];
  const beforeBody = [];
  const afterBody = [];
  let started = false;                 // body content seen
  let pastBody = false;
  for (const n of content) {
    if (n === oldHead) continue;
    if (n === oldBody) { started = true; pastBody = true; continue; }
    if (!started && (isHeadish(n) || isBlank(n) || n.type === 'comment')) { headAdd.push(n); continue; }
    started = true;
    (pastBody ? afterBody : beforeBody).push(n);
  }
  setChildren(head, [...head.children, ...headAdd]);
  setChildren(body, [...beforeBody, ...body.children, ...afterBody]);
  const html = htmlEl || $('<html></html>')[0];
  setChildren(html, [head, body]);
  setChildren(root, [...front, html]);
}

function setChildren(parent, children) {
  parent.children = children;
  for (let i = 0; i < children.length; i++) {
    const c = children[i];
    c.parent = parent;
    c.prev = children[i - 1] || null;
    c.next = children[i + 1] || null;
  }
}
