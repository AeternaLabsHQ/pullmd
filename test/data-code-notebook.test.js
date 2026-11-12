import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { dataFileKind, extractDataFile, fence, parseDelimited } from '../lib/datafile.js';
import { isNotebookFile, extractNotebook } from '../lib/notebook.js';
import { codeLanguage, extractCodeFile } from '../lib/codefile.js';
import { plainTextKind } from '../lib/plaintext.js';
import { htmlFragmentToMarkdown } from '../lib/web.js';

// Dates are rendered in the server's zone (TZ, default Europe/Berlin).
before(() => { process.env.TZ = 'Europe/Berlin'; });

const fakeHtml = (h) => h.replace(/<[^>]+>/g, '');
const csv = (text, filename = 'liste.csv') => extractDataFile(Buffer.from(text), { filename });
const tableOf = (md) => md.split('\n').filter((l) => l.startsWith('|'));

// ---------------------------------------------------------------- fence

describe('fence', () => {
  it('uses three backticks by default and grows past backtick runs inside', () => {
    assert.equal(fence('a = 1', 'python'), '```python\na = 1\n```');
    assert.equal(fence('x\n```js\ny\n```\n'), '````\nx\n```js\ny\n```\n````');
    assert.equal(fence('a `````` b'), '```````\na `````` b\n```````');
  });
});

// ---------------------------------------------------------------- detection

describe('dataFileKind', () => {
  it('detects by extension', () => {
    assert.equal(dataFileKind('', 'a.CSV'), 'csv');
    assert.equal(dataFileKind('', 'a.tsv'), 'tsv');
    assert.equal(dataFileKind('', 'a.tab'), 'tsv');
    for (const e of ['json', 'jsonl', 'ndjson', 'geojson']) assert.equal(dataFileKind('', `a.${e}`), 'json');
    for (const e of ['xml', 'rss', 'atom']) assert.equal(dataFileKind('', `a.${e}`), 'xml');
    assert.equal(dataFileKind('', 'a.svg'), null);
    assert.equal(dataFileKind('', 'a.opml'), null);
  });

  it('uses the content type only when the name has no extension', () => {
    assert.equal(dataFileKind('text/csv; charset=utf-8', 'export'), 'csv');
    assert.equal(dataFileKind('application/rss+xml', ''), 'xml');
    assert.equal(dataFileKind('application/ld+json', 'data'), 'json');
    assert.equal(dataFileKind('application/json', 'notes.txt'), null);
    assert.equal(dataFileKind('text/plain', 'export'), null);
  });
});

// ---------------------------------------------------------------- CSV / TSV

