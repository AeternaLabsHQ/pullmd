import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { extractRtf, isRtfFile, rtfToHtmlIfEncapsulated, rtfToMarkdown } from '../lib/rtf.js';
import { extractMsg } from '../lib/msg.js';

const rtfFixture = (name) => readFileSync(new URL(`./fixtures/rtf/${name}`, import.meta.url));
const msgFixture = (name) => readFileSync(new URL(`./fixtures/msg/${name}`, import.meta.url));
const md = (rtf) => rtfToMarkdown(rtf).markdown;
// Builds an RTF \uN control word without a literal unicode escape in this source.
const U = (n) => `${String.fromCharCode(92)}u${n}`;
const LONG = 'Ein ausreichend langer Absatz mit Inhalt. '.repeat(10);

// [MS-OXRTFEX] section 3.1, verbatim.
const SPEC_EXAMPLE = String.raw`{\rtf1\ANSI\ansicpg1251\fromhtml1 \deff0
{\fonttbl {\f0\fmodern Courier New;}{\f1\fswiss Arial;}{\f2\fswiss\fcharset0 Arial;}}
{\colortbl\red0\green0\blue0;\red0\green0\blue255;}
{\*\htmltag64}
\uc1\pard\plain\deftab360 \f0\fs24
{\*\htmltag <HTML><head>\par
<style>\par
<!--\par
 /* Style Definitions */\par
 p.MsoNormal, li.MsoNormal \{font-family:Arial;\}\par
-->\par
</style>\par
\tab <!-- This is a HTML comment.\par
There is a horizontal tab (%x09) character before the comment, \par
and some new lines inside the comment. -->\par
</head>\par
<body>\par
<p\par
class="MsoNormal">}
{\htmlrtf \f1 \htmlrtf0 Note the line break inside a P tag. {\*\htmltag <b>}{\htmlrtf \b
\htmlrtf0 This is a bold text{\*\htmltag </b>}} \htmlrtf\par\htmlrtf0}
\htmlrtf \par \htmlrtf0
{\*\htmltag </p>\par
<p class="MsoNormal">\par}
{\htmlrtf \f1 \htmlrtf0 This is a normal text with a character references:
{\*\htmltag &nbsp;}\htmlrtf \'a0\htmlrtf0 {\*\htmltag &lt;}\htmlrtf <\htmlrtf0 {\*\htmltag
&uml;}\htmlrtf {\f2\'a8}\htmlrtf0{\*\htmltag <br>\par}\htmlrtf\line\htmlrtf0
characters which have special meaning in RTF: \{\}\\{\*\htmltag
<br>\par}\htmlrtf\line\htmlrtf0\htmlrtf\par\htmlrtf0}
{\*\htmltag </p>\par
<ol>\par
    <li class="MsoNormal">}{\htmlrtf
{{\*\pn\pnlvlbody\pndec\pnstart1\pnindent360{\pntxta.}}\li360\fi-360{\pntext 1.\tab} \f1
\htmlrtf0 This is a list item}\htmlrtf\par\htmlrtf0}
{\*\htmltag \par
</ol>\par
</body>\par
</HTML>\par }}`;

describe('isRtfFile', () => {
  it('detects by extension, by content type only without one', () => {
    assert.equal(isRtfFile('application/octet-stream', 'Brief.RTF'), true);
    assert.equal(isRtfFile('application/rtf', ''), true);
    assert.equal(isRtfFile('text/rtf; charset=us-ascii', 'upload'), true);
    assert.equal(isRtfFile('text/richtext', ''), true);
    assert.equal(isRtfFile('application/rtf', 'brief.doc'), false);
    assert.equal(isRtfFile('text/plain', 'a.txt'), false);
  });
});

