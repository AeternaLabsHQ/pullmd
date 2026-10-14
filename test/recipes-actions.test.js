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

describe('applyPreprocessActions — replace-with-text', () => {
  it('replaces matching elements with a fixed text', () => {
    const html = '<div class="cell"><span class="icon yes"></span></div><div class="cell"><span class="icon no"></span></div>';
    const out = applyPreprocessActions(html, [
      { action: 'replace-with-text', selector: '.yes', text: 'ja' },
      { action: 'replace-with-text', selector: '.no', text: 'nein' },
    ]);
    assert.ok(out.includes('<div class="cell">ja</div>'));
    assert.ok(out.includes('<div class="cell">nein</div>'));
  });

  it('uses an attribute value when attr is given', () => {
    const html = '<p><span role="img" aria-label="E-Mail"></span><span role="img" aria-label="Chat"></span></p>';
    const out = applyPreprocessActions(html, [
      { action: 'replace-with-text', selector: '[role=img]', attr: 'aria-label' },
    ]);
    assert.ok(out.includes('<p>E-MailChat</p>'));
    assert.equal(out.includes('<span'), false);
  });

  it('escapes the inserted text', () => {
    const out = applyPreprocessActions('<p><i class="x"></i></p>', [
      { action: 'replace-with-text', selector: '.x', text: '<b>' },
    ]);
    assert.ok(out.includes('&lt;b&gt;'));
  });

  it('drops the element when attr is missing on it', () => {
    const out = applyPreprocessActions('<p>a<i class="x"></i>b</p>', [
      { action: 'replace-with-text', selector: '.x', attr: 'aria-label' },
    ]);
    assert.ok(out.includes('<p>ab</p>'));
  });
});

describe('applyPreprocessActions — prepend-text', () => {
  it('inserts escaped text before the existing content', () => {
    const out = applyPreprocessActions('<ul><li class="pro"><span>Gratis</span></li><li class="con">Teuer</li></ul>', [
      { action: 'prepend-text', selector: 'li.pro', text: 'Vorteil: ' },
      { action: 'prepend-text', selector: 'li.con', text: '<Nachteil> ' },
    ]);
    assert.ok(out.includes('<li class="pro">Vorteil: <span>Gratis</span></li>'));
    assert.ok(out.includes('<li class="con">&lt;Nachteil&gt; Teuer</li>'));
  });
});

describe('applyPreprocessActions — grid-to-table', () => {
  const grid = (cols, cells, style = `grid-template-columns:repeat(${cols}, 1fr)`) =>
    `<div style="${style}">${cells.map((c) => `<div>${c}</div>`).join('')}</div>`;

  it('turns a CSS grid into a table, first row as header', () => {
    const html = `<section id="cmp">${grid(3, ['', 'A', 'B', 'Fee', '0€', '5€', 'Card', 'yes', 'no'])}</section>`;
    const out = applyPreprocessActions(html, [{ action: 'grid-to-table', selector: '#cmp' }]);
    assert.ok(out.includes('<table>'));
    assert.ok(out.includes('<thead><tr><th></th><th>A</th><th>B</th></tr></thead>'));
    assert.ok(out.includes('<tr><td>Fee</td><td>0€</td><td>5€</td></tr>'));
    assert.ok(out.includes('<tr><td>Card</td><td>yes</td><td>no</td></tr>'));
    assert.equal(out.includes('<section'), false, 'container is replaced by the table');
  });

  it('merges several grids inside one container in document order', () => {
    const html = `<div id="cmp"><div class="head">${grid(2, ['', 'A'])}</div>${grid(2, ['Fee', '0€', 'Card', 'yes'])}</div>`;
    const out = applyPreprocessActions(html, [{ action: 'grid-to-table', selector: '#cmp' }]);
    assert.equal((out.match(/<table>/g) || []).length, 1);
    assert.ok(out.includes('<th>A</th>'));
    assert.ok(out.includes('<tr><td>Fee</td><td>0€</td></tr><tr><td>Card</td><td>yes</td></tr>'));
  });

  it('works when the selector matches the grid itself', () => {
    const html = `<p>x</p>${grid(2, ['h1', 'h2', 'a', 'b']).replace('<div style', '<div id="g" style')}`;
    const out = applyPreprocessActions(html, [{ action: 'grid-to-table', selector: '#g' }]);
    assert.ok(out.includes('<th>h1</th><th>h2</th>'));
    assert.ok(out.includes('<td>a</td><td>b</td>'));
  });

  it('counts explicit tracks when there is no repeat()', () => {
    const html = `<div id="cmp">${grid(0, ['h1', 'h2', 'h3', 'a', 'b', 'c'], 'display:grid;grid-template-columns: 200px 1fr minmax(0, 2fr)')}</div>`;
    const out = applyPreprocessActions(html, [{ action: 'grid-to-table', selector: '#cmp' }]);
    assert.ok(out.includes('<td>a</td><td>b</td><td>c</td>'));
  });

  it('uses the columns option over the inline style', () => {
    const html = `<div id="cmp"><div class="g">${['h1', 'h2', 'a', 'b'].map((c) => `<div>${c}</div>`).join('')}</div></div>`;
    const out = applyPreprocessActions(html, [{ action: 'grid-to-table', selector: '#cmp .g', columns: 2 }]);
    assert.ok(out.includes('<th>h1</th><th>h2</th>'));
    assert.ok(out.includes('<td>a</td><td>b</td>'));
  });

  it('flattens cell content to text, separating block children', () => {
    const html = `<div id="cmp">${grid(2, ['', 'A', 'Forms', '<div><p>GmbH</p><p>UG</p></div>'])}</div>`;
    const out = applyPreprocessActions(html, [{ action: 'grid-to-table', selector: '#cmp' }]);
    assert.ok(out.includes('<td>GmbH UG</td>'));
  });

  it('pads a short last row', () => {
    const html = `<div id="cmp">${grid(3, ['a', 'b', 'c', 'd'])}</div>`;
    const out = applyPreprocessActions(html, [{ action: 'grid-to-table', selector: '#cmp' }]);
    assert.ok(out.includes('<tr><td>d</td><td></td><td></td></tr>'));
  });

  it('leaves the container alone when no column count can be found', () => {
    const html = '<div id="cmp"><div>a</div><div>b</div></div>';
    const out = applyPreprocessActions(html, [{ action: 'grid-to-table', selector: '#cmp' }]);
    assert.equal(out.includes('<table>'), false);
    assert.ok(out.includes('<div id="cmp">'));
  });

  it('escapes cell text', () => {
    const html = `<div id="cmp">${grid(1, ['h', '&lt;script&gt;'])}</div>`;
    const out = applyPreprocessActions(html, [{ action: 'grid-to-table', selector: '#cmp' }]);
    assert.ok(out.includes('<td>&lt;script&gt;</td>'));
  });
});
