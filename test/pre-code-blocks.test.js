import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { extractHtml, htmlFragmentToMarkdown } from '../lib/web.js';

// #110: node-html-markdown fences only a <pre> that contains <code>. Sphinx /
// Pygments (docs.python.org, Read the Docs) and GitHub's rendered READMEs emit
// a bare <pre>, whose lines came out as headings and paragraphs.

const PROSE = '<p>' + 'Explanatory prose about the tool and how to use it in practice. '.repeat(6) + '</p>';

const SPHINX = `<div class="highlight-python notranslate"><div class="highlight"><pre><span></span><span class="c1"># install it</span>
<span class="kn">import</span> <span class="nn">os</span>
<span class="k">def</span> <span class="nf">main</span><span class="p">():</span>
    <span class="nb">print</span>("hi")
</pre></div></div>`;

const GITHUB = `<div class="highlight highlight-source-shell"><pre>npm install -g tool
# then
tool --version</pre></div>`;

const page = (body) => `<html><head><title>Doc</title></head><body><article><h1>Doc</h1>${PROSE}${body}${PROSE}</article></body></html>`;

describe('bare <pre> code blocks (#110)', () => {
  it('fences a Sphinx block with its language and indentation', async () => {
    const { markdown } = await extractHtml(page(SPHINX), { extractor: 'readability' });
    assert.ok(markdown.includes('```python\n# install it\nimport os\ndef main():\n    print("hi")\n```'), markdown);
  });

  it('fences a GitHub README block with its language', async () => {
    const { markdown } = await extractHtml(page(GITHUB), { extractor: 'readability' });
    assert.ok(markdown.includes('```shell\nnpm install -g tool\n# then\ntool --version\n```'), markdown);
  });

  it('fences a bare <pre> without a language hint', async () => {
    const { markdown } = await extractHtml(page('<pre># not a heading\nline two</pre>'), { extractor: 'readability' });
    assert.ok(markdown.includes('```\n# not a heading\nline two\n```'), markdown);
  });

  it('keeps the language of an existing <pre><code class="language-x">', async () => {
    const { markdown } = await extractHtml(page('<pre><code class="language-js">const a = 1;</code></pre>'), { extractor: 'readability' });
    assert.ok(markdown.includes('```js\nconst a = 1;\n```'), markdown);
  });

  it('ignores generic Sphinx/GitHub classes that name no language', async () => {
    const html = '<div class="highlight-default notranslate"><div class="highlight"><pre>x = 1</pre></div></div>'
      + '<div class="highlight highlight-text-html-basic"><pre>&lt;p&gt;hi&lt;/p&gt;</pre></div>';
    const { markdown } = await extractHtml(page(html), { extractor: 'readability' });
    assert.ok(markdown.includes('```\nx = 1\n```'), markdown);
    assert.ok(markdown.includes('```\n<p>hi</p>\n```'), markdown);
  });

  it('drops a language token that could break the fence', async () => {
    const { markdown } = await extractHtml(page('<pre class="language-a`b">x</pre>'), { extractor: 'readability' });
    assert.ok(markdown.includes('```\nx\n```'), markdown);
  });

  it('fences bare <pre> in HTML fragments (e-mail path)', () => {
    const md = htmlFragmentToMarkdown(GITHUB);
    assert.ok(md.includes('```shell\nnpm install -g tool\n# then\ntool --version\n```'), md);
  });
});
