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

  it('keeps the alt text of an inline data: image instead of its payload', () => {
    const out = stripMarkdown('x ![alt](data:image/png;base64,AAAA) y');
    assert.equal(out, 'x alt y');
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

// The implementation before the link/image handling became a linear scan.
// Kept verbatim as the parity oracle: format=text output must not change.
function legacyStripMarkdown(md) {
  const ESCAPE = /\\([!-\/:-@\[-`{-~])/g;
  const CODE = /((?<!\\)```[\s\S]*?```|(?<!\\)`[^`\n]*`)/;
  const park = (s) => s.split(CODE)
    .map((part, i) => (i % 2 ? part : part.replace(ESCAPE, (_, ch) => String.fromCharCode(0xE000 + ch.charCodeAt(0)))))
    .join('');
  const unpark = (s) => s.replace(/[\uE021-\uE07E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xE000));
  return unpark(park(md)
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/\*(.+?)\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/_(.+?)_/g, '$1')
    .replace(/~~(.+?)~~/g, '$1')
    .replace(/!\[.*?\]\((.+?)\)/g, '$1')
    .replace(/\[(.+?)\]\((.+?)\)/g, '$1 ($2)')
    .replace(/^>\s?/gm, '')
    .replace(/^[-*+]\s+/gm, '- ')
    .replace(/^---+$/gm, '---')
    .trim());
}

const REALISTIC = [
  '# Release notes\n\nSee the [changelog](https://example.com/changelog) and the [docs](https://example.com/docs#install).\n',
  '![Logo](https://example.com/logo.png)\n\nText with an ![inline image](https://x.test/a.png "title") in it.\n',
  '[![Build](https://ci.test/badge.svg)](https://ci.test/job) [![npm](https://img.test/npm.svg)](https://npm.test/p)\n',
  'Reference links: [one][1], [two][ref] and [three].\n\n[1]: https://example.com/1\n[ref]: https://example.com/ref "Title"\n',
  'Inline `code [a](b)` and `![x](y)` spans stay.\n\n```js\nconst link = "[a](b)";\nconst img = "![i](j)";\n```\n',
  'Nested [brackets [in] link text](https://example.com/x) and [a [b [c]]](d).\n',
  'Parentheses in URLs: [Function](https://en.wikipedia.org/wiki/Function_(mathematics)) and [x](a(b)c).\n',
  'Empty bits: [a]() and [](x) and [a](b) and ![](empty.png) and ![alt]().\n',
  '> Quote with a [link](https://q.test)\n> and **bold** text\n\n- item [one](1)\n* item ![two](2)\n+ item three\n\n---\n',
  'Escapes: \\[not a link\\](x), [\\[1\\]](#cite_note-1), \\![not](img).\n',
  'Line\nbreak [a\n](b) and [a](b\nc) and ![x\r](y) and [p\u2028q](r) and [s](t\u2029u).\n',
  '| a | [b](c) |\n| - | - |\n| ![d](e) | f |\n',
  'Wiki style: [[Page]] and [[Other|label]] and [x]](y) and [x]((y)) and [x]( y ).\n',
  'Many on one line: [a](1) [b](2) ![c](3) [d](4)![e](5)[f](6)).\n',
];

// Small deterministic PRNG so the fuzz corpus is the same on every run.
function prng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
}

describe('stripMarkdown output parity with the previous implementation', () => {
  it('matches on the realistic documents', () => {
    for (const doc of REALISTIC) assert.equal(stripMarkdown(doc), legacyStripMarkdown(doc), JSON.stringify(doc));
  });

  it('matches on a seeded fuzz corpus of link and image shapes', () => {
    const alphabet = ['[', ']', '(', ')', '!', 'a', '*', '_', '\\', ' ', '\n', '\r', '\u2028', '`', '](', '!['];
    const rnd = prng(20261118);
    for (let n = 0; n < 20000; n++) {
      const len = 1 + Math.floor(rnd() * 30);
      let s = '';
      for (let i = 0; i < len; i++) s += alphabet[Math.floor(rnd() * alphabet.length)];
      assert.equal(stripMarkdown(s), legacyStripMarkdown(s), JSON.stringify(s));
    }
  });
});

describe('stripMarkdown runs in linear time', () => {
  const shapes = {
    '[a]( x 50k': '[a]('.repeat(50_000),
    '![ x 100k': '!['.repeat(100_000),
    '[ x 100k': '['.repeat(100_000),
    ']( x 100k': ']('.repeat(100_000),
    'nested brackets': '['.repeat(50_000) + 'a' + ']'.repeat(50_000) + '(',
    '![a]( x 50k': '![a]('.repeat(50_000),
    '[a](b x 50k': '[a](b'.repeat(50_000),
    '**a x 100k': '**a'.repeat(100_000),
    '[a]( x 50k inside pre': '# T\n\n<pre>' + '[a]('.repeat(50_000) + '</pre>',
  };
  for (const [name, input] of Object.entries(shapes)) {
    it(`${name} completes in under 500 ms`, () => {
      const t0 = performance.now();
      stripMarkdown(input);
      const ms = performance.now() - t0;
      assert.ok(ms < 500, `${name} took ${ms.toFixed(0)} ms`);
    });
  }
});
