import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { hostMatches } from '../lib/recipes.js';

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
