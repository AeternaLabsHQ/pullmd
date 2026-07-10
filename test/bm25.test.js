import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { tokenize, scoreBm25 } from '../lib/bm25.js';

describe('tokenize', () => {
  it('lowercases and splits plain words', () => {
    assert.deepEqual(tokenize('Hello World'), ['hello', 'world']);
  });

  it('returns [] for empty input', () => {
    assert.deepEqual(tokenize(''), []);
  });

  it('returns [] for input with no matches', () => {
    assert.deepEqual(tokenize('   ---   ...   '), []);
  });

  it('keeps dotted identifiers like os.path as a single token', () => {
    assert.deepEqual(tokenize('import os.path today'), ['import', 'os.path', 'today']);
  });

  it('keeps hyphenated identifiers like better-sqlite3 as a single token', () => {
    assert.deepEqual(tokenize('using better-sqlite3 here'), ['using', 'better-sqlite3', 'here']);
  });

  it('splits on punctuation and whitespace generally', () => {
    assert.deepEqual(tokenize('foo, bar! baz?'), ['foo', 'bar', 'baz']);
  });

  it('lowercases unicode letters, e.g. Köln -> köln', () => {
    assert.deepEqual(tokenize('Köln'), ['köln']);
  });

  it('keeps unicode word characters like äöü', () => {
    assert.deepEqual(tokenize('äöü words'), ['äöü', 'words']);
  });

  it('does not include a trailing hyphen/dot as part of the token', () => {
    assert.deepEqual(tokenize('word- word.'), ['word', 'word']);
  });

  it('treats digits as part of tokens', () => {
    assert.deepEqual(tokenize('es2024 v3.2.0'), ['es2024', 'v3.2.0']);
  });
});

describe('scoreBm25 — basics', () => {
  it('returns 0 for every doc when queryTokens is empty', () => {
    const docs = [['foo', 'bar'], ['baz']];
    const scores = scoreBm25([], docs);
    assert.deepEqual(scores, [0, 0]);
  });

  it('returns [] for empty docs array', () => {
    const scores = scoreBm25(['foo'], []);
    assert.deepEqual(scores, []);
  });

  it('returns 0 for a doc that does not contain any query term', () => {
    const docs = [['alpha', 'beta'], ['gamma', 'delta']];
    const scores = scoreBm25(['zzz'], docs);
    assert.deepEqual(scores, [0, 0]);
  });

  it('all scores are finite numbers, never NaN', () => {
    const docs = [[], ['foo'], ['foo', 'foo', 'bar']];
    const scores = scoreBm25(['foo', 'missing'], docs);
    for (const s of scores) {
      assert.ok(Number.isFinite(s), `expected finite score, got ${s}`);
    }
  });

  it('empty doc (dl=0) scores 0 and does not produce NaN', () => {
    const docs = [[], ['foo', 'bar']];
    const scores = scoreBm25(['foo'], docs);
    assert.equal(scores[0], 0);
    assert.ok(Number.isFinite(scores[1]));
  });

  it('all-empty docs corpus (avgdl=0) yields finite zero scores, no NaN', () => {
    const docs = [[], [], []];
    const scores = scoreBm25(['foo'], docs);
    assert.deepEqual(scores, [0, 0, 0]);
    for (const s of scores) assert.ok(Number.isFinite(s));
  });

  it('a doc containing the query term outscores one that does not', () => {
    const docs = [['foo', 'bar', 'baz'], ['bar', 'baz', 'qux']];
    const scores = scoreBm25(['foo'], docs);
    assert.ok(scores[0] > scores[1]);
  });
});

describe('scoreBm25 — IDF behavior', () => {
  it('a term present in every doc gets near-zero IDF -> negligible score, rare term outscores common term', () => {
    const docs = [
      ['common', 'rare', 'x', 'y'],
      ['common', 'z', 'w'],
      ['common', 'q', 'r'],
    ];
    const scores = scoreBm25(['common'], docs);
    const rareScores = scoreBm25(['rare'], docs);
    // doc 0 contains both 'common' and 'rare' at same tf=1; rare term must score
    // much higher due to near-zero IDF for the ubiquitous term.
    assert.ok(rareScores[0] > scores[0]);
  });

  it('IDF is computed per-call corpus (per-page), not global', () => {
    const docsA = [['x'], ['x'], ['x']]; // term in every doc -> low idf
    const docsB = [['x'], ['y'], ['z']]; // term in one doc -> higher idf
    const scoresA = scoreBm25(['x'], docsA);
    const scoresB = scoreBm25(['x'], docsB);
    assert.ok(scoresB[0] > scoresA[0]);
  });
});

describe('scoreBm25 — length normalization', () => {
  it('longer doc with same tf scores below shorter doc', () => {
    const shortDoc = ['foo', 'bar'];
    const longDoc = ['foo', 'bar', 'padding', 'padding', 'padding', 'padding', 'padding', 'padding'];
    const docs = [shortDoc, longDoc];
    const scores = scoreBm25(['foo'], docs);
    assert.ok(scores[0] > scores[1]);
  });
});

describe('scoreBm25 — query term dedupe', () => {
  it('duplicate query tokens count once (same score as deduped query)', () => {
    const docs = [['foo', 'bar', 'foo'], ['bar', 'baz']];
    const scoresDup = scoreBm25(['foo', 'foo', 'foo'], docs);
    const scoresSingle = scoreBm25(['foo'], docs);
    assert.deepEqual(scoresDup, scoresSingle);
  });
});

describe('scoreBm25 — options', () => {
  it('respects custom k1/b overrides and still returns finite scores', () => {
    const docs = [['foo', 'bar'], ['foo', 'foo', 'foo', 'padding', 'padding']];
    const scores = scoreBm25(['foo'], docs, { k1: 1.2, b: 0.5 });
    for (const s of scores) assert.ok(Number.isFinite(s));
  });

  it('defaults to k1=1.5, b=0.75 when opts omitted', () => {
    const docs = [['foo', 'bar'], ['foo', 'foo', 'foo', 'padding', 'padding']];
    const withDefaults = scoreBm25(['foo'], docs);
    const withExplicitDefaults = scoreBm25(['foo'], docs, { k1: 1.5, b: 0.75 });
    assert.deepEqual(withDefaults, withExplicitDefaults);
  });
});
