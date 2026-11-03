// Minimal ZIP reader for upload formats that are zip containers
// (OpenDocument and friends). No dependencies: it reads the central
// directory, supports "stored" and "deflate" entries, rejects encrypted
// entries and caps the inflated size so a zip bomb fails cleanly.
//
// Every offset is bounds-checked: truncated or garbage input throws a
// ZipError, it never reads out of range or loops forever.
import zlib from 'node:zlib';

const EOCD_SIG = 0x06054b50;
const CDIR_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;
const EOCD_MIN = 22;
const EOCD_SEARCH = 65535 + EOCD_MIN; // max comment length + record
const MAX_ENTRIES = 65535;

export const DEFAULT_MAX_ENTRY_BYTES = 64 * 1024 * 1024;

export class ZipError extends Error {
  constructor(message, code = 'zip_invalid') {
    super(message);
    this.name = 'ZipError';
    this.code = code;
  }
}

function need(buf, offset, length) {
  if (!Number.isInteger(offset) || offset < 0 || length < 0 || offset + length > buf.length) {
    throw new ZipError('Truncated or damaged ZIP archive.');
  }
}

function findEocd(buf) {
  if (buf.length < EOCD_MIN) throw new ZipError('Not a ZIP archive.', 'zip_not_zip');
  const stop = Math.max(0, buf.length - EOCD_SEARCH);
  for (let i = buf.length - EOCD_MIN; i >= stop; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) return i;
  }
  throw new ZipError('Not a ZIP archive.', 'zip_not_zip');
}

/**
 * List the entries of a ZIP archive from its central directory.
 * @param {Buffer} buffer
 * @returns {Array<{name:string, compressedSize:number, size:number, method:number,
 *   encrypted:boolean, localOffset:number}>}
 */
export function readZipEntries(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  const eocd = findEocd(buf);
  const count = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdOffset === 0xffffffff) {
    throw new ZipError('ZIP64 archives are not supported.', 'zip_unsupported');
  }
  need(buf, cdOffset, cdSize);

  const entries = [];
  let p = cdOffset;
  const end = cdOffset + cdSize;
  for (let n = 0; n < count && n < MAX_ENTRIES; n++) {
    need(buf, p, 46);
    if (p + 46 > end || buf.readUInt32LE(p) !== CDIR_SIG) {
      throw new ZipError('Damaged ZIP central directory.');
    }
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const compressedSize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    need(buf, p + 46, nameLen + extraLen + commentLen);
    // Bit 11 = UTF-8 names; everything else is CP437, which matches
    // latin1 for the ASCII names ODF uses.
    const nameBytes = buf.subarray(p + 46, p + 46 + nameLen);
    const name = nameBytes.toString(flags & 0x800 ? 'utf8' : 'latin1');
    entries.push({ name, compressedSize, size, method, encrypted: Boolean(flags & 1), localOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/**
 * Read one entry's bytes. Returns null when the archive has no such entry.
 * @param {Buffer} buffer
 * @param {string} name
 * @param {object} [options]
 * @param {number} [options.maxBytes] cap on the uncompressed size
 * @param {Array} [options.entries] result of readZipEntries, to avoid re-parsing
 * @returns {Buffer|null}
 */
export function readZipEntry(buffer, name, options = {}) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_ENTRY_BYTES;
  const entries = options.entries || readZipEntries(buf);
  const entry = entries.find((e) => e.name === name);
  if (!entry) return null;
  if (entry.encrypted) throw new ZipError(`ZIP entry ${name} is encrypted.`, 'zip_encrypted');

  const lo = entry.localOffset;
  need(buf, lo, 30);
  if (buf.readUInt32LE(lo) !== LOCAL_SIG) throw new ZipError('Damaged ZIP local header.');
  // Sizes come from the central directory: with a data descriptor
  // (flag bit 3) the local header carries zeros.
  const start = lo + 30 + buf.readUInt16LE(lo + 26) + buf.readUInt16LE(lo + 28);
  need(buf, start, entry.compressedSize);
  const data = buf.subarray(start, start + entry.compressedSize);

  if (entry.method === 0) {
    if (data.length > maxBytes) throw new ZipError(`ZIP entry ${name} is too large.`, 'zip_too_large');
    return Buffer.from(data);
  }
  if (entry.method === 8) {
    try {
      return zlib.inflateRawSync(data, { maxOutputLength: maxBytes });
    } catch (err) {
      if (err?.code === 'ERR_BUFFER_TOO_LARGE' || err instanceof RangeError) {
        throw new ZipError(`ZIP entry ${name} is too large.`, 'zip_too_large');
      }
      throw new ZipError(`ZIP entry ${name} could not be decompressed.`);
    }
  }
  throw new ZipError(`ZIP compression method ${entry.method} is not supported.`, 'zip_unsupported');
}
