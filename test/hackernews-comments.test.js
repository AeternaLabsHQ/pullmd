// test/hackernews-comments.test.js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { formatComments } from '../lib/hackernews.js';

const c = (o = {}) => ({ type: 'comment', author: 'u', text: '<p>body</p>', created_at_i: 1781069624, children: [], ...o });

describe('formatComments', () => {
  it('renders a top-level comment with author + heading', () => {
    const out = formatComments([c({ author: 'alice', text: '<p>Hello</p>' })], { totalComments: 1, limit: null, depth: 5 });
    assert.ok(out.includes('## Kommentare (1 von 1)'));
    assert.ok(/\*\*alice\*\* · .+: Hello/.test(out));
  });
  it('emits English heading when lang=en', () => {
    const out = formatComments([c()], { totalComments: 1, limit: null, depth: 5, lang: 'en' });
    assert.ok(out.includes('## Comments (1 of 1)'));
  });
  it('indents nested replies 2 spaces per level', () => {
    const tree = [c({ author: 'a', text: '<p>L0</p>', children: [c({ author: 'b', text: '<p>L1</p>', children: [c({ author: 'd', text: '<p>L2</p>' })] })] })];
    const out = formatComments(tree, { totalComments: 3, limit: null, depth: 5 });
    assert.ok(/\n\*\*a\*\* · .+: L0/.test('\n' + out));
    assert.ok(/\n {2}\*\*b\*\* · .+: L1/.test(out));
    assert.ok(/\n {4}\*\*d\*\* · .+: L2/.test(out));
  });
  it('respects depth cutoff (depth=2 hides level 2)', () => {
    const tree = [c({ text: '<p>L0</p>', children: [c({ text: '<p>L1</p>', children: [c({ text: '<p>L2</p>' })] })] })];
    const out = formatComments(tree, { totalComments: 3, limit: null, depth: 2 });
    assert.ok(out.includes('L0') && out.includes('L1') && !out.includes('L2'));
  });
  it('respects top-level limit', () => {
    const tree = Array.from({ length: 10 }, (_, i) => c({ text: `<p>C${i}</p>` }));
    const out = formatComments(tree, { totalComments: 10, limit: 3, depth: 5 });
    assert.ok(out.includes('C0') && out.includes('C2') && !out.includes('C3'));
  });
  it('skips dead/deleted nodes (null text or author)', () => {
    const tree = [c({ author: null, text: null }), c({ author: 'real', text: '<p>Visible</p>' })];
    const out = formatComments(tree, { totalComments: 1, limit: null, depth: 5 });
    assert.ok(out.includes('Visible'));
    assert.ok(out.includes('(1 von'));
  });
  it('converts HTML in comment text to markdown', () => {
    const out = formatComments([c({ text: '<p>see <a href="https://x.com">link</a></p>' })], { totalComments: 1, limit: null, depth: 5 });
    assert.ok(out.includes('[link](https://x.com)'));
  });
});
