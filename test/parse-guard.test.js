import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import {
  inspectMarkup, isTooComplex, loadHtml, parseHtmlDocument,
  MAX_NESTING_DEPTH, MAX_DEPTH_SUM, MAX_RAW_DEPTH_SUM, MAX_HTML_ELEMENTS, MAX_TEXT_NODES, MAX_CHILD_NODES, MAX_ATTRIBUTES,
  WEB_HTML_LIMITS, RAW_HTML_LIMITS,
} from '../lib/parse-guard.js';
import { htmlFragmentToMarkdown, extractHtml } from '../lib/web.js';
import { Readability } from '@mozilla/readability';

// Readability spies and patches live in this thread, so the conversions they
// watch run here too, not in the worker pool (lib/convert-pool.js).
function convertInProcess() {
  let saved;
  before(() => { saved = process.env.PULLMD_CONVERT_WORKERS; process.env.PULLMD_CONVERT_WORKERS = '0'; });
  after(() => {
    if (saved === undefined) delete process.env.PULLMD_CONVERT_WORKERS;
    else process.env.PULLMD_CONVERT_WORKERS = saved;
  });
}

const fixture = readFileSync(new URL('./fixtures/claude-blog-split-body.html', import.meta.url), 'utf8');

function assertTooComplex(err) {
  assert.equal(err.status, 422);
  assert.equal(err.code, 'document_too_complex');
  assert.equal(err.message, 'Document is nested too deeply or has too many elements');
  assert.equal(isTooComplex(err), true);
  return true;
}

