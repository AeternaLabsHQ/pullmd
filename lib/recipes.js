import { z } from 'zod';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import * as cheerio from 'cheerio';
import { rawFrontmatterAllowlist, RESERVED_FRONTMATTER_FIELDS } from './frontmatter.js';

const ActionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('remove-attr'),    selector: z.string().min(1), attr:  z.string().min(1) }),
  z.object({ action: z.literal('remove-class'),   selector: z.string().min(1), class: z.string().min(1) }),
  z.object({ action: z.literal('remove-element'), selector: z.string().min(1) }),
  z.object({ action: z.literal('unwrap'),         selector: z.string().min(1) }),
]);

const FetchSchema = z.object({
  render:          z.enum(['force', 'skip']).optional(),
  wait_for:        z.string().min(1).optional(),
  wait_timeout_ms: z.number().int().min(0).max(15000).optional(),
  mobile_ua:       z.boolean().optional(),
  pdf:             z.enum(['ocr']).optional(),
}).strict();

// `remove` is subtractive (drop these elements); `content` is positive (THIS is
// the article). A non-empty `content` bypasses Readability's candidate scoring
// entirely — see selectRecipeContent in lib/web.js.
const SelectSchema = z.object({
  remove:  z.array(z.string().min(1)).default([]),
  content: z.array(z.string().min(1)).default([]),
}).strict();

// A single frontmatter field descriptor: exactly one of `jsonld` (dot-path into
// the selected JSON-LD node) or `selector` (CSS selector; text of first match).
const FrontmatterFieldSchema = z.object({
  jsonld:   z.string().min(1).optional(),
  selector: z.string().min(1).optional(),
}).strict().refine(
  (v) => (v.jsonld === undefined) !== (v.selector === undefined),
  { message: 'field must have exactly one of "jsonld" or "selector"' },
);

// Field names: letter-led, letters/digits/underscore/hyphen, ≤64 chars.
const FrontmatterFieldName = z.string().regex(
  /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/,
  { message: 'invalid frontmatter field name' },
);

const FrontmatterSchema = z.object({
  jsonld: z.object({ type: z.string().min(1) }).strict().optional(),
  fields: z.record(FrontmatterFieldName, FrontmatterFieldSchema)
    .refine((o) => Object.keys(o).length > 0, { message: 'frontmatter.fields must be non-empty' }),
}).strict().superRefine((v, ctx) => {
  const usesJsonld = Object.values(v.fields).some((f) => f && f.jsonld !== undefined);
  if (usesJsonld && !v.jsonld) {
    ctx.addIssue({
      code: 'custom',
      path: ['jsonld'],
      message: 'frontmatter.jsonld.type is required when a field uses a "jsonld" source',
    });
  }
  // A recipe cannot redefine a pipeline-computed field (provenance, share/cache
  // bookkeeping, media/LLM-usage fields) — only metadata-derived fields
  // (title/author/published/...) are legitimately overridable. See
  // RESERVED_FRONTMATTER_FIELDS in lib/frontmatter.js for the exact set.
  for (const key of Object.keys(v.fields)) {
    if (RESERVED_FRONTMATTER_FIELDS.has(key)) {
      ctx.addIssue({
        code: 'custom',
        path: ['fields', key],
        message: `frontmatter field name "${key}" is reserved`,
      });
    }
  }
});

export const RecipeSchema = z.object({
  name:       z.string().min(1),
  host:       z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]),
  path:       z.string().min(1).default('/**'),
  preprocess: z.array(ActionSchema).default([]),
  select:     SelectSchema.default({ remove: [], content: [] }),
  extractor:  z.enum(['readability', 'trafilatura', 'playwright']).optional(),
  fetch:      FetchSchema.default({}),
  frontmatter: FrontmatterSchema.optional(),
}).strict();

let cachedState = null;

