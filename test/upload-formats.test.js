import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { extractMsg, isMsgFile } from '../lib/msg.js';
import { extractMhtml, isMhtmlFile } from '../lib/mhtml.js';
import { extractPlainText, plainTextKind } from '../lib/plaintext.js';
import { extractSubtitles, isSubtitleFile, parseCues, cuesToParagraphs } from '../lib/subtitles.js';
import { extractEml } from '../lib/eml.js';
import { decodeTextFile } from '../lib/text-decode.js';
import { extractFile } from '../lib/web.js';
import { createApp } from '../server.js';

const fixture = (name) => readFileSync(new URL(`./fixtures/msg/${name}`, import.meta.url));
const LONG = 'Dies ist ein ausreichend langer Absatz mit echtem Inhalt, damit die Extraktion etwas findet. '.repeat(6);

async function post(path, body, filename, contentType = 'application/octet-stream') {
  const app = createApp({});
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      fetch(`http://localhost:${server.address().port}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': contentType, 'X-Filename': encodeURIComponent(filename) },
        body,
      }).then(async (res) => { const text = await res.text(); server.close(); resolve({ status: res.status, headers: Object.fromEntries(res.headers), body: text }); })
        .catch((e) => { server.close(); reject(e); });
    });
  });
}

// ---------------------------------------------------------------- .msg

describe('Outlook .msg', () => {
  it('detects by extension and Outlook content types', () => {
    assert.equal(isMsgFile('application/octet-stream', 'Mail.MSG'), true);
    assert.equal(isMsgFile('application/vnd.ms-outlook', ''), true);
    assert.equal(isMsgFile('application/pdf', 'a.pdf'), false);
  });

  it('renders the plain-text body with To/Cc/Bcc', async () => {
    const r = await extractMsg(fixture('to-cc-bcc.msg'), { lang: 'en' });
    assert.equal(r.source, 'email');
    assert.ok(r.markdown.startsWith('# Subject\n\n'));
    assert.match(r.markdown, /\*\*To:\*\* ToUser <to@example\.com>/);
    assert.match(r.markdown, /\*\*Cc:\*\* ToCc <cc@example\.com>/);
    assert.match(r.markdown, /\*\*Bcc:\*\* ToBcc <bcc@example\.com>/);
    assert.match(r.markdown, /\*\*Date:\*\* /);
  });

  it('uses the HTML body (decoded by its charset) when there is no plain-text body', async () => {
    const r = await extractMsg(fixture('html-body.msg'), { lang: 'de' });
    assert.ok(r.markdown.startsWith('# Microsoft Outlook テスト メッセージ\n'));
    assert.match(r.markdown, /\*\*Von:\*\* Microsoft Outlook <ku@digitaldolphins\.jp>/);
    assert.ok(r.markdown.includes('この電子メール メッセージは'));
    assert.ok(!r.markdown.includes('<meta'));
    assert.equal(r.metadata.publishedTime, '2025-09-26T01:43:11.000Z');
  });

  it('lists real attachments and skips hidden inline images', async () => {
    const r = await extractMsg(fixture('attach-and-inline.msg'), { lang: 'de' });
    assert.match(r.markdown, /Anhänge \(nicht umgewandelt\): attach\.png\n/);
    assert.ok(!r.markdown.includes('image001.png'));
    const r2 = await extractMsg(fixture('attachmentFiles.msg'), { lang: 'en' });
    assert.match(r2.markdown, /Attachments \(not converted\): jpg\.jpg, png\.png, tif\.tif/);
  });

  it('rejects bytes that are not a compound file', async () => {
    await assert.rejects(() => extractMsg(Buffer.from('From: x\r\n\r\nhello'.repeat(50))), (e) => e.status === 422);
  });
});

// ---------------------------------------------------------------- short HTML-only mail

describe('short HTML-only e-mail', () => {
  it('keeps the text instead of returning an empty body', async () => {
    const raw = Buffer.from([
      'From: a@example.com', 'To: b@example.com', 'Subject: Kurz', 'MIME-Version: 1.0',
      'Content-Type: text/html; charset=utf-8', '',
      '<html><body><p>Bis <b>Montag</b>!</p></body></html>',
    ].join('\r\n'));
    const r = await extractEml(raw, {});
    assert.match(r.markdown, /Bis \*\*Montag\*\*!/);
  });
});

// ---------------------------------------------------------------- .mhtml

function mhtml({ url = 'https://example.com/artikel', body = `<article><h1>Ein Artikel</h1><p>${LONG}</p></article>` } = {}) {
  const b = '----MultipartBoundary--abc123----';
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Ein Artikel</title></head><body>${body}</body></html>`;
  const qp = html.replace(/=/g, '=3D');
  return Buffer.from([
    'From: <Saved by Blink>',
    ...(url ? [`Snapshot-Content-Location: ${url}`] : []),
    'Subject: Ein Artikel',
    'Date: Tue, 3 Nov 2026 16:00:00 +0100',
    'MIME-Version: 1.0',
    'Content-Type: multipart/related;',
    '\ttype="text/html";',
    `\tboundary="${b}"`,
    '',
    '',
    `--${b}`,
    'Content-Type: text/html',
    'Content-ID: <frame-1@mhtml.blink>',
    'Content-Transfer-Encoding: quoted-printable',
    ...(url ? [`Content-Location: ${url}`] : []),
    '',
    qp,
    '',
    `--${b}`,
    'Content-Type: image/png',
    'Content-Transfer-Encoding: base64',
    'Content-Location: https://example.com/bild.png',
    '',
    'iVBORw0KGgo=',
    '',
    `--${b}--`,
    '',
  ].join('\r\n'));
}

describe('MHTML', () => {
  it('detects .mhtml/.mht and multipart/related', () => {
    assert.equal(isMhtmlFile('', 'seite.mhtml'), true);
    assert.equal(isMhtmlFile('message/rfc822', 'seite.MHT'), true);
    assert.equal(isMhtmlFile('multipart/related', ''), true);
    assert.equal(isMhtmlFile('multipart/related', 'x.pdf'), false);
  });

  it('extracts the saved page and keeps the original URL', async () => {
    const r = await extractMhtml(mhtml(), { filename: 'seite.mhtml' });
    assert.ok(r.markdown.includes('Dies ist ein ausreichend langer Absatz'));
    assert.equal(r.metadata.sourceUrl, 'https://example.com/artikel');
    assert.ok(!r.markdown.includes('iVBORw0KGgo'));
  });

  it('passes the URL on to extractHtml (site recipes)', async () => {
    let got;
    await extractMhtml(mhtml(), {
      extractHtml: async (html, opts) => { got = opts; return { markdown: '# x\n\n' + LONG, metadata: { contentLength: 500 } }; },
    });
    assert.equal(got.url, 'https://example.com/artikel');
  });

  it('ignores non-http locations', async () => {
    let got;
    await extractMhtml(mhtml({ url: 'file:///C:/x.html' }), {
      extractHtml: async (html, opts) => { got = opts; return { markdown: LONG, metadata: { contentLength: 500 } }; },
    });
    assert.equal(got.url, undefined);
  });

  it('answers 422 for an app shell with almost no content', async () => {
    await assert.rejects(() => extractMhtml(mhtml({ body: '<div id="root"></div>' })), (e) => e.status === 422);
  });
});

// ---------------------------------------------------------------- .txt / .md

describe('plain text and Markdown', () => {
  it('detects by extension first, then content type', () => {
    assert.equal(plainTextKind('application/octet-stream', 'notiz.md'), 'markdown');
    assert.equal(plainTextKind('', 'liesmich.TXT'), 'text');
    assert.equal(plainTextKind('text/plain', ''), 'text');
    assert.equal(plainTextKind('text/plain', 'daten.csv'), null);
    assert.equal(plainTextKind('text/markdown', 'x'), 'markdown');
    assert.equal(plainTextKind('text/plain', 'server.log'), 'text');
    assert.equal(plainTextKind('application/octet-stream', 'server.log'), null);
  });

  it('titles a .txt by its file name', async () => {
    const r = await extractPlainText(Buffer.from('Zeile eins\nZeile zwei\n'), { filename: 'Einkauf Liste.txt', kind: 'text' });
    assert.equal(r.markdown, '# Einkauf Liste\n\nZeile eins\nZeile zwei\n');
    assert.equal(r.source, 'text');
  });

  it('keeps a Markdown file that already starts with a heading as it is', async () => {
    const r = await extractPlainText(Buffer.from('# Mein Titel\n\nText.\n'), { filename: 'a.md', kind: 'markdown' });
    assert.equal(r.markdown, '# Mein Titel\n\nText.\n');
    assert.equal(r.title, 'Mein Titel');
  });

  it('moves a note\'s own frontmatter into a yaml block and uses its title', async () => {
    const src = '---\ntitle: "Notiz"\ntags: [a, b]\n---\n\nErster Absatz.\n';
    const r = await extractPlainText(Buffer.from(src), { filename: 'n.md', kind: 'markdown' });
    assert.equal(r.title, 'Notiz');
    assert.ok(r.markdown.startsWith('# Notiz\n\n```yaml\ntitle: "Notiz"\ntags: [a, b]\n```\n\nErster Absatz.'));
    assert.ok(!/^---/m.test(r.markdown));
  });

  it('decodes Windows-1252 umlauts', () => {
    assert.equal(decodeTextFile(Buffer.from([0x47, 0x72, 0xfc, 0xdf, 0x65])), 'Grüße');
    assert.equal(decodeTextFile(Buffer.from('\ufeffGrüße', 'utf8')), 'Grüße');
  });

  it('rejects binary and empty files', async () => {
    await assert.rejects(() => extractPlainText(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00]), { kind: 'text' }), (e) => e.status === 422);
    await assert.rejects(() => extractPlainText(Buffer.from('  \n'), { kind: 'text' }), (e) => e.status === 422);
  });
});

