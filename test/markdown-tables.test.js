import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { NodeHtmlMarkdown } from 'node-html-markdown';
import { compactTables } from '../lib/markdown-tables.js';

describe('compactTables', () => {
  it('removes the column padding node-html-markdown adds', () => {
    const md = new NodeHtmlMarkdown({}).translate(
      '<table><tr><th>a</th><th>longer header</th></tr><tr><td>x</td><td>1</td></tr></table>',
    );
    assert.equal(compactTables(md), '| a | longer header |\n| --- | --- |\n| x | 1 |');
  });

  it('keeps alignment colons in the separator row', () => {
    assert.equal(compactTables('| a | b | c |\n|:-----|-----:|:----:|'), '| a | b | c |\n| :--- | ---: | :---: |');
  });

  it('keeps escaped pipes and empty cells', () => {
    assert.equal(compactTables('| x\\|y    |     |\n| a        | b   |'), '| x\\|y | |\n| a | b |');
  });

  it('leaves fenced code blocks alone', () => {
    const md = '```\n| a    | b |\n```\n\n| c    | d |';
    assert.equal(compactTables(md), '```\n| a    | b |\n```\n\n| c | d |');
  });

  it('does not touch lines that are not table rows', () => {
    const md = 'a  |  b\n\nplain   text';
    assert.equal(compactTables(md), md);
  });

  it('passes empty input through', () => {
    assert.equal(compactTables(''), '');
    assert.equal(compactTables(null), null);
  });

  it('shrinks long space runs in linear time', () => {
    const run = ' '.repeat(1_000_000);
    for (const [input, expected] of [
      ['|' + run + '|', '| |'],
      ['|' + run + 'x|', '| x|'],
      ['| a' + run + '|', '| a |'],
    ]) {
      const t0 = performance.now();
      const out = compactTables(input);
      const ms = performance.now() - t0;
      assert.equal(out, expected);
      assert.ok(ms < 200, `${JSON.stringify(input.slice(0, 4))}... took ${ms.toFixed(0)} ms`);
    }
  });

  it('matches the previous space-run handling on a seeded fuzz corpus', () => {
    const legacy = (line) => line.replace(/ {2,}\|/g, ' |').replace(/\| {2,}/g, '| ');
    let seed = 20261118;
    const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };
    const alphabet = [' ', ' ', '  ', '|', 'a', '\\|', ':'];
    for (let n = 0; n < 20000; n++) {
      let row = '|';
      const len = Math.floor(rnd() * 20);
      for (let i = 0; i < len; i++) row += alphabet[Math.floor(rnd() * alphabet.length)];
      row += '|';
      assert.equal(compactTables(row), legacy(row), JSON.stringify(row));
    }
  });
});
