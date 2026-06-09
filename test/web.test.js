import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { extractWeb, extractFile, extractHtml } from '../lib/web.js';
import { matchRecipesAgainst } from '../lib/recipes.js';

// Single-fetch: extractWeb makes exactly ONE request per call.
// The Accept header includes text/markdown preference.
function mockFetch(response) {
  let callCount = 0;
  const fn = async (url, opts) => {
    callCount++;
    if (typeof response === 'function') return response(url, opts);
    return response;
  };
  fn.callCount = () => callCount;
  return fn;
}

describe('extractWeb - Cloudflare markdown', () => {
  it('returns Cloudflare markdown when server responds with text/markdown', async () => {
    const fetcher = mockFetch({
      ok: true,
      headers: { get: (h) => h === 'content-type' ? 'text/markdown; charset=utf-8' : null },
      text: async () => '# Hello World\n\nSome content here.',
    });

    const result = await extractWeb('https://example.com/article', { fetch: fetcher });
    assert.ok(result.markdown.includes('# Hello World'));
    assert.equal(result.source, 'cloudflare');
    assert.ok(result.title);
    assert.equal(fetcher.callCount(), 1, 'should make exactly one fetch');
  });
});

describe('extractWeb - Readability fallback', () => {
  it('falls back to Readability when response is HTML', async () => {
    const html = `
      <html><head><title>Test Article</title></head>
      <body>
        <nav>Menu</nav>
        <article><h1>Test Article</h1><p>Main content paragraph that needs to be long enough for the Readability extraction to consider it substantial content worth keeping. This paragraph contains enough text to exceed the minimum threshold for content extraction, ensuring that the Readability algorithm identifies it as the main article body.</p></article>
        <footer>Footer stuff</footer>
      </body></html>
    `;

    const fetcher = mockFetch({
      ok: true,
      headers: { get: (h) => h === 'content-type' ? 'text/html; charset=utf-8' : null },
      text: async () => html,
    });

    const result = await extractWeb('https://example.com/article', { fetch: fetcher });
    assert.ok(result.markdown.includes('Main content paragraph'));
    assert.equal(result.source, 'readability');
    assert.equal(result.title, 'Test Article');
    assert.equal(fetcher.callCount(), 1, 'should make exactly one fetch');
  });

  it('cleans nav but keeps comments when comments=true', async () => {
    const html = `
      <html><head><title>Page</title></head>
      <body>
        <nav>Navigation</nav>
        <article><p>Content</p></article>
        <div class="comments"><p>A comment</p></div>
        <footer>Footer</footer>
      </body></html>
    `;

    const fetcher = mockFetch({
      ok: true,
      headers: { get: () => 'text/html; charset=utf-8' },
      text: async () => html,
    });

    const result = await extractWeb('https://example.com/page', { comments: true, fetch: fetcher });
    assert.ok(!result.markdown.includes('Navigation'), 'nav should be removed');
    assert.ok(result.markdown.includes('A comment'), 'comments should be kept');
    assert.equal(fetcher.callCount(), 1, 'should make exactly one fetch');
  });

  it('does not send Accept: text/markdown when comments=true', async () => {
    const fetcher = mockFetch((url, opts) => {
      assert.ok(!opts?.headers?.Accept?.includes('text/markdown'),
        'should not request markdown when comments=true');
      return {
        ok: true,
        headers: { get: () => 'text/html; charset=utf-8' },
        text: async () => '<html><head><title>T</title></head><body><p>Hi</p></body></html>',
      };
    });

    await extractWeb('https://example.com/page', { comments: true, fetch: fetcher });
  });
});

describe('extractWeb - charset detection (#8)', () => {
  // Body padded with enough Latin-1 prose so Readability picks the article
  // up as substantial content (>200 chars). The relevant words (für, Rätsel,
  // über) appear in the headline.
  const ger = (charset) => `<!DOCTYPE html><html lang="de"><head><meta charset="${charset}"><title>Test</title></head><body><article><h1>Forscher finden den wahren Grund für das Aussterben der Neandertaler</h1><p>Das Aussterben der Neandertaler gibt der Wissenschaft seit Langem Rätsel auf. Neue Forschungen liefern überraschende Einsichten über das Überleben in Europa und zeigen, dass die Population stärker betroffen war als bisher angenommen. Die Studie liefert Hinweise auf entscheidende Faktoren für den Niedergang.</p></article></body></html>`;

  function bytesResponse(buffer, contentType) {
    return {
      ok: true,
      status: 200,
      headers: { get: (h) => (h.toLowerCase() === 'content-type' ? contentType : null) },
      arrayBuffer: async () => buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
      // .text() intentionally returns mojibake to prove the fix uses arrayBuffer
      text: async () => buffer.toString('utf-8'),
    };
  }

  it('decodes ISO-8859-1 pages without charset header (winfuture.de case)', async () => {
    const html = ger('iso-8859-1');
    const buf = Buffer.from(html, 'latin1'); // raw Latin-1 bytes
    const result = await extractWeb('https://example.com/de', {
      fetch: async () => bytesResponse(buf, 'text/html'),
    });
    assert.ok(result.markdown.includes('für'), 'für must survive (was f�r before fix)');
    assert.ok(result.markdown.includes('Rätsel'), 'Rätsel must survive (was R�tsel before fix)');
    assert.ok(result.markdown.includes('über'), 'über must survive (was �ber before fix)');
    assert.ok(!result.markdown.includes('�'), 'no replacement char in output');
  });

  it('decodes Windows-1252 pages with smart quotes and em-dash', async () => {
    // 0x93 = „"" curly opening, 0x94 = "" curly closing, 0x97 = — em-dash
    const html = `<!DOCTYPE html><html><head><meta http-equiv="Content-Type" content="text/html; charset=windows-1252"><title>T</title></head><body><article><h1>Headline</h1><p>This is a test \x93smart quote\x94 \x97 with em-dash. It has enough body text to clear the Readability minimum threshold so the extractor commits to this content rather than falling back to the raw page body. Curly punctuation is the canonical Windows-1252 tell.</p></article></body></html>`;
    const buf = Buffer.from(html, 'latin1');
    const result = await extractWeb('https://example.com/win1252', {
      fetch: async () => bytesResponse(buf, 'text/html'),
    });
    assert.ok(result.markdown.includes('“smart quote”'), 'curly quotes must decode correctly');
    assert.ok(result.markdown.includes('—'), 'em-dash must decode correctly');
    assert.ok(!result.markdown.includes('�'), 'no replacement char in output');
  });

  it('respects charset= in Content-Type header over <meta>', async () => {
    // Document declares utf-8 in <meta> but server says iso-8859-1 — header wins.
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>T</title></head><body><article><h1>Café Pâtisserie Belgique</h1><p>Header-declared charset must take precedence over the in-document meta tag. This paragraph exists to give Readability enough body weight that it commits to the article instead of falling back to the raw page.</p></article></body></html>`;
    const buf = Buffer.from(html, 'latin1');
    const result = await extractWeb('https://example.com/fr', {
      fetch: async () => bytesResponse(buf, 'text/html; charset=iso-8859-1'),
    });
    assert.ok(result.markdown.includes('Café'), 'header charset wins → Café decoded as Latin-1');
    assert.ok(result.markdown.includes('Pâtisserie'));
  });

  it('keeps UTF-8 pages working (regression guard)', async () => {
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>T</title></head><body><article><h1>Über schöne Wörter</h1><p>Standardfall: UTF-8 Bytes mit deutschen Umlauten, weiterhin korrekt dekodiert wie zuvor. Der Absatz ist lang genug, damit Readability ihn als Hauptinhalt erkennt und nicht auf die Roh-HTML-Variante zurückfällt — Standard-Pfad bleibt unangetastet.</p></article></body></html>`;
    const buf = Buffer.from(html, 'utf-8');
    const result = await extractWeb('https://example.com/utf8', {
      fetch: async () => bytesResponse(buf, 'text/html'),
    });
    assert.ok(result.markdown.includes('Über'));
    assert.ok(result.markdown.includes('schöne'));
    assert.ok(result.markdown.includes('Wörter'));
    assert.ok(!result.markdown.includes('�'));
  });

  it('honors UTF-8 BOM when no header or meta is present', async () => {
    const html = `<!DOCTYPE html><html><head><title>T</title></head><body><article><h1>München Wörter</h1><p>Kein expliziter Charset, weder im Header noch im Meta-Tag — die UTF-8-BOM am Anfang muss greifen. Der Absatz ist lang genug für Readability, damit der Extractor diesen Text als Hauptinhalt nimmt und nicht auf die Roh-HTML-Variante zurückfällt.</p></article></body></html>`;
    const buf = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(html, 'utf-8')]);
    const result = await extractWeb('https://example.com/bom', {
      fetch: async () => bytesResponse(buf, 'text/html'),
    });
    assert.ok(result.markdown.includes('München'));
    assert.ok(!result.markdown.includes('�'));
  });
});

