import express from 'express';
import { extractPost, normalizeRedditUrl } from './lib/reddit.js';
import { extractWeb } from './lib/web.js';
import { createCache } from './lib/cache.js';
import { createAuth, formatBootstrapError } from './lib/auth.js';
import { qualityScore } from './lib/scoring.js';
import { buildFrontmatter } from './lib/frontmatter.js';
import { mcpHandler } from './lib/mcp.js';
import { renderHelp, renderIndex, getSkillZip, publicUrlFor } from './lib/distrib.js';
import { getRecipeStatus, loadRecipes, applyRecipesInvalidation, computeRecipesHash } from './lib/recipes.js';
import path from 'node:path';
import fs from 'node:fs';

function stripMarkdown(md) {
  return md
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/\*(.+?)\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/_(.+?)_/g, '$1')
    .replace(/~~(.+?)~~/g, '$1')
    .replace(/!\[.*?\]\((.+?)\)/g, '$1')
    .replace(/\[(.+?)\]\((.+?)\)/g, '$1 ($2)')
    .replace(/^>\s?/gm, '')
    .replace(/^[-*+]\s+/gm, '- ')
    .replace(/^---+$/gm, '---')
    .trim();
}

function isRedditUrl(url) {
  try {
    normalizeRedditUrl(url);
    return true;
  } catch {
    return false;
  }
}

function detectClient(ua, clientMode) {
  // Explicit client-mode header from the frontend trumps UA sniffing
  if (clientMode === 'pwa') return 'pwa';
  if (!ua) return 'api';
  const lower = ua.toLowerCase();
  if (lower.includes('claude') || lower.includes('anthropic')) return 'claude';
  if (lower.includes('curl') || lower.includes('wget') || lower.includes('python-requests') || lower.includes('httpie') || lower.includes('node-fetch') || lower.includes('axios')) return 'api';
  if (lower.includes('mozilla') || lower.includes('chrome') || lower.includes('safari') || lower.includes('firefox') || lower.includes('edge')) return 'browser';
  return 'api';
}

function readDisablePublicHistoryEnv() {
  const v = process.env.DISABLE_PUBLIC_HISTORY;
  if (v == null) return false;
  const s = String(v).toLowerCase().trim();
  return s === 'true' || s === '1' || s === 'yes' || s === 'on';
}

