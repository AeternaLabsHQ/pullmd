/**
 * Builds a YAML frontmatter block from extraction metadata.
 *
 * Returns a string like:
 *   ---
 *   title: "..."
 *   url: https://...
 *   source: trafilatura
 *   fetched: 2026-04-25T13:53:00Z
 *   quality: 0.85
 *   ---
 *
 * Skips null/undefined fields. Quotes strings that contain YAML special chars.
 * Dates use ISO 8601 (UTC).
 */

function quoteYamlString(s) {
  if (s == null) return '';
  // Quote when truly ambiguous in YAML 1.2: ": " (key separator), " #" (comment),
  // newlines, quotes/backslashes, leading flow/special chars, or YAML keywords.
  if (
    /: |\t| #|[\r\n]|"|'|\\/.test(s) ||
    /^[\s>|!&*?{}[\]@`%-]/.test(s) ||
    /^(true|false|null|yes|no|on|off|~)$/i.test(s.trim())
  ) {
    return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\r\n]+/g, ' ')}"`;
  }
  return s;
}

function formatField(key, value) {
  if (value == null || value === '') return null;
  if (typeof value === 'number' || typeof value === 'boolean') return `${key}: ${value}`;
  if (Array.isArray(value)) {
    if (value.length === 0) return null;
    return `${key}:\n${value.map(v => `  - ${quoteYamlString(String(v))}`).join('\n')}`;
  }
  return `${key}: ${quoteYamlString(String(value))}`;
}

/**
 * The complete set of field names that any caller in this codebase can emit.
 * Used to validate PULLMD_FRONTMATTER_FIELDS and to filter unknown names.
 */
export const KNOWN_FRONTMATTER_FIELDS = new Set([
  'title', 'url', 'source', 'fetched', 'quality', 'author', 'published', 'modified',
  'description', 'language', 'image', 'site', 'extractor_reason', 'share_id', 'share_url',
  'duration', 'views', 'image_size', 'audio_seconds', 'pdf_pages',
  'subreddit', 'upvotes', 'images_transcribed',
  'llm_model', 'llm_tokens', 'llm_prompt_tokens', 'llm_completion_tokens',
  'cached', 'refreshed', 'age_ms',
  'extracted', 'extract_confidence', 'sections_selected', 'original_tokens', 'returned_tokens',
]);

/**
 * Frontmatter field names that are metadata-derived (scraped from generic
 * title/og/meta/twitter tags via extractMetadata) and therefore fair game for a
 * recipe to override — site-specific knowledge legitimately beats generic
 * scraping for these.
 */
export const OVERRIDABLE_FRONTMATTER_FIELDS = new Set([
  'title', 'author', 'published', 'modified', 'description', 'language', 'image', 'site',
]);

/**
 * Frontmatter field names the pipeline computes itself: provenance (source,
 * fetched, quality, extractor_reason), share/cache bookkeeping (share_id,
 * share_url, cached, refreshed, age_ms), and media/LLM-usage fields merged in
 * later via mergeMediaFrontmatter (duration, views, image_size, audio_seconds,
 * pdf_pages, subreddit, upvotes, images_transcribed, llm_*) plus the fetched url itself. A recipe
 * MUST NOT be able to define a `frontmatter.fields` key with one of these
 * names — enforced at recipe-schema validation time (lib/recipes.js
 * FrontmatterSchema), and defensively here in buildFrontmatter in case an
 * unvalidated recipeFields object ever reaches it.
 *
 * Derived as "everything in KNOWN_FRONTMATTER_FIELDS that is not overridable".
 */
export const RESERVED_FRONTMATTER_FIELDS = new Set(
  [...KNOWN_FRONTMATTER_FIELDS].filter((f) => !OVERRIDABLE_FRONTMATTER_FIELDS.has(f)),
);

/**
 * Returns a Set of allowed field names derived from PULLMD_FRONTMATTER_FIELDS,
 * or null if all fields should be emitted (env unset, empty, or all-unknown).
 */
function frontmatterAllowlist() {
  const raw = process.env.PULLMD_FRONTMATTER_FIELDS;
  if (!raw) return null;
  const requested = raw.split(',').map(s => s.trim()).filter(Boolean);
  const valid = requested.filter(k => KNOWN_FRONTMATTER_FIELDS.has(k));
  return valid.length ? new Set(valid) : null;   // all-unknown (or empty) → null = all fields
}

/**
 * The raw, unfiltered PULLMD_FRONTMATTER_FIELDS allowlist (every listed name,
 * regardless of whether it is a built-in field). Recipe-defined frontmatter
 * fields have arbitrary names, so they are gated on the raw set — a contributor
 * lists their custom field name verbatim to keep it. Returns null when unset.
 *
 * @param {object} [env]  Environment object (defaults to process.env)
 * @returns {Set<string>|null}
 */
export function rawFrontmatterAllowlist(env = process.env) {
  const raw = env.PULLMD_FRONTMATTER_FIELDS;
  if (!raw) return null;
  const names = raw.split(',').map(s => s.trim()).filter(Boolean);
  return names.length ? new Set(names) : null;
}

/**
 * @param {object} metadata    The extraction metadata object
 * @param {object} [opts]
 * @param {string} [opts.source]   The extraction source (cloudflare, trafilatura, readability, reddit, ...)
 * @param {string} [opts.shareId]  Optional share id
 * @returns {string} YAML frontmatter block including the surrounding `---` lines, with trailing newline.
 *                   Returns '' if PULLMD_FRONTMATTER_FIELDS is set and no allowlisted fields have values.
 */
export function buildFrontmatter(metadata = {}, { source = null, shareId = null } = {}) {
  const fetched = new Date().toISOString();
  const allow = frontmatterAllowlist();

  // Recipe-injected fields ride in metadata.recipeFields (survives cache hits via
  // the stored metadata JSON). They win over generic metadata-derived fields on a
  // name collision — site-specific knowledge beats generic scraping — and are
  // gated on the raw allowlist (their names are arbitrary, not built-ins).
  //
  // Reserved (pipeline-computed) names are stripped defensively here even though
  // the recipe schema already rejects them at load time (lib/recipes.js) — this
  // is a belt-and-suspenders guard against a hand-crafted/unvalidated
  // recipeFields object, not the primary enforcement point.
  const rawRecipeFields = (metadata.recipeFields && typeof metadata.recipeFields === 'object')
    ? metadata.recipeFields : null;
  const recipeFields = rawRecipeFields
    ? Object.fromEntries(
        Object.entries(rawRecipeFields).filter(([k]) => !RESERVED_FRONTMATTER_FIELDS.has(k)),
      )
    : null;
  const recipeKeys = recipeFields ? new Set(Object.keys(recipeFields)) : null;
  const rawAllow = recipeFields ? rawFrontmatterAllowlist() : null;

  const fields = [
    ['title', metadata.title],
    ['url', metadata.sourceUrl || metadata.canonical],
    ['source', source],
    ['fetched', fetched],
    ['quality', metadata.quality],
    ['author', metadata.author],
    ['published', metadata.publishedTime],
    ['modified', metadata.modifiedTime],
    ['description', metadata.description || metadata.ogDescription],
    ['language', metadata.language],
    ['image', metadata.ogImage || metadata.twitterImage],
    ['site', metadata.ogSiteName],
    ['extractor_reason', metadata.extractorReason],
    ['share_id', shareId],
  ]
    .filter(([k]) => !allow || allow.has(k))
    .filter(([k]) => !recipeKeys || !recipeKeys.has(k))   // recipe overrides generic
    .map(([k, v]) => formatField(k, v))
    .filter(Boolean);

  const recipeLines = recipeFields
    ? Object.entries(recipeFields)
        .filter(([k]) => !rawAllow || rawAllow.has(k))
        .map(([k, v]) => formatField(k, v))
        .filter(Boolean)
    : [];

  const all = fields.concat(recipeLines);
  if (all.length === 0) return '';
  return `---\n${all.join('\n')}\n---\n\n`;
}

/**
 * Merge additional fields into a markdown document's leading YAML frontmatter
 * block, or prepend a new block if none exists. Keys that already appear in
 * the existing block are skipped (existing values win), so this is safe to
 * call after `buildFrontmatter` has already produced a block.
 *
 * @param {string} markdown            The markdown text, possibly already prefixed with `---\n...---\n\n`
 * @param {Array<[string, *]>} fields  Ordered key/value pairs to add (null/undefined skipped, dedup'd against existing keys)
 * @returns {string} markdown with the merged frontmatter block
 */
export function mergeFrontmatter(markdown, fields = []) {
  const fmMatch = markdown.match(/^---\n([\s\S]*?)\n---\n+/);
  const existingKeys = new Set();
  if (fmMatch) {
    for (const line of fmMatch[1].split('\n')) {
      const m = line.match(/^([a-zA-Z_][\w-]*)\s*:/);
      if (m) existingKeys.add(m[1]);
    }
  }

  const allow = frontmatterAllowlist();
  const lines = fields
    .filter(([k]) => !existingKeys.has(k))
    .filter(([k]) => !allow || allow.has(k))
    .map(([k, v]) => formatField(k, v))
    .filter(Boolean);

  if (lines.length === 0) return markdown;

  if (fmMatch) {
    const existing = fmMatch[1];
    const after = markdown.slice(fmMatch[0].length);
    return `---\n${existing}\n${lines.join('\n')}\n---\n\n${after}`;
  }
  return `---\n${lines.join('\n')}\n---\n\n${markdown}`;
}

/**
 * Extraction sources that can carry media / LLM-usage metadata worth surfacing
 * in the frontmatter (duration, views, image_size, audio_seconds, pdf_pages,
 * llm_*). Used to gate {@link mergeMediaFrontmatter}.
 */
export const MEDIA_FRONTMATTER_SOURCES = new Set([
  'youtube', 'markitdown', 'image-caption', 'audio-transcript', 'pdf-ocr', 'reddit', 'hackernews',
]);

/**
 * Merge media / LLM-usage fields from an extraction metadata object into a
 * markdown document's frontmatter. No-op for non-media sources. Centralizes the
 * field mapping so every serve path (fresh fetch, cache hit, MCP, file upload)
 * stays in sync.
 *
 * @param {string} markdown   markdown text (with or without a leading YAML block)
 * @param {object} [metadata] extraction metadata (ytDuration, imageSize, llmTokens, …)
 * @param {string} [source]   extraction source; merge only runs for media sources
 * @returns {string} markdown with media frontmatter merged in (existing keys win)
 */
export function mergeMediaFrontmatter(markdown, metadata = {}, source = null) {
  if (!MEDIA_FRONTMATTER_SOURCES.has(source)) return markdown;
  const m = metadata || {};
  return mergeFrontmatter(markdown, [
    ['subreddit', m.subreddit],
    ['author', m.author],
    ['published', m.published],
    ['upvotes', m.upvotes],
    ['duration', m.ytDuration],
    ['views', m.ytViews],
    ['image_size', m.imageSize],
    ['audio_seconds', m.audioSeconds],
    ['pdf_pages', m.pdfPages],
    ['images_transcribed', m.imagesTranscribed],
    ['llm_model', m.llmModel],
    ['llm_tokens', m.llmTokens],
    ['llm_prompt_tokens', m.llmPromptTokens],
    ['llm_completion_tokens', m.llmCompletionTokens],
  ]);
}

/**
 * Validate PULLMD_FRONTMATTER_FIELDS at startup. Warns once about unknown field
 * names and silently returns when unset or all names are valid.
 *
 * @param {object} [env]  Environment object (defaults to process.env)
 * @param {function} [warn]  Warning function (defaults to console.warn)
 */
export function validateFrontmatterFields(env = process.env, warn = console.warn) {
  const raw = env.PULLMD_FRONTMATTER_FIELDS;
  if (!raw) return;
  const unknown = raw.split(',').map(s => s.trim()).filter(Boolean)
    .filter(k => !KNOWN_FRONTMATTER_FIELDS.has(k));
  if (unknown.length) {
    warn(`PULLMD_FRONTMATTER_FIELDS: unknown field(s) ignored: ${unknown.join(', ')} (known: ${[...KNOWN_FRONTMATTER_FIELDS].join(', ')})`);
  }
}