describe('extractWeb - extractor override (#17)', () => {
  const baseHtml = `
    <html><head><title>Article</title></head>
    <body><article>
      <h1>Article</h1>
      <p>Body paragraph one with enough text for Readability to commit to this content. The article needs at least 200 chars in the readability output, so the prose has to be a bit longer than usual.</p>
      <p>Body paragraph two providing additional substance so the static extractor finds plenty of weight in this candidate node and chooses it.</p>
    </article></body></html>
  `;
  const fetcher = () => ({
    ok: true,
    headers: { get: () => 'text/html; charset=utf-8' },
    text: async () => baseHtml,
  });

  // The Trafilatura URL is captured at module load — re-import per test.
  async function importWithTrafi(url) {
    process.env.TRAFILATURA_URL = url;
    return import(`../lib/web.js?ext=${Date.now()}-${Math.random()}`);
  }

  it('extractor=readability skips Trafilatura entirely', async () => {
    const prev = process.env.TRAFILATURA_URL;
    try {
      const { extractWeb: ew } = await importWithTrafi('http://trafilatura-test/extract');
      let trafiCalls = 0;
      const fakeFetch = async (url) => {
        if (typeof url === 'string' && url.includes('trafilatura-test')) trafiCalls++;
        return { ok: true, headers: { get: () => 'text/html; charset=utf-8' }, text: async () => baseHtml };
      };
      const result = await ew('https://example.com/x', { fetch: fakeFetch, extractor: 'readability' });
      assert.equal(result.source, 'readability');
      assert.equal(trafiCalls, 0, 'Trafilatura sidecar must not be called');
      assert.match(result.metadata.extractorReason, /forced via extractor=readability/);
    } finally {
      if (prev === undefined) delete process.env.TRAFILATURA_URL;
      else process.env.TRAFILATURA_URL = prev;
    }
  });

  it('extractor=trafilatura uses the sidecar output and skips pickBest', async () => {
    const prev = process.env.TRAFILATURA_URL;
    try {
      const { extractWeb: ew } = await importWithTrafi('http://trafilatura-test/extract');
      const trafiOut = '# Article\n\n' + 'Trafilatura body paragraph with substantial text. '.repeat(20);
      const fakeFetch = async (url) => {
        if (typeof url === 'string' && url.includes('/extract')) {
          return { ok: true, headers: { get: () => 'text/plain' }, text: async () => trafiOut };
        }
        return { ok: true, headers: { get: () => 'text/html; charset=utf-8' }, text: async () => baseHtml };
      };
      const result = await ew('https://example.com/x', { fetch: fakeFetch, extractor: 'trafilatura' });
      assert.equal(result.source, 'trafilatura');
      assert.ok(result.markdown.includes('Trafilatura body paragraph'), 'Trafilatura output must be the chosen one');
      assert.match(result.metadata.extractorReason, /forced via extractor=trafilatura/);
    } finally {
      if (prev === undefined) delete process.env.TRAFILATURA_URL;
      else process.env.TRAFILATURA_URL = prev;
    }
  });

  it('extractor=trafilatura falls back to pickBest with a warning when sidecar is unreachable', async () => {
    const prev = process.env.TRAFILATURA_URL;
    try {
      const { extractWeb: ew } = await importWithTrafi('http://trafilatura-test/extract');
      const fakeFetch = async (url) => {
        if (typeof url === 'string' && url.includes('/extract')) {
          return { ok: false, status: 503, headers: { get: () => null }, text: async () => '' };
        }
        return { ok: true, headers: { get: () => 'text/html; charset=utf-8' }, text: async () => baseHtml };
      };
      const result = await ew('https://example.com/x', { fetch: fakeFetch, extractor: 'trafilatura' });
      assert.match(result.source, /^readability/);
      assert.match(result.metadata.extractorReason, /unavailable, fell back/);
    } finally {
      if (prev === undefined) delete process.env.TRAFILATURA_URL;
      else process.env.TRAFILATURA_URL = prev;
    }
  });

  it('extractor=playwright forces a render even when the static result looks fine', async () => {
    let renderCalls = 0;
    const renderClient = async () => {
      renderCalls++;
      return baseHtml;
    };
    const result = await extractWeb('https://example.com/x', {
      fetch: fetcher,
      extractor: 'playwright',
      renderClient,
    });
    assert.equal(renderCalls, 1, 'render client must be invoked exactly once');
    assert.equal(result.source, 'playwright');
    assert.match(result.metadata.extractorReason, /forced via extractor=playwright/);
  });

  it('no extractor override → existing pickBest behavior preserved', async () => {
    const result = await extractWeb('https://example.com/x', { fetch: fetcher });
    assert.match(result.source, /^readability/);
    assert.ok(result.metadata.extractorReason && !/forced via extractor/.test(result.metadata.extractorReason));
  });
});