describe('CSV and TSV', () => {
  it('renders a comma-separated file as a table titled after the file', async () => {
    const r = await csv('Name,Stadt\nAnna,Berlin\nBen,Hamburg\n', 'Kunden.csv');
    assert.equal(r.source, 'data');
    assert.equal(r.title, 'Kunden');
    assert.equal(r.metadata.sourceUrl, null);
    assert.equal(r.markdown, '# Kunden\n\n| Name | Stadt |\n| --- | --- |\n| Anna | Berlin |\n| Ben | Hamburg |\n');
  });

  it('sniffs the semicolon of German Excel exports, commas stay inside cells', async () => {
    const r = await csv('Artikel;Preis;Menge\nApfel;1,20;3\nBirne;0,90;5\n');
    assert.deepEqual(tableOf(r.markdown), [
      '| Artikel | Preis | Menge |', '| --- | --- | --- |', '| Apfel | 1,20 | 3 |', '| Birne | 0,90 | 5 |',
    ]);
  });

  it('handles quoted fields with delimiters, "" escapes and line breaks (CRLF)', async () => {
    const r = await csv('id,text\r\n1,"Hallo, Welt"\r\n2,"sagt ""hi"""\r\n3,"zwei\r\nZeilen"\r\n');
    assert.deepEqual(tableOf(r.markdown).slice(2), [
      '| 1 | Hallo, Welt |', '| 2 | sagt "hi" |', '| 3 | zwei<br>Zeilen |',
    ]);
  });

  it('honors and drops an Excel "sep=" line', async () => {
    const r = await csv('sep=|\na|b\n1|2\n');
    assert.deepEqual(tableOf(r.markdown), ['| a | b |', '| --- | --- |', '| 1 | 2 |']);
    assert.ok(!r.markdown.includes('sep='));
  });

  it('escapes pipes inside cells', async () => {
    const r = await csv('Ausdruck,Wert\n"a|b",1\n');
    assert.equal(tableOf(r.markdown)[2], '| a\\|b | 1 |');
  });

  it('strips the UTF-8 BOM of Excel exports', async () => {
    const r = await extractDataFile(
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('Spalte;Größe\nx;1\n')]),
      { filename: 'excel.csv' },
    );
    assert.equal(tableOf(r.markdown)[0], '| Spalte | Größe |');
  });

  it('decodes windows-1252 umlauts', async () => {
    // "Straße;Ort\nHauptstr.;Köln\n" in windows-1252
    const bytes = Buffer.from([
      ...Buffer.from('Stra'), 0xdf, ...Buffer.from('e;Ort\nHauptstr.;K'), 0xf6, ...Buffer.from('ln\n'),
    ]);
    const r = await extractDataFile(bytes, { filename: 'alt.csv' });
    assert.deepEqual(tableOf(r.markdown), ['| Straße | Ort |', '| --- | --- |', '| Hauptstr. | Köln |']);
  });

  it('pads short rows, widens for long rows, keeps empty headers and drops empty trailing rows', async () => {
    const r = await csv('a,,c\n1\n1,2,3,4\n,,\n\n');
    assert.deepEqual(tableOf(r.markdown), [
      '| a |  | c |  |', '| --- | --- | --- | --- |', '| 1 |  |  |  |', '| 1 | 2 | 3 | 4 |',
    ]);
  });

  it('a single column is still a table, a header alone too', async () => {
    assert.deepEqual(tableOf((await csv('Wort\neins\nzwei\n')).markdown), ['| Wort |', '| --- |', '| eins |', '| zwei |']);
    assert.deepEqual(tableOf((await csv('a,b\n')).markdown), ['| a | b |', '| --- | --- |']);
  });

  it('reads TSV with tabs even when cells contain commas and semicolons', async () => {
    const r = await extractDataFile(Buffer.from('Name\tNotiz\nAnna\ta, b; c\n'), { filename: 'daten.tsv', kind: 'tsv' });
    assert.deepEqual(tableOf(r.markdown), ['| Name | Notiz |', '| --- | --- |', '| Anna | a, b; c |']);
  });

  it('rejects empty and binary files with 422', async () => {
    await assert.rejects(csv('  \n\n'), (e) => e.status === 422 && e.code === 'empty_file');
    await assert.rejects(extractDataFile(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00]), { filename: 'x.csv' }),
      (e) => e.status === 422 && e.code === 'not_text');
  });

  it('parseDelimited keeps a literal quote that does not start a field', () => {
    assert.deepEqual(parseDelimited('a,5" Rohr\n', ','), [['a', '5" Rohr']]);
  });
});

// ---------------------------------------------------------------- JSON

