import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { publicLookup } from './helpers/fake-dns.js';

const ORIGINAL_TRAFILATURA_URL = process.env.TRAFILATURA_URL;

describe('extractWeb with trafilatura sidecar', () => {
  before(() => {
    process.env.TRAFILATURA_URL = 'http://mock-trafilatura/extract';
  });

  after(() => {
    if (ORIGINAL_TRAFILATURA_URL === undefined) delete process.env.TRAFILATURA_URL;
    else process.env.TRAFILATURA_URL = ORIGINAL_TRAFILATURA_URL;
  });

  it('uses trafilatura when readability is thin and trafilatura is substantial', async () => {
    // Re-import to pick up new env var
    const { extractWeb } = await import(`../lib/web.js?nano=${Date.now()}`);

    const thinHtml = '<html><head><title>Promptbook</title></head><body><div class="banner">x</div></body></html>';
    const trafilaturaMd = '# Promptbook\n\n' + 'High-quality content. '.repeat(200);

    const fakeFetch = async (url) => {
      if (url.includes('mock-trafilatura')) {
        return { ok: true, text: async () => trafilaturaMd };
      }
      return {
        ok: true,
        status: 200,
        headers: new Map([['content-type', 'text/html']]),
        text: async () => thinHtml,
      };
    };

    const result = await extractWeb('https://example.com/promptbook', { fetch: fakeFetch, lookup: publicLookup });
    assert.equal(result.source, 'trafilatura');
    assert.ok(result.markdown.includes('High-quality content'));
    assert.ok(result.metadata.quality > 0);
    assert.match(result.metadata.extractorReason, /readability fell back to body|readability thin/);
  });

  it('falls back to readability when trafilatura sidecar fails', async () => {
    const { extractWeb } = await import(`../lib/web.js?nano=${Date.now()}`);

    const articleHtml = `<html><head><title>Article</title></head><body><article>${'<p>Real article content.</p>'.repeat(50)}</article></body></html>`;

    const fakeFetch = async (url) => {
      if (url.includes('mock-trafilatura')) {
        throw new Error('connection refused');
      }
      return {
        ok: true,
        status: 200,
        headers: new Map([['content-type', 'text/html']]),
        text: async () => articleHtml,
      };
    };

    const result = await extractWeb('https://example.com/article', { fetch: fakeFetch, lookup: publicLookup });
    assert.equal(result.source, 'readability');
    assert.ok(result.markdown.includes('Real article content'));
  });

  it('runs without sidecar configured (TRAFILATURA_URL unset)', async () => {
    delete process.env.TRAFILATURA_URL;
    const { extractWeb } = await import(`../lib/web.js?nano=${Date.now()}`);

    const articleHtml = `<html><head><title>Article</title></head><body><article>${'<p>Article content.</p>'.repeat(40)}</article></body></html>`;

    const fakeFetch = async () => ({
      ok: true,
      status: 200,
      headers: new Map([['content-type', 'text/html']]),
      text: async () => articleHtml,
    });

    const result = await extractWeb('https://example.com/article', { fetch: fakeFetch, lookup: publicLookup });
    assert.equal(result.source, 'readability');
    assert.ok(result.markdown.length > 0);

    process.env.TRAFILATURA_URL = 'http://mock-trafilatura/extract';
  });

  it('applies recipe select.remove to the HTML sent to the trafilatura sidecar', async () => {
    const { extractWeb } = await import(`../lib/web.js?nano=${Date.now()}`);

    const recipes = [{
      name: 'r', host: 'example.com', path: '/**',
      preprocess: [], select: { remove: ['aside.recommendations'] }, fetch: {},
    }];
    // Thin readability page so the quality auto-pick chooses trafilatura.
    const pageHtml = '<html><head><title>T</title></head><body>' +
      '<aside class="recommendations">SELECT-REMOVE-MARKER</aside>' +
      '<div class="banner">x</div></body></html>';
    const trafilaturaMd = '# T\n\n' + 'Substantial sidecar content. '.repeat(200);

    let sidecarPayload = null;
    const fakeFetch = async (url, opts) => {
      if (url.includes('mock-trafilatura')) {
        sidecarPayload = JSON.parse(opts.body);
        return { ok: true, text: async () => trafilaturaMd };
      }
      return {
        ok: true,
        status: 200,
        headers: new Map([['content-type', 'text/html']]),
        text: async () => pageHtml,
      };
    };

    const result = await extractWeb('https://example.com/page', { fetch: fakeFetch, recipes, lookup: publicLookup });
    assert.equal(result.source, 'trafilatura');
    assert.ok(sidecarPayload, 'sidecar must have been called');
    assert.equal(sidecarPayload.html.includes('SELECT-REMOVE-MARKER'), false,
      'select.remove selectors must be stripped from the HTML the sidecar receives');
    assert.equal(result.markdown.includes('SELECT-REMOVE-MARKER'), false);
  });

  it('an invalid select.remove selector is skipped without breaking extraction', async () => {
    const { extractWeb } = await import(`../lib/web.js?nano=${Date.now()}`);

    const recipes = [{
      name: 'r', host: 'example.com', path: '/**',
      preprocess: [],
      select: { remove: ['div:has-broken(', 'aside.strip-me'] },
      fetch: {},
    }];
    const pageHtml = '<html><head><title>T</title></head><body>' +
      '<aside class="strip-me">VALID-SELECTOR-MARKER</aside>' +
      '<div class="banner">x</div></body></html>';
    const trafilaturaMd = '# T\n\n' + 'Substantial sidecar content. '.repeat(200);

    let sidecarPayload = null;
    const fakeFetch = async (url, opts) => {
      if (url.includes('mock-trafilatura')) {
        sidecarPayload = JSON.parse(opts.body);
        return { ok: true, text: async () => trafilaturaMd };
      }
      return {
        ok: true,
        status: 200,
        headers: new Map([['content-type', 'text/html']]),
        text: async () => pageHtml,
      };
    };

    const result = await extractWeb('https://example.com/page', { fetch: fakeFetch, recipes, lookup: publicLookup });
    assert.equal(result.source, 'trafilatura', 'extraction must survive the invalid selector');
    assert.equal(sidecarPayload.html.includes('VALID-SELECTOR-MARKER'), false,
      'valid selectors after an invalid one must still apply');
  });

  it('recipe frontmatter selectors still see elements that select.remove strips', async () => {
    const { extractWeb } = await import(`../lib/web.js?nano=${Date.now()}`);

    const recipes = [{
      name: 'r', host: 'example.com', path: '/**',
      preprocess: [],
      select: { remove: ['span.byline'] },
      frontmatter: { fields: { author: { source: 'selector', selector: 'span.byline' } } },
      fetch: {},
    }];
    const pageHtml = '<html><head><title>T</title></head><body>' +
      '<span class="byline">Jane Doe</span>' +
      '<div class="banner">x</div></body></html>';
    const trafilaturaMd = '# T\n\n' + 'Substantial sidecar content. '.repeat(200);

    const fakeFetch = async (url) => {
      if (url.includes('mock-trafilatura')) {
        return { ok: true, text: async () => trafilaturaMd };
      }
      return {
        ok: true,
        status: 200,
        headers: new Map([['content-type', 'text/html']]),
        text: async () => pageHtml,
      };
    };

    const result = await extractWeb('https://example.com/page', { fetch: fakeFetch, recipes, lookup: publicLookup });
    assert.equal(result.metadata.recipeFields?.author, 'Jane Doe',
      'frontmatter extraction runs before select.remove strips the element');
    assert.equal(result.markdown.includes('Jane Doe'), false,
      'the stripped element must not appear in the body');
  });
});
