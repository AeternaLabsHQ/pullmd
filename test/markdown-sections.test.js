import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseBlocks, buildSectionTree } from '../lib/markdown-sections.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function normalizeBlankLines(text) {
  return text.split(/\r?\n/).join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

describe('parseBlocks — headings', () => {
  it('parses ATX headings with correct level and line range', () => {
    const md = '# Title\n\nSome text.';
    const blocks = parseBlocks(md);
    assert.equal(blocks[0].type, 'heading');
    assert.equal(blocks[0].level, 1);
    assert.equal(blocks[0].startLine, 0);
    assert.equal(blocks[0].endLine, 0);
    assert.equal(blocks[0].text, '# Title');
  });

  it('supports levels 1 through 6', () => {
    const md = '# a\n\n## b\n\n### c\n\n#### d\n\n##### e\n\n###### f';
    const blocks = parseBlocks(md).filter(b => b.type === 'heading');
    assert.deepEqual(blocks.map(b => b.level), [1, 2, 3, 4, 5, 6]);
  });

  it('does not treat setext-style underlines as headings', () => {
    const md = 'Title\n===\n\nSubtitle\n---';
    const blocks = parseBlocks(md);
    assert.ok(blocks.every(b => b.type !== 'heading'), 'no heading blocks expected');
    assert.equal(blocks[0].type, 'paragraph');
  });

  it('requires a space after the hashes (not a heading otherwise)', () => {
    const md = '#nospace text';
    const blocks = parseBlocks(md);
    assert.equal(blocks[0].type, 'paragraph');
  });

  it('a line with 7+ # characters is not a heading (ATX caps at 6)', () => {
    const md = '####### too many text';
    const blocks = parseBlocks(md);
    assert.equal(blocks[0].type, 'paragraph');
  });
});

describe('parseBlocks — code fences', () => {
  it('parses a fenced code block as one atomic block', () => {
    const md = '```js\nconst x = 1;\n```';
    const blocks = parseBlocks(md);
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].type, 'code');
    assert.equal(blocks[0].startLine, 0);
    assert.equal(blocks[0].endLine, 2);
  });

  it('does not recognize a heading-like line inside a fence', () => {
    const md = '```\n# fake\n```';
    const blocks = parseBlocks(md);
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].type, 'code');
  });

  it('does not recognize a table-like line inside a fence', () => {
    const md = '```\n| a | b |\n| - | - |\n```';
    const blocks = parseBlocks(md);
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].type, 'code');
  });

  it('a ``` fence inside a ~~~ fence does not close the outer fence', () => {
    const md = '~~~\n```\nstill inside\n~~~\nafter';
    const blocks = parseBlocks(md);
    assert.equal(blocks[0].type, 'code');
    assert.equal(blocks[0].startLine, 0);
    assert.equal(blocks[0].endLine, 3);
    assert.equal(blocks[1].type, 'paragraph');
    assert.equal(blocks[1].text, 'after');
  });

  it('a ~~~ fence inside a ``` fence does not close the outer fence', () => {
    const md = '```\n~~~\nstill inside\n```\nafter';
    const blocks = parseBlocks(md);
    assert.equal(blocks[0].type, 'code');
    assert.equal(blocks[0].startLine, 0);
    assert.equal(blocks[0].endLine, 3);
  });

  it('an unclosed fence runs to end of document without crashing', () => {
    const md = 'text\n\n```js\nconst x = 1;\nno closing fence here';
    const blocks = parseBlocks(md);
    const code = blocks.find(b => b.type === 'code');
    assert.ok(code);
    assert.equal(code.startLine, 2);
    assert.equal(code.endLine, 4);
  });

  it('closing fence must have at least as many chars as the opening fence', () => {
    const md = '````\ncode\n```\nstill code\n````\nafter';
    const blocks = parseBlocks(md);
    assert.equal(blocks[0].type, 'code');
    assert.equal(blocks[0].endLine, 4);
    assert.equal(blocks[1].text, 'after');
  });

  it('parses indented code blocks (4+ spaces after a blank line)', () => {
    const md = 'text\n\n    indented code\n    more code\n\nafter';
    const blocks = parseBlocks(md);
    const code = blocks.find(b => b.type === 'code');
    assert.ok(code);
    assert.equal(code.text, '    indented code\n    more code');
  });
});

