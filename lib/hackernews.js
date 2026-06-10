// lib/hackernews.js
import { NodeHtmlMarkdown } from 'node-html-markdown';

const HN_HOST = 'news.ycombinator.com';
const ALGOLIA_BASE = 'https://hn.algolia.com/api/v1';

// listing path → Algolia query config + display title
const LISTINGS = {
  '/':       { tag: 'front_page', byDate: false, title: 'Front Page' },
  '/news':   { tag: 'front_page', byDate: false, title: 'Front Page' },
  '/newest': { tag: 'story',      byDate: true,  title: 'Newest' },
  '/ask':    { tag: 'ask_hn',     byDate: false, title: 'Ask HN' },
  '/show':   { tag: 'show_hn',    byDate: false, title: 'Show HN' },
  '/jobs':   { tag: 'job',        byDate: false, title: 'Jobs' },
  '/best':   { tag: 'front_page', byDate: false, title: 'Best' },
};

const nhm = new NodeHtmlMarkdown({ codeBlockStyle: 'fenced', bulletMarker: '-' });

/**
 * Parse + validate an HN URL into a target descriptor.
 * @returns {{kind:'item', id:string, canonical:string} | {kind:'listing', listing:string, canonical:string}}
 * @throws {Error} for non-HN URLs, unsupported paths (/user, /threads, …), or bad item ids.
 */
export function normalizeHnUrl(input) {
  if (!input || typeof input !== 'string') throw new Error('Not a valid Hacker News URL');
  let url;
  try { url = new URL(input.trim()); } catch { throw new Error('Not a valid Hacker News URL'); }
  if (url.hostname.toLowerCase() !== HN_HOST) throw new Error('Not a valid Hacker News URL');

  const pathname = url.pathname.replace(/\/+$/, '') || '/';

  if (pathname === '/item') {
    const id = url.searchParams.get('id');
    if (!id || !/^\d+$/.test(id)) throw new Error('Not a valid Hacker News URL');
    return { kind: 'item', id, canonical: `https://${HN_HOST}/item?id=${id}` };
  }
  if (Object.prototype.hasOwnProperty.call(LISTINGS, pathname)) {
    return { kind: 'listing', listing: pathname, canonical: `https://${HN_HOST}${pathname}` };
  }
  throw new Error('Not a valid Hacker News URL');
}

export function isHnUrl(input) {
  try { normalizeHnUrl(input); return true; } catch { return false; }
}

export async function fetchAlgoliaItem(id, { fetchImpl = fetch } = {}) {
  const res = await fetchImpl(`${ALGOLIA_BASE}/items/${id}`, { headers: { Accept: 'application/json' } });
  if (res.status === 404) throw new Error('Item not found');
  if (res.status === 429) throw new Error('Rate limited by Hacker News API. Try again later.');
  if (!res.ok) throw new Error(`Hacker News API returned status ${res.status}`);
  return res.json();
}

export async function fetchAlgoliaSearch(listing, { fetchImpl = fetch, hitsPerPage = 30 } = {}) {
  const cfg = LISTINGS[listing] || LISTINGS['/'];
  const endpoint = cfg.byDate ? 'search_by_date' : 'search';
  const url = `${ALGOLIA_BASE}/${endpoint}?tags=${cfg.tag}&hitsPerPage=${hitsPerPage}`;
  const res = await fetchImpl(url, { headers: { Accept: 'application/json' } });
  if (res.status === 429) throw new Error('Rate limited by Hacker News API. Try again later.');
  if (!res.ok) throw new Error(`Hacker News API returned status ${res.status}`);
  const json = await res.json();
  return json.hits || [];
}

function relativeTime(utcSeconds) {
  if (!utcSeconds) return '';
  const diff = Math.floor(Date.now() / 1000) - utcSeconds;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 2592000) return `${Math.floor(diff / 86400)}d ago`;
  if (diff < 31536000) return `${Math.floor(diff / 2592000)}mo ago`;
  return `${Math.floor(diff / 31536000)}y ago`;
}

function isDead(node) {
  return !node || node.type !== 'comment' || node.text == null || node.author == null;
}

function htmlToMd(html) {
  return nhm.translate(html || '').trim();
}

// Count all alive comment descendants of a node. Dead nodes and their whole
// subtree are skipped, mirroring formatCommentNode (which drops a dead node and
// everything beneath it) so the rendered count and the heading total agree.
function countComments(node) {
  let n = 0;
  for (const child of node.children || []) {
    if (!isDead(child)) {
      n++;
      n += countComments(child);
    }
  }
  return n;
}

