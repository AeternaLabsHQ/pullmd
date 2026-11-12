import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRecipes, matchRecipes, getRecipeStatus } from '../lib/recipes.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const defaultPath = path.join(here, 'fixtures/recipes/default.json');

let dir;
before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pullmd-recipes-err-')); });
after(() => { fs.rmSync(dir, { recursive: true, force: true }); });

function userFile(name, content) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, content);
  return p;
}

// Silences and records console.warn / console.log for one test.
function capture(t) {
  const warn = t.mock.method(console, 'warn', () => {});
  t.mock.method(console, 'log', () => {});
  return () => warn.mock.calls.map((c) => String(c.arguments[0]));
}

// The two fixture defaults must survive whatever the user file does.
function assertDefaultsIntact(state) {
  assert.deepEqual(state.recipes.slice(0, 2).map((r) => r.name), ['fixture-paywall', 'fixture-extractor']);
  assert.deepEqual(state.status.sources[0], { path: defaultPath, loaded: 2, rejected: 0 });
  const merged = matchRecipes(new URL('https://blog.example.com/post'));
  assert.equal(merged.extractor, 'trafilatura');
  assert.equal(merged.preprocess.length, 1);
  assert.equal(merged.preprocess[0].action, 'remove-attr');
}

describe('loadRecipes - broken user file', () => {
  const cases = [
    {
      label: 'unreadable (a directory in place of the file)',
      make: () => { const p = path.join(dir, 'a-directory.json'); fs.mkdirSync(p, { recursive: true }); return p; },
      warning: /^\[recipes\] cannot read .*a-directory\.json: /,
    },
    {
      label: 'not valid JSON',
      make: () => userFile('broken.json', '[{ "name": "x", "host": "x.example.com" '),
      warning: /^\[recipes\] .*broken\.json is not valid JSON: /,
    },
    {
      label: 'empty file',
      make: () => userFile('empty.json', ''),
      warning: /^\[recipes\] .*empty\.json is not valid JSON: /,
    },
    {
      label: 'root is an object',
      make: () => userFile('object.json', JSON.stringify({ name: 'x', host: 'x.example.com' })),
      warning: /^\[recipes\] .*object\.json root must be an array$/,
    },
    {
      label: 'root is null',
      make: () => userFile('null.json', 'null'),
      warning: /^\[recipes\] .*null\.json root must be an array$/,
    },
  ];

  for (const c of cases) {
    it(`${c.label}: warns once, loads nothing from it, keeps the defaults`, (t) => {
      const warnings = capture(t);
      const userPath = c.make();

      const state = loadRecipes({ defaultPath, userPath });

      assert.deepEqual(Object.keys(state).sort(), ['recipes', 'status']);
      assert.equal(state.recipes.length, 2);
      assert.equal(state.status.loaded, 2);
      assert.equal(state.status.rejected, 0);
      // The file exists, so it is reported as a source - with nothing in it.
      assert.deepEqual(state.status.sources[1], { path: userPath, loaded: 0, rejected: 0 });
      assert.deepEqual(state.status.filteredFrontmatterFields, []);
      assert.equal(getRecipeStatus(), state.status);
      assertDefaultsIntact(state);

      const w = warnings();
      assert.equal(w.length, 1, `expected exactly one warning, got ${JSON.stringify(w)}`);
      assert.match(w[0], c.warning);
    });
  }

  it('a broken default file does not stop the user file from loading', (t) => {
    const warnings = capture(t);
    const brokenDefault = userFile('default-broken.json', 'nope');
    const userPath = userFile('user-ok.json', JSON.stringify([{ name: 'u1', host: 'u.example.com', extractor: 'playwright' }]));

    const state = loadRecipes({ defaultPath: brokenDefault, userPath });

    assert.deepEqual(state.recipes.map((r) => r.name), ['u1']);
    assert.deepEqual(state.status.sources, [
      { path: brokenDefault, loaded: 0, rejected: 0 },
      { path: userPath, loaded: 1, rejected: 0 },
    ]);
    assert.equal(matchRecipes(new URL('https://u.example.com/')).extractor, 'playwright');
    assert.equal(warnings().length, 1);
  });
});

describe('loadRecipes - entries inside a readable user file', () => {
  it('duplicate name: warns, the later entry replaces the earlier one', (t) => {
    const warnings = capture(t);
    const userPath = userFile('dupes.json', JSON.stringify([
      { name: 'twice', host: 'dupe.example.com', extractor: 'readability' },
      { name: 'between', host: 'other.example.com' },
      { name: 'twice', host: 'dupe.example.com', extractor: 'playwright' },
    ]));

    const state = loadRecipes({ defaultPath, userPath });

    assert.deepEqual(state.recipes.map((r) => r.name),
      ['fixture-paywall', 'fixture-extractor', 'between', 'twice']);
    assert.deepEqual(state.status.sources[1], { path: userPath, loaded: 2, rejected: 0 });
    assert.equal(state.status.loaded, 4);
    assert.equal(matchRecipes(new URL('https://dupe.example.com/')).extractor, 'playwright');
    assertDefaultsIntact(state);

    const w = warnings();
    assert.equal(w.length, 1);
    assert.match(w[0], /dupes\.json .* duplicate name "twice", later entry wins$/);
  });

  it('a name already used by the default file is not a duplicate (per-file check)', (t) => {
    const warnings = capture(t);
    const userPath = userFile('overlay.json', JSON.stringify([
      { name: 'fixture-extractor', host: 'blog.example.com', extractor: 'playwright' },
    ]));

    const state = loadRecipes({ defaultPath, userPath });

    assert.equal(state.recipes.length, 3);
    assert.equal(matchRecipes(new URL('https://blog.example.com/x')).extractor, 'playwright');
    assert.deepEqual(warnings(), []);
  });

  it('non-object entries are rejected one by one with index and a null name', (t) => {
    const warnings = capture(t);
    const userPath = userFile('junk.json', JSON.stringify([
      null,
      'a string',
      { name: 'good', host: 'good.example.com' },
      { host: 'nameless.example.com' },
      { name: 'extra-key', host: 'x.example.com', unknown: true },
    ]));

    const state = loadRecipes({ defaultPath, userPath });

    assert.deepEqual(state.status.sources[1], { path: userPath, loaded: 1, rejected: 4 });
    assert.equal(state.status.rejected, 4);
    assert.equal(state.status.loaded, 3);
    assert.equal(state.recipes.at(-1).name, 'good');
    assertDefaultsIntact(state);

    const w = warnings();
    assert.equal(w.length, 4);
    assert.match(w[0], /recipe #0 rejected: /);
    assert.match(w[1], /recipe #1 rejected: /);
    assert.match(w[2], /recipe #3 rejected: name: /);
    assert.match(w[3], /recipe #4 rejected: /);
  });

  it('an empty array is a valid, empty source without a warning', (t) => {
    const warnings = capture(t);
    const userPath = userFile('none.json', '[]');

    const state = loadRecipes({ defaultPath, userPath });

    assert.deepEqual(state.status.sources[1], { path: userPath, loaded: 0, rejected: 0 });
    assert.deepEqual(warnings(), []);
  });
});