// ---------------------------------------------------------------- .srt / .vtt

const SRT = `1
00:00:01,000 --> 00:00:03,000
<i>Hallo zusammen,</i>

2
00:00:03,200 --> 00:00:05,000
heute geht es um
Untertitel.

3
00:00:09,000 --> 00:00:11,000
{\\an8}Neuer Gedanke &amp; mehr.
`;

const VTT = `WEBVTT
Kind: captions
Language: de

NOTE automatisch erzeugt

00:00:00.000 --> 00:00:02.000 align:start position:0%
das ist<00:00:00.500><c> rollend</c>

00:00:02.000 --> 00:00:04.000 align:start position:0%
das ist rollend
und geht weiter

00:00:04.000 --> 00:00:06.000
<v Anna>und geht weiter
bis zum Ende
`;

describe('subtitles', () => {
  it('detects .srt/.vtt', () => {
    assert.equal(isSubtitleFile('', 'film.SRT'), true);
    assert.equal(isSubtitleFile('text/vtt', ''), true);
    assert.equal(isSubtitleFile('text/plain', 'film.txt'), false);
  });

  it('turns SRT into paragraphs split at pauses, without tags or numbers', async () => {
    const r = await extractSubtitles(Buffer.from(SRT), { filename: 'Vortrag.de.srt' });
    assert.equal(r.markdown, '# Vortrag.de\n\nHallo zusammen, heute geht es um Untertitel.\n\nNeuer Gedanke & mehr.\n');
    assert.equal(r.source, 'subtitles');
  });

  it('collapses rolling auto-caption repeats in VTT', () => {
    const paragraphs = cuesToParagraphs(parseCues(VTT));
    assert.deepEqual(paragraphs, ['das ist rollend und geht weiter bis zum Ende']);
  });

  it('handles CRLF and hour-less VTT timestamps', () => {
    const cues = parseCues('WEBVTT\r\n\r\n01:02.500 --> 01:04.000\r\nKurz\r\n');
    assert.equal(cues[0].start, 62.5);
  });

  it('answers 422 when there are no cues', async () => {
    await assert.rejects(() => extractSubtitles(Buffer.from('nur text'), {}), (e) => e.status === 422);
  });
});

