import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { metrics, pickBest, scoreOf, qualityScore } from '../lib/scoring.js';

describe('metrics', () => {
  it('counts headings, tables, code blocks, and length', () => {
    const md = `# Title\n\n## Sub\n\n\`\`\`js\nfoo\n\`\`\`\n\n| a | b |\n| - | - |\n| 1 | 2 |\n`;
    const m = metrics(md);
    assert.equal(m.headings, 2);
    assert.equal(m.codeBlocks, 1);
    assert.equal(m.tables, 3);
    assert.ok(m.len > 0);
  });

  it('handles empty input', () => {
    assert.deepEqual(metrics(''), { len: 0, headings: 0, tables: 0, codeBlocks: 0, paragraphs: 0 });
    assert.deepEqual(metrics(null), { len: 0, headings: 0, tables: 0, codeBlocks: 0, paragraphs: 0 });
  });

  it('counts paragraphs (text blocks separated by blank lines)', () => {
    const md = `First paragraph with enough text to count as content.\n\nSecond paragraph with similar substance and length.\n\nThird paragraph that also exceeds the threshold easily.`;
    const m = metrics(md);
    assert.ok(m.paragraphs >= 3, `expected >=3, got ${m.paragraphs}`);
  });
});

describe('pickBest', () => {
  it('prefers readability when trafilatura is empty', () => {
    const r = pickBest('# hi\n' + 'x'.repeat(2000), '');
    assert.equal(r.winner, 'readability');
    assert.match(r.reason, /trafilatura empty/);
  });

  it('picks trafilatura when readability is thin and trafilatura is substantial', () => {
    // nano-banana case: readability 107c, trafilatura 14k
    const readability = 'x'.repeat(100);
    const trafilatura = '# Title\n' + 'content '.repeat(500);
    const r = pickBest(readability, trafilatura);
    assert.equal(r.winner, 'trafilatura');
    assert.match(r.reason, /readability thin/);
  });

  it('keeps readability for API-docs-like pages (tables preserved)', () => {
    // elevenlabs case: readability has tables, trafilatura drops them
    const readability = '# API\n' + '| param | type |\n| - | - |\n| a | b |\n'.repeat(10) + 'description '.repeat(200);
    const trafilatura = 'description '.repeat(150);
    const r = pickBest(readability, trafilatura);
    assert.equal(r.winner, 'readability');
    assert.match(r.reason, /tables preserved/);
  });

  it('picks longer trafilatura when it has structure (lukas-schmalz case)', () => {
    const readability = '# Workshop\n' + 'x'.repeat(1700);
    const trafilatura = '# Workshop\n## Details\n' + 'x'.repeat(3000);
    const r = pickBest(readability, trafilatura);
    assert.equal(r.winner, 'trafilatura');
    assert.match(r.reason, /longer with structure/);
  });

  it('picks longer readability over short trafilatura', () => {
    const readability = '# Article\n' + 'x'.repeat(8000);
    const trafilatura = '# Short\n' + 'x'.repeat(2000);
    const r = pickBest(readability, trafilatura);
    assert.equal(r.winner, 'readability');
    assert.match(r.reason, /longer with structure/);
  });

  it('picks trafilatura when readability fell back to body-soup (nano-banana case)', () => {
    // Readability fallback gives 22k of nav/body soup; Trafilatura gives 14k of real content
    const readabilityFallback = '# Title\n' + '- [Home](/)\n- [Pricing](/pricing)\n'.repeat(50) + 'x'.repeat(20000);
    const trafilatura = '# Real Article\n' + 'real content '.repeat(1500);
    const r = pickBest(readabilityFallback, trafilatura, true);
    assert.equal(r.winner, 'trafilatura');
    assert.match(r.reason, /readability fell back to body/);
  });

  it('falls back to readability for comparable lengths (stability bias)', () => {
    const readability = '# A\n' + 'x'.repeat(4000);
    const trafilatura = '# A\n' + 'x'.repeat(4100);
    const r = pickBest(readability, trafilatura);
    assert.equal(r.winner, 'readability');
    assert.match(r.reason, /comparable/);
  });
});

