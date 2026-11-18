import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { findArticleSeries, seriesToMarkdown, isEnabled } from '../lib/article-series.js';
import { extractHtml } from '../lib/web.js';

const URL_ = 'https://example.org/alice/posts/1';
const sentence = (n) => `Post number ${n} makes a distinct point about the subject, with enough plain words to read like real prose and not like a label or a caption.`;

const post = (author, n, { text = sentence(n), extra = '', stats = true } = {}) => `
  <article class="post">
    <a href="/${author}"><img alt="@${author}" src="/avatars/${author}.jpg"></a>
    <div><a href="/${author}">${author}</a><a href="/${author}">@${author}</a></div>
    <a href="/${author}/posts/${n}">Nov ${n}</a>
    <p>${text}</p>
    ${extra}
    ${stats ? `<a href="/compose?to=${n}">24</a><div>1K</div><div>5.2K</div>` : ''}
  </article>`;

const page = (inner, chrome = '') => `<!doctype html><html><head><title>A page</title></head>
  <body><main>${inner}</main>${chrome}</body></html>`;

const seriesOf = (html) => {
  const { document } = parseHTML(html);
  return findArticleSeries(document);
};

function withEnv(value, fn) {
  const prev = process.env.PULLMD_ARTICLE_SERIES;
  if (value === undefined) delete process.env.PULLMD_ARTICLE_SERIES;
  else process.env.PULLMD_ARTICLE_SERIES = value;
  const restore = () => {
    if (prev === undefined) delete process.env.PULLMD_ARTICLE_SERIES;
    else process.env.PULLMD_ARTICLE_SERIES = prev;
  };
  try {
    const r = fn();
    if (r && typeof r.then === 'function') return r.finally(restore);
    restore();
    return r;
  } catch (e) { restore(); throw e; }
}

describe('findArticleSeries', () => {
  it('finds posts that share a lead link', () => {
    const s = seriesOf(page([1, 2, 3, 4].map((n) => post('alice', n)).join('')));
    assert.equal(s.blocks.length, 4);
  });

  it('drops a duplicate and keeps its LAST position, so a linked post stays in order', () => {
    const html = page(post('alice', 3) + post('alice', 1) + post('alice', 2) + post('alice', 3) + post('alice', 4));
    const s = seriesOf(html);
    const order = s.blocks.map((b) => b.textContent.match(/Post number (\d)/)[1]);
    assert.deepEqual(order, ['1', '2', '3', '4']);
    assert.equal(s.duplicates, 1);
  });

  it('leaves out a stray post from someone else', () => {
    const s = seriesOf(page([1, 2, 3].map((n) => post('alice', n)).join('') + post('bob', 9)));
    assert.equal(s.blocks.length, 3);
    assert.equal(s.others, 1);
    assert.ok(!s.blocks.some((b) => b.textContent.includes('bob')));
  });

  it('does not count an article nested inside another as its own block', () => {
    const quoted = post('carol', 7);
    const s = seriesOf(page(post('alice', 1, { extra: quoted }) + post('alice', 2) + post('alice', 3)));
    assert.equal(s.blocks.length, 3);
    assert.equal(s.others, 0);
  });

  it('ignores a single post with one reply', () => {
    assert.equal(seriesOf(page(post('alice', 1) + post('alice', 1) + post('bob', 2))), null);
  });

  it('ignores a page with one article', () => {
    assert.equal(seriesOf(page(post('alice', 1))), null);
  });

  it('ignores a discussion among many people', () => {
    const html = page(post('alice', 1) + post('bob', 2) + post('alice', 3) + post('carol', 4) + post('dave', 5));
    assert.equal(seriesOf(html), null);
  });

  it('ignores a teaser list where every card links to itself first', () => {
    const cards = [1, 2, 3, 4].map((n) => `<article><a href="/news/${n}">Read story ${n}</a><p>${sentence(n)}</p></article>`);
    assert.equal(seriesOf(page(cards.join(''))), null);
  });

  it('ignores a list of headlined cards from one author', () => {
    const cards = [1, 2, 3].map((n) => `<article><a href="/alice">alice</a><h2>Headline ${n}</h2><p>${sentence(n)}</p></article>`);
    assert.equal(seriesOf(page(cards.join(''))), null);
  });

  it('ignores blocks that are mostly links', () => {
    const cards = [1, 2, 3].map((n) => `<article><a href="/alice">alice</a><a href="/s/${n}">${sentence(n)}</a></article>`);
    assert.equal(seriesOf(page(cards.join(''))), null);
  });

  it('ignores a series that is only a small part of the page', () => {
    const chrome = `<div>${'Unrelated page text that belongs to something else entirely. '.repeat(60)}</div>`;
    assert.equal(seriesOf(page([1, 2].map((n) => post('alice', n)).join(''), chrome)), null);
  });

  it('ignores a page where one block carries nearly all the text', () => {
    const long = Array.from({ length: 30 }, (_, i) => sentence(i)).join(' ');
    assert.equal(seriesOf(page(post('alice', 1, { text: long }) + post('alice', 2))), null);
  });
});

