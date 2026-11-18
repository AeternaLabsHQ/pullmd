// Budget check for HTML/XML before a DOM is built from it.
//
// htmlparser2 (behind cheerio and linkedom) keeps its open-element stack as an
// array and inserts every new tag at the front, so each open tag costs time in
// proportion to the current depth. Deeply nested markup therefore parses in
// quadratic time and blocks the event loop. This module runs the same
// tokenizer with no DOM and stops as soon as a budget is exceeded: the depth
// cap keeps every insert bounded, so the check itself stays linear.

import { Parser } from 'htmlparser2';
import { unprocessable } from './mail-render.js';

export const MAX_NESTING_DEPTH = 1024;

const TOO_COMPLEX_MESSAGE = 'Document is nested too deeply or has too many elements';
const TOO_COMPLEX_CODE = 'document_too_complex';

/**
 * Tokenize `markup` and measure its nesting depth and element count. Uses the
 * parser's own stack, so implied closes (`<p>`, `<li>`) do not add depth.
 *
 * @param {string} markup
 * @param {object} [options]
 * @param {boolean} [options.xml=false]  XML mode (feeds, OpenDocument)
 * @param {number} [options.maxDepth=MAX_NESTING_DEPTH]
 * @param {number} [options.maxElements=Infinity]
 * @returns {{ depth: number, elements: number }}
 * @throws a 422 error with code 'document_too_complex' when a budget is exceeded
 */
export function inspectMarkup(markup, { xml = false, maxDepth = MAX_NESTING_DEPTH, maxElements = Infinity } = {}) {
  let depth = 0;
  let elements = 0;
  const handlers = {
    onopentagname() {
      elements++;
      const d = parser.stack.length;
      if (d > depth) depth = d;
      if (depth > maxDepth || elements > maxElements) {
        throw unprocessable(TOO_COMPLEX_MESSAGE, TOO_COMPLEX_CODE);
      }
    },
  };
  const parser = new Parser(handlers, { xmlMode: xml, decodeEntities: false });
  parser.write(String(markup ?? ''));
  parser.end();
  return { depth, elements };
}

/** True for the error inspectMarkup() throws. */
export function isTooComplex(err) {
  return err?.code === TOO_COMPLEX_CODE;
}
