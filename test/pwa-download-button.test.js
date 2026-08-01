import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

// Static-content assertions on the PWA source, same convention as
// pwa-rendered-frontmatter.test.js and the "PWA index.html: misconfig banner
// DOM" block in auth-pages-i18n.test.js: there is no DOM harness for
// public/index.html, so the guard sits on the code itself.
describe('PWA index.html: download button', () => {
  const html = readFileSync(join(ROOT, 'public/index.html'), 'utf8');

  it('renders a download button with an icon and an i18n label', () => {
    const btn = html.match(/<button id="download-btn"[\s\S]*?<\/button>/);
    assert.ok(btn, '#download-btn must exist in public/index.html');
    assert.match(btn[0], /<svg /, 'download button needs an inline SVG icon');
    assert.match(btn[0], /<span class="label" data-i18n="download\.btn">/);
  });

  it('gives all three action buttons a translated title + aria-label', () => {
    for (const [id, key] of [['copy-btn', 'copy'], ['share-btn', 'share\\.btn'], ['download-btn', 'download\\.btn']]) {
      const btn = html.match(new RegExp(`<button id="${id}"[^>]*>`));
      assert.ok(btn, `#${id} must exist`);
      assert.match(btn[0], /data-i18n-attr="title aria-label"/, `#${id} needs title + aria-label`);
      assert.match(btn[0], new RegExp(`data-i18n-attr-key="${key}"`));
    }
  });

  it('is not gated on navigator.share like the share button is', () => {
    const shareGate = html.match(/if \(navigator\.share\) \{[\s\S]*?\n      \}\n/);
    assert.ok(shareGate, 'navigator.share block must exist');
    assert.doesNotMatch(shareGate[0], /downloadBtn/);
    assert.doesNotMatch(html, /downloadBtn\.style\.display/);
  });

  it('has download.btn in both i18n dicts', () => {
    const keys = html.match(/'download\.btn':\s*'Download'/g) || [];
    assert.equal(keys.length, 2, 'download.btn must be in the DE and the EN dict');
  });

  it('resets the download label in showResult so a lang switch takes effect', () => {
    const fn = html.match(/function showResult\([\s\S]*?\n      \}\n/);
    assert.ok(fn, 'showResult must exist');
    assert.match(fn[0], /downloadBtn\.querySelector\('\.label'\)\.textContent = t\('download\.btn'\)/);
  });

  it('downloads rawMarkdown as a markdown Blob via a temporary object URL', () => {
    const handler = html.match(/downloadBtn\.addEventListener\('click'[\s\S]*?\n      \}\);\n/);
    assert.ok(handler, 'download click handler must exist');
    assert.match(handler[0], /if \(!rawMarkdown\) return;/);
    assert.match(handler[0], /new Blob\(\[rawMarkdown\], \{ type: 'text\/markdown;charset=utf-8' \}\)/);
    assert.match(handler[0], /URL\.createObjectURL\(blob\)/);
    assert.match(handler[0], /a\.download = downloadFilename\(\)/);
    assert.match(handler[0], /a\.click\(\)/);
    assert.match(handler[0], /URL\.revokeObjectURL\(url\)/);
  });

  it('derives the filename from the frontmatter title, then share id, then a fallback', () => {
    const fn = html.match(/function downloadFilename\(\)[\s\S]*?\n      \}\n/);
    assert.ok(fn, 'downloadFilename must exist');
    assert.match(fn[0], /title:/, 'must read title: out of the frontmatter');
    assert.match(fn[0], /rawFrontmatter/);
    assert.match(fn[0], /slugifyFilename\(currentShareId\)/);
    assert.match(fn[0], /'pullmd'/);
    assert.match(fn[0], /base \+ '\.md'/);
    // The share id must actually be captured when a result is shown.
    assert.match(html, /currentShareId = shareId \|\| '';/);
  });

  it('slugifies dependency-free: lowercase, dashes, collapsed, trimmed, capped', () => {
    const fn = html.match(/function slugifyFilename\(s\)[\s\S]*?\n      \}\n/);
    assert.ok(fn, 'slugifyFilename must exist');
    assert.match(fn[0], /toLowerCase\(\)/);
    assert.match(fn[0], /replace\(\/\[\^a-z0-9\]\+\/g, '-'\)/);
    assert.match(fn[0], /slice\(0, 60\)/);
    assert.doesNotMatch(fn[0], /require\(|import /);
  });

  it('collapses all three action labels to icons on narrow screens', () => {
    const mq = html.match(/@media \(max-width: 480px\) \{[\s\S]*?\n    \}\n/);
    assert.ok(mq, 'the 480px breakpoint must exist');
    assert.match(mq[0], /#copy-btn \.label, #share-btn \.label, #download-btn \.label \{ display: none; \}/);
  });

  it('shares the action-button styling with copy and share', () => {
    assert.match(html, /#copy-btn, #permalink-copy-btn, #share-btn, #download-btn \{/);
    assert.match(html, /#copy-btn:hover, #permalink-copy-btn:hover, #share-btn:hover, #download-btn:hover \{/);
  });
});
