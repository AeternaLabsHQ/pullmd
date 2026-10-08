import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { stripMarkdown } from '../lib/strip-markdown.js';

describe('stripMarkdown', () => {
  it('strips headings, emphasis and links', () => {
    assert.equal(
      stripMarkdown('# Title\n\nSome **bold** and *em* text, see [docs](https://example.com).'),
      'Title\n\nSome bold and em text, see docs (https://example.com).',
    );
  });

  it('keeps the space after inline emphasis in list items (#60)', () => {
    assert.equal(
      stripMarkdown('- *New!* This update\n- a new **Preview anyway** button'),
      '- New! This update\n- a new Preview anyway button',
    );
  });

  it('resolves backslash escapes to the bare character (#60)', () => {
    assert.equal(stripMarkdown('- **\\[Widgets\\]** *New!* This update'), '- [Widgets] New! This update');
    assert.equal(stripMarkdown('@functools.cache(user\\_function)'), '@functools.cache(user_function)');
    assert.equal(stripMarkdown('C:\\\\Users \\# \\> \\| \\~ \\`'), 'C:\\Users # > | ~ `');
  });

  it('does not read escaped markers as emphasis', () => {
    assert.equal(stripMarkdown('def \\_\\_init\\_\\_(self)'), 'def __init__(self)');
    assert.equal(stripMarkdown('return n \\* factorial(n-1) \\* 2'), 'return n * factorial(n-1) * 2');
  });

  it('does not read escaped brackets as a link', () => {
    assert.equal(stripMarkdown('[\\[1\\]](#cite_note-1)'), '[1] (#cite_note-1)');
  });

  it('leaves backslashes inside code spans and fenced blocks alone', () => {
    assert.equal(stripMarkdown('Use `a\\_b` here'), 'Use `a\\_b` here');
    assert.equal(stripMarkdown('```\nre = /\\./\n```'), '```\nre = /\\./\n```');
  });

  it('leaves a backslash before a non-punctuation character alone', () => {
    assert.equal(stripMarkdown('C:\\Users\\andie'), 'C:\\Users\\andie');
  });
});
