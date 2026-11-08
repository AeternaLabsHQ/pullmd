// AI-readable output, generated at build time:
//   /llms.txt          every page in the sidebars, grouped by sidebar section (https://llmstxt.org)
//   /<page>.md         a plain Markdown copy of every page, API reference included
//   /openapi.yaml|json the API spec, linked from llms.txt
const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');

const attr = (tag, name) => (tag.match(new RegExp(`\\b${name}="([^"]*)"`)) || [])[1];
const hasAttr = (tag, name) => new RegExp(`\\s${name}(\\s|/?>|$)`).test(tag);

// Inline JSX outside code spans: <Method m="GET" /> -> GET, <Badge>Latest</Badge> -> **Latest**, other tags dropped.
function inlineJsx(line) {
  return line.split(/(`[^`]*`)/).map((part, i) => (i % 2 ? part : part
    .replace(/<Method m="([A-Z]+)"\s*\/>/g, '$1')
    .replace(/<Badge[^>]*>([^<]*)<\/Badge>/g, '**$1**')
    .replace(/<\/?[A-Z][A-Za-z]*(\s[^>]*)?\/?>/g, ''))).join('');
}

// MDX source -> plain Markdown. Components become their Markdown equivalent, the indentation
// they add is removed, and code fences are copied verbatim (so placeholders like <URL> survive).
function mdxToMarkdown(src, link) {
  const body = src
    .replace(/^---[\s\S]*?---\n/, '')
    .replace(/^(import|export) .*$/gm, '');
  const out = [];
  const stack = [];       // open block components, for dedenting their children
  let fence = null;       // indentation of the open code fence
  let step = 0;
  let card = null;        // { title, href, text[] } while inside <Card>
  let param = null;       // { head, text[] } while inside <ParamField>
  const emit = (l) => {
    if (card) card.text.push(l.trim());
    else if (param) param.text.push(l.trim());
    else out.push(l);
  };
  const quote = () => stack.some((s) => s.quote);

  for (const raw of body.split('\n')) {
    const indent = raw.match(/^ */)[0].length;
    const line = raw.slice(Math.min(indent, stack.length * 2));
    if (fence !== null) {
      emit((quote() ? '> ' : '') + raw.slice(Math.min(fence, indent)));
      if (/^\s*```/.test(raw)) fence = null;
      continue;
    }
    if (/^\s*```/.test(raw)) {
      fence = indent;
      emit((quote() ? '> ' : '') + raw.trimStart());
      continue;
    }
    const t = raw.trim();
    const open = t.match(/^<([A-Z][A-Za-z]*)(\s[^>]*)?>(.*)$/);
    const close = t.match(/^<\/([A-Z][A-Za-z]*)>$/);
    if (close) {
      const name = close[1];
      if (name === 'Card' && card) {
        out.push(`- [${card.title}](${link(card.href)})${card.text.filter(Boolean).length ? `: ${inlineJsx(card.text.filter(Boolean).join(' '))}` : ''}`);
        card = null;
      } else if (name === 'ParamField' && param) {
        out.push(`- ${param.head}${param.text.filter(Boolean).length ? `: ${inlineJsx(param.text.filter(Boolean).join(' '))}` : ''}`);
        param = null;
      }
      stack.pop();
      if (['Steps', 'Tabs', 'AccordionGroup', 'CardGroup', 'Step', 'TabItem', 'Accordion', 'Note', 'Tip', 'Warning', 'Check'].includes(name)) out.push('');
      continue;
    }
    if (open && !/\/>$/.test(open[0]) && !open[0].includes(`</${open[1]}>`)) {
      const [tag, name] = open;
      const quoteBlock = ['Note', 'Tip', 'Warning', 'Check'].includes(name);
      stack.push({ name, quote: quoteBlock });
      if (name === 'Steps') step = 0;
      else if (name === 'Step') out.push(`**${++step}. ${attr(tag, 'title')}**`, '');
      else if (name === 'TabItem' || name === 'Accordion') out.push(`**${attr(tag, 'label') || attr(tag, 'title')}**`, '');
      else if (name === 'Card') card = { title: attr(tag, 'title'), href: attr(tag, 'href'), text: [] };
      else if (name === 'ParamField') {
        const meta = [attr(tag, 'type'), hasAttr(tag, 'required') && 'required', attr(tag, 'default') && `default \`${attr(tag, 'default')}\``].filter(Boolean);
        param = { head: `\`${attr(tag, 'name')}\`${meta.length ? ` (${meta.join(', ')})` : ''}`, text: [] };
      } else if (quoteBlock) out.push(`> **${attr(tag, 'title') || name}:**`);
      if (open[3].trim()) emit((quoteBlock ? '> ' : '') + inlineJsx(open[3]));
      continue;
    }
    // One-line callout: <Tip>text</Tip>
    const oneLine = t.match(/^<(Note|Tip|Warning|Check)(\s[^>]*)?>(.*)<\/\1>$/);
    if (oneLine) {
      emit(`${quote() ? '> ' : ''}> **${attr(t, 'title') || oneLine[1]}:** ${inlineJsx(oneLine[3])}`);
      continue;
    }
    emit((quote() && t ? '> ' : '') + inlineJsx(quote() ? t : line));
  }
  return out.join('\n')
    .replace(/\]\(((?:\/|pathname:\/\/\/)[^)\s]*)\)/g, (m, href) => `](${link(href)})`)
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// The part of the OpenAPI spec one operation needs: the operation itself plus every component it
// references, followed transitively, so the slice is a complete, valid spec on its own.
function sliceSpec(spec, method, opPath) {
  const pathItem = spec.paths?.[opPath] || {};
  const operation = pathItem[method.toLowerCase()];
  if (!operation) return null;
  const item = { [method.toLowerCase()]: operation };
  if (pathItem.parameters) item.parameters = pathItem.parameters;
  const components = {};
  const seen = new Set();
  const visit = (node) => {
    if (Array.isArray(node)) return node.forEach(visit);
    if (!node || typeof node !== 'object') return;
    const ref = typeof node.$ref === 'string' && node.$ref.match(/^#\/components\/([^/]+)\/(.+)$/);
    if (ref && !seen.has(node.$ref)) {
      seen.add(node.$ref);
      const [, kind, name] = ref;
      const target = spec.components?.[kind]?.[name];
      if (target) {
        (components[kind] ||= {})[name] = target;
        visit(target);
      }
    }
    Object.values(node).forEach(visit);
  };
  visit(item);
  const security = operation.security || spec.security;
  for (const req of security || []) {
    for (const name of Object.keys(req)) {
      const scheme = spec.components?.securitySchemes?.[name];
      if (scheme) (components.securitySchemes ||= {})[name] = scheme;
    }
  }
  const out = { openapi: spec.openapi, info: spec.info, servers: spec.servers };
  if (spec.security) out.security = spec.security;
  out.paths = { [opPath]: item };
  if (Object.keys(components).length) out.components = components;
  return out;
}

// Generated API operation -> Markdown: a short header, then the operation's slice of the spec,
// the same source the rendered page is generated from.
function operationToMarkdown(op, spec, yaml) {
  const slice = spec && sliceSpec(spec, op.method, op.path);
  if (!slice) throw new Error(`[ai-readable] ${op.method} ${op.path} is not in the OpenAPI spec`);
  const L = [`# ${op.summary}`, ''];
  if (op.description) L.push(`> ${firstSentence(op.description)}`, '');
  L.push(`\`${op.method.toUpperCase()} ${op.path}\``, '', '## OpenAPI', '');
  L.push(`\`\`\`\`yaml ${op.method.toLowerCase()} ${op.path}`, yaml.dump(slice, { noRefs: true, lineWidth: 100 }).trimEnd(), '````');
  return L.join('\n');
}


const firstSentence = (s = '') => {
  const m = s.trim().match(/^[\s\S]*?[.!?](?=\s|$)/);
  return (m ? m[0] : s).replace(/\s+/g, ' ').trim();
};

module.exports = function aiReadable(context, opts) {
  let docs = [];
  let sidebars = {};
  return {
    name: 'ai-readable',
    async allContentLoaded({ allContent }) {
      const version = allContent['docusaurus-plugin-content-docs']?.default?.loadedVersions?.[0];
      docs = version?.docs ?? [];
      sidebars = version?.sidebars ?? {};
    },
    async postBuild({ outDir, siteConfig }) {
      const base = siteConfig.url.replace(/\/$/, '') + siteConfig.baseUrl.replace(/\/$/, '');
      const mdRel = (permalink) => {
        const rel = permalink.replace(siteConfig.baseUrl, '/').replace(/\/$/, '') || '/index';
        return `${rel === '/' ? '/index' : rel}.md`;
      };
      // Site link in page content -> absolute URL of that page's Markdown copy.
      const link = (href = '') => {
        if (href.startsWith('pathname:///')) return `${base}/${href.slice('pathname:///'.length)}`;
        if (!href.startsWith('/')) return href;
        const [p, hash] = href.split('#');
        if (/\.\w+$/.test(p)) return base + href;
        return `${base}${mdRel(siteConfig.baseUrl + p.replace(/^\//, ''))}${hash ? `#${hash}` : ''}`;
      };

      let spec = null;
      const specSrc = opts.openapiSpec && path.join(context.siteDir, opts.openapiSpec);
      if (specSrc && fs.existsSync(specSrc)) {
        const raw = fs.readFileSync(specSrc, 'utf8');
        spec = specSrc.endsWith('.json') ? JSON.parse(raw) : yaml.load(raw);
      }
      // Every Markdown copy starts by pointing agents at the full index.
      const preamble = `> ## Documentation index\n> Fetch the complete documentation index at: ${base}/llms.txt\n> Use this file to discover all available pages before exploring further.\n\n`;

      const byId = new Map(docs.map((d) => [d.id, d]));
      const written = new Map();
      for (const d of docs) {
        const src = path.join(context.siteDir, d.source.replace('@site/', ''));
        if (!fs.existsSync(src)) continue;
        const text = fs.readFileSync(src, 'utf8');
        const opJson = (text.match(/generated\/api\/([\w-]+)\.json/) || [])[1];
        let md;
        if (opJson) {
          const op = JSON.parse(fs.readFileSync(path.join(context.siteDir, 'src/generated/api', `${opJson}.json`), 'utf8'));
          md = operationToMarkdown(op, spec, yaml);
        } else {
          md = mdxToMarkdown(text, link);
          if (!/^# /.test(md)) md = `# ${d.title}\n\n${md}`;
        }
        const rel = mdRel(d.permalink);
        const mdPath = path.join(outDir, rel);
        fs.mkdirSync(path.dirname(mdPath), { recursive: true });
        fs.writeFileSync(mdPath, preamble + md + '\n');
        written.set(d.id, rel);
      }

      // llms.txt mirrors the sidebars: one H2 per top-level category, H3 for nested ones.
      const lines = [`# ${opts.productName}`, '', `> ${opts.tagline}`];
      let specEntry = null;
      if (spec) {
        const name = `openapi${path.extname(specSrc)}`;
        fs.copyFileSync(specSrc, path.join(outDir, name));
        specEntry = `- [OpenAPI specification](${base}/${name}): Every endpoint, parameter and response, for importing into an API client or generating code.`;
      }
      const listed = new Set();
      const entry = (id, label) => {
        const d = byId.get(id);
        if (!d || !written.has(id)) return null;
        listed.add(id);
        const full = (d.description || '').replace(/\s+/g, ' ').trim();
        const desc = (full.length > 200 ? firstSentence(full) : full).replace(/\]\((\/[^)\s]*)\)/g, (m, href) => `](${link(href)})`);
        return `- [${label || d.title}](${base}${written.get(id)})${desc ? `: ${desc}` : ''}`;
      };
      // Pages directly under a heading, then each category as the next heading level down.
      const section = (items, level, heading, about) => {
        const own = items.filter((it) => it.type !== 'category').map((it) => entry(it.id, it.label)).filter(Boolean);
        if (specEntry && heading && heading === opts.sidebarTitles?.[opts.specSidebar]) { own.push(specEntry); specEntry = null; }
        if (heading) lines.push('', `${'#'.repeat(level)} ${heading}`);
        if (about) lines.push('', about);
        if (own.length) lines.push('', ...own);
        for (const cat of items.filter((it) => it.type === 'category')) {
          const catItems = cat.link?.type === 'doc' ? [{ type: 'doc', id: cat.link.id }, ...cat.items] : cat.items;
          section(catItems, Math.min(level + 1, 4), cat.label, cat.description || cat.link?.description);
        }
      };
      const order = opts.sidebarOrder || Object.keys(sidebars);
      for (const name of order.filter((n) => sidebars[n])) {
        const items = sidebars[name];
        // A sidebar of categories puts each category at H2; any other sidebar gets its own H2 title.
        if (items.every((it) => it.type === 'category')) section(items, 1, null);
        else section(items, 2, opts.sidebarTitles?.[name] || name);
      }
      if (specEntry) lines.push('', '## OpenAPI specification', '', specEntry);
      const missing = docs.filter((d) => !listed.has(d.id) && !d.unlisted && d.sidebar);
      if (missing.length) console.warn(`[ai-readable] in a sidebar but not in llms.txt: ${missing.map((d) => d.id).join(', ')}`);
      fs.writeFileSync(path.join(outDir, 'llms.txt'), lines.join('\n') + '\n');
    },
  };
};