describe('seriesToMarkdown', () => {
  it('keeps every post text', async () => {
    const { NodeHtmlMarkdown } = await import('node-html-markdown');
    const nhm = new NodeHtmlMarkdown();
    const s = seriesOf(page([1, 2, 3].map((n) => post('alice', n)).join('')));
    const md = seriesToMarkdown(s.blocks, (h) => nhm.translate(h));
    for (const n of [1, 2, 3]) assert.ok(md.includes(`Post number ${n} makes`), `post ${n}`);
    assert.equal(md.split('\n---\n').length, 3);
  });

  it('shows the repeated byline once and keeps per-post permalinks', async () => {
    const { NodeHtmlMarkdown } = await import('node-html-markdown');
    const nhm = new NodeHtmlMarkdown();
    const s = seriesOf(page([1, 2, 3].map((n) => post('alice', n)).join('')));
    const md = seriesToMarkdown(s.blocks, (h) => nhm.translate(h));
    assert.equal(md.match(/avatars\/alice\.jpg/g).length, 1);
    for (const n of [1, 2, 3]) assert.ok(md.includes(`/alice/posts/${n}`), `permalink ${n}`);
  });

  it('removes trailing counters but keeps a lone number at the end of a post', async () => {
    const { NodeHtmlMarkdown } = await import('node-html-markdown');
    const nhm = new NodeHtmlMarkdown();
    const s = seriesOf(page(
      post('alice', 1) + post('alice', 2, { stats: false, extra: '<div>42</div>' }) + post('alice', 3),
    ));
    const md = seriesToMarkdown(s.blocks, (h) => nhm.translate(h));
    assert.ok(!md.includes('5.2K'));
    assert.ok(!md.includes('/compose'));
    assert.match(md, /\n42\n/);
  });

  it('renders a nested article as a quote', async () => {
    const { NodeHtmlMarkdown } = await import('node-html-markdown');
    const nhm = new NodeHtmlMarkdown();
    const s = seriesOf(page(post('alice', 1, { extra: post('carol', 7, { stats: false }) }) + post('alice', 2)));
    const md = seriesToMarkdown(s.blocks, (h) => nhm.translate(h));
    assert.match(md, /^> .*Post number 7 makes/m);
  });

  it('removes empty links, also inside a quote', async () => {
    const { NodeHtmlMarkdown } = await import('node-html-markdown');
    const nhm = new NodeHtmlMarkdown();
    const quoted = post('carol', 7, { stats: false, extra: '<a href="/carol/posts/7/photo/1"></a>' });
    const s = seriesOf(page(post('alice', 1, { extra: quoted }) + post('alice', 2)));
    const md = seriesToMarkdown(s.blocks, (h) => nhm.translate(h));
    assert.ok(!md.includes('photo/1'));
  });
});

describe('isEnabled', () => {
  it('is on by default and off with PULLMD_ARTICLE_SERIES=off', () => {
    withEnv(undefined, () => assert.equal(isEnabled(), true));
    withEnv('off', () => assert.equal(isEnabled(), false));
    withEnv(' OFF ', () => assert.equal(isEnabled(), false));
  });
});

describe('extractHtml integration', () => {
  // The shape that makes Readability commit to one block: the opening post in
  // <main>, the rest in a separate list outside it, the text in plain spans.
  const spanned = (author, n) => post(author, n).replace(/<p>(.*?)<\/p>/, '<span>$1</span>');
  const item = (author, n) => `<li>${spanned(author, n)}</li>`;
  const thread = `<!doctype html><html><head><title>A page</title></head><body>
    <div><main><section>${spanned('alice', 1)}</section></main></div>
    <div><ul>${item('alice', 1)}${[2, 3, 4, 5].map((n) => item('alice', n)).join('')}${item('bob', 9)}</ul></div>
  </body></html>`;

  it('returns the whole series with absolute links and states what it did', async () => {
    const r = await extractHtml(thread, { url: URL_ });
    assert.equal(r.source, 'article-series');
    for (const n of [1, 2, 3, 4, 5]) assert.ok(r.markdown.includes(`Post number ${n} makes`), `post ${n}`);
    assert.ok(!r.markdown.includes('Post number 9'));
    assert.ok(r.markdown.includes('https://example.org/alice/posts/3'));
    assert.match(r.metadata.extractorReason, /article series: 5 articles/);
    assert.match(r.metadata.extractorReason, /1 duplicate/);
    assert.match(r.metadata.extractorReason, /1 other/);
    assert.equal(r.metadata.contentLength > 500, true);
  });

  it('does not touch an ordinary article with comments from other people', async () => {
    const body = Array.from({ length: 12 }, (_, i) => `<p>${sentence(i)}</p>`).join('');
    const html = page(`<article><h1>Title</h1>${body}</article>${post('bob', 1)}${post('carol', 2)}${post('dave', 3)}`);
    const r = await extractHtml(html, { url: URL_ });
    assert.notEqual(r.source, 'article-series');
  });

  it('is skipped when disabled', async () => {
    await withEnv('off', async () => {
      const r = await extractHtml(thread, { url: URL_ });
      assert.notEqual(r.source, 'article-series');
    });
  });

  it('is skipped when the caller forces a static extractor', async () => {
    const r = await extractHtml(thread, { url: URL_, extractor: 'readability' });
    assert.equal(r.source, 'readability');
  });
});

