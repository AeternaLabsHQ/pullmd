import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { extractHtml } from '../lib/web.js';

const LONG_PARAGRAPH = 'Main content paragraph that needs to be long enough for the Readability extraction to consider it substantial content worth keeping. This paragraph contains enough text to exceed the minimum threshold for content extraction, ensuring that the Readability algorithm identifies it as the main article body.';

const ARTICLE_HTML = `
  <html><head><title>Saved Article</title></head>
  <body>
    <nav>Menu</nav>
    <article><h1>Saved Article</h1><p>${LONG_PARAGRAPH}</p></article>
    <footer>Footer stuff</footer>
  </body></html>
`;

describe('extractHtml - basic conversion (no URL)', () => {
  it('converts HTML and performs no fetch', async () => {
    let fetchCalls = 0;
    const result = await extractHtml(ARTICLE_HTML, {
      filename: 'saved-article.html',
      extractor: 'readability',
      fetch: async () => { fetchCalls++; throw new Error('must not fetch'); },
    });
    assert.ok(result.markdown.includes('Main content paragraph'));
    assert.equal(result.title, 'Saved Article');
    assert.equal(fetchCalls, 0, 'extractHtml must not fetch anything');
  });

  it('uses the filename in the header and renders no link line', async () => {
    const prev = process.env.PULLMD_SOURCE_HEADER; process.env.PULLMD_SOURCE_HEADER = 'true';
    const result = await extractHtml(ARTICLE_HTML, { filename: 'saved-article.html' });
    assert.ok(result.markdown.includes('**saved-article.html**'));
    assert.ok(!result.markdown.includes('http'), 'header must not contain a link');
    if (prev === undefined) delete process.env.PULLMD_SOURCE_HEADER; else process.env.PULLMD_SOURCE_HEADER = prev;
  });

  it('sets metadata.sourceUrl to null and exposes contentLength', async () => {
    const result = await extractHtml(ARTICLE_HTML, { filename: 'x.html' });
    assert.equal(result.metadata.sourceUrl, null);
    assert.ok(result.metadata.contentLength > 200, `contentLength was ${result.metadata.contentLength}`);
  });

  it('title falls back to filename, then Untitled', async () => {
    const noTitle = `<html><body><article><p>${LONG_PARAGRAPH}</p></article></body></html>`;
    const withFile = await extractHtml(noTitle, { filename: 'report.html' });
    assert.equal(withFile.title, 'report.html');
    const bare = await extractHtml(noTitle, {});
    assert.equal(bare.title, 'Untitled');
  });
});

describe('extractHtml - with original URL', () => {
  it('renders the standard linked header and sourceUrl', async () => {
    const prev = process.env.PULLMD_SOURCE_HEADER; process.env.PULLMD_SOURCE_HEADER = 'true';
    const result = await extractHtml(ARTICLE_HTML, { url: 'https://www.example.com/post' });
    assert.ok(result.markdown.includes('**example.com**'));
    assert.ok(result.markdown.includes('https://www.example.com/post'));
    assert.equal(result.metadata.sourceUrl, 'https://www.example.com/post');
    if (prev === undefined) delete process.env.PULLMD_SOURCE_HEADER; else process.env.PULLMD_SOURCE_HEADER = prev;
  });

  it('applies matching recipes only when a URL is provided', async () => {
    const html = `
      <html><head><title>T</title></head>
      <body><article>
        <p class="junk">SUBSCRIBE NOW BANNER</p>
        <p>${LONG_PARAGRAPH}</p>
      </article></body></html>
    `;
    const recipes = [{ host: 'example.com', select: { remove: ['.junk'] } }];
    const withUrl = await extractHtml(html, { url: 'https://example.com/a', recipes });
    assert.ok(!withUrl.markdown.includes('SUBSCRIBE NOW BANNER'));
    const withoutUrl = await extractHtml(html, { recipes });
    assert.ok(withoutUrl.markdown.includes('SUBSCRIBE NOW BANNER'), 'no url → recipes must not apply');
  });
});

describe('extractHtml - data: URI images (SingleFile exports)', () => {
  it('replaces inlined images with their alt text and drops alt-less ones', async () => {
    const html = `
      <html><head><title>Pics</title></head>
      <body><article>
        <p>${LONG_PARAGRAPH}</p>
        <p><img src="data:image/png;base64,iVBORw0KGgo${'A'.repeat(500)}" alt="Chart of results"></p>
        <p><img src="data:image/gif;base64,R0lGODlh${'B'.repeat(300)}"></p>
      </article></body></html>
    `;
    const result = await extractHtml(html, { filename: 'pics.html' });
    assert.ok(!result.markdown.includes('data:image'), 'no data: URIs in output');
    assert.ok(result.markdown.includes('Chart of results'), 'alt text survives');
  });
});
