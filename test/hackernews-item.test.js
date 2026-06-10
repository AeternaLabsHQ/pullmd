// test/hackernews-item.test.js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { formatItem, itemMeta } from '../lib/hackernews.js';

const story = (o = {}) => ({
  id: 1, type: 'story', author: 'sub', title: 'A Title', url: null, text: null,
  points: 234, created_at_i: 1781060000, children: [], ...o,
});
const comment = (o = {}) => ({ type: 'comment', author: 'c', text: '<p>hi</p>', created_at_i: 1781069624, children: [], ...o });

describe('formatItem', () => {
  it('renders title and link-post URL in body', () => {
    const md = formatItem(story({ url: 'https://example.com/post' }));
    assert.ok(md.startsWith('# A Title'));
    assert.ok(md.includes('https://example.com/post'));
  });
  it('renders Ask HN selftext as markdown', () => {
    const md = formatItem(story({ title: 'Ask HN: X?', text: '<p>my <b>question</b></p>' }));
    assert.ok(md.includes('my **question**'));
  });
  it('omits the Comments section when there are no alive comments', () => {
    const md = formatItem(story({ children: [] }));
    assert.ok(!md.includes('## Kommentare'));
  });
  it('appends a Comments section with heading when comments exist', () => {
    const md = formatItem(story({ children: [comment({ author: 'x', text: '<p>yo</p>' })] }), { commentDepth: 5 });
    assert.ok(md.includes('## Kommentare (1 von 1)'));
    assert.ok(md.includes('yo'));
  });
  it('titles a comment-permalink root as "Comment by <author>"', () => {
    const md = formatItem(comment({ author: 'pg', text: '<p>root</p>' }));
    assert.ok(md.startsWith('# Comment by pg'));
  });
  it('excludes children of a dead node from the heading total (count matches render)', () => {
    // A dead parent with a live child: formatCommentNode drops the whole dead
    // subtree, so the live grandchild must be neither rendered nor counted —
    // heading reads "1 von 1", not "1 von 2".
    const md = formatItem(story({ children: [
      comment({ author: 'alive', text: '<p>shown</p>' }),
      comment({ author: null, text: null, children: [comment({ author: 'orphan', text: '<p>hidden</p>' })] }),
    ] }), { commentDepth: 5 });
    assert.ok(md.includes('## Kommentare (1 von 1)'));
    assert.ok(md.includes('shown'));
    assert.ok(!md.includes('hidden'));
  });
});

describe('itemMeta', () => {
  it('maps author/points/created to frontmatter keys', () => {
    const m = itemMeta(story());
    assert.equal(m.author, 'sub');
    assert.equal(m.upvotes, 234);
    assert.equal(m.published, new Date(1781060000 * 1000).toISOString());
  });
});
