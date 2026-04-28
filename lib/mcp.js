import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

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
}) {
  const server = new McpServer({ name: 'pullmd', version: '1.0.0' });

  server.registerTool(
    'read_url',
    {
      description:
        'Fetch a web page or Reddit thread and return clean Markdown. Auto-detects Reddit URLs, falls back through Cloudflare-Markdown and Mozilla Readability for everything else. Use this whenever you would otherwise fetch raw HTML — it produces dramatically cleaner content and saves context window space.',
      inputSchema: {
        url: z.string().url().describe('The URL to fetch'),
        comments: z.boolean().optional().describe('Include Reddit comments. Default true (ignored for non-Reddit URLs).'),
        comment_depth: z.number().int().min(1).max(10).optional().describe('Reddit comment nesting depth. Default 3.'),
        comment_limit: z.number().int().min(1).max(500).optional().describe('Optional cap on top-level Reddit comments. Default: no cap (Reddit returns ~200).'),
        frontmatter: z.boolean().optional().describe('Prepend YAML metadata block (title, source, fetched, quality, …). Default false.'),
        lang: z.enum(['de', 'en']).optional().describe('Language of the comments-section header. Default de.'),
        nocache: z.boolean().optional().describe('Bypass the 1-hour cache and re-fetch. Default false.'),
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
    }) => {
      const useCache = cache && !nocache;

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
            return {
              content: [{ type: 'text', text: fm + baseMd }],
            };
          }
        }
      }

      if (isRedditUrl(url)) {
        const baseMd = await extract(url, {
          comments,
          commentDepth: comment_depth,
          commentLimit: comment_limit,
          lang,
        });
        const titleMatch = baseMd.match(/^#\s+(.+)$/m);
        let shareId = null;
        if (cache) {
          shareId = cache.put({
            url,
            title: titleMatch?.[1] || 'Reddit Post',
            markdown: baseMd,
            source: 'reddit',
            client: 'api',
          });
        }
        const q = qualityScore(baseMd);
        const fm = frontmatter
          ? buildFrontmatter(
              { title: titleMatch?.[1] || null, sourceUrl: url, quality: q },
              { source: 'reddit', shareId }
            )
          : '';
        return {
          content: [{ type: 'text', text: fm + baseMd }],
        };
      }

      const result = await extractWeb(url, { comments: false });
      let shareId = null;
      if (cache) {
        shareId = cache.put({
          url,
          title: result.title,
          markdown: result.markdown,
          source: result.source,
          client: 'api',
        });
      }
      const fm = frontmatter
        ? buildFrontmatter(result.metadata || {}, { source: result.source, shareId })
        : '';
      return {
        content: [{ type: 'text', text: fm + result.markdown }],
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
      let refreshed = false;
      const ageMs = Date.now() - new Date(entry.created_at + 'Z').getTime();
      if (ageMs > 60 * 60 * 1000) {
        try {
          const md = entry.markdown || '';
          const hadComments =
            md.includes('\n## Kommentare') || md.includes('\n## Comments');
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
              client: 'api',
            });
            markdown = baseMd;
            refreshed = true;
          } else {
            const result = await extractWeb(entry.url, { comments: false });
            cache.put({
              url: entry.url,
              title: result.title,
              markdown: result.markdown,
              source: result.source,
              client: 'api',
            });
            markdown = result.markdown;
            refreshed = true;
          }
        } catch (err) {
          // Fall through with stale snapshot.
        }
      }

      return {
        content: [{ type: 'text', text: markdown }],
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
      server = createMcpServer(deps);
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
