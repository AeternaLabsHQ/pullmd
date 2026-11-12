import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { extractMhtml, isMhtmlFile } from '../lib/mhtml.js';

// The happy path (inline root part, Snapshot-Content-Location, app-shell 422)
// lives in upload-formats.test.js. This file covers the fallbacks.

const LONG = 'Dies ist ein ausreichend langer Absatz mit echtem Inhalt, damit die Extraktion etwas findet. '.repeat(4);
const PAGE = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Ein Artikel</title></head><body><article><h1>Ein Artikel</h1><p>${LONG}</p></article></body></html>`;
const B = '----MultipartBoundary--xyz789----';

/**
 * @param {object} o
 * @param {string[]} [o.headers]      extra top-level header lines
 * @param {string[]} [o.partHeaders]  extra header lines of the HTML part
 * @param {string|null} [o.html]      null leaves the HTML part out
 */
function archive({ headers = [], partHeaders = [], html = PAGE } = {}) {
  return Buffer.from([
    'From: <Saved by Blink>',
    ...headers,
    'Subject: Ein Artikel',
    'MIME-Version: 1.0',
    'Content-Type: multipart/related;',
    '\ttype="text/html";',
    `\tboundary="${B}"`,
    '',
    '',
    ...(html === null ? [] : [
      `--${B}`,
      'Content-Type: text/html; charset=utf-8',
      'Content-Transfer-Encoding: quoted-printable',
      ...partHeaders,
      '',
      html.replace(/=/g, '=3D'),
      '',
    ]),
    `--${B}`,
    'Content-Type: image/png',
    'Content-Transfer-Encoding: base64',
    'Content-Location: https://example.com/bild.png',
    '',
    'iVBORw0KGgo=',
    '',
    `--${B}--`,
    '',
  ].join('\r\n'));
}

// Records what extractMhtml hands to the HTML extractor.
function spy(result = { markdown: '# x\n\n' + LONG, metadata: { contentLength: 500 } }) {
  const calls = [];
  const extractHtml = async (html, opts) => { calls.push({ html, opts }); return result; };
  return { calls, extractHtml };
}

describe('extractMhtml - root part marked as attachment', () => {
  const asAttachment = () => archive({
    headers: ['Snapshot-Content-Location: https://example.com/artikel'],
    partHeaders: ['Content-Disposition: attachment; filename="seite.html"'],
  });

  it('reads the HTML from the attachment', async () => {
    const { calls, extractHtml } = spy();
    await extractMhtml(asAttachment(), { extractHtml, filename: 'seite.mhtml', extractor: 'readability' });
    assert.equal(calls.length, 1);
    assert.ok(calls[0].html.includes('<h1>Ein Artikel</h1>'), 'the decoded page must reach the extractor');
    assert.ok(calls[0].html.includes('charset="utf-8"'), 'quoted-printable must be decoded');
    assert.deepEqual(calls[0].opts, {
      url: 'https://example.com/artikel', filename: 'seite.mhtml', extractor: 'readability',
    });
  });

  it('extracts it with the real pipeline', async () => {
    const r = await extractMhtml(asAttachment(), { filename: 'seite.mhtml' });
    assert.ok(r.markdown.includes('Dies ist ein ausreichend langer Absatz'));
    assert.equal(r.metadata.sourceUrl, 'https://example.com/artikel');
  });
});

describe('extractMhtml - no HTML page', () => {
  const notMhtml = (e) => {
    assert.equal(e.status, 422);
    assert.equal(e.code, 'not_mhtml');
    assert.match(e.message, /No HTML page found/);
    return true;
  };

  it('rejects an archive without any HTML part', async () => {
    const { calls, extractHtml } = spy();
    await assert.rejects(() => extractMhtml(archive({ html: null }), { extractHtml }), notMhtml);
    assert.equal(calls.length, 0);
  });

  it('rejects an HTML part that is only whitespace', async () => {
    const { extractHtml } = spy();
    await assert.rejects(() => extractMhtml(archive({ html: '  \r\n ' }), { extractHtml }), notMhtml);
  });

  it('rejects a file that is not MIME at all', async () => {
    const { extractHtml } = spy();
    await assert.rejects(() => extractMhtml(Buffer.from('just some bytes'), { extractHtml }), notMhtml);
  });
});

describe('extractMhtml - source URL headers', () => {
  async function urlFor(headers) {
    const { calls, extractHtml } = spy();
    const r = await extractMhtml(archive({ headers }), { extractHtml });
    return { url: calls[0].opts.url, sourceUrl: r.metadata.sourceUrl };
  }

  it('falls back to the top-level Content-Location', async () => {
    const r = await urlFor(['Content-Location: http://example.org/alt']);
    assert.equal(r.url, 'http://example.org/alt');
    assert.equal(r.sourceUrl, 'http://example.org/alt');
  });

  it('prefers Snapshot-Content-Location over Content-Location', async () => {
    const r = await urlFor([
      'Content-Location: https://example.org/zweite',
      'Snapshot-Content-Location: https://example.com/erste',
    ]);
    assert.equal(r.url, 'https://example.com/erste');
  });

  it('skips a non-http snapshot location and uses Content-Location', async () => {
    const r = await urlFor([
      'Snapshot-Content-Location: chrome-extension://abcdef/page.html',
      'Content-Location: https://example.org/zweite',
    ]);
    assert.equal(r.url, 'https://example.org/zweite');
  });

  for (const value of ['file:///C:/x.html', 'javascript:alert(1)', 'ftp://example.com/x', 'not a url', 'example.com/artikel']) {
    it(`ignores "${value}"`, async () => {
      const r = await urlFor([`Snapshot-Content-Location: ${value}`, `Content-Location: ${value}`]);
      assert.equal(r.url, undefined);
      assert.equal(r.sourceUrl, undefined, 'no source URL may be invented');
    });
  }

  it('does not read the Content-Location of the HTML part', async () => {
    const { calls, extractHtml } = spy();
    await extractMhtml(archive({ partHeaders: ['Content-Location: https://example.com/teil'] }), { extractHtml });
    assert.equal(calls[0].opts.url, undefined);
  });

  it('keeps a sourceUrl the extractor already set', async () => {
    const { extractHtml } = spy({ markdown: LONG, metadata: { contentLength: 500, sourceUrl: 'https://canonical.example/x' } });
    const r = await extractMhtml(archive({ headers: ['Snapshot-Content-Location: https://example.com/artikel'] }), { extractHtml });
    assert.equal(r.metadata.sourceUrl, 'https://canonical.example/x');
  });
});

describe('extractMhtml - content floor', () => {
  const tooLittle = (e) => e.status === 422 && e.code === 'too_little_content';

  it('rejects a result below 200 characters with its own code', async () => {
    const { extractHtml } = spy({ markdown: 'kurz', metadata: { contentLength: 199 } });
    await assert.rejects(() => extractMhtml(archive(), { extractHtml }), tooLittle);
  });

  it('accepts exactly 200 characters', async () => {
    const { extractHtml } = spy({ markdown: 'x', metadata: { contentLength: 200 } });
    const r = await extractMhtml(archive(), { extractHtml });
    assert.equal(r.markdown, 'x');
  });

  it('treats missing metadata as no content', async () => {
    const { extractHtml } = spy({ markdown: LONG });
    await assert.rejects(() => extractMhtml(archive(), { extractHtml }), tooLittle);
  });
});

describe('isMhtmlFile', () => {
  it('accepts the Safari/legacy content type when there is no file extension', () => {
    assert.equal(isMhtmlFile('application/x-mimearchive', ''), true);
    assert.equal(isMhtmlFile('Multipart/Related; boundary="x"', 'seite'), true);
    assert.equal(isMhtmlFile('application/x-mimearchive', undefined), true);
  });

  it('lets a foreign file extension win over the content type', () => {
    assert.equal(isMhtmlFile('application/x-mimearchive', 'bericht.docx'), false);
  });

  it('does not treat a dot in a directory name as an extension', () => {
    assert.equal(isMhtmlFile('multipart/related', 'ordner.v2/seite'), true);
  });

  it('rejects other content types and empty input', () => {
    assert.equal(isMhtmlFile('multipart/mixed', ''), false);
    assert.equal(isMhtmlFile('text/html', ''), false);
    assert.equal(isMhtmlFile('', ''), false);
    assert.equal(isMhtmlFile(undefined, undefined), false);
    assert.equal(isMhtmlFile('', 'seite.mhtmlx'), false);
  });
});
