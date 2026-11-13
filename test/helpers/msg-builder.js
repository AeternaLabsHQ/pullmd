// Test helper: builds Outlook .msg files (MS-CFB compound files + MS-OXMSG
// property streams) in memory, byte for byte reproducible, so tests can pin
// exact bytes - in particular PT_STRING8 (0x001E) strings in a non-UTF-8 code
// page, which no msgreader fixture covers.
//
// Scope: just what msgreader (and Outlook-style readers) need. Version 3 CFB
// (512-byte sectors, 64-byte mini sectors, 4096-byte mini-stream cutoff), one
// FAT chain without DIFAT extension (files up to about 7 MB), directory
// trees as balanced binary trees with every entry black (a reader that
// validates red-black rules would object; none of ours does).
//
// Encoding helpers (encodeCodepage) derive their tables from Node's
// TextDecoder (WHATWG), which is a different implementation than the
// iconv-lite msgreader uses, so the fixtures are not produced by the code
// under test.

const FREESECT = 0xffffffff;
const ENDOFCHAIN = 0xfffffffe;
const FATSECT = 0xfffffffd;
const SECTOR = 512;
const MINI = 64;
const CUTOFF = 4096;
const NOSTREAM = 0xffffffff;

// ---------------------------------------------------------------- encoding

const tableCache = new Map();

/** char -> bytes table for a WHATWG label, built by decoding every 1- and 2-byte sequence. */
function encodingTable(label) {
  let table = tableCache.get(label);
  if (table) return table;
  table = new Map();
  const dec = new TextDecoder(label);
  const put = (bytes) => {
    const s = dec.decode(Uint8Array.from(bytes));
    // Keep the first sequence per character; skip replacement results.
    if ([...s].length === 1 && s !== '�' && !table.has(s)) table.set(s, bytes);
  };
  for (let b = 0; b < 256; b++) put([b]);
  const multiByte = /^(shift_jis|gbk|gb18030|big5|euc-kr|euc-jp)$/.test(label);
  if (multiByte) {
    for (let lead = 0x81; lead <= 0xfe; lead++) {
      for (let trail = 0x40; trail <= 0xfe; trail++) put([lead, trail]);
    }
  }
  tableCache.set(label, table);
  return table;
}

/** Encode text in the given WHATWG encoding (single-byte or the common double-byte ones). */
export function encodeCodepage(text, label) {
  if (/^utf-?8$/i.test(label)) return Buffer.from(text, 'utf8');
  const table = encodingTable(label);
  const out = [];
  for (const ch of text) {
    const bytes = table.get(ch);
    if (!bytes) throw new Error(`${JSON.stringify(ch)} has no ${label} encoding`);
    out.push(...bytes);
  }
  return Buffer.from(out);
}

const utf16 = (s) => Buffer.from(s, 'utf16le');

// ---------------------------------------------------------------- MAPI properties

export const PT = { LONG: 0x0003, STRING8: 0x001e, UNICODE: 0x001f, BINARY: 0x0102, TIME: 0x0040 };

/** Well-known property ids used by the tests. */
export const PID = {
  subject: 0x0037,
  senderName: 0x0c1a,
  senderEmail: 0x0c1f,
  senderSmtp: 0x5d01,
  body: 0x1000,
  bodyHtmlBinary: 0x1013, // PR_HTML, binary
  compressedRtf: 0x1009,
  messageClass: 0x001a,
  recipType: 0x0c15,
  recipName: 0x3001,
  recipSmtp: 0x39fe,
  internetCodepage: 0x3fde,
  messageCodepage: 0x3ffd,
};

const hex4 = (n) => n.toString(16).toUpperCase().padStart(4, '0');

/** A property: { id, type, value } with value a Buffer (string/binary types) or a number (PT_LONG). */
export const prop = (id, type, value) => ({ id, type, value });
export const long = (id, n) => prop(id, PT.LONG, n);
/** PT_STRING8 property from already-encoded bytes. */
export const str8 = (id, bytes) => prop(id, PT.STRING8, Buffer.from(bytes));
/** PT_UNICODE property from JS text. */
export const str16 = (id, text) => prop(id, PT.UNICODE, utf16(text));
export const bin = (id, bytes) => prop(id, PT.BINARY, Buffer.from(bytes));

/**
 * [MS-OXMSG] 2.4 property stream. Header: 8 reserved bytes (+ 24 more for the
 * top-level message: next recipient/attachment ids, counts, 8 reserved).
 * Entries: tag (4), flags (4, 6 = readable|writable), then 8 value bytes:
 * the value itself for PT_LONG, size (+4 reserved) for variable-length types.
 */
