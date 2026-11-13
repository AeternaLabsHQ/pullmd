// Starts the real PullMD app in-process for the browser tests: createApp()
// on an ephemeral port, a throwaway SQLite cache, and stubbed extractors, so
// no test touches the network or a sidecar.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../../server.js';
import { createCache } from '../../lib/cache.js';

// Hosts the tests convert. Allowlisted names skip the SSRF guard's DNS
// lookup (lib/ssrf.js), which keeps the suite offline.
export const WEB_URL = 'https://example.test/article';
export const REDDIT_URL = 'https://www.reddit.com/r/test/comments/abc123/a_post/';
export const HN_URL = 'https://news.ycombinator.com/item?id=4242';
process.env.PULLMD_ALLOWED_HOSTS = 'example.test,www.reddit.com,news.ycombinator.com';

/** A promise with its resolve/reject exposed, to hold a stub mid-flight. */
export function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** Web extractor result shaped like lib/web.js extractWeb(). */
export function webResult(url, { title = 'Example Article', body } = {}) {
  const markdown = body ?? `# ${title}\n\nFirst paragraph of the article.\n\n## Section\n\nA [link](https://example.test/other) and **bold** text.\n`;
  return {
    markdown,
    title,
    source: 'readability',
    metadata: { title, sourceUrl: url, quality: 0.9 },
  };
}

/**
 * @param {object} [opts]
 * @param {Function} [opts.extractWeb]   (url, options) => result; default webResult()
 * @param {Function} [opts.extractPost]  Reddit stub; default returns a short post
 * @param {Function} [opts.extractHn]    HN stub; default returns a short item
 * @param {Function} [opts.extractHtml]  local HTML upload stub
 * @param {Function} [opts.extractFile]  file upload stub
 * @param {boolean}  [opts.disablePublicHistory]
 * @returns {Promise<{ baseUrl: string, cache: object, calls: object, close: Function }>}
 */
export async function startApp(opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pullmd-e2e-'));
  const cache = createCache(path.join(dir, 'cache.db'));
  // Every call each stub received, so tests can assert what reached the server.
  const calls = { web: [], reddit: [], hn: [], html: [], file: [] };
  const record = (list, fn) => async (...args) => { list.push(args); return fn(...args); };

  const app = createApp({
    cache,
    disablePublicHistory: opts.disablePublicHistory ?? false,
    statusChecker: async () => ({ ok: true, version: 'e2e', services: {} }),
    extractWeb: record(calls.web, opts.extractWeb || (async (url) => webResult(url))),
    extractPost: record(calls.reddit, opts.extractPost || (async () => '# A Reddit post\n\nPost body.\n')),
    extractHn: record(calls.hn, opts.extractHn || (async () => '# An HN item\n\nItem body.\n')),
    extractHtml: record(calls.html, opts.extractHtml || (async () => {
      const text = 'Uploaded HTML content. '.repeat(20);
      return {
        markdown: `# Uploaded page\n\n${text}\n`,
        title: 'Uploaded page',
        source: 'readability',
        metadata: { title: 'Uploaded page', contentLength: text.length },
      };
    })),
    extractFile: record(calls.file, opts.extractFile || (async (buf, { filename }) => ({
      markdown: `# ${filename}\n\n${buf.toString('utf8')}\n`,
      title: filename,
      source: 'local',
      metadata: { title: filename },
    }))),
  });

  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  async function close() {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    try { cache.db.close(); } catch {}
    fs.rmSync(dir, { recursive: true, force: true });
  }

  return { baseUrl, cache, calls, close };
}
