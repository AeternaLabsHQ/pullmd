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
});
