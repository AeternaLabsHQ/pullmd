import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { preprocess } from '../lib/preprocess.js';

describe('preprocess — Pattern 1 (paywall / aria-hidden paragraphs)', () => {
  it('strips aria-hidden and paywall class from <p>, keeps the text', () => {
    const html = `<html><body><article>
      <p>Visible paragraph one with enough text to be substantial.</p>
      <p id="x" class="paywall foo" aria-hidden="true">"Whatever you say" was the quote.</p>
      <p>Visible paragraph three with enough text to be substantial.</p>
    </article></body></html>`;
    const out = preprocess(html);
    assert.ok(out.includes('"Whatever you say"'), 'paywall paragraph text must survive');
    assert.ok(!/class="[^"]*paywall[^"]*"/.test(out), 'paywall class must be stripped');
    assert.ok(!/aria-hidden="true"/.test(out), 'aria-hidden must be stripped');
    assert.ok(/class="foo"/.test(out), 'other classes on the same paragraph must remain');
  });

  it('removes the class attribute entirely if paywall was the only class', () => {
    const html = `<html><body><p class="paywall" aria-hidden="true">Quote</p></body></html>`;
    const out = preprocess(html);
    assert.ok(!/class=/.test(out), 'class attribute should be removed when only paywall was set');
    assert.ok(!/aria-hidden/.test(out));
    assert.ok(out.includes('Quote'));
  });

  it('does not touch <div aria-hidden="true">', () => {
    const html = `<html><body><div aria-hidden="true">decorative</div></body></html>`;
    const out = preprocess(html);
    assert.ok(/aria-hidden="true"/.test(out), 'aria-hidden on non-<p> elements must be left alone');
  });

  it('does not touch <span aria-hidden="true">', () => {
    const html = `<html><body><p>Real <span aria-hidden="true">×</span> text</p></body></html>`;
    const out = preprocess(html);
    assert.ok(/<span[^>]*aria-hidden="true"[^>]*>/.test(out), 'icon spans must keep their aria-hidden');
  });

  it('passes plain HTML through unchanged in shape', () => {
    const html = `<html><body><article><p>Just a normal paragraph.</p></article></body></html>`;
    const out = preprocess(html);
    assert.ok(out.includes('<p>Just a normal paragraph.</p>'));
  });
});

describe('preprocess — Pattern 2 (widget tokens on article-body container)', () => {
  function bodyWithParagraphs(divClass) {
    const longP = (i) =>
      `<p>Paragraph ${i} with enough body text to clear the eighty-character substantial-paragraph threshold so it counts toward the article-body heuristic.</p>`;
    return `<html><body><div class="${divClass}">${[1, 2, 3, 4, 5, 6].map(longP).join('')}</div></body></html>`;
  }

  it('strips flw-widget-newsletter when the div has 5+ substantial paragraphs', () => {
    const html = bodyWithParagraphs('clear-both widget widget-content flw-article-text-content flw-widget-newsletter flw-author-bio');
    const out = preprocess(html);
    assert.ok(!/flw-widget-newsletter/.test(out), 'widget-newsletter token must be stripped');
    assert.ok(/flw-article-text-content/.test(out), 'unrelated flw-* tokens must remain');
  });

  it('strips flw-article-recirculation-v1 alongside other widget tokens', () => {
    const html = bodyWithParagraphs('widget flw-article-recirculation-v1 flw-widget-newsletter flw-article-image-caption');
    const out = preprocess(html);
    assert.ok(!/flw-article-recirculation-v1/.test(out));
    assert.ok(!/flw-widget-newsletter/.test(out));
    assert.ok(/flw-article-image-caption/.test(out));
  });

  it('does NOT strip widget tokens from a real newsletter <div> (no body paragraphs)', () => {
    const html = `<html><body>
      <div class="widget-newsletter">
        <h3>Subscribe</h3>
        <form><input type="email"><button>Sign up</button></form>
        <p>One short tagline.</p>
      </div>
    </body></html>`;
    const out = preprocess(html);
    assert.ok(/widget-newsletter/.test(out), 'real newsletter widgets must keep their class');
  });

  it('does NOT trigger when paragraphs are too short', () => {
    const html = `<html><body><div class="flw-widget-newsletter">
      <p>Short one</p><p>Another short</p><p>Yet another</p><p>Fourth</p><p>Fifth</p><p>Sixth</p>
    </div></body></html>`;
    const out = preprocess(html);
    assert.ok(/flw-widget-newsletter/.test(out), '<80-char paragraphs must not satisfy the article-body heuristic');
  });

  it('removes the class attribute when widget tokens were the only classes (edge case)', () => {
    const html = bodyWithParagraphs('flw-widget-newsletter');
    const out = preprocess(html);
    assert.ok(!/flw-widget-newsletter/.test(out));
  });
});

describe('preprocess — Pattern 3 (Webflow w-embed wrapping a table)', () => {
  it('strips the w-embed token from a div that wraps a table, keeps the table', () => {
    const html = `<html><body><h2>Schnellvergleich</h2><div class="w-embed"><div class="c-table-wrap">
      <table><tr><th>Anbieter</th></tr><tr><td>Kontist</td></tr></table>
    </div></div></body></html>`;
    const out = preprocess(html);
    assert.ok(!/w-embed/.test(out), 'w-embed token must be stripped');
    assert.ok(out.includes('<td>Kontist</td>'), 'table must survive');
  });

  it('keeps sibling classes on the embed div', () => {
    const html = `<html><body><div class="foo w-embed bar"><table><tr><td>x</td></tr></table></div></body></html>`;
    const out = preprocess(html);
    assert.ok(/class="foo bar"/.test(out), 'other classes must remain');
  });

  it('does not touch a w-embed without a table (icon / widget embeds)', () => {
    const html = `<html><body><div class="c-svg is-accordion w-embed"><svg width="12" height="8"></svg></div></body></html>`;
    const out = preprocess(html);
    assert.ok(/class="c-svg is-accordion w-embed"/.test(out), 'non-table embeds must keep w-embed');
  });
});

describe('preprocess — robustness', () => {
  it('returns input unchanged for empty / non-string', () => {
    assert.equal(preprocess(''), '');
    assert.equal(preprocess(null), null);
    assert.equal(preprocess(undefined), undefined);
  });

  it('does not crash on malformed HTML', () => {
    const html = `<html><body><p class="paywall" aria-hidden="true">Unclosed`;
    assert.doesNotThrow(() => preprocess(html));
  });
});
