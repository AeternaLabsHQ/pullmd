import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import {
  GUARD_LIMITS,
  isEnabled,
  bodyTextLength,
  shouldAttempt,
  findDominantContainer,
  acceptCandidate,
  containerLabel,
  guardReason,
} from '../lib/coverage-guard.js';
import { extractHtml, extractWeb } from '../lib/web.js';
import { RecipeSchema } from '../lib/recipes.js';

const bodyOf = (inner) => parseHTML(`<html><body>${inner}</body></html>`).document.querySelector('body');

// Runs fn with PULLMD_COVERAGE_GUARD set to value, then restores the previous value.
function withGuardEnv(value, fn) {
  const prev = process.env.PULLMD_COVERAGE_GUARD;
  if (value === undefined) delete process.env.PULLMD_COVERAGE_GUARD;
  else process.env.PULLMD_COVERAGE_GUARD = value;
  try { return fn(); } finally {
    if (prev === undefined) delete process.env.PULLMD_COVERAGE_GUARD;
    else process.env.PULLMD_COVERAGE_GUARD = prev;
  }
}

// Async variant for tests with async functions like extractHtml.
async function withGuardEnvAsync(value, fn) {
  const prev = process.env.PULLMD_COVERAGE_GUARD;
  if (value === undefined) delete process.env.PULLMD_COVERAGE_GUARD;
  else process.env.PULLMD_COVERAGE_GUARD = value;
  try { return await fn(); } finally {
    if (prev === undefined) delete process.env.PULLMD_COVERAGE_GUARD;
    else process.env.PULLMD_COVERAGE_GUARD = prev;
  }
}

describe('coverage guard limits', () => {
  it('pins the calibrated constants', () => {
    assert.equal(GUARD_LIMITS.MIN_BODY_TEXT, 20_000);
    assert.equal(GUARD_LIMITS.MAX_COVERAGE, 0.10);
    assert.equal(GUARD_LIMITS.DOMINANCE, 0.90);
    assert.equal(GUARD_LIMITS.MIN_GAIN, 3);
    assert.equal(GUARD_LIMITS.MIN_PARAGRAPHS, 5);
    assert.equal(GUARD_LIMITS.MAX_LABEL, 60);
  });
});

describe('isEnabled', () => {
  it('defaults to on', () => {
    assert.equal(withGuardEnv(undefined, isEnabled), true);
  });

  it('is off only for the literal off switch, case and space tolerant', () => {
    assert.equal(withGuardEnv('off', isEnabled), false);
    assert.equal(withGuardEnv('OFF', isEnabled), false);
    assert.equal(withGuardEnv(' off ', isEnabled), false);
    assert.equal(withGuardEnv('false', isEnabled), true);
    assert.equal(withGuardEnv('on', isEnabled), true);
  });
});

describe('bodyTextLength', () => {
  it('collapses whitespace before measuring', () => {
    assert.equal(bodyTextLength(parseHTML('<html><body>  a\n\n   b  </body></html>').document), 3);
  });

  it('returns 0 when there is no body', () => {
    assert.equal(bodyTextLength({ querySelector: () => null }), 0);
  });

  it('returns 0 for a nullish document', () => {
    assert.equal(bodyTextLength(null), 0);
  });
});

describe('shouldAttempt', () => {
  it('skips bodies below the size floor even at absurd coverage', () => {
    assert.equal(shouldAttempt(19_999, 1), false);
  });

  it('fires on a large body with a sliver of an extract', () => {
    assert.equal(shouldAttempt(100_000, 3_000), true);
  });

  it('skips when coverage is at or above the ceiling', () => {
    assert.equal(shouldAttempt(100_000, 10_000), false);
    assert.equal(shouldAttempt(100_000, 9_999), true);
  });

  it('skips entirely when the guard is switched off', () => {
    assert.equal(withGuardEnv('off', () => shouldAttempt(100_000, 3_000)), false);
  });
});

