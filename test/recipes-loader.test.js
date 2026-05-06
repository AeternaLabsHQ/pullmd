import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { RecipeSchema } from '../lib/recipes.js';
import { loadRecipes } from '../lib/recipes.js';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const fix = (rel) => path.join(here, 'fixtures/recipes', rel);

describe('RecipeSchema', () => {
  it('accepts a minimal recipe with name + host', () => {
    const result = RecipeSchema.safeParse({ name: 'r1', host: 'example.com' });
    assert.equal(result.success, true);
  });

  it('accepts host as string array', () => {
    const result = RecipeSchema.safeParse({ name: 'r1', host: ['a.com', 'b.com'] });
    assert.equal(result.success, true);
  });

  it('rejects when name is missing', () => {
    const result = RecipeSchema.safeParse({ host: 'example.com' });
    assert.equal(result.success, false);
  });

  it('rejects when host is missing', () => {
    const result = RecipeSchema.safeParse({ name: 'r1' });
    assert.equal(result.success, false);
  });

  it('accepts all four preprocess actions', () => {
    const recipe = {
      name: 'r1', host: 'a.com',
      preprocess: [
        { action: 'remove-attr', selector: 'p', attr: 'aria-hidden' },
        { action: 'remove-class', selector: 'p', class: 'paywall' },
        { action: 'remove-element', selector: 'aside.ads' },
        { action: 'unwrap', selector: 'span.wrapper' },
      ],
    };
    assert.equal(RecipeSchema.safeParse(recipe).success, true);
  });

  it('rejects unknown preprocess action', () => {
    const recipe = {
      name: 'r1', host: 'a.com',
      preprocess: [{ action: 'acton', selector: 'p', attr: 'x' }],
    };
    assert.equal(RecipeSchema.safeParse(recipe).success, false);
  });

  it('accepts fetch options', () => {
    const recipe = {
      name: 'r1', host: 'a.com',
      fetch: { render: 'force', wait_for: '.x', wait_timeout_ms: 5000, mobile_ua: true },
    };
    assert.equal(RecipeSchema.safeParse(recipe).success, true);
  });

  it('rejects fetch.render outside the enum', () => {
    const recipe = { name: 'r1', host: 'a.com', fetch: { render: 'auto' } };
    assert.equal(RecipeSchema.safeParse(recipe).success, false);
  });

  it('caps fetch.wait_timeout_ms at 15000', () => {
    const recipe = { name: 'r1', host: 'a.com', fetch: { wait_timeout_ms: 99999 } };
    assert.equal(RecipeSchema.safeParse(recipe).success, false);
  });

  it('accepts select.remove as string array', () => {
    const recipe = { name: 'r1', host: 'a.com', select: { remove: ['aside', '.ads'] } };
    assert.equal(RecipeSchema.safeParse(recipe).success, true);
  });

  it('accepts extractor enum', () => {
    for (const x of ['readability', 'trafilatura', 'playwright']) {
      assert.equal(RecipeSchema.safeParse({ name: 'r1', host: 'a.com', extractor: x }).success, true);
    }
  });

  it('rejects unknown extractor', () => {
    assert.equal(
      RecipeSchema.safeParse({ name: 'r1', host: 'a.com', extractor: 'magic' }).success,
      false,
    );
  });
});

describe('loadRecipes — default file only', () => {
  it('loads recipes from the default file', () => {
    const { recipes, status } = loadRecipes({ defaultPath: fix('default.json') });
    assert.equal(recipes.length, 2);
    assert.equal(recipes[0].name, 'fixture-paywall');
    assert.equal(status.loaded, 2);
    assert.equal(status.rejected, 0);
    assert.equal(status.sources.length, 1);
    assert.equal(status.sources[0].loaded, 2);
  });

  it('returns empty + warning when default file is absent', () => {
    const { recipes, status } = loadRecipes({ defaultPath: fix('does-not-exist.json') });
    assert.equal(recipes.length, 0);
    assert.equal(status.loaded, 0);
    assert.equal(status.sources.length, 0);
  });

  it('skips user file when not provided', () => {
    const { status } = loadRecipes({ defaultPath: fix('default.json') });
    assert.equal(status.sources.length, 1);
  });
});

describe('loadRecipes — user overlay', () => {
  it('loads default + user, concatenates in order', () => {
    const { recipes } = loadRecipes({
      defaultPath: fix('default.json'),
      userPath: fix('user.json'),
    });
    assert.equal(recipes.length, 4);
    assert.equal(recipes[0].name, 'fixture-paywall');
    assert.equal(recipes[1].name, 'fixture-extractor');
    assert.equal(recipes[2].name, 'fixture-extractor');  // user override (same name)
    assert.equal(recipes[3].name, 'fixture-user-only');
  });

  it('reports per-source counts in status', () => {
    const { status } = loadRecipes({
      defaultPath: fix('default.json'),
      userPath: fix('user.json'),
    });
    assert.equal(status.sources.length, 2);
    assert.equal(status.sources[0].loaded, 2);
    assert.equal(status.sources[1].loaded, 2);
    assert.equal(status.rejected, 0);
  });

  it('skips user file silently when absent', () => {
    const { status } = loadRecipes({
      defaultPath: fix('default.json'),
      userPath: fix('does-not-exist.json'),
    });
    assert.equal(status.sources.length, 1);
  });

  it('rejects malformed recipe per-recipe, loads the rest', () => {
    const { recipes, status } = loadRecipes({
      defaultPath: fix('default.json'),
      userPath: fix('invalid.json'),
    });
    assert.equal(recipes.length, 3);  // 2 default + 1 valid from invalid.json
    assert.equal(status.rejected, 1);
    assert.equal(status.sources[1].rejected, 1);
  });
});
