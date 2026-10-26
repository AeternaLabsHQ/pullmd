import * as cheerio from 'cheerio';
import { redditFetch, getUserAgent } from './reddit-auth.js';
import { assertUrlAllowed } from './ssrf.js';
import {
  EMBEDDED_IMAGE_HOSTS,
  readEmbeddedImagesMode,
  visionConfigured,
  renderImageBlock,
  renderImageMarker,
  transcribeImages,
} from './embedded-images.js';
import { applyMediaUsage } from './media-usage.js';

/**
 * Resolves a Reddit URL by normalizing it and following any redirects.
 *
 * - For standard Reddit URLs, returns the normalized form directly.
 * - For redd.it short links and /s/ share links, follows the redirect
 *   via a HEAD request and normalizes the final destination URL.
 *
 * @param {string} input - A Reddit URL string
 * @returns {Promise<string>} The resolved, normalized Reddit URL
 * @throws {Error} If input is invalid or redirect resolution fails
 */
export async function resolveRedditUrl(input) {
  const normalized = normalizeRedditUrl(input);

  if (!normalized.startsWith('NEEDS_REDIRECT:')) {
    return normalized;
  }

  const redirectUrl = normalized.slice('NEEDS_REDIRECT:'.length);

  // Use raw fetch with manual redirect — auth-rewriting oauth.reddit.com
  // would lose the redirect target, and short-link resolution doesn't need auth.
  // SSRF guard: a short-link could point at an internal/metadata host.
  await assertUrlAllowed(redirectUrl);
  const response = await fetch(redirectUrl, {
    method: 'GET',
    headers: { 'User-Agent': getUserAgent() },
    redirect: 'manual',
  });

  const location = response.headers.get('location');
  if (!location) {
    throw new Error(`Failed to resolve Reddit URL: no redirect (status ${response.status})`);
  }

  return normalizeRedditUrl(location);
}

/**
 * Reddit's JSON API HTML-escapes `&`, `<` and `>` in every text field
 * (selftext, comment bodies, titles, URLs) unless `raw_json=1` is set, which
 * turned `>` quotes into `&gt;` and links into `&amp;` in the Markdown.
 */
export function withRawJson(url) {
  const u = new URL(url);
  u.searchParams.set('raw_json', '1');
  return u.href;
}

/**
 * Reddit's editor marks an empty paragraph with a line holding only a
 * zero-width space, usually as the entity `&#x200B;`. It carries no content and
 * shows up as literal noise in plain Markdown, so such lines are dropped.
 */
export function cleanRedditText(text) {
  const zw = '[ \\t]*(?:&#x200[bB];|&#8203;|\\u200B)[ \\t]*';
  const isMarker = new RegExp(`^${zw}$`);
  // A marker line followed by a blank line takes that blank line along, so
  // the paragraph break stays a single blank line; a removal can expose an
  // earlier marker to the next blank line. One pass with a stack instead of
  // repeated rescans keeps this linear (post bodies are attacker-controlled).
  const lines = String(text).split('\n');
  const kept = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] === '' && i < lines.length - 1 && kept.length >= 2 && isMarker.test(kept[kept.length - 1])) {
      kept.pop();
      continue;
    }
    kept.push(lines[i]);
  }
  return kept.join('\n')
    .replace(new RegExp(`\\n${zw}(?=\\n|$)`, 'g'), '')
    .replace(new RegExp(`^${zw}(?:\\n|$)\\n*`), '');
}

/**
 * Fetches Reddit post data by appending .json to the canonical post URL.
 *
 * @param {string} canonicalUrl - A canonical Reddit post URL
 * @returns {Promise<object>} The parsed JSON response from Reddit
 * @throws {Error} If the post is not found (404), rate limited (429), or blocked (403)
 */
export async function fetchRedditJson(canonicalUrl) {
  const jsonUrl = withRawJson(canonicalUrl.replace(/\/$/, '') + '.json');

  const response = await redditFetch(jsonUrl, {
    headers: { 'Accept': 'application/json' },
  });

  if (response.status === 404) {
    throw new Error('Post not found');
  }
  if (response.status === 429) {
    throw new Error('Rate limited by Reddit. Try again later.');
  }
  if (response.status === 403) {
    throw new Error('Blocked by Reddit (403). Falling back may be needed.');
  }
  if (!response.ok) {
    throw new Error(`Reddit returned status ${response.status}`);
  }

  return response.json();
}

