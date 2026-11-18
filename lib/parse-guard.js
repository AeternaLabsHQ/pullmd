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

/** inspectMarkup() options for HTML that goes through the web extraction pipeline. */
export const WEB_HTML_LIMITS = Object.freeze({
  maxDepthSum: MAX_DEPTH_SUM,
  maxElements: MAX_HTML_ELEMENTS,
  maxTextNodes: MAX_TEXT_NODES,
  maxChildren: MAX_CHILD_NODES,
  maxAttributes: MAX_ATTRIBUTES,
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
} = {}) {
  let depth = 0;
  let elements = 0;
  let depthSum = 0;
  let textNodes = 0;
  let children = 0;
  let nodes = 0;
  let attributes = 0;
  let rawText = null;
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
    },
    onclosetag(name) {
      if (name === rawText) rawText = null;
    },
    ontext(data) {
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
 * cheerio.load() for HTML through htmlparser2 instead of cheerio's default
 * parse5, so the tree is built by the same parser inspectMarkup() measures
 * (parse5 nests content that htmlparser2 reads as raw text, e.g. inside
 * <svg><title>). The input is checked against WEB_HTML_LIMITS first: every
 * HTML parse in lib/ goes through this or parseHtmlDocument(), so no parse
 * can skip the guard, whichever serializer produced the string.
 * Text and attributes are decoded as with parse5; $.html() escapes only what
 * HTML needs (&, <, >, quotes in attributes) and keeps other characters as
 * they are. The tree gets the html > head + body skeleton parse5 would add
 * (see ensureDocumentShape).
 *
 * @param {string} html
 */
export function loadHtml(html) {
  inspectMarkup(html, WEB_HTML_LIMITS);
  const $ = cheerio.load(html, { xml: { xmlMode: false, decodeEntities: true, encodeEntities: 'utf8' } });
  ensureDocumentShape($);
  return $;
}

/**
 * linkedom parseHTML() behind the same check as loadHtml(). A <title> outside
 * <head> is replaced by a text node with its text (see neutralizeBodyTitles),
 * so no serialization of the returned document can hold more markup than the
 * checked string.
 *
 * @param {string} html
 * @returns {ReturnType<typeof parseHTML>}
 */
export function parseHtmlDocument(html) {
  inspectMarkup(html, WEB_HTML_LIMITS);
  const parsed = parseHTML(html);
  neutralizeBodyTitles(parsed.document);
  return parsed;
}

/**
 * Replace every HTML <title> that is not a child of <head> with a text node
 * carrying its text. htmlparser2 decodes the content of a <title> wherever it
 * stands, and linkedom writes the decoded text back unescaped (it is a
 * TextElement, like <script>). In <body> that lets escaped text become live
 * markup the next time the document is serialized and parsed again, e.g. by
 * Readability's innerHTML round-trip, with no budget check in between. The
 * head title stays (metadata reads it), and so does <svg><title>, which is an
 * SVGElement and serializes escaped.
 *
 * @param {Document} document
 */
export function neutralizeBodyTitles(document) {
  for (const el of document.querySelectorAll('title')) {
    if (el.parentElement?.localName === 'head' || el.closest('svg')) continue;
    el.replaceWith(document.createTextNode(el.textContent));
  }
}

/**
 * Check a serialized DOM string that a library will parse again without going
 * through the helpers above, e.g. through linkedom's innerHTML setter.
 * linkedom writes the decoded text of an HTML <title> back unescaped (in
 * <body> too, where htmlparser2 also decodes it), so such a string can hold
 * far more markup than the document it came from. Throws like inspectMarkup().
 *
 * @param {string} html
 */
export function assertSerializedSafe(html) {
  inspectMarkup(html, WEB_HTML_LIMITS);
}

// dom-serializer writes text inside these elements without escaping (they
// are raw text for a browser), but htmlparser2 parses their content as
// normal markup and decodes its entities. Written back as is, `&lt;div&gt;`
// in a <noscript> would turn into a live <div> for the next parser.
// script, style and xmp are absent: htmlparser2 keeps their content raw (not
// decoded), so it round-trips unchanged.
const REPARSED_UNENCODED = new Set(['iframe', 'noembed', 'noframes', 'noscript', 'plaintext']);

const escapeText = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * $.html() for a tree from loadHtml() whose output another parser reads
 * again: text inside the elements above is escaped like any other text.
 *
 * @param {import('cheerio').CheerioAPI} $
 * @returns {string}
 */
export function serializeHtml($) {
  const changed = [];
  const stack = [$.root()[0]];
  while (stack.length) {
    const node = stack.pop();
    if (!node.children) continue;
    const escape = node.type === 'tag' && REPARSED_UNENCODED.has(node.name);
    for (const child of node.children) {
      if (escape && child.type === 'text') {
        changed.push([child, child.data]);
        child.data = escapeText(child.data);
      } else if (child.children) {
        stack.push(child);
      }
    }
  }
  try {
    return $.html();
  } finally {
    for (const [child, data] of changed) child.data = data;
  }
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
