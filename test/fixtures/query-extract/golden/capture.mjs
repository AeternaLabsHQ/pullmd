// Golden-capture script for the query-extract byte-identity check.
//
// Captured on branch feat/query-extract BEFORE any query-extract code existed
// (base commit eab7bd4), so these goldens ARE the pre-feature behavior.
// Task 6's acceptance test must replay the exact same app setup + requests and
// compare normalized bodies against the golden files.
//
// Run from the repo root: node test/fixtures/query-extract/golden/capture.mjs
//
// Normalization: share ids are random 8-char hex -> "00000000"; ISO timestamps
// (the dynamic `fetched` field) -> epoch.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../../../../server.js';
import { createCache } from '../../../../lib/cache.js';

const here = dirname(fileURLToPath(import.meta.url));
const pageMd = readFileSync(join(here, '../page.md'), 'utf8');

// example.com: resolves publicly, passes the SSRF guard (like existing tests).
export const FIXTURE_URL = 'https://example.com/acme-sync';

export function buildFixtureApp() {
  return createApp({
    extractWeb: async () => ({
      markdown: pageMd,
      title: 'Acme Sync Server Documentation',
      source: 'readability',
      metadata: {
        title: 'Acme Sync Server Documentation',
        author: 'Acme Docs Team',
        published: '2026-01-15T09:00:00.000Z',
        description: 'Installation, configuration and operations manual.',
      },
    }),
    cache: createCache(':memory:'),
  });
}

export function normalize(body) {
  return body
    .replace(/\b[0-9a-f]{8}\b/g, '00000000')
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/g, '1970-01-01T00:00:00.000Z');
}

// Requests replayed against ONE app instance, in this order (order matters:
// the first request populates the cache, later ones exercise the cache-hit path).
export const GOLDEN_REQUESTS = [
  ['default.md', `/api?url=${encodeURIComponent(FIXTURE_URL)}`],
  ['cachehit.md', `/api?url=${encodeURIComponent(FIXTURE_URL)}`],
  ['json.json', `/api?url=${encodeURIComponent(FIXTURE_URL)}&format=json`],
  ['text.txt', `/api?url=${encodeURIComponent(FIXTURE_URL)}&format=text`],
  ['frontmatter.md', `/api?url=${encodeURIComponent(FIXTURE_URL)}&frontmatter=true`],
];

async function main() {
  const app = buildFixtureApp();
  const server = app.listen(0);
  await new Promise((r) => server.on('listening', r));
  const port = server.address().port;
  for (const [file, path] of GOLDEN_REQUESTS) {
    const res = await fetch(`http://localhost:${port}${path}`);
    if (res.status !== 200) throw new Error(`${path} -> ${res.status}`);
    writeFileSync(join(here, file), normalize(await res.text()));
    console.log(`wrote ${file}`);
  }
  server.close();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