describe('JSON', () => {
  it('pretty-prints single-line JSON with two spaces and keeps big numbers exact', async () => {
    const r = await extractDataFile(Buffer.from('{"id":12345678901234567890,"tags":["a","b"],"leer":{}}'), { filename: 'daten.json' });
    assert.equal(r.source, 'data');
    assert.equal(r.title, 'daten');
    assert.equal(r.markdown,
      '# daten\n\n```json\n{\n  "id": 12345678901234567890,\n  "tags": [\n    "a",\n    "b"\n  ],\n  "leer": {}\n}\n```\n');
  });

  it('keeps already formatted JSON as it is', async () => {
    const text = '{\n    "a": 1,\n    "b": [1, 2]\n}';
    const r = await extractDataFile(Buffer.from(text + '\n'), { filename: 'x.json' });
    assert.ok(r.markdown.includes('```json\n' + text + '\n```'));
  });

  it('takes the title from a top-level title or name property', async () => {
    assert.equal((await extractDataFile(Buffer.from('{"title":"Mein Projekt","name":"x"}'), { filename: 'p.json' })).title, 'Mein Projekt');
    assert.equal((await extractDataFile(Buffer.from('{"name":"paket"}'), { filename: 'package.json' })).title, 'paket');
    assert.equal((await extractDataFile(Buffer.from('[{"title":"x"}]'), { filename: 'liste.json' })).title, 'liste');
  });

  it('does not fail on invalid JSON, the raw text goes into the block', async () => {
    const r = await extractDataFile(Buffer.from('{"a": 1,, oops'), { filename: 'kaputt.json' });
    assert.equal(r.markdown, '# kaputt\n\n```json\n{"a": 1,, oops\n```\n');
  });

  it('keeps JSON Lines line by line', async () => {
    const r = await extractDataFile(Buffer.from('{"n":1}\n{"n":2}\n'), { filename: 'log.jsonl' });
    assert.equal(r.markdown, '# log\n\n```json\n{"n":1}\n{"n":2}\n```\n');
  });

  it('grows the fence when a string contains backticks', async () => {
    const r = await extractDataFile(Buffer.from('{\n  "md": "```js\\nx\\n```"\n}'), { filename: 'f.json' });
    assert.ok(r.markdown.includes('````json\n'));
  });
});

// ---------------------------------------------------------------- XML / feeds

const RSS = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:content="http://purl.org/rss/1.0/modules/content/">
<channel>
  <title>Beispiel &amp; Blog</title>
  <link>https://blog.example/</link>
  <description>Notizen aus der Werkstatt</description>
  <item>
    <title>Erster Eintrag</title>
    <link>https://blog.example/eins</link>
    <pubDate>Mon, 02 Nov 2026 09:30:00 GMT</pubDate>
    <dc:creator>Alex</dc:creator>
    <description>Kurzfassung</description>
    <content:encoded><![CDATA[<p>Hallo <b>Welt</b> &amp; mehr</p>]]></content:encoded>
  </item>
  <item>
    <title>Zweiter [Teil]</title>
    <link>https://blog.example/zwei</link>
    <description>&lt;p&gt;Siehe &lt;a href="https://docs.example/"&gt;Doku&lt;/a&gt;&lt;/p&gt;</description>
  </item>
</channel>
</rss>`;

const ATOM = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Projekt-Neuigkeiten</title>
  <subtitle>Was sich getan hat</subtitle>
  <link href="https://news.example/feed.atom" rel="self"/>
  <link href="https://news.example/"/>
  <author><name>Team Beispiel</name></author>
  <updated>2026-11-01T12:00:00Z</updated>
  <entry>
    <title type="html">Version &lt;b&gt;2&lt;/b&gt;</title>
    <link rel="alternate" href="https://news.example/v2"/>
    <published>2026-11-01T08:00:00Z</published>
    <content type="html"><![CDATA[<ul><li>schneller</li><li>kleiner</li></ul>]]></content>
  </entry>
  <entry>
    <title>Ohne Link</title>
    <updated>2026-10-01T08:00:00Z</updated>
    <content type="xhtml"><div xmlns="http://www.w3.org/1999/xhtml"><p>XHTML <em>Inhalt</em></p></div></content>
  </entry>
  <entry>
    <title>Nur Text</title>
    <summary type="text">a &lt; b</summary>
  </entry>
</feed>`;

