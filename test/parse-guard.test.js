import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import {
  inspectMarkup, isTooComplex, loadHtml, parseHtmlDocument, serializeHtml,
  MAX_NESTING_DEPTH, MAX_DEPTH_SUM, MAX_HTML_ELEMENTS, MAX_TEXT_NODES, MAX_CHILD_NODES, MAX_ATTRIBUTES, WEB_HTML_LIMITS,
} from '../lib/parse-guard.js';
import { htmlFragmentToMarkdown, extractHtml } from '../lib/web.js';
import { Readability } from '@mozilla/readability';

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

describe('loadHtml', () => {
  it('parses with htmlparser2: <svg><title> content stays text', () => {
    const $ = loadHtml('<svg><title><div><div></title></svg>');
    assert.equal($('div').length, 0);
  });

  it('adds the html/head/body skeleton parse5 would add', () => {
    assert.equal(loadHtml('<title>T</title><p>x</p>').html(), '<html><head><title>T</title></head><body><p>x</p></body></html>');
    assert.equal(loadHtml('<!DOCTYPE html><html lang="de"><head><title>T</title></head><p>x</p></html>').html(),
      '<!DOCTYPE html><html lang="de"><head><title>T</title></head><body><p>x</p></body></html>');
    const full = '<!doctype html>\n<html>\n<head><title>t</title></head>\n<body><p>x</p></body>\n</html>\n';
    assert.equal(loadHtml(full).html(), full);
  });

  it('decodes text and attributes and escapes only what HTML needs', () => {
    const $ = loadHtml('<p title="a&amp;b">&lt;x&gt; &auml;</p>');
    assert.equal($('p').text(), '<x> \u00e4');
    assert.equal($('p').attr('title'), 'a&b');
    assert.equal($('body').html(), '<p title="a&amp;b">&lt;x&gt; \u00e4</p>');
  });

  it('selects in linear time on many top-level nodes', () => {
    const t0 = performance.now();
    const $ = loadHtml('<a></a>'.repeat(100_000));
    assert.equal($('a').length, 100_000);
    assert.ok(performance.now() - t0 < 2000, `took ${performance.now() - t0} ms`);
  });
});

// Content that htmlparser2 reads as raw text but parse5 would nest: the
// guard and every parser in the pipeline must agree on the tree.
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

describe('serializeHtml', () => {
  for (const tag of ['noscript', 'iframe', 'noembed', 'noframes', 'xmp']) {
    it(`keeps escaped text inside <${tag}> escaped`, () => {
      const out = serializeHtml(loadHtml(`<p>x</p><${tag}>&lt;img src=x onerror=alert(1)&gt;</${tag}>`));
      assert.ok(out.includes(`<${tag}>&lt;img src=x onerror=alert(1)&gt;</${tag}>`), out);
      assert.ok(!out.includes('<img'), out);
    });
  }

  it('keeps escaped text inside <plaintext> escaped', () => {
    const out = serializeHtml(loadHtml('<p>x</p><plaintext>&lt;b&gt;'));
    assert.ok(out.includes('<plaintext>&lt;b&gt;</plaintext>'), out);
  });

  it('leaves script, style and xmp untouched and escapes normal text once', () => {
    const out = serializeHtml(loadHtml('<script>if (a < b && c) x()</script><style>a > b {}</style><xmp><b></xmp><p>&lt;x&gt; &amp;</p>'));
    assert.ok(out.includes('<xmp><b></xmp>'), out);
    assert.ok(out.includes('<script>if (a < b && c) x()</script>'), out);
    assert.ok(out.includes('<style>a > b {}</style>'), out);
    assert.ok(out.includes('<p>&lt;x&gt; &amp;</p>'), out);
  });

  it('does not change the tree it serializes', () => {
    const $ = loadHtml('<noscript>&lt;b&gt;</noscript>');
    serializeHtml($);
    assert.equal($('noscript').text(), '<b>');
  });
});

// Elements dom-serializer writes back unescaped: their decoded text must not
// turn into markup for linkedom after preprocess().
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

