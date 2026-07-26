import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { RecipeSchema } from '../lib/recipes.js';
import { extractHtml } from '../lib/web.js';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const here = path.dirname(fileURLToPath(import.meta.url));
const defaultFile = path.join(here, '..', 'site-recipes.default.json');

// Webflow wraps the article body in two separate `.blog_post_content_wrap`
// branches with an in-article CTA card wedged between them. Readability scores
// one branch as its top candidate; the other is not a sibling, so the whole
// lead section is silently dropped (issue #44). Fixture is the real page's DOM
// skeleton with the prose replaced by same-length filler — the structure is
// what triggers the bug, the wording is not.
const FIXTURE = fs.readFileSync(
  path.join(here, 'fixtures', 'claude-blog-split-body.html'),
  'utf8',
);

const POST_URL = 'https://claude.com/blog/the-new-rules-of-context-engineering';

function shippedRecipes() {
  const raw = JSON.parse(fs.readFileSync(defaultFile, 'utf8'));
  return raw.map((entry) => {
    const parsed = RecipeSchema.safeParse(entry);
    assert.equal(parsed.success, true, `shipped recipe "${entry.name}" must validate`);
    return parsed.data;
  });
}

describe('claude.com blog built-in recipe (issue #44)', () => {
  it('ships in the default recipe file and validates', () => {
    const recipe = shippedRecipes().find((r) => r.name === 'claude-blog-split-body');
    assert.ok(recipe, 'claude-blog-split-body must ship in site-recipes.default.json');
    assert.deepEqual(recipe.host, ['claude.com', 'www.claude.com']);
    assert.equal(recipe.path, '/blog/**');
  });

  it('without the recipe Readability drops the lead block', async () => {
    const result = await extractHtml(FIXTURE, {
      url: POST_URL,
      recipes: [],
      extractor: 'readability',
    });
    assert.match(result.markdown, /REST BLOCK/);
    assert.doesNotMatch(result.markdown, /LEAD BLOCK/);
  });

  it('with the recipe both body blocks survive', async () => {
    const result = await extractHtml(FIXTURE, {
      url: POST_URL,
      recipes: shippedRecipes(),
      extractor: 'readability',
    });
    assert.match(result.markdown, /LEAD BLOCK/);
    assert.match(result.markdown, /REST BLOCK/);
    assert.match(result.markdown, /^## Then and now$/m);
  });

  it('does not apply outside /blog/**', async () => {
    const result = await extractHtml(FIXTURE, {
      url: 'https://claude.com/pricing',
      recipes: shippedRecipes(),
      extractor: 'readability',
    });
    assert.doesNotMatch(result.markdown, /LEAD BLOCK/);
  });
});
