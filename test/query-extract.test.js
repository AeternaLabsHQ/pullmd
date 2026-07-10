import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { estimateTokens, queryExtract } from '../lib/query-extract.js';

const MARKER = '<!-- … -->';

// Deterministic filler that never collides with the distinctive query terms
// used below (zircon/quokka/basilisk/wombat/betaneighbor/...).
function filler(nWords, seed = 'lorem') {
  const words = [];
  for (let i = 0; i < nWords; i++) words.push(seed + (i % 9));
  return words.join(' ');
}

// Count occurrences of a substring (non-overlapping).
function countOccurrences(haystack, needle) {
  let count = 0;
  let idx = 0;
  for (;;) {
    const at = haystack.indexOf(needle, idx);
    if (at === -1) break;
    count++;
    idx = at + needle.length;
  }
  return count;
}

// Every non-blank, non-marker output line must be a verbatim line of the input
// (proves the output is a substring-composition of input blocks: no invented text).
function assertNoInventedText(input, output) {
  const inputLines = new Set(input.split(/\r?\n/));
  for (const region of output.split(MARKER)) {
    for (const line of region.split('\n')) {
      if (line.trim() === '') continue;
      assert.ok(inputLines.has(line), `output line not present in input: ${JSON.stringify(line)}`);
    }
  }
}

describe('estimateTokens', () => {
  it('is 0 for the empty string', () => {
    assert.equal(estimateTokens(''), 0);
  });

  it('is Math.ceil(length / 4)', () => {
    assert.equal(estimateTokens('abcd'), 1);
    assert.equal(estimateTokens('abcde'), 2);
    assert.equal(estimateTokens('x'.repeat(3200)), 800);
    assert.equal(estimateTokens('x'.repeat(3201)), 801);
  });
});

describe('queryExtract — whole-page short-circuit', () => {
  it('returns the whole page (confidence null) at the exact threshold boundary', () => {
    // maxTokens 600 -> threshold = max(800, floor(750)) = 800.
    const atBoundary = 'x'.repeat(3200); // estimateTokens === 800 <= 800 -> short-circuit
    const res = queryExtract(atBoundary, 'anything', { maxTokens: 600 });
    assert.equal(res.extracted, false);
    assert.equal(res.confidence, null);
    assert.equal(res.sectionsSelected, 0);
    assert.equal(res.originalTokens, 800);
    assert.equal(res.returnedTokens, 800);
    assert.equal(res.markdown, atBoundary); // exact same string
  });

  it('crosses the boundary just above threshold (does not short-circuit)', () => {
    // estimateTokens === 801 > 800: not short-circuited. With a non-matching
    // query it falls through to the no-match whole-page fallback ('low'),
    // which is distinguishable from the short-circuit (null).
    const justOver = 'x'.repeat(3204); // estimateTokens === 801
    const res = queryExtract(justOver, 'nonexistentorphanterm', { maxTokens: 600 });
    assert.equal(res.extracted, false);
    assert.equal(res.confidence, 'low');
    assert.equal(res.markdown, justOver);
  });

  it('honors the maxTokens * 1.25 branch when it exceeds 800', () => {
    // maxTokens 2000 -> threshold = max(800, floor(2500)) = 2500.
    const under = 'x'.repeat(4000); // estimateTokens 1000 <= 2500 -> short-circuit
    const res = queryExtract(under, 'anything', { maxTokens: 2000 });
    assert.equal(res.extracted, false);
    assert.equal(res.confidence, null);
    assert.equal(res.markdown, under);
  });
});

// ---------------------------------------------------------------------------
// Fixtures large enough (> 3200 chars) to clear the 800-token short-circuit.
// ---------------------------------------------------------------------------

function twoFarApartPage() {
  // Matched sections stay small (fit the budget); Middle/Trailer bulk the page
  // past the 800-token short-circuit and separate the two matches so they are
  // non-contiguous regions.
  return [
    `# Installation`,
    `${filler(40)} quokka ${filler(10)}`,
    `# Middle chapter`,
    `${filler(260)}`,
    `# Configuration`,
    `${filler(40)} basilisk ${filler(10)}`,
    `# Trailer`,
    `${filler(260)}`,
  ].join('\n\n');
}