function relativeTime(utcSeconds) {
  const now = Math.floor(Date.now() / 1000);
  const diff = now - utcSeconds;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 2592000) return `${Math.floor(diff / 86400)}d ago`;
  if (diff < 31536000) return `${Math.floor(diff / 2592000)}mo ago`;
  return `${Math.floor(diff / 31536000)}y ago`;
}

const SINGLE_IMAGE_EXT = /\.(jpg|jpeg|png|webp)$/i;

const decodeAmp = (u) => u.replace(/&amp;/g, '&');

function allowedImageHost(u) {
  try {
    return EMBEDDED_IMAGE_HOSTS.has(new URL(u).hostname.toLowerCase());
  } catch {
    return false;
  }
}

/**
 * All post images eligible for transcription, in render order (not capped).
 * Mirrors the media branches of formatPost: video posts have none, galleries
 * use gallery_data order, a single image must be a jpg/jpeg/png/webp on an
 * allowed host, and text posts contribute media_metadata images their
 * selftext references (ordered by first appearance).
 *
 * Keys are stable across fetches: the media id for gallery and inline images,
 * the filename without extension for single images. preview.redd.it query
 * strings are signed and change, so they never go into a key.
 *
 * @returns {Array<{url: string, key: string, kind: 'single'|'gallery'|'inline'}>}
 */
export function collectPostImages(post) {
  if (!post) return [];
  if (post.is_video && post.media?.reddit_video?.fallback_url) return [];

  if (post.gallery_data && post.media_metadata) {
    const out = [];
    const seen = new Set();
    for (const item of post.gallery_data.items || []) {
      const meta = post.media_metadata[item.media_id];
      if (meta?.e !== 'Image' || !meta?.s?.u || seen.has(item.media_id)) continue;
      const url = decodeAmp(meta.s.u);
      if (!allowedImageHost(url)) continue;
      seen.add(item.media_id);
      out.push({ url, key: item.media_id, kind: 'gallery' });
    }
    return out;
  }

  if (post.post_hint === 'image' || /\.(jpg|jpeg|png|gif|webp)$/i.test(post.url || '')) {
    let pathname;
    try {
      pathname = new URL(post.url).pathname;
    } catch {
      return [];
    }
    if (!allowedImageHost(post.url) || !SINGLE_IMAGE_EXT.test(pathname)) return [];
    const key = pathname.split('/').pop().replace(SINGLE_IMAGE_EXT, '');
    return key ? [{ url: post.url, key, kind: 'single' }] : [];
  }

  if (post.is_self && post.media_metadata && !post.gallery_data && post.selftext) {
    const found = [];
    for (const [id, meta] of Object.entries(post.media_metadata)) {
      if (meta?.e !== 'Image' || !meta?.s?.u) continue;
      const at = post.selftext.indexOf(id);
      if (at === -1) continue;
      const url = decodeAmp(meta.s.u);
      if (!allowedImageHost(url)) continue;
      found.push({ at, image: { url, key: id, kind: 'inline' } });
    }
    return found.sort((a, b) => a.at - b.at).map((f) => f.image);
  }

  return [];
}

/**
 * Block (transcript), marker or nothing for one eligible image key.
 * `{ failed: true }` entries never render as a block.
 */
function imageAddon(key, { transcripts, marker, lang }) {
  const t = transcripts[key];
  if (t && !t.failed) return renderImageBlock(t, lang);
  return marker ? renderImageMarker(lang) : null;
}

/**
 * Insert blocks/markers for inline images after the first selftext line that
 * references each one, with a blank line before and after (otherwise markdown
 * lazy continuation would pull the next line into the quote).
 */
function selftextWithAddons(selftext, images, opts) {
  const inline = images.filter((i) => i.kind === 'inline');
  if (inline.length === 0) return selftext;
  const lines = selftext.split('\n');
  const addonsByLine = new Map();
  for (const { key } of inline) {
    const addon = imageAddon(key, opts);
    if (!addon) continue;
    const idx = lines.findIndex((l) => l.includes(key));
    if (idx === -1) continue;
    if (!addonsByLine.has(idx)) addonsByLine.set(idx, []);
    addonsByLine.get(idx).push(addon);
  }
  if (addonsByLine.size === 0) return selftext;
  const out = [];
  lines.forEach((line, i) => {
    out.push(line);
    const addons = addonsByLine.get(i);
    if (!addons) return;
    for (const addon of addons) out.push('', addon);
    if (i + 1 < lines.length && lines[i + 1].trim() !== '') out.push('');
  });
  return out.join('\n');
}

