import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { RecipeSchema, mergeRecipes } from '../lib/recipes.js';
import { extractHtml, extractWeb } from '../lib/web.js';

const block = (over = {}) => ({
  title: 'Trend',
  script: '#ng-state',
  path: ['a/b', 'rows'],
  ...over,
});

const parse = (append) => RecipeSchema.parse({ name: 't', host: 'example.com', append });

describe('recipe append schema', () => {
  it('defaults append to an empty array', () => {
    assert.deepEqual(RecipeSchema.parse({ name: 't', host: 'example.com' }).append, []);
  });

  it('accepts a block and defaults limit to 200', () => {
    const r = parse([block()]);
    assert.equal(r.append.length, 1);
    assert.equal(r.append[0].limit, 200);
  });

  it('accepts integer path segments', () => {
    assert.deepEqual(parse([block({ path: ['days', 0, 'hours'] })]).append[0].path, ['days', 0, 'hours']);
  });

  it('accepts a fields map of segment arrays', () => {
    const r = parse([block({ fields: { max_c: ['t', 'max'] } })]);
    assert.deepEqual(r.append[0].fields.max_c, ['t', 'max']);
  });

  it('rejects an empty path', () => {
    assert.throws(() => parse([block({ path: [] })]));
  });

  it('rejects a missing title and an over-long one', () => {
    assert.throws(() => parse([block({ title: undefined })]));
    assert.throws(() => parse([block({ title: 'x'.repeat(121) })]));
  });

  it('accepts a title of exactly 120 characters', () => {
    const title = 'x'.repeat(120);
    assert.equal(parse([block({ title })]).append[0].title, title);
  });

  it('rejects an empty title', () => {
    assert.throws(() => parse([block({ title: '' })]));
  });

  it('rejects limit outside 1..1000', () => {
    assert.throws(() => parse([block({ limit: 0 })]));
    assert.throws(() => parse([block({ limit: 1001 })]));
  });

  it('accepts limit at the 1..1000 boundaries', () => {
    assert.equal(parse([block({ limit: 1 })]).append[0].limit, 1);
    assert.equal(parse([block({ limit: 1000 })]).append[0].limit, 1000);
  });

  it('rejects an unknown key inside a block', () => {
    assert.throws(() => parse([block({ format: 'table' })]));
  });

  it('rejects an invalid field name', () => {
    assert.throws(() => parse([block({ fields: { '1bad': ['x'] } })]));
  });
});

describe('mergeRecipes append', () => {
  it('concatenates append blocks across matching recipes in order', () => {
    const merged = mergeRecipes([
      parse([block({ title: 'A' })]),
      parse([block({ title: 'B' })]),
    ]);
    assert.deepEqual(merged.appendBlocks.map((b) => b.title), ['A', 'B']);
  });

  it('yields an empty list when no recipe defines append', () => {
    assert.deepEqual(mergeRecipes([]).appendBlocks, []);
  });
});

const PROSE = 'This paragraph is deliberately long enough that the recipe-selected body clears the minimum length floor on its own, without help from any of the surrounding blocks on the page. The floor exists to catch selectors that have gone stale after a site redesign.';

const STATE = JSON.stringify({
  'p_city_local/forecast': {
    longTerm: [
      { date: '2026-08-08', t: { max: 26 } },
      { date: '2026-08-09', t: { max: 34 } },
    ],
  },
});

const PAGE = `<html><head><title>Doc</title>
  <script id="ng-state" type="application/json">${STATE}</script></head><body>
  <div class="lead"><p>LEAD ${PROSE}</p></div>
</body></html>`;

const APPEND = [{
  title: 'Trend',
  script: '#ng-state',
  path: ['p_city_local/forecast', 'longTerm'],
  fields: { datum: ['date'], max_c: ['t', 'max'] },
}];

const recipeWith = (extra) => RecipeSchema.parse({
  name: 'append-it', host: 'example.com', append: APPEND, ...extra,
});