describe('findDominantContainer', () => {
  const PROSE = 'x'.repeat(1000);

  it('stops where the text branches across siblings', () => {
    const body = bodyOf(`<div class="wrap"><div class="a">${PROSE}</div><div class="b">${PROSE}</div></div>`);
    assert.equal(findDominantContainer(body).getAttribute('class'), 'wrap');
  });

  it('descends several levels while one child keeps dominating', () => {
    const body = bodyOf(`<div class="outer"><div class="inner"><div class="a">${PROSE}</div><div class="b">${PROSE}</div></div></div>`);
    assert.equal(findDominantContainer(body).getAttribute('class'), 'inner');
  });

  it('keeps descending past small siblings instead of stopping at them', () => {
    // A sibling that holds a sliver of the text is not a branch point. This is
    // the property that separates "one container owns the page" from "the page
    // has several parts", and it is what makes the guard work on real markup.
    const body = bodyOf(`<div class="wrap"><div class="a">${PROSE}</div><div class="b">short</div></div>`);
    assert.equal(findDominantContainer(body).getAttribute('class'), 'a');
  });

  it('finds the dominant container even when the body itself has several children', () => {
    // Real cleaned pages keep more than one child under body. Requiring a single
    // child here would make the guard silently never fire.
    const body = bodyOf(`<div class="main">${PROSE}</div><div class="tiny">short</div>`);
    assert.equal(findDominantContainer(body).getAttribute('class'), 'main');
  });

  it('returns null when the text is spread across siblings of the body', () => {
    const body = bodyOf(`<div class="a">${PROSE}</div><div class="b">${PROSE}</div><div class="c">${PROSE}</div>`);
    assert.equal(findDominantContainer(body), null);
  });

  it('ignores children that carry no text', () => {
    const body = bodyOf(`<div class="wrap"><span class="empty"></span><div class="a">${PROSE}</div></div>`);
    assert.equal(findDominantContainer(body).getAttribute('class'), 'a');
  });

  it('returns null for an empty body', () => {
    assert.equal(findDominantContainer(bodyOf('')), null);
  });

  it('returns null for a nullish body', () => {
    assert.equal(findDominantContainer(null), null);
  });

  it('stops at the depth limit instead of walking forever', () => {
    let html = `${PROSE}`;
    for (let i = 0; i < 60; i++) html = `<div class="d${i}">${html}</div>`;
    const node = findDominantContainer(bodyOf(html));
    assert.ok(node, 'expected a container');
    assert.equal(node.getAttribute('class'), 'd30');
  });
});

describe('acceptCandidate', () => {
  const para = (n) => Array.from({ length: n }, (_, i) => `Paragraph number ${i} is comfortably longer than forty characters.`).join('\n\n');

  it('rejects a candidate that is not substantially larger', () => {
    assert.equal(acceptCandidate(para(20), para(20).length), false);
  });

  it('rejects a large candidate without prose structure', () => {
    const navSoup = '- link\n'.repeat(2000);
    assert.equal(acceptCandidate(navSoup, 100), false);
  });

  it('accepts a large candidate with prose structure', () => {
    assert.equal(acceptCandidate(para(30), 100), true);
  });

  it('treats a zero-length extract as length one instead of dividing by zero', () => {
    assert.equal(acceptCandidate(para(30), 0), true);
  });
});