/**
 * @param {object} post - Reddit post data
 * @param {string} [url]
 * @param {object} [opts] - embedded image rendering; without it the output is
 *   exactly what it was before embedded images existed
 * @param {Object<string, object>} [opts.transcripts] - key -> {description, transcript} | {failed: true}
 * @param {boolean} [opts.marker] - render the "not transcribed" marker for eligible images without a transcript
 * @param {string} [opts.lang]
 */
export function formatPost(post, url, { transcripts = {}, marker = false, lang = 'de' } = {}) {
  const addonOpts = { transcripts, marker, lang };
  const images = collectPostImages(post);
  const eligible = new Set(images.filter((i) => i.kind !== 'inline').map((i) => i.key));
  const addonFor = (key) => (eligible.has(key) ? imageAddon(key, addonOpts) : null);

  const lines = [];
  lines.push(`# ${post.title}`);
  lines.push('');
  // Clean body by default (v3): subreddit/author/upvotes/published live in the
  // frontmatter. PULLMD_SOURCE_HEADER=true restores the legacy inline meta line
  // — same opt-out switch as the web source header.
  if (process.env.PULLMD_SOURCE_HEADER) {
    const time = relativeTime(post.created_utc);
    const fetched = new Date().toISOString().slice(0, 16).replace('T', ' ');
    lines.push(`**r/${post.subreddit}** · u/${post.author} · ${post.score} ↑ · ${time} · ${fetched}`);
    if (url) lines.push(url);
    lines.push('');
  }

  // Reddit lets any post type carry both media and a selftext body, so
  // render media (if any) and selftext (if any) independently. The previous
  // if/else-if chain dropped selftext on image/gallery/video/link posts.
  // Rendering stays as it always was; eligible images only gain a block or
  // marker on its own paragraph after their line.
  const mediaLines = [];
  const pushImage = (line, key) => {
    mediaLines.push(line);
    const addon = key == null ? null : addonFor(key);
    if (addon) mediaLines.push('', addon, '');
  };
  if (post.is_video && post.media?.reddit_video?.fallback_url) {
    mediaLines.push(`Video: ${post.media.reddit_video.fallback_url}`);
  } else if (post.gallery_data && post.media_metadata) {
    for (const item of post.gallery_data.items) {
      const meta = post.media_metadata[item.media_id];
      if (meta?.s?.u) {
        pushImage(`![](${meta.s.u.replace(/&amp;/g, '&')})`, item.media_id);
      }
    }
  } else if (post.post_hint === 'image' || /\.(jpg|jpeg|png|gif|webp)$/i.test(post.url || '')) {
    pushImage(`![](${post.url})`, images[0]?.key);
  } else if (!post.is_self && post.url) {
    mediaLines.push(post.url);
  }
  // A trailing blank after the last block is already supplied below (or not needed).
  if (mediaLines.at(-1) === '') mediaLines.pop();

  if (mediaLines.length > 0) {
    lines.push(...mediaLines);
  }
  if (post.selftext) {
    if (mediaLines.length > 0) lines.push('');
    lines.push(selftextWithAddons(cleanRedditText(post.selftext), images, addonOpts));
  }

  return lines.join('\n');
}

function formatCommentNode(node, depth, maxDepth, lines, counter) {
  if (!node || node.kind !== 't1' || !node.data) return;
  const { author, score, body } = node.data;

  if (author === '[deleted]' || author === '[removed]' || body === '[deleted]' || body === '[removed]') {
    return;
  }

  if (depth >= maxDepth) return;

  counter.count++;

  const indent = '  '.repeat(depth);
  const bodyLines = cleanRedditText(body).split('\n');
  const formatted = bodyLines.map((line, i) =>
    i === 0
      ? `${indent}**u/${author}** [+${score}]: ${line}`
      : `${indent}${line}`
  ).join('\n');

  lines.push(formatted);

  if (node.data.replies && node.data.replies.data?.children) {
    for (const reply of node.data.replies.data.children) {
      formatCommentNode(reply, depth + 1, maxDepth, lines, counter);
    }
  }
}