describe('feeds', () => {
  it('renders RSS 2.0 with CDATA and escaped HTML (real htmlFragmentToMarkdown)', async () => {
    const r = await extractDataFile(Buffer.from(RSS), { filename: 'feed.xml', htmlFragmentToMarkdown, lang: 'en' });
    assert.equal(r.source, 'feed');
    assert.equal(r.title, 'Beispiel & Blog');
    assert.equal(r.metadata.sourceUrl, 'https://blog.example/');
    assert.ok(r.markdown.startsWith('# Beispiel & Blog\n\nNotizen aus der Werkstatt\n\n## [Erster Eintrag](https://blog.example/eins)\n\n*'));
    assert.match(r.markdown, /\*2 November 2026[^*]* · Alex\*/);
    // content:encoded wins over the short description
    assert.ok(r.markdown.includes('Hallo **Welt** & mehr'));
    assert.ok(!r.markdown.includes('Kurzfassung'));
    assert.ok(r.markdown.includes('## [Zweiter \\[Teil\\]](https://blog.example/zwei)'));
    assert.ok(r.markdown.includes('Siehe [Doku](https://docs.example/)'));
    assert.ok(!r.markdown.includes('<p>'));
  });

  it('renders Atom: alternate link, html/xhtml/text content, feed author', async () => {
    const r = await extractDataFile(Buffer.from(ATOM), { filename: 'news.atom', htmlFragmentToMarkdown: fakeHtml, lang: 'de' });
    assert.equal(r.source, 'feed');
    assert.equal(r.title, 'Projekt-Neuigkeiten');
    assert.equal(r.metadata.sourceUrl, 'https://news.example/');
    assert.equal(r.metadata.author, 'Team Beispiel');
    assert.ok(r.markdown.includes('Was sich getan hat'));
    assert.ok(r.markdown.includes('## [Version 2](https://news.example/v2)'));
    assert.match(r.markdown, /\*1\. November 2026/);
    assert.ok(r.markdown.includes('schneller'));
    assert.ok(r.markdown.includes('## Ohne Link\n'));
    assert.ok(r.markdown.includes('XHTML Inhalt'));
    assert.ok(r.markdown.includes('a < b'));
  });

  it('falls back to stripping tags without a converter', async () => {
    const r = await extractDataFile(Buffer.from(RSS), { filename: 'feed.rss' });
    assert.ok(r.markdown.includes('Hallo Welt & mehr'));
  });

  it('renders RSS 1.0 (RDF) items that sit next to the channel', async () => {
    const rdf = `<?xml version="1.0"?>
<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns="http://purl.org/rss/1.0/" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel rdf:about="https://rdf.example/"><title>RDF-Kanal</title><link>https://rdf.example/</link><description>d</description></channel>
  <item rdf:about="https://rdf.example/a"><title>Artikel A</title><link>https://rdf.example/a</link><dc:date>2026-09-01T10:00:00Z</dc:date></item>
</rdf:RDF>`;
    const r = await extractDataFile(Buffer.from(rdf), { filename: 'rdf.xml', htmlFragmentToMarkdown: fakeHtml });
    assert.equal(r.source, 'feed');
    assert.equal(r.title, 'RDF-Kanal');
    assert.ok(r.markdown.includes('## [Artikel A](https://rdf.example/a)'));
  });

  it('passes other XML through as a code block', async () => {
    const xml = '<?xml version="1.0"?>\n<config>\n  <wert name="a">1</wert>\n</config>\n';
    const r = await extractDataFile(Buffer.from(xml), { filename: 'einstellungen.xml' });
    assert.equal(r.source, 'data');
    assert.equal(r.title, 'einstellungen');
    assert.equal(r.markdown, '# einstellungen\n\n```xml\n' + xml.trimEnd() + '\n```\n');
  });
});

// ---------------------------------------------------------------- notebooks

function notebook(cells, metadata = {}) {
  return Buffer.from(JSON.stringify({
    nbformat: 4,
    nbformat_minor: 5,
    metadata: { kernelspec: { language: 'python', name: 'python3' }, ...metadata },
    cells,
  }));
}

