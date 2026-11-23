import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createImageStore } from '../lib/image-store.js';

const ID_A = 'ab0123456789abcdef0123456789abcd';
const ID_B = 'cd0123456789abcdef0123456789abef';
const BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);

function listAll(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listAll(p));
    else out.push(p);
  }
  return out;
}

describe('image store', () => {
  let root;
  let store;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'pullmd-img-'));
    store = createImageStore(root);
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('writes bytes to <root>/<first two hex>/<id>.<ext> and exposes rootDir', () => {
    store.write(ID_A, 'image/jpeg', BYTES);
    const expected = path.join(root, 'ab', `${ID_A}.jpeg`);
    assert.equal(store.filePath(ID_A, 'image/jpeg'), expected);
    assert.deepEqual(fs.readFileSync(expected), BYTES);
    assert.equal(store.rootDir, root);
  });

  it('maps every allowed MIME type to its extension', () => {
    const cases = { 'image/jpeg': 'jpeg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' };
    for (const [mime, ext] of Object.entries(cases)) {
      assert.equal(path.basename(store.filePath(ID_A, mime)), `${ID_A}.${ext}`);
    }
  });

  it('leaves no temp file behind after a write', () => {
    store.write(ID_A, 'image/png', BYTES);
    assert.deepEqual(listAll(root), [path.join(root, 'ab', `${ID_A}.png`)]);
  });

  it('overwrites an existing file for the same id', () => {
    store.write(ID_A, 'image/png', BYTES);
    store.write(ID_A, 'image/png', Buffer.from('second'));
    assert.equal(fs.readFileSync(store.filePath(ID_A, 'image/png'), 'utf8'), 'second');
  });

  it('rejects bad ids and MIME types without creating anything', () => {
    for (const id of ['../../x', ID_A.toUpperCase(), 'ab', `${ID_A}0`, '', undefined, 42]) {
      assert.throws(() => store.write(id, 'image/jpeg', BYTES), /invalid image id/, `id ${String(id)}`);
      assert.throws(() => store.filePath(id, 'image/jpeg'), /invalid image id/, `id ${String(id)}`);
    }
    for (const mime of ['image/svg+xml', 'text/html', '', undefined, '__proto__', 'constructor']) {
      assert.throws(() => store.write(ID_A, mime, BYTES), /unsupported image type/, `mime ${String(mime)}`);
      assert.throws(() => store.filePath(ID_A, mime), /unsupported image type/, `mime ${String(mime)}`);
    }
    assert.deepEqual(listAll(root), []);
    assert.deepEqual(fs.readdirSync(root), []);
  });

  it('remove deletes files, ignores missing files and bad ids, and never throws', () => {
    store.write(ID_A, 'image/jpeg', BYTES);
    store.write(ID_B, 'image/png', BYTES);
    assert.doesNotThrow(() => store.remove([
      { id: ID_A, mime: 'image/jpeg' },
      { id: ID_B, mime: 'image/png' },
      { id: ID_B, mime: 'image/png' },
      { id: '../../etc/passwd', mime: 'image/png' },
      { id: ID_A, mime: 'image/svg+xml' },
      null,
      {},
    ]));
    assert.deepEqual(listAll(root), []);
  });

  it('remove tolerates an empty list and a missing root', () => {
    fs.rmSync(root, { recursive: true, force: true });
    assert.doesNotThrow(() => store.remove([]));
    assert.doesNotThrow(() => store.remove([{ id: ID_A, mime: 'image/jpeg' }]));
  });

  it('sweep keeps known ids, removes unknown ones and leftover temp files', () => {
    store.write(ID_A, 'image/jpeg', BYTES);
    store.write(ID_B, 'image/png', BYTES);
    const leftover = path.join(root, 'ab', `${ID_A}.jpeg.deadbeef.tmp`);
    fs.writeFileSync(leftover, 'partial');
    const removed = store.sweep(new Set([ID_A]));
    assert.equal(removed, 2);
    assert.deepEqual(listAll(root), [path.join(root, 'ab', `${ID_A}.jpeg`)]);
  });

  it('sweep with an empty set removes all images', () => {
    store.write(ID_A, 'image/jpeg', BYTES);
    store.write(ID_B, 'image/gif', BYTES);
    assert.equal(store.sweep(new Set()), 2);
    assert.deepEqual(listAll(root), []);
  });

  it('sweep on a missing root returns 0', () => {
    fs.rmSync(root, { recursive: true, force: true });
    assert.equal(store.sweep(new Set()), 0);
  });
});
