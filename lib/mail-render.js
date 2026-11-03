// Shared Markdown rendering for e-mails (.eml via postal-mime, .msg via
// msgreader). Callers normalize the message into plain strings first.

const MIN_HTML_CONTENT_CHARS = 200;

const LABELS = {
  de: { from: 'Von', to: 'An', cc: 'Cc', bcc: 'Bcc', date: 'Datum', noSubject: '(kein Betreff)', attachments: 'Anhänge (nicht umgewandelt)' },
  en: { from: 'From', to: 'To', cc: 'Cc', bcc: 'Bcc', date: 'Date', noSubject: '(no subject)', attachments: 'Attachments (not converted)' },
};

export function formatMailDate(value, lang) {
  const d = new Date(value);
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

async function webModule() {
  return import('./web.js');
}

/**
 * Pick the message body: the HTML part through the regular extraction
 * (strips newsletter chrome), else the plain-text part, else - for short
 * HTML-only mails the extraction rejects - a direct HTML conversion.
 */
async function mailBody({ html, text }, { filename, extractHtml, htmlFragmentToMarkdown }) {
  const hasHtml = typeof html === 'string' && html.trim();
  if (hasHtml) {
    try {
      const fn = extractHtml || (await webModule()).extractHtml;
      const result = await fn(html, { filename });
      if ((result.metadata?.contentLength ?? 0) >= MIN_HTML_CONTENT_CHARS) {
        // The HTML pipeline opens with its own "# <title>" line (plus a
        // "**file** · date" line with PULLMD_SOURCE_HEADER); the mail header
        // supplies both instead.
        const markdown = result.markdown.replace(/^# [^\n]*\n+(?:\*\*[^\n]*\*\* · [^\n]*\n+)?/, '');
        return { body: tidy(markdown), quality: result.metadata?.quality };
      }
    } catch (err) {
      console.warn('E-mail HTML part failed to convert:', err.message);
    }
  }
  if (typeof text === 'string' && text.trim()) return { body: tidy(text) };
  if (hasHtml) {
    const fn = htmlFragmentToMarkdown || (await webModule()).htmlFragmentToMarkdown;
    return { body: tidy(fn(html)) };
  }
  return { body: '' };
}

/**
 * @param {object} mail
 * @param {string} [mail.subject]
 * @param {string} [mail.from]   formatted "Name <addr>"
 * @param {string} [mail.to]     formatted, comma-separated
 * @param {string} [mail.cc]
 * @param {string} [mail.bcc]
 * @param {string|Date} [mail.date]
 * @param {string} [mail.html]
 * @param {string} [mail.text]
 * @param {string[]} [mail.attachmentNames]
 * @param {object} [options]  filename, lang, extractHtml, htmlFragmentToMarkdown
 */
export async function renderMail(mail, options = {}) {
  const { lang } = options;
  const L = LABELS[lang === 'en' ? 'en' : 'de'];
  const { body, quality } = await mailBody(mail, options);

  const subject = (mail.subject || '').trim() || L.noSubject;
  const date = mail.date ? formatMailDate(mail.date, lang) : null;

  const headerLines = [];
  if (mail.from) headerLines.push(`**${L.from}:** ${mail.from}`);
  if (mail.to) headerLines.push(`**${L.to}:** ${mail.to}`);
  if (mail.cc) headerLines.push(`**${L.cc}:** ${mail.cc}`);
  if (mail.bcc) headerLines.push(`**${L.bcc}:** ${mail.bcc}`);
  if (date) headerLines.push(`**${L.date}:** ${date}`);

  let markdown = `# ${subject}\n\n`;
  if (headerLines.length) markdown += headerLines.join('  \n') + '\n\n---\n\n';
  if (body) markdown += body + '\n';

  const names = (mail.attachmentNames || []).filter(Boolean);
  if (names.length) markdown += `\n---\n\n${L.attachments}: ${names.join(', ')}\n`;

  const d = mail.date ? new Date(mail.date) : null;
  return {
    markdown,
    title: subject,
    source: 'email',
    metadata: {
      title: subject,
      sourceUrl: null,
      author: mail.from || undefined,
      publishedTime: d && !isNaN(d) ? d.toISOString() : undefined,
      quality,
      contentLength: body.length,
    },
  };
}

/** Error the upload route answers with 422 (bad input, not an upstream failure). */
export function unprocessable(message, code) {
  const err = new Error(message);
  err.code = code;
  err.status = 422;
  return err;
}