describe('Jupyter notebooks', () => {
  it('detects .ipynb and the content type without extension', () => {
    assert.equal(isNotebookFile('application/octet-stream', 'Analyse.IPYNB'), true);
    assert.equal(isNotebookFile('application/x-ipynb+json', 'upload'), true);
    assert.equal(isNotebookFile('application/x-ipynb+json', 'a.json'), false);
    assert.equal(isNotebookFile('application/json', 'a.json'), false);
  });

  it('renders markdown, code and outputs; title from the first H1 without duplicating it', async () => {
    const buf = notebook([
      { cell_type: 'markdown', metadata: {}, source: ['# Auswertung\n', '\n', 'Ein kurzer Text.'] },
      {
        cell_type: 'code', metadata: {}, execution_count: 1, source: 'print("hallo")\n1 + 1',
        outputs: [
          { output_type: 'stream', name: 'stdout', text: ['hallo\n'] },
          { output_type: 'execute_result', execution_count: 1, metadata: {}, data: { 'text/plain': ['2'] } },
        ],
      },
      {
        cell_type: 'code', metadata: {}, source: ['df'],
        outputs: [{ output_type: 'display_data', metadata: {}, data: { 'text/markdown': '| a |\n|---|\n| 1 |', 'text/plain': 'a\n1' } }],
      },
      {
        cell_type: 'code', metadata: {}, source: 'plot()',
        outputs: [{ output_type: 'display_data', metadata: {}, data: { 'image/png': 'iVBORw0KGgo=', 'text/plain': '<Figure size 640x480>' } }],
      },
      {
        cell_type: 'code', metadata: {}, source: '1/0',
        outputs: [{
          output_type: 'error', ename: 'ZeroDivisionError', evalue: 'division by zero',
          traceback: ['\u001b[0;31mZeroDivisionError\u001b[0m Traceback', '\u001b[1;32m----> 1\u001b[0m 1/0'],
        }],
      },
      { cell_type: 'raw', metadata: {}, source: 'roher Text' },
    ], { authors: [{ name: 'Kim Beispiel' }] });

    const r = await extractNotebook(buf, { filename: 'auswertung.ipynb', lang: 'en' });
    assert.equal(r.source, 'notebook');
    assert.equal(r.title, 'Auswertung');
    assert.equal(r.metadata.author, 'Kim Beispiel');
    assert.equal(r.metadata.sourceUrl, null);
    assert.equal(r.markdown, [
      '# Auswertung',
      'Ein kurzer Text.',
      '```python\nprint("hallo")\n1 + 1\n```',
      '```text\nhallo\n```',
      '```text\n2\n```',
      '```python\ndf\n```',
      '| a |\n|---|\n| 1 |',
      '```python\nplot()\n```',
      '*[image output]*',
      '```python\n1/0\n```',
      '```text\nZeroDivisionError: division by zero\nZeroDivisionError Traceback\n----> 1 1/0\n```',
      '```\nroher Text\n```',
    ].join('\n\n') + '\n');
    assert.ok(!r.markdown.includes('\u001b'));
  });

  it('localizes the image placeholder and uses language_info and metadata.title', async () => {
    const buf = notebook([
      { cell_type: 'markdown', metadata: {}, source: '# Kapitel' },
      { cell_type: 'code', metadata: {}, source: 'x <- 1', outputs: [{ output_type: 'display_data', data: { 'image/jpeg': '...' } }] },
    ], { title: 'Notebook-Titel', language_info: { name: 'R' } });
    const r = await extractNotebook(buf, { filename: 'n.ipynb', lang: 'de' });
    assert.equal(r.title, 'Notebook-Titel');
    assert.ok(r.markdown.startsWith('# Notebook-Titel\n\n# Kapitel\n\n```r\nx <- 1\n```\n\n*[Bildausgabe]*\n'));
  });

  it('falls back to the filename stem', async () => {
    const r = await extractNotebook(notebook([{ cell_type: 'code', metadata: {}, source: 'pass', outputs: [] }]), { filename: 'skript.ipynb' });
    assert.equal(r.title, 'skript');
    assert.equal(r.markdown, '# skript\n\n```python\npass\n```\n');
  });

  it('rejects nbformat 3, non-JSON and cell-less files with 422', async () => {
    const v3 = Buffer.from(JSON.stringify({ nbformat: 3, metadata: {}, worksheets: [{ cells: [] }] }));
    await assert.rejects(extractNotebook(v3, { filename: 'alt.ipynb' }), (e) => e.status === 422 && e.code === 'not_notebook');
    await assert.rejects(extractNotebook(Buffer.from('kein json'), {}), (e) => e.status === 422 && e.code === 'not_notebook');
    await assert.rejects(extractNotebook(Buffer.from('{"nbformat":4}'), {}), (e) => e.status === 422 && e.code === 'not_notebook');
  });
});

// ---------------------------------------------------------------- code files