describe('extractWeb - preprocessing (#17)', () => {
  it('recovers paywall + aria-hidden paragraphs that Readability would normally drop', async () => {
    const html = `
      <html><head><title>T</title></head>
      <body><article>
        <h1>Headline</h1>
        <p>Visible body paragraph one with enough text for Readability to commit to this candidate as the article body, so the page passes the substantial-content threshold cleanly.</p>
        <p class="paywall" aria-hidden="true">"Whatever you say" — the quote that carries the article and would otherwise vanish via the aria-hidden silent drop.</p>
        <p>Visible body paragraph three rounding out the article with another bit of prose that gets the candidate clearly above the minimum length floor.</p>
      </article></body></html>
    `;
    const fetcher = () => ({
      ok: true,
      headers: { get: () => 'text/html; charset=utf-8' },
      text: async () => html,
    });
    const result = await extractWeb('https://example.com/de', { fetch: fetcher });
    assert.ok(result.markdown.includes('"Whatever you say"'), 'paywall paragraph must be in the output');
  });
});

describe('extractWeb - error handling', () => {
  it('throws when page cannot be fetched', async () => {
    const fetcher = mockFetch({
      ok: false, status: 404,
      headers: { get: () => null },
      text: async () => '',
    });

    await assert.rejects(
      () => extractWeb('https://example.com/missing', { fetch: fetcher }),
      { message: /failed.*404/i }
    );
  });
});

describe('extractWeb - output format', () => {
  it('includes title and domain in header', async () => {
    const prev = process.env.PULLMD_SOURCE_HEADER; process.env.PULLMD_SOURCE_HEADER = 'true';
    const html = `
      <html><head>
        <title>Great Article</title>
        <meta property="article:published_time" content="2026-03-15T10:00:00Z">
      </head>
      <body><article><p>Content here</p></article></body></html>
    `;

    const fetcher = mockFetch({
      ok: true,
      headers: { get: () => 'text/html; charset=utf-8' },
      text: async () => html,
    });

    const result = await extractWeb('https://example.com/article', { fetch: fetcher });
    assert.ok(result.markdown.includes('# Great Article'));
    assert.ok(result.markdown.includes('example.com'));
    if (prev === undefined) delete process.env.PULLMD_SOURCE_HEADER; else process.env.PULLMD_SOURCE_HEADER = prev;
  });
});

describe('extractWeb - Readability fallback for thin content (P1.3)', () => {
  it('uses readability-fallback source when Readability returns too little', async () => {
    // Page with content only in a generic div — Readability often returns <200 chars
    const html = `
      <html><head><title>Sparse Page</title></head>
      <body>
        <div>
          <p>This is the actual content of the page that should be extracted.</p>
          <p>Second paragraph with more content for the extraction pipeline.</p>
          <p>Third paragraph to ensure enough content in the fallback result.</p>
        </div>
      </body></html>
    `;
    const fetcher = mockFetch({
      ok: true,
      status: 200,
      headers: { get: (h) => h === 'content-type' ? 'text/html; charset=utf-8' : null },
      text: async () => html,
    });

    const result = await extractWeb('https://example.com/sparse', { fetch: fetcher });
    assert.ok(result.markdown.includes('actual content'), 'should include page content');
    assert.ok(result.source === 'readability' || result.source === 'readability-fallback',
      'source should be readability or readability-fallback');
  });
});

describe('extractWeb - metadata', () => {
  it('returns metadata object with HTML extraction', async () => {
    const html = `
      <html lang="de">
      <head>
        <title>Metadata Test</title>
        <meta name="description" content="A description">
        <meta name="author" content="Author Name">
        <meta property="og:title" content="OG Test">
      </head>
      <body><article><p>Content paragraph here.</p></article></body>
      </html>
    `;
    const fetcher = mockFetch({
      ok: true,
      status: 200,
      headers: { get: (h) => h === 'content-type' ? 'text/html; charset=utf-8' : null },
      text: async () => html,
    });

    const result = await extractWeb('https://example.com/article', { fetch: fetcher });
    assert.ok(result.metadata, 'should have metadata object');
    assert.equal(result.metadata.title, 'Metadata Test');
    assert.equal(result.metadata.description, 'A description');
    assert.equal(result.metadata.author, 'Author Name');
    assert.equal(result.metadata.ogTitle, 'OG Test');
    assert.equal(result.metadata.language, 'de');
    assert.equal(result.metadata.sourceUrl, 'https://example.com/article');
    assert.equal(result.metadata.statusCode, 200);
  });

  it('returns metadata with Cloudflare markdown path', async () => {
    const fetcher = mockFetch({
      ok: true,
      status: 200,
      headers: { get: (h) => {
        if (h === 'content-type') return 'text/markdown; charset=utf-8';
        return null;
      }},
      text: async () => '# Cloud Title\n\nContent here for testing.',
    });

    const result = await extractWeb('https://example.com/page', { fetch: fetcher });
    assert.ok(result.metadata, 'should have metadata object');
    assert.equal(result.metadata.title, 'Cloud Title');
    assert.equal(result.metadata.sourceUrl, 'https://example.com/page');
  });
});