// linkedom writes the decoded text of a <title> back unescaped, so the
// innerHTML of a nested article can be far more markup than it parsed from.
describe('seriesToMarkdown - nested article chains', () => {
  const chainPage = (K, M) => {
    const txt = (i) => `post ${i} ` + 'words here and there '.repeat(10);
    const chain = '<article>'.repeat(K) + '<p>inner</p>' + '<b></b>'.repeat(M) + '</article>'.repeat(K);
    return '<html><body>' + Array.from({ length: 4 }, (_, i) =>
      `<article><a href="/u/ann">Ann</a><p>${txt(i)}</p>${i === 0 ? chain : ''}</article>`).join('') + '</body></html>';
  };

  it('quotes a nested article inside a nested article as a nested quote', () => {
    const { document } = parseHTML('<html><body><article><p>a</p><article><p>b</p><article><p>c</p></article></article></article></body></html>');
    const md = seriesToMarkdown([document.querySelector('article')], (h) => h);
    assert.equal(md, '<p>a</p><blockquote><p>b</p><blockquote><p>c</p></blockquote></blockquote>');
    assert.equal(document.querySelectorAll('article').length, 1);
  });

  // Each nested article is moved once instead of being serialized and parsed
  // again at every nesting level (which was quadratic and ran out of memory).
  for (const [K, M] of [[100, 90_000], [250, 38_000]]) {
    it(`a chain of ${K} nested articles with ${M / 1000}k siblings finishes fast`, () => {
      const { document } = parseHTML(chainPage(K, M));
      const s = findArticleSeries(document);
      assert.equal(s.blocks.length, 4);
      const t0 = performance.now();
      const md = seriesToMarkdown(s.blocks, (h) => h);
      const ms = performance.now() - t0;
      assert.ok(ms < 5000, `took ${ms} ms`);
      assert.equal(md.match(/<blockquote>/g).length, K);
      assert.ok(md.includes('<p>inner</p>'));
      assert.equal(md.split('\n---\n').length, 4);
    });
  }

  // Standalone this takes about 3.3 s (Readability and the series re-parse on
  // 38k siblings, all inside the budgets); before the fix it ran for minutes
  // or out of memory. The bound is a backstop for the parallel suite.
  it('the K=250 chain page converts through extractHtml, 200 or 422', async () => {
    const t0 = performance.now();
    try {
      const r = await extractHtml(chainPage(250, 38_000), { recipes: [], fetch: async () => { throw new Error('no network'); } });
      assert.equal(typeof r.markdown, 'string');
      assert.equal(r.source, 'readability');
    } catch (err) {
      assert.equal(err.code, 'document_too_complex');
    }
    assert.ok(performance.now() - t0 < 15000, `took ${performance.now() - t0} ms`);
  });

  // A body <title> inside a nested article is text after parseHtmlDocument, so
  // nothing in the series path can turn it back into markup.
  it('a nested <title> with escaped markup converts fast, 200 or 422', async () => {
    const html = '<html><body>' + [1, 2, 3].map((n) => `<article><a href="/u/ann">Ann</a><p>post ${n} ${'words '.repeat(20)}</p>`
      + (n === 1 ? '<article><p>b</p><title>T&lt;/title&gt;' + '&lt;div&gt;'.repeat(99_000) + '</title></article>' : '') + '</article>').join('')
      + '</body></html>';
    const t0 = performance.now();
    try {
      const r = await extractHtml(html, { recipes: [], fetch: async () => { throw new Error('no network'); } });
      assert.equal(typeof r.markdown, 'string');
    } catch (err) {
      assert.equal(err.code, 'document_too_complex');
    }
    assert.ok(performance.now() - t0 < 5000, `took ${performance.now() - t0} ms`);
  });
});