describe('code files', () => {
  it('maps extensions and well-known names, leaves .env alone', () => {
    assert.equal(codeLanguage('', 'main.py'), 'python');
    assert.equal(codeLanguage('', 'App.TSX'), 'tsx');
    assert.equal(codeLanguage('', 'Dockerfile'), 'dockerfile');
    assert.equal(codeLanguage('', 'Dockerfile.prod'), 'dockerfile');
    assert.equal(codeLanguage('', 'Makefile'), 'makefile');
    assert.equal(codeLanguage('', 'Jenkinsfile'), 'groovy');
    assert.equal(codeLanguage('', 'CMakeLists.txt'), 'cmake');
    assert.equal(codeLanguage('', 'server.log'), '');
    assert.equal(codeLanguage('text/plain', '.env'), null);
    assert.equal(codeLanguage('text/plain', 'config.env'), null);
    assert.equal(codeLanguage('', 'notes.txt'), null);
    assert.equal(codeLanguage('', 'bild.png'), null);
    assert.equal(codeLanguage('text/x-python', 'skript'), 'python');
    assert.equal(codeLanguage('text/x-python', 'skript.txt'), null);
  });

  it('renders a Python file under its full filename', async () => {
    const r = await extractCodeFile(Buffer.from('def f():\r\n    return 1   \r\n\r\n  \r\n'), { filename: 'werkzeug.py' });
    assert.equal(r.source, 'code');
    assert.equal(r.title, 'werkzeug.py');
    assert.equal(r.metadata.sourceUrl, null);
    // CRLF -> LF, trailing blank lines go, trailing spaces of the last line stay
    assert.equal(r.markdown, '# werkzeug.py\n\n```python\ndef f():\n    return 1   \n```\n');
  });

  it('escapes emphasis characters in the heading only', async () => {
    const r = await extractCodeFile(Buffer.from('x = 1\n'), { filename: '__init__.py' });
    assert.equal(r.title, '__init__.py');
    assert.ok(r.markdown.startsWith('# \\_\\_init\\_\\_.py\n\n```python\n'));
  });

  it('renders a Dockerfile', async () => {
    const r = await extractCodeFile(Buffer.from('FROM node:22\nRUN npm ci\n'), { filename: 'Dockerfile', language: codeLanguage('', 'Dockerfile') });
    assert.equal(r.markdown, '# Dockerfile\n\n```dockerfile\nFROM node:22\nRUN npm ci\n```\n');
  });

  it('grows the fence past backticks in the file', async () => {
    const r = await extractCodeFile(Buffer.from('const s = `\n```\n`;\n'), { filename: 'vorlage.js' });
    assert.equal(r.markdown, '# vorlage.js\n\n````javascript\nconst s = `\n```\n`;\n````\n');
  });

  it('a log file gets a plain fence', async () => {
    const r = await extractCodeFile(Buffer.from('12:00 start\n12:01 ende\n'), { filename: 'app.log', language: '' });
    assert.equal(r.markdown, '# app.log\n\n```\n12:00 start\n12:01 ende\n```\n');
  });

  it('.ts: TypeScript text works, MPEG-TS video is rejected', async () => {
    const r = await extractCodeFile(Buffer.from('export const n: number = 1;\n'), { filename: 'index.ts' });
    assert.ok(r.markdown.includes('```typescript\nexport const n: number = 1;\n```'));

    const video = Buffer.alloc(188 * 3, 0xff);
    for (let i = 0; i < 3; i++) { video[i * 188] = 0x47; video[i * 188 + 1] = 0x40; video[i * 188 + 2] = 0x00; video[i * 188 + 3] = 0x10; }
    await assert.rejects(extractCodeFile(video, { filename: 'clip.ts' }), (e) => e.status === 422 && e.code === 'not_text');
    const nul = Buffer.from([0x00, 0x01, 0x02, 0x41, 0x42]);
    await assert.rejects(extractCodeFile(nul, { filename: 'x.ts' }), (e) => e.status === 422 && e.code === 'not_text');
  });

  it('rejects empty files', async () => {
    await assert.rejects(extractCodeFile(Buffer.from('\n  \n'), { filename: 'leer.py' }), (e) => e.status === 422 && e.code === 'empty_file');
  });
});

// ---------------------------------------------------------------- plain text kinds