describe('inspectMarkup', () => {
  it('exports the budgets', () => {
    assert.equal(MAX_NESTING_DEPTH, 256);
    assert.equal(MAX_DEPTH_SUM, 10_000_000);
    // 100k keeps a margin below the ~125k direct children at which linkedom's
    // innerHTML setter overflows the call stack (spread into replaceChildren).
    assert.equal(MAX_HTML_ELEMENTS, 100_000);
    assert.equal(MAX_CHILD_NODES, 100_000);
    assert.equal(MAX_ATTRIBUTES, 200_000);
    assert.deepEqual(WEB_HTML_LIMITS, {
      maxDepthSum: MAX_DEPTH_SUM, maxElements: MAX_HTML_ELEMENTS, maxTextNodes: MAX_TEXT_NODES, maxChildren: MAX_CHILD_NODES,
      maxAttributes: MAX_ATTRIBUTES,
    });
    assert.equal(MAX_RAW_DEPTH_SUM, 100_000_000);
    assert.deepEqual(RAW_HTML_LIMITS, { ...WEB_HTML_LIMITS, maxDepth: Infinity, maxDepthSum: MAX_RAW_DEPTH_SUM, foreignRawText: true });
  });

  // Guards the reliance on htmlparser2's internal parser.stack: if a new
  // htmlparser2 version renames or reorders it, depth stops being measured.
  it('reads the depth from the parser stack', () => {
    assert.equal(inspectMarkup('<a><b>').depth, 2);
  });

  it('sums the depth at every open tag', () => {
    const r = inspectMarkup('<div><p>a</p><p>b</p></div>');
    assert.deepEqual({ depth: r.depth, elements: r.elements, depthSum: r.depthSum }, { depth: 2, elements: 3, depthSum: 5 });
    assert.throws(() => inspectMarkup('<div>'.repeat(200) + '<a></a>'.repeat(100), { maxDepthSum: 20_000 }), assertTooComplex);
    assert.equal(inspectMarkup('<div>'.repeat(200) + '<a></a>'.repeat(100), { maxDepthSum: 50_000 }).depthSum, 20100 + 20100);
  });

  it('counts text nodes and the splits at escaped characters, not inside raw-text elements', () => {
    assert.equal(inspectMarkup('<p>a &lt; b &amp; c</p>').textNodes, 3);
    assert.equal(inspectMarkup('<script>if (a < b && c) x()</script>').textNodes, 1);
    assert.equal(inspectMarkup('<style>a > b {}</style><textarea>&lt;</textarea>').textNodes, 2);
    assert.equal(inspectMarkup('<svg><title><<<</title></svg>').textNodes, 4);
    assert.throws(() => inspectMarkup('<p>' + '&lt;'.repeat(1000) + '</p>', { maxTextNodes: 500 }), assertTooComplex);
  });

  it('names the exceeded budget in err.limit, with the same message', () => {
    const limitOf = (fn) => { try { fn(); } catch (err) { assertTooComplex(err); return err.limit; } return null; };
    assert.equal(limitOf(() => inspectMarkup('<div>'.repeat(300))), 'depth');
    assert.equal(limitOf(() => inspectMarkup('<a/>'.repeat(20), { xml: true, maxElements: 10 })), 'elements');
    assert.equal(limitOf(() => inspectMarkup('<div>'.repeat(200) + '<a></a>'.repeat(100), { maxDepthSum: 20_000 })), 'depthSum');
    assert.equal(limitOf(() => inspectMarkup('<p>' + '&lt;'.repeat(1000) + '</p>', { maxTextNodes: 500 })), 'textNodes');
  });

  it('counts every DOM node: elements, text, comments, processing instructions and CDATA', () => {
    const nodesOf = (m, o) => inspectMarkup(m, o).nodes;
    assert.equal(nodesOf('<a><b>x</b></a>'), 3);
    assert.equal(nodesOf('<p>a &lt; b</p>'), 3);                           // element + text split in two
    assert.equal(nodesOf('<r><!-- c --><!----></r>', { xml: true }), 3);
    assert.equal(nodesOf('<?xml version="1.0"?><r><?pi x?></r>', { xml: true }), 3);
    assert.equal(nodesOf('<!DOCTYPE html><p>x</p>'), 3);                   // directive counts too
    assert.equal(nodesOf('<r><![CDATA[x y]]></r>', { xml: true }), 3);  // element + CDATA + its text
    assert.equal(nodesOf('<p><![CDATA[x]]></p>'), 2);                       // HTML reads CDATA as a comment
    assert.equal(nodesOf('x<?a?>'.repeat(10), { xml: true }), 20);
    // Attributes count as nodes too (bare names cost almost no input).
    const r = inspectMarkup('<p a b="1" c=\'\'>x</p>');
    assert.deepEqual({ nodes: r.nodes, attributes: r.attributes, elements: r.elements }, { nodes: 5, attributes: 3, elements: 1 });
    assert.equal(inspectMarkup('<r xmlns:a="u" a:b="v"/>', { xml: true }).attributes, 2);
    // A flood without elements stays inside every other budget.
    const flood = '<r>' + '<!---->'.repeat(1000) + '</r>';
    assert.equal(inspectMarkup(flood, { xml: true, maxElements: 10 }).elements, 1);
    const limitOf = (fn) => { try { fn(); } catch (err) { assertTooComplex(err); return err.limit; } return null; };
    assert.equal(limitOf(() => inspectMarkup(flood, { xml: true, maxNodes: 500 })), 'nodes');
    assert.equal(limitOf(() => inspectMarkup('<r>' + '<?a?>'.repeat(1000) + '</r>', { xml: true, maxNodes: 500 })), 'nodes');
    assert.equal(limitOf(() => inspectMarkup('<r>' + 'x<?a?>'.repeat(300) + '</r>', { xml: true, maxNodes: 500 })), 'nodes');
    assert.equal(limitOf(() => inspectMarkup('<r>' + '<![CDATA[x]]>'.repeat(300) + '</r>', { xml: true, maxNodes: 500 })), 'nodes');
    assert.equal(limitOf(() => inspectMarkup('<r ' + Array.from({ length: 600 }, (_, i) => 'a' + i).join(' ') + '/>', { xml: true, maxNodes: 500 })), 'nodes');
    assert.equal(limitOf(() => inspectMarkup(flood, { xml: true, maxNodes: 1001 })), null);
    assert.equal(limitOf(() => inspectMarkup('<p a b c>x</p>'.repeat(10), { maxAttributes: 29 })), 'attributes');
    assert.equal(limitOf(() => inspectMarkup('<p a b c>x</p>'.repeat(10), { maxAttributes: 30 })), null);
    assert.equal(limitOf(() => inspectMarkup('<p ' + 'a'.repeat(5).split('').map((_, i) => 'x' + i).join(' ') + '>', WEB_HTML_LIMITS)), null);
  });

  it('rejects flat documents over the element budget', () => {
    assert.throws(() => inspectMarkup('<a></a>'.repeat(MAX_HTML_ELEMENTS + 1), WEB_HTML_LIMITS), assertTooComplex);
  });

  it('counts the child nodes of each element, text nodes and splits included', () => {
    assert.equal(inspectMarkup('<div><p>a</p> <p>b &lt; c</p></div>').children, 3);
    assert.equal(inspectMarkup('<div>' + ' <b></b>'.repeat(50) + '</div>').children, 100);
    assert.equal(inspectMarkup('<div>'.repeat(50) + 'x').children, 1);
    // Void elements are children of the element they stand in.
    assert.equal(inspectMarkup('<div><p>a<br>b</p>' + ' <br>'.repeat(50) + '</div>').children, 101);
    assert.equal(inspectMarkup('<p>a<br>b<img>c</p>').children, 5);
    const limitOf = (fn) => { try { fn(); } catch (err) { assertTooComplex(err); return err.limit; } return null; };
    assert.equal(limitOf(() => inspectMarkup('<div>' + ' <b></b>'.repeat(60) + '</div>', { maxChildren: 100 })), 'children');
    assert.equal(limitOf(() => inspectMarkup('<div>' + '<b>x</b>'.repeat(60) + '</div>', { maxChildren: 100 })), null);
    // 60k elements and 60k blank text nodes: inside every other budget, but
    // 120k direct children of body.
    assert.equal(limitOf(() => inspectMarkup('<html><body>' + ' <b></b>'.repeat(60_000) + '</body></html>', WEB_HTML_LIMITS)), 'children');
  });

  it('accepts a normal article', () => {
    const r = inspectMarkup(fixture);
    assert.ok(r.depth > 0 && r.depth < 100, `depth ${r.depth}`);
    assert.ok(r.elements > 0);
  });

  it('implied closes do not count as depth', () => {
    assert.ok(inspectMarkup('<p>x'.repeat(5000)).depth < 10);
    assert.ok(inspectMarkup('<ul>' + '<li>x'.repeat(5000)).depth < 10);
  });

  it('rejects a chain just over the depth cap', () => {
    assert.equal(inspectMarkup('<div>'.repeat(256)).depth, 256);
    assert.throws(() => inspectMarkup('<div>'.repeat(257)), assertTooComplex);
  });

  it('rejects deep HTML fast', () => {
    const t0 = performance.now();
    assert.throws(() => inspectMarkup('<span>'.repeat(100_000)), assertTooComplex);
    assert.ok(performance.now() - t0 < 1000, `took ${performance.now() - t0} ms`);
  });

  it('rejects deep XML', () => {
    const t0 = performance.now();
    assert.throws(() => inspectMarkup('<rss>' + '<a>'.repeat(400_000), { xml: true }), assertTooComplex);
    assert.ok(performance.now() - t0 < 1000, `took ${performance.now() - t0} ms`);
  });

  it('element budget', () => {
    const xml = '<a/>'.repeat(2000);
    assert.throws(() => inspectMarkup(xml, { xml: true, maxElements: 1000 }), assertTooComplex);
    assert.equal(inspectMarkup(xml, { xml: true, maxElements: 5000 }).elements, 2000);
  });

  it('isTooComplex is false for other errors', () => {
    assert.equal(isTooComplex(new Error('x')), false);
    assert.equal(isTooComplex(undefined), false);
  });
});

