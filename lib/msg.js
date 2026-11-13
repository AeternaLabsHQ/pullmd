// Outlook .msg (CFB / OLE compound file) to Markdown, in-process via
// msgreader. Same output as .eml (lib/mail-render.js). Bodies: PR_HTML, else
// the HTML encapsulated in the compressed RTF body (\fromhtml1, many Outlook
// mails keep their HTML only there), else PR_BODY.
import MsgReaderPkg from '@kenjiuno/msgreader';
import { decompressRTF } from '@kenjiuno/decompressrtf';
import { renderMail, unprocessable } from './mail-render.js';
import { rtfToHtmlIfEncapsulated } from './rtf.js';

const MsgReader = MsgReaderPkg.default || MsgReaderPkg;

// OLE compound file signature.
const CFB_MAGIC = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);

export function isMsgFile(contentType, filename) {
  if (/\.msg$/i.test(filename || '')) return true;
  return /^application\/(vnd\.ms-outlook|x-msg)\b/i.test(contentType || '');
}

// Windows code page -> WHATWG encoding label (Node's TextDecoder, full ICU).
function encodingForCodepage(cp) {
  if (!cp || cp === 65001) return 'utf-8';
  if (cp >= 1250 && cp <= 1258) return `windows-${cp}`;
  if (cp >= 28591 && cp <= 28605) return `iso-8859-${cp - 28590}`;
  return {
    20127: 'us-ascii', 932: 'shift_jis', 936: 'gbk', 949: 'euc-kr', 950: 'big5',
    50220: 'iso-2022-jp', 51932: 'euc-jp', 54936: 'gb18030', 20866: 'koi8-r', 21866: 'koi8-u',
  }[cp] || 'utf-8';
}

function decodeHtml(bytes, codepage) {
  const buf = Buffer.from(bytes);
  // A <meta charset> in the first KB wins over the message code page.
  const head = buf.subarray(0, 1024).toString('latin1');
  const meta = head.match(/charset\s*=\s*["']?([\w-]+)/i);
  for (const label of [meta?.[1], codepage ? encodingForCodepage(codepage) : null]) {
    if (!label) continue;
    try { return new TextDecoder(label).decode(buf); } catch { /* unknown label */ }
  }
  if (codepage) return buf.toString('utf8');
  // No <meta charset> and no code page: UTF-8 if the bytes are valid UTF-8, else Windows-1252.
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch { /* not UTF-8 */ }
  return new TextDecoder('windows-1252').decode(buf);
}

// Code page -> iconv-lite encoding name (the decoder msgreader uses for
// PT_STRING8 properties); undefined where iconv-lite has none.
function iconvEncodingForCodepage(cp) {
  if (cp === 65001) return 'utf-8';
  if (cp === 20127) return 'us-ascii';
  if ((cp >= 1250 && cp <= 1258) || cp === 874 || cp === 932 || cp === 936 || cp === 949 || cp === 950) return `cp${cp}`;
  if (cp >= 28591 && cp <= 28599) return `iso-8859-${cp - 28590}`;
  if (cp === 28605) return 'iso-8859-15';
  return {
    866: 'ibm866', 10000: 'macintosh', 20866: 'koi8-r', 21866: 'koi8-u', 51932: 'euc-jp', 54936: 'gb18030',
  }[cp];
}

const PT_STRING8 = 0x001e;

/**
 * msgreader's file data. PT_STRING8 properties (non-Unicode strings: older
 * Outlook, some exporters) are bytes in PR_MESSAGE_CODEPAGE (else
 * PR_INTERNET_CPID, else Windows-1252); msgreader reads them as Latin-1
 * unless told the encoding, so a message that has any is read a second time
 * with its code page. A code page iconv-lite does not know leaves the Latin-1
 * reading in place.
 */
function readMsgData(buffer) {
  let hasString8 = false;
  const first = new MsgReader(buffer);
  first.parserConfig = { propertyObserver: (fields, tag) => { if ((tag & 0xffff) === PT_STRING8) hasString8 = true; } };
  const data = first.getFileData();
  if (data.error || !hasString8) return data;
  const encoding = iconvEncodingForCodepage(data.messageCodepage || data.internetCodepage || 1252);
  if (!encoding) return data;
  try {
    const second = new MsgReader(buffer);
    second.parserConfig = { ansiEncoding: encoding };
    return second.getFileData();
  } catch {
    return data;
  }
}

/** HTML de-encapsulated from PR_RTF_COMPRESSED; undefined on any failure (plain body takes over). */
function htmlFromCompressedRtf(compressed) {
  try {
    const rtf = Buffer.from(decompressRTF(Array.from(compressed))).toString('latin1');
    const html = rtfToHtmlIfEncapsulated(rtf);
    return html && html.trim() ? html : undefined;
  } catch {
    return undefined;
  }
}

function formatPerson(name, address) {
  // Exchange-internal senders carry an X.500 DN ("/O=EXCHANGE/...") instead of SMTP.
  const addr = address && !address.startsWith('/') ? address : '';
  const n = (name || '').replace(/^'(.*)'$/, '$1');
  if (n && addr && n !== addr) return `${n} <${addr}>`;
  return addr || n;
}

/**
 * @param {Buffer} buffer   raw .msg bytes
 * @param {object} [options] filename, lang, extractHtml / htmlFragmentToMarkdown (tests)
 */
export async function extractMsg(buffer, options = {}) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 512 || !buffer.subarray(0, 8).equals(CFB_MAGIC)) {
    throw unprocessable('Not an Outlook .msg file. / Keine Outlook-.msg-Datei.', 'not_msg');
  }
  let data;
  try {
    data = readMsgData(buffer);
  } catch (err) {
    throw unprocessable(`Could not read the .msg file: ${err.message} / .msg-Datei nicht lesbar.`, 'not_msg');
  }
  if (data.error) {
    throw unprocessable(`Could not read the .msg file: ${data.error} / .msg-Datei nicht lesbar.`, 'not_msg');
  }

  const byType = (t) => (data.recipients || [])
    .filter((r) => (r.recipType || 'to') === t)
    .map((r) => formatPerson(r.name, r.smtpAddress || r.email))
    .filter(Boolean)
    .join(', ');

  let html = typeof data.bodyHtml === 'string' ? data.bodyHtml : undefined;
  if (!html && data.html) html = decodeHtml(data.html, data.internetCodepage || data.messageCodepage);
  if (!html && data.compressedRtf) html = htmlFromCompressedRtf(data.compressedRtf);

  return renderMail({
    subject: data.subject,
    from: formatPerson(data.senderName, data.senderSmtpAddress || data.senderEmail),
    to: byType('to'),
    cc: byType('cc'),
    bcc: byType('bcc'),
    date: data.messageDeliveryTime || data.clientSubmitTime || undefined,
    html,
    text: data.body,
    attachmentNames: (data.attachments || [])
      .filter((a) => !a.attachmentHidden)
      .map((a) => a.fileName || (a.innerMsgContent ? `${a.name || 'message'}.msg` : a.name)),
  }, options);
}
