import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import archiver from 'archiver';
import pkg from '../package.json' with { type: 'json' };

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const PLACEHOLDER = '__PULLMD_URL__';
const VERSION_PLACEHOLDER = '__PULLMD_VERSION__';
const DISABLE_HISTORY_PLACEHOLDER = '__PULLMD_DISABLE_HISTORY_FLAG__';
export const PULLMD_VERSION = pkg.version;

/** Trim a trailing slash so substituted paths read like "<base>/api". */
function normalize(url) {
  if (!url) return url;
  return url.replace(/\/+$/, '');
}

/** Replace every `__PULLMD_URL__` occurrence. */
export function substituteUrl(text, baseUrl) {
  if (!text) return text;
  return text.split(PLACEHOLDER).join(normalize(baseUrl));
}

/** Replace both `__PULLMD_URL__` and `__PULLMD_VERSION__` placeholders. */
export function substituteVars(text, baseUrl, version = PULLMD_VERSION) {
  if (!text) return text;
  const withUrl = substituteUrl(text, baseUrl);
  return withUrl.split(VERSION_PLACEHOLDER).join(version);
}

/**
 * Determine the public base URL for this request.
 * Priority: env PUBLIC_URL → X-Forwarded-Proto/Host → req.protocol + req.host.
 */
export function publicUrlFor(req) {
  const env = process.env.PUBLIC_URL;
  if (env) return normalize(env);
  const proto = req.get('x-forwarded-proto') || req.protocol;
  const host = req.get('x-forwarded-host') || req.get('host');
  return `${proto}://${host}`;
}

/** Read public/help.html and public/index.html from disk and substitute placeholders. */
const HELP_PATH = path.join(REPO_ROOT, 'public', 'help.html');
const INDEX_PATH = path.join(REPO_ROOT, 'public', 'index.html');
let helpRaw = null;
let indexRaw = null;

function helpTemplate() {
  if (helpRaw === null) helpRaw = readFileSync(HELP_PATH, 'utf8');
  return helpRaw;
}
function indexTemplate() {
  if (indexRaw === null) indexRaw = readFileSync(INDEX_PATH, 'utf8');
  return indexRaw;
}

export function renderHelp(baseUrl) {
  return substituteVars(helpTemplate(), baseUrl);
}
export function renderIndex(baseUrl, opts = {}) {
  const out = substituteVars(indexTemplate(), baseUrl);
  const flag = opts.disablePublicHistory ? 'true' : 'false';
  return out.split(DISABLE_HISTORY_PLACEHOLDER).join(flag);
}

/**
 * Build the pullmd skill ZIP with `__PULLMD_URL__` replaced. Returns a
 * Buffer ready to send with content-type application/zip.
 *
 * Files inside the archive:
 *   pullmd/.claude-plugin/plugin.json
 *   pullmd/skills/pullmd/SKILL.md
 *   pullmd/hooks/hooks.json
 *
 * Only the canonical Claude-Code skill path (`skills/<name>/SKILL.md`) is
 * shipped — the legacy flat `skills/<name>.md` was never actually loaded
 * by Claude Code as a skill.
 */
const SKILL_ROOT = path.join(REPO_ROOT, 'skill', 'pullmd');
const SKILL_FILES = [
  '.claude-plugin/plugin.json',
  'skills/pullmd/SKILL.md',
  'hooks/hooks.json',
];

export function buildSkillZip(baseUrl) {
  return new Promise((resolve, reject) => {
    const archive = archiver('zip', { zlib: { level: 9 } });
    const chunks = [];
    archive.on('data', (c) => chunks.push(c));
    archive.on('end', () => resolve(Buffer.concat(chunks)));
    archive.on('warning', (err) => { if (err.code !== 'ENOENT') reject(err); });
    archive.on('error', reject);

    for (const rel of SKILL_FILES) {
      const abs = path.join(SKILL_ROOT, rel);
      let content;
      try {
        content = readFileSync(abs, 'utf8');
      } catch {
        continue;
      }
      archive.append(substituteVars(content, baseUrl), { name: `pullmd/${rel}` });
    }
    archive.finalize();
  });
}

/** Tiny in-process cache: one zip per distinct baseUrl. */
const zipCache = new Map();
export async function getSkillZip(baseUrl) {
  const key = normalize(baseUrl) || '';
  if (zipCache.has(key)) return zipCache.get(key);
  const buf = await buildSkillZip(key);
  zipCache.set(key, buf);
  return buf;
}

/** Test/dev hook so tests can re-read templates after edits. */
export function _resetCaches() {
  helpRaw = null;
  indexRaw = null;
  zipCache.clear();
}
