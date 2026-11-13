import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { htmlFragmentToMarkdown } from '../lib/web.js';
import { stripMarkdown } from '../lib/strip-markdown.js';
import { extractWeb } from './helpers/fake-dns.js';

function mockFetch(html) {
  return async () => ({
    ok: true,
    status: 200,
    headers: { get: (h) => h === 'content-type' ? 'text/html; charset=utf-8' : null },
    text: async () => html,
  });
}

describe('GFM output quality', () => {
  it('converts code blocks with language hints', async () => {
    const html = `<html><head><title>Code</title></head><body>
      <article><pre><code class="language-ts">const x: number = 1;</code></pre></article>
    </body></html>`;
    const result = await extractWeb('https://example.com/code', { fetch: mockFetch(html) });
    // The page is too short for Readability, so the cleaned-body fallback
    // converts it and the language class on <code> survives as the fence info.
    assert.ok(result.markdown.includes('```ts\nconst x: number = 1;\n```'), result.markdown);
  });

  it('converts HTML tables to GFM tables', async () => {
    const html = `<html><head><title>Table</title></head><body>
      <article><table><thead><tr><th>Name</th><th>Value</th></tr></thead>
      <tbody><tr><td>A</td><td>1</td></tr></tbody></table></article>
    </body></html>`;
    const result = await extractWeb('https://example.com/table', { fetch: mockFetch(html) });
    assert.ok(result.markdown.includes('| Name'), 'should have GFM table');
    assert.ok(result.markdown.includes('---'), 'should have table separator');
  });

  async function md(body, path = 'tasks') {
    const html = `<html><head><title>Tasks</title></head><body><article>${body}</article></body></html>`;
    return (await extractWeb(`https://example.com/${path}`, { fetch: mockFetch(html) })).markdown;
  }

  describe('task lists', () => {
    it('renders checkbox state as GFM task items', async () => {
      const out = await md(`<ul>
        <li><input type="checkbox" checked> Done</li>
        <li><input type="checkbox"> Todo</li>
      </ul>`);
      assert.ok(out.endsWith('- [x] Done\n- [ ] Todo'), out);
      assert.doesNotMatch(out, /\\\[/);
    });

    it('handles the GitHub markup', async () => {
      const out = await md(`<ul class="contains-task-list">
        <li class="task-list-item"><input type="checkbox" class="task-list-item-checkbox" disabled checked> Done</li>
        <li class="task-list-item"><input type="checkbox" class="task-list-item-checkbox" disabled> Todo</li>
      </ul>`);
      assert.ok(out.endsWith('- [x] Done\n- [ ] Todo'), out);
    });

    it('handles a checkbox wrapped in a label or a paragraph', async () => {
      const out = await md(`<ul>
        <li><label><input type="checkbox" checked> Labelled</label></li>
        <li><p><input type="checkbox"> Loose</p></li>
      </ul>`);
      assert.ok(out.includes('- [x] Labelled'), out);
      assert.ok(out.includes('- [ ] Loose'), out);
    });

    it('separates the marker from label text without a space', async () => {
      const out = await md(`<ul><li><input type="checkbox" checked>Done</li></ul>`);
      assert.ok(out.endsWith('- [x] Done'), out);
    });

    it('keeps nested items and the surrounding text', async () => {
      const out = await md(`<p>${'Intro text for the list. '.repeat(10)}</p><ul>
        <li><input type="checkbox" checked> Parent
          <ul><li><input type="checkbox"> Child</li></ul></li>
      </ul>`);
      assert.match(out, /- \[x\] Parent/);
      assert.match(out, /\n {2,4}- \[ \] Child/);
    });

    it('does not mark a checkbox that is not the leading content', async () => {
      const out = await md(`<ul><li>Agree <input type="checkbox" checked> here</li></ul>`);
      assert.doesNotMatch(out, /\[[ x]\]/);
      assert.match(out, /Agree/);
    });

    it('does not mark a checkbox outside a list item', async () => {
      const out = await md(`<p><input type="checkbox" checked> Subscribe to the newsletter</p>`);
      assert.doesNotMatch(out, /\[[ x]\]/);
    });

    it('keeps dropping other inputs in list items', async () => {
      const out = await md(`<ul><li><input type="radio" checked> Option</li><li><input type="text" value="x"> Field</li></ul>`);
      assert.doesNotMatch(out, /\[[ x]\]/);
      assert.match(out, /- Option/);
    });

    it('format=text keeps the state readable', async () => {
      const out = await md(`<ul><li><input type="checkbox" checked> Done</li><li><input type="checkbox"> Todo</li></ul>`);
      assert.equal(stripMarkdown(out.slice(out.indexOf('- [x]'))), '- [x] Done\n- [ ] Todo');
    });
  });

  it('converts task items in an e-mail fragment', () => {
    const out = htmlFragmentToMarkdown('<ul><li><input type="checkbox" checked> Done</li><li><input type="checkbox"> Todo</li></ul>');
    assert.equal(out, '- [x] Done\n- [ ] Todo');
  });
});
