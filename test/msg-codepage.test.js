// Outlook .msg files whose strings are not Unicode: PT_STRING8 (0x001E)
// properties in the code page of PR_MESSAGE_CODEPAGE (0x3FFD), the HTML body
// (PR_HTML, binary) in PR_INTERNET_CPID (0x3FDE), compressed-RTF bodies with
// \ansicpg. The .msg files are built in memory by test/helpers/msg-builder.js
// (no binary fixtures); the bytes come from Node's TextDecoder tables, not from
// the iconv-lite msgreader decodes with. Everything runs through extractFile,
// the entry point of the upload route.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { extractFile } from '../lib/web.js';
import {
  buildMsg, compressRtfLiteral, encodeCodepage, long, str8, str16, bin, PID,
} from './helpers/msg-builder.js';

/** Markdown of an uploaded .msg: { title, headers: string[], body }. */
async function convert(buffer, lang = 'en') {
  const r = await extractFile(buffer, { filename: 'mail.msg', contentType: 'application/octet-stream', lang });
  const md = r.markdown;
  const nl = md.indexOf('\n\n');
  const title = md.slice(0, nl);
  assert.ok(title.startsWith('# '), `title line: ${title}`);
  let rest = md.slice(nl + 2);
  let headers = [];
  if (rest.startsWith('**')) {
    const cut = rest.indexOf('\n\n---\n\n');
    headers = rest.slice(0, cut).split('\n').map((h) => h.replace(/ +$/, ''));
    rest = rest.slice(cut + 7);
  }
  return { title: title.slice(2), headers, body: rest, markdown: md };
}

const enc = encodeCodepage;

/** A plain-text message with PT_STRING8 strings in `label`. */
function textMessage(label, cp, { subject, from, address = 'sender@example.com', to, toAddress = 'to@example.com', body }, extra = []) {
  return buildMsg({
    props: [
      long(PID.messageCodepage, cp),
      str8(PID.subject, enc(subject, label)),
      str8(PID.senderName, enc(from, label)),
      str8(PID.senderSmtp, enc(address, label)),
      ...(body === undefined ? [] : [str8(PID.body, enc(body, label))]),
      ...extra,
    ],
    recipients: to
      ? [[long(PID.recipType, 1), str8(PID.recipName, enc(to, label)), str8(PID.recipSmtp, enc(toAddress, label))]]
      : [],
  });
}

const BAD = /[\u0080-\u009f�]/;

