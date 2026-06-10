import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { extractWeb, extractHtml } from '../lib/web.js';

// Relative URLs in the source HTML must be resolved against the page URL
// before extraction, so markdown image/link targets work outside the
// origin (e.g. when rendered on the PullMD share page).

function htmlResponse(html) {
  return {
    ok: true,
    status: 200,
    headers: { get: (h) => h === 'content-type' ? 'text/html; charset=utf-8' : null },
    text: async () => html,
  };
}

const PAD = '<p>' + 'Lorem ipsum dolor sit amet, consectetur adipiscing elit. '.repeat(20) + '</p>';

describe('relative URL resolution (readability path)', () => {
  it('absolutifies root-relative image src and link href against the page URL', async () => {
    const html = `<html><head><title>T</title></head><body><article><h1>Head</h1>${PAD}
      <img src="/images/1920/helmet.webp" alt="pic">
      <p><a href="/other/page">link</a> trailing text to keep the paragraph substantial.</p>
    </article></body></html>`;

    const result = await extractWeb('https://www.sciencedaily.com/releases/2026/06/article.htm', {
      fetch: async () => htmlResponse(html),
    });

    assert.ok(result.markdown.includes('![pic](https://www.sciencedaily.com/images/1920/helmet.webp)'),
      `expected absolute image URL, got:\n${result.markdown}`);
    assert.ok(result.markdown.includes('](https://www.sciencedaily.com/other/page)'),
      `expected absolute link URL, got:\n${result.markdown}`);
  });

  it('resolves page-relative and protocol-relative URLs', async () => {
    const html = `<html><head><title>T</title></head><body><article><h1>Head</h1>${PAD}
      <img src="img/photo.jpg" alt="rel">
      <img src="//cdn.example.com/asset.png" alt="proto">
    </article></body></html>`;

    const result = await extractWeb('https://example.com/blog/post/', {
      fetch: async () => htmlResponse(html),
    });

    assert.ok(result.markdown.includes('![rel](https://example.com/blog/post/img/photo.jpg)'),
      `expected page-relative resolution, got:\n${result.markdown}`);
    assert.ok(result.markdown.includes('![proto](https://cdn.example.com/asset.png)'),
      `expected protocol-relative resolution, got:\n${result.markdown}`);
  });

  it('leaves absolute, data:, mailto: and fragment URLs untouched', async () => {
    const html = `<html><head><title>T</title></head><body><article><h1>Head</h1>${PAD}
      <img src="https://other.example.org/pic.png" alt="abs">
      <img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" alt="inline">
      <p><a href="mailto:hi@example.com">mail</a> and <a href="#section">jump</a> stay as they are.</p>
    </article></body></html>`;

    const result = await extractWeb('https://example.com/page', {
      fetch: async () => htmlResponse(html),
    });

    assert.ok(result.markdown.includes('![abs](https://other.example.org/pic.png)'));
    // Readability drops data: images today — the fix must at least not
    // resolve them into nonsense like https://example.com/data:image/...
    assert.ok(!result.markdown.includes('example.com/data:'));
    assert.ok(result.markdown.includes('(mailto:hi@example.com)'));
    assert.ok(result.markdown.includes('(#section)'),
      `fragment link should stay relative, got:\n${result.markdown}`);
  });
});

describe('relative URL resolution (extractHtml, no source URL)', () => {
  it('leaves relative URLs as-is when there is no URL to resolve against', async () => {
    const html = `<html><head><title>T</title></head><body><article><h1>Head</h1>${PAD}
      <img src="/images/local.png" alt="pic">
    </article></body></html>`;

    const result = await extractHtml(html, {});
    assert.ok(result.markdown.includes('![pic](/images/local.png)'),
      `expected untouched relative URL, got:\n${result.markdown}`);
  });
});

describe('relative URL resolution (trafilatura path)', () => {
  const ORIGINAL = process.env.TRAFILATURA_URL;

  before(() => { process.env.TRAFILATURA_URL = 'http://mock-trafilatura/extract'; });
  after(() => {
    if (ORIGINAL === undefined) delete process.env.TRAFILATURA_URL;
    else process.env.TRAFILATURA_URL = ORIGINAL;
  });

  it('sends absolutified HTML (src and srcset) to the sidecar', async () => {
    const { extractWeb: extractWebFresh } = await import(`../lib/web.js?absolutify=${Math.random()}`);

    const html = `<html><head><title>T</title></head><body><article><h1>Head</h1>${PAD}
      <img src="/images/helmet.webp" srcset="/images/helmet-480.webp 480w, /images/helmet-960.webp 960w" alt="pic">
    </article></body></html>`;

    let sidecarBody = null;
    const fakeFetch = async (url, opts) => {
      if (String(url).includes('mock-trafilatura')) {
        sidecarBody = JSON.parse(opts.body);
        return { ok: true, text: async () => '' };
      }
      return htmlResponse(html);
    };

    await extractWebFresh('https://www.sciencedaily.com/releases/article.htm', { fetch: fakeFetch });

    assert.ok(sidecarBody, 'sidecar should have been called');
    assert.ok(sidecarBody.html.includes('https://www.sciencedaily.com/images/helmet.webp'),
      'img src sent to sidecar should be absolute');
    assert.ok(sidecarBody.html.includes('https://www.sciencedaily.com/images/helmet-480.webp 480w'),
      'srcset entries sent to sidecar should be absolute');
    assert.ok(!sidecarBody.html.includes('"/images/'),
      'no root-relative src/srcset should remain in sidecar HTML');
  });
});
