// End-to-end acceptance suite for the query-extract feature (Task 6).
//
// Maps 1:1 to the feature's handoff checklist:
//   1. Byte-identity against pre-feature golden files (no `query`).
//   2. With `query`: well-formed subset (fences balanced, table intact, breadcrumb present).
//   3. Heading-less page -> paragraph fallback (block mode) end-to-end.
//   4. Non-contiguous matches -> well-formed elision marker(s) in the body.
//   5. No-match query -> whole page + confidence low (header + json field).
//   6. Token reduction measured on the fixture page for a pinned query.
//   7. Two sequential query requests, same URL -> extractor invoked exactly once.
//
// Uses test/fixtures/query-extract/page.md and the golden files/harness
// documented in test/fixtures/query-extract/golden/capture.mjs. Does NOT
// duplicate cases already covered by test/server-query-extract.test.js or
// test/mcp-query-extract.test.js.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../server.js';
import { createCache } from '../lib/cache.js';
import { buildFixtureApp, FIXTURE_URL, GOLDEN_REQUESTS, normalize } from './fixtures/query-extract/golden/capture.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const goldenDir = join(here, 'fixtures/query-extract/golden');
const pageMd = readFileSync(join(here, 'fixtures/query-extract/page.md'), 'utf8');

const ELISION_MARKER = '<!-- … -->';

async function request(app, path, opts = {}) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const port = server.address().port;
      fetch(`http://localhost:${port}${path}`, opts)
        .then(async (res) => {
          const text = await res.text();
          server.close();
          resolve({ status: res.status, headers: Object.fromEntries(res.headers), body: text });
        })
        .catch((err) => { server.close(); reject(err); });
    });
  });
}

// --- 1. Byte-identity against pre-feature golden files -------------------
//
// Replays every GOLDEN_REQUESTS entry, IN ORDER, against a single fresh
// buildFixtureApp() instance (order matters: the first request populates the
// cache, later ones exercise the cache-hit path — exactly as capture.mjs
// documents). None of these requests carry `query`, so this is the
// byte-identity gate: the no-query path must be byte-for-byte unchanged from
// the pre-feature server.
describe('Acceptance 1: byte-identity against pre-feature golden files (no query)', () => {
  let app;
  let server;
  let port;

  before(async () => {
    app = buildFixtureApp();
    server = app.listen(0);
    await new Promise((resolve) => server.on('listening', resolve));
    port = server.address().port;
  });

  after(() => server.close());

  for (const [file, path] of GOLDEN_REQUESTS) {
    it(`${file}: normalized response body equals the committed golden file exactly`, async () => {
      const res = await fetch(`http://localhost:${port}${path}`);
      assert.equal(res.status, 200);
      const body = normalize(await res.text());
      const golden = readFileSync(join(goldenDir, file), 'utf8');
      assert.equal(body, golden, `byte-identity mismatch for ${file}`);
    });
  }
});

