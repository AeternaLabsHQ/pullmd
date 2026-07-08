import * as cheerio from 'cheerio';
import { redditFetch, getUserAgent } from './reddit-auth.js';
import { assertUrlAllowed } from './ssrf.js';

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
 * Fetches Reddit post data by appending .json to the canonical post URL.
 *
 * @param {string} canonicalUrl - A canonical Reddit post URL
 * @returns {Promise<object>} The parsed JSON response from Reddit
 * @throws {Error} If the post is not found (404), rate limited (429), or blocked (403)
 */
export async function fetchRedditJson(canonicalUrl) {
  const jsonUrl = canonicalUrl.replace(/\/$/, '') + '.json';

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

export function formatPost(post, url) {
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
  const mediaLines = [];
  if (post.is_video && post.media?.reddit_video?.fallback_url) {
    mediaLines.push(`Video: ${post.media.reddit_video.fallback_url}`);
  } else if (post.gallery_data && post.media_metadata) {
    for (const item of post.gallery_data.items) {
      const meta = post.media_metadata[item.media_id];
      if (meta?.s?.u) {
        mediaLines.push(`![](${meta.s.u.replace(/&amp;/g, '&')})`);
      }
    }
  } else if (post.post_hint === 'image' || /\.(jpg|jpeg|png|gif|webp)$/i.test(post.url || '')) {
    mediaLines.push(`![](${post.url})`);
  } else if (!post.is_self && post.url) {
    mediaLines.push(post.url);
  }

  if (mediaLines.length > 0) {
    lines.push(...mediaLines);
  }
  if (post.selftext) {
    if (mediaLines.length > 0) lines.push('');
    lines.push(post.selftext);
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
  const bodyLines = body.split('\n');
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
  const aboutUrl = canonicalUrl.replace(/\/$/, '') + '/about.json';
  const listingUrl = `${canonicalUrl.replace(/\/$/, '')}/${sort}.json?limit=${limit}`;

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
  } = options;

  const canonicalUrl = await resolveRedditUrl(url);

  // Handle subreddit links (not individual posts)
  if (isSubredditUrl(canonicalUrl)) {
    const listing = await extractSubreddit(canonicalUrl);
    return withMeta ? { markdown: listing, meta: null } : listing;
  }

  let postData;
  let commentData;

  try {
    const json = await fetchRedditJson(canonicalUrl);
    postData = json[0].data.children[0].data;
    commentData = json[1];
  } catch (err) {
    if (err.message.includes('403') || err.message.includes('Rate limited')) {
      postData = await fetchOldRedditFallback(canonicalUrl);
      commentData = null;
    } else {
      throw err;
    }
  }

  let markdown = formatPost(postData, canonicalUrl);

  if (comments && commentData) {
    markdown += '\n\n---\n\n';
    markdown += formatComments(commentData, {
      totalComments: postData.num_comments,
      limit: commentLimit,
      depth: commentDepth,
      lang,
    });
  }

  return withMeta ? { markdown, meta: postMeta(postData) } : markdown;
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
