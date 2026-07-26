import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { RecipeSchema, mergeRecipes } from '../lib/recipes.js';
import { extractHtml } from '../lib/web.js';

const URL = 'https://example.com/article';

function recipe(select) {
  return RecipeSchema.parse({ name: 'test', host: 'example.com', select });
}

// Long enough to clear RECIPE_CONTENT_MIN_CHARS (200) on its own.
const PROSE = 'This paragraph is deliberately long enough that the recipe-selected body clears the minimum length floor on its own, without help from any of the surrounding blocks on the page. The floor exists to catch selectors that have gone stale after a site redesign, so every fixture block here has to sit comfortably above it.';

const PAGE = `<html><head><title>Doc</title></head><body>
  <nav><a href="/x">nav link</a><a href="/y">another nav link</a></nav>
  <div class="stub"><p>Too short.</p></div>
  <div class="lead"><p>LEAD ${PROSE}</p></div>
  <aside class="promo"><p>PROMO block that must never reach the output at all.</p></aside>
  <div class="rest"><h2>Heading</h2><p>REST ${PROSE}</p></div>
  <footer><p>FOOTER boilerplate that must never reach the output either.</p></footer>
</body></html>`;

describe('recipe select.content', () => {
  it('schema accepts content and defaults it to an empty array', () => {
    assert.deepEqual(recipe({ content: ['.a'] }).select.content, ['.a']);
    assert.deepEqual(recipe({ remove: ['.b'] }).select.content, []);
  });

  it('merges content selectors across matching recipes by concatenation', () => {
    const merged = mergeRecipes([
      recipe({ content: ['.lead'] }),
      recipe({ content: ['.rest'] }),
    ]);
    assert.deepEqual(merged.contentSelectors, ['.lead', '.rest']);
  });

  it('selects exactly the named blocks and nothing else', async () => {
    const result = await extractHtml(PAGE, {
      url: URL,
      recipes: [recipe({ content: ['.lead', '.rest'] })],
      extractor: 'readability',
    });
    assert.equal(result.source, 'recipe-content');
    assert.match(result.markdown, /LEAD /);
    assert.match(result.markdown, /REST /);
    assert.doesNotMatch(result.markdown, /PROMO/);
    assert.doesNotMatch(result.markdown, /FOOTER/);
    assert.doesNotMatch(result.markdown, /nav link/);
  });

  it('emits matches in document order regardless of selector order', async () => {
    const result = await extractHtml(PAGE, {
      url: URL,
      recipes: [recipe({ content: ['.rest', '.lead'] })],
      extractor: 'readability',
    });
    assert.ok(
      result.markdown.indexOf('LEAD ') < result.markdown.indexOf('REST '),
      'lead block must precede rest block',
    );
  });

  it('does not emit nested matches twice', async () => {
    const nested = await extractHtml(PAGE, {
      url: URL,
      recipes: [recipe({ content: ['.lead', '.lead p'] })],
      extractor: 'readability',
    });
    const plain = await extractHtml(PAGE, {
      url: URL,
      recipes: [recipe({ content: ['.lead'] })],
      extractor: 'readability',
    });
    assert.equal(nested.markdown, plain.markdown);
  });

  it('falls back to the normal pipeline when the selectors match nothing', async () => {
    const result = await extractHtml(PAGE, {
      url: URL,
      recipes: [recipe({ content: ['.gone-after-a-redesign'] })],
      extractor: 'readability',
    });
    assert.notEqual(result.source, 'recipe-content');
    assert.match(result.metadata.extractorReason, /select\.content matched nothing/);
    assert.match(result.markdown, /REST /);
  });

  it('falls back when the match is below the length floor', async () => {
    const result = await extractHtml(PAGE, {
      url: URL,
      recipes: [recipe({ content: ['.stub'] })],
      extractor: 'readability',
    });
    assert.notEqual(result.source, 'recipe-content');
    assert.match(result.metadata.extractorReason, /select\.content matched only \d+c/);
  });

  it('an invalid selector skips itself instead of breaking extraction', async () => {
    const result = await extractHtml(PAGE, {
      url: URL,
      recipes: [recipe({ content: ['((((', '.lead'] })],
      extractor: 'readability',
    });
    assert.equal(result.source, 'recipe-content');
    assert.match(result.markdown, /LEAD /);
  });

  it('select.remove applies before select.content picks the body', async () => {
    const result = await extractHtml(PAGE, {
      url: URL,
      recipes: [recipe({ content: ['.rest'], remove: ['.rest h2'] })],
      extractor: 'readability',
    });
    assert.equal(result.source, 'recipe-content');
    assert.match(result.markdown, /REST /);
    assert.doesNotMatch(result.markdown, /^## Heading$/m);
  });
});