describe('.msg PT_STRING8 strings (non-Unicode .msg)', () => {
  it('decodes Windows-1252: umlauts, euro sign and typographic punctuation (0x80-0x9F)', async () => {
    const msg = textMessage('windows-1252', 1252, {
      subject: 'Grüße aus Köln: 100 € für Käse',
      from: 'Jürgen Müller',
      to: 'Zoë Ünal',
      body: 'Schöne Grüße!\r\nDer Preis: 5 € – „reduziert“ …',
    });
    const r = await convert(msg, 'de');
    assert.equal(r.title, 'Grüße aus Köln: 100 € für Käse');
    assert.deepEqual(r.headers, ['**Von:** Jürgen Müller <sender@example.com>', '**An:** Zoë Ünal <to@example.com>']);
    assert.equal(r.body, 'Schöne Grüße!\nDer Preis: 5 € – „reduziert“ …\n');
  });

  it('decodes Windows-1251 (Cyrillic)', async () => {
    const msg = textMessage('windows-1251', 1251, {
      subject: 'Привет, мир: отчёт за квартал',
      from: 'Иван Петров',
      to: 'Анна Ёлкина',
      body: 'Здравствуйте!\r\nСумма: 100 € — оплачено.',
    });
    const r = await convert(msg);
    assert.equal(r.title, 'Привет, мир: отчёт за квартал');
    assert.deepEqual(r.headers, ['**From:** Иван Петров <sender@example.com>', '**To:** Анна Ёлкина <to@example.com>']);
    assert.equal(r.body, 'Здравствуйте!\nСумма: 100 € — оплачено.\n');
  });

  it('decodes Windows-1250 (Central European)', async () => {
    const msg = textMessage('windows-1250', 1250, {
      subject: 'Příliš žluťoučký kůň',
      from: 'Zażółć Gęślą',
      body: 'Úpěl ďábelské ódy. Zażółć gęślą jaźń.',
    });
    const r = await convert(msg);
    assert.equal(r.title, 'Příliš žluťoučký kůň');
    assert.deepEqual(r.headers, ['**From:** Zażółć Gęślą <sender@example.com>']);
    assert.equal(r.body, 'Úpěl ďábelské ódy. Zażółć gęślą jaźń.\n');
  });

  it('decodes Shift-JIS (code page 932, double-byte)', async () => {
    const msg = textMessage('shift_jis', 932, {
      subject: '日本語のテスト',
      from: '山田太郎',
      to: '鈴木花子',
      body: 'こんにちは、世界。\r\nテストメールです。',
    });
    const r = await convert(msg);
    assert.equal(r.title, '日本語のテスト');
    assert.deepEqual(r.headers, ['**From:** 山田太郎 <sender@example.com>', '**To:** 鈴木花子 <to@example.com>']);
    assert.equal(r.body, 'こんにちは、世界。\nテストメールです。\n');
  });

  it('decodes UTF-8 in PT_STRING8 (code page 65001)', async () => {
    const msg = textMessage('utf-8', 65001, {
      subject: 'Grüße: 100 € ☃',
      from: 'Jürgen Müller',
      body: 'Süß und salzig – 5 €',
    });
    const r = await convert(msg);
    assert.equal(r.title, 'Grüße: 100 € ☃');
    assert.deepEqual(r.headers, ['**From:** Jürgen Müller <sender@example.com>']);
    assert.equal(r.body, 'Süß und salzig – 5 €\n');
  });

  it('assumes Windows-1252 when the message carries no code page', async () => {
    const msg = buildMsg({
      props: [
        str8(PID.subject, enc('Preis: 100 € für Käse', 'windows-1252')),
        str8(PID.senderName, enc('Jürgen Müller', 'windows-1252')),
        str8(PID.body, enc('Zahlung über 5 € „sofort“', 'windows-1252')),
      ],
    });
    const r = await convert(msg);
    assert.equal(r.title, 'Preis: 100 € für Käse');
    assert.deepEqual(r.headers, ['**From:** Jürgen Müller']);
    assert.equal(r.body, 'Zahlung über 5 € „sofort“\n');
  });

  it('falls back to PR_INTERNET_CPID when PR_MESSAGE_CODEPAGE is missing', async () => {
    const msg = buildMsg({
      props: [
        long(PID.internetCodepage, 1251),
        str8(PID.subject, enc('Привет', 'windows-1251')),
        str8(PID.body, enc('Мир', 'windows-1251')),
      ],
    });
    const r = await convert(msg);
    assert.equal(r.title, 'Привет');
    assert.equal(r.body, 'Мир\n');
  });

  it('leaves PT_UNICODE properties alone in a message that also has PT_STRING8 ones', async () => {
    const msg = buildMsg({
      props: [
        long(PID.messageCodepage, 1251),
        str16(PID.subject, 'Grüße ☃ Привет'),
        str8(PID.senderName, enc('Иван', 'windows-1251')),
        str8(PID.body, enc('Тело письма', 'windows-1251')),
      ],
      recipients: [[long(PID.recipType, 1), str16(PID.recipName, 'Zoë Ünal'), str16(PID.recipSmtp, 'z@example.com')]],
    });
    const r = await convert(msg);
    assert.equal(r.title, 'Grüße ☃ Привет');
    assert.deepEqual(r.headers, ['**From:** Иван', '**To:** Zoë Ünal <z@example.com>']);
    assert.equal(r.body, 'Тело письма\n');
  });

  it('does not fail on a code page it has no decoder for; ASCII text stays readable', async () => {
    const msg = buildMsg({
      props: [
        long(PID.messageCodepage, 99999),
        str8(PID.subject, Buffer.from('Plain subject')),
        str8(PID.body, Buffer.from('Plain body')),
      ],
    });
    const r = await convert(msg);
    assert.equal(r.title, 'Plain subject');
    assert.equal(r.body, 'Plain body\n');
  });
});

// A paragraph long enough for the regular HTML pipeline (>= 200 characters of content).
const pad = (s) => `${s} ${'This paragraph pads the message so that the extraction finds enough content. '.repeat(4)}`;

