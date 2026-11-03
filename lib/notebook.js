// Jupyter notebooks (.ipynb, nbformat 4): Markdown cells as they are, code
// cells and their text outputs as code blocks, images as a short placeholder.
import { decodeTextFile, filenameStem, firstAtxHeading } from './text-decode.js';
import { unprocessable } from './mail-render.js';
import { fence } from './datafile.js';

const LABELS = {
  de: { image: '*[Bildausgabe]*' },
  en: { image: '*[image output]*' },
};

// CSI sequences (colors, cursor moves) and OSC sequences (titles, links).
const ANSI_RE = /\x1b\[[0-9;?]*[ -\/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;

export function isNotebookFile(contentType, filename) {
  if (/\.ipynb$/i.test(filename || '')) return true;
  if (/\.[^./\\]+$/.test(filename || '')) return false;
  return /^application\/x-ipynb\+json\b/i.test(contentType || '');
}

function joinSource(value) {
  if (Array.isArray(value)) return value.map((v) => String(v ?? '')).join('');
  return value == null ? '' : String(value);
}

function stripAnsi(text) {
  return text.replace(ANSI_RE, '');
}

function clean(text) {
  return stripAnsi(text).replace(/\r\n?/g, '\n').trimEnd();
}

function renderOutput(output, L) {
  const type = output?.output_type;
  if (type === 'stream') {
    const text = clean(joinSource(output.text));
    return text ? fence(text, 'text') : '';
  }
  if (type === 'execute_result' || type === 'display_data') {
    const data = output.data || {};
    const md = joinSource(data['text/markdown']).trim();
    if (md) return stripAnsi(md);
    // A plot's text/plain is only "<Figure size ...>": the placeholder says more.
    if (Object.keys(data).some((k) => k.startsWith('image/'))) return L.image;
    const plain = clean(joinSource(data['text/plain']));
    return plain ? fence(plain, 'text') : '';
  }
  if (type === 'error') {
    const head = [output.ename, output.evalue].filter(Boolean).join(': ');
    const trace = clean(Array.isArray(output.traceback) ? output.traceback.join('\n') : joinSource(output.traceback));
    const text = [head, trace].filter(Boolean).join('\n');
    return text ? fence(clean(text), 'text') : '';
  }
  return '';
}

/**
 * @param {Buffer} buffer
 * @param {object} [options]
 * @param {string} [options.filename]
 * @param {'de'|'en'} [options.lang]  placeholder language
 */
export async function extractNotebook(buffer, options = {}) {
  const { filename, lang = 'de' } = options;
  const L = LABELS[lang === 'en' ? 'en' : 'de'];
  let nb;
  try {
    nb = JSON.parse(decodeTextFile(buffer));
  } catch {
    nb = null;
  }
  if (!nb || typeof nb !== 'object' || Array.isArray(nb.worksheets) || !Array.isArray(nb.cells) || (nb.nbformat && nb.nbformat < 4)) {
    throw unprocessable(
      'This is not a Jupyter notebook in nbformat 4. / Das ist kein Jupyter-Notebook im Format nbformat 4.',
      'not_notebook',
    );
  }

  if (!nb.cells.length) {
    throw unprocessable('The notebook has no cells. / Das Notebook enthält keine Zellen.', 'empty_file');
  }

  const meta = nb.metadata || {};
  const language = String(meta.language_info?.name || meta.kernelspec?.language || 'python').toLowerCase();
  const cells = nb.cells.filter((c) => c && typeof c === 'object');

  let title = typeof meta.title === 'string' && meta.title.trim() ? meta.title.trim() : null;
  let dropFirstH1 = false;
  if (!title) {
    for (const cell of cells) {
      if (cell.cell_type !== 'markdown') continue;
      const h = firstAtxHeading(joinSource(cell.source));
      if (h) { title = h.text; break; }
    }
    if (title && cells[0]?.cell_type === 'markdown') {
      const h = firstAtxHeading(joinSource(cells[0].source).replace(/^\s*\n/, ''));
      dropFirstH1 = !!h && h.index === 0 && h.text === title;
    }
  }
  if (!title) title = filenameStem(filename) || 'Notebook';

  const parts = [];
  cells.forEach((cell, i) => {
    const src = joinSource(cell.source).replace(/\r\n?/g, '\n');
    if (cell.cell_type === 'markdown') {
      let text = src;
      if (i === 0 && dropFirstH1) text = text.replace(/^\s*\n/, '').replace(/^[^\n]*\n?/, '');
      text = text.trim();
      if (text) parts.push(text);
    } else if (cell.cell_type === 'code') {
      const code = src.trimEnd();
      if (code) parts.push(fence(code, language));
      for (const output of Array.isArray(cell.outputs) ? cell.outputs : []) {
        const rendered = renderOutput(output, L);
        if (rendered) parts.push(rendered);
      }
    } else if (cell.cell_type === 'raw') {
      const text = src.trimEnd();
      if (text) parts.push(fence(text));
    }
  });

  const body = parts.join('\n\n');
  const metadata = { title, sourceUrl: null, contentLength: body.length };
  const firstAuthor = Array.isArray(meta.authors) ? meta.authors[0] : null;
  const author = typeof firstAuthor === 'string' ? firstAuthor : firstAuthor?.name;
  if (typeof author === 'string' && author.trim()) metadata.author = author.trim();

  return {
    markdown: `# ${title}\n\n${body ? body + '\n' : ''}`,
    title,
    source: 'notebook',
    metadata,
  };
}