describe('rtfToMarkdown', () => {
  it('converts a LibreOffice document: headings, emphasis, link, lists, table, metadata', () => {
    const r = rtfToMarkdown(rtfFixture('quartalsbericht.rtf').toString('latin1'));
    assert.equal(r.title, 'Quartalsbericht Gartenverein');
    assert.equal(r.author, 'Erika Beispiel');
    assert.equal(r.created, null); // LibreOffice writes \creatim\yr0
    const expected = [
      '# Quartalsbericht Gartenverein',
      '',
      'Dieser Bericht fasst die **wichtigsten Ereignisse** des Quartals zusammen. Die Beiträge sind *unverändert* geblieben, die Kasse enthält 1.250 €.',
      '',
      '## Termine',
      '',
      '- Frühjahrsputz am Samstag',
      '- Pflanzentausch im Mai',
      '- Sommerfest mit Grillgut',
      '',
      'Weitere Informationen stehen auf der [Vereinsseite](https://example.org/verein).',
      '',
      '## Ablauf',
      '',
      '1. Begrüßung',
      '2. Kassenbericht',
      '',
      '## Beete',
      '',
      '| Beet | Pächter | Fläche |',
      '| --- | --- | --- |',
      '| A1 | Müller | 12 m² |',
      '| B2 | Schäfer \\| Sohn | 8 m² |',
      '',
      'Mit freundlichen Grüßen  ',
      'Der Vorstand',
    ].join('\n');
    assert.equal(r.markdown, expected);
  });

  it('decodes \\\'hh with the document code page', () => {
    assert.equal(md(String.raw`{\rtf1\ansi\ansicpg1252 Gr\'fc\'dfe aus K\'f6ln}`), 'Grüße aus Köln');
    assert.equal(md(String.raw`{\rtf1\ansi\ansicpg1251 \'e4\'e0}`), 'да');
  });

  it('uses the font charset over the document code page', () => {
    const rtf = String.raw`{\rtf1\ansi\ansicpg1252{\fonttbl{\f0 Arial;}{\f1\fcharset204 Arial Cyr;}}\f0 \'e4 {\f1 \'e4}}`;
    assert.equal(md(rtf), 'ä д');
  });

  it('decodes double-byte code pages as byte sequences, ASCII trail bytes included', () => {
    assert.equal(md(String.raw`{\rtf1\ansi\ansicpg932 \'83\'65\'83\'58\'83\'67}`), 'テスト');
    assert.equal(md(String.raw`{\rtf1\ansi\ansicpg932 \'83e\'83X\'83g}`), 'テスト');
  });

  it('honours \\uN with the \\ucN skip count', () => {
    assert.equal(md(String.raw`{\rtf1\ansi\uc1 ${U(33636)}?\u-30000?}`), '荤\u8ad0');
    assert.equal(md(String.raw`{\rtf1\ansi\uc2 ${U(8364)}\'80\'80 Euro}`), '€ Euro');
    assert.equal(md(String.raw`{\rtf1\ansi\uc0 \u228 x}`), 'äx');
    // \uc is group-scoped, the fallback ends at a group boundary
    assert.equal(md(String.raw`{\rtf1\ansi{\uc3 \u252 abc}\u246 ?}`), 'üö');
    assert.equal(md(String.raw`{\rtf1\ansi\uc5 {\u252}x}`), 'üx');
  });

  it('restores formatting when nested groups close', () => {
    assert.equal(md(String.raw`{\rtf1 a {\b b {\i c} d} e}`), 'a **b *c* d** e');
    assert.equal(md(String.raw`{\rtf1 {\b fett \b0 normal}}`), '**fett** normal');
    assert.equal(md(String.raw`{\rtf1 {\b fett\par weiter}}`), '**fett**\n\n**weiter**');
    assert.equal(md(String.raw`{\rtf1 x{\b  }y}`), 'x y');
  });

  it('skips \\* destinations, font/color tables, pictures and \\bin data', () => {
    const rtf = String.raw`{\rtf1{\fonttbl{\f0 Arial;}}{\colortbl;\red0\green0\blue0;}{\*\unbekannt geheim {\b noch geheimer}}{\pict\pngblip 89504e47}{\*\shppict{\pict 00}}{\header Kopfzeile}{\object{\*\objdata 01}{\result Ergebnis}} sichtbar{\*\x \bin4 }}{ab} ende}`;
    assert.equal(md(rtf), 'Ergebnis sichtbar ende');
  });

  it('handles escapes and special characters', () => {
    const rtf = String.raw`{\rtf1 \{a\} b\\c d\~e Silben\-trennung non\_breaking \emdash  \endash  \lquote x\rquote  \ldblquote y\rdblquote\line z\tab w}`;
    assert.equal(md(rtf), '{a} b\\\\c d\u00a0e Silbentrennung non-breaking \u2014 \u2013 \u2018x\u2019 \u201cy\u201d  \nz w');
  });

  it('escapes Markdown syntax in the text', () => {
    assert.equal(md(String.raw`{\rtf1 5 * 3 = snake_case [x]\par # kein Titel\par 1. kein Punkt}`), '5 \\* 3 = snake\\_case \\[x\\]\n\n\\# kein Titel\n\n1\\. kein Punkt');
  });

  it('reads \\info metadata including the creation time', () => {
    const r = rtfToMarkdown(String.raw`{\rtf1{\info{\title Notiz}{\author Max Muster}{\creatim\yr2024\mo3\dy5\hr14\min30}{\*\company Firma}}Text}`);
    assert.deepEqual(r, { markdown: 'Text', title: 'Notiz', author: 'Max Muster', created: '2024-03-05T14:30:00.000Z' });
  });

  it('turns Word-style fields, lists and tables into Markdown', () => {
    const rtf = String.raw`{\rtf1\ansi
{\stylesheet{\s0 Normal;}{\s1\outlinelevel0 heading 1;}{\s2 Heading 2;}{\*\cs10 Default Paragraph Font;}}
\pard\s1 Titel\par
\pard\s2 Abschnitt\par
\pard Siehe {\field{\*\fldinst {HYPERLINK "https://example.com/a_b" }}{\fldrslt {\ul\b Link}}} hier.\par
\pard{\pntext\f1 \'b7\tab}{\*\pn\pnlvlblt{\pntxtb\'b7}}Punkt eins\par
\pard\ls1\ilvl1{\listtext 1.\tab}Unterpunkt\par
\trowd\cellx1000\cellx2000\pard\intbl Kopf A\cell Kopf B\cell\row
\trowd\cellx1000\cellx2000\pard\intbl {\i x}\par y\cell z\cell\row
\pard Danach\par}`;
    assert.equal(md(rtf), [
      '# Titel',
      '',
      '## Abschnitt',
      '',
      'Siehe **[Link](https://example.com/a_b)** hier.',
      '',
      '- Punkt eins',
      '   1. Unterpunkt',
      '',
      '| Kopf A | Kopf B |',
      '| --- | --- |',
      '| *x*<br>y | z |',
      '',
      'Danach',
    ].join('\n'));
  });

  it('survives absurd group nesting without recursion', () => {
    const deep = '{\\rtf1 vorher ' + '{'.repeat(100000) + 'tief' + '}'.repeat(100000) + 'nachher}';
    assert.equal(md(deep), 'vorher nachher');
    // groups beyond the depth bound are dropped whole, \* included
    const bound = '{\\rtf1 ' + '{'.repeat(200) + '{\\*\\foo versteckt}sichtbar' + '}'.repeat(200) + '}';
    assert.equal(md(bound), 'sichtbar');
    const unclosed = '{\\rtf1 ' + '{\\b '.repeat(100000) + 'offen';
    assert.equal(md(unclosed), '');
    const html = '{\\rtf1\\fromhtml1 ' + '{'.repeat(100000) + '{\\*\\htmltag <i>}x' + '}'.repeat(100001) + '{\\*\\htmltag <p>}y}';
    assert.equal(rtfToHtmlIfEncapsulated(html), '<p>y');
  });
});