describe('extractWeb orchestrator with playwright fallback', () => {
  let originalPlaywrightUrl;
  beforeEach(() => { originalPlaywrightUrl = process.env.PLAYWRIGHT_URL; });
  afterEach(()  => {
    if (originalPlaywrightUrl === undefined) delete process.env.PLAYWRIGHT_URL;
    else process.env.PLAYWRIGHT_URL = originalPlaywrightUrl;
  });

  // Helper: a minimal HTML payload that yields a low-quality static extraction
  // (no <article>, mostly headings, no paragraph content) — triggers renderDecision
  // predicate (iii) low-quality (<0.5).
  function soupHtml() {
    const heads = Array.from({ length: 20 }, (_, i) => `<h2>H${i}</h2>`).join('');
    return `<!doctype html><html><body>${heads}<p>tiny</p></body></html>`;
  }
  function cleanHtml() {
    const paras = Array.from({ length: 10 }, () =>
      '<p>This is a body paragraph that is comfortably long enough for the metrics regex to match it as a real paragraph.</p>'
    ).join('');
    return `<!doctype html><html><body><article><h1>A real article</h1>${paras}</article></body></html>`;
  }
  function fetchWith(body, ct = 'text/html; charset=utf-8') {
    return async () => {
      const headers = { get: (k) => k.toLowerCase() === 'content-type' ? ct : null };
      return { ok: true, status: 200, headers, text: async () => body };
    };
  }

  it('does not call sidecar on a clean article', async () => {
    let sidecarCalls = 0;
    process.env.PLAYWRIGHT_URL = 'http://playwright:8002/render';
    const result = await extractWeb('https://example.com', {
      fetch: fetchWith(cleanHtml()),
      renderClient: async () => { sidecarCalls++; return cleanHtml(); },
    });
    assert.equal(sidecarCalls, 0);
    assert.notEqual(result.source, 'playwright');
  });

  it('calls sidecar and switches source to playwright when static result is low-quality', async () => {
    process.env.PLAYWRIGHT_URL = 'http://playwright:8002/render';
    let sidecarCalls = 0;
    const result = await extractWeb('https://example.com', {
      fetch: fetchWith(soupHtml()),
      renderClient: async () => { sidecarCalls++; return cleanHtml(); },
    });
    assert.equal(sidecarCalls, 1);
    assert.equal(result.source, 'playwright');
    assert.match(result.metadata.extractorReason, /rendered via playwright/);
  });

  it('falls back to original (degraded) when sidecar throws', async () => {
    process.env.PLAYWRIGHT_URL = 'http://playwright:8002/render';
    const result = await extractWeb('https://example.com', {
      fetch: fetchWith(soupHtml()),
      renderClient: async () => { throw new Error('sidecar down'); },
    });
    assert.notEqual(result.source, 'playwright');
    assert.match(result.metadata.extractorReason, /playwright fallback failed/);
  });

  it('honors render=force on a clean page', async () => {
    process.env.PLAYWRIGHT_URL = 'http://playwright:8002/render';
    let sidecarCalls = 0;
    const result = await extractWeb('https://example.com', {
      fetch: fetchWith(cleanHtml()),
      renderClient: async () => { sidecarCalls++; return cleanHtml(); },
      render: 'force',
    });
    assert.equal(sidecarCalls, 1);
    assert.equal(result.source, 'playwright');
  });

  it('honors render=skip on a low-quality page', async () => {
    process.env.PLAYWRIGHT_URL = 'http://playwright:8002/render';
    let sidecarCalls = 0;
    const result = await extractWeb('https://example.com', {
      fetch: fetchWith(soupHtml()),
      renderClient: async () => { sidecarCalls++; return cleanHtml(); },
      render: 'skip',
    });
    assert.equal(sidecarCalls, 0);
    assert.notEqual(result.source, 'playwright');
  });

  it('emits stage events in order on render path', async () => {
    process.env.PLAYWRIGHT_URL = 'http://playwright:8002/render';
    const events = [];
    await extractWeb('https://example.com', {
      fetch: fetchWith(soupHtml()),
      renderClient: async () => cleanHtml(),
      emit: (stage, data) => events.push({ stage, ...data }),
    });
    const stages = events.map(e => e.stage);
    assert.deepEqual(stages, ['fetching', 'extracting', 'rendering', 'extracting']);
  });

  it('emits only fetching+extracting on no-render path', async () => {
    const events = [];
    await extractWeb('https://example.com', {
      fetch: fetchWith(cleanHtml()),
      emit: (stage, data) => events.push({ stage, ...data }),
    });
    assert.deepEqual(events.map(e => e.stage), ['fetching', 'extracting']);
  });
});

describe('cleanDom CMS-pattern preprocessing', () => {
  function fetchHtml(html) {
    return async () => {
      const headers = { get: (k) => k.toLowerCase() === 'content-type' ? 'text/html' : null };
      return { ok: true, status: 200, headers, text: async () => html };
    };
  }

  it('surfaces readonly <input> value as <code> in markdown', async () => {
    const html = `<!doctype html><html><body><article><h1>API Model</h1>
      ${Array.from({ length: 8 }, () => '<p>This is a paragraph that is comfortably long enough to count as a real paragraph for the metrics regex used in scoring and pickBest decisions.</p>').join('')}
      <p>Copy this slug:</p>
      <input type="text" readonly value="mistral-large-latest">
    </article></body></html>`;
    const result = await extractWeb('https://example.com/api', { fetch: fetchHtml(html) });
    assert.match(result.markdown, /`mistral-large-latest`/);
    assert.doesNotMatch(result.markdown, /<input/);
  });

  it('does not transform editable (non-readonly) inputs', async () => {
    const html = `<!doctype html><html><body><article><h1>Form Demo</h1>
      ${Array.from({ length: 8 }, () => '<p>This is a paragraph that is comfortably long enough to count as a real paragraph for the metrics regex used in scoring and pickBest decisions.</p>').join('')}
      <input type="text" value="user@example.com">
    </article></body></html>`;
    const result = await extractWeb('https://example.com/form', { fetch: fetchHtml(html) });
    assert.doesNotMatch(result.markdown, /`user@example\.com`/);
  });

  it('drops UUID alt-text on images, preserves the link', async () => {
    const html = `<!doctype html><html><body><article><h1>Models</h1>
      ${Array.from({ length: 8 }, () => '<p>This is a paragraph that is comfortably long enough to count as a real paragraph for the metrics regex used in scoring and pickBest decisions.</p>').join('')}
      <img alt="9201fe9b-6130-4cfd-8f50-ee8a757ce553" src="https://cms.example.com/asset/9201fe9b-6130-4cfd-8f50-ee8a757ce553">
    </article></body></html>`;
    const result = await extractWeb('https://example.com/models', { fetch: fetchHtml(html) });
    assert.doesNotMatch(result.markdown, /9201fe9b-6130-4cfd-8f50-ee8a757ce553\]/);
    // Image link itself is still present (the URL contains the UUID; that's fine — only the alt was the noise).
    assert.match(result.markdown, /cms\.example\.com\/asset\/9201fe9b-6130-4cfd-8f50-ee8a757ce553/);
  });

  it('preserves descriptive alt-text on images', async () => {
    const html = `<!doctype html><html><body><article><h1>Photos</h1>
      ${Array.from({ length: 8 }, () => '<p>This is a paragraph that is comfortably long enough to count as a real paragraph for the metrics regex used in scoring and pickBest decisions.</p>').join('')}
      <img alt="A red sunset over mountains" src="https://example.com/photo.jpg">
    </article></body></html>`;
    const result = await extractWeb('https://example.com/photos', { fetch: fetchHtml(html) });
    assert.match(result.markdown, /A red sunset over mountains/);
  });
});