describe('queryExtract — no match', () => {
  it('returns the EXACT input string, extracted false, confidence low', () => {
    const md = twoFarApartPage();
    assert.ok(estimateTokens(md) > 800, 'fixture must exceed short-circuit threshold');
    const res = queryExtract(md, 'nonexistentorphanterm');
    assert.equal(res.extracted, false);
    assert.equal(res.confidence, 'low');
    assert.equal(res.sectionsSelected, 0);
    assert.equal(res.markdown, md); // identity: same string reference/content
  });

  it('treats an empty (whitespace-only) query as no match -> low', () => {
    const md = twoFarApartPage();
    const res = queryExtract(md, '   ');
    assert.equal(res.extracted, false);
    assert.equal(res.confidence, 'low');
    assert.equal(res.markdown, md);
  });
});

describe('queryExtract — section mode', () => {
  it('emits two strong matches far apart, in document order, with exactly one elision marker', () => {
    const md = twoFarApartPage();
    const res = queryExtract(md, 'quokka basilisk');
    assert.equal(res.extracted, true);
    assert.equal(res.sectionsSelected, 2);
    assert.ok(res.markdown.includes('quokka'), 'first match present');
    assert.ok(res.markdown.includes('basilisk'), 'second match present');
    assert.equal(countOccurrences(res.markdown, MARKER), 1, 'exactly one elision marker');
    assert.ok(
      res.markdown.indexOf('quokka') < res.markdown.indexOf('basilisk'),
      'document order preserved',
    );
    // Middle/Trailer sections were not selected.
    assert.ok(!res.markdown.includes('# Middle chapter'));
    assert.ok(!res.markdown.includes('# Trailer'));
    assert.ok(res.returnedTokens < res.originalTokens);
    assertNoInventedText(md, res.markdown);
  });

  it('emits a code fence top-match complete (even fence-delimiter count, content intact)', () => {
    const md = [
      `# Overview`,
      `${filler(260)}`,
      `# Zircon internals`,
      `${filler(30)}`,
      '```js\nconst zircon = require("zircon");\nzircon.start();\n```',
      `# Other`,
      `${filler(260)}`,
    ].join('\n\n');
    assert.ok(estimateTokens(md) > 800);
    const res = queryExtract(md, 'zircon');
    assert.equal(res.extracted, true);
    assert.equal(countOccurrences(res.markdown, '```') % 2, 0, 'fence delimiters balanced');
    assert.ok(res.markdown.includes('zircon.start();'), 'fence content intact');
    assert.ok(res.markdown.includes('# Zircon internals'));
    assertNoInventedText(md, res.markdown);
  });

  it('emits a table top-match in full', () => {
    const md = [
      `# Overview`,
      `${filler(260)}`,
      `# Wombat metrics`,
      `${filler(20)}`,
      '| metric | value |\n| --- | --- |\n| wombat count | 42 |\n| wombat rate | 7 |',
      `# Other`,
      `${filler(260)}`,
    ].join('\n\n');
    assert.ok(estimateTokens(md) > 800);
    const res = queryExtract(md, 'wombat');
    assert.equal(res.extracted, true);
    assert.ok(res.markdown.includes('| metric | value |'));
    assert.ok(res.markdown.includes('| wombat count | 42 |'));
    assert.ok(res.markdown.includes('| wombat rate | 7 |'));
    assertNoInventedText(md, res.markdown);
  });

  it('prepends ancestor heading breadcrumb for a deep (###) match', () => {
    const md = [
      `# Acme Manual`,
      `${filler(260)}`,
      `## Configuration`,
      `${filler(20)}`,
      `### Environment variables`,
      `${filler(30)} basilisk ${filler(30)}`,
      `## Deployment`,
      `${filler(260)}`,
    ].join('\n\n');
    assert.ok(estimateTokens(md) > 800);
    const res = queryExtract(md, 'basilisk');
    assert.equal(res.extracted, true);
    assert.ok(res.markdown.includes('# Acme Manual'), '# ancestor present');
    assert.ok(res.markdown.includes('## Configuration'), '## ancestor present');
    assert.ok(res.markdown.includes('### Environment variables'), 'matched heading present');
    // Order: # before ## before ###.
    assert.ok(res.markdown.indexOf('# Acme Manual') < res.markdown.indexOf('## Configuration'));
    assert.ok(res.markdown.indexOf('## Configuration') < res.markdown.indexOf('### Environment variables'));
    assertNoInventedText(md, res.markdown);
  });

  it('descends to block mode for an oversized top section, keeping heading + breadcrumb', () => {
    const bigBody = [];
    for (let i = 0; i < 8; i++) bigBody.push(`${filler(60)} ${i === 4 ? 'basilisk' : 'padding'} ${filler(60)}`);
    const bigSection = `## Big chapter\n\n${bigBody.join('\n\n')}`;
    const md = [
      `# Acme Manual`,
      bigSection,
      `## Small chapter`,
      `${filler(60)}`,
    ].join('\n\n');
    assert.ok(estimateTokens(md) > 800);
    const res = queryExtract(md, 'basilisk', { maxTokens: 200 });
    assert.equal(res.extracted, true);
    assert.ok(res.markdown.includes('## Big chapter'), 'section heading kept');
    assert.ok(res.markdown.includes('# Acme Manual'), 'breadcrumb kept');
    assert.ok(res.markdown.includes('basilisk'), 'matched block present');
    // Output is well under the whole oversized section.
    assert.ok(res.returnedTokens < estimateTokens(bigSection), 'descent shrinks the section');
    assert.ok(res.returnedTokens < res.originalTokens);
    assertNoInventedText(md, res.markdown);
  });
});