function loadOneFile(filePath) {
  if (!filePath || !fs.existsSync(filePath)) {
    return { loaded: [], rejected: [], present: false };
  }
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    console.warn(`[recipes] cannot read ${filePath}: ${err.message}`);
    return { loaded: [], rejected: [], present: true };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    console.warn(`[recipes] ${filePath} is not valid JSON: ${err.message}`);
    return { loaded: [], rejected: [], present: true };
  }
  if (!Array.isArray(parsed)) {
    console.warn(`[recipes] ${filePath} root must be an array`);
    return { loaded: [], rejected: [], present: true };
  }

  const loaded = [];
  const rejected = [];
  const seenNames = new Set();
  parsed.forEach((entry, index) => {
    const result = RecipeSchema.safeParse(entry);
    if (!result.success) {
      const msg = result.error.issues
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ');
      console.warn(`[recipes] ${filePath} — recipe #${index} rejected: ${msg}`);
      rejected.push({ index, name: entry?.name ?? null, message: msg });
      return;
    }
    if (seenNames.has(result.data.name)) {
      console.warn(`[recipes] ${filePath} — duplicate name "${result.data.name}", later entry wins`);
      const existingIdx = loaded.findIndex((r) => r.name === result.data.name);
      if (existingIdx >= 0) loaded.splice(existingIdx, 1);
    }
    seenNames.add(result.data.name);
    loaded.push(result.data);
  });
  return { loaded, rejected, present: true };
}

function resolveUserPath() {
  const env = process.env.PULLMD_SITE_RECIPES;
  if (env) return env;  // explicit always wins
  const auto = path.resolve(process.cwd(), 'data/site-recipes.json');
  return fs.existsSync(auto) ? auto : null;
}

export function loadRecipes(opts = {}) {
  const defaultPath = opts.defaultPath ?? path.resolve(process.cwd(), 'site-recipes.default.json');
  const userPath = opts.userPath ?? resolveUserPath();

  const sources = [];
  let allLoaded = [];
  let totalRejected = 0;

  for (const filePath of [defaultPath, userPath]) {
    if (!filePath) continue;
    const { loaded, rejected, present } = loadOneFile(filePath);
    if (!present) continue;
    sources.push({ path: filePath, loaded: loaded.length, rejected: rejected.length });
    allLoaded = allLoaded.concat(loaded);
    totalRejected += rejected.length;
    console.log(`[recipes] loaded ${filePath}: ${loaded.length} ok, ${rejected.length} rejected`);
  }

  // When PULLMD_FRONTMATTER_FIELDS is set it is a strict allowlist: recipe
  // frontmatter fields not on it are dropped from the output. Surface which
  // fields that affects (log + status) so a contributor can see WHY a field
  // vanished. Computable at boot: the allowlist is env, the fields are static.
  const rawAllow = rawFrontmatterAllowlist();
  const filteredFrontmatterFields = [];
  if (rawAllow) {
    for (const r of allLoaded) {
      if (!r.frontmatter?.fields) continue;
      const dropped = Object.keys(r.frontmatter.fields).filter((k) => !rawAllow.has(k));
      if (dropped.length) {
        filteredFrontmatterFields.push({ recipe: r.name, fields: dropped });
        console.warn(`[recipes] recipe "${r.name}": frontmatter field(s) dropped by PULLMD_FRONTMATTER_FIELDS allowlist: ${dropped.join(', ')}`);
      }
    }
  }

  cachedState = {
    recipes: allLoaded,
    status: {
      loaded: allLoaded.length,
      rejected: totalRejected,
      sources,
      filteredFrontmatterFields,
    },
  };
  return cachedState;
}

export function getRecipeStatus() {
  if (!cachedState) return { loaded: 0, rejected: 0, sources: [], filteredFrontmatterFields: [] };
  return cachedState.status;
}

function globToRegex(glob) {
  // Escape every regex-special char EXCEPT '*'; then translate '*' to '.*'.
  const escaped = glob.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp('^' + escaped + '$', 'i');
}

export function hostMatches(pattern, host) {
  const patterns = Array.isArray(pattern) ? pattern : [pattern];
  return patterns.some((p) => globToRegex(p).test(host));
}

