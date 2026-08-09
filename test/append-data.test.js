import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseJsonScript, resolveSegments, projectRows, renderAppendBlocks } from '../lib/append-data.js';
import * as cheerio from 'cheerio';

const wrap = (json, id = 'ng-state') =>
  `<html><head><script id="${id}" type="application/json">${json}</script></head><body></body></html>`;

// Mirrors the real wetteronline blob: keys carry dots, slashes and query strings.
const BLOB = {
  'p_city_local/forecast': {
    longTerm: [
      { date: '2026-08-08', airTemperature: { max: { celsius: 26 }, min: { celsius: 11 } }, wind: { force: '2-3' } },
      { date: '2026-08-09', airTemperature: { max: { celsius: 34 }, min: { celsius: 12 } }, wind: { force: '3' } },
    ],
  },
  'https://api.example.com/v1?c=abc&release_version=XYZ': { days: [{ n: 1 }, { n: 2 }] },
};

describe('parseJsonScript', () => {
  it('parses the first matching script element', () => {
    const $ = cheerio.load(wrap(JSON.stringify(BLOB)));
    const parsed = parseJsonScript($, '#ng-state');
    assert.equal(parsed['p_city_local/forecast'].longTerm.length, 2);
  });

  it('returns null for a selector that matches nothing', () => {
    const $ = cheerio.load(wrap(JSON.stringify(BLOB)));
    assert.equal(parseJsonScript($, '#nope'), null);
  });

  it('returns null for malformed JSON instead of throwing', () => {
    const $ = cheerio.load(wrap('{ this is not json'));
    assert.equal(parseJsonScript($, '#ng-state'), null);
  });
});

describe('resolveSegments', () => {
  it('resolves a key that contains dots, slashes and a query string', () => {
    const v = resolveSegments(BLOB, ['https://api.example.com/v1?c=abc&release_version=XYZ', 'days']);
    assert.deepEqual(v, [{ n: 1 }, { n: 2 }]);
  });

  it('resolves a key containing a slash', () => {
    const v = resolveSegments(BLOB, ['p_city_local/forecast', 'longTerm']);
    assert.equal(v.length, 2);
  });

  it('indexes arrays with integer segments', () => {
    assert.deepEqual(resolveSegments(BLOB, ['p_city_local/forecast', 'longTerm', 0, 'date']), '2026-08-08');
  });

  it('does NOT collapse arrays the way resolvePath does', () => {
    const v = resolveSegments(BLOB, ['p_city_local/forecast', 'longTerm']);
    assert.ok(Array.isArray(v), 'the array itself must survive, not its first element');
  });

  it('returns undefined for a path that runs into nothing', () => {
    assert.equal(resolveSegments(BLOB, ['p_city_local/forecast', 'nope']), undefined);
    assert.equal(resolveSegments(BLOB, ['p_city_local/forecast', 'longTerm', 99]), undefined);
    assert.equal(resolveSegments(null, ['a']), undefined);
  });
});

describe('projectRows', () => {
  const rows = BLOB['p_city_local/forecast'].longTerm;
  const fields = {
    datum: ['date'],
    max_c: ['airTemperature', 'max', 'celsius'],
    wind: ['wind', 'force'],
  };

  it('projects and renames in field order', () => {
    const out = projectRows(rows, fields, 200);
    assert.deepEqual(out[0], { datum: '2026-08-08', max_c: 26, wind: '2-3' });
    assert.deepEqual(Object.keys(out[0]), ['datum', 'max_c', 'wind']);
  });

  it('omits the key when a field does not resolve, instead of writing null', () => {
    const out = projectRows([{ date: 'x' }], fields, 200);
    assert.deepEqual(out[0], { datum: 'x' });
    assert.ok(!('max_c' in out[0]));
  });

  it('normalizes a single object into a one-row list', () => {
    const out = projectRows({ date: 'solo' }, { datum: ['date'] }, 200);
    assert.deepEqual(out, [{ datum: 'solo' }]);
  });

  it('skips non-object rows when fields are set', () => {
    const out = projectRows(['a', 42, { date: 'keep' }], { datum: ['date'] }, 200);
    assert.deepEqual(out, [{ datum: 'keep' }]);
  });

  it('applies limit', () => {
    assert.equal(projectRows(rows, fields, 1).length, 1);
  });

  it('passes the subtree through unchanged when fields are absent', () => {
    const out = projectRows(rows, undefined, 200);
    assert.deepEqual(out, rows);
  });

  it('applies limit to an array even without fields', () => {
    assert.equal(projectRows(rows, undefined, 1).length, 1);
  });
});

const SPEC = {
  title: '16-Tage-Trend',
  script: '#ng-state',
  path: ['p_city_local/forecast', 'longTerm'],
  fields: { datum: ['date'], max_c: ['airTemperature', 'max', 'celsius'] },
  limit: 200,
};