export function createApp(overrides = {}) {
  const app = express();
  const extract = overrides.extractPost || extractPost;
  const extractWebFn = overrides.extractWeb || extractWeb;
  const cache = overrides.cache || null;
  const auth = overrides.auth || null;
  const disablePublicHistory = overrides.disablePublicHistory ?? readDisablePublicHistoryEnv();

  const gate = auth ? auth.requireAuth() : (req, res, next) => next();

  // Cache deletes touch the global URL-deduped store — they affect every
  // user's history, not just the caller's. Restrict to admin in any
  // non-disabled mode. In disabled mode, anyone can call (v1 behaviour).
  const adminOnly = (req, res, next) => {
    if (!auth || auth.mode === 'disabled') return next();
    if (req.user?.is_admin) return next();
    return res.status(403).json({ error: 'Admin required' });
  };

  // Templated help page + skill zip (PUBLIC_URL substitution).
  // Must come BEFORE express.static so they win over the raw files in /public.
  app.get(['/help', '/help.html'], (req, res) => {
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.send(renderHelp(publicUrlFor(req)));
  });

  // Templated index page (substitutes PUBLIC_URL + version).
  // Must come BEFORE express.static so it wins over the raw file in /public.
  app.get(['/', '/index.html'], (req, res) => {
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.send(renderIndex(publicUrlFor(req), { disablePublicHistory }));
  });

  app.get('/web-reader.zip', async (req, res, next) => {
    try {
      const buf = await getSkillZip(publicUrlFor(req));
      res.set('Content-Type', 'application/zip');
      res.set('Content-Disposition', 'attachment; filename="web-reader.zip"');
      res.set('Content-Length', String(buf.length));
      res.send(buf);
    } catch (err) {
      next(err);
    }
  });

  app.use(express.static('public', { extensions: ['html'] }));

  if (auth) {
    app.use(auth.middleware());
    auth.mountAuthRoutes(app);
  }

  // MCP endpoint (stateless Streamable-HTTP transport).
  // Each request gets a fresh MCP server + transport bound to the same deps.
  const mcp = mcpHandler({
    extract,
    extractWeb: extractWebFn,
    cache,
    qualityScore,
    buildFrontmatter,
    isRedditUrl,
  });
  app.post('/mcp', gate, express.json({ limit: '1mb' }), mcp);
  app.get('/mcp', gate, mcp);
  app.delete('/mcp', gate, mcp);

  app.get('/share', (req, res) => {
    let link = req.query.link || req.query.url || '';
    if (!link && req.query.text) {
      const urlMatch = req.query.text.match(/https?:\/\/\S+/);
      if (urlMatch) link = urlMatch[0];
    }
    res.redirect(302, `/#url=${encodeURIComponent(link)}`);
  });

  // Refresh a stale share-cache entry by re-extracting from its source URL.
  // Best-effort: infers comments/lang from the cached markdown; falls back
  // to the existing markdown on extraction failure (e.g. dead source).
  async function refreshShareEntry(entry, client) {
    const md = entry.markdown || '';
    const hadComments = md.includes('\n## Kommentare') || md.includes('\n## Comments');
    const inferredLang = md.includes('\n## Comments') ? 'en' : 'de';
    if (isRedditUrl(entry.url)) {
      const baseMd = await extract(entry.url, {
        comments: hadComments,
        commentDepth: 3,
        lang: inferredLang,
      });
      const titleMatch = baseMd.match(/^#\s+(.+)$/m);
      cache.put({
        url: entry.url,
        title: titleMatch?.[1] || entry.title || 'Reddit Post',
        markdown: baseMd,
        source: 'reddit',
        client,
        user_id: null,
      });
      return baseMd;
    }
    const result = await extractWebFn(entry.url, { comments: false });
    cache.put({
      url: entry.url,
      title: result.title,
      markdown: result.markdown,
      source: result.source,
      client,
      user_id: null,
    });
    return result.markdown;
  }

  // Share endpoint: return cached markdown by share ID, refreshing if stale.
  app.get('/s/:id', async (req, res) => {
    if (!cache) {
      return res.status(404).json({ error: 'Cache not available' });
    }

    const entry = cache.getByShareId(req.params.id);
    if (!entry) {
      return res.status(404).json({ error: 'Share link not found or expired' });
    }

    let markdown = entry.markdown;
    const ageMs = Date.now() - new Date(entry.created_at + 'Z').getTime();
    const STALE_MS = 60 * 60 * 1000;
    if (ageMs > STALE_MS) {
      const client = detectClient(req.headers['user-agent'], req.headers['x-client-mode']);
      try {
        markdown = await refreshShareEntry(entry, client);
      } catch (err) {
        // Source is unreachable / failed — serve the stale snapshot.
        console.warn('Share-link refresh failed for', entry.url, '—', err.message);
      }
    }

    const format = req.query.format;
    if (format === 'text') {
      res.set('Content-Type', 'text/plain; charset=utf-8');
      return res.send(stripMarkdown(markdown));
    }
    res.set('Content-Type', 'text/markdown; charset=utf-8');
    return res.send(markdown);
  });

  app.get('/api', gate, async (req, res) => {
    const { url, comments, comment_depth, comment_limit, format, nocache, frontmatter, lang, render, extractor } = req.query;
    const wantFrontmatter = frontmatter === 'true' || frontmatter === '1';
    const reqLang = lang === 'en' ? 'en' : 'de';
    const validExtractor = (extractor === 'readability' || extractor === 'trafilatura' || extractor === 'playwright')
      ? extractor : undefined;

    if (!url) {
      return res.status(400).json({ error: 'Missing required parameter: url' });
    }

    const client = detectClient(req.headers['user-agent'], req.headers['x-client-mode'] || req.query.client_mode);
    // Explicit comment_depth/comment_limit changes the expected output, but we
    // don't store these params per cache row — bypass the cache so the new
    // values actually take effect (the fresh response then overwrites the row).
    const explicitCommentParams = comment_depth !== undefined || comment_limit !== undefined;
    const explicitRenderParam = render === 'force' || render === 'skip';
    const useCache = cache && nocache !== 'true' && nocache !== '1' && !explicitCommentParams && !explicitRenderParam && !validExtractor;

    const wantComments = comments !== 'false' && comments !== '0';
    const t0 = Date.now();

    if (useCache) {
      const cached = cache.get(url);
      if (cached) {
        const redditCached = isRedditUrl(url);
        const hasComments = cached.markdown.includes('\n## Kommentare') || cached.markdown.includes('\n## Comments');
        if (!redditCached || !wantComments || hasComments) {
          const baseMd = cached.markdown;
          const cachedQuality = qualityScore(baseMd);
          const titleMatchCached = baseMd.match(/^#\s+(.+)$/m);
          const fm = wantFrontmatter
            ? buildFrontmatter({
                title: titleMatchCached?.[1] || cached.title,
                sourceUrl: url,
                quality: cachedQuality,
              }, { source: cached.source, shareId: cached.share_id })
            : '';
          const md = fm + baseMd;
          res.set('X-Source', cached.source);
          res.set('X-Quality', String(cachedQuality));
          if (cached.share_id) res.set('X-Share-Id', cached.share_id);
          if (cache) cache.logExtraction({
            url, source: cached.source, quality: cachedQuality, markdownLen: md.length,
            extractorReason: null, durationMs: Date.now() - t0, client, cached: true,
          });
          if (format === 'json') {
            return res.json({
              markdown: md,
              metadata: null,
              source: cached.source,
              shareId: cached.share_id || null,
            });
          }
          if (format === 'text') {
            res.set('Content-Type', 'text/plain; charset=utf-8');
            return res.send(stripMarkdown(md));
          }
          res.set('Content-Type', 'text/markdown; charset=utf-8');
          return res.send(md);
        }
      }
    }

    if (isRedditUrl(url)) {
      try {
        const baseMd = await extract(url, {
          comments: wantComments,
          commentDepth: comment_depth ? parseInt(comment_depth, 10) : 3,
          commentLimit: comment_limit ? parseInt(comment_limit, 10) : null,
          lang: reqLang,
        });

        let shareId = null;
        const titleMatch = baseMd.match(/^#\s+(.+)$/m);
        if (cache) {
          shareId = cache.put({ url, title: titleMatch?.[1] || 'Reddit Post', markdown: baseMd, source: 'reddit', client, user_id: req.user?.id ?? null });
        }

        const quality = qualityScore(baseMd);
        const fm = wantFrontmatter
          ? buildFrontmatter({ title: titleMatch?.[1] || null, sourceUrl: url, quality }, { source: 'reddit', shareId })
          : '';
        const markdown = fm + baseMd;

        res.set('X-Source', 'reddit');
        res.set('X-Quality', String(quality));
        if (shareId) res.set('X-Share-Id', shareId);
        if (cache) cache.logExtraction({
          url, source: 'reddit', quality, markdownLen: baseMd.length,
          extractorReason: null, durationMs: Date.now() - t0, client, cached: false,
        });
        if (format === 'json') {
          return res.json({
            markdown,
            metadata: {
              title: titleMatch?.[1] || null,
              description: null, canonical: null, author: null,
              publishedTime: null, modifiedTime: null,
              ogTitle: null, ogDescription: null, ogImage: null,
              ogSiteName: null, ogType: null,
              twitterCard: null, twitterTitle: null, twitterDescription: null, twitterImage: null,
              language: null, sourceUrl: url, statusCode: 200,
              quality,
            },
            source: 'reddit',
            shareId: shareId || null,
          });
        }
        if (format === 'text') {
          res.set('Content-Type', 'text/plain; charset=utf-8');
          return res.send(stripMarkdown(markdown));
        }
        res.set('Content-Type', 'text/markdown; charset=utf-8');
        return res.send(markdown);
      } catch (err) {
        if (err.message.includes('not found') || err.message.includes('Not found')) {
          return res.status(404).json({ error: 'Post not found' });
        }
        if (err.message.includes('Rate limited') || err.message.includes('429')) {
          return res.status(502).json({ error: 'Reddit rate limit. Try again later.' });
        }
        if (err.message.includes('403') || err.message.includes('Blocked')) {
          return res.status(502).json({ error: 'Reddit blocked the request.' });
        }
        console.error('API error:', err);
        return res.status(500).json({ error: 'Internal server error' });
      }
    }

    try {
      const result = await extractWebFn(url, {
        comments: false,
        render: explicitRenderParam ? render : undefined,
        extractor: validExtractor,
      });

      let shareId = null;
      if (cache) {
        shareId = cache.put({ url, title: result.title, markdown: result.markdown, source: result.source, client, user_id: req.user?.id ?? null });
      }

      const fm = wantFrontmatter
        ? buildFrontmatter(result.metadata || {}, { source: result.source, shareId })
        : '';
      const finalMd = fm + result.markdown;

      res.set('X-Source', result.source);
      if (result.metadata?.quality !== undefined) {
        res.set('X-Quality', String(result.metadata.quality));
      }
      if (shareId) res.set('X-Share-Id', shareId);
      if (cache) cache.logExtraction({
        url, source: result.source,
        quality: result.metadata?.quality,
        markdownLen: result.markdown.length,
        extractorReason: result.metadata?.extractorReason || null,
        durationMs: Date.now() - t0,
        client, cached: false,
      });
      if (format === 'json') {
        return res.json({
          markdown: finalMd,
          metadata: result.metadata || null,
          source: result.source,
          shareId: shareId || null,
        });
      }
      if (format === 'text') {
        res.set('Content-Type', 'text/plain; charset=utf-8');
        return res.send(stripMarkdown(finalMd));
      }
      res.set('Content-Type', 'text/markdown; charset=utf-8');
      return res.send(finalMd);
    } catch (err) {
      console.error('Web extraction error:', err);
      return res.status(502).json({ error: `Failed to extract page: ${err.message}` });
    }
  });

  app.get('/api/stream', gate, async (req, res) => {
    const { url, comments, comment_depth, comment_limit, frontmatter, lang, nocache, render, extractor } = req.query;
    const wantFrontmatter = frontmatter === 'true' || frontmatter === '1';
    const reqLang = lang === 'en' ? 'en' : 'de';
    const validExtractor = (extractor === 'readability' || extractor === 'trafilatura' || extractor === 'playwright')
      ? extractor : undefined;

    if (!url) {
      return res.status(400).json({ error: 'Missing required parameter: url' });
    }

    res.set('Content-Type', 'text/event-stream; charset=utf-8');
    res.set('Cache-Control', 'no-cache');
    res.set('Connection', 'keep-alive');
    res.flushHeaders?.();

    const send = (event, data) => {
      res.write(`event: ${event}\n`);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };
    const emit = (stage, data = {}) => send('status', { stage, ...data });

    const ac = new AbortController();
    req.on('close', () => ac.abort());

    const client = detectClient(req.headers['user-agent'], req.headers['x-client-mode'] || req.query.client_mode);
    const wantComments = comments !== 'false' && comments !== '0';
    const explicitRenderParam = render === 'force' || render === 'skip';
    const explicitCommentParams = comment_depth !== undefined || comment_limit !== undefined;
    const useCache = cache && nocache !== 'true' && nocache !== '1' && !explicitRenderParam && !explicitCommentParams && !validExtractor;
    const t0 = Date.now();

    try {
      // Cache hit fast path
      if (useCache) {
        const cached = cache.get(url);
        if (cached) {
          const redditCached = isRedditUrl(url);
          const hasComments = cached.markdown.includes('\n## Kommentare') || cached.markdown.includes('\n## Comments');
          if (!redditCached || !wantComments || hasComments) {
            emit('fetching', { url, cached: true });
            const baseMd = cached.markdown;
            const cachedQuality = qualityScore(baseMd);
            const titleMatchCached = baseMd.match(/^#\s+(.+)$/m);
            const fm = wantFrontmatter
              ? buildFrontmatter({ title: titleMatchCached?.[1] || cached.title, sourceUrl: url, quality: cachedQuality }, { source: cached.source, shareId: cached.share_id })
              : '';
            send('result', {
              markdown: fm + baseMd,
              source: cached.source,
              shareId: cached.share_id || null,
            });
            cache.logExtraction({
              url, source: cached.source, quality: cachedQuality, markdownLen: (fm + baseMd).length,
              extractorReason: null, durationMs: Date.now() - t0, client, cached: true,
            });
            return res.end();
          }
        }
      }

      // Reddit-specific errors (404, 429, 403) are mapped to HTTP status codes in /api.
      // Here they bubble to the outer catch and surface via the error event's message,
      // which lib/reddit.js already populates with user-readable strings.
      if (isRedditUrl(url)) {
        emit('fetching', { url });
        const baseMd = await extract(url, {
          comments: wantComments,
          commentDepth: comment_depth ? parseInt(comment_depth, 10) : 3,
          commentLimit: comment_limit ? parseInt(comment_limit, 10) : null,
          lang: reqLang,
        });
        emit('extracting', { source: 'reddit' });
        const titleMatch = baseMd.match(/^#\s+(.+)$/m);
        let shareId = null;
        if (cache) {
          shareId = cache.put({ url, title: titleMatch?.[1] || 'Reddit Post', markdown: baseMd, source: 'reddit', client, user_id: req.user?.id ?? null });
        }
        const quality = qualityScore(baseMd);
        const fm = wantFrontmatter
          ? buildFrontmatter({ title: titleMatch?.[1] || null, sourceUrl: url, quality }, { source: 'reddit', shareId })
          : '';
        send('result', { markdown: fm + baseMd, source: 'reddit', shareId: shareId || null });
        if (cache) cache.logExtraction({ url, source: 'reddit', quality, markdownLen: baseMd.length, extractorReason: null, durationMs: Date.now() - t0, client, cached: false });
        return res.end();
      }

      // Web path with optional Playwright fallback inside extractWeb
      const result = await extractWebFn(url, {
        comments: false,
        render: explicitRenderParam ? render : undefined,
        extractor: validExtractor,
        emit,
        signal: ac.signal,
      });

      let shareId = null;
      if (cache) {
        shareId = cache.put({ url, title: result.title, markdown: result.markdown, source: result.source, client, user_id: req.user?.id ?? null });
      }

      const fm = wantFrontmatter
        ? buildFrontmatter(result.metadata || {}, { source: result.source, shareId })
        : '';
      const finalMd = fm + result.markdown;

      send('result', { markdown: finalMd, source: result.source, shareId: shareId || null });
      if (cache) cache.logExtraction({
        url, source: result.source,
        quality: result.metadata?.quality,
        markdownLen: result.markdown.length,
        extractorReason: result.metadata?.extractorReason || null,
        durationMs: Date.now() - t0,
        client, cached: false,
      });
      res.end();
    } catch (err) {
      console.error('SSE stream error:', err);
      send('error', { message: String(err?.message ?? err) || 'Internal error' });
      res.end();
    }
  });

  app.get('/api/recipes/status', (req, res) => {
    const status = getRecipeStatus();
    const ok = status.rejected === 0;
    res.json({
      ok,
      loaded:   status.loaded,
      rejected: status.rejected,
      sources:  status.sources,
    });
  });

  app.get('/api/stats', (req, res) => {
    if (!cache) return res.json({ total: 0, window: '-7 days' });
    const window = req.query.window || '-7 days';
    res.json(cache.extractionStats(window));
  });

  app.get('/api/storage', (req, res) => {
    if (!cache) return res.json({ total: 0, retentionDays: 90 });
    res.json(cache.storageStats());
  });

  app.get('/api/config', (req, res) => {
    res.json({
      disablePublicHistory,
      authMode: auth ? auth.mode : 'disabled',
      authMisconfigured: !!auth?.isMisconfigured,
    });
  });

  app.get('/api/history', gate, (req, res) => {
    if (disablePublicHistory && !req.user) {
      return res.status(403).json({ error: 'Public history is disabled on this instance.' });
    }
    if (!cache) {
      return res.json([]);
    }
    const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100);
    if (req.user) {
      return res.json(cache.historyForUser(req.user.id, limit));
    }
    res.json(cache.history(limit));
  });

  app.get('/api/archive', gate, (req, res) => {
    if (disablePublicHistory && !req.user) {
      return res.status(403).json({ error: 'Public history is disabled on this instance.' });
    }
    if (!cache) {
      return res.json({ items: [], total: 0 });
    }
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    if (req.user) {
      return res.json(cache.historyPageForUser(req.user.id, limit, offset));
    }
    res.json(cache.historyPage(limit, offset));
  });

  app.delete('/api/cache/:id', gate, adminOnly, (req, res) => {
    if (!cache) {
      return res.status(404).json({ error: 'Cache not available' });
    }
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'Invalid ID' });
    const result = cache.delete(id);
    if (!result.changes) {
      return res.status(404).json({ error: 'Entry not found', id });
    }
    res.json({ ok: true, id });
  });

  app.delete('/api/cache', gate, adminOnly, (req, res) => {
    if (!cache) {
      return res.status(404).json({ error: 'Cache not available' });
    }
    cache.deleteAll();
    res.json({ ok: true });
  });

  return app;
}

const isDirectRun = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'));
if (isDirectRun || process.argv[1]?.endsWith('server.js')) {
  const port = process.env.PORT || 3000;
  const cache = createCache(process.env.CACHE_DB || './data/cache.db');
  const mode = process.env.PULLMD_AUTH_MODE || 'disabled';
  const auth = createAuth({ db: cache.db, mode, env: process.env });
  try {
    await auth.runMigration();
  } catch (err) {
    if (err && err.code === 'ERR_BOOTSTRAP_MISSING_CREDENTIALS') {
      console.error(formatBootstrapError(mode));
      process.exit(1);
    }
    throw err;
  }
  // Load site recipes (default + optional user overlay)
  const defaultRecipesPath = path.resolve(process.cwd(), 'site-recipes.default.json');
  const userRecipesPath = process.env.PULLMD_SITE_RECIPES
    || (fs.existsSync(path.resolve(process.cwd(), 'data/site-recipes.json'))
          ? path.resolve(process.cwd(), 'data/site-recipes.json')
          : null);
  loadRecipes({ defaultPath: defaultRecipesPath, userPath: userRecipesPath });

  // Hash recipe content; if changed since last boot, invalidate cache.
  const recipesHash = computeRecipesHash([defaultRecipesPath, userRecipesPath].filter(Boolean));
  applyRecipesInvalidation(cache, recipesHash);
  const invalidationStamp = cache.getMeta('recipes_invalidated_at');
  if (invalidationStamp) cache.setRecipesInvalidatedAt(invalidationStamp);

  const app = createApp({ cache, auth });
  app.listen(port, () => {
    console.log(`PullMD running on http://localhost:${port} (auth: ${mode})`);
  });
}