function formatCommentNode(node, depth, maxDepth, lines, counter) {
  if (depth >= maxDepth) return;
  if (isDead(node)) return;            // mirror Reddit: drop dead node + subtree
  counter.count++;
  const indent = '  '.repeat(depth);
  const time = relativeTime(node.created_at_i);
  const bodyLines = htmlToMd(node.text).split('\n');
  lines.push(bodyLines.map((line, i) =>
    i === 0 ? `${indent}**${node.author}** · ${time}: ${line}` : `${indent}${line}`
  ).join('\n'));
  for (const child of node.children || []) {
    formatCommentNode(child, depth + 1, maxDepth, lines, counter);
  }
}

export function formatComments(children, { totalComments, limit, depth, lang = 'de' }) {
  const limited = limit ? children.slice(0, limit) : children;
  const lines = ['', ''];             // placeholder for heading, filled after counting
  const counter = { count: 0 };
  for (let i = 0; i < limited.length; i++) {
    if (i > 0) lines.push('');
    formatCommentNode(limited[i], 0, depth, lines, counter);
  }
  lines[0] = lang === 'en'
    ? `## Comments (${counter.count} of ${totalComments})`
    : `## Kommentare (${counter.count} von ${totalComments})`;
  return lines.join('\n');
}

export function itemMeta(item) {
  return {
    author: item.author || null,
    published: item.created_at_i ? new Date(item.created_at_i * 1000).toISOString() : null,
    upvotes: typeof item.points === 'number' ? item.points : null,
  };
}

export function formatItem(item, { comments = true, commentDepth = 3, commentLimit = null, lang = 'de' } = {}) {
  const lines = [];
  const title = item.title || (item.type === 'comment' ? `Comment by ${item.author}` : 'Hacker News');
  lines.push(`# ${title}`, '');

  if (process.env.PULLMD_SOURCE_HEADER) {
    const time = relativeTime(item.created_at_i);
    const fetched = new Date().toISOString().slice(0, 16).replace('T', ' ');
    const pts = typeof item.points === 'number' ? `${item.points} ↑ · ` : '';
    const by = item.author ? `by ${item.author} · ` : '';
    lines.push(`**HN** · ${by}${pts}${time} · ${fetched}`, '');
  }

  if (item.url) lines.push(item.url, '');         // link-post URL stays in body (option a)
  if (item.text) lines.push(htmlToMd(item.text), '');

  let markdown = lines.join('\n').trimEnd();

  if (comments) {
    const children = item.children || [];
    if (children.some((c) => !isDead(c))) {
      markdown += '\n\n---\n\n' + formatComments(children, {
        totalComments: countComments(item),
        limit: commentLimit,
        depth: commentDepth,
        lang,
      });
    }
  }
  return markdown;
}

export function formatListing(hits, listing) {
  const cfg = LISTINGS[listing] || LISTINGS['/'];
  const lines = [`# Hacker News — ${cfg.title}`, ''];
  hits.forEach((h, i) => {
    const discussion = `https://${HN_HOST}/item?id=${h.objectID}`;
    const link = h.url || discussion;
    const meta = [
      typeof h.points === 'number' ? `${h.points} points` : '',
      typeof h.num_comments === 'number' ? `${h.num_comments} comments` : '',
    ].filter(Boolean).join(', ');
    const tail = meta ? `${meta} · ` : '';
    lines.push(`${i + 1}. [${h.title}](${link}) — ${tail}[discussion](${discussion})`);
  });
  return lines.join('\n');
}

export async function extractHn(url, options = {}) {
  const { comments = true, commentDepth = 3, commentLimit = null, lang = 'de', withMeta = false, fetchImpl = fetch } = options;
  const target = normalizeHnUrl(url);

  if (target.kind === 'listing') {
    const hits = await fetchAlgoliaSearch(target.listing, { fetchImpl });
    const md = formatListing(hits, target.listing);
    return withMeta ? { markdown: md, meta: null } : md;
  }

  const item = await fetchAlgoliaItem(target.id, { fetchImpl });
  const md = formatItem(item, { comments, commentDepth, commentLimit, lang });
  return withMeta ? { markdown: md, meta: itemMeta(item) } : md;
}