describe('plainTextKind prose markup', () => {
  it('treats prose markup as plain text, HTML still not', () => {
    for (const ext of ['rst', 'adoc', 'asciidoc', 'org', 'textile', 'wiki', 'nfo']) {
      assert.equal(plainTextKind('application/octet-stream', `README.${ext}`), 'text', ext);
    }
    assert.equal(plainTextKind('text/plain', 'seite.html'), null);
    assert.equal(plainTextKind('', 'notes.md'), 'markdown');
  });
});

describe('hostile data, code and notebook input', () => {
  const timed = async (fn) => {
    const t0 = Date.now();
    const out = await fn();
    const ms = Date.now() - t0;
    assert.ok(ms < 5000, `took ${ms} ms`);
    return out;
  };

  it('drops many trailing blank lines from code in linear time', async () => {
    const r = await timed(() => extractCodeFile(Buffer.from(`a${'\n'.repeat(200000)}x`), { filename: 'a.py' }));
    assert.ok(r.markdown.includes(`a${'\n'.repeat(200000)}x\n\`\`\``));
    const r2 = await timed(() => extractCodeFile(Buffer.from(`a  \n \t\n\n`), { filename: 'b.py' }));
    assert.equal(r2.markdown, '# b.py\n\n```python\na  \n```\n');
    const r3 = await timed(() => extractCodeFile(Buffer.from(`a\n${' '.repeat(200000)}x\n\n`), { filename: 'c.py' }));
    assert.ok(r3.markdown.includes(`${' '.repeat(200000)}x\n\`\`\``));
  });

  it('builds a table from 150000 rows without overflowing the stack', async () => {
    const r = await timed(() => csv('a,b\n' + '1,2\n'.repeat(150000)));
    assert.equal(tableOf(r.markdown).length, 150000 + 2);
  });

  it('refuses a table that would be mostly padding', async () => {
    await assert.rejects(
      () => csv(','.repeat(200000) + '\n' + 'a\n'.repeat(200000)),
      (e) => e.status === 422 && e.code === 'document_too_large',
    );
  });

  it('keeps deeply nested JSON as it is instead of re-indenting it', async () => {
    const deep = '['.repeat(5000) + ']'.repeat(5000);
    const r = await timed(() => extractDataFile(Buffer.from(deep), { filename: 'tief.json' }));
    assert.equal(r.markdown, `# tief\n\n\`\`\`json\n${deep}\n\`\`\`\n`);
    const ok = '['.repeat(64) + '1' + ']'.repeat(64);
    const r2 = await extractDataFile(Buffer.from(ok), { filename: 'ok.json' });
    assert.ok(r2.markdown.includes(`\n${'  '.repeat(64)}1\n`));
  });

  it('strips hostile feed HTML in linear time', async () => {
    const rss = `<rss><channel><title>${'&lt;script&gt;'.repeat(50000)}T</title><item><title>${'&lt;a'.repeat(50000)}</title><description>${' '.repeat(100000)}x</description></item></channel></rss>`;
    const r = await timed(() => extractDataFile(Buffer.from(rss), { filename: 'a.rss' }));
    assert.match(r.markdown, /^# /);
  });

  it('trims trailing whitespace of XML in linear time', async () => {
    const r = await timed(() => extractDataFile(Buffer.from(`<a/>${' '.repeat(200000)}x  \n\n`), { filename: 'a.xml' }));
    assert.ok(r.markdown.endsWith(`${' '.repeat(200000)}x\n\`\`\`\n`));
  });

  it('reads notebook headings and code with long blank runs in linear time', async () => {
    const nb = notebook([
      { cell_type: 'markdown', source: `# a${' '.repeat(100000)}b ##` },
      { cell_type: 'code', source: `x${' '.repeat(100000)}y  \n`, outputs: [{ output_type: 'stream', name: 'stdout', text: `o${' '.repeat(100000)}p\n` }] },
    ]);
    const r = await timed(() => extractNotebook(nb, { filename: 'n.ipynb' }));
    assert.equal(r.title, `a${' '.repeat(100000)}b`);
    assert.ok(r.markdown.includes(`x${' '.repeat(100000)}y\n\`\`\``));
  });
});