describe('qualityScore', () => {
  it('returns 0 for empty markdown', () => {
    assert.equal(qualityScore(''), 0);
    assert.equal(qualityScore(null), 0);
  });

  it('returns full score for substantial article-shaped markdown with article tag', () => {
    const md = '# Title\n\n' + 'A paragraph with enough length to count as content. '.repeat(3) + '\n\n' +
      'Another paragraph that adds substantial body text for the heuristic. '.repeat(3) + '\n\n' +
      'Third paragraph with even more relevant text content here. '.repeat(3) + '\n\n' +
      'x'.repeat(200);
    const html = '<html><body><article>' + 'x'.repeat(md.length * 30) + '</article></body></html>';
    const score = qualityScore(md, { rawHtml: html });
    // 0.3 (>500c) + 0.2 (ratio>2%? 1/30=3.3%) + 0.2 (article) + 0.15 (heading) + 0.15 (3 paragraphs) = 1.0
    assert.equal(score, 1);
  });

  it('penalizes when extracted ratio is too low (over-stripped)', () => {
    const md = '# Title\n\n' +
      'A first paragraph that is long enough to count as a real content block.\n\n' +
      'A second paragraph also long enough to qualify under the heuristic threshold.\n\n' +
      'A third paragraph that easily clears the forty-character minimum length.';
    const heavyHtml = '<html><body>' + 'x'.repeat(md.length * 100) + '</body></html>'; // ratio 1%
    const score = qualityScore(md, { rawHtml: heavyHtml });
    // No 0.3 (len<500), no 0.2 (ratio<2%), no 0.2 (no article), 0.15 heading, 0.15 paragraphs
    assert.equal(score, 0.3);
  });

  it('rewards article or main tag presence', () => {
    const md = 'just text content here.\n\nanother sentence with similar length.\n\nthird sentence to make the threshold.';
    const withArticle = qualityScore(md, { rawHtml: '<html><body><article>x</article></body></html>' });
    const withoutArticle = qualityScore(md, { rawHtml: '<html><body><div>x</div></body></html>' });
    assert.ok(withArticle > withoutArticle);
  });

  it('grants non-html-source bonus for Reddit/Cloudflare paths', () => {
    const md = '# Post Title\n\n' +
      'A first comment with sufficient text length to count under the heuristic.\n\n' +
      'A second comment that also exceeds the forty-character paragraph minimum.\n\n' +
      'A third comment also long enough to register as a content paragraph here.';
    const score = qualityScore(md);
    // 0 (len<500) + 0.4 (non-html bonus) + 0.15 heading + 0.15 paragraphs = 0.7
    assert.ok(score >= 0.7, `got ${score}`);
  });
});

describe('scoreOf', () => {
  it('returns 0 for empty', () => {
    assert.equal(scoreOf({ len: 0, headings: 0, tables: 0, codeBlocks: 0 }), 0);
  });

  it('caps length contribution at 5000c', () => {
    const small = scoreOf({ len: 5000, headings: 1, tables: 0, codeBlocks: 0 });
    const huge = scoreOf({ len: 50000, headings: 1, tables: 0, codeBlocks: 0 });
    assert.equal(small, huge);
  });

  it('rewards structured content', () => {
    const plain = scoreOf({ len: 5000, headings: 0, tables: 0, codeBlocks: 0 });
    const structured = scoreOf({ len: 5000, headings: 3, tables: 2, codeBlocks: 1 });
    assert.ok(structured > plain);
    assert.ok(structured <= 1);
  });
});

describe('metrics on a multi-megabyte single line (#98)', () => {
  it('counts the paragraph without overflowing the regex stack', () => {
    const md = 'lorem ipsum dolor sit amet '.repeat(400_000);
    const m = metrics(md);
    assert.equal(m.paragraphs, 1);
    assert.equal(m.len, md.length);
  });
  it('still needs 40+ characters after the first for a paragraph', () => {
    assert.equal(metrics('a'.repeat(40)).paragraphs, 0);
    assert.equal(metrics('a'.repeat(41)).paragraphs, 1);
    assert.equal(metrics('a'.repeat(50) + '\n\n' + 'b'.repeat(50)).paragraphs, 2);
  });
});
