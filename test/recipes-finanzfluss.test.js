import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { RecipeSchema } from '../lib/recipes.js';
import { extractHtml } from '../lib/web.js';

const recipes = JSON.parse(fs.readFileSync(new URL('../site-recipes.default.json', import.meta.url), 'utf8'))
  .map((r) => RecipeSchema.parse(r));

const PAGE_URL = 'https://www.finanzfluss.de/vergleich/geschaeftskonto/';
const PROSE = 'Ein Geschäftskonto ist ein Girokonto, das für den geschäftlichen Zahlungsverkehr gedacht ist. Die Grundfunktionen wie Überweisungen, Lastschriften und Bargeldauszahlung entsprechen denen eines klassischen Girokontos, dazu kommen Unterkonten und Schnittstellen.';

const GRID = 'grid-template-columns:repeat(3, var(--cell-width))';
const label = (key, text) => `<div class="sticky" data-column-key="${key}"><span class="font-semibold">${text}</span></div>`;
const tip = '<div role="button"><div class="tooltip-icon tooltip-info"><svg></svg></div><span class="sr-only">Tooltip anzeigen</span></div>';

// Shape of the Nuxt comparison widget: a header grid (rank row + product
// names) and a body grid, both 1 label column + 2 products, plus a hidden
// sticky CTA footer grid.
const PAGE = `<html><head><title>Geschäftskonto-Vergleich</title></head><body><main>
<div data-cy="vergleich-geschaeftskonto">
  <div class="intro">
    <div class="title-container"><h1>Geschäftskonto-Vergleich 2026</h1></div>
    <div class="grid"><div class="content"><h2>Die besten Firmenkonten</h2><p>Intro zum Vergleich.</p></div></div>
  </div>
  <div><div id="comparison-content">
    <div class="cards md:hidden"><p>MOBILE-CARD duplicate</p></div>
    <div data-cy="comparison-table-desktop"><div class="relative">
      <div class="sticky"><div class="grid" style="${GRID}">
        ${label('provider', 'Anbieter')}<div data-cy="cell_provider">1 Bestes Konto</div><div data-cy="cell_provider">2</div>
        ${label('label', 'Konto')}<div data-cy="cell_label"><span>FYRST BASE</span>${tip}</div><div data-cy="cell_label"><span>N26 Business</span></div>
      </div></div>
      <div class="grid" style="${GRID}">
        ${label('url', 'Angebot')}<div data-cy="cell_url"><a href="#">Zum Angebot</a></div><div data-cy="cell_url"><a href="#">Zum Angebot</a></div>
        ${label('fee', 'Kontoführungsgebühr')}<div><p>0€</p></div><div><p>4,90€</p></div>
        ${label('debitcard', 'Debitkarte')}<div><img alt="Mastercard" src="x.svg"><p>0€</p></div><div><img alt="VISA" src="y.svg"><p>0€</p></div>
        ${label('branches', 'Filialen')}<div><span class="iconify i-ff:no" aria-hidden="true"></span></div><div><span class="iconify i-ff:yes" aria-hidden="true"></span></div>
        ${label('support', 'Support')}<div><span role="img" aria-label="E-Mail"></span><span role="img" aria-label="Chat"></span></div><div><span role="img" aria-label="Telefon"></span></div>
        ${label('country', 'Einlagensicherung')}<div><span class="flag f-de"></span><span class="sr-only">DE</span>${tip}</div><div><span class="sr-only">FR</span></div>
      </div>
      <div class="invisible"><div class="grid" style="${GRID}">${label('url', 'Angebot')}<div>Zum Angebot</div><div>Zum Angebot</div></div></div>
    </div></div>
  </div></div>
  <div class="content-container"><nav>Home Vergleich</nav><div class="wp-content"><h2>Die besten Geschäftskonten aus unserem Test</h2><p>${PROSE}</p><div class="card"><div class="cta-mobile"><p>MOBILE-CTA Fyrst Base</p></div><div class="cta-desktop"><p>DESKTOP-CTA Fyrst Base</p></div></div></div></div>
</div>
</main></body></html>`;

describe('finanzfluss-vergleich recipe', () => {
  it('turns the comparison grid into a table between intro and article', async () => {
    const { markdown, source } = await extractHtml(PAGE, { url: PAGE_URL, recipes, extractor: 'readability' });
    assert.equal(source, 'recipe-content');
    const rows = markdown.split('\n').filter((l) => l.startsWith('|')).map((l) => l.split('|').map((c) => c.trim()).slice(1, -1));
    assert.deepEqual(rows[0], ['Konto', 'FYRST BASE', 'N26 Business']);
    assert.deepEqual(rows.slice(2), [
      ['Kontoführungsgebühr', '0€', '4,90€'],
      ['Debitkarte', 'Mastercard 0€', 'VISA 0€'],
      ['Filialen', 'nein', 'ja'],
      ['Support', 'E-MailChat', 'Telefon'],
      ['Einlagensicherung', 'DE', 'FR'],
    ]);
    assert.ok(markdown.indexOf('Intro zum Vergleich') < markdown.indexOf('| Konto'));
    assert.ok(markdown.indexOf('| Konto') < markdown.indexOf('aus unserem Test'));
    assert.doesNotMatch(markdown, /Tooltip anzeigen|Zum Angebot|MOBILE-CARD|Bestes Konto/);
  });

  it('keeps only the desktop variant of the product cards', async () => {
    const { markdown } = await extractHtml(PAGE, { url: PAGE_URL, recipes, extractor: 'readability' });
    assert.match(markdown, /DESKTOP-CTA/);
    assert.doesNotMatch(markdown, /MOBILE-CTA/);
  });

  it('emits the table without column padding', async () => {
    const { markdown } = await extractHtml(PAGE, { url: PAGE_URL, recipes, extractor: 'readability' });
    assert.match(markdown, /^\| Konto \| FYRST BASE \| N26 Business \|$/m);
    assert.match(markdown, /^\| --- \| --- \| --- \|$/m);
  });
});
