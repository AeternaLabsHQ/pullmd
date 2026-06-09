import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildFrontmatter, mergeFrontmatter, mergeMediaFrontmatter, KNOWN_FRONTMATTER_FIELDS, validateFrontmatterFields } from '../lib/frontmatter.js';

describe('buildFrontmatter', () => {
  it('emits a YAML block with delimiters and trailing blank line', () => {
    const out = buildFrontmatter({ title: 'Hello', sourceUrl: 'https://example.com' });
    assert.match(out, /^---\n/);
    assert.match(out, /\n---\n\n$/);
  });

  it('includes title, url, source, quality fields when present', () => {
    const out = buildFrontmatter(
      { title: 'My Article', sourceUrl: 'https://example.com/a', quality: 0.85 },
      { source: 'trafilatura' }
    );
    assert.match(out, /title: My Article/);
    assert.match(out, /url: https:\/\/example\.com\/a/);
    assert.match(out, /source: trafilatura/);
    assert.match(out, /quality: 0\.85/);
  });

  it('skips null and undefined fields', () => {
    const out = buildFrontmatter({ title: 'X', author: null, description: undefined });
    assert.match(out, /title: X/);
    assert.doesNotMatch(out, /author:/);
    assert.doesNotMatch(out, /description:/);
  });

  it('quotes strings containing key-separator pattern (: with space)', () => {
    const out = buildFrontmatter({ title: 'X: a Y' });
    assert.match(out, /title: "X: a Y"/);
  });

  it('does not quote URLs (colon without space)', () => {
    const out = buildFrontmatter({ title: 'X', sourceUrl: 'https://example.com/a' });
    assert.match(out, /url: https:\/\/example\.com\/a/);
  });

  it('quotes strings containing quotes', () => {
    const out = buildFrontmatter({ title: 'He said "hi"' });
    assert.match(out, /title: "He said \\"hi\\""/);
  });

  it('quotes YAML keywords like true/false/null', () => {
    const out = buildFrontmatter({ title: 'true' });
    assert.match(out, /title: "true"/);
  });

  it('neutralizes carriage returns so a crafted title cannot inject a YAML line', () => {
    const out = buildFrontmatter({ title: 'x\rinjected: pwned' });
    assert.ok(!out.includes('\r'), 'raw carriage return must not survive in the frontmatter');
    assert.match(out, /title: "x injected: pwned"/);
  });

  it('neutralizes a bare carriage return even without other special chars', () => {
    const out = buildFrontmatter({ title: 'line1\rline2' });
    assert.ok(!out.includes('\r'), 'raw carriage return must not survive in the frontmatter');
  });

  it('emits ISO 8601 fetched timestamp', () => {
    const out = buildFrontmatter({ title: 'X' });
    assert.match(out, /fetched: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it('returns an empty-fields-only block when metadata has no useful data', () => {
    const out = buildFrontmatter({});
    // still has fetched timestamp
    assert.match(out, /^---\nfetched: /);
  });

  it('falls back from sourceUrl to canonical when sourceUrl missing', () => {
    const out = buildFrontmatter({ canonical: 'https://canonical.example/' });
    assert.match(out, /url: https:\/\/canonical\.example\//);
  });

  it('uses ogDescription when description is null', () => {
    const out = buildFrontmatter({ description: null, ogDescription: 'OG fallback' });
    assert.match(out, /description: OG fallback/);
  });

  it('includes share_id and source from opts', () => {
    const out = buildFrontmatter({ title: 'X' }, { source: 'reddit', shareId: 'abc12345' });
    assert.match(out, /source: reddit/);
    assert.match(out, /share_id: abc12345/);
  });
});

describe('mergeMediaFrontmatter', () => {
  it('adds duration/views for a youtube source', () => {
    const md = '---\ntitle: T\nsource: youtube\n---\n\nbody';
    const out = mergeMediaFrontmatter(md, { ytDuration: '12:34', ytViews: '1000' }, 'youtube');
    assert.match(out, /duration: 12:34/);
    assert.match(out, /views: 1000/);
  });

  it('adds image_size + llm fields for an image-caption source', () => {
    const md = '---\ntitle: P\nsource: image-caption\n---\n\nbody';
    const out = mergeMediaFrontmatter(md, { imageSize: '800x600', llmModel: 'gpt-4o-mini', llmTokens: 42 }, 'image-caption');
    assert.match(out, /image_size: 800x600/);
    assert.match(out, /llm_model: gpt-4o-mini/);
    assert.match(out, /llm_tokens: 42/);
  });

  it('adds pdf_pages for a pdf-ocr source', () => {
    const md = '---\ntitle: D\nsource: pdf-ocr\n---\n\nbody';
    const out = mergeMediaFrontmatter(md, { pdfPages: 7 }, 'pdf-ocr');
    assert.match(out, /pdf_pages: 7/);
  });

  it('is a no-op for non-media sources', () => {
    const md = '---\ntitle: T\nsource: readability\n---\n\nbody';
    const out = mergeMediaFrontmatter(md, { ytDuration: '12:34' }, 'readability');
    assert.equal(out, md);
  });

  it('does not duplicate a field already present in the block', () => {
    const md = '---\ntitle: T\nsource: youtube\nduration: 99:99\n---\n\nbody';
    const out = mergeMediaFrontmatter(md, { ytDuration: '12:34' }, 'youtube');
    assert.match(out, /duration: 99:99/);
    assert.doesNotMatch(out, /duration: 12:34/);
  });
});

describe('PULLMD_FRONTMATTER_FIELDS allowlist', () => {
  const save = () => process.env.PULLMD_FRONTMATTER_FIELDS;
  const restore = (p) => { if (p === undefined) delete process.env.PULLMD_FRONTMATTER_FIELDS; else process.env.PULLMD_FRONTMATTER_FIELDS = p; };

  it('emits all fields when unset OR empty', () => {
    const p = save();
    delete process.env.PULLMD_FRONTMATTER_FIELDS;
    let fm = buildFrontmatter({ title: 'T', sourceUrl: 'https://e/x', quality: 0.9 }, { source: 'web' });
    assert.ok(fm.includes('title:') && fm.includes('url:') && fm.includes('source:') && fm.includes('quality:'));
    process.env.PULLMD_FRONTMATTER_FIELDS = '';   // empty == unset == all
    fm = buildFrontmatter({ title: 'T', sourceUrl: 'https://e/x', quality: 0.9 }, { source: 'web' });
    assert.ok(fm.includes('title:') && fm.includes('quality:'));
    restore(p);
  });

  it('emits only allowlisted fields when set', () => {
    const p = save(); process.env.PULLMD_FRONTMATTER_FIELDS = 'title,source';
    const fm = buildFrontmatter({ title: 'T', sourceUrl: 'https://e/x', quality: 0.9, author: 'A' }, { source: 'web' });
    assert.ok(fm.includes('title:') && fm.includes('source:'));
    assert.ok(!fm.includes('url:') && !fm.includes('quality:') && !fm.includes('author:'));
    restore(p);
  });

  it('mergeFrontmatter respects the allowlist', () => {
    const p = save(); process.env.PULLMD_FRONTMATTER_FIELDS = 'title';
    const merged = mergeFrontmatter(buildFrontmatter({ title: 'T' }, { source: 'youtube' }), [['duration', '12:34'], ['views', '1000']]);
    assert.ok(!merged.includes('duration:') && !merged.includes('views:'));
    restore(p);
  });

  it('all-unknown names → falls back to ALL fields (not empty)', () => {
    const p = save(); process.env.PULLMD_FRONTMATTER_FIELDS = 'titel,sauce';   // typos
    const fm = buildFrontmatter({ title: 'T', sourceUrl: 'https://e/x', quality: 0.9 }, { source: 'web' });
    assert.ok(fm.includes('title:') && fm.includes('url:') && fm.includes('quality:'), 'fallback to all');
    restore(p);
  });

  it('valid field with no matching value → no empty block', () => {
    const p = save(); process.env.PULLMD_FRONTMATTER_FIELDS = 'llm_tokens';   // valid name, but no LLM usage here
    const fm = buildFrontmatter({ title: 'T', sourceUrl: 'https://e/x' }, { source: 'web' });
    assert.equal(fm, '', 'no fields to emit → empty string, not "---\\n---"');
    restore(p);
  });

  it('validateFrontmatterFields warns on unknown names, silent when all valid/unset', () => {
    const warns = [];
    const warn = (m) => warns.push(m);
    validateFrontmatterFields({ PULLMD_FRONTMATTER_FIELDS: 'title,bogus,views' }, warn);
    assert.equal(warns.length, 1);
    assert.ok(warns[0].includes('bogus'));
    warns.length = 0;
    validateFrontmatterFields({ PULLMD_FRONTMATTER_FIELDS: 'title,views' }, warn);
    validateFrontmatterFields({}, warn);
    assert.equal(warns.length, 0);
    // KNOWN set sanity:
    assert.ok(KNOWN_FRONTMATTER_FIELDS.has('llm_tokens') && KNOWN_FRONTMATTER_FIELDS.has('title'));
  });
});