describe('queryExtract — block mode (heading-poor pages)', () => {
  it('selects the top paragraph plus neighbors when there are < 2 headings', () => {
    const paras = [];
    for (let i = 0; i < 10; i++) {
      let body = filler(55);
      if (i === 4) body += ' alphaneighbor';
      if (i === 5) body += ' quokka';
      if (i === 6) body += ' betaneighbor';
      paras.push(body);
    }
    const md = [`# Title`, ...paras].join('\n\n');
    assert.ok(estimateTokens(md) > 800);
    const res = queryExtract(md, 'quokka', { maxTokens: 250 });
    assert.equal(res.extracted, true);
    assert.ok(res.markdown.includes('quokka'), 'top block present');
    assert.ok(
      res.markdown.includes('betaneighbor') || res.markdown.includes('alphaneighbor'),
      'at least one neighbor included',
    );
    assert.ok(res.returnedTokens < res.originalTokens);
    assertNoInventedText(md, res.markdown);
  });
});

describe('queryExtract — invariants', () => {
  it('is deterministic (same input -> byte-identical result)', () => {
    const md = twoFarApartPage();
    const a = queryExtract(md, 'quokka basilisk');
    const b = queryExtract(md, 'quokka basilisk');
    assert.deepEqual(a, b);
  });

  it('every extracted result reduces token count and invents no text', () => {
    const md = twoFarApartPage();
    const res = queryExtract(md, 'quokka');
    assert.equal(res.extracted, true);
    assert.ok(res.returnedTokens < res.originalTokens);
    assertNoInventedText(md, res.markdown);
  });

  it('confidence is high when the top unit covers >= half the query terms', () => {
    const md = twoFarApartPage();
    const res = queryExtract(md, 'quokka'); // single term, fully covered -> coverage 1
    assert.equal(res.confidence, 'high');
  });

  it('caps deduped query terms at 64: a matching term beyond position 64 is ignored', () => {
    const md = twoFarApartPage();
    // 64 unique, non-matching filler terms, followed by a 65th term ('quokka')
    // that DOES match the fixture. If the cap truncates to the first 64
    // deduped terms, 'quokka' never participates in scoring, so the query
    // with it appended must be byte-identical to the query without it.
    const filler64 = [];
    for (let i = 0; i < 64; i++) filler64.push(`queryterm${i}`);
    const truncatedQuery = filler64.join(' ');
    const fullQuery = truncatedQuery + ' quokka';
    const a = queryExtract(md, fullQuery);
    const b = queryExtract(md, truncatedQuery);
    assert.deepEqual(a, b);
  });
});
