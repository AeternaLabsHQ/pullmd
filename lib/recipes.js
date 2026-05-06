import { z } from 'zod';
import fs from 'node:fs';
import path from 'node:path';

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
}).strict();

const SelectSchema = z.object({
  remove: z.array(z.string().min(1)).default([]),
}).strict();

export const RecipeSchema = z.object({
  name:       z.string().min(1),
  host:       z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]),
  path:       z.string().min(1).default('/**'),
  preprocess: z.array(ActionSchema).default([]),
  select:     SelectSchema.default({ remove: [] }),
  extractor:  z.enum(['readability', 'trafilatura', 'playwright']).optional(),
  fetch:      FetchSchema.default({}),
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

  cachedState = {
    recipes: allLoaded,
    status: {
      loaded: allLoaded.length,
      rejected: totalRejected,
      sources,
    },
  };
  return cachedState;
}

export function getRecipeStatus() {
  if (!cachedState) return { loaded: 0, rejected: 0, sources: [] };
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
