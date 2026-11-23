import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beginHosting, parsePdfImages, MAX_IMAGE_BYTES, MAX_TOTAL_BYTES } from '../lib/ocr-image-hosting.js';
import { createImageStore } from '../lib/image-store.js';

const PUBLIC = 'https://pullmd.example';
const dataUri = (bytes, mime = 'image/jpeg') => `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`;
const jpeg = (id, size = 10) => ({ id, width: 100, height: 100, dataUri: dataUri(Buffer.alloc(size, 7)) });

function listFiles(root) {
  const out = [];
  if (!fs.existsSync(root)) return out;
  for (const shard of fs.readdirSync(root)) {
    for (const f of fs.readdirSync(path.join(root, shard))) out.push(f);
  }
  return out;
}

describe('parsePdfImages', () => {
  it('maps the value to a mode', () => {
    assert.equal(parsePdfImages('hosted', true), 'hosted');
    assert.equal(parsePdfImages('hosted', false), 'caption');
    assert.equal(parsePdfImages('caption', false), 'caption');
    assert.equal(parsePdfImages('caption', true), 'caption');
    assert.equal(parsePdfImages('strip', true), 'strip');
    assert.equal(parsePdfImages(undefined, true), 'strip');
    assert.equal(parsePdfImages('x', true), 'strip');
    assert.equal(parsePdfImages(['hosted'], true), 'strip');
  });
});

describe('beginHosting', () => {
  let root;
  let store;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'pullmd-hosting-'));
    store = createImageStore(root);
  });
  afterEach(() => {
    mock.restoreAll();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('writes two images and returns their URLs and assets', async () => {
    const h = beginHosting({ store, publicUrl: PUBLIC });
    const map = await h.hostImages([jpeg('img-0.jpeg'), jpeg('img-1.jpeg', 20)]);
    assert.equal(map.size, 2);
    assert.equal(h.assets.length, 2);
    assert.equal(listFiles(root).length, 2);
    for (const id of ['img-0.jpeg', 'img-1.jpeg']) {
      assert.match(map.get(id), /^https:\/\/pullmd\.example\/img\/[0-9a-f]{32}\.jpeg$/);
    }
    const a = h.assets[1];
    assert.match(a.id, /^[0-9a-f]{32}$/);
    assert.equal(a.mime, 'image/jpeg');
    assert.equal(a.size, 20);
    assert.ok(map.get('img-1.jpeg').includes(a.id));
    assert.deepEqual(fs.readFileSync(store.filePath(a.id, a.mime)), Buffer.alloc(20, 7));
  });

  it('skips SVG, undecodable, id-less and oversize images', async () => {
    const h = beginHosting({ store, publicUrl: PUBLIC });
    const svg = { id: 'img-1.svg', dataUri: dataUri('<svg/>', 'image/svg+xml') };
    const big = jpeg('img-2.jpeg', MAX_IMAGE_BYTES + 1);
    const junk = { id: 'img-3.jpeg', dataUri: 'data:image/jpeg;base64,!!!' };
    const noUri = { id: 'img-4.jpeg' };
    const map = await h.hostImages([jpeg('img-0.jpeg'), svg, big, junk, noUri, null]);
    assert.deepEqual([...map.keys()], ['img-0.jpeg']);
    assert.equal(h.assets.length, 1);
    assert.equal(listFiles(root).length, 1);
  });

  it('accepts an image of exactly the per-image cap', async () => {
    const h = beginHosting({ store, publicUrl: PUBLIC });
    const map = await h.hostImages([jpeg('img-0.jpeg', MAX_IMAGE_BYTES)]);
    assert.equal(map.size, 1);
  });

  it('skips the image that would push the total over the cap, keeps later ones that fit', async () => {
    const h = beginHosting({ store, publicUrl: PUBLIC });
    const full = MAX_TOTAL_BYTES / MAX_IMAGE_BYTES;
    const images = Array.from({ length: full }, (_, i) => jpeg(`img-${i}.jpeg`, MAX_IMAGE_BYTES));
    images.push(jpeg('img-over.jpeg', 1));
    const map = await h.hostImages(images);
    assert.equal(map.size, full);
    assert.equal(map.has('img-over.jpeg'), false);
    assert.equal(h.assets.length, full);
  });

  it('skips an image whose write throws and keeps the others', async () => {
    mock.method(console, 'warn', () => {});
    let calls = 0;
    const flaky = {
      write(id, mime, bytes) {
        if (++calls === 2) throw new Error('disk full');
        store.write(id, mime, bytes);
      },
      remove: (a) => store.remove(a),
    };
    const h = beginHosting({ store: flaky, publicUrl: PUBLIC });
    const map = await h.hostImages([jpeg('img-0.jpeg'), jpeg('img-1.jpeg'), jpeg('img-2.jpeg')]);
    assert.deepEqual([...map.keys()], ['img-0.jpeg', 'img-2.jpeg']);
    assert.equal(h.assets.length, 2);
    assert.equal(listFiles(root).length, 2);
  });

  it('rollback removes every written file and empties assets', async () => {
    const h = beginHosting({ store, publicUrl: PUBLIC });
    await h.hostImages([jpeg('img-0.jpeg'), jpeg('img-1.jpeg')]);
    assert.equal(listFiles(root).length, 2);
    h.rollback();
    assert.equal(listFiles(root).length, 0);
    assert.deepEqual(h.assets, []);
  });

  it('keeps the same assets array object so callers can hold a reference', async () => {
    const h = beginHosting({ store, publicUrl: PUBLIC });
    const ref = h.assets;
    await h.hostImages([jpeg('img-0.jpeg')]);
    assert.equal(ref.length, 1);
    h.rollback();
    assert.equal(ref.length, 0);
  });

  it('tolerates a trailing slash on the public URL', async () => {
    const h = beginHosting({ store, publicUrl: `${PUBLIC}/` });
    const map = await h.hostImages([jpeg('img-0.jpeg')]);
    assert.match(map.get('img-0.jpeg'), /^https:\/\/pullmd\.example\/img\/[0-9a-f]{32}\.jpeg$/);
  });
});