describe('htmlFragmentToMarkdown (mail and calendar bodies)', () => {
  it('rejects an over-nested fragment fast', () => {
    const t0 = performance.now();
    assert.throws(() => htmlFragmentToMarkdown('<div>'.repeat(100_000)), assertTooComplex);
    assert.ok(performance.now() - t0 < 1000, `took ${performance.now() - t0} ms`);
  });
});

// Content that htmlparser2 reads as raw text but parse5 nests: the raw-input
// check sees no depth, the strict check on parse5's output does.
describe('raw-input check - raw-text elements in foreign content', () => {
  const variants = ['<svg><title>', '<svg><style>', '<svg><script>', '<svg><textarea>', '<svg><xmp>',
    '<math><mi><svg><title>', '<math><title>', '<math><mtext><textarea>', '<svg><foreignObject><title>'];
  for (const prefix of variants) {
    it(`${prefix} + 100k <div> is rejected in under 1 s`, () => {
      const t0 = performance.now();
      assert.throws(() => loadHtml(prefix + '<div>'.repeat(100_000)), assertTooComplex);
      assert.ok(performance.now() - t0 < 1000, `took ${performance.now() - t0} ms`);
    });
  }

  it('measures the content as markup at its depth, also without an end tag', () => {
    const r = inspectMarkup('<svg><title>' + '<div>'.repeat(10), RAW_HTML_LIMITS);
    assert.equal(r.depth, 12);
    assert.equal(r.elements, 12);
    assert.equal(r.depthSum, 1 + 2 + (3 + 12) * 10 / 2);
    // Outside foreign content, and in the strict check, a <title> stays text.
    assert.equal(inspectMarkup('<title>' + '<div>'.repeat(10), RAW_HTML_LIMITS).elements, 1);
    assert.equal(inspectMarkup('<svg><title>' + '<div>'.repeat(10)).elements, 2);
  });

  it('a nested chain of raw-text elements is cut off', () => {
    assert.throws(() => inspectMarkup('<svg><title>'.repeat(20), RAW_HTML_LIMITS), assertTooComplex);
  });

  it('plain SVG with a title and CSS passes unchanged', () => {
    const r = inspectMarkup('<svg><title>Icon &amp; label</title><style>a > b { fill: red }</style><path d="M0 0"/></svg>', RAW_HTML_LIMITS);
    assert.equal(r.elements, 4);
  });
});