describe('containerLabel', () => {
  it('prefers the id', () => {
    assert.equal(containerLabel(bodyOf('<div id="main" class="a b">x</div>').firstElementChild), 'div#main');
  });

  it('falls back to the first class', () => {
    assert.equal(containerLabel(bodyOf('<div class="a b">x</div>').firstElementChild), 'div.a');
  });

  it('falls back to the bare tag name', () => {
    assert.equal(containerLabel(bodyOf('<section>x</section>').firstElementChild), 'section');
  });

  it('caps a page-controlled id so the persisted reason stays bounded', () => {
    // id and class come from the fetched page. The label lands in the extraction
    // log and in frontmatter, so an absurd attribute must not travel with it.
    const node = bodyOf(`<div id="${'A'.repeat(5000)}">x</div>`).firstElementChild;
    const label = containerLabel(node);
    assert.ok(label.length <= GUARD_LIMITS.MAX_LABEL + 'div#'.length + 1, `label was ${label.length}c`);
    assert.match(label, /^div#A+…$/);
  });

  it('caps a page-controlled class the same way', () => {
    const node = bodyOf(`<div class="${'B'.repeat(500)}">x</div>`).firstElementChild;
    assert.match(containerLabel(node), /^div\.B{60}…$/);
  });
});

describe('guardReason', () => {
  it('states coverage, body size, container and gain, and keeps the prior reason', () => {
    const node = bodyOf('<div class="elementor">x</div>').firstElementChild;
    const reason = guardReason(336_670, 10_503, node, 339_923, 'comparable, prefer baseline');
    assert.match(reason, /^coverage guard: 3\.1% coverage of 336670c body/);
    assert.match(reason, /recovered div\.elementor \(32\.4x, holds \d+% of body\)/);
    assert.match(reason, /prior pick: comparable, prefer baseline$/);
  });

  it('reports the container share of the body, which the trigger does not imply', () => {
    // DOMINANCE is enforced per descent level, so the shares multiply: a
    // container reached through several levels can hold far less than 90% of
    // the body. The reason has to state the real figure, not the threshold.
    const node = bodyOf(`<div class="deep">${'x'.repeat(500)}</div>`).firstElementChild;
    assert.match(guardReason(1000, 10, node, 500, 'prior'), /holds 50% of body/);
  });
});

// A page-builder one-pager in miniature: one wrapper, a shallow preamble that
// Readability scores highest, and many chapters whose prose sits several levels
// deeper inside accordion items. Readability's candidate score dilutes with
// depth, so it keeps the preamble and drops every chapter — the exact failure
// this guard exists for. Built in code because test/fixtures/ is public.
const SENTENCE = 'The maintenance schedule for the district heating network was revised after the winter review, and the operators agreed to publish updated figures every quarter. ';
const prose = (n) => SENTENCE.repeat(n);

function onePager({ wrapped = true, introParas = 5, chapters = 12, items = 6 } = {}) {
  const intro = `<div class="page-block"><div class="block-inner"><h2>Preamble</h2>`
    + `<div class="page-block"><div class="intro-wrapper">`
    + Array.from({ length: introParas }, () => `<p>${prose(2)}</p>`).join('')
    + `</div></div></div></div>`;
  const chapter = (i) => `<div class="page-block"><div class="block-inner"><h2>Chapter ${i}</h2>`
    + `<div class="page-block"><div class="accordion-wrapper"><div class="accordion">`
    + Array.from({ length: items }, (_, j) =>
      `<div class="accordion-item"><div class="accordion-head"><h3>Item ${i}.${j + 1}</h3></div>`
      + `<div class="accordion-panel">${Array.from({ length: 2 }, () => `<p>${prose(1)}</p>`).join('')}</div></div>`).join('')
    + `</div></div></div></div></div>`;
  const blocks = intro + Array.from({ length: chapters }, (_, i) => chapter(i + 1)).join('');
  const inner = wrapped ? `<div class="site-builder">${blocks}</div>` : blocks;
  return `<html><head><title>Programme</title></head><body>`
    + `<nav><a href="/a">Home</a></nav>${inner}<footer><p>Footer boilerplate.</p></footer></body></html>`;
}

const PAGE_URL = 'https://example.com/programme';

describe('coverage guard in the extraction pipeline', () => {
  it('recovers the full body of a page-builder one-pager', async () => {
    const result = await extractHtml(onePager(), { url: PAGE_URL, recipes: [] });
    assert.equal(result.source, 'coverage-guard');
    assert.match(result.markdown, /Chapter 1\b/);
    assert.match(result.markdown, /Chapter 12\b/);
    assert.match(result.markdown, /Preamble/);
  });

  it('records why it intervened', async () => {
    const result = await extractHtml(onePager(), { url: PAGE_URL, recipes: [] });
    assert.match(result.metadata.extractorReason, /^coverage guard: \d+\.\d% coverage of \d+c body/);
    assert.match(result.metadata.extractorReason, /recovered div\.site-builder \(\d+\.\dx, holds \d+% of body\)/);
    assert.match(result.metadata.extractorReason, /prior pick: /);
  });

  it('reports the recovered length, not the discarded one', async () => {
    const before = await extractHtml(onePager(), { url: PAGE_URL, recipes: [], extractor: 'readability' });
    const after = await extractHtml(onePager(), { url: PAGE_URL, recipes: [] });
    assert.ok(after.metadata.contentLength > before.metadata.contentLength * 3,
      `expected the guard to grow the extract, got ${before.metadata.contentLength} -> ${after.metadata.contentLength}`);
  });
});

describe('coverage guard guard-rails', () => {
  it('stays silent on a flat page with the same content but no dominant container', async () => {
    // Identical text, one structural difference: no wrapper. The text is spread
    // across body-level siblings, which is what a listing page looks like.
    const result = await extractHtml(onePager({ wrapped: false }), { url: PAGE_URL, recipes: [] });
    assert.notEqual(result.source, 'coverage-guard');
    assert.doesNotMatch(result.metadata.extractorReason, /coverage guard/);
  });

  it('leaves an ordinary small article untouched', async () => {
    const small = `<html><head><title>Note</title></head><body><div class="wrap"><article>`
      + `<p>${prose(3)}</p><p>${prose(3)}</p></article></div></body></html>`;
    const result = await extractHtml(small, { url: PAGE_URL, recipes: [] });
    assert.notEqual(result.source, 'coverage-guard');
  });

  it('stays silent below the body-size floor even when every other condition holds', async () => {
    // Same shape as the firing fixture, only shorter. Measured on this fixture:
    // body 17,635 chars (under the 20,000 floor), coverage 9.3% (under the
    // ceiling), a dominant container is present, and the candidate would be
    // ~10x larger. The size floor is the only thing holding the guard back, so
    // lowering MIN_BODY_TEXT makes this test fail — which is the point.
    const result = await extractHtml(onePager({ chapters: 8 }), { url: PAGE_URL, recipes: [] });
    assert.notEqual(result.source, 'coverage-guard');
    assert.doesNotMatch(result.metadata.extractorReason, /coverage guard/);
  });

  it('yields to a recipe select.content', async () => {
    const recipe = RecipeSchema.parse({
      name: 'test', host: 'example.com', select: { content: ['.intro-wrapper'] },
    });
    const result = await extractHtml(onePager(), { url: PAGE_URL, recipes: [recipe] });
    assert.equal(result.source, 'recipe-content');
    assert.doesNotMatch(result.metadata.extractorReason, /coverage guard/);
  });

  it('yields to a forced extractor=readability', async () => {
    const result = await extractHtml(onePager(), { url: PAGE_URL, recipes: [], extractor: 'readability' });
    assert.equal(result.source, 'readability');
    assert.equal(result.metadata.extractorReason, 'forced via extractor=readability');
  });

  it('yields to a forced extractor=trafilatura even when the sidecar is unavailable', async () => {
    const result = await extractHtml(onePager(), { url: PAGE_URL, recipes: [], extractor: 'trafilatura' });
    assert.doesNotMatch(result.metadata.extractorReason, /coverage guard/);
  });

  it('still fires when the extractor is pinned to playwright', async () => {
    // extractor=playwright still takes the DEFAULT pickBest path on the static
    // pass (only readability/trafilatura pins skip Readability+Trafilatura
    // entirely) - so the guard must NOT treat it like a static forced
    // extractor. extractHtml's own `extractor` option only accepts
    // 'readability'/'trafilatura' (see its JSDoc), so drive this through a
    // recipe's `extractor: playwright` instead, exactly as a real site
    // configuration would.
    const recipe = RecipeSchema.parse({ name: 'test', host: 'example.com', extractor: 'playwright' });
    const result = await extractHtml(onePager(), { url: PAGE_URL, recipes: [recipe] });
    assert.equal(result.source, 'coverage-guard');
  });

  it('is switched off by PULLMD_COVERAGE_GUARD=off', async () => {
    const result = await withGuardEnvAsync('off', () => extractHtml(onePager(), { url: PAGE_URL, recipes: [] }));
    assert.notEqual(result.source, 'coverage-guard');
  });

  it('never shrinks the result', async () => {
    const forced = await extractHtml(onePager(), { url: PAGE_URL, recipes: [], extractor: 'readability' });
    const guarded = await extractHtml(onePager(), { url: PAGE_URL, recipes: [] });
    assert.ok(guarded.markdown.length >= forced.markdown.length,
      'the guard must only ever grow the extract');
  });
});

describe('coverage guard on the rendered (Playwright) pass', () => {
  function fetchThinHtml() {
    return async () => {
      const headers = { get: (k) => (k.toLowerCase() === 'content-type' ? 'text/html; charset=utf-8' : null) };
      return { ok: true, status: 200, headers, text: async () => '<html><body><p>thin</p></body></html>' };
    };
  }

  it('keeps the coverage-guard source and reason when the guard fires on the rendered DOM', async () => {
    // render: 'force' makes the second (Playwright) pass happen regardless of
    // what the static extraction looks like; the injected renderClient hands
    // back the one-pager fixture, so the guard fires on the SECOND
    // convertWithReadability call (the rendered one), not the first. Before the
    // fix, extractWeb unconditionally overwrote source/extractorReason with
    // 'playwright', losing the guard's transparency markers.
    const result = await extractWeb(PAGE_URL, {
      fetch: fetchThinHtml(),
      recipes: [],
      render: 'force',
      renderClient: async () => onePager(),
    });
    assert.equal(result.source, 'coverage-guard');
    assert.match(result.metadata.extractorReason, /forced via render=force/);
    assert.match(result.metadata.extractorReason, /coverage guard:/);
  });
});