// The same title serialization inside <body>: parseHtmlDocument() turns a
// body <title> into a text node, and the serialized body is checked once more
// before Readability runs. The spy proves the order: a 422 must come before
// Readability.parse(). All three stop at the first parse: 99k has about 198k
// text nodes inside one element (MAX_CHILD_NODES), 150k and 199k are over
// MAX_TEXT_NODES as well. The <br> case below stays inside every budget and
// exercises the neutralised title itself.
describe('extractHtml - escaped markup in a body <title>', () => {
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

describe('parseHtmlDocument - <title> outside <head>', () => {
  it('turns a body <title> into a text node and keeps the head title', () => {
    const { document } = parseHtmlDocument('<html><head><title>Head &amp; T</title></head>'
      + '<body><p>x</p><title>T&lt;/title&gt;&lt;br&gt;</title><svg><title>S&lt;b&gt;</title></svg></body></html>');
    assert.equal(document.querySelector('head > title').textContent, 'Head & T');
    assert.equal(document.querySelector('body title:not(svg title)'), null);
    assert.ok(document.body.textContent.includes('T</title><br>'));
    assert.ok(document.body.innerHTML.includes('T&lt;/title&gt;&lt;br&gt;'));
    assert.ok(!document.body.innerHTML.includes('<br>'));
    // The svg title is an SVGElement and serializes escaped on its own.
    assert.equal(document.querySelector('svg title').textContent, 'S<b>');
    assert.ok(document.body.innerHTML.includes('<svg><title>S&lt;b&gt;</title></svg>'));
  });

  it('keeps the head title for metadata and shows the body title as text', async () => {
    const html = '<html><head><title>Head Title</title></head><body><p>Some words in a paragraph here.</p>'
      + '<title>Body &lt;b&gt;bold&lt;/b&gt; text</title><p>More words in another paragraph.</p></body></html>';
    const r = await extractHtml(html, { extractor: 'readability', recipes: [] });
    assert.equal(r.title, 'Head Title');
    assert.ok(r.markdown.includes('bold'), r.markdown);
    assert.ok(!/\*\*bold\*\*/.test(r.markdown), 'body title content became markup');
  });

  // Readability's _replaceBrs wraps the siblings after a <br> run in <p>, so
  // the string it caches can be deeper than the body checked before parse().
  // With the body title gone there is no markup left to grow: 45k escaped
  // <br> (90k text nodes, inside every budget) convert as text, and 79k (the
  // original probe, 158k child nodes of the title) stop at the first parse.
  for (const n of [45_000, 79_000]) {
    it(`a body <title> with ${n / 1000}k escaped <br> behind <br> runs answers fast, 200 or 422`, async () => {
      const html = '<html><body>' + '<span>a<br><br>'.repeat(125) + '<title>T&lt;/title&gt;' + '&lt;br&gt;'.repeat(n)
        + '</title>' + '</span>'.repeat(125) + '</body></html>';
      const t0 = performance.now();
      try {
        const r = await extractHtml(html, { extractor: 'readability', recipes: [] });
        assert.equal(typeof r.markdown, 'string');
        assert.equal(n, 45_000, 'expected the 79k case to stop at the first parse');
      } catch (err) {
        assertTooComplex(err);
        assert.equal(n, 79_000, 'expected the 45k case to convert');
      }
      assert.ok(performance.now() - t0 < 5000, `took ${performance.now() - t0} ms`);
    });
  }
});

describe('extractHtml - many siblings and a stack overflow inside Readability', () => {
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
  it('loadHtml and parseHtmlDocument reject over-nested markup', async () => {
    const { parseHtmlDocument } = await import('../lib/parse-guard.js');
    assert.throws(() => loadHtml('<div>'.repeat(300)), assertTooComplex);
    assert.throws(() => parseHtmlDocument('<div>'.repeat(300)), assertTooComplex);
    assert.equal(parseHtmlDocument('<html><body><p>x</p></body></html>').document.querySelector('p').textContent, 'x');
  });
});
