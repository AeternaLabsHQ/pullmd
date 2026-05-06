import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { RecipeSchema } from '../lib/recipes.js';

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