function propertyStream(props, { root, recipients = 0, attachments = 0 }) {
  const header = Buffer.alloc(root ? 32 : 8);
  if (root) {
    header.writeUInt32LE(recipients, 8); // next recipient id
    header.writeUInt32LE(attachments, 12); // next attachment id
    header.writeUInt32LE(recipients, 16); // recipient count
    header.writeUInt32LE(attachments, 20); // attachment count
  }
  const entries = props.map((p) => {
    const e = Buffer.alloc(16);
    e.writeUInt32LE(((p.id << 16) | p.type) >>> 0, 0);
    e.writeUInt32LE(6, 4);
    if (p.type === PT.LONG) e.writeUInt32LE(p.value, 8);
    else if (p.type === PT.STRING8) e.writeUInt32LE(p.value.length + 1, 8); // size counts the NUL
    else if (p.type === PT.UNICODE) e.writeUInt32LE(p.value.length + 2, 8);
    else e.writeUInt32LE(p.value.length, 8);
    return e;
  });
  return Buffer.concat([header, ...entries]);
}

/** The __substg1.0_<id><type> stream content of a variable-length property (NUL terminated strings). */
function substgData(p) {
  if (p.type === PT.STRING8) return Buffer.concat([p.value, Buffer.from([0])]);
  if (p.type === PT.UNICODE) return Buffer.concat([p.value, Buffer.from([0, 0])]);
  return p.value;
}

function storageFor(props, { root, recipients, attachments }) {
  const streams = [{ name: '__properties_version1.0', data: propertyStream(props, { root, recipients, attachments }) }];
  for (const p of props) {
    if (p.type === PT.LONG) continue;
    streams.push({ name: `__substg1.0_${hex4(p.id)}${hex4(p.type)}`, data: substgData(p) });
  }
  return streams;
}

/**
 * Build an Outlook message.
 * @param {{props: object[], recipients?: object[][]}} msg  properties (prop()/str8()/...) of the message and of each recipient
 * @returns {Buffer}
 */
export function buildMsg({ props, recipients = [] }) {
  const root = {
    name: 'Root Entry',
    children: [
      ...storageFor(props, { root: true, recipients: recipients.length }),
      ...recipients.map((rp, i) => ({
        name: `__recip_version1.0_#${i.toString(16).toUpperCase().padStart(8, '0')}`,
        children: storageFor(rp, { root: false }),
      })),
    ],
  };
  return buildCfb(root);
}

// ---------------------------------------------------------------- CFB writer

const nameOrder = (a, b) => {
  // MS-CFB 2.6.4: shorter names first, then ordinal compare of the upper-cased name.
  if (a.name.length !== b.name.length) return a.name.length - b.name.length;
  const x = a.name.toUpperCase();
  const y = b.name.toUpperCase();
  return x < y ? -1 : x > y ? 1 : 0;
};

