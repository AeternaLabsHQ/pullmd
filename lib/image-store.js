// File store for hosted OCR figures: <root>/<id[0..1]>/<id>.<ext>.
//
// Synchronous on purpose: the files are tens of KB and the callers sit on the
// request path. Ids and MIME types are validated on every call and are the
// only input that ever reaches a path, so nothing user-controlled can escape
// the root.

import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { IMAGE_EXT } from './ocr-images.js';

const ID_RE = /^[0-9a-f]{32}$/;
const SHARD_RE = /^[0-9a-f]{2}$/;
const EXTS = Object.values(IMAGE_EXT);
// <id>.<ext> for a stored file; a temp file carries a random suffix and .tmp.
const FILE_RE = new RegExp(`^([0-9a-f]{32})\\.(${EXTS.join('|')})$`);
const TMP_SUFFIX = '.tmp';

function extFor(id, mime) {
  if (typeof id !== 'string' || !ID_RE.test(id)) throw new Error('invalid image id');
  if (typeof mime !== 'string' || !Object.hasOwn(IMAGE_EXT, mime)) throw new Error('unsupported image type');
  return IMAGE_EXT[mime];
}

export function createImageStore(rootDir) {
  function filePath(id, mime) {
    const ext = extFor(id, mime); // validates first: nothing unchecked reaches the path
    return path.join(rootDir, id.slice(0, 2), `${id}.${ext}`);
  }

  function write(id, mime, bytes) {
    const target = filePath(id, mime);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const tmp = `${target}.${randomBytes(4).toString('hex')}${TMP_SUFFIX}`;
    try {
      fs.writeFileSync(tmp, bytes);
      fs.renameSync(tmp, target);
    } catch (err) {
      fs.rmSync(tmp, { force: true });
      throw err;
    }
  }

  // Best effort: a failed delete is left for sweep(), and a bad entry is skipped.
  function remove(assets) {
    for (const asset of assets || []) {
      try {
        fs.rmSync(filePath(asset?.id, asset?.mime), { force: true });
      } catch { /* ignore */ }
    }
  }

  // Removes stored files whose id is not in knownIds and leftover temp files.
  // Files that do not follow the store's naming are not ours and stay.
  function sweep(knownIds) {
    let shards;
    try {
      shards = fs.readdirSync(rootDir, { withFileTypes: true });
    } catch {
      return 0;
    }
    let removed = 0;
    for (const shard of shards) {
      if (!shard.isDirectory() || !SHARD_RE.test(shard.name)) continue;
      const dir = path.join(rootDir, shard.name);
      let files;
      try {
        files = fs.readdirSync(dir);
      } catch {
        continue;
      }
      for (const name of files) {
        const m = FILE_RE.exec(name);
        const stale = m ? !knownIds.has(m[1]) : name.endsWith(TMP_SUFFIX);
        if (!stale) continue;
        try {
          fs.rmSync(path.join(dir, name), { force: true });
          removed++;
        } catch { /* ignore */ }
      }
      try {
        fs.rmdirSync(dir); // only succeeds when empty
      } catch { /* not empty */ }
    }
    return removed;
  }

  return { write, filePath, remove, sweep, rootDir };
}
