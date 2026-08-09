import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { RecipeSchema, mergeRecipes } from '../lib/recipes.js';

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