describe('parseBlocks — tables', () => {
  it('parses a table with a leading pipe as one atomic block', () => {
    const md = '| a | b |\n| - | - |\n| 1 | 2 |';
    const blocks = parseBlocks(md);
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].type, 'table');
    assert.equal(blocks[0].startLine, 0);
    assert.equal(blocks[0].endLine, 2);
  });

  it('parses a table without a leading pipe as one atomic block', () => {
    const md = 'a | b\n--- | ---\n1 | 2';
    const blocks = parseBlocks(md);
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].type, 'table');
    assert.equal(blocks[0].endLine, 2);
  });

  it('a line with | but no delimiter row is a paragraph, not a table', () => {
    const md = 'a | b\nsome more text';
    const blocks = parseBlocks(md);
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].type, 'paragraph');
  });
});

describe('parseBlocks — lists', () => {
  it('parses a simple list as one atomic block', () => {
    const md = '- one\n- two\n- three';
    const blocks = parseBlocks(md);
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].type, 'list');
    assert.equal(blocks[0].endLine, 2);
  });

  it('parses an ordered list', () => {
    const md = '1. one\n2. two\n3) three';
    const blocks = parseBlocks(md);
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].type, 'list');
  });

  it('includes indented continuation lines in the list block', () => {
    const md = '- one\n  continuation text\n- two';
    const blocks = parseBlocks(md);
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].type, 'list');
    assert.equal(blocks[0].endLine, 2);
  });

  it('a nested code fence inside a list item stays inside one list block', () => {
    const md = '- one\n  ```js\n  const x = 1;\n\n  still fenced\n  ```\n- two';
    const blocks = parseBlocks(md);
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].type, 'list');
    assert.equal(blocks[0].startLine, 0);
    assert.equal(blocks[0].endLine, 6);
  });

  it('a blank line followed by unindented, non-list text ends the list', () => {
    const md = '- one\n- two\n\nA regular paragraph.';
    const blocks = parseBlocks(md);
    assert.equal(blocks.length, 2);
    assert.equal(blocks[0].type, 'list');
    assert.equal(blocks[0].endLine, 1);
    assert.equal(blocks[1].type, 'paragraph');
  });

  it('a blank line followed by another list item stays in the same list block', () => {
    const md = '- one\n\n- two';
    const blocks = parseBlocks(md);
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].type, 'list');
    assert.equal(blocks[0].endLine, 2);
  });

  it('an unindented fence right after a list item (no blank line) ends the list', () => {
    const md = '- one\n```js\ntop level code\n```';
    const blocks = parseBlocks(md);
    assert.equal(blocks.length, 2);
    assert.equal(blocks[0].type, 'list');
    assert.equal(blocks[0].endLine, 0);
    assert.equal(blocks[1].type, 'code');
    assert.equal(blocks[1].startLine, 1);
    assert.equal(blocks[1].endLine, 3);
  });

  it('a closing fence indented 4+ spaces inside a list item still closes the fence, so a following heading is not swallowed', () => {
    const md = [
      '10. item',
      '    ```js',
      '    code',
      '    ```',
      '',
      '# Next Heading',
      '',
      'body text',
    ].join('\n');
    const blocks = parseBlocks(md);
    assert.equal(blocks.length, 3);
    assert.equal(blocks[0].type, 'list');
    assert.equal(blocks[0].startLine, 0);
    assert.equal(blocks[0].endLine, 3);
    assert.equal(blocks[1].type, 'heading');
    assert.equal(blocks[1].text, '# Next Heading');
    assert.equal(blocks[2].type, 'paragraph');
    assert.equal(blocks[2].text, 'body text');

    const { headingCount } = buildSectionTree(blocks);
    assert.equal(headingCount, 1);
  });
});