/** @param {{name: string, children: object[]}} root  storage tree; leaves are {name, data: Buffer} */
export function buildCfb(root) {
  // Flatten into directory entries (index 0 = root).
  const entries = [];
  const walk = (node, type) => {
    const entry = { name: node.name, type, data: node.data || null, left: NOSTREAM, right: NOSTREAM, child: NOSTREAM, start: ENDOFCHAIN, size: 0 };
    const index = entries.length;
    entries.push(entry);
    if (node.children) {
      const kids = [...node.children].sort(nameOrder).map((k) => ({ idx: walk(k, k.children ? 1 : 2), k }));
      // Balanced BST over the sorted siblings.
      const build = (lo, hi) => {
        if (lo > hi) return NOSTREAM;
        const mid = (lo + hi) >> 1;
        entries[kids[mid].idx].left = build(lo, mid - 1);
        entries[kids[mid].idx].right = build(mid + 1, hi);
        return kids[mid].idx;
      };
      entry.child = build(0, kids.length - 1);
    }
    return index;
  };
  walk(root, 5);

  // Streams: small ones into the mini stream, big ones into regular sectors.
  const miniChunks = [];
  const miniFat = [];
  let miniSectors = 0;
  const big = [];
  for (const e of entries) {
    if (e.type !== 2) continue;
    e.size = e.data.length;
    if (e.size === 0) continue;
    if (e.size < CUTOFF) {
      const n = Math.ceil(e.size / MINI);
      e.start = miniSectors;
      for (let i = 0; i < n; i++) miniFat.push(i === n - 1 ? ENDOFCHAIN : miniSectors + i + 1);
      miniSectors += n;
      const padded = Buffer.alloc(n * MINI);
      e.data.copy(padded);
      miniChunks.push(padded);
    } else {
      big.push(e);
    }
  }
  const miniStream = Buffer.concat(miniChunks);
  const miniFatSectors = Math.ceil(miniFat.length / (SECTOR / 4));
  const dirSectors = Math.ceil(entries.length / 4);
  const bigSectors = big.reduce((n, e) => n + Math.ceil(e.size / SECTOR), 0);
  const miniStreamSectors = Math.ceil(miniStream.length / SECTOR);
  const dataSectors = bigSectors + miniStreamSectors + miniFatSectors + dirSectors;
  let fatSectors = 1;
  while (fatSectors * (SECTOR / 4) < dataSectors + fatSectors) fatSectors++;
  if (fatSectors > 109) throw new Error('file too large for the minimal CFB writer');

  // Layout: [FAT][directory][mini FAT][mini stream][big streams...]
  const fat = new Array(fatSectors * (SECTOR / 4)).fill(FREESECT);
  let next = 0;
  const chain = (count) => {
    const first = next;
    for (let i = 0; i < count; i++) fat[next + i] = i === count - 1 ? ENDOFCHAIN : next + i + 1;
    next += count;
    return count ? first : ENDOFCHAIN;
  };
  const fatStart = next;
  for (let i = 0; i < fatSectors; i++) fat[next++] = FATSECT;
  const dirStart = chain(dirSectors);
  const miniFatStart = chain(miniFatSectors);
  entries[0].start = chain(miniStreamSectors);
  entries[0].size = miniStream.length;
  for (const e of big) e.start = chain(Math.ceil(e.size / SECTOR));

  const out = Buffer.alloc((next + 1) * SECTOR, 0);
  // Header.
  Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]).copy(out, 0);
  out.writeUInt16LE(0x003e, 24); // minor version
  out.writeUInt16LE(3, 26); // major version
  out.writeUInt16LE(0xfffe, 28); // little endian
  out.writeUInt16LE(9, 30); // sector shift
  out.writeUInt16LE(6, 32); // mini sector shift
  out.writeUInt32LE(0, 40); // directory sector count (0 for v3)
  out.writeUInt32LE(fatSectors, 44);
  out.writeUInt32LE(dirStart, 48);
  out.writeUInt32LE(CUTOFF, 56);
  out.writeUInt32LE(miniFatStart, 60);
  out.writeUInt32LE(miniFatSectors, 64);
  out.writeUInt32LE(ENDOFCHAIN, 68); // first DIFAT sector
  out.writeUInt32LE(0, 72);
  for (let i = 0; i < 109; i++) out.writeUInt32LE(i < fatSectors ? fatStart + i : FREESECT, 76 + 4 * i);

  const at = (sector) => (sector + 1) * SECTOR;
  fat.forEach((v, i) => out.writeUInt32LE(v, at(fatStart) + 4 * i));
  // Mini FAT (unused slots stay FREESECT).
  const miniFatBuf = Buffer.alloc(miniFatSectors * SECTOR, 0xff);
  miniFat.forEach((v, i) => miniFatBuf.writeUInt32LE(v, 4 * i));
  miniFatBuf.copy(out, at(miniFatStart));
  miniStream.copy(out, at(entries[0].start));
  for (const e of big) e.data.copy(out, at(e.start));

  // Directory.
  const dir = Buffer.alloc(dirSectors * SECTOR);
  // Unused entries: no-stream links.
  for (let i = entries.length; i < dirSectors * 4; i++) {
    dir.writeUInt32LE(NOSTREAM, i * 128 + 68);
    dir.writeUInt32LE(NOSTREAM, i * 128 + 72);
    dir.writeUInt32LE(NOSTREAM, i * 128 + 76);
  }
  entries.forEach((e, i) => {
    const o = i * 128;
    const nm = Buffer.from(`${e.name}\0`, 'utf16le');
    if (nm.length > 64) throw new Error(`directory name too long: ${e.name}`);
    nm.copy(dir, o);
    dir.writeUInt16LE(nm.length, o + 64);
    dir.writeUInt8(e.type, o + 66);
    dir.writeUInt8(1, o + 67); // black
    dir.writeUInt32LE(e.left, o + 68);
    dir.writeUInt32LE(e.right, o + 72);
    dir.writeUInt32LE(e.child, o + 76);
    dir.writeUInt32LE(e.start, o + 116);
    dir.writeUInt32LE(e.size, o + 120);
  });
  dir.copy(out, at(dirStart));
  return out;
}

// ---------------------------------------------------------------- compressed RTF

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return c >>> 0;
}

/**
 * [MS-OXRTFCP] PR_RTF_COMPRESSED container ("LZFu") holding `rtf` as literals
 * only (every control byte 0x00, no back-references): valid, just not small.
 * @param {Buffer} rtf  raw RTF bytes
 */
export function compressRtfLiteral(rtf) {
  const parts = [];
  for (let i = 0; i < rtf.length; i += 8) {
    const chunk = rtf.subarray(i, i + 8);
    parts.push(Buffer.from([0]), chunk);
  }
  const contents = Buffer.concat(parts);
  const header = Buffer.alloc(16);
  header.writeUInt32LE(contents.length + 12, 0); // compressed size, counting the 12 bytes after this field
  header.writeUInt32LE(rtf.length, 4); // raw size
  header.write('LZFu', 8, 'latin1');
  header.writeUInt32LE(crc32(contents), 12);
  return Buffer.concat([header, contents]);
}