describe('rtfToHtmlIfEncapsulated', () => {
  it('returns null for RTF without \\fromhtml1', () => {
    assert.equal(rtfToHtmlIfEncapsulated(String.raw`{\rtf1\ansi Hallo}`), null);
    assert.equal(rtfToHtmlIfEncapsulated(String.raw`{\rtf1\ansi\fromhtml0 Hallo}`), null);
    assert.equal(rtfToHtmlIfEncapsulated(String.raw`{\rtf1\ansi\fromtext Hallo}`), null);
    // only the first 10 tokens are inspected
    assert.equal(rtfToHtmlIfEncapsulated(String.raw`{\rtf1 Text \fromhtml1}`), null);
    assert.equal(rtfToHtmlIfEncapsulated('kein rtf'), null);
  });

  it('recovers the HTML of the [MS-OXRTFEX] 3.1 example', () => {
    const html = rtfToHtmlIfEncapsulated(SPEC_EXAMPLE);
    assert.ok(html.startsWith('<HTML><head>\r\n<style>\r\n<!--\r\n'));
    assert.ok(html.includes(' p.MsoNormal, li.MsoNormal {font-family:Arial;}\r\n'));
    assert.ok(html.includes('</style>\r\n\t<!-- This is a HTML comment.\r\n'));
    assert.ok(html.includes('<p\r\nclass="MsoNormal">Note the line break inside a P tag. <b>This is a bold text</b> </p>\r\n'));
    // the RTF itself drops the spaces around the references (control-word delimiters)
    assert.ok(html.includes('character references:&nbsp;&lt;&uml;<br>\r\ncharacters which have special meaning in RTF: {}\\<br>\r\n</p>'));
    assert.ok(html.includes('<li class="MsoNormal">This is a list item\r\n</ol>'));
    assert.ok(!html.includes('1.\t'));
    assert.ok(!html.includes('\u00a0'));
    assert.ok(html.endsWith('</HTML>\r\n'));
  });

  it('decodes htmltag bytes with the document code page and body text with the font code page', () => {
    const rtf = String.raw`{\rtf1\ansi\ansicpg1252\fromhtml1 {\fonttbl{\f0 Arial;}{\f1\fcharset204 Arial Cyr;}}{\*\htmltag <p title="\'e4">}\f1 \'e4\htmlrtf {\f0 x}\htmlrtf0 {\*\htmltag84 &#8364;${U(8364)}?}}`;
    assert.equal(rtfToHtmlIfEncapsulated(rtf), '<p title="ä">д&#8364;€');
  });

  it('decodes multi-byte code pages and skips \\mhtmltag', () => {
    const rtf = String.raw`{\rtf1\ansi\ansicpg932\fromhtml1 {\*\mhtmltag84 <img src="cid:x">}{\*\htmltag84 <img src="y">}\'83\'65\'83X\'83g{\*\htmltag <b>\'83\'67</b>}}`;
    assert.equal(rtfToHtmlIfEncapsulated(rtf), '<img src="y">テスト<b>ト</b>');
  });
});