describe('parseBlocks — blockquotes', () => {
  it('parses consecutive > lines as one atomic block', () => {
    const md = '> line one\n> line two';
    const blocks = parseBlocks(md);
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].type, 'blockquote');
    assert.equal(blocks[0].endLine, 1);
  });

  it('includes blank >-only lines inside the blockquote', () => {
    const md = '> line one\n>\n> line two';
    const blocks = parseBlocks(md);
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].type, 'blockquote');
    assert.equal(blocks[0].endLine, 2);
  });

  it('a truly blank line ends the blockquote', () => {
    const md = '> line one\n\nAfter.';
    const blocks = parseBlocks(md);
    assert.equal(blocks.length, 2);
    assert.equal(blocks[0].type, 'blockquote');
    assert.equal(blocks[1].type, 'paragraph');
  });
});

describe('parseBlocks — html blocks', () => {
  it('parses consecutive html lines until a blank line', () => {
    const md = '<div>\n  <p>hi</p>\n</div>\n\nAfter.';
    const blocks = parseBlocks(md);
    assert.equal(blocks[0].type, 'html');
    assert.equal(blocks[0].startLine, 0);
    assert.equal(blocks[0].endLine, 2);
    assert.equal(blocks[1].type, 'paragraph');
  });

  it('parses an html comment block', () => {
    const md = '<!-- elided -->';
    const blocks = parseBlocks(md);
    assert.equal(blocks[0].type, 'html');
  });
});

describe('parseBlocks — paragraphs', () => {
  it('groups consecutive non-blank lines into one paragraph', () => {
    const md = 'line one\nline two\nline three';
    const blocks = parseBlocks(md);
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].type, 'paragraph');
    assert.equal(blocks[0].endLine, 2);
  });

  it('separates paragraphs on blank lines', () => {
    const md = 'para one\n\npara two';
    const blocks = parseBlocks(md);
    assert.equal(blocks.length, 2);
    assert.ok(blocks.every(b => b.type === 'paragraph'));
  });

  it('a paragraph breaks before a following heading without a blank line', () => {
    const md = 'text before\n# Heading';
    const blocks = parseBlocks(md);
    assert.equal(blocks.length, 2);
    assert.equal(blocks[0].type, 'paragraph');
    assert.equal(blocks[1].type, 'heading');
  });
});

describe('parseBlocks — reconstruction invariant', () => {
  it('joining block texts with blank lines reproduces a mixed inline fixture', () => {
    const md = [
      '# Title',
      '',
      'Intro paragraph.',
      '',
      '```js',
      'const x = 1;',
      '```',
      '',
      '| a | b |',
      '| - | - |',
      '| 1 | 2 |',
      '',
      '- item one',
      '- item two',
      '',
      '> a quote',
      '',
      'Closing paragraph.',
    ].join('\n');
    const blocks = parseBlocks(md);
    const reconstructed = blocks.map(b => b.text).join('\n\n');
    assert.equal(normalizeBlankLines(reconstructed), normalizeBlankLines(md));
  });

  it('reconstructs the query-extract fixture page', () => {
    const fixture = fs.readFileSync(
      path.join(__dirname, 'fixtures', 'query-extract', 'page.md'),
      'utf8'
    );
    const blocks = parseBlocks(fixture);
    const reconstructed = blocks.map(b => b.text).join('\n\n');
    assert.equal(normalizeBlankLines(reconstructed), normalizeBlankLines(fixture));
  });
});

