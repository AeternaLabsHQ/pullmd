// Refresh a stale share-cache entry by re-extracting from its source URL.
// Shared by GET /s/:id (server.js) and the MCP get_share tool (lib/mcp.js),
// so both dispatch a row to the extractor of its source the same way.
//
// Best-effort: infers comments/lang from the cached markdown. Extraction
// errors propagate; the caller serves the stale snapshot then.

import { redditImageOptions, resolveEmbeddedImages, imageStoreFrom } from './embedded-images.js';

/**
 * @returns {Promise<{ markdown: string, source: string, refreshed: boolean }>}
 *   `refreshed` is false when a transient failure kept the old snapshot.
 */
export async function refreshShareEntry(entry, {
  cache,
  extract,
  extractHn,
  extractWeb,
  isRedditUrl,
  isHnUrl,
  client,
  userId = null,
  llmAllowed,
  lookup,
}) {
  const md = entry.markdown || '';
  const hadComments = md.includes('\n## Kommentare') || md.includes('\n## Comments');
  const inferredLang = md.includes('\n## Comments') ? 'en' : 'de';
  const kept = { markdown: entry.markdown, source: entry.source, refreshed: false };

  if (isRedditUrl(entry.url)) {
    const r = await extract(entry.url, {
      comments: hadComments,
      commentDepth: 3,
      lang: inferredLang,
      withMeta: true,
      ...redditImageOptions(resolveEmbeddedImages(undefined), llmAllowed, imageStoreFrom(cache)),
      ...(lookup && { ssrfOpts: { lookup } }),
    });
    // An image missed for a transient reason: keep the existing snapshot,
    // like the web path below. Always restart the refresh clock: the paid
    // transcripts are already in the image store, and without the touch
    // every later view would fetch Reddit and spend budget again.
    if (typeof r !== 'string' && r.noStore) {
      cache.touch(entry.url);
      return kept;
    }
    // Test doubles may return a bare string; production returns { markdown, meta }.
    const baseMd = typeof r === 'string' ? r : r.markdown;
    const redditMeta = typeof r === 'string' ? null : r.meta;
    const titleMatch = baseMd.match(/^#\s+(.+)$/m);
    cache.put({
      url: entry.url,
      title: titleMatch?.[1] || entry.title || 'Reddit Post',
      markdown: baseMd,
      source: 'reddit',
      client,
      user_id: userId,
      metadata: redditMeta,
    });
    return { markdown: baseMd, source: 'reddit', refreshed: true };
  }

  if (isHnUrl(entry.url)) {
    const r = await extractHn(entry.url, {
      comments: hadComments,
      commentDepth: 3,
      lang: inferredLang,
      withMeta: true,
    });
    const baseMd = typeof r === 'string' ? r : r.markdown;
    const hnMeta = typeof r === 'string' ? null : r.meta;
    const titleMatch = baseMd.match(/^#\s+(.+)$/m);
    cache.put({
      url: entry.url,
      title: titleMatch?.[1] || entry.title || 'Hacker News',
      markdown: baseMd,
      source: 'hackernews',
      client,
      user_id: userId,
      metadata: hnMeta,
    });
    return { markdown: baseMd, source: 'hackernews', refreshed: true };
  }

  const result = await extractWeb(entry.url, { comments: false, ...(llmAllowed && { llmAllowed }), ...(lookup && { lookup }) });
  // Transient failure (e.g. YouTube 429): keep the existing good snapshot
  // instead of overwriting it with a "couldn't retrieve" placeholder.
  // A paid-tier budget deferral also restarts the refresh clock, so the
  // source is not fetched again on every hit until the budget recovers.
  if (result.noStore) {
    if (result.budgetDeferred) cache.touch(entry.url);
    return kept;
  }
  cache.put({
    url: entry.url,
    title: result.title,
    markdown: result.markdown,
    source: result.source,
    client,
    user_id: userId,
    metadata: result.metadata,
  });
  return { markdown: result.markdown, source: result.source, refreshed: true };
}
