import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

// Static-content assertions on the PWA source, same convention as the
// "PWA index.html: misconfig banner DOM" block in auth-pages-i18n.test.js:
// there is no DOM harness for public/index.html, so the guard is on the code.
describe('PWA index.html: rendered view keeps frontmatter out of marked', () => {
  const html = readFileSync(join(ROOT, 'public/index.html'), 'utf8');
  const fn = html.match(/function renderRenderedView\(\)[\s\S]*?\n      \}\n/);

  it('has a renderRenderedView function', () => {
    assert.ok(fn, 'renderRenderedView must exist in public/index.html');
  });

  it('parses only the body through marked, never the combined rawMarkdown', () => {
    assert.match(fn[0], /marked\.parse\(rawBody/);
    assert.doesNotMatch(fn[0], /marked\.parse\(rawMarkdown/);
  });

  it('prepends the frontmatter as a fm-block code box built via DOM APIs', () => {
    assert.match(fn[0], /createElement\('pre'\)/);
    assert.match(fn[0], /className = 'fm-block'/);
    assert.match(fn[0], /createElement\('code'\)/);
    assert.match(fn[0], /insertBefore\(pre, resultRenderedEl\.firstChild\)/);
  });

  it('fills the frontmatter box via textContent, never innerHTML', () => {
    assert.match(fn[0], /code\.textContent = frontmatterInner\(rawFrontmatter\)/);
    assert.doesNotMatch(fn[0], /code\.innerHTML/);
  });

  it('keeps the no-marked fallback on the full rawMarkdown', () => {
    assert.match(fn[0], /if \(!window\.marked \|\| !window\.DOMPurify\)[\s\S]*?resultRenderedEl\.textContent = rawMarkdown;/);
  });

  it('styles the fm-block for both themes via the shared tokens', () => {
    assert.match(html, /#result-rendered pre\.fm-block \{/);
    assert.match(html, /#result-rendered pre\.fm-block code \{[\s\S]*?color: var\(--fg-muted\)/);
  });
});