describe('extractWeb — recipe integration (Hook 0+1)', () => {
  // HTML substantial enough that renderDecision returns no on its own
  // (sufficient length, multiple paragraphs, no fallback). Ensures the recipe
  // render=force flag is the SOLE reason renderClient gets invoked.
  const substantialHtml = `<html><head><title>Substantial Article</title></head><body><article><h1>Substantial Article</h1>${'<p>This is a long paragraph with meaningful content and enough words to clear the eighty-character substantial threshold easily, so multiple of these will produce strong static extraction.</p>'.repeat(20)}</article></body></html>`;

  it('uses recipe.fetch.render when no query render param', async () => {
    const recipes = [{ name: 'r', host: 'example.com', path: '/**', preprocess: [], select: { remove: [] }, fetch: { render: 'force' } }];
    let renderCalled = false;
    const fetcher = mockFetch({
      ok: true,
      headers: { get: (h) => h === 'content-type' ? 'text/html' : null },
      text: async () => substantialHtml,
      arrayBuffer: async () => new TextEncoder().encode(substantialHtml).buffer,
      status: 200,
    });
    const renderClient = async (url, opts) => {
      renderCalled = true;
      return substantialHtml;
    };
    await extractWeb('https://example.com/', { fetch: fetcher, renderClient, recipes });
    assert.equal(renderCalled, true, 'recipe render=force should trigger renderClient');
  });

  it('query render=skip wins over recipe render=force', async () => {
    const recipes = [{ name: 'r', host: 'example.com', path: '/**', preprocess: [], select: { remove: [] }, fetch: { render: 'force' } }];
    let renderCalled = false;
    const fetcher = mockFetch({
      ok: true,
      headers: { get: (h) => h === 'content-type' ? 'text/html' : null },
      text: async () => '<html><body><article><p>x</p></article></body></html>',
      arrayBuffer: async () => new TextEncoder().encode('<html><body><article><p>x</p></article></body></html>').buffer,
      status: 200,
    });
    const renderClient = async () => { renderCalled = true; return ''; };
    await extractWeb('https://example.com/', { fetch: fetcher, renderClient, recipes, render: 'skip' });
    assert.equal(renderCalled, false);
  });
});

describe('extractWeb — recipe integration (Hook 2 preprocess + select)', () => {
  it('applies recipe preprocess actions before extraction', async () => {
    const recipes = [{
      name: 'r', host: 'example.com', path: '/**',
      preprocess: [{ action: 'remove-element', selector: 'div.ads-noise' }],
      select: { remove: [] }, fetch: {},
    }];
    const html = '<html><head><title>T</title></head><body><article>' +
      '<div class="ads-noise">PREPROCESS-SHOULD-REMOVE-ME</div>' +
      '<p>A substantial paragraph with enough body text to clear extraction-quality thresholds, ' +
      'this is filler content for the test, more filler content for the test, and even more.</p>' +
      '</article></body></html>';
    const fetcher = mockFetch({
      ok: true,
      headers: { get: (h) => h === 'content-type' ? 'text/html' : null },
      text: async () => html,
      arrayBuffer: async () => new TextEncoder().encode(html).buffer,
      status: 200,
    });
    const result = await extractWeb('https://example.com/', { fetch: fetcher, recipes });
    assert.ok(result.markdown.includes('substantial paragraph'), 'body paragraph survives');
    assert.equal(result.markdown.includes('PREPROCESS-SHOULD-REMOVE-ME'), false,
      'recipe preprocess remove-element must strip the noise div');
  });

  it('extends cleanDom REMOVE_SELECTORS via recipe select.remove', async () => {
    const recipes = [{
      name: 'r', host: 'example.com', path: '/**',
      preprocess: [], select: { remove: ['div.recipe-only-strip'] }, fetch: {},
    }];
    const html = '<html><head><title>T</title></head><body><article>' +
      '<div class="recipe-only-strip">SELECT-SHOULD-NOT-APPEAR</div>' +
      '<p>A substantial paragraph with enough body text to clear extraction-quality thresholds for the article container.</p>' +
      '</article></body></html>';
    const fetcher = mockFetch({
      ok: true,
      headers: { get: (h) => h === 'content-type' ? 'text/html' : null },
      text: async () => html,
      arrayBuffer: async () => new TextEncoder().encode(html).buffer,
      status: 200,
    });
    const result = await extractWeb('https://example.com/', { fetch: fetcher, recipes });
    assert.equal(result.markdown.includes('SELECT-SHOULD-NOT-APPEAR'), false,
      'recipe select.remove must strip the targeted div');
  });
});

