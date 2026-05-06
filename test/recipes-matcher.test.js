import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { hostMatches, pathMatches, mergeRecipes, matchRecipesAgainst } from '../lib/recipes.js';

describe('hostMatches', () => {
  it('matches exact hostname', () => {
    assert.equal(hostMatches('example.com', 'example.com'), true);
    assert.equal(hostMatches('example.com', 'other.com'), false);
  });

  it('is case-insensitive', () => {
    assert.equal(hostMatches('Example.COM', 'example.com'), true);
  });

  it('star matches any character sequence including dots', () => {
    assert.equal(hostMatches('*.example.com', 'foo.example.com'), true);
    assert.equal(hostMatches('*.example.com', 'foo.bar.example.com'), true);
    assert.equal(hostMatches('*.example.com', 'example.com'), false);  // apex needs explicit entry
    assert.equal(hostMatches('*.example.com', 'other.com'), false);
  });

  it('accepts an array — any-of semantics', () => {
    assert.equal(hostMatches(['a.com', 'b.com'], 'b.com'), true);
    assert.equal(hostMatches(['a.com', 'b.com'], 'c.com'), false);
  });

  it('escapes regex special chars in literal parts', () => {
    assert.equal(hostMatches('foo.example.com', 'foo.example.com'), true);
    assert.equal(hostMatches('foo.example.com', 'fooXexample.com'), false);  // dot is literal
  });
});

describe('pathMatches', () => {
  it('matches exact path', () => {
    assert.equal(pathMatches('/foo', '/foo'), true);
    assert.equal(pathMatches('/foo', '/bar'), false);
  });

  it('** matches multiple segments', () => {
    assert.equal(pathMatches('/**', '/'), true);
    assert.equal(pathMatches('/**', '/a/b/c'), true);
    assert.equal(pathMatches('/foo/**', '/foo/a/b'), true);
    assert.equal(pathMatches('/foo/**', '/bar/a/b'), false);
  });

  it('* matches single segment (no slashes)', () => {
    assert.equal(pathMatches('/foo/*', '/foo/bar'), true);
    assert.equal(pathMatches('/foo/*', '/foo/bar/baz'), false);
    assert.equal(pathMatches('/foo/*', '/foo/'), false);
  });

  it('mixed * and ** in the same pattern', () => {
    assert.equal(pathMatches('/*/issues/*', '/owner/issues/123'), true);
    assert.equal(pathMatches('/*/issues/*', '/owner/sub/issues/123'), false);  // * = single segment
    assert.equal(pathMatches('/*/issues/**', '/owner/issues/123/comment/456'), true);
  });
});

describe('mergeRecipes', () => {
  it('returns empty merge for no recipes', () => {
    const m = mergeRecipes([]);
    assert.deepEqual(m.preprocess, []);
    assert.deepEqual(m.removeSelectors, []);
    assert.equal(m.extractor, undefined);
    assert.deepEqual(m.fetch, {});
  });

  it('concatenates preprocess action lists in order', () => {
    const r1 = { preprocess: [{ action: 'remove-attr', selector: 'p', attr: 'aria-hidden' }], select: { remove: [] }, fetch: {} };
    const r2 = { preprocess: [{ action: 'remove-class', selector: 'p', class: 'paywall' }], select: { remove: [] }, fetch: {} };
    const m = mergeRecipes([r1, r2]);
    assert.equal(m.preprocess.length, 2);
    assert.equal(m.preprocess[0].action, 'remove-attr');
    assert.equal(m.preprocess[1].action, 'remove-class');
  });

  it('concatenates select.remove lists', () => {
    const r1 = { preprocess: [], select: { remove: ['aside'] }, fetch: {} };
    const r2 = { preprocess: [], select: { remove: ['.ads'] }, fetch: {} };
    const m = mergeRecipes([r1, r2]);
    assert.deepEqual(m.removeSelectors, ['aside', '.ads']);
  });

  it('extractor is last-wins', () => {
    const r1 = { preprocess: [], select: { remove: [] }, fetch: {}, extractor: 'readability' };
    const r2 = { preprocess: [], select: { remove: [] }, fetch: {}, extractor: 'trafilatura' };
    assert.equal(mergeRecipes([r1, r2]).extractor, 'trafilatura');
  });

  it('fetch fields merge per-key, not as whole object', () => {
    const r1 = { preprocess: [], select: { remove: [] }, fetch: { wait_for: '.x' } };
    const r2 = { preprocess: [], select: { remove: [] }, fetch: { mobile_ua: true } };
    const m = mergeRecipes([r1, r2]);
    assert.equal(m.fetch.wait_for, '.x');     // from r1, preserved
    assert.equal(m.fetch.mobile_ua, true);    // from r2
  });

  it('fetch field last-wins on per-key conflict', () => {
    const r1 = { preprocess: [], select: { remove: [] }, fetch: { render: 'force' } };
    const r2 = { preprocess: [], select: { remove: [] }, fetch: { render: 'skip' } };
    assert.equal(mergeRecipes([r1, r2]).fetch.render, 'skip');
  });
});

describe('matchRecipesAgainst', () => {
  const recipes = [
    { name: 'a', host: '*.example.com', path: '/**', preprocess: [], select: { remove: [] }, fetch: {} },
    { name: 'b', host: 'github.com',    path: '/*/issues/*', preprocess: [], select: { remove: [] }, fetch: { render: 'force' } },
    { name: 'c', host: 'github.com',    path: '/**', preprocess: [], select: { remove: [] }, fetch: {} },
  ];

  it('returns recipes whose host AND path match', () => {
    const merged = matchRecipesAgainst(recipes, new URL('https://github.com/owner/issues/123'));
    assert.equal(merged.fetch.render, 'force');  // 'b' matched (and 'c'); both apply
  });

  it('skips recipes where path does not match', () => {
    const merged = matchRecipesAgainst(recipes, new URL('https://github.com/owner/pulls/1'));
    // 'b' does NOT match (path /*/issues/*); 'c' matches; render stays unset
    assert.equal(merged.fetch.render, undefined);
  });

  it('returns empty merge when nothing matches', () => {
    const merged = matchRecipesAgainst(recipes, new URL('https://other.org/'));
    assert.deepEqual(merged.preprocess, []);
    assert.equal(merged.extractor, undefined);
  });

  it('matches real GitHub issue URLs (org/repo/issues/N)', () => {
    const ghRecipes = [
      { name: 'gh', host: 'github.com', path: '/*/*/issues/*',
        preprocess: [], select: { remove: [] }, fetch: { render: 'force' } },
    ];
    const merged = matchRecipesAgainst(ghRecipes, new URL('https://github.com/AeternaLabsHQ/pullmd/issues/10'));
    assert.equal(merged.fetch.render, 'force', 'three-segment github path must match /*/*/issues/*');
  });
});