// ---------------------------------------------------------------- routing

describe('extractFile routes local formats away from markitdown', () => {
  const never = async () => { throw new Error('markitdown must not be called'); };
  for (const [name, buf, source] of [
    ['a.msg', () => fixture('to-cc-bcc.msg'), 'email'],
    ['a.txt', () => Buffer.from('hallo'), 'text'],
    ['a.md', () => Buffer.from('# T\n\nx'), 'markdown'],
    ['a.vtt', () => Buffer.from(VTT), 'subtitles'],
  ]) {
    it(name, async () => {
      const r = await extractFile(buf(), { filename: name, contentType: 'application/octet-stream', markitdownClient: never });
      assert.equal(r.source, source);
    });
  }

  it('a.mhtml', async () => {
    const r = await extractFile(mhtml(), { filename: 'a.mhtml', contentType: 'message/rfc822', markitdownClient: never });
    assert.equal(r.metadata.sourceUrl, 'https://example.com/artikel');
  });
});

describe('POST /api/file with local formats', () => {
  it('serves a .srt with frontmatter', async () => {
    const res = await post('/api/file?frontmatter=true', Buffer.from(SRT), 'talk.srt');
    assert.equal(res.status, 200);
    assert.equal(res.headers['x-source'], 'subtitles');
    assert.match(res.body, /^---\ntitle: "?talk"?\n/);
    assert.match(res.body, /source: "?subtitles"?/);
  });

  it('serves an .mhtml with the original URL in the frontmatter', async () => {
    const res = await post('/api/file?frontmatter=true', mhtml(), 'seite.mhtml', 'multipart/related');
    assert.equal(res.status, 200);
    assert.match(res.body, /url: "?https:\/\/example\.com\/artikel"?/);
  });

  it('answers 422 for a broken .msg', async () => {
    const res = await post('/api/file', Buffer.from('nope'), 'kaputt.msg');
    assert.equal(res.status, 422);
  });
});