describe('append blocks in the extraction pipeline', () => {
  it('appends the block on the recipe-content path', async () => {
    const r = await extractHtml(PAGE, {
      url: 'https://example.com/a',
      recipes: [recipeWith({ select: { content: ['.lead'] } })],
      extractor: 'readability',
    });
    assert.equal(r.source, 'recipe-content');
    assert.ok(r.markdown.includes('LEAD'), 'body must still be there');
    assert.match(r.markdown, /## Trend\n\n```json\n/);
    assert.ok(r.markdown.trimEnd().endsWith('```'), 'block must sit at the very end');
    assert.ok(r.markdown.includes('{"datum":"2026-08-08","max_c":26}'));
    assert.match(r.metadata.extractorReason, /append: Trend \(2 Zeilen\)/);
  });

  it('appends the block on the readability path too', async () => {
    const r = await extractHtml(PAGE, {
      url: 'https://example.com/a',
      recipes: [recipeWith({})],
      extractor: 'readability',
    });
    assert.notEqual(r.source, 'recipe-content');
    assert.match(r.markdown, /## Trend\n/);
  });

  it('leaves quality untouched but grows contentLength', async () => {
    const opts = { url: 'https://example.com/a', extractor: 'readability' };
    const plain = await extractHtml(PAGE, { ...opts, recipes: [RecipeSchema.parse({ name: 'n', host: 'example.com' })] });
    const withBlock = await extractHtml(PAGE, { ...opts, recipes: [recipeWith({})] });
    assert.equal(withBlock.metadata.quality, plain.metadata.quality);
    assert.ok(withBlock.metadata.contentLength > plain.metadata.contentLength);
  });

  it('changes nothing when the recipe has no append blocks', async () => {
    const r = await extractHtml(PAGE, {
      url: 'https://example.com/a',
      recipes: [RecipeSchema.parse({ name: 'n', host: 'example.com' })],
      extractor: 'readability',
    });
    assert.ok(!r.markdown.includes('```json'));
    assert.ok(!/append:/.test(r.metadata.extractorReason || ''));
  });

  it('degrades to the plain document when the path is stale', async () => {
    const stale = RecipeSchema.parse({
      name: 'stale', host: 'example.com',
      append: [{ ...APPEND[0], path: ['p_city_local/forecast', 'gone'] }],
    });
    const r = await extractHtml(PAGE, { url: 'https://example.com/a', recipes: [stale], extractor: 'readability' });
    assert.ok(r.markdown.includes('LEAD'));
    assert.ok(!r.markdown.includes('```json'));
  });
});

describe('append blocks do not leak into the render decision', () => {
  // The static extraction here is deliberately thin: forcing extractor=trafilatura
  // with no sidecar configured always produces an extractorReason containing
  // "fell back to ..." (see convertWithReadability), and the body is short
  // enough that the base result.markdown (header + body, WITHOUT the append
  // block) stays under the 500-char renderDecision floor. quality is kept
  // >=0.5 (article tag + heading + a healthy markdown/rawHtml ratio) so the
  // "low quality" trigger cannot also explain a render - only the "thin (<500c)"
  // trigger can. The append block itself is sized well past 500 chars, so if
  // it were attached to result.markdown BEFORE renderDecision ran, the "thin"
  // trigger would falsely read as satisfied and skip the Playwright call.
  const rows = [];
  for (let i = 0; i < 20; i++) {
    rows.push({ date: `2026-08-${String(i + 1).padStart(2, '0')}`, t: { max: 20 + i } });
  }
  const STATE = JSON.stringify({ 'p_city_local/forecast': { longTerm: rows } });
  const THIN_PAGE = `<html><head><title>Doc</title>
    <script id="ng-state" type="application/json">${STATE}</script></head><body>
    <article><h2>Heading</h2><p>Some short paragraph text here for context.</p></article>
  </body></html>`;

  const recipe = RecipeSchema.parse({
    name: 'thin-append', host: 'example.com',
    append: [{
      title: 'Trend', script: '#ng-state',
      path: ['p_city_local/forecast', 'longTerm'],
      fields: { datum: ['date'], max_c: ['t', 'max'] },
    }],
  });

  const fetchHtml = (html) => async () => ({
    ok: true,
    status: 200,
    headers: { get: (k) => (k.toLowerCase() === 'content-type' ? 'text/html; charset=utf-8' : null) },
    text: async () => html,
  });

  it('still calls the Playwright render client when the append block alone would push the result over the length floor', async () => {
    let renderCalled = false;
    const result = await extractWeb('https://example.com/thin', {
      fetch: fetchHtml(THIN_PAGE),
      extractor: 'trafilatura',
      recipes: [recipe],
      renderClient: async () => { renderCalled = true; return THIN_PAGE; },
    });
    assert.ok(renderCalled, 'the append block must not hide a thin static extraction from the render decision');
    assert.ok(result.metadata.quality >= 0.5, 'test setup check: quality must not be the reason a render happens');
    assert.match(result.markdown, /## Trend\n/, 'the append block must still end up in the final markdown');
  });
});
