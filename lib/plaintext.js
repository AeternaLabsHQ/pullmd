// Plain text (.txt) and Markdown (.md) uploads: passed through as they are,
// with a "# title" line on top when the file has none, so the result looks
// like every other conversion and can carry frontmatter.
import { decodeTextFile, filenameStem, firstAtxHeading, looksBinary } from './text-decode.js';
import { unprocessable } from './mail-render.js';

export function plainTextKind(contentType, filename) {
  const name = filename || '';
  if (/\.(md|markdown)$/i.test(name)) return 'markdown';
  if (/\.(txt|rst|adoc|asciidoc|org|textile|wiki|nfo)$/i.test(name)) return 'text';
  // Structured formats belong to datafile.js, HTML to the web pipeline.
  if (/\.(csv|tsv|tab|json|jsonl|ndjson|geojson|xml|rss|atom|html?)$/i.test(name)) return null;
  // Any other extension: the content type alone does not make it text (an
  // "x.docx" sent as text/plain is still a Word file).
  if (/\.[^./\\]+$/.test(name)) return null;
  const ct = (contentType || '').split(';')[0].trim().toLowerCase();
  if (ct === 'text/markdown' || ct === 'text/x-markdown') return 'markdown';
  if (ct === 'text/plain') return 'text';
  return null;
}

function yamlScalar(v) {
  const s = v.trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) return s.slice(1, -1);
  return s;
}

/**
 * @param {Buffer} buffer
 * @param {object} [options]
 * @param {string} [options.filename]
 * @param {'text'|'markdown'} [options.kind]
 */
export async function extractPlainText(buffer, options = {}) {
  const { filename, kind = 'text' } = options;
  let text = decodeTextFile(buffer).replace(/\r\n?/g, '\n');
  if (looksBinary(text)) {
    throw unprocessable('This does not look like a text file. / Das sieht nicht nach einer Textdatei aus.', 'not_text');
  }
  if (!text.trim()) {
    throw unprocessable('The file is empty. / Die Datei ist leer.', 'empty_file');
  }

  let title = null;
  let ownFrontmatter = null;
  if (kind === 'markdown') {
    // A note's own YAML frontmatter (Obsidian & co.) would collide with
    // pullmd's block - keep it, visibly, as a yaml code block below the title.
    const fm = text.match(/^---\n([\s\S]*?)\n---[ \t]*(\n+|$)/);
    if (fm) {
      ownFrontmatter = fm[1];
      text = text.slice(fm[0].length);
      const t = ownFrontmatter.match(/^title:[ \t]*(.+)$/m);
      if (t) title = yamlScalar(t[1]) || null;
    }
    const h1 = firstAtxHeading(text);
    if (!title && h1) title = h1.text;
  }
  if (!title) title = filenameStem(filename) || (kind === 'markdown' ? 'Markdown' : 'Text');

  let body = text.replace(/^\n+/, '').trimEnd();
  const startsWithTitle = kind === 'markdown' && /^#[ \t]+/.test(body);
  let markdown = startsWithTitle ? '' : `# ${title}\n\n`;
  if (startsWithTitle) {
    const nl = body.indexOf('\n');
    markdown = (nl === -1 ? body : body.slice(0, nl)) + '\n\n';
    body = nl === -1 ? '' : body.slice(nl + 1).replace(/^\n+/, '');
  }
  if (ownFrontmatter) markdown += '```yaml\n' + ownFrontmatter + '\n```\n\n';
  if (body) markdown += body + '\n';

  return {
    markdown,
    title,
    source: kind,
    metadata: { title, sourceUrl: null, contentLength: body.length },
  };
}
