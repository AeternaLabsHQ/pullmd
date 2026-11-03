// E-mail (.eml / message/rfc822) to Markdown. Handled in-process - no
// markitdown sidecar needed. Only the message text is converted; attachments
// are listed by name, never decoded or converted.
import PostalMime from 'postal-mime';
import { renderMail, unprocessable } from './mail-render.js';

export function isEmlFile(contentType, filename) {
  if (/\.eml$/i.test(filename || '')) return true;
  // .mhtml files are MIME too and may arrive as message/rfc822 - the
  // extension decides first.
  if (/\.mht(ml)?$/i.test(filename || '')) return false;
  return /^message\/rfc822\b/i.test(contentType || '');
}

function formatAddress(a) {
  if (!a) return '';
  // Group syntax ("Team: a@x, b@y;") arrives as { name, group: [...] }.
  if (Array.isArray(a.group)) return a.group.map(formatAddress).filter(Boolean).join(', ');
  if (a.name && a.address) return `${a.name} <${a.address}>`;
  return a.address || a.name || '';
}

function formatList(list) {
  return (list || []).map(formatAddress).filter(Boolean).join(', ');
}

/**
 * @param {Buffer} buffer        raw RFC 822 message
 * @param {object} [options]     filename, lang ('de'|'en'), extractHtml / htmlFragmentToMarkdown (tests)
 */
export async function extractEml(buffer, options = {}) {
  const email = await PostalMime.parse(buffer);
  const hasHeaders = email.from || email.subject || email.date || (email.to && email.to.length);
  if (!hasHeaders) {
    throw unprocessable('Not an e-mail: no From/To/Subject/Date headers found. / Keine E-Mail: keine From/To/Subject/Date-Header gefunden.', 'not_email');
  }
  return renderMail({
    subject: email.subject,
    from: formatAddress(email.from),
    to: formatList(email.to),
    cc: formatList(email.cc),
    bcc: formatList(email.bcc),
    date: email.date,
    html: email.html,
    text: email.text,
    // Inline images referenced from the HTML (Content-ID) are not real attachments.
    attachmentNames: (email.attachments || [])
      .filter((a) => a.disposition !== 'inline' || !a.contentId)
      .map((a) => a.filename),
  }, options);
}
