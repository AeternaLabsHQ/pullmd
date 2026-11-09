// Builds a small client-side search index from the docs sources (one entry per page section)
// and the generated API operations, exposed as plugin global data for the search modal.
const fs = require('node:fs');
const path = require('node:path');

const slugify = (s) => s.toLowerCase().trim().replace(/[`*_~[\]()<>{}!?.,:;"'\/\\|@#$%^&+=]/g, '').replace(/\s+/g, '-');
const strip = (s) => s
  .replace(/^---[\s\S]*?---\n/, '')
  .replace(/^(import|export) .*$/gm, '')
  .replace(/```[\s\S]*?```/g, ' ')
  .replace(/^\s*\|?\s*:?-{2,}.*$/gm, ' ')
  .replace(/<[^>]+>/g, ' ')
  .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
  .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
  .replace(/[*_`>#|]/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

function walk(dir, out = []) {
  for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, f.name);
    if (f.isDirectory()) walk(p, out);
    else if (/\.mdx?$/.test(f.name)) out.push(p);
  }
  return out;
}

function routeFor(file, docsDir, fm) {
  if (fm.slug) return fm.slug.startsWith('/') ? fm.slug : '/' + fm.slug;
  let rel = path.relative(docsDir, file).replace(/\.mdx?$/, '').split(path.sep).map((s) => s.replace(/^\d+-/, '')).join('/');
  rel = rel.replace(/(^|\/)index$/, '');
  return '/' + rel;
}

module.exports = function searchIndex(context) {
  return {
    name: 'search-index',
    async loadContent() {
      const docsDir = path.join(context.siteDir, 'docs');
      const entries = [];
      for (const file of walk(docsDir)) {
        const src = fs.readFileSync(file, 'utf8');
        const fmBlock = (src.match(/^---\n([\s\S]*?)\n---/) || [])[1] || '';
        const fm = Object.fromEntries(fmBlock.split('\n').map((l) => l.match(/^(\w+):\s*"?(.*?)"?\s*$/)).filter(Boolean).map((m) => [m[1], m[2]]));
        const route = routeFor(file, docsDir, fm);
        const crumb = file.includes(`${path.sep}reference${path.sep}api${path.sep}`) ? 'API reference' : path.relative(docsDir, path.dirname(file)).split(path.sep).filter(Boolean).map((s) => s.replace(/^\d+-/, '').replace(/-/g, ' ')).join(' › ');
        const title = fm.title || route;
        const opJson = (src.match(/generated\/api\/([\w-]+)\.json/) || [])[1];
        if (opJson) {
          const op = JSON.parse(fs.readFileSync(path.join(context.siteDir, 'src/generated/api', `${opJson}.json`), 'utf8'));
          entries.push({ t: op.summary, s: '', u: route, c: crumb, x: `${op.method} ${op.path} ${op.description}`.slice(0, 300), m: op.method });
          continue;
        }
        const body = src.replace(/^---[\s\S]*?---\n/, '');
        const parts = body.split(/^(##+ .*)$/m);
        entries.push({ t: title, s: '', u: route, c: crumb, x: strip(parts[0]).slice(0, 300) });
        for (let i = 1; i < parts.length; i += 2) {
          const h = parts[i].replace(/^#+\s*/, '').replace(/<[^>]+>/g, '').trim();
          entries.push({ t: title, s: h, u: `${route}#${slugify(h)}`, c: crumb, x: strip(parts[i + 1] || '').slice(0, 300) });
        }
      }
      return entries;
    },
    async contentLoaded({ content, actions }) {
      actions.setGlobalData({ entries: content });
    },
  };
};