export function formatComments(commentData, { totalComments, limit, depth, lang = 'de' }) {
  const children = commentData.data.children.filter(c => c.kind === 't1');
  const limited = limit ? children.slice(0, limit) : children;

  const lines = [];
  const counter = { count: 0 };

  // placeholder — filled after counting
  lines.push('');
  lines.push('');

  for (let i = 0; i < limited.length; i++) {
    if (i > 0) lines.push('');
    formatCommentNode(limited[i], 0, depth, lines, counter);
  }

  lines[0] = lang === 'en'
    ? `## Comments (${counter.count} of ${totalComments})`
    : `## Kommentare (${counter.count} von ${totalComments})`;

  return lines.join('\n');
}

export function parseOldRedditHtml(html) {
  const $ = cheerio.load(html);
  const thing = $('div.thing').first();

  const title = thing.find('a.title').first().text().trim();
  const author = thing.find('a.author').first().text().trim();
  const subredditText = thing.find('a.subreddit').first().text().trim();
  const subreddit = subredditText.replace(/^r\//, '');
  const score = parseInt(thing.attr('data-score'), 10) || 0;

  const mdDiv = thing.find('.usertext-body .md');
  const selftext = mdDiv.find('p').map((_, el) => $(el).text()).get().join('\n\n');

  return {
    title,
    author,
    subreddit,
    score,
    selftext,
    is_self: true,
    created_utc: Math.floor(Date.now() / 1000),
    url: '',
    num_comments: 0,
    is_video: false,
    media: null,
    gallery_data: null,
    media_metadata: null,
    post_hint: undefined,
  };
}

export async function fetchOldRedditFallback(canonicalUrl) {
  // old.reddit.com HTML scraping doesn't go through OAuth — keep as direct fetch
  const oldUrl = canonicalUrl.replace('www.reddit.com', 'old.reddit.com');

  const response = await fetch(oldUrl, {
    headers: { 'User-Agent': getUserAgent() },
  });

  if (!response.ok) {
    throw new Error(`Old Reddit fallback failed: ${response.status}`);
  }

  const html = await response.text();
  return parseOldRedditHtml(html);
}

/**
 * Main entry point: resolves a Reddit URL, fetches JSON data, and returns
 * formatted Markdown for the post (and optionally its comments).
 *
 * @param {string} url - A Reddit URL string
 * @param {object} [options]
 * @param {boolean} [options.comments=true] - Whether to include comments
 * @param {number} [options.commentDepth=3] - Maximum comment nesting depth
 * @param {number|null} [options.commentLimit=null] - Optional cap on top-level comments (null = no cap)
 * @returns {Promise<string>} The post (and optionally comments) as Markdown
 */
/**
 * A Reddit URL PullMD has no extractor for (rules, wiki, user profiles,
 * sorted listings, ...). Thrown before any fetch, or when a URL that looked
 * like a post returned something other than a post listing.
 */
export class RedditUnsupportedPageError extends Error {
  constructor(url) {
    super(`Unsupported Reddit page: PullMD reads Reddit posts and subreddits, not ${url}`);
    this.name = 'RedditUnsupportedPageError';
    this.code = 'reddit_unsupported_page';
  }
}

function isPostUrl(url) {
  try {
    const u = new URL(url);
    return /\/comments\/[a-z0-9]+\//i.test(u.pathname) || /^\/gallery\/[a-z0-9]+\/?$/i.test(u.pathname);
  } catch {
    return false;
  }
}

function isSubredditUrl(url) {
  try {
    const u = new URL(url);
    return /^\/r\/[^/]+\/?$/.test(u.pathname);
  } catch {
    return false;
  }
}

function formatSubredditListing(children, sort) {
  const lines = [];
  lines.push(`## ${sort === 'top' ? 'Top' : 'Hot'} posts`);
  lines.push('');
  let idx = 1;
  for (const child of children) {
    if (child.kind !== 't3' || !child.data) continue;
    const p = child.data;
    if (p.stickied) continue;
    const time = relativeTime(p.created_utc);
    const permalink = `https://www.reddit.com${p.permalink}`;
    lines.push(`${idx}. **[${p.title}](${permalink})** · u/${p.author} · ${p.score} ↑ · ${p.num_comments} 💬 · ${time}`);
    if (p.is_self && p.selftext) {
      const snippet = p.selftext.replace(/\s+/g, ' ').slice(0, 200);
      lines.push(`   ${snippet}${p.selftext.length > 200 ? '…' : ''}`);
    } else if (!p.is_self && p.url && !/reddit\.com/.test(p.url)) {
      lines.push(`   ${p.url}`);
    }
    lines.push('');
    idx++;
  }
  return lines.join('\n');
}

async function extractSubreddit(canonicalUrl, options = {}) {
  const { sort = 'hot', limit = 25 } = options;
  const aboutUrl = withRawJson(canonicalUrl.replace(/\/$/, '') + '/about.json');
  const listingUrl = withRawJson(`${canonicalUrl.replace(/\/$/, '')}/${sort}.json?limit=${limit}`);

  const [aboutRes, listingRes] = await Promise.all([
    redditFetch(aboutUrl, { headers: { 'Accept': 'application/json' } }),
    redditFetch(listingUrl, { headers: { 'Accept': 'application/json' } }),
  ]);

  if (!aboutRes.ok) throw new Error(`Reddit returned status ${aboutRes.status}`);
  const aboutJson = await aboutRes.json();
  const sub = aboutJson.data;

  const fetched = new Date().toISOString().slice(0, 16).replace('T', ' ');
  const lines = [];
  lines.push(`# r/${sub.display_name}`);
  lines.push('');
  const subtitle = sub.title ? `**${sub.title}**` : '';
  const stats = `${(sub.subscribers || 0).toLocaleString()} Mitglieder · ${(sub.active_user_count || 0).toLocaleString()} online · ${fetched}`;
  if (subtitle) {
    lines.push(`${subtitle} · ${stats}`);
  } else {
    lines.push(stats);
  }
  lines.push(canonicalUrl);
  lines.push('');
  if (sub.public_description) {
    lines.push(sub.public_description);
    lines.push('');
  }

  if (listingRes.ok) {
    const listingJson = await listingRes.json();
    const children = listingJson.data?.children || [];
    if (children.length > 0) {
      lines.push('---');
      lines.push('');
      lines.push(formatSubredditListing(children, sort));
    }
  }

  if (sub.description) {
    lines.push('---');
    lines.push('');
    lines.push('## About');
    lines.push('');
    lines.push(sub.description);
  }

  return lines.join('\n');
}

/**
 * Frontmatter-ready meta fields for a Reddit post. Values mirror the legacy
 * inline meta line (subreddit, author, score, creation date).
 */
function postMeta(post) {
  return {
    subreddit: post.subreddit ? `r/${post.subreddit}` : null,
    author: post.author ? `u/${post.author}` : null,
    published: post.created_utc ? new Date(post.created_utc * 1000).toISOString() : null,
    upvotes: typeof post.score === 'number' ? post.score : null,
  };
}

export async function extractPost(url, options = {}) {
  const {
    comments = true,
    commentDepth = 3,
    commentLimit = null,
    lang = 'de',
    withMeta = false,
    images: imagesMode = 'off',
    llmAllowed,
    imageStore = null,
    captionFn,
    fetchFn,
    ssrfOpts,
  } = options;

  const canonicalUrl = await resolveRedditUrl(url);

  // Handle subreddit links (not individual posts)
  if (isSubredditUrl(canonicalUrl)) {
    const listing = await extractSubreddit(canonicalUrl);
    return withMeta ? { markdown: listing, meta: null } : listing;
  }

  if (!isPostUrl(canonicalUrl)) throw new RedditUnsupportedPageError(canonicalUrl);

  let postData;
  let commentData;

  try {
    const json = await fetchRedditJson(canonicalUrl);
    postData = Array.isArray(json) ? json[0]?.data?.children?.[0]?.data : undefined;
    if (!postData) throw new RedditUnsupportedPageError(canonicalUrl);
    commentData = json[1];
  } catch (err) {
    if (err.message.includes('403') || err.message.includes('Rate limited')) {
      postData = await fetchOldRedditFallback(canonicalUrl);
      commentData = null;
    } else {
      throw err;
    }
  }

  const images = await postImages(postData, {
    imagesMode, llmAllowed, imageStore, captionFn, fetchFn, ssrfOpts, lang,
  });

  let markdown = formatPost(postData, canonicalUrl, {
    transcripts: images.transcripts, marker: images.marker, lang,
  });

  if (comments && commentData) {
    markdown += '\n\n---\n\n';
    markdown += formatComments(commentData, {
      totalComments: postData.num_comments,
      limit: commentLimit,
      depth: commentDepth,
      lang,
    });
  }

  if (!withMeta) return markdown;
  const meta = postMeta(postData);
  const result = { markdown, meta };
  if (images.total > 0) {
    meta.imagesTranscribed = `${images.done}/${images.total}`;
    meta.imagesResolved = images.done + images.failed;
    if (images.usage) applyMediaUsage(meta, { usage: images.usage });
  }
  // Internal flags stay off `meta`, which is persisted in the cache.
  if (images.noStore) result.noStore = true;
  if (images.budgetDeferred) result.budgetDeferred = true;
  return result;
}

/**
 * Resolve transcripts for a post's eligible images: transcribe when the
 * effective mode is on and a vision provider is configured (reusing and
 * filling the per-image store), otherwise only look results up in the store,
 * for free. The instance switch `off` ignores the store entirely, so the body
 * stays as it was before this feature.
 */
async function postImages(post, { imagesMode, llmAllowed, imageStore, captionFn, fetchFn, ssrfOpts, lang }) {
  const images = collectPostImages(post);
  const empty = { transcripts: {}, marker: false, total: 0, done: 0, failed: 0, usage: null, noStore: false, budgetDeferred: false };
  if (images.length === 0) return empty;

  const keys = new Set(images.map((i) => i.key));
  const instanceOff = readEmbeddedImagesMode() === 'off';
  const vision = visionConfigured();
  const store = instanceOff ? null : imageStore;

  let transcripts = {};
  let usage = null;
  let noStore = false;
  let budgetDeferred = false;
  if (imagesMode === 'on' && !instanceOff && vision) {
    const r = await transcribeImages(images, { llmAllowed, captionFn, fetchFn, lang, store, ssrfOpts });
    transcripts = r.transcripts;
    usage = r.usage;
    noStore = r.transientMiss;
    budgetDeferred = r.budgetDeferred;
  } else if (store) {
    for (const key of keys) {
      let stored = null;
      try { stored = store.get(key); } catch (err) {
        console.warn('[embedded-images]', `store read failed for ${key}: ${err?.message ?? err}`);
      }
      if (stored && !stored.failed) transcripts[key] = stored;
    }
  }

  const values = [...keys].map((k) => transcripts[k]).filter(Boolean);
  const failed = values.filter((t) => t.failed).length;
  return {
    transcripts,
    marker: vision && !instanceOff,
    total: keys.size,
    done: values.length - failed,
    failed,
    usage,
    noStore,
    budgetDeferred,
  };
}

/**
 * Normalizes a Reddit URL to its canonical form.
 *
 * - Converts all Reddit subdomains (old, new, bare) to www.reddit.com
 * - Strips query parameters and hash fragments
 * - Ensures trailing slash on pathname
 * - Returns NEEDS_REDIRECT: prefix for redd.it short links and /s/ share links
 * - Throws for non-Reddit URLs or invalid input
 *
 * @param {string} input - A Reddit URL string
 * @returns {string} The normalized URL, or a NEEDS_REDIRECT: prefixed string
 * @throws {Error} If input is not a valid Reddit URL
 */
export function normalizeRedditUrl(input) {
  if (!input || typeof input !== 'string') {
    throw new Error('Not a valid Reddit URL');
  }

  let url;
  try {
    url = new URL(input.trim());
  } catch {
    throw new Error('Not a valid Reddit URL');
  }

  const hostname = url.hostname.toLowerCase();

  // redd.it short links need redirect resolution
  if (hostname === 'redd.it') {
    return `NEEDS_REDIRECT:${url.origin}${url.pathname}`;
  }

  // Validate it's a reddit domain
  if (!['www.reddit.com', 'reddit.com', 'old.reddit.com', 'new.reddit.com'].includes(hostname)) {
    throw new Error('Not a valid Reddit URL');
  }

  // Share links (/s/) need redirect resolution
  if (/\/r\/[^/]+\/s\//.test(url.pathname)) {
    return `NEEDS_REDIRECT:${url.href}`;
  }

  // Normalize hostname to www.reddit.com
  url.hostname = 'www.reddit.com';

  // Strip all query params and hash
  url.search = '';
  url.hash = '';

  // Ensure trailing slash
  if (!url.pathname.endsWith('/')) {
    url.pathname += '/';
  }

  return url.href;
}
