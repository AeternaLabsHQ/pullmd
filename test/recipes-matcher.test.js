import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { hostMatches, pathMatches } from '../lib/recipes.js';

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
