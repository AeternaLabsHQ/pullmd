// End-to-end: every new local format reaches its reader through POST
// /api/file (dispatch order in extractFile), without the markitdown sidecar.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createApp } from '../server.js';

const fx = (p) => readFileSync(new URL(`./fixtures/${p}`, import.meta.url));

async function post(body, filename, contentType = 'application/octet-stream') {
  // No markitdown sidecar configured: any of these reaching it would fail.
  const app = createApp({});
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      fetch(`http://localhost:${server.address().port}/api/file?frontmatter=true&lang=en`, {
        method: 'POST',
        headers: { 'Content-Type': contentType, 'X-Filename': encodeURIComponent(filename) },
        body,
      }).then(async (res) => { const text = await res.text(); server.close(); resolve({ status: res.status, source: res.headers.get('x-source'), body: text }); })
        .catch((e) => { server.close(); reject(e); });
    });
  });
}

const ICS = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:1@example.com\r\nSUMMARY:Planning\r\nDTSTART:20261105T130000Z\r\nDTEND:20261105T140000Z\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n';
const VCF = 'BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Alex Example\r\nEMAIL:alex@example.com\r\nEND:VCARD\r\n';
const NB = JSON.stringify({ nbformat: 4, nbformat_minor: 5, metadata: { language_info: { name: 'python' } }, cells: [{ cell_type: 'code', source: 'print(1)', outputs: [], metadata: {} }] });

const CASES = [
  ['bericht.odt', () => fx('odf/lo-writer.odt'), 'opendocument', /## Termine/],
  ['tabelle.ods', () => fx('odf/lo-calc.ods'), 'opendocument', /\| Monat \| Kilo \| Notiz \|/],
  ['folien.odp', () => fx('odf/folien.odp'), 'opendocument', /## Willkommen/],
  ['bericht.rtf', () => fx('rtf/quartalsbericht.rtf'), 'rtf', /Vereinsseite/],
  ['termin.ics', () => Buffer.from(ICS), 'calendar', /# Planning/],
  ['kontakt.vcf', () => Buffer.from(VCF), 'contact', /alex@example\.com/],
  ['analyse.ipynb', () => Buffer.from(NB), 'notebook', /```python\nprint\(1\)/],
  ['daten.csv', () => Buffer.from('a;b\n1;2\n'), 'data', /\| a \| b \|/],
  ['daten.json', () => Buffer.from('{"a":1}'), 'data', /```json/],
  ['skript.py', () => Buffer.from('print("hi")\n'), 'code', /```python/],
  ['CMakeLists.txt', () => Buffer.from('project(x)\n'), 'code', /```cmake/],
  ['server.log', () => Buffer.from('12:00 started\n'), 'code', /12:00 started/],
  ['notes.rst', () => Buffer.from('Title\n=====\n\nBody.\n'), 'text', /Body\./],
];

describe('POST /api/file - formats read by pullmd itself', () => {
  for (const [name, body, source, re] of CASES) {
    it(`${name} -> ${source}`, async () => {
      const res = await post(body(), name);
      assert.equal(res.status, 200, res.body);
      assert.equal(res.source, source);
      assert.match(res.body, re);
      assert.match(res.body, /^---\n/);
    });
  }

  it('a broken OpenDocument file answers 422, not 502', async () => {
    const res = await post(Buffer.from('not a zip at all'), 'kaputt.odt');
    assert.equal(res.status, 422);
  });

  it('.env is not treated as code', async () => {
    const res = await post(Buffer.from('SECRET=1\n'), '.env');
    assert.notEqual(res.source, 'code');
  });
});
