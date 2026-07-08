import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { mergeFrontmatter, mergeMediaFrontmatter } from './frontmatter.js';
import { publicUrlFor, PULLMD_VERSION } from './distrib.js';
import { assertUrlAllowed, SsrfError } from './ssrf.js';

function shareUrl(publicUrl, shareId) {
  if (!shareId) return null;
  const base = (publicUrl || '').replace(/\/+$/, '');
  return `${base}/s/${shareId}`;
}

/**
 * Build a stateless MCP server exposing PullMD tools.
 *
 * Tools:
 *   - read_url     fetch a web page or Reddit thread as Markdown
 *   - get_share    fetch by share-id, refreshing from source if >1h old
 *   - list_recent  recently fetched URLs
 *
 * Dependencies are passed in so the same business logic backs /api and MCP.
 */
export function createMcpServer({
  extract,
  extractWeb,
  cache,
  qualityScore,
  buildFrontmatter,
  isRedditUrl,
  publicUrl,
  user = null,
}) {
  const server = new McpServer({ name: 'pullmd', version: PULLMD_VERSION });
  const baseUrl = publicUrl || process.env.PUBLIC_URL || `http://localhost:${process.env.PORT || 3000}`;

  server.registerTool(
    'read_url',
    {
      description:
        'Fetch a URL and return clean Markdown. Handles web pages (Cloudflare-Markdown, Readability+Trafilatura, headless-Chromium fallback for JS-heavy sites), Reddit threads with comment trees, documents (PDF, Word, PowerPoint, Excel, EPUB, CSV, …), YouTube videos (title, description, transcript with timecodes), and image/audio URLs (AI caption / transcription) — document, YouTube, and media support depend on server configuration. Use this whenever you would otherwise fetch raw HTML or download a document — it produces dramatically cleaner content and saves context window space.',
      inputSchema: {
        url: z.string().url().describe('The URL to fetch'),
        comments: z.boolean().optional().describe('Include Reddit comments. Default true (ignored for non-Reddit URLs).'),
        comment_depth: z.number().int().min(1).max(10).optional().describe('Reddit comment nesting depth. Default 3.'),
        comment_limit: z.number().int().min(1).max(500).optional().describe('Optional cap on top-level Reddit comments. Default: no cap (Reddit returns ~200).'),
        frontmatter: z.boolean().optional().describe('Prepend YAML metadata block (title, source, fetched, quality, …). Default false.'),
        lang: z.enum(['de', 'en']).optional().describe('Language of the comments-section header. Default de.'),
        nocache: z.boolean().optional().describe('Bypass the 1-hour cache and re-fetch. Default false.'),
        extractor: z.enum(['readability', 'trafilatura', 'playwright']).optional().describe('Force a specific extractor and skip the pickBest decision. Use as an escape hatch when the default chooses poorly for a given site. Ignored for Reddit URLs.'),
        yt_timecodes: z.enum(['links', 'plain', 'none']).optional().describe('YouTube transcript timecode style (links = clickable timestamps, default).'),
        yt_chunk: z.number().int().min(0).optional().describe('YouTube transcript block size in seconds; 0 = per original snippet.'),
        pdf_ocr: z.boolean().optional().describe('Use high-quality OCR for PDFs instead of the default text extraction (requires PULLMD_PDF_OCR_API_KEY). Default false.'),
      },
    },
    async ({
      url,
      comments = true,
      comment_depth = 3,
      comment_limit = null,
      frontmatter = false,
      lang = 'de',
      nocache = false,
      extractor,
      yt_timecodes,
      yt_chunk,
      pdf_ocr = false,
    }) => {
      try {
        await assertUrlAllowed(url);
      } catch (err) {
        if (err instanceof SsrfError) {
          return { content: [{ type: 'text', text: `URL not allowed: ${err.message}` }], isError: true };
        }
        throw err;
      }

      // An explicit extractor override (or pdf=ocr) should bypass the cache so
      // the forced path actually runs. Same logic as /api in server.js.
      const explicitYtParams = yt_timecodes !== undefined || yt_chunk !== undefined;
      const useCache = cache && !nocache && !extractor && !explicitYtParams && !pdf_ocr;

      if (useCache) {
        const cached = cache.get(url);
        if (cached) {
          const reddit = isRedditUrl(url);
          const hasComments =
            cached.markdown.includes('\n## Kommentare') ||
            cached.markdown.includes('\n## Comments');
          if (!reddit || !comments || hasComments) {
            const baseMd = cached.markdown;
            const q = qualityScore(baseMd);
            const titleMatch = baseMd.match(/^#\s+(.+)$/m);
            const fm = frontmatter
              ? buildFrontmatter(
                  { title: titleMatch?.[1] || cached.title, sourceUrl: url, quality: q },
                  { source: cached.source, shareId: cached.share_id }
                )
              : '';
            let text = mergeFrontmatter(fm + baseMd, [
              ['source', cached.source],
              ['share_id', cached.share_id],
              ['share_url', shareUrl(baseUrl, cached.share_id)],
              ['quality', q],
              ['cached', true],
            ]);
            if (frontmatter) text = mergeMediaFrontmatter(text, cached.metadata, cached.source);
            return {
              content: [{ type: 'text', text }],
            };
          }
        }
      }

      if (isRedditUrl(url)) {
        const r = await extract(url, {
          comments,
          commentDepth: comment_depth,
          commentLimit: comment_limit,
          lang,
          withMeta: true,
        });
        // Test doubles may return a bare string; production returns { markdown, meta }.
        const baseMd = typeof r === 'string' ? r : r.markdown;
        const redditMeta = typeof r === 'string' ? null : r.meta;
        const titleMatch = baseMd.match(/^#\s+(.+)$/m);
        let shareId = null;
        if (cache) {
          shareId = cache.put({
            url,
            title: titleMatch?.[1] || 'Reddit Post',
            markdown: baseMd,
            source: 'reddit',
            client: 'api',
            user_id: user?.id ?? null,
            metadata: redditMeta,
          });
        }
        const q = qualityScore(baseMd);
        const fm = frontmatter
          ? buildFrontmatter(
              { title: titleMatch?.[1] || null, sourceUrl: url, quality: q },
              { source: 'reddit', shareId }
            )
          : '';
        let text = mergeFrontmatter(fm + baseMd, [
          ['source', 'reddit'],
          ['share_id', shareId],
          ['share_url', shareUrl(baseUrl, shareId)],
          ['quality', q],
          ['cached', false],
        ]);
        if (frontmatter) text = mergeMediaFrontmatter(text, redditMeta, 'reddit');
        return {
          content: [{ type: 'text', text }],
        };
      }

      const result = await extractWeb(url, {
        comments: false,
        extractor,
        pdfOcr: pdf_ocr,
        ...(yt_timecodes !== undefined && { ytTimecodes: yt_timecodes }),
        ...(yt_chunk !== undefined && { ytChunk: yt_chunk }),
      });
      let shareId = null;
      if (cache && !result.noStore) {
        shareId = cache.put({
          url,
          title: result.title,
          markdown: result.markdown,
          source: result.source,
          client: 'api',
          user_id: user?.id ?? null,
          metadata: result.metadata,
        });
      }
      const fm = frontmatter
        ? buildFrontmatter(result.metadata || {}, { source: result.source, shareId })
        : '';
      const q = result.metadata?.quality ?? qualityScore(result.markdown);
      let text = mergeFrontmatter(fm + result.markdown, [
        ['source', result.source],
        ['share_id', shareId],
        ['share_url', shareUrl(baseUrl, shareId)],
        ['quality', q],
        ['cached', false],
      ]);
      if (frontmatter) text = mergeMediaFrontmatter(text, result.metadata, result.source);
      return {
        content: [{ type: 'text', text }],
      };
    }
  );

  server.registerTool(
    'get_share',
    {
      description:
        'Fetch a previously-pulled URL by its 8-hex share id. If the cached row is older than 1h it is refreshed from the original source first; if the source is unreachable the last snapshot is returned. Use this as a stable live-endpoint for content that changes over time (e.g. a subreddit feed).',
      inputSchema: {
        id: z.string().describe('The 8-hex share id from a prior read_url call.'),
      },
    },
    async ({ id }) => {
      if (!cache) {
        return { content: [{ type: 'text', text: 'Cache not available' }], isError: true };
      }
      const entry = cache.getByShareId(id);
      if (!entry) {
        return {
          content: [{ type: 'text', text: 'Share id not found or expired' }],
          isError: true,
        };
      }

      let markdown = entry.markdown;
      let source = entry.source;
      let refreshed = false;
      const ageMs = Date.now() - new Date(entry.created_at + 'Z').getTime();
      if (ageMs > 60 * 60 * 1000) {
        try {
          const md = entry.markdown || '';
          const hadComments =
            md.includes('\n## Kommentare') || md.includes('\n## Comments');
          const inferredLang = md.includes('\n## Comments') ? 'en' : 'de';
          if (isRedditUrl(entry.url)) {
            const r = await extract(entry.url, {
              comments: hadComments,
              commentDepth: 3,
              lang: inferredLang,
              withMeta: true,
            });
            // Test doubles may return a bare string; production returns { markdown, meta }.
            const baseMd = typeof r === 'string' ? r : r.markdown;
            const redditMeta = typeof r === 'string' ? null : r.meta;
            const titleMatch = baseMd.match(/^#\s+(.+)$/m);
            cache.put({
              url: entry.url,
              title: titleMatch?.[1] || entry.title || 'Reddit Post',
              markdown: baseMd,
              source: 'reddit',
              client: 'api',
              user_id: user?.id ?? null,
              metadata: redditMeta,
            });
            markdown = baseMd;
            source = 'reddit';
            refreshed = true;
          } else {
            const result = await extractWeb(entry.url, { comments: false });
            // Transient failure (e.g. YouTube 429): keep the existing good
            // snapshot rather than overwriting it with a placeholder.
            if (result.noStore) {
              markdown = entry.markdown;
              source = entry.source;
            } else {
              cache.put({
                url: entry.url,
                title: result.title,
                markdown: result.markdown,
                source: result.source,
                client: 'api',
                user_id: user?.id ?? null,
                metadata: result.metadata,
              });
              markdown = result.markdown;
              source = result.source;
              refreshed = true;
            }
          }
        } catch (err) {
          // Fall through with stale snapshot.
        }
      }

      const text = mergeFrontmatter(markdown, [
        ['url', entry.url],
        ['source', source],
        ['share_id', id],
        ['share_url', shareUrl(baseUrl, id)],
        ['refreshed', refreshed],
        ['age_ms', ageMs],
      ]);
      return {
        content: [{ type: 'text', text }],
      };
    }
  );

  server.registerTool(
    'list_recent',
    {
      description:
        'List recently fetched URLs from the PullMD cache. Useful for discovering what has been read in this or earlier sessions, or to find the share-id of a previously-pulled URL.',
      inputSchema: {
        limit: z
          .number()
          .int()
          .min(1)
          .max(50)
          .optional()
          .describe('Max items to return. Default 10.'),
      },
    },
    async ({ limit = 10 }) => {
      if (!cache) {
        return { content: [{ type: 'text', text: '[]' }] };
      }
      const items = cache.history(limit).map((it) => ({
        url: it.url,
        title: it.title,
        source: it.source,
        share_id: it.share_id,
        share_url: shareUrl(baseUrl, it.share_id),
        created_at: it.created_at,
      }));
      return {
        content: [{ type: 'text', text: JSON.stringify(items, null, 2) }],
      };
    }
  );

  return server;
}

/**
 * Express handler for stateless MCP-over-HTTP. Each request gets a fresh
 * server + transport pair; tools are stateless so this is cheap.
 *
 * Usage:
 *   app.post('/mcp', express.json(), mcpHandler({ ...deps }));
 *   app.get('/mcp',  mcpHandler({ ...deps }));
 */
export function mcpHandler(deps) {
  return async (req, res) => {
    let server;
    let transport;
    try {
      const publicUrl = publicUrlFor(req);
      server = createMcpServer({ ...deps, publicUrl, user: req.user || null });
      transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on('close', () => {
        try { transport.close(); } catch (_) {}
        try { server.close(); } catch (_) {}
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error('MCP handler error:', err);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Internal MCP error' },
          id: null,
        });
      }
    }
  };
}
