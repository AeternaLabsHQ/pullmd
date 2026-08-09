import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseJsonScript, resolveSegments, projectRows } from '../lib/append-data.js';
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
