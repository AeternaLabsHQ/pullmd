import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isEmlFile, extractEml } from '../lib/eml.js';
import { extractFile } from '../lib/web.js';

function mail({ subject = 'Hallo Welt', html, text, attachment, extraHeaders = '' } = {}) {
  const lines = [
    'From: =?UTF-8?Q?J=C3=BCrgen_M=C3=BCller?= <juergen@example.com>',
    'To: Andie <andie@example.com>, Bob <bob@example.com>',
    `Subject: ${subject}`,
    'Date: Tue, 03 Nov 2026 15:03:24 +0100',
    'MIME-Version: 1.0',
  ];
  if (extraHeaders) lines.push(extraHeaders);
  const parts = [];
  if (text !== undefined) parts.push(['text/plain; charset="utf-8"', text]);
  if (html !== undefined) parts.push(['text/html; charset="utf-8"', html]);
  const boundary = 'BOUNDARY42';
  if (!attachment && parts.length === 1) {
    lines.push(`Content-Type: ${parts[0][0]}`, 'Content-Transfer-Encoding: 8bit', '', parts[0][1]);
    return Buffer.from(lines.join('\r\n'));
  }
  lines.push(`Content-Type: multipart/mixed; boundary="${boundary}"`, '');
  for (const [ct, body] of parts) {
    lines.push(`--${boundary}`, `Content-Type: ${ct}`, 'Content-Transfer-Encoding: 8bit', '', body);
  }
  if (attachment) {
    lines.push(`--${boundary}`, 'Content-Type: application/pdf',
      `Content-Disposition: attachment; filename="${attachment}"`,
      'Content-Transfer-Encoding: base64', '', 'JVBERi0xLjQ=');
  }
  lines.push(`--${boundary}--`, '');
  return Buffer.from(lines.join('\r\n'));
}

const LONG = 'Dies ist ein ausreichend langer Absatz mit echtem Inhalt, damit die Extraktion etwas findet. '.repeat(6);

describe('extractEml - Cc and legacy source header', () => {
  it('lists Cc recipients', async () => {
    const r = await extractEml(mail({ text: LONG, extraHeaders: 'Cc: Carla <carla@example.com>' }), { lang: 'de' });
    assert.match(r.markdown, /\*\*Cc:\*\* Carla <carla@example\.com>/);
  });

  it('drops the legacy source line when PULLMD_SOURCE_HEADER is set', async () => {
    const html = `<html><body><article><h1>Hallo Welt</h1><p>${LONG}</p></article></body></html>`;
    process.env.PULLMD_SOURCE_HEADER = 'true';
    try {
      const r = await extractEml(mail({ html }), { filename: 'x.eml' });
      assert.ok(!r.markdown.includes('**x.eml**'));
    } finally {
      delete process.env.PULLMD_SOURCE_HEADER;
    }
  });
});

describe('isEmlFile', () => {
  it('matches .eml by name and message/rfc822 by type', () => {
    assert.equal(isEmlFile('application/octet-stream', 'Mail.EML'), true);
    assert.equal(isEmlFile('message/rfc822', 'x'), true);
    assert.equal(isEmlFile('application/pdf', 'a.pdf'), false);
    assert.equal(isEmlFile(undefined, undefined), false);
  });
});

