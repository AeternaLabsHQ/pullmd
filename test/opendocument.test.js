import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import zlib from 'node:zlib';
import { extractOpenDocument, isOpenDocumentFile } from '../lib/opendocument.js';
import { readZipEntries, readZipEntry, ZipError } from '../lib/zip.js';

const fixture = (name) => readFileSync(new URL(`./fixtures/odf/${name}`, import.meta.url));

/** Tiny ZIP writer: entries = [{ name, data, deflate?, flags? }]. */
function makeZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const e of entries) {
    const raw = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data);
    const body = e.deflate ? zlib.deflateRawSync(raw) : raw;
    const name = Buffer.from(e.name);
    const crc = zlib.crc32(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(e.flags || 0, 6);
    local.writeUInt16LE(e.deflate ? 8 : 0, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(e.flags || 0, 8);
    central.writeUInt16LE(e.deflate ? 8 : 0, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, body);
    centrals.push(central, name);
    offset += 30 + name.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

const NS = 'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0"';

function odf(kind, bodyXml, extra = [], autoStyles = '') {
  return makeZip([
    { name: 'mimetype', data: `application/vnd.oasis.opendocument.${kind}` },
    { name: 'content.xml', data: `<?xml version="1.0"?><office:document-content ${NS}>${autoStyles}<office:body>${bodyXml}</office:body></office:document-content>`, deflate: true },
    ...extra,
  ]);
}

const is422 = (code) => (e) => e.status === 422 && e.code === code;

// ---------------------------------------------------------------- detection

describe('isOpenDocumentFile', () => {
  it('detects by extension', () => {
    assert.equal(isOpenDocumentFile('application/octet-stream', 'Bericht.ODT'), true);
    assert.equal(isOpenDocumentFile('', 'a.ods'), true);
    assert.equal(isOpenDocumentFile('', 'a.odp'), true);
    assert.equal(isOpenDocumentFile('application/vnd.oasis.opendocument.text', 'a.docx'), false);
  });

  it('detects by content type only when the name has no extension', () => {
    assert.equal(isOpenDocumentFile('application/vnd.oasis.opendocument.spreadsheet', 'upload'), true);
    assert.equal(isOpenDocumentFile('application/vnd.oasis.opendocument.presentation; charset=binary', ''), true);
    assert.equal(isOpenDocumentFile('application/vnd.oasis.opendocument.graphics', ''), false);
    assert.equal(isOpenDocumentFile('application/zip', ''), false);
  });
});

// ---------------------------------------------------------------- .odt

describe('OpenDocument text (.odt)', () => {
  it('renders headings, inline formatting, links, lists, tables and footnotes', async () => {
    const r = await extractOpenDocument(fixture('bericht.odt'), { filename: 'bericht.odt', lang: 'de' });
    const md = r.markdown;
    assert.equal(r.source, 'opendocument');
    assert.ok(md.startsWith('# Projektbericht Gartenbau\n\n## Einleitung\n\n'), md);
    assert.ok(md.includes('Dies ist ein **fetter** und ein *kursiver* Text mit einem [Link](https://example.com/info).[^1]'));
    assert.ok(md.includes('Ein Sternchen \\* und ein Wort_mit_Unterstrich bleiben normal.   Drei Leerzeichen.  \nNeue Zeile im selben Absatz.'));
    assert.ok(md.includes('\n\\# Keine Überschrift\n'));
    assert.ok(md.includes('\n*Ein ganz kursiver Absatz.*\n'));
    assert.ok(md.includes('\n**Benannter** Zeichenstil.\n'));
    assert.ok(md.includes('### Liste\n\n- Erster Punkt\n  - Unterpunkt A\n  - Unterpunkt B\n- Zweiter Punkt\n\n1. Eins\n2. Zwei\n'));
    assert.ok(md.includes('| Pflanze | Menge |\n| --- | --- |\n| Tomate \\| rot | 12 |\n| Gurke<br>lang | 7 |'));
    assert.ok(md.trimEnd().endsWith('Ende.\n\n[^1]: Eine Fußnote mit Quelle.'));
  });

  it('skips the table of contents, annotations and bookmarks', async () => {
    const r = await extractOpenDocument(fixture('bericht.odt'), { filename: 'bericht.odt' });
    assert.ok(!r.markdown.includes('Einleitung 1'));
    assert.ok(!r.markdown.includes('Kommentar'));
    assert.ok(!r.markdown.includes('****'));
    assert.ok(!r.markdown.includes('Table_20_Heading'));
    assert.ok(!r.markdown.includes('**Pflanze**'), 'named table-heading style is not bolded');
  });

  it('reads title, author and date from meta.xml', async () => {
    const r = await extractOpenDocument(fixture('bericht.odt'), { filename: 'bericht.odt' });
    assert.equal(r.title, 'Projektbericht Gartenbau');
    assert.equal(r.metadata.title, 'Projektbericht Gartenbau');
    assert.equal(r.metadata.author, 'Erika Beispiel');
    assert.equal(r.metadata.publishedTime, '2026-02-03T14:05:00.000Z');
    assert.equal(r.metadata.sourceUrl, null);
    assert.equal(r.metadata.contentLength, r.markdown.length - '# Projektbericht Gartenbau\n\n'.length - 1);
  });

  it('uses a leading heading as title without repeating it', async () => {
    const buf = odf('text', '<office:text><text:h text:outline-level="1">Mein Titel</text:h><text:p>Text.</text:p><text:h text:outline-level="2">Teil</text:h></office:text>');
    const r = await extractOpenDocument(buf, { filename: 'x.odt' });
    assert.equal(r.title, 'Mein Titel');
    assert.equal(r.markdown, '# Mein Titel\n\nText.\n\n## Teil\n');
  });

  it('keeps tabs and text-box text, skips images and descends into sections', async () => {
    const buf = odf('text', '<office:text xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0"><text:section text:name="S1">'
      + '<text:p>Name<text:tab/>Wert</text:p>'
      + '<text:p><draw:frame draw:name="Bild1"><draw:image xlink:href="Pictures/a.png" xmlns:xlink="http://www.w3.org/1999/xlink"/></draw:frame>Nach dem Bild.</text:p>'
      + '<text:p>Vor<draw:frame draw:name="Rahmen1"><draw:text-box><text:p>Kastentext</text:p></draw:text-box></draw:frame>nach.</text:p>'
      + '</text:section></office:text>');
    const r = await extractOpenDocument(buf, { filename: 'x.odt' });
    assert.equal(r.markdown, '# x\n\nName\tWert\n\nNach dem Bild.\n\nVor Kastentext nach.\n');
  });

  it('renders a number style without a format as bullets, with one as numbers', async () => {
    const styles = (fmt) => '<office:automatic-styles xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0"><text:list-style style:name="L9">'
      + `<text:list-level-style-number text:level="1" style:num-format="${fmt}"/></text:list-style></office:automatic-styles>`;
    const body = '<office:text><text:list text:style-name="L9"><text:list-item><text:p>a</text:p></text:list-item><text:list-item><text:p>b</text:p></text:list-item></text:list></office:text>';
    const plain = await extractOpenDocument(odf('text', body, [], styles('')), { filename: 'x.odt' });
    assert.ok(plain.markdown.includes('- a\n- b'), plain.markdown);
    const numbered = await extractOpenDocument(odf('text', body, [], styles('1')), { filename: 'x.odt' });
    assert.ok(numbered.markdown.includes('1. a\n2. b'), numbered.markdown);
  });

  it('rejects absurdly deep nesting with 422 instead of crashing', async () => {
    const deep = '<text:span>'.repeat(30000) + 'x' + '</text:span>'.repeat(30000);
    const buf = odf('text', `<office:text><text:p>${deep}</text:p></office:text>`);
    await assert.rejects(() => extractOpenDocument(buf, { filename: 'tief.odt' }), is422('not_opendocument'));
  });

  it('falls back to the filename stem', async () => {
    const buf = odf('text', '<office:text><text:p>Nur ein Absatz.</text:p></office:text>');
    const r = await extractOpenDocument(buf, { filename: 'Notiz vom Mai.odt' });
    assert.equal(r.markdown, '# Notiz vom Mai\n\nNur ein Absatz.\n');
  });
});

// ---------------------------------------------------------------- .ods

describe('OpenDocument spreadsheet (.ods)', () => {
  it('renders each non-empty sheet as a section with a table', async () => {
    const r = await extractOpenDocument(fixture('ernte.ods'), { filename: 'ernte.ods' });
    assert.equal(r.markdown, [
      '# ernte', '',
      '## Ernte', '',
      '| Monat | Kilo | Notiz |',
      '| --- | --- | --- |',
      '| Mai | 4,5 | a\\|b |',
      '|  |  |  |',
      '|  |  |  |',
      '| Juni und Juli |  | 3 |', '',
      '## Werkzeug', '',
      '| Name | Anzahl |',
      '| --- | --- |',
      '| Spaten | 2 |', '',
    ].join('\n'));
    assert.ok(!r.markdown.includes('## Leer'));
    assert.equal(r.metadata.author, 'Max Muster');
    assert.equal(r.metadata.publishedTime, '2026-01-15T08:00:00.000Z');
  });

  it('caps repeated rows and columns that carry content', async () => {
    const sheet = '<office:spreadsheet><table:table table:name="Lang">'
      + '<table:table-row table:number-rows-repeated="1048576"><table:table-cell table:number-columns-repeated="20"><text:p>x</text:p></table:table-cell></table:table-row>'
      + '</table:table><table:table table:name="Breit">'
      + '<table:table-row><table:table-cell table:number-columns-repeated="16384"><text:p>x</text:p></table:table-cell></table:table-row>'
      + '</table:table></office:spreadsheet>';
    const t0 = Date.now();
    const r = await extractOpenDocument(odf('spreadsheet', sheet), { filename: 'b.ods' });
    assert.ok(Date.now() - t0 < 15000);
    const [long, wide] = r.markdown.split('## Breit');
    const lines = long.split('\n').filter((l) => l.startsWith('|'));
    assert.equal(lines.length, 10000 + 1); // rows + separator
    assert.equal(lines[0].split(' | ').length, 20);
    assert.equal(wide.split('\n').find((l) => l.startsWith('|')).split(' | ').length, 1000);
  });

  it('refuses a sheet whose capped expansion is still too large', async () => {
    // 10000 x 1000 cells (the per-table caps) of 1 KB each would be ~10 GB.
    const sheet = '<office:spreadsheet><table:table table:name="Bombe">'
      + `<table:table-row table:number-rows-repeated="1048576"><table:table-cell table:number-columns-repeated="16384"><text:p>${'x'.repeat(1024)}</text:p></table:table-cell></table:table-row>`
      + '</table:table></office:spreadsheet>';
    const t0 = Date.now();
    await assert.rejects(() => extractOpenDocument(odf('spreadsheet', sheet), { filename: 'b.ods' }), is422('document_too_large'));
    assert.ok(Date.now() - t0 < 5000, `took ${Date.now() - t0} ms`);
  });

  it('keeps a single sheet heading', async () => {
    const sheet = '<office:spreadsheet><table:table table:name="Tabelle1"><table:table-row><table:table-cell><text:p>a</text:p></table:table-cell></table:table-row></table:table></office:spreadsheet>';
    const r = await extractOpenDocument(odf('spreadsheet', sheet), { filename: 'eins.ods' });
    assert.equal(r.markdown, '# eins\n\n## Tabelle1\n\n| a |\n| --- |\n');
  });
});

// ---------------------------------------------------------------- .odp

describe('OpenDocument presentation (.odp)', () => {
  it('renders slides with titles, bodies and speaker notes', async () => {
    const r = await extractOpenDocument(fixture('folien.odp'), { filename: 'folien.odp', lang: 'de' });
    assert.equal(r.markdown, [
      '# Quartalsrückblick Gartenverein', '',
      '## Willkommen', '',
      '- Neue **Beete** angelegt',
      '- Kompost erweitert',
      '  - zweiter Behälter', '',
      '*Notizen:*', '',
      '> Kurz die Helfer erwähnen.', '',
      '## Ausblick', '',
      'Im Frühjahr pflanzen wir Kräuter.', '',
      'Mehr unter [example.org](https://example.org/garten).', '',
      '## Folie 3', '',
      'Folie ohne Titel.', '',
    ].join('\n'));
    assert.equal(r.metadata.author, 'Max Muster');
    assert.equal(r.metadata.publishedTime, '2026-03-14T10:00:00.000Z');
  });

  it('uses English labels for lang=en', async () => {
    const r = await extractOpenDocument(fixture('folien.odp'), { filename: 'folien.odp', lang: 'en' });
    assert.ok(r.markdown.includes('*Notes:*\n\n> Kurz'));
    assert.ok(r.markdown.includes('## Slide 3\n'));
  });
});

// ---------------------------------------------------------------- errors

describe('OpenDocument errors', () => {
  it('rejects garbage bytes as not_opendocument', async () => {
    await assert.rejects(() => extractOpenDocument(Buffer.from('not a zip at all'.repeat(20))), is422('not_opendocument'));
    await assert.rejects(() => extractOpenDocument(Buffer.alloc(0)), is422('not_opendocument'));
  });

  it('rejects a zip without content.xml', async () => {
    const buf = makeZip([{ name: 'mimetype', data: 'application/epub+zip' }, { name: 'x.txt', data: 'hi' }]);
    await assert.rejects(() => extractOpenDocument(buf, { filename: 'x.odt' }), is422('not_opendocument'));
  });

  it('rejects a password-protected document', async () => {
    const manifest = '<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0"><manifest:file-entry manifest:full-path="content.xml"><manifest:encryption-data manifest:checksum-type="SHA1/1K"/></manifest:file-entry></manifest:manifest>';
    const buf = makeZip([
      { name: 'mimetype', data: 'application/vnd.oasis.opendocument.text' },
      { name: 'content.xml', data: Buffer.from([0x13, 0x8f, 0xa2, 0x00, 0xff, 0x41, 0x99]) },
      { name: 'META-INF/manifest.xml', data: manifest, deflate: true },
    ]);
    await assert.rejects(() => extractOpenDocument(buf, { filename: 'geheim.odt' }), (e) => {
      assert.equal(e.status, 422);
      assert.equal(e.code, 'encrypted_document');
      assert.match(e.message, /password-protected.* \/ .*passwortgeschützt/);
      return true;
    });
  });

  it('treats an unreadable content.xml as encrypted', async () => {
    const buf = makeZip([{ name: 'content.xml', data: Buffer.from('\u0001\u0002 binary junk') }]);
    await assert.rejects(() => extractOpenDocument(buf, { filename: 'x.odt' }), is422('encrypted_document'));
  });

  it('budgets nested tables across the whole document', async () => {
    // Each level repeats the one below 100 x 100 times.
    let inner = `<text:p>${'y'.repeat(1024)}</text:p>`;
    for (let d = 0; d < 4; d++) {
      inner = `<table:table><table:table-row table:number-rows-repeated="100"><table:table-cell table:number-columns-repeated="100">${inner}</table:table-cell></table:table-row></table:table>`;
    }
    const t0 = Date.now();
    await assert.rejects(() => extractOpenDocument(odf('text', `<office:text>${inner}</office:text>`), { filename: 'n.odt' }), is422('document_too_large'));
    assert.ok(Date.now() - t0 < 5000, `took ${Date.now() - t0} ms`);
  });

  it('formats a span with a long run of spaces in linear time', async () => {
    const auto = '<office:automatic-styles xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0">'
      + '<style:style style:name="B" style:family="text"><style:text-properties fo:font-weight="bold"/></style:style></office:automatic-styles>';
    const body = `<office:text><text:p>a <text:span text:style-name="B">x${'<text:s text:c="100"/>'.repeat(2000)}y</text:span></text:p></office:text>`;
    const t0 = Date.now();
    const r = await extractOpenDocument(odf('text', body, [], auto), { filename: 's.odt' });
    assert.ok(Date.now() - t0 < 5000, `took ${Date.now() - t0} ms`);
    assert.match(r.markdown, /\*\*x {200000}y\*\*/);
  });

  it('fails cleanly on a zip bomb', async () => {
    const buf = makeZip([
      { name: 'mimetype', data: 'application/vnd.oasis.opendocument.text' },
      { name: 'content.xml', data: Buffer.alloc(80 * 1024 * 1024, 0x20), deflate: true },
    ]);
    assert.ok(buf.length < 200 * 1024);
    await assert.rejects(() => extractOpenDocument(buf, { filename: 'bomb.odt' }), is422('document_too_large'));
  });
});

// ---------------------------------------------------------------- zip reader

describe('lib/zip.js', () => {
  it('lists and reads stored and deflated entries', () => {
    const buf = makeZip([{ name: 'a.txt', data: 'stored' }, { name: 'dir/b.txt', data: 'deflated '.repeat(50), deflate: true }]);
    const entries = readZipEntries(buf);
    assert.deepEqual(entries.map((e) => [e.name, e.method, e.size]), [['a.txt', 0, 6], ['dir/b.txt', 8, 450]]);
    assert.equal(readZipEntry(buf, 'a.txt').toString(), 'stored');
    assert.equal(readZipEntry(buf, 'dir/b.txt', { entries }).toString(), 'deflated '.repeat(50));
    assert.equal(readZipEntry(buf, 'missing'), null);
  });

  it('reads the LibreOffice fixtures', () => {
    const names = readZipEntries(fixture('folien.odp')).map((e) => e.name);
    assert.equal(names[0], 'mimetype');
    assert.ok(names.includes('content.xml'));
  });

  it('caps the inflated size', () => {
    const buf = makeZip([{ name: 'big', data: Buffer.alloc(1024 * 1024), deflate: true }, { name: 'small', data: Buffer.alloc(2048) }]);
    assert.throws(() => readZipEntry(buf, 'big', { maxBytes: 1000 }), (e) => e instanceof ZipError && e.code === 'zip_too_large');
    assert.throws(() => readZipEntry(buf, 'small', { maxBytes: 1000 }), (e) => e instanceof ZipError && e.code === 'zip_too_large');
    assert.equal(readZipEntry(buf, 'big', { maxBytes: 1024 * 1024 }).length, 1024 * 1024);
  });

  it('rejects encrypted entries', () => {
    const buf = makeZip([{ name: 'secret', data: 'xxxx', flags: 1 }]);
    assert.equal(readZipEntries(buf)[0].encrypted, true);
    assert.throws(() => readZipEntry(buf, 'secret'), (e) => e instanceof ZipError && e.code === 'zip_encrypted');
  });

  it('throws ZipError on every truncation of a valid archive', () => {
    const buf = makeZip([{ name: 'a.txt', data: 'hello world '.repeat(20), deflate: true }]);
    for (let len = 0; len < buf.length; len++) {
      const cut = buf.subarray(0, len);
      assert.throws(() => {
        const entries = readZipEntries(cut);
        readZipEntry(cut, 'a.txt', { entries });
      }, ZipError, `length ${len}`);
    }
  });

  it('throws ZipError on corrupted offsets', () => {
    const buf = Buffer.from(makeZip([{ name: 'a.txt', data: 'hello' }]));
    const eocd = buf.length - 22;
    const bad = Buffer.from(buf);
    bad.writeUInt32LE(0xfffffff0, eocd + 16); // central directory offset
    assert.throws(() => readZipEntries(bad), ZipError);
    const bad2 = Buffer.from(buf);
    const cd = bad2.readUInt32LE(eocd + 16);
    bad2.writeUInt32LE(0x7fffffff, cd + 42); // local header offset
    assert.throws(() => readZipEntry(bad2, 'a.txt'), ZipError);
    const bad3 = Buffer.from(buf);
    bad3.writeUInt32LE(0x7fffffff, cd + 20); // compressed size
    assert.throws(() => readZipEntry(bad3, 'a.txt'), ZipError);
  });
});

describe('real LibreOffice output', () => {
  const real = (name) => readFileSync(new URL(`./fixtures/odf/${name}`, import.meta.url));

  it('Writer: title heading is not repeated and level 2 stays "##"', async () => {
    const r = await extractOpenDocument(real('lo-writer.odt'), { filename: 'lo-writer.odt' });
    assert.equal(r.title, 'Quartalsbericht Gartenverein');
    assert.equal(r.metadata.author, 'Erika Beispiel');
    assert.equal((r.markdown.match(/Quartalsbericht Gartenverein/g) || []).length, 1);
    assert.match(r.markdown, /^## Termine$/m);
    assert.match(r.markdown, /\*\*wichtigsten Ereignisse\*\*/);
    assert.match(r.markdown, /\[Vereinsseite\]\(https:\/\/example\.org\/verein\)/);
    assert.match(r.markdown, /^1\. Begrüßung$/m);
    assert.match(r.markdown, /\| B2 \| Schäfer \\\| Sohn \| 8 m² \|/);
  });

  it('Calc: semicolon CSV import becomes one table', async () => {
    const r = await extractOpenDocument(real('lo-calc.ods'), { filename: 'lo-calc.ods' });
    assert.match(r.markdown, /\| Monat \| Kilo \| Notiz \|\n\| --- \| --- \| --- \|\n\| Mai \| 4,5 \| erste Ernte \|\n\| Juni \| 12 \| mit ; Semikolon \|/);
  });
});

describe('span formatting overrides the paragraph', () => {
  it('a span with font-weight normal switches off a bold paragraph', async () => {
    const styles = '<office:automatic-styles>'
      + '<style:style style:name="P2" style:family="paragraph"><style:text-properties fo:font-style="italic" fo:font-weight="bold"/></style:style>'
      + '<style:style style:name="T1" style:family="text"><style:text-properties fo:font-weight="normal"/></style:style>'
      + '<style:style style:name="T3" style:family="text"><style:text-properties fo:font-style="normal" fo:font-weight="normal"/></style:style>'
      + '</office:automatic-styles>';
    const body = '<office:text><text:p text:style-name="P2"><text:span text:style-name="T1">Italic</text:span></text:p>'
      + '<text:p text:style-name="P2">Bold italic</text:p>'
      + '<text:p text:style-name="P2"><text:span text:style-name="T3">Plain</text:span></text:p></office:text>';
    const r = await extractOpenDocument(odf('text', body, [], styles), { filename: 'x.odt' });
    assert.match(r.markdown, /^\*Italic\*$/m);
    assert.match(r.markdown, /^\*\*\*Bold italic\*\*\*$/m);
    assert.match(r.markdown, /^Plain$/m);
  });
});

describe('OpenDocument links', () => {
  const XL = 'xmlns:xlink="http://www.w3.org/1999/xlink"';
  const linkDoc = (href) => odf('text', `<office:text><text:p>Siehe <text:a ${XL} xlink:href="${href}">hier</text:a>.</text:p></office:text>`);

  it('keeps web, mail and relative links, drops the target of an in-document anchor', async () => {
    assert.match((await extractOpenDocument(linkDoc('https://example.com/a'), { filename: 'l.odt' })).markdown, /Siehe \[hier\]\(https:\/\/example\.com\/a\)\./);
    assert.match((await extractOpenDocument(linkDoc('mailto:a@example.com'), { filename: 'l.odt' })).markdown, /\[hier\]\(mailto:a@example\.com\)/);
    assert.match((await extractOpenDocument(linkDoc('../Anhang.odt'), { filename: 'l.odt' })).markdown, /\[hier\]\(\.\.\/Anhang\.odt\)/);
    assert.match((await extractOpenDocument(linkDoc('#Kapitel'), { filename: 'l.odt' })).markdown, /Siehe hier\./);
    assert.doesNotMatch((await extractOpenDocument(linkDoc('#Kapitel'), { filename: 'l.odt' })).markdown, /\]\(|Kapitel/);
  });

  it('drops the target of script, data and file links', async () => {
    for (const href of ['javascript:alert(1)', 'JavaScript:alert(1)', 'java&#10;script:alert(1)', ' javascript:alert(1)', 'data:text/html,x', 'file:///etc/passwd', 'vbscript:x']) {
      const r = await extractOpenDocument(linkDoc(href), { filename: 'l.odt' });
      assert.match(r.markdown, /Siehe hier\./, href);
      assert.doesNotMatch(r.markdown, /\]\(/, href);
    }
  });
});