describe('buildSectionTree', () => {
  it('creates a synthetic root section holding pre-first-heading content', () => {
    const blocks = parseBlocks('Preamble text.\n\n# Title\n\nBody.');
    const { sections, headingCount } = buildSectionTree(blocks);
    assert.equal(headingCount, 1);
    assert.equal(sections[0].heading, null);
    assert.equal(sections[0].level, 0);
    assert.equal(sections[0].blocks.length, 1);
    assert.equal(sections[0].blocks[0].text, 'Preamble text.');
    assert.equal(sections[0].parent, null);
    assert.equal(sections[0].children.length, 1);
  });

  it('nests same-level headings as siblings under root', () => {
    const blocks = parseBlocks('# One\n\ntext one\n\n# Two\n\ntext two');
    const { sections } = buildSectionTree(blocks);
    const root = sections[0];
    assert.equal(root.children.length, 2);
    assert.equal(root.children[0].heading.text, '# One');
    assert.equal(root.children[1].heading.text, '# Two');
    assert.equal(root.children[0].parent, root);
  });

  it('nests a deeper heading under the most recent shallower heading', () => {
    const blocks = parseBlocks('# One\n\n## Two\n\ntext two\n\n### Three\n\ntext three');
    const { sections } = buildSectionTree(blocks);
    const one = sections.find(s => s.heading && s.heading.text === '# One');
    const two = sections.find(s => s.heading && s.heading.text === '## Two');
    const three = sections.find(s => s.heading && s.heading.text === '### Three');
    assert.equal(two.parent, one);
    assert.equal(three.parent, two);
    assert.equal(one.children.length, 1);
    assert.equal(two.children.length, 1);
  });

  it('nests correctly when a heading level is skipped', () => {
    const blocks = parseBlocks('# One\n\n### Three\n\ntext');
    const { sections } = buildSectionTree(blocks);
    const one = sections.find(s => s.heading && s.heading.text === '# One');
    const three = sections.find(s => s.heading && s.heading.text === '### Three');
    assert.equal(three.parent, one, '### after # is a child of # even though ## is skipped');
    assert.equal(one.children.length, 1);
    assert.equal(one.children[0], three);
  });

  it('a parent section blocks array excludes descendant content', () => {
    const blocks = parseBlocks('# One\n\nparent text\n\n## Two\n\nchild text');
    const { sections } = buildSectionTree(blocks);
    const one = sections.find(s => s.heading && s.heading.text === '# One');
    const two = sections.find(s => s.heading && s.heading.text === '## Two');
    assert.equal(one.blocks.length, 1);
    assert.equal(one.blocks[0].text, 'parent text');
    assert.equal(two.blocks.length, 1);
    assert.equal(two.blocks[0].text, 'child text');
  });

  it('pops back to a shallower ancestor after a deeper subtree ends', () => {
    const blocks = parseBlocks('# One\n\n## Two\n\ntext\n\n## Three\n\ntext');
    const { sections } = buildSectionTree(blocks);
    const one = sections.find(s => s.heading && s.heading.text === '# One');
    assert.equal(one.children.length, 2);
    assert.equal(one.children[0].heading.text, '## Two');
    assert.equal(one.children[1].heading.text, '## Three');
  });

  it('returns headingCount matching the number of heading blocks', () => {
    const blocks = parseBlocks('# a\n\n## b\n\n### c');
    const { headingCount } = buildSectionTree(blocks);
    assert.equal(headingCount, 3);
  });

  it('handles a document with no headings at all', () => {
    const blocks = parseBlocks('just a paragraph, no headings.');
    const { sections, headingCount } = buildSectionTree(blocks);
    assert.equal(headingCount, 0);
    assert.equal(sections.length, 1);
    assert.equal(sections[0].blocks.length, 1);
  });

  it('assigns increasing order values in document order', () => {
    const blocks = parseBlocks('# One\n\n## Two\n\n# Three');
    const { sections } = buildSectionTree(blocks);
    const orders = sections.map(s => s.order);
    assert.deepEqual(orders, [...orders].sort((a, b) => a - b));
    assert.equal(new Set(orders).size, orders.length);
  });
});