describe('extractEml', () => {
  it('builds a header block with subject, sender, recipients and German date', async () => {
    const r = await extractEml(mail({ text: LONG }), { lang: 'de' });
    assert.equal(r.source, 'email');
    assert.ok(r.markdown.startsWith('# Hallo Welt\n\n'));
    assert.match(r.markdown, /\*\*Von:\*\* Jürgen Müller <juergen@example\.com>/);
    assert.match(r.markdown, /\*\*An:\*\* Andie <andie@example\.com>, Bob <bob@example\.com>/);
    assert.match(r.markdown, /\*\*Datum:\*\* 3\. November 2026/);
    assert.ok(r.markdown.includes('Dies ist ein ausreichend langer Absatz'));
    assert.equal(r.metadata.title, 'Hallo Welt');
    assert.equal(r.metadata.author, 'Jürgen Müller <juergen@example.com>');
    assert.equal(r.metadata.publishedTime, '2026-11-03T14:03:24.000Z');
  });

  it('uses English labels when lang=en', async () => {
    const r = await extractEml(mail({ text: LONG }), { lang: 'en' });
    assert.match(r.markdown, /\*\*From:\*\* /);
    assert.match(r.markdown, /\*\*To:\*\* /);
    assert.match(r.markdown, /\*\*Date:\*\* /);
  });

  it('prefers the HTML part and drops the duplicate H1 the HTML pipeline adds', async () => {
    const html = `<html><head><title>Hallo Welt</title></head><body><article><h1>Hallo Welt</h1><p>${LONG}</p><p><a href="https://example.com/x">Ein Link</a></p></article></body></html>`;
    const r = await extractEml(mail({ html, text: 'nur klartext' }), {});
    assert.ok(r.markdown.includes('[Ein Link](https://example.com/x)'));
    assert.ok(!r.markdown.includes('nur klartext'));
    assert.equal(r.markdown.match(/^# Hallo Welt$/gm).length, 1);
  });

  it('falls back to the plain-text part when the HTML yields almost nothing', async () => {
    const html = '<html><body><img src="https://t.example/p.gif" width="1" height="1"></body></html>';
    const r = await extractEml(mail({ html, text: LONG }), {});
    assert.ok(r.markdown.includes('Dies ist ein ausreichend langer Absatz'));
  });

  it('lists attachment names without converting them', async () => {
    const r = await extractEml(mail({ text: LONG, attachment: 'rechnung.pdf' }), { lang: 'de' });
    assert.match(r.markdown, /Anhänge \(nicht umgewandelt\): rechnung\.pdf/);
    assert.ok(!r.markdown.includes('JVBERi0'));
  });

  it('copes with a mail that has no subject and no body', async () => {
    const raw = Buffer.from('From: a@example.com\r\nTo: b@example.com\r\n\r\n');
    const r = await extractEml(raw, { lang: 'en', filename: 'leer.eml' });
    assert.ok(r.markdown.startsWith('# (no subject)\n'));
  });

  it('rejects a file that is not a mail at all', async () => {
    await assert.rejects(() => extractEml(Buffer.from('%PDF-1.4 garbage'), {}), /e-?mail/i);
  });
});

describe('extractFile routes .eml away from markitdown', () => {
  it('never calls the markitdown client for an .eml', async () => {
    let called = false;
    const r = await extractFile(mail({ text: LONG }), {
      filename: 'x.eml', contentType: 'application/octet-stream',
      markitdownClient: async () => { called = true; return { markdown: '' }; },
    });
    assert.equal(called, false);
    assert.equal(r.source, 'email');
  });
});

describe('POST /api/file with an .eml (real extractFile, no sidecar)', () => {
  async function post(path, body, filename) {
    const { createApp } = await import('../server.js');
    const app = createApp({});
    return new Promise((resolve, reject) => {
      const server = app.listen(0, () => {
        fetch(`http://localhost:${server.address().port}${path}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/octet-stream', 'X-Filename': encodeURIComponent(filename) },
          body,
        }).then(async (res) => { const text = await res.text(); server.close(); resolve({ status: res.status, headers: Object.fromEntries(res.headers), body: text }); })
          .catch((e) => { server.close(); reject(e); });
      });
    });
  }

  it('converts the mail and puts subject/author/date into the frontmatter', async () => {
    const res = await post('/api/file?frontmatter=true&lang=en', mail({ text: LONG }), 'hallo.eml');
    assert.equal(res.status, 200);
    assert.equal(res.headers['x-source'], 'email');
    assert.equal(res.headers['x-share-id'], undefined);
    assert.match(res.body, /^---\n/);
    assert.match(res.body, /title: "?Hallo Welt"?/);
    assert.match(res.body, /source: "?email"?/);
    assert.match(res.body, /published: "?2026-11-03T14:03:24\.000Z"?/);
    assert.match(res.body, /\*\*From:\*\* /);
  });

  it('answers 422 for an .eml that is not a mail', async () => {
    const res = await post('/api/file', Buffer.from('just some bytes'), 'kaputt.eml');
    assert.equal(res.status, 422);
    assert.match(JSON.parse(res.body).error, /e-mail/i);
  });
});
