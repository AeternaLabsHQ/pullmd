// Source code, config and log files: the file as one fenced code block with
// the language taken from the extension (or the well-known file name).
import { decodeTextFile, looksBinary } from './text-decode.js';
import { unprocessable } from './mail-render.js';
import { fence } from './datafile.js';

const EXT_LANG = {
  py: 'python', pyw: 'python',
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'jsx',
  ts: 'typescript', tsx: 'tsx',
  java: 'java', kt: 'kotlin', kts: 'kotlin', scala: 'scala', groovy: 'groovy', gradle: 'groovy',
  c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp', hh: 'cpp',
  cs: 'csharp', go: 'go', rs: 'rust', rb: 'ruby', php: 'php', swift: 'swift',
  m: 'objectivec', mm: 'objectivec', dart: 'dart', lua: 'lua', pl: 'perl', pm: 'perl',
  r: 'r', jl: 'julia',
  sh: 'bash', bash: 'bash', zsh: 'zsh', fish: 'fish',
  ps1: 'powershell', psm1: 'powershell', bat: 'batch', cmd: 'batch',
  vb: 'vbnet', vbs: 'vbscript',
  sql: 'sql',
  css: 'css', scss: 'scss', sass: 'sass', less: 'less',
  vue: 'vue', svelte: 'svelte', astro: 'astro',
  yaml: 'yaml', yml: 'yaml', toml: 'toml', ini: 'ini', cfg: 'ini', conf: 'ini', properties: 'properties',
  tf: 'hcl', hcl: 'hcl', nix: 'nix',
  graphql: 'graphql', gql: 'graphql', proto: 'protobuf',
  diff: 'diff', patch: 'diff',
  dockerfile: 'dockerfile', makefile: 'makefile', mk: 'makefile', cmake: 'cmake',
  tex: 'latex', bib: 'bibtex',
  log: '',
  // .env is left out on purpose: it usually holds secrets and lands here by mistake.
};

const NAME_LANG = {
  dockerfile: 'dockerfile',
  containerfile: 'dockerfile',
  makefile: 'makefile',
  gnumakefile: 'makefile',
  jenkinsfile: 'groovy',
  vagrantfile: 'ruby',
  gemfile: 'ruby',
  rakefile: 'ruby',
  'cmakelists.txt': 'cmake',
};

const CT_LANG = {
  'text/x-python': 'python',
  'text/x-script.python': 'python',
  'text/javascript': 'javascript',
  'application/javascript': 'javascript',
  'application/x-javascript': 'javascript',
  'text/x-shellscript': 'bash',
  'application/x-sh': 'bash',
  'text/css': 'css',
  'application/x-yaml': 'yaml',
  'application/yaml': 'yaml',
  'text/yaml': 'yaml',
  'text/x-yaml': 'yaml',
  'application/toml': 'toml',
  'application/sql': 'sql',
  'text/x-diff': 'diff',
  'text/x-patch': 'diff',
};

function basename(filename) {
  return String(filename || '').split(/[\\/]/).pop();
}

/**
 * @returns {string|null} fence language ('' = plain text block), or null when
 *   the file is not a code/config/log file. Callers must test `!== null`.
 */
export function codeLanguage(contentType, filename) {
  const base = basename(filename).toLowerCase();
  if (Object.prototype.hasOwnProperty.call(NAME_LANG, base)) return NAME_LANG[base];
  if (/^(docker|container)file\./.test(base)) return 'dockerfile';
  const ext = base.match(/\.([^.]+)$/);
  if (ext) return Object.prototype.hasOwnProperty.call(EXT_LANG, ext[1]) ? EXT_LANG[ext[1]] : null;
  const ct = (contentType || '').split(';')[0].trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(CT_LANG, ct) ? CT_LANG[ct] : null;
}

/** MPEG transport stream (.ts video): 0x47 sync byte every 188 bytes. */
function isMpegTs(buf) {
  return buf.length >= 188 && buf[0] === 0x47 && buf[188] === 0x47
    && (buf.length < 377 || buf[376] === 0x47);
}

/** More than a few control characters (other than tab/newline/CR/FF) means binary. */
function mostlyControl(text) {
  const sample = text.slice(0, 8192);
  if (!sample) return false;
  const ctrl = sample.match(/[\x00-\x08\x0e-\x1a\x1c-\x1f\x7f]/g);
  return !!ctrl && ctrl.length / sample.length > 0.01;
}

/**
 * Drop blank (whitespace-only) lines at the very end, like
 * s.replace(/(?:\n[ \t\f\v]*)+$/, '') without its quadratic backtracking.
 */
function trimBlankLinesAtEnd(s) {
  let end = s.length;
  for (;;) {
    let j = end;
    while (j > 0 && ' \t\f\v'.includes(s[j - 1])) j--;
    if (j > 0 && s[j - 1] === '\n') end = j - 1;
    else break;
  }
  return s.slice(0, end);
}

/**
 * @param {Buffer} buffer
 * @param {object} [options]
 * @param {string} [options.filename]
 * @param {string} [options.language]  defaults to codeLanguage(null, filename)
 */
export async function extractCodeFile(buffer, options = {}) {
  const { filename } = options;
  const language = options.language ?? codeLanguage(null, filename) ?? '';
  const buf = Buffer.from(buffer);
  const decoded = decodeTextFile(buf);
  if (isMpegTs(buf) || looksBinary(decoded) || mostlyControl(decoded)) {
    throw unprocessable('This does not look like a text file. / Das sieht nicht nach einer Textdatei aus.', 'not_text');
  }
  // Byte-faithful apart from line endings and blank lines at the very end.
  const text = trimBlankLinesAtEnd(decoded.replace(/\r\n?/g, '\n'));
  if (!text.trim()) {
    throw unprocessable('The file is empty. / Die Datei ist leer.', 'empty_file');
  }

  const title = basename(filename) || 'Code';
  // "__init__.py" would otherwise render as bold "init.py".
  const heading = title.replace(/([\\*_`])/g, '\\$1');
  const body = fence(text, language);
  return {
    markdown: `# ${heading}\n\n${body}\n`,
    title,
    source: 'code',
    metadata: { title, sourceUrl: null, contentLength: text.length },
  };
}