describe('extractRtf', () => {
  it('converts the LibreOffice fixture with title and author', async () => {
    const r = await extractRtf(rtfFixture('quartalsbericht.rtf'), { filename: 'bericht.rtf' });
    assert.equal(r.source, 'rtf');
    assert.equal(r.title, 'Quartalsbericht Gartenverein');
    assert.ok(r.markdown.startsWith('# Quartalsbericht Gartenverein\n\nDieser Bericht fasst'));
    assert.equal((r.markdown.match(/^# /gm) || []).length, 1); // document H1 not repeated
    assert.equal(r.metadata.author, 'Erika Beispiel');
    assert.equal(r.metadata.sourceUrl, null);
    assert.ok(r.metadata.contentLength > 400);
  });

  it('falls back to the file name for the title', async () => {
    const r = await extractRtf(Buffer.from(String.raw`{\rtf1\ansi Nur ein Satz.\par}`), { filename: 'Mein Brief.rtf' });
    assert.equal(r.markdown, '# Mein Brief\n\nNur ein Satz.\n');
  });

  it('accepts a UTF-8 BOM and leading whitespace', async () => {
    const r = await extractRtf(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('\r\n {\\rtf1 Hallo}')]), { filename: 'a.rtf' });
    assert.equal(r.markdown, '# a\n\nHallo\n');
  });

  it('routes encapsulated HTML through extractHtml', async () => {
    let got;
    const rtf = `{\\rtf1\\ansi\\fromhtml1 {\\*\\htmltag <html><head><title>Rundbrief</title></head><body><p>}${LONG}{\\*\\htmltag </p></body></html>}}`;
    const r = await extractRtf(Buffer.from(rtf), {
      filename: 'x.rtf',
      extractHtml: async (html, opts) => { got = { html, opts }; return { markdown: `# Rundbrief\n\n${LONG}\n`, metadata: { contentLength: LONG.length } }; },
    });
    assert.ok(got.html.startsWith('<html><head><title>Rundbrief</title>'));
    assert.equal(got.opts.filename, 'x.rtf');
    assert.equal(r.title, 'Rundbrief');
    assert.equal(r.markdown, `# Rundbrief\n\n${LONG.trim()}\n`);
  });

  it('converts short encapsulated HTML directly', async () => {
    const rtf = String.raw`{\rtf1\ansi\fromhtml1 {\*\htmltag <p>}Bis {\*\htmltag <b>}Montag{\*\htmltag </b>}!{\*\htmltag </p>}}`;
    const r = await extractRtf(Buffer.from(rtf), { filename: 'kurz.rtf' });
    assert.equal(r.markdown, '# kurz\n\nBis **Montag**!\n');
  });

  it('answers 422 for non-RTF bytes and for RTF without text', async () => {
    await assert.rejects(() => extractRtf(Buffer.from('%PDF-1.7 garbage'), {}), (e) => e.status === 422 && e.code === 'not_rtf');
    await assert.rejects(() => extractRtf(Buffer.from([0x00, 0xff, 0x13, 0x37]), {}), (e) => e.status === 422 && e.code === 'not_rtf');
    await assert.rejects(() => extractRtf(Buffer.from(String.raw`{\rtf1{\fonttbl{\f0 Arial;}}\par\par}`), {}), (e) => e.status === 422 && e.code === 'empty_file');
  });
});

describe('.msg bodies stored only as RTF-encapsulated HTML', () => {
  const capture = () => {
    const calls = [];
    const extractHtml = async (html) => { calls.push(html); return { markdown: `# t\n\n${LONG}`, metadata: { contentLength: LONG.length } }; };
    return { calls, extractHtml };
  };

  it('feeds the de-encapsulated HTML (with its formatting) into the mail renderer', async () => {
    const { calls, extractHtml } = capture();
    const r = await extractMsg(msgFixture('attachmentFiles.msg'), { lang: 'en', extractHtml });
    assert.equal(calls.length, 1);
    // the plain-text body only has "attachmentFiles"; the HTML keeps the italics
    assert.match(calls[0], /<i><span lang=EN-US[^>]*>attachmentFiles<o:p><\/o:p><\/span><\/i>/);
    assert.ok(r.markdown.includes(LONG.trim()));
  });

  it('keeps inline images of the HTML body', async () => {
    const { calls, extractHtml } = capture();
    await extractMsg(msgFixture('attach-and-inline.msg'), { lang: 'en', extractHtml });
    assert.match(calls[0], /<img width=256 height=32 [^>]*src="cid:image001\.png@01D78380\.EF6DC500">/);
  });

  it('prefers a real HTML body over the RTF', async () => {
    const { calls, extractHtml } = capture();
    await extractMsg(msgFixture('html-body.msg'), { lang: 'en', extractHtml });
    assert.ok(calls[0].includes('この電子メール メッセージは'));
    assert.ok(!calls[0].includes('htmltag'));
  });

  it('still uses the plain body when the HTML is too short for the extraction', async () => {
    const r = await extractMsg(msgFixture('to-cc-bcc.msg'), { lang: 'en' });
    assert.match(r.markdown, /---\n\nMessage\n/);
  });
});

describe('encapsulated HTML images', () => {
  it('drops images pointing at files outside the RTF, keeps web images', async () => {
    const rtf = String.raw`{\rtf1\ansi\ansicpg1252\fromhtml1 {\*\htmltag64 <body>}{\*\htmltag84 <img src="1.jpg">}{\*\htmltag84 <img src="https://example.com/a.png" alt="web">}{\*\htmltag84 <p>}Hallo Welt{\*\htmltag84 </p>}{\*\htmltag64 </body>}}`;
    const r = await extractRtf(Buffer.from(rtf), { filename: 'mail.rtf' });
    assert.doesNotMatch(r.markdown, /1\.jpg/);
    assert.match(r.markdown, /!\[web\]\(https:\/\/example\.com\/a\.png\)/);
    assert.match(r.markdown, /Hallo Welt/);
  });
});

describe('hostile RTF input', () => {
  const timed = (fn) => {
    const t0 = Date.now();
    const out = fn();
    const ms = Date.now() - t0;
    assert.ok(ms < 5000, `took ${ms} ms`);
    return out;
  };

  it('formats a long whitespace run inside bold text in linear time', () => {
    const out = timed(() => md(`{\\rtf1 {\\b x${' '.repeat(200000)}y}}`));
    assert.equal(out, `**x${' '.repeat(200000)}y**`);
  });

  it('styles many whitespace-only segments in linear time', () => {
    const out = timed(() => md(`{\\rtf1 ${'{\\b a}{ }'.repeat(50000)}}`));
    assert.ok(out.startsWith('**a a a'));
    assert.ok(out.endsWith('a**'));
  });

  it('tidies many line breaks and long trailing blanks in linear time', () => {
    const out = timed(() => md(`{\\rtf1 x${'\\line '.repeat(100000)}# y${' '.repeat(100000)}z\\par}`));
    assert.ok(out.startsWith('x  \n\n'));
    assert.ok(out.endsWith(`\\# y${' '.repeat(100000)}z`));
  });

  it('pads table rows only within a budget', () => {
    const rtf = `{\\rtf1 \\intbl ${'a\\cell '.repeat(100000)}\\row ${'\\intbl b\\cell \\row '.repeat(100000)}}`;
    assert.throws(() => md(rtf), (e) => e.status === 422 && e.code === 'document_too_large');
  });

  it('reads the <title> of encapsulated HTML in linear time', async () => {
    const rtf = `{\\rtf1\\ansi\\fromhtml1 {\\*\\htmltag <html>}${'{\\*\\htmltag <title>}'.repeat(50000)}{\\*\\htmltag <p>}${LONG}{\\*\\htmltag </p>}}`;
    const t0 = Date.now();
    const r = await extractRtf(Buffer.from(rtf, 'latin1'), {
      filename: 'kein-titel.rtf',
      extractHtml: async () => ({ markdown: `# x\n\n${LONG}`, metadata: { contentLength: LONG.length } }),
    });
    assert.ok(Date.now() - t0 < 5000, `took ${Date.now() - t0} ms`);
    assert.equal(r.title, 'kein-titel');
  });
});
