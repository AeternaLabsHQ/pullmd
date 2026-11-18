import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { inspectMarkup, isTooComplex, MAX_NESTING_DEPTH } from '../lib/parse-guard.js';
import { htmlFragmentToMarkdown } from '../lib/web.js';

const fixture = readFileSync(new URL('./fixtures/claude-blog-split-body.html', import.meta.url), 'utf8');

function assertTooComplex(err) {
  assert.equal(err.status, 422);
  assert.equal(err.code, 'document_too_complex');
  assert.equal(err.message, 'Document is nested too deeply or has too many elements');
  assert.equal(isTooComplex(err), true);
  return true;
}

describe('inspectMarkup', () => {
  it('exports the default depth budget', () => {
    assert.equal(MAX_NESTING_DEPTH, 1024);
  });

  it('accepts a normal article', () => {
    const r = inspectMarkup(fixture);
    assert.ok(r.depth > 0 && r.depth < 100, `depth ${r.depth}`);
    assert.ok(r.elements > 0);
  });

  it('implied closes do not count as depth', () => {
    assert.ok(inspectMarkup('<p>x'.repeat(5000)).depth < 10);
    assert.ok(inspectMarkup('<ul>' + '<li>x'.repeat(5000)).depth < 10);
  });

  it('rejects deep HTML fast', () => {
    const t0 = performance.now();
    assert.throws(() => inspectMarkup('<span>'.repeat(100_000)), assertTooComplex);
    assert.ok(performance.now() - t0 < 1000, `took ${performance.now() - t0} ms`);
  });

  it('rejects deep XML', () => {
    const t0 = performance.now();
    assert.throws(() => inspectMarkup('<rss>' + '<a>'.repeat(400_000), { xml: true }), assertTooComplex);
    assert.ok(performance.now() - t0 < 1000, `took ${performance.now() - t0} ms`);
  });

  it('element budget', () => {
    const xml = '<a/>'.repeat(2000);
    assert.throws(() => inspectMarkup(xml, { xml: true, maxElements: 1000 }), assertTooComplex);
    assert.equal(inspectMarkup(xml, { xml: true, maxElements: 5000 }).elements, 2000);
  });

  it('isTooComplex is false for other errors', () => {
    assert.equal(isTooComplex(new Error('x')), false);
    assert.equal(isTooComplex(undefined), false);
  });
});

describe('htmlFragmentToMarkdown (mail and calendar bodies)', () => {
  it('rejects an over-nested fragment fast', () => {
    const t0 = performance.now();
    assert.throws(() => htmlFragmentToMarkdown('<div>'.repeat(100_000)), assertTooComplex);
    assert.ok(performance.now() - t0 < 1000, `took ${performance.now() - t0} ms`);
  });
});
