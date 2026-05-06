import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { applyPreprocessActions } from '../lib/recipes.js';

describe('applyPreprocessActions — remove-attr', () => {
  it('removes the named attribute from matching elements', () => {
    const html = '<p aria-hidden="true">x</p><p aria-hidden="true">y</p>';
    const out = applyPreprocessActions(html, [
      { action: 'remove-attr', selector: 'p', attr: 'aria-hidden' },
    ]);
    assert.equal(out.includes('aria-hidden'), false);
    assert.ok(out.includes('<p>x</p>'));
  });

  it('leaves non-matching elements alone', () => {
    const html = '<p aria-hidden="true">x</p><div aria-hidden="true">y</div>';
    const out = applyPreprocessActions(html, [
      { action: 'remove-attr', selector: 'p', attr: 'aria-hidden' },
    ]);
    assert.ok(out.includes('<div aria-hidden="true">y</div>'));
  });
});

describe('applyPreprocessActions — remove-class', () => {
  it('removes the named class token, preserving others', () => {
    const html = '<p class="foo paywall bar">x</p>';
    const out = applyPreprocessActions(html, [
      { action: 'remove-class', selector: 'p', class: 'paywall' },
    ]);
    assert.ok(out.includes('class="foo bar"') || out.includes('class="foo  bar"'));
    assert.equal(out.includes('paywall'), false);
  });

  it('removes the class attribute entirely if the only token is removed', () => {
    const html = '<p class="paywall">x</p>';
    const out = applyPreprocessActions(html, [
      { action: 'remove-class', selector: 'p', class: 'paywall' },
    ]);
    assert.equal(out.includes('class='), false);
  });
});

describe('applyPreprocessActions — remove-element', () => {
  it('removes the matching element and its descendants', () => {
    const html = '<article><p>keep</p><aside class="ads"><p>drop</p></aside></article>';
    const out = applyPreprocessActions(html, [
      { action: 'remove-element', selector: 'aside.ads' },
    ]);
    assert.equal(out.includes('drop'), false);
    assert.ok(out.includes('keep'));
  });
});

describe('applyPreprocessActions — unwrap', () => {
  it('replaces element with its children', () => {
    const html = '<p>hello <span class="wrap">world</span>!</p>';
    const out = applyPreprocessActions(html, [
      { action: 'unwrap', selector: 'span.wrap' },
    ]);
    assert.ok(out.includes('hello world!'));
    assert.equal(out.includes('<span'), false);
  });
});

describe('applyPreprocessActions — robustness', () => {
  it('returns original HTML when actions list is empty', () => {
    const html = '<p>x</p>';
    assert.equal(applyPreprocessActions(html, []), html);
  });

  it('no-op when selector matches nothing', () => {
    const html = '<p>x</p>';
    const out = applyPreprocessActions(html, [
      { action: 'remove-attr', selector: 'div', attr: 'foo' },
    ]);
    assert.ok(out.includes('<p>x</p>'));
  });

  it('returns input unchanged when html is empty/null', () => {
    assert.equal(applyPreprocessActions('', []), '');
    assert.equal(applyPreprocessActions(null, []), null);
  });

  it('applies multiple actions in order', () => {
    const html = '<p aria-hidden="true" class="paywall foo">x</p>';
    const out = applyPreprocessActions(html, [
      { action: 'remove-attr', selector: 'p', attr: 'aria-hidden' },
      { action: 'remove-class', selector: 'p', class: 'paywall' },
    ]);
    assert.equal(out.includes('aria-hidden'), false);
    assert.equal(out.includes('paywall'), false);
    assert.ok(out.includes('foo'));
  });
});
