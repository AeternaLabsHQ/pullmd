// E-mail (.eml / message/rfc822) to Markdown. Handled in-process - no
// markitdown sidecar needed. Only the message text is converted; attachments
// are listed by name, never decoded or converted.
import PostalMime from 'postal-mime';

const MIN_HTML_CONTENT_CHARS = 200;

const LABELS = {
  de: { from: 'Von', to: 'An', cc: 'Cc', date: 'Datum', noSubject: '(kein Betreff)', attachments: 'Anhänge (nicht umgewandelt)' },
  en: { from: 'From', to: 'To', cc: 'Cc', date: 'Date', noSubject: '(no subject)', attachments: 'Attachments (not converted)' },
};

export function isEmlFile(contentType, filename) {
  if (/^message\/rfc822\b/i.test(contentType || '')) return true;
  return /\.eml$/i.test(filename || '');
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

function formatDate(iso, lang) {
  const d = new Date(iso);
  if (isNaN(d)) return null;
  return d.toLocaleString(lang === 'en' ? 'en-GB' : 'de-DE', {
    day: 'numeric', month: 'long', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
    timeZone: process.env.TZ || 'Europe/Berlin',
    timeZoneName: 'short',
  });
}

function tidy(md) {
  return md
    .replace(/\r\n?/g, '\n')
    .replace(/!\[[^\]]*\]\(cid:[^)]*\)/gi, '')   // inline images referenced by Content-ID
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function htmlToMarkdown(html, filename, extractHtmlFn) {
  const fn = extractHtmlFn || (await import('./web.js')).extractHtml;
  const result = await fn(html, { filename });
  if ((result.metadata?.contentLength ?? 0) < MIN_HTML_CONTENT_CHARS) return null;
  // The HTML pipeline opens with its own "# <title>" line (plus a
  // "**file** · date" line with PULLMD_SOURCE_HEADER); the mail header
  // supplies both instead.
  return { markdown: result.markdown.replace(/^# [^\n]*\n+(?:\*\*[^\n]*\*\* · [^\n]*\n+)?/, ''), quality: result.metadata?.quality };
}

/**
 * @param {Buffer} buffer        raw RFC 822 message
 * @param {object} [options]
 * @param {string} [options.filename]
 * @param {'de'|'en'} [options.lang]   header labels, default de
 * @param {function} [options.extractHtml]  injectable (tests); defaults to lib/web.js extractHtml
 */
export async function extractEml(buffer, options = {}) {
  const { filename, lang } = options;
  const L = LABELS[lang === 'en' ? 'en' : 'de'];

  const email = await PostalMime.parse(buffer);
  const hasHeaders = email.from || email.subject || email.date || (email.to && email.to.length);
  if (!hasHeaders) {
    const err = new Error('Not an e-mail: no From/To/Subject/Date headers found. / Keine E-Mail: keine From/To/Subject/Date-Header gefunden.');
    err.code = 'not_email';
    throw err;
  }

  let body = '';
  let quality;
  if (email.html && email.html.trim()) {
    try {
      const converted = await htmlToMarkdown(email.html, filename, options.extractHtml);
      if (converted) { body = converted.markdown; quality = converted.quality; }
    } catch (err) {
      console.warn('E-mail HTML part failed to convert, using plain text:', err.message);
    }
  }
  if (!body && email.text) body = email.text;
  body = tidy(body);

  const subject = (email.subject || '').trim() || L.noSubject;
  const from = formatAddress(email.from);
  const to = formatList(email.to);
  const cc = formatList(email.cc);
  const date = email.date ? formatDate(email.date, lang) : null;

  const headerLines = [];
  if (from) headerLines.push(`**${L.from}:** ${from}`);
  if (to) headerLines.push(`**${L.to}:** ${to}`);
  if (cc) headerLines.push(`**${L.cc}:** ${cc}`);
  if (date) headerLines.push(`**${L.date}:** ${date}`);

  let markdown = `# ${subject}\n\n`;
  if (headerLines.length) markdown += headerLines.join('  \n') + '\n\n---\n\n';
  if (body) markdown += body + '\n';

  const attachmentNames = (email.attachments || [])
    .filter((a) => a.disposition !== 'inline' || !a.contentId)
    .map((a) => a.filename)
    .filter(Boolean);
  if (attachmentNames.length) {
    markdown += `\n---\n\n${L.attachments}: ${attachmentNames.join(', ')}\n`;
  }

  const publishedTime = email.date && !isNaN(new Date(email.date)) ? new Date(email.date).toISOString() : undefined;
  return {
    markdown,
    title: subject,
    source: 'email',
    metadata: {
      title: subject,
      sourceUrl: null,
      author: from || undefined,
      publishedTime,
      quality,
      contentLength: body.length,
    },
  };
}
