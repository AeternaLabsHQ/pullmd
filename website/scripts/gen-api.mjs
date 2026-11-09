#!/usr/bin/env node
// Generates the API reference from the OpenAPI spec named in site.config.ts:
//   docs/reference/api/index.mdx                      overview (base URL, auth, endpoint list)
//   docs/reference/api/<tag>/<operation>.mdx         one page per operation
//   src/generated/api/<operationId>.json             resolved data each page renders
// Run `npm run gen-api` after changing the spec. Generated files are not edited by hand.
import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const cfg = fs.readFileSync(path.join(root, 'site.config.ts'), 'utf8');
const specRel = (cfg.match(/openapiSpec:\s*'([^']*)'/) || [])[1];
const outDocs = path.join(root, 'docs/reference/api');
const outData = path.join(root, 'src/generated/api');
fs.rmSync(outDocs, { recursive: true, force: true });
fs.rmSync(outData, { recursive: true, force: true });
if (!specRel) { console.log('No openapiSpec in site.config.ts: API reference disabled.'); process.exit(0); }

const raw = fs.readFileSync(path.join(root, specRel), 'utf8');
const spec = specRel.endsWith('.json') ? JSON.parse(raw) : yaml.load(raw);

// ---------- $ref resolution (local refs, cycle-safe) ----------
function lookup(ref) {
  return ref.replace(/^#\//, '').split('/').reduce((o, k) => o?.[k.replace(/~1/g, '/').replace(/~0/g, '~')], spec);
}
function deref(node, seen = new Set()) {
  if (Array.isArray(node)) return node.map((n) => deref(n, seen));
  if (!node || typeof node !== 'object') return node;
  if (node.$ref) {
    if (seen.has(node.$ref)) return { type: 'object', description: `Recursive reference to ${node.$ref.split('/').pop()}` };
    const next = new Set(seen); next.add(node.$ref);
    const { $ref, ...rest } = node;
    return deref({ ...lookup($ref), ...rest }, next);
  }
  const out = {};
  for (const [k, v] of Object.entries(node)) out[k] = deref(v, seen);
  // allOf: merge the parts into one schema, so fields and descriptions render as if written inline.
  if (out.allOf) {
    const { allOf, ...rest } = out;
    const merged = Object.assign({}, ...allOf, rest);
    const props = allOf.map((x) => x.properties).filter(Boolean);
    if (props.length || rest.properties) merged.properties = Object.assign({}, ...props, rest.properties);
    const req = [...new Set(allOf.flatMap((x) => x.required || []).concat(rest.required || []))];
    if (req.length) merged.required = req;
    return merged;
  }
  return out;
}

// ---------- example values from schemas ----------
function exampleFor(s, depth = 0) {
  if (!s || depth > 8) return null;
  if (s.example !== undefined) return s.example;
  if (s.default !== undefined) return s.default;
  if (s.enum?.length) return s.enum[0];
  if (s.allOf) return Object.assign({}, ...s.allOf.map((x) => exampleFor(x, depth + 1)));
  if (s.oneOf || s.anyOf) return exampleFor((s.oneOf || s.anyOf).find((x) => x.type !== 'null') || {}, depth + 1);
  const t = Array.isArray(s.type) ? s.type.find((x) => x !== 'null') : s.type;
  if (t === 'object' || s.properties) {
    const o = {};
    for (const [k, v] of Object.entries(s.properties || {})) o[k] = exampleFor(v, depth + 1);
    return o;
  }
  if (t === 'array') return [exampleFor(s.items || {}, depth + 1)];
  if (t === 'integer' || t === 'number') return 0;
  if (t === 'boolean') return true;
  if (s.format === 'date-time') return '2026-01-01T00:00:00Z';
  if (s.format === 'uuid') return '3c90c3cc-0d44-4b50-8888-8dd25736052a';
  return '<string>';
}

// `example`, else the first of `examples`, else one built from the schema.
function mediaExample(media) {
  if (!media) return null;
  if (media.example !== undefined) return media.example;
  const first = Object.values(media.examples || {})[0];
  if (first?.value !== undefined) return first.value;
  return exampleFor(media.schema);
}

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const esc = (s) => String(s ?? '').replace(/"/g, '\\"').replace(/\n/g, ' ');
const servers = (spec.servers || []).map((s) => s.url);
const schemes = deref(spec.components?.securitySchemes || {});
const tagMeta = Object.fromEntries((spec.tags || []).map((t) => [t.name, t]));
const methods = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'];

fs.mkdirSync(outDocs, { recursive: true });
fs.mkdirSync(outData, { recursive: true });
const byTag = new Map();
let tagPos = 1;

for (const [p, item] of Object.entries(spec.paths || {})) {
  for (const m of methods) {
    const op0 = item[m];
    if (!op0) continue;
    const op = deref(op0);
    const params = [...deref(item.parameters || []), ...(op.parameters || [])];
    const id = op.operationId || slug(`${m}-${p}`);
    const tag = op.tags?.[0] || 'Endpoints';
    const secReqs = op.security ?? spec.security ?? [];
    const security = secReqs.flatMap((req) =>
      Object.keys(req).map((name) => ({ name, ...schemes[name] })));
    // An empty requirement ({}) in the list means the call also works without credentials.
    const securityOptional = secReqs.some((req) => Object.keys(req).length === 0);
    const body = op.requestBody;
    const bodyType = body ? Object.keys(body.content || {})[0] : null;
    const bodySchema = bodyType ? body.content[bodyType].schema : null;
    const data = {
      id, method: m.toUpperCase(), path: p, servers,
      summary: op.summary || id, description: op.description || '',
      deprecated: !!op.deprecated, security, securityOptional,
      params: {
        path: params.filter((x) => x.in === 'path'),
        query: params.filter((x) => x.in === 'query'),
        header: params.filter((x) => x.in === 'header'),
        cookie: params.filter((x) => x.in === 'cookie'),
      },
      body: body ? {
        required: !!body.required, contentType: bodyType, description: body.description || '',
        schema: bodySchema, example: mediaExample(body.content[bodyType]),
      } : null,
      responses: Object.entries(op.responses || {}).map(([status, r]) => {
        const ct = r.content ? Object.keys(r.content)[0] : null;
        const schema = ct ? r.content[ct].schema : null;
        const headers = Object.entries(r.headers || {}).map(([name, h]) => ({
          name, description: h.description || '', schema: h.schema || { type: 'string' },
        }));
        const contents = Object.entries(r.content || {}).map(([type, c]) => ({ contentType: type, schema: c.schema || null }));
        return { status, description: r.description || '', contentType: ct, schema, headers, contents,
                 example: ct ? mediaExample(r.content[ct]) : null };
      }),
    };
    fs.writeFileSync(path.join(outData, `${id}.json`), JSON.stringify(data, null, 1));

    if (!byTag.has(tag)) byTag.set(tag, []);
    const list = byTag.get(tag);
    list.push(data);
    const dir = path.join(outDocs, slug(tag));
    fs.mkdirSync(dir, { recursive: true });
    if (list.length === 1) {
      fs.writeFileSync(path.join(dir, '_category_.json'), JSON.stringify({
        label: tag, position: tagPos++, collapsible: false,
        ...(tagMeta[tag]?.description ? { description: tagMeta[tag].description } : {}),
      }, null, 2));
    }
    fs.writeFileSync(path.join(dir, `${slug(data.summary)}.mdx`), `---
title: "${esc(data.summary)}"
sidebar_label: "${esc(data.summary)}"
sidebar_position: ${list.length}
sidebar_class_name: "api-method ${m}"
description: "${esc(data.description || `${data.method} ${p}`)}"
hide_table_of_contents: true
hide_title: true
displayed_sidebar: api
---

import op from '@site/src/generated/api/${id}.json';
import ApiOperation from '@site/src/components/api/ApiOperation';

<ApiOperation op={op} />
`);
  }
}

// ---------- overview page ----------
const authLines = Object.entries(schemes).map(([name, s]) =>
  s.type === 'http' && s.scheme === 'bearer' ? `- **${name}**: send \`Authorization: Bearer <token>\`.${s.description ? ` ${s.description}` : ''} Each endpoint's page says whether it needs this.`
  : s.type === 'apiKey' ? `- **${name}**: send your API key in the \`${s.name}\` ${s.in}.`
  : `- **${name}**: ${s.type}${s.scheme ? ` (${s.scheme})` : ''}.`).join('\n');
const endpointRows = [...byTag.entries()].map(([tag, ops]) =>
  `### ${tag}\n\n${tagMeta[tag]?.description ? tagMeta[tag].description + '\n\n' : ''}| | Endpoint | |\n|---|---|---|\n` +
  ops.map((o) => `| <Method m="${o.method}" /> | \`${o.path}\` | [${o.summary}](/reference/api/${slug(tag)}/${slug(o.summary)}) |`).join('\n')).join('\n\n');
fs.writeFileSync(path.join(outDocs, 'index.mdx'), `---
title: "API reference"
sidebar_label: "Overview"
sidebar_position: 0
description: "${esc(spec.info?.description?.split('\n')[0] || `${spec.info?.title} reference`)}"
displayed_sidebar: api
---

# API reference

${spec.info?.description?.trim() || ''}

## Base URL

${servers.map((s) => `\`\`\`\n${s}\n\`\`\``).join('\n\n') || 'Not specified.'}

## Authentication

${authLines || 'No authentication.'}

## OpenAPI specification

Download the full spec to import into Postman or Insomnia, generate a client, or give to an AI tool: [openapi${path.extname(specRel)}](pathname:///openapi${path.extname(specRel)}).

## Endpoints

${endpointRows}
`);
// Serve the spec as a static file (dev server and build), at the same path the overview links to.
fs.mkdirSync(path.join(root, 'static'), { recursive: true });
fs.copyFileSync(path.join(root, specRel), path.join(root, 'static', `openapi${path.extname(specRel)}`));
const n = [...byTag.values()].reduce((a, b) => a + b.length, 0);
console.log(`Generated ${n} operation pages in ${byTag.size} groups from ${specRel}.`);