describe('extractHtml - raw-text contexts in foreign content', () => {
  const variants = {
    'svg/title': '<svg><title>',
    'svg/style': '<svg><style>',
    'svg/script': '<svg><script>',
    'math/textarea': '<math><mtext><textarea>',
  };
  for (const [name, prefix] of Object.entries(variants)) {
    it(`${name} + 10k <div> answers fast, 422 or a result`, async () => {
      const t0 = performance.now();
      try {
        const r = await extractHtml(prefix + '<div>'.repeat(10_000), { extractor: 'readability' });
        assert.equal(typeof r.markdown, 'string');
      } catch (err) {
        assertTooComplex(err);
      }
      assert.ok(performance.now() - t0 < 5000, `took ${performance.now() - t0} ms`);
    });
  }
});

// Elements parse5 reads as raw text and writes back unescaped: their content
// becomes markup for linkedom after preprocess(), and the strict check sees it.
describe('extractHtml - escaped markup inside unencoded elements', () => {
  for (const tag of ['noscript', 'iframe', 'noembed', 'noframes', 'plaintext']) {
    it(`<${tag}> + 20k escaped <div> answers fast, 422 or a result`, async () => {
      const t0 = performance.now();
      const close = tag === 'plaintext' ? '' : `</${tag}>`;
      try {
        const r = await extractHtml(`<p>x</p><${tag}>` + '&lt;div&gt;'.repeat(20_000) + close, { extractor: 'readability' });
        assert.equal(typeof r.markdown, 'string');
      } catch (err) {
        assertTooComplex(err);
      }
      assert.ok(performance.now() - t0 < 5000, `took ${performance.now() - t0} ms`);
    });
  }
});

// linkedom writes the decoded text of a <title> back unescaped, so its
// toString() (used when a url is given) can turn text into markup. Every
// later parse checks its own input.
describe('extractHtml - escaped markup in <head><title> with a url', () => {
  it('answers fast, 422 or a result', async () => {
    const html = '<html><head><title>T&lt;/title&gt;' + '&lt;div&gt;'.repeat(20_000) + '</title></head><body><p>x</p></body></html>';
    const t0 = performance.now();
    try {
      const r = await extractHtml(html, { url: 'https://example.org/a', extractor: 'readability', recipes: [] });
      assert.equal(typeof r.markdown, 'string');
    } catch (err) {
      assertTooComplex(err);
    }
    assert.ok(performance.now() - t0 < 5000, `took ${performance.now() - t0} ms`);
  });
});