// --- 2 & 6. Well-formed subset + measured token reduction -----------------
//
// Pinned query: "environment variables configuration" against the fixture
// page. Measured: originalTokens=1751, returnedTokens=499 (ratio ~0.285),
// comfortably under the 0.3 * originalTokens bar. Table has 6 data rows plus
// header + delimiter; the env-var table lives under "## Configuration" >
// "### Environment variables", so an intact table AND an ancestor breadcrumb
// heading are both exercised by one query.
describe('Acceptance 2+6: well-formed subset and measured token reduction', () => {
  const QUERY = 'environment variables configuration';

  it('selects an intact env-var table with its breadcrumb heading, fences balanced', async () => {
    const app = buildFixtureApp();
    const res = await request(app, `/api?url=${encodeURIComponent(FIXTURE_URL)}&query=${encodeURIComponent(QUERY)}`);
    assert.equal(res.status, 200);
    assert.equal(res.headers['x-extracted'], 'true');

    const body = res.body;

    // Fence delimiters balanced (even count): no atomic code block was split.
    const fenceCount = (body.match(/```/g) || []).length;
    assert.equal(fenceCount % 2, 0, `expected an even number of \`\`\` fence delimiters, got ${fenceCount}`);

    // The env-var table is intact: header, delimiter row, and all 6 data rows.
    assert.ok(body.includes('| Variable | Default | Description |'), 'table header row missing');
    assert.ok(body.includes('| --- | --- | --- |'), 'table delimiter row missing');
    for (const varName of ['ACME_PORT', 'ACME_DATA_DIR', 'ACME_LOG_LEVEL', 'ACME_MAX_BODY', 'ACME_FEDERATION', 'ACME_TOKEN_TTL']) {
      assert.ok(body.includes(`\`${varName}\``), `table row for ${varName} missing — table was not selected intact`);
    }

    // Breadcrumb: the ancestor heading ("## Configuration") is present ahead
    // of the selected sub-heading ("### Environment variables"), giving the
    // excerpt context it wouldn't have if only the leaf section were kept.
    const parentIdx = body.indexOf('## Configuration');
    const childIdx = body.indexOf('### Environment variables');
    assert.ok(parentIdx !== -1, 'ancestor breadcrumb heading "## Configuration" missing');
    assert.ok(childIdx !== -1, 'selected heading "### Environment variables" missing');
    assert.ok(parentIdx < childIdx, 'breadcrumb heading must precede the selected sub-heading');
  });

  it('reduces token count to <= 30% of the original for the pinned query', async () => {
    const app = buildFixtureApp();
    const res = await request(app, `/api?url=${encodeURIComponent(FIXTURE_URL)}&query=${encodeURIComponent(QUERY)}`);
    assert.equal(res.status, 200);

    const originalTokens = Number(res.headers['x-extract-original-tokens']);
    const returnedTokens = Number(res.headers['x-extract-returned-tokens']);
    assert.ok(Number.isFinite(originalTokens) && originalTokens > 0);
    assert.ok(Number.isFinite(returnedTokens) && returnedTokens > 0);

    const ratio = returnedTokens / originalTokens;
    assert.ok(
      returnedTokens <= 0.3 * originalTokens,
      `measured on the fixture page: originalTokens=${originalTokens}, returnedTokens=${returnedTokens}, ratio=${ratio.toFixed(3)} (expected <= 0.3)`,
    );
  });
});

// --- 3. Heading-less page -> paragraph fallback (block mode) --------------
//
// A page with zero headings and > 800 estimated tokens (headingCount < 2
// forces block mode per lib/query-extract.js). One paragraph carries a
// distinctive term ("gizmo"); block mode must select a contiguous window
// around it and leave clearly unrelated far paragraphs out.
function fillerParagraph(seed, sentences = 20) {
  const words = ['lorem', 'ipsum', 'dolor', 'sit', 'amet', 'consectetur', 'adipiscing', 'elit', 'sed', 'do'];
  const lines = [];
  for (let i = 0; i < sentences; i++) {
    lines.push(`${seed} ${words[i % words.length]} ${words[(i + 3) % words.length]} filler sentence number ${i} padding this paragraph out.`);
  }
  return lines.join(' ');
}

function headinglessPage() {
  return [
    fillerParagraph('alpha'),
    '',
    fillerParagraph('bravo'),
    '',
    'The gizmo widget requires a firmware update before first use; without it the gizmo will refuse to pair with the hub.',
    '',
    fillerParagraph('charlie'),
    '',
    fillerParagraph('delta'),
  ].join('\n\n');
}

describe('Acceptance 3: heading-less page falls back to block mode end-to-end', () => {
  it('extracts a contiguous window around the matching paragraph, excluding far-away filler', async () => {
    const app = createApp({
      extractWeb: async () => ({ markdown: headinglessPage(), title: 'Heading-less Page', source: 'readability' }),
      cache: createCache(':memory:'),
    });
    const res = await request(app, '/api?url=https://example.com/headingless&query=gizmo+firmware+update');
    assert.equal(res.status, 200);
    assert.equal(res.headers['x-extracted'], 'true');
    assert.equal(res.headers['x-extract-confidence'], 'high');
    // Block mode reports sectionsSelected as the output region count.
    assert.equal(res.headers['x-extract-sections'], '1');

    assert.ok(res.body.includes('gizmo widget requires a firmware update'), 'matching paragraph must be present');
    assert.ok(!res.body.includes('alpha lorem'), 'far unrelated paragraph "alpha" must be excluded');
    assert.ok(!res.body.includes('delta lorem'), 'far unrelated paragraph "delta" must be excluded');

    const originalTokens = Number(res.headers['x-extract-original-tokens']);
    const returnedTokens = Number(res.headers['x-extract-returned-tokens']);
    assert.ok(returnedTokens < originalTokens, 'block-mode excerpt must be smaller than the original page');
  });
});

// --- 4. Non-contiguous matches -> well-formed elision marker(s) -----------
//
// A combined query pulling in both far-apart topics of the fixture page
// (env vars under "## Configuration" and the database-locked section under
// "## Troubleshooting") produces a non-contiguous selection. Verifies the
// elision marker is always well-formed (`\n\n<!-- … -->\n\n`, never bare or
// glued to adjacent text, never wrapping an empty region) AND that content
// from both topics is present, in original document order.
describe('Acceptance 4: non-contiguous matches use a well-formed elision marker', () => {
  it('assembles disjoint regions with the marker between them, in document order', async () => {
    const app = buildFixtureApp();
    const query = 'environment variables configuration database locked sqlite';
    const res = await request(app, `/api?url=${encodeURIComponent(FIXTURE_URL)}&query=${encodeURIComponent(query)}`);
    assert.equal(res.status, 200);
    assert.equal(res.headers['x-extracted'], 'true');

    const body = res.body;
    assert.ok(body.includes(ELISION_MARKER), 'expected at least one elision marker for non-contiguous matches');

    // Well-formedness: every marker occurrence is wrapped in the
    // "\n\n<marker>\n\n" separator, and every region around it has content.
    // A raw count of the marker text that disagrees with the count derived
    // from splitting on the well-formed wrapper would mean a malformed
    // (bare, doubled, or empty-region) marker slipped through.
    const wrapped = `\n\n${ELISION_MARKER}\n\n`;
    const parts = body.split(wrapped);
    assert.ok(parts.length >= 2, 'expected at least 2 regions separated by the elision marker');
    for (const part of parts) {
      assert.ok(part.trim().length > 0, 'elision marker must never wrap an empty region');
    }
    const rawMarkerCount = (body.match(/<!-- … -->/g) || []).length;
    assert.equal(rawMarkerCount, parts.length - 1, 'every elision marker occurrence must use the well-formed wrapper');

    // Content from both far-apart topics is present, in original document order.
    const envIdx = body.indexOf('ACME_TOKEN_TTL');
    const dbIdx = body.indexOf('single-writer by design');
    assert.ok(envIdx !== -1, 'env-var content ("## Configuration" region) missing');
    assert.ok(dbIdx !== -1, 'database-locked content ("## Troubleshooting" region) missing');
    assert.ok(envIdx < dbIdx, 'regions must stay in original document order (Configuration precedes Troubleshooting)');
  });
});

// --- 5. No-match query -> whole page + confidence low ----------------------
describe('Acceptance 5: no-match query returns the whole page with confidence low', () => {
  it('header: X-Extracted false, X-Extract-Confidence low, full page returned', async () => {
    const app = buildFixtureApp();
    const res = await request(app, `/api?url=${encodeURIComponent(FIXTURE_URL)}&query=${encodeURIComponent('xyzzy quux nonexistent')}`);
    assert.equal(res.status, 200);
    assert.equal(res.headers['x-extracted'], 'false');
    assert.equal(res.headers['x-extract-confidence'], 'low');
    // Whole page: both far-apart sections are present untouched.
    assert.ok(res.body.includes('### Environment variables'));
    assert.ok(res.body.includes('### Database is locked'));
    assert.ok(!res.body.includes(ELISION_MARKER), 'no elision marker expected when the whole page is returned');
  });

  it('json field: extract.extracted false, extract.confidence low', async () => {
    const app = buildFixtureApp();
    const res = await request(app, `/api?url=${encodeURIComponent(FIXTURE_URL)}&query=${encodeURIComponent('xyzzy quux nonexistent')}&format=json`);
    assert.equal(res.status, 200);
    const json = JSON.parse(res.body);
    assert.ok(json.extract);
    assert.equal(json.extract.extracted, false);
    assert.equal(json.extract.confidence, 'low');
    assert.equal(json.markdown, pageMd, 'full unmodified page markdown expected in the json body');
  });
});

// --- 7. Two sequential query requests, same URL -> one extractor call -----
describe('Acceptance 7: two sequential query requests to the same URL invoke the extractor once', () => {
  it('second query request is served from cache; extractor runs only on the first', async () => {
    let calls = 0;
    const app = createApp({
      extractWeb: async () => {
        calls++;
        return { markdown: pageMd, title: 'Acme Sync Server Documentation', source: 'readability' };
      },
      cache: createCache(':memory:'),
    });

    const first = await request(app, `/api?url=${encodeURIComponent(FIXTURE_URL)}&query=${encodeURIComponent('environment variables configuration')}`);
    assert.equal(first.status, 200);
    assert.equal(first.headers['x-extracted'], 'true');
    assert.equal(calls, 1);

    const second = await request(app, `/api?url=${encodeURIComponent(FIXTURE_URL)}&query=${encodeURIComponent('database locked sqlite')}`);
    assert.equal(second.status, 200);
    assert.equal(second.headers['x-extracted'], 'true');
    assert.equal(calls, 1, 'second query request must be served from cache; the extractor must not run again');
    assert.ok(second.body.includes('### Database is locked'));
  });
});