describe('extractWeb — Hook 3 (playwright fetch options)', () => {
  it('passes recipe.fetch.wait_for and mobile_ua to renderClient', async () => {
    const recipes = [{
      name: 'r', host: 'example.com', path: '/**',
      preprocess: [], select: { remove: [] },
      fetch: { render: 'force', wait_for: '.gate', wait_timeout_ms: 3000, mobile_ua: true },
    }];
    let renderOpts;
    const fetcher = mockFetch({
      ok: true,
      headers: { get: (h) => h === 'content-type' ? 'text/html' : null },
      text: async () => '<html><body><article><p>x</p></article></body></html>',
      arrayBuffer: async () => new TextEncoder().encode('<html><body><article><p>x</p></article></body></html>').buffer,
      status: 200,
    });
    const renderClient = async (url, opts) => {
      renderOpts = opts;
      return '<html><body><article><h1>R</h1><p>rendered substantial body content paragraph for testing pipeline.</p></article></body></html>';
    };
    await extractWeb('https://example.com/', { fetch: fetcher, renderClient, recipes });
    assert.equal(renderOpts.waitFor, '.gate');
    assert.equal(renderOpts.waitTimeoutMs, 3000);
    assert.equal(renderOpts.mobileUa, true);
  });

  it('passes a User-Agent string to renderClient (from the rotation pool)', async () => {
    const recipes = [{
      name: 'r', host: 'example.com', path: '/**',
      preprocess: [], select: { remove: [] },
      fetch: { render: 'force' },  // force render to exercise the renderClient path
    }];
    let renderOpts;
    const fetcher = mockFetch({
      ok: true,
      headers: { get: (h) => h === 'content-type' ? 'text/html' : null },
      text: async () => '<html><body><article><p>x</p></article></body></html>',
      arrayBuffer: async () => new TextEncoder().encode('<html><body><article><p>x</p></article></body></html>').buffer,
      status: 200,
    });
    const renderClient = async (url, opts) => {
      renderOpts = opts;
      return '<html><body><article><h1>R</h1><p>rendered substantial body content paragraph for testing pipeline.</p></article></body></html>';
    };
    await extractWeb('https://example.com/', { fetch: fetcher, renderClient, recipes });
    assert.ok(typeof renderOpts.userAgent === 'string', 'userAgent should be a string');
    assert.match(renderOpts.userAgent, /Mozilla\//, 'userAgent should look like a real UA string');
  });
});

describe('extractWeb - markitdown document routing', () => {
  function pdfFetch(bytes = Buffer.from('%PDF-1.4 fake')) {
    return async () => ({
      ok: true,
      status: 200,
      headers: { get: (h) => (h.toLowerCase() === 'content-type' ? 'application/pdf' : null) },
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    });
  }

  it('routes application/pdf to the markitdown client and tags source=markitdown', async () => {
    const prev = process.env.PULLMD_SOURCE_HEADER; process.env.PULLMD_SOURCE_HEADER = 'true';
    let received;
    const markitdownClient = async (buf, o) => { received = { len: buf.length, ...o }; return { markdown: 'PDF body text here, long enough.', title: 'My PDF' }; };
    const result = await extractWeb('https://example.com/doc.pdf?token=abc', { fetch: pdfFetch(), markitdownClient });
    assert.equal(result.source, 'markitdown');
    assert.ok(result.markdown.includes('# My PDF'));
    assert.ok(result.markdown.includes('PDF body text here'));
    assert.ok(result.markdown.includes('example.com'));
    assert.equal(received.contentType, 'application/pdf');
    assert.equal(received.filename, 'doc.pdf');
    if (prev === undefined) delete process.env.PULLMD_SOURCE_HEADER; else process.env.PULLMD_SOURCE_HEADER = prev;
  });

  it('routes by URL extension when content-type is octet-stream', async () => {
    const octetFetch = async () => ({
      ok: true, status: 200,
      headers: { get: (h) => (h.toLowerCase() === 'content-type' ? 'application/octet-stream' : null) },
      arrayBuffer: async () => Buffer.from('DOCX').buffer,
    });
    let called = false;
    const markitdownClient = async () => { called = true; return { markdown: 'docx text content', title: 'D' }; };
    const result = await extractWeb('https://example.com/report.docx', { fetch: octetFetch, markitdownClient });
    assert.equal(called, true);
    assert.equal(result.source, 'markitdown');
  });

  it('throws when markitdown is the target but the sidecar is unavailable', async () => {
    await assert.rejects(
      () => extractWeb('https://example.com/doc.pdf', { fetch: pdfFetch(), markitdownClient: async () => null }),
      /markitdown/i,
    );
  });

  it('does NOT route text/html to markitdown', async () => {
    const htmlFetch = async () => ({
      ok: true, status: 200,
      headers: { get: (h) => (h.toLowerCase() === 'content-type' ? 'text/html; charset=utf-8' : null) },
      arrayBuffer: async () => Buffer.from('<html><head><title>T</title></head><body><article><p>Plenty of real article body text that is well over the two hundred character minimum so Readability keeps it as the main content of the page for sure.</p></article></body></html>').buffer,
    });
    let called = false;
    const result = await extractWeb('https://example.com/page', { fetch: htmlFetch, markitdownClient: async () => { called = true; return { markdown: 'x', title: 'x' }; } });
    assert.equal(called, false);
    assert.notEqual(result.source, 'markitdown');
  });
});

describe('extractFile - local document upload', () => {
  it('converts bytes via markitdown and shows the filename in the header', async () => {
    const prev = process.env.PULLMD_SOURCE_HEADER; process.env.PULLMD_SOURCE_HEADER = 'true';
    const result = await extractFile(Buffer.from('PDFBYTES'), {
      filename: 'report.pdf',
      contentType: 'application/pdf',
      markitdownClient: async (buf, o) => { assert.equal(o.contentType, 'application/pdf'); return { markdown: 'Converted body text.', title: 'Report' }; },
    });
    assert.equal(result.source, 'markitdown');
    assert.ok(result.markdown.includes('# Report'));
    assert.ok(result.markdown.includes('**report.pdf**'));
    assert.ok(!result.markdown.includes('http'));   // no source URL for local files
    assert.equal(result.metadata.sourceUrl, null);
    assert.ok(result.metadata.contentLength > 0);
    if (prev === undefined) delete process.env.PULLMD_SOURCE_HEADER; else process.env.PULLMD_SOURCE_HEADER = prev;
  });

  it('throws when the sidecar is unavailable', async () => {
    await assert.rejects(
      () => extractFile(Buffer.from('x'), { filename: 'a.pdf', markitdownClient: async () => null }),
      /markitdown/i,
    );
  });

  it('returns empty markdown and falls back to the filename when the sidecar yields only whitespace', async () => {
    const result = await extractFile(Buffer.from('x'), {
      filename: 'empty.pdf',
      markitdownClient: async () => ({ markdown: '   \n  ', title: null }),
    });
    assert.equal(result.metadata.contentLength, 0);
    assert.equal(result.title, 'empty.pdf');
  });

  it('falls back to markitdown when the vision provider throws on an uploaded image', async () => {
    let called = false;
    const result = await extractFile(Buffer.from('JPEGBYTES'), {
      filename: 'photo.jpg',
      contentType: 'image/jpeg',
      captionFn: async () => { throw new Error('boom'); },
      markitdownClient: async () => { called = true; return { markdown: 'exif only', title: 'photo' }; },
    });
    assert.equal(called, true, 'markitdown must be the fallback when captionFn throws');
    assert.equal(result.source, 'markitdown');
  });
});

describe('extractWeb - media routing via Node LLM layer', () => {
  function imgFetch() {
    return async () => ({
      ok: true, status: 200,
      headers: { get: (h) => (h.toLowerCase() === 'content-type' ? 'image/jpeg' : null) },
      arrayBuffer: async () => Buffer.from('JPEGBYTES').buffer,
    });
  }

  it('falls through to normal extraction when no vision provider is configured (captionFn returns null)', async () => {
    let called = false;
    const result = await extractWeb('https://example.com/photo.jpg', {
      fetch: imgFetch(),
      captionFn: async () => null,
      markitdownClient: async () => { called = true; return { markdown: 'x', title: 'x' }; },
    });
    assert.equal(called, false, 'markitdown must not be called for an image when captionFn returns null');
    assert.notEqual(result.source, 'markitdown');
  });

  it('routes images to the vision adapter (source=image-caption) when captionFn is set', async () => {
    const result = await extractWeb('https://example.com/photo.jpg', {
      fetch: imgFetch(),
      captionFn: async () => ({ markdown: 'A caption of the photo.', usage: null }),
    });
    assert.equal(result.source, 'image-caption');
    assert.ok(result.markdown.includes('A caption of the photo.'));
  });

  it('falls through to normal extraction when the vision provider throws (no 502)', async () => {
    const result = await extractWeb('https://example.com/photo.jpg', {
      fetch: imgFetch(),
      captionFn: async () => { throw new Error('rate limited (429)'); },
    });
    assert.notEqual(result.source, 'image-caption');
    assert.ok(result.source, 'extraction must resolve to some source, not reject');
  });
});

describe('extractWeb - YouTube routing', () => {
  function ytFetch() {
    return async () => ({
      ok: true, status: 200,
      headers: { get: (h) => (h.toLowerCase() === 'content-type' ? 'text/html; charset=utf-8' : null) },
      arrayBuffer: async () => Buffer.from('<html><head><title>Vid - YouTube</title></head><body>p</body></html>').buffer,
    });
  }

  it('routes youtu.be with normalized sourceUrl + format opts when enabled', async () => {
    const prev = process.env.MARKITDOWN_YOUTUBE; process.env.MARKITDOWN_YOUTUBE = 'true';
    let received;
    const result = await extractWeb('https://youtu.be/abc123', {
      fetch: ytFetch(), ytTimecodes: 'plain', ytChunk: 0,
      youtubeClient: async (html, o) => { received = o; return { markdown: '## Transcript\n\nhello', title: 'My Video', fields: { channel: 'Chan', duration: '12:34', views: '1000' } }; },
    });
    assert.equal(result.source, 'youtube');
    assert.equal(received.sourceUrl, 'https://www.youtube.com/watch?v=abc123');
    assert.equal(received.timecodes, 'plain');
    assert.equal(received.chunk, 0);
    assert.equal(result.source, 'youtube');
    assert.equal(received.sourceUrl, 'https://www.youtube.com/watch?v=abc123');
    assert.ok(result.markdown.includes('# My Video'));
    assert.ok(!result.markdown.includes('**Channel:**'), 'meta line must not be in the body');
    assert.equal(result.metadata.author, 'Chan');
    assert.equal(result.metadata.ytDuration, '12:34');
    assert.equal(result.metadata.ytViews, '1000');
    if (prev === undefined) delete process.env.MARKITDOWN_YOUTUBE; else process.env.MARKITDOWN_YOUTUBE = prev;
  });

  it('falls back to the HTML pipeline when the youtube sidecar is down', async () => {
    const prev = process.env.MARKITDOWN_YOUTUBE; process.env.MARKITDOWN_YOUTUBE = 'true';
    const result = await extractWeb('https://www.youtube.com/watch?v=abc123', { fetch: ytFetch(), youtubeClient: async () => null });
    assert.notEqual(result.source, 'youtube');
    if (prev === undefined) delete process.env.MARKITDOWN_YOUTUBE; else process.env.MARKITDOWN_YOUTUBE = prev;
  });

  it('does NOT route YouTube when disabled', async () => {
    const prev = process.env.MARKITDOWN_YOUTUBE; delete process.env.MARKITDOWN_YOUTUBE;
    let called = false;
    const result = await extractWeb('https://www.youtube.com/watch?v=abc123', { fetch: ytFetch(), youtubeClient: async () => { called = true; return { markdown: 'x', title: 'x' }; } });
    assert.equal(called, false);
    assert.notEqual(result.source, 'youtube');
    if (prev !== undefined) process.env.MARKITDOWN_YOUTUBE = prev;
  });
});

describe('extractWeb - LLM usage metadata', () => {
  function imgFetch() {
    return async () => ({
      ok: true, status: 200,
      headers: { get: (h) => (h.toLowerCase() === 'content-type' ? 'image/jpeg' : null) },
      arrayBuffer: async () => Buffer.from('JPEGBYTES').buffer,
    });
  }
  it('maps vision adapter usage/imageSize into metadata (source=image-caption)', async () => {
    const result = await extractWeb('https://example.com/p.jpg', {
      fetch: imgFetch(),
      captionFn: async () => ({ markdown: '## Description\n\na caption', usage: { model: 'gpt-4o-mini', total_tokens: 123 }, imageSize: '172x178' }),
    });
    assert.equal(result.source, 'image-caption');
    assert.equal(result.metadata.llmModel, 'gpt-4o-mini');
    assert.equal(result.metadata.llmTokens, 123);
    assert.equal(result.metadata.imageSize, '172x178');
  });
});

describe('formatHeader - clean body (default) vs legacy', () => {
  it('default body is just the H1 title (no domain/date/url line)', async () => {
    const prev = process.env.PULLMD_SOURCE_HEADER; delete process.env.PULLMD_SOURCE_HEADER;
    const html = '<html><head><title>T</title></head><body><article><p>Plenty of real article body text well over the two hundred character minimum so Readability keeps it as the main content of this page for certain, yes indeed it does.</p></article></body></html>';
    const r = await extractHtml(html, { url: 'https://example.com/x' });
    assert.ok(r.markdown.startsWith('# T'));
    assert.ok(!r.markdown.includes('example.com'), 'no domain line in clean body');
    assert.ok(!r.markdown.includes('https://example.com/x'), 'no url line in clean body');
    if (prev === undefined) delete process.env.PULLMD_SOURCE_HEADER; else process.env.PULLMD_SOURCE_HEADER = prev;
  });

  it('PULLMD_SOURCE_HEADER=true restores the legacy domain/url header', async () => {
    const prev = process.env.PULLMD_SOURCE_HEADER; process.env.PULLMD_SOURCE_HEADER = 'true';
    const html = '<html><head><title>T</title></head><body><article><p>Plenty of real article body text well over the two hundred character minimum so Readability keeps it as the main content of this page for certain, yes indeed it does.</p></article></body></html>';
    const r = await extractHtml(html, { url: 'https://example.com/x' });
    assert.ok(r.markdown.includes('example.com'));
    assert.ok(r.markdown.includes('https://example.com/x'));
    if (prev === undefined) delete process.env.PULLMD_SOURCE_HEADER; else process.env.PULLMD_SOURCE_HEADER = prev;
  });
});

describe('media routing → Node LLM layer', () => {
  const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000002000154a24f3f0000000049454e44ae426082', 'hex');

  it('extractFile routes an image to the vision adapter (source=image-caption)', async () => {
    const r = await extractFile(PNG, {
      filename: 'pic.png', contentType: 'image/png',
      captionFn: async () => ({ markdown: '## Description\n\nA cat.', usage: { model: 'gpt-4o-mini', total_tokens: 50 }, imageSize: '1x1' }),
      transcribeFn: async () => { throw new Error('should not transcribe'); },
      markitdownClient: async () => { throw new Error('should not call markitdown'); },
    });
    assert.equal(r.source, 'image-caption');
    assert.ok(r.markdown.startsWith('# '));
    assert.ok(r.markdown.includes('A cat.'));
    assert.equal(r.metadata.imageSize, '1x1');
    assert.equal(r.metadata.llmModel, 'gpt-4o-mini');
  });

  it('extractFile routes audio to the STT adapter (source=audio-transcript)', async () => {
    const r = await extractFile(Buffer.from('AUDIO'), {
      filename: 'clip.mp3', contentType: 'audio/mpeg',
      transcribeFn: async () => ({ markdown: '### Audio Transcript\n\nHi.', usage: { model: 'whisper-1' }, audioSeconds: 4.2 }),
      captionFn: async () => { throw new Error('no'); },
      markitdownClient: async () => { throw new Error('no'); },
    });
    assert.equal(r.source, 'audio-transcript');
    assert.ok(r.markdown.includes('Hi.'));
    assert.equal(r.metadata.audioSeconds, 4.2);
  });

  it('extractFile falls through to markitdown when the image adapter is unconfigured (returns null)', async () => {
    const r = await extractFile(PNG, {
      filename: 'pic.png', contentType: 'image/png',
      captionFn: async () => null,
      markitdownClient: async () => ({ markdown: 'EXIF only', title: 'pic' }),
    });
    assert.equal(r.source, 'markitdown');
    assert.ok(r.markdown.includes('EXIF only'));
  });

  it('extractFile still routes a PDF to markitdown (source=markitdown)', async () => {
    const r = await extractFile(Buffer.from('%PDF-1.4'), {
      filename: 'doc.pdf', contentType: 'application/pdf',
      captionFn: async () => { throw new Error('no'); },
      markitdownClient: async () => ({ markdown: 'Doc body', title: 'Doc' }),
    });
    assert.equal(r.source, 'markitdown');
  });
});

describe('extractWeb - media null-fallthrough single body read (regression)', () => {
  it('image URL with no provider falls through to normal extraction without double-reading the body', async () => {
    const sv = process.env.PULLMD_VISION_API_KEY; delete process.env.PULLMD_VISION_API_KEY;
    const html = '<html><head><title>Img Page</title></head><body><article><p>'
      + 'Plenty of real article text well over the two hundred character minimum so Readability keeps this as the main content of the page, yes indeed it certainly does for sure.'
      + '</p></article></body></html>';
    let reads = 0;
    const bytes = Buffer.from(html);
    const onceFetch = async () => ({
      ok: true, status: 200,
      headers: { get: (h) => (h.toLowerCase() === 'content-type' ? 'image/png' : null) },
      arrayBuffer: async () => {
        if (reads++ > 0) throw new TypeError('body used already');
        return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      },
    });
    // image content-type, captionFn returns null (no provider) → must fall through, not crash
    const r = await extractWeb('https://example.com/pic.png', { fetch: onceFetch, captionFn: async () => null });
    assert.ok(r.markdown.startsWith('# '));
    if (sv === undefined) delete process.env.PULLMD_VISION_API_KEY; else process.env.PULLMD_VISION_API_KEY = sv;
  });

  it('audio URL with no provider falls through to normal extraction without double-reading the body', async () => {
    const sv = process.env.PULLMD_STT_API_KEY; delete process.env.PULLMD_STT_API_KEY;
    const html = '<html><head><title>Audio Page</title></head><body><article><p>'
      + 'Plenty of real article text well over the two hundred character minimum so Readability keeps this as the main content of the page, yes indeed it certainly does for sure.'
      + '</p></article></body></html>';
    let reads = 0;
    const bytes = Buffer.from(html);
    const onceFetch = async () => ({
      ok: true, status: 200,
      headers: { get: (h) => (h.toLowerCase() === 'content-type' ? 'audio/mpeg' : null) },
      arrayBuffer: async () => { if (reads++ > 0) throw new TypeError('body used already'); return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength); },
    });
    // audio content-type, transcribeFn returns null (no provider) → must fall through, not crash
    const r = await extractWeb('https://example.com/clip.mp3', { fetch: onceFetch, transcribeFn: async () => null });
    assert.ok(r.markdown.startsWith('# '));
    if (sv === undefined) delete process.env.PULLMD_STT_API_KEY; else process.env.PULLMD_STT_API_KEY = sv;
  });
});