// The same title serialization inside <body>. The spy proves the order: a 422
// must come before Readability.parse(). All three stop at the raw check: 99k
// has about 198k text nodes inside one element (MAX_CHILD_NODES), 150k and
// 199k are over MAX_TEXT_NODES as well.
describe('extractHtml - escaped markup in a body <title>', () => {
  convertInProcess();

  for (const n of [99_000, 150_000, 199_000]) {
    it(`${n / 1000}k escaped <div> is rejected before Readability runs`, async () => {
      const html = '<html><body><p>x</p><title>T&lt;/title&gt;' + '&lt;div&gt;'.repeat(n) + '</title></body></html>';
      const parse = Readability.prototype.parse;
      let calls = 0;
      Readability.prototype.parse = function (...args) { calls++; return parse.apply(this, args); };
      const t0 = performance.now();
      try {
        const r = await extractHtml(html, { extractor: 'readability', recipes: [] });
        assert.equal(typeof r.markdown, 'string');
      } catch (err) {
        assertTooComplex(err);
        assert.equal(calls, 0, 'Readability.parse() ran before the 422');
      } finally {
        Readability.prototype.parse = parse;
      }
      assert.ok(performance.now() - t0 < 5000, `took ${performance.now() - t0} ms`);
    });
  }
});

// Readability's _replaceBrs wraps the siblings after a <br> run in <p>; the
// escaped <br> in a body <title> become markup once linkedom serializes the
// title. 79k of them (158k child nodes of the title) stop at the raw check.
// Smaller counts stay inside the budgets and end at the conversion time
// limit (test/convert-pool.test.js).
describe('extractHtml - a body <title> with escaped <br> behind <br> runs', () => {
  it('79k escaped <br> are rejected fast', async () => {
    const html = '<html><body>' + '<span>a<br><br>'.repeat(125) + '<title>T&lt;/title&gt;' + '&lt;br&gt;'.repeat(79_000)
      + '</title>' + '</span>'.repeat(125) + '</body></html>';
    const t0 = performance.now();
    await assert.rejects(extractHtml(html, { extractor: 'readability', recipes: [] }), assertTooComplex);
    assert.ok(performance.now() - t0 < 5000, `took ${performance.now() - t0} ms`);
  });
});

describe('extractHtml - many siblings and a stack overflow inside Readability', () => {
  convertInProcess();

  it('140k empty siblings in body are rejected at the first parse', async () => {
    const html = '<html><body><p>x</p>' + '<b></b>'.repeat(140_000) + '</body></html>';
    const parse = Readability.prototype.parse;
    let calls = 0;
    Readability.prototype.parse = function (...args) { calls++; return parse.apply(this, args); };
    try {
      await assert.rejects(extractHtml(html, { extractor: 'readability', recipes: [] }), assertTooComplex);
    } finally {
      Readability.prototype.parse = parse;
    }
    assert.equal(calls, 0);
  });

  it('a RangeError thrown by Readability.parse() becomes a 422 document_too_complex', async () => {
    const parse = Readability.prototype.parse;
    Readability.prototype.parse = function () { throw new RangeError('Maximum call stack size exceeded'); };
    try {
      await assert.rejects(
        extractHtml('<html><body><p>Some words in a paragraph here.</p></body></html>', { extractor: 'readability', recipes: [] }),
        assertTooComplex,
      );
    } finally {
      Readability.prototype.parse = parse;
    }
  });

  it('other errors from Readability.parse() keep their type', async () => {
    const parse = Readability.prototype.parse;
    Readability.prototype.parse = function () { throw new TypeError('boom'); };
    try {
      await assert.rejects(
        extractHtml('<html><body><p>Some words in a paragraph here.</p></body></html>', { extractor: 'readability', recipes: [] }),
        (err) => err instanceof TypeError && err.message === 'boom',
      );
    } finally {
      Readability.prototype.parse = parse;
    }
  });
});

describe('parse helpers check their own input', () => {
  it('parseHtmlDocument applies the strict check, loadHtml and raw: true the raw-input check', () => {
    const deep = '<div>'.repeat(300);
    assert.throws(() => parseHtmlDocument(deep), assertTooComplex);
    assert.equal(parseHtmlDocument(deep, { raw: true }).document.querySelectorAll('div').length, 300);
    assert.equal(loadHtml(deep)('div').length, 300);
    const bomb = '<div>'.repeat(100_000);
    assert.throws(() => loadHtml(bomb), assertTooComplex);
    assert.throws(() => parseHtmlDocument(bomb, { raw: true }), assertTooComplex);
    assert.equal(parseHtmlDocument('<html><body><p>x</p></body></html>').document.querySelector('p').textContent, 'x');
  });
});

