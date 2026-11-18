import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import {
  inspectMarkup, isTooComplex, loadHtml, serializeHtml, MAX_NESTING_DEPTH, MAX_DEPTH_SUM, MAX_HTML_ELEMENTS, MAX_TEXT_NODES, WEB_HTML_LIMITS,
} from '../lib/parse-guard.js';
import { htmlFragmentToMarkdown, extractHtml } from '../lib/web.js';

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
    assert.deepEqual(WEB_HTML_LIMITS, { maxDepthSum: MAX_DEPTH_SUM, maxElements: MAX_HTML_ELEMENTS, maxTextNodes: MAX_TEXT_NODES });
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

  it('rejects flat documents over the element budget', () => {
    assert.throws(() => inspectMarkup('<a></a>'.repeat(MAX_HTML_ELEMENTS + 1), WEB_HTML_LIMITS), assertTooComplex);
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
      assert.ok(performance.now() - t0 < 2000, `took ${performance.now() - t0} ms`);
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
      assert.ok(performance.now() - t0 < 2000, `took ${performance.now() - t0} ms`);
    });
  }
});