describe('.msg HTML body (PR_HTML) in a non-UTF-8 code page', () => {
  const htmlMessage = (label, cp, html, { props = [] } = {}) => buildMsg({
    props: [
      long(PID.internetCodepage, cp),
      str8(PID.subject, Buffer.from('HTML body subject')),
      bin(PID.bodyHtmlBinary, enc(html, label)),
      ...props,
    ],
  });

  it('decodes a Windows-1252 HTML body without <meta charset> by PR_INTERNET_CPID', async () => {
    const r = await convert(htmlMessage('windows-1252', 1252,
      `<html><body><p>${pad('Käse für 5 € – „frisch“ aus Köln.')}</p></body></html>`), 'de');
    assert.equal(r.title, 'HTML body subject');
    assert.ok(r.body.includes('Käse für 5 € – „frisch“ aus Köln.'), r.body);
    assert.ok(!BAD.test(r.markdown), 'no C1 control or replacement characters');
  });

  it('decodes a short Windows-1252 HTML body (direct HTML conversion)', async () => {
    const r = await convert(htmlMessage('windows-1252', 1252, '<p>Grüße: <b>5 €</b></p>'), 'de');
    assert.equal(r.body, 'Grüße: **5 €**\n');
  });

  it('decodes a Windows-1251 HTML body', async () => {
    const r = await convert(htmlMessage('windows-1251', 1251,
      `<html><body><p>${pad('Привет, мир! Счёт на 100 €.')}</p></body></html>`));
    assert.ok(r.body.includes('Привет, мир! Счёт на 100 €.'), r.body);
    assert.ok(!BAD.test(r.markdown));
  });

  it('decodes a Shift-JIS HTML body', async () => {
    const r = await convert(htmlMessage('shift_jis', 932,
      `<html><body><p>${pad('こんにちは、世界。テストです。')}</p></body></html>`));
    assert.ok(r.body.includes('こんにちは、世界。テストです。'), r.body);
    assert.ok(!BAD.test(r.markdown));
  });

  it('uses PR_MESSAGE_CODEPAGE for the HTML when PR_INTERNET_CPID is missing', async () => {
    const msg = buildMsg({
      props: [
        long(PID.messageCodepage, 1251),
        str8(PID.subject, enc('Тема', 'windows-1251')),
        bin(PID.bodyHtmlBinary, enc('<p>Привет, мир</p>', 'windows-1251')),
      ],
    });
    const r = await convert(msg);
    assert.equal(r.title, 'Тема');
    assert.equal(r.body, 'Привет, мир\n');
  });

  it('guesses without any code page or <meta charset>: valid UTF-8 as UTF-8, anything else as Windows-1252', async () => {
    const noCodepage = (bytes) => buildMsg({ props: [str8(PID.subject, Buffer.from('S')), bin(PID.bodyHtmlBinary, bytes)] });
    const utf8 = await convert(noCodepage(Buffer.from('<p>Grüße: 5 €</p>', 'utf8')));
    assert.equal(utf8.body, 'Grüße: 5 €\n');
    const ansi = await convert(noCodepage(enc('<p>Grüße: 5 €</p>', 'windows-1252')));
    assert.equal(ansi.body, 'Grüße: 5 €\n');
  });

  it('lets <meta charset> win over the message code page', async () => {
    const r = await convert(htmlMessage('windows-1251', 1252,
      '<html><head><meta http-equiv="Content-Type" content="text/html; charset=windows-1251"></head><body><p>Привет, мир</p></body></html>'));
    assert.equal(r.body, 'Привет, мир\n');
  });
});

// RTF with HTML encapsulated (\fromhtml1), bytes >= 0x80 as \'hh in the \ansicpg code page.
function encapsulatedRtf(label, cp, { fontCharset, html }) {
  const esc = (text) => [...enc(text, label)].map((b) => (b < 0x80 ? String.fromCharCode(b) : `\\'${b.toString(16).padStart(2, '0')}`)).join('');
  const tag = (t) => `{\\*\\htmltag64 ${t}}`;
  return Buffer.from([
    `{\\rtf1\\ansi\\ansicpg${cp}\\fromhtml1 \\deff0{\\fonttbl{\\f0\\fswiss\\fcharset${fontCharset} Arial;}}`,
    tag('<html><body><p>'),
    `\\htmlrtf {\\htmlrtf0 ${esc(html)}}`,
    tag('</p></body></html>'),
    '}',
  ].join(''), 'latin1');
}

describe('.msg compressed-RTF body with \\ansicpg', () => {
  const rtfMessage = (label, cp, fontCharset, html) => buildMsg({
    props: [
      long(PID.messageCodepage, cp),
      str8(PID.subject, enc('RTF', label)),
      bin(PID.compressedRtf, compressRtfLiteral(encapsulatedRtf(label, cp, { fontCharset, html }))),
    ],
  });

  it('decodes Windows-1252 text and the euro sign', async () => {
    const r = await convert(rtfMessage('windows-1252', 1252, 0, 'Grüße aus Köln: 5 € – „frisch“'), 'de');
    assert.equal(r.body, 'Grüße aus Köln: 5 € – „frisch“\n');
  });

  it('decodes Windows-1251 text', async () => {
    const r = await convert(rtfMessage('windows-1251', 1251, 204, 'Привет, мир! Счёт на 100 €.'));
    assert.equal(r.body, 'Привет, мир! Счёт на 100 €.\n');
  });

  it('decodes Shift-JIS text', async () => {
    const r = await convert(rtfMessage('shift_jis', 932, 128, 'こんにちは、世界。テストです。'));
    assert.equal(r.body, 'こんにちは、世界。テストです。\n');
  });

  it('takes the body from the RTF alone (no PR_BODY, no PR_HTML), so the container round-trips', async () => {
    const r = await convert(rtfMessage('windows-1251', 1251, 204, 'Только RTF'));
    assert.equal(r.body, 'Только RTF\n');
  });
});