// A chain the raw check admits but parse5's recursive serializer cannot write
// back on the main thread's stack (a worker's is larger, there the strict
// check stops it): 422, not 500.
describe('extractHtml - a stack overflow in preprocess()', () => {
  convertInProcess();

  it('a mail fragment with 6000 nested <div> answers 422 document_too_complex', () => {
    assert.throws(() => htmlFragmentToMarkdown('<div>'.repeat(6000) + 'x'), assertTooComplex);
  });

  it('6000 nested <div> answer 422 document_too_complex', async () => {
    const html = '<div>'.repeat(6000) + 'x';
    assert.doesNotThrow(() => loadHtml(html));
    await assert.rejects(extractHtml(html, { extractor: 'readability', recipes: [] }), assertTooComplex);
  });
});

// Valid HTML with omitted end tags (legacy pages, HN, the WHATWG spec): the
// tree must be the one a browser builds (parse5), and the input check must
// not mistake the end tags htmlparser2 does not imply for nesting.
describe('extractHtml - omitted end tags parse as in a browser', () => {
  const lorem = 'Lorem ipsum dolor sit amet, consectetur adipiscing elit. ';
  const para = (i) => `Paragraph ${i}. ` + lorem.repeat(2);
  const rep = (n, f) => Array.from({ length: n }, (_, i) => f(i)).join('\n');
  const wrap = (b) => `<!DOCTYPE html><html><head><title>T</title></head><body><article><h1>Head</h1>${b}</article></body></html>`;

  it('300 <p><b> paragraphs convert, one paragraph each', async () => {
    const r = await extractHtml(wrap(rep(300, (i) => `<p><b>${para(i)}`)), { extractor: 'readability', recipes: [] });
    assert.equal(r.markdown.match(/^\*+Paragraph \d+\\\./gm)?.length, 300);
  });

  it('a table whose cells hold unclosed <p> keeps every row', async () => {
    const html = wrap(`<p>${para(1)}</p><table>` + rep(40, (i) => `<tr><td><p>r${i}a<td><p>r${i}b`) + `</table><p>${para(2)}</p>`);
    const r = await extractHtml(html, { extractor: 'readability', recipes: [] });
    assert.equal(r.markdown.match(/^\| r\d+a/gm)?.length, 40, r.markdown);
  });

  it('an inlined data: image does not change how the rest parses', async () => {
    const html = wrap(`<p>${para(0)}<img src="data:image/png;base64,AAAA" alt="pic one"></p>` + rep(300, (i) => `<p><b>${para(i)}`));
    const r = await extractHtml(html, { extractor: 'readability', recipes: [] });
    assert.equal(r.markdown.match(/^\*+Paragraph \d+\\\./gm)?.length, 300);
    assert.ok(r.markdown.includes('pic one'));
    assert.ok(!r.markdown.includes('data:'));
  });

  it('a mail fragment with 300 <p><b> paragraphs converts', () => {
    const md = htmlFragmentToMarkdown(rep(300, (i) => `<p><b>${para(i)}`));
    assert.equal(md.match(/\*\*Paragraph \d+\\\./g).length, 300);
  });

  for (const [name, html] of Object.entries({
    'p/b': rep(2000, (i) => `<p><b>${para(i)}`),
    'li/a': '<ul>' + rep(2000, (i) => `<li><a href="/x${i}">Item ${i} ${lorem}`) + '</ul>',
    'dt/b/dd': '<dl>' + rep(2000, (i) => `<dt><b>Term ${i}<dd>${para(i)}`) + '</dl>',
    'td/font': '<table>' + rep(2000, (i) => `<tr><td><font>a${i}<td><font>${lorem}`) + '</table>',
  })) {
    it(`2000 unclosed ${name} items pass the input check`, () => {
      assert.doesNotThrow(() => loadHtml(wrap(html)));
    });
  }

  it('loadHtml builds the parse5 tree', () => {
    const $ = loadHtml('<table><tr><td><p>a<td>b</table><p><b>x<p>y');
    assert.equal($('table > tbody > tr > td').length, 2);
    assert.equal($('body > p').length, 2);
  });

  it('100k nested <div> are still rejected in under 1 s', () => {
    const t0 = performance.now();
    assert.throws(() => loadHtml('<div>'.repeat(100_000)), assertTooComplex);
    assert.ok(performance.now() - t0 < 1000, `took ${performance.now() - t0} ms`);
  });
});