function pathGlobToRegex(glob) {
  // Translate ** before *, escape regex-specials in between.
  // Strategy: walk char-by-char, recognize ** and * tokens, escape literals.
  let result = '';
  let i = 0;
  while (i < glob.length) {
    if (glob[i] === '*' && glob[i + 1] === '*') {
      result += '.*';
      i += 2;
    } else if (glob[i] === '*') {
      result += '[^/]+';
      i += 1;
    } else {
      result += glob[i].replace(/[.+?^${}()|[\]\\]/g, '\\$&');
      i += 1;
    }
  }
  return new RegExp('^' + result + '$');
}

export function pathMatches(pattern, urlPath) {
  return pathGlobToRegex(pattern).test(urlPath);
}

export function mergeRecipes(recipes) {
  const result = {
    preprocess: [],
    removeSelectors: [],
    contentSelectors: [],
    extractor: undefined,
    fetch: {},
  };
  let fmFields = null;      // key-wise merge; later recipe wins on collision
  let fmJsonld;             // scalar last-wins
  for (const r of recipes) {
    result.preprocess = result.preprocess.concat(r.preprocess || []);
    result.removeSelectors = result.removeSelectors.concat(r.select?.remove || []);
    result.contentSelectors = result.contentSelectors.concat(r.select?.content || []);
    if (r.extractor !== undefined) result.extractor = r.extractor;
    if (r.fetch) {
      for (const key of ['render', 'wait_for', 'wait_timeout_ms', 'mobile_ua', 'pdf']) {
        if (r.fetch[key] !== undefined) result.fetch[key] = r.fetch[key];
      }
    }
    if (r.frontmatter) {
      if (r.frontmatter.fields) fmFields = { ...(fmFields || {}), ...r.frontmatter.fields };
      if (r.frontmatter.jsonld !== undefined) fmJsonld = r.frontmatter.jsonld;
    }
  }
  if (fmFields) {
    result.frontmatter = { fields: fmFields };
    if (fmJsonld !== undefined) result.frontmatter.jsonld = fmJsonld;
  }
  return result;
}

export function matchRecipesAgainst(recipes, url) {
  const host = url.hostname;
  const urlPath = url.pathname || '/';
  const matched = recipes.filter(
    (r) => hostMatches(r.host, host) && pathMatches(r.path || '/**', urlPath),
  );
  return mergeRecipes(matched);
}

export function matchRecipes(url) {
  if (!cachedState) return mergeRecipes([]);
  return matchRecipesAgainst(cachedState.recipes, url);
}

export function computeRecipesHash(filePaths) {
  const hash = createHash('sha256');
  for (const p of filePaths) {
    if (!p) continue;
    if (fs.existsSync(p)) {
      hash.update(p, 'utf8');
      hash.update('\n', 'utf8');
      hash.update(fs.readFileSync(p));
      hash.update('\n', 'utf8');
    }
  }
  return hash.digest('hex');
}

export function applyRecipesInvalidation(cache, newHash) {
  const oldHash = cache.getMeta('recipes_hash');
  if (oldHash !== newHash) {
    if (oldHash !== null) {
      // Hash truly changed across reboots — bump invalidation timestamp.
      // First boot (oldHash === null) does NOT bump: existing cache rows stay valid
      // until the operator actually changes recipes.
      const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
      cache.setRecipesInvalidatedAt(now);
    }
    cache.setMeta('recipes_hash', newHash);
  }
}

export function applyPreprocessActions(html, actions) {
  if (!html || typeof html !== 'string') return html;
  if (!actions || actions.length === 0) return html;

  const $ = cheerio.load(html, { decodeEntities: false });
  for (const action of actions) {
    switch (action.action) {
      case 'remove-attr':
        $(action.selector).removeAttr(action.attr);
        break;
      case 'remove-class':
        $(action.selector).each((_, el) => {
          const $el = $(el);
          const cls = $el.attr('class');
          if (!cls) return;
          const tokens = cls.split(/\s+/).filter((t) => t && t !== action.class);
          if (tokens.length === 0) $el.removeAttr('class');
          else $el.attr('class', tokens.join(' '));
        });
        break;
      case 'remove-element':
        $(action.selector).remove();
        break;
      case 'unwrap':
        $(action.selector).each((_, el) => {
          const $el = $(el);
          $el.replaceWith($el.contents());
        });
        break;
    }
  }
  return $.html();
}