describe('renderAppendBlocks', () => {
  it('renders a heading and a fenced json block with one row per line', () => {
    const { markdown, notes } = renderAppendBlocks(wrap(JSON.stringify(BLOB)), [SPEC]);
    assert.match(markdown, /\n## 16-Tage-Trend\n/);
    assert.match(markdown, /```json\n\[\n/);
    assert.match(markdown, /\n\]\n```/);
    assert.ok(markdown.includes('{"datum":"2026-08-08","max_c":26}'));
    assert.deepEqual(notes, ['16-Tage-Trend (2 Zeilen)']);
  });

  it('produces valid JSON inside the fence', () => {
    const { markdown } = renderAppendBlocks(wrap(JSON.stringify(BLOB)), [SPEC]);
    const body = markdown.split('```json\n')[1].split('\n```')[0];
    assert.equal(JSON.parse(body).length, 2);
  });

  it('returns empty markdown for every failure mode without throwing', () => {
    const ok = JSON.stringify(BLOB);
    const cases = [
      [wrap(ok), [{ ...SPEC, script: '#nope' }]],
      [wrap('{ broken'), [SPEC]],
      [wrap(ok), [{ ...SPEC, path: ['p_city_local/forecast', 'nope'] }]],
      [wrap(JSON.stringify({ 'p_city_local/forecast': { longTerm: 'a string' } })), [SPEC]],
      [wrap(ok), []],
    ];
    for (const [html, specs] of cases) {
      const { markdown, notes } = renderAppendBlocks(html, specs);
      assert.equal(markdown, '');
      assert.deepEqual(notes, []);
    }
  });

  it('parses the same script only once across several blocks', () => {
    const original = JSON.parse;
    let calls = 0;
    JSON.parse = (...args) => { calls++; return original(...args); };
    try {
      renderAppendBlocks(wrap(JSON.stringify(BLOB)), [SPEC, { ...SPEC, title: 'Zweiter' }]);
    } finally {
      JSON.parse = original;
    }
    assert.equal(calls, 1, 'the blob must be parsed once, not once per block');
  });

  it('truncates at the per-block byte cap and says so beside the fence', () => {
    const many = Array.from({ length: 4000 }, (_, i) => ({
      date: `d${i}`, airTemperature: { max: { celsius: i } }, pad: 'x'.repeat(200),
    }));
    const html = wrap(JSON.stringify({ 'p_city_local/forecast': { longTerm: many } }));
    const { markdown, notes } = renderAppendBlocks(html, [{ ...SPEC, limit: 1000, fields: undefined }]);
    assert.ok(Buffer.byteLength(markdown, 'utf8') < 80 * 1024, 'must stay near the 64 KB cap');
    assert.match(markdown, /Gekürzt: \d+ von \d+ Zeilen ausgegeben\./);
    assert.match(notes[0], /von/);
    const body = markdown.split('```json\n')[1].split('\n```')[0];
    assert.ok(Array.isArray(JSON.parse(body)), 'truncated output must still be valid JSON');
  });

  it('skips a block when the document budget is exhausted', () => {
    const many = Array.from({ length: 4000 }, (_, i) => ({ pad: 'y'.repeat(200), i }));
    const html = wrap(JSON.stringify({ 'p_city_local/forecast': { longTerm: many } }));
    const bulk = { ...SPEC, limit: 1000, fields: undefined };
    const { markdown, notes } = renderAppendBlocks(html, [
      { ...bulk, title: 'A' }, { ...bulk, title: 'B' }, { ...bulk, title: 'C' },
    ]);
    assert.ok(Buffer.byteLength(markdown, 'utf8') <= 132 * 1024, 'document cap must hold');
    assert.ok(notes.some((n) => n.includes('übersprungen')), `expected a skip note, got ${JSON.stringify(notes)}`);
  });

  it('keeps the assembled block within the 64 KB cap even at the schema max title length', () => {
    const longTitle = 'T'.repeat(120); // recipe schema caps title at 120 chars
    const many = Array.from({ length: 4000 }, (_, i) => ({
      date: `d${i}`, airTemperature: { max: { celsius: i } }, pad: 'x'.repeat(200),
    }));
    const html = wrap(JSON.stringify({ 'p_city_local/forecast': { longTerm: many } }));
    const { markdown } = renderAppendBlocks(html, [{ ...SPEC, title: longTitle, limit: 1000, fields: undefined }]);
    assert.ok(Buffer.byteLength(markdown, 'utf8') <= 64 * 1024, 'the whole block, including heading and fence chrome, must respect the cap');
    const body = markdown.split('```json\n')[1].split('\n```')[0];
    assert.ok(Array.isArray(JSON.parse(body)), 'truncated output must still be valid JSON');
  });
});