describe('PDF-OCR routing (opt-in)', () => {
  const PDF = Buffer.from('%PDF-1.4 fake');
  const pdfFetch = (bytes = PDF) => async () => ({
    ok: true, status: 200,
    headers: { get: (h) => (h.toLowerCase() === 'content-type' ? 'application/pdf' : null) },
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  });

  it('extractFile routes a PDF to OCR when pdfOcr + provider (source=pdf-ocr)', async () => {
    const r = await extractFile(PDF, {
      filename: 'doc.pdf', contentType: 'application/pdf', pdfOcr: true,
      ocrFn: async () => ({ markdown: '# Doc\n\n| a | b |', usage: { model: 'mistral-ocr-latest' }, pdfPages: 3 }),
      markitdownClient: async () => { throw new Error('should not call markitdown'); },
    });
    assert.equal(r.source, 'pdf-ocr');
    assert.ok(r.markdown.includes('| a | b |'));
    assert.equal(r.metadata.pdfPages, 3);
    assert.equal(r.metadata.llmModel, 'mistral-ocr-latest');
  });

  it('extractFile PDF falls back to markitdown when pdfOcr off', async () => {
    const r = await extractFile(PDF, {
      filename: 'doc.pdf', contentType: 'application/pdf',
      ocrFn: async () => { throw new Error('should not OCR'); },
      markitdownClient: async () => ({ markdown: 'plain doc', title: 'Doc' }),
    });
    assert.equal(r.source, 'markitdown');
  });

  it('extractFile PDF falls back to markitdown when OCR returns null (unconfigured)', async () => {
    const r = await extractFile(PDF, {
      filename: 'doc.pdf', contentType: 'application/pdf', pdfOcr: true,
      ocrFn: async () => null,
      markitdownClient: async () => ({ markdown: 'plain doc', title: 'Doc' }),
    });
    assert.equal(r.source, 'markitdown');
  });

  it('extractFile PDF falls back to markitdown when OCR throws', async () => {
    const r = await extractFile(PDF, {
      filename: 'doc.pdf', contentType: 'application/pdf', pdfOcr: true,
      ocrFn: async () => { throw new Error('ocr 429'); },
      markitdownClient: async () => ({ markdown: 'plain doc', title: 'Doc' }),
    });
    assert.equal(r.source, 'markitdown');
  });

  it('extractWeb routes a PDF URL to OCR when pdfOcr + provider (source=pdf-ocr)', async () => {
    const r = await extractWeb('https://example.com/doc.pdf', {
      fetch: pdfFetch(), pdfOcr: true,
      ocrFn: async () => ({ markdown: '# Web Doc\n\ntable', usage: { model: 'mistral-ocr-latest' }, pdfPages: 1 }),
    });
    assert.equal(r.source, 'pdf-ocr');
    assert.ok(r.markdown.includes('table'));
  });

  it('extractWeb PDF default via recipe fetch.pdf=ocr (no query opt-in)', async () => {
    const recipes = [{ name: 'r', host: 'example.com', path: '/**', preprocess: [], select: { remove: [] }, fetch: { pdf: 'ocr' } }];
    const r = await extractWeb('https://example.com/doc.pdf', {
      fetch: pdfFetch(), recipes,
      ocrFn: async () => ({ markdown: 'recipe ocr', usage: { model: 'mistral-ocr-latest' }, pdfPages: 1 }),
    });
    assert.equal(r.source, 'pdf-ocr');
  });

  it('extractWeb routes a PDF URL with a query string + octet-stream content-type to OCR', async () => {
    const bytes = Buffer.from('%PDF-1.4 fake');
    const octetPdfFetch = async () => ({
      ok: true, status: 200,
      headers: { get: (h) => (h.toLowerCase() === 'content-type' ? 'application/octet-stream' : null) },
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    });
    const r = await extractWeb('https://example.com/report.pdf?download=1', {
      fetch: octetPdfFetch, pdfOcr: true,
      ocrFn: async () => ({ markdown: 'ocr body', usage: { model: 'mistral-ocr-latest' }, pdfPages: 1 }),
    });
    assert.equal(r.source, 'pdf-ocr');
  });
});
