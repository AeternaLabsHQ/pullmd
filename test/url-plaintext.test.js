// Issue #113: text files served as text/plain (raw.githubusercontent.com and
// friends) are read as text, not through the HTML pipeline.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { extractWeb } from './helpers/fake-dns.js';

const textResponse = (body, type = 'text/plain; charset=utf-8') => async () => ({
  ok: true,
  status: 200,
  headers: { get: (h) => h === 'content-type' ? type : null },
  text: async () => body,
});

const latin1Response = (str) => async () => {
  const bytes = Buffer.from(str, 'latin1');
  return {
    ok: true,
    status: 200,
    headers: { get: (h) => h === 'content-type' ? 'text/plain; charset=iso-8859-1' : null },
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  };
};

const CHANGELOG = '# Changelog\n\n## 1.0\n\n- Added <name placeholder\n- Fixed `a<b` in docs\n';

describe('extractWeb - text/plain files (#113)', () => {
  it('passes a .md file through unchanged, line breaks and <placeholders> included', async () => {
    const r = await extractWeb('https://raw.example.com/o/r/main/CHANGELOG.md', { fetch: textResponse(CHANGELOG) });
    assert.equal(r.source, 'markdown');
    assert.equal(r.title, 'Changelog');
    assert.equal(r.markdown, CHANGELOG);
    assert.equal(r.metadata.sourceUrl, 'https://raw.example.com/o/r/main/CHANGELOG.md');
    assert.equal(r.metadata.statusCode, 200);
  });

  it('does not fail on a large file with a stray "<name" (the reported crash)', async () => {
    const md = '# Changelog\n\n- Added <name placeholder\n'
      + Array.from({ length: 1200 }, (_, i) => `word${i}`).join(' ') + '\n';
    const r = await extractWeb('https://raw.example.com/CHANGELOG.md', { fetch: textResponse(md) });
    assert.equal(r.source, 'markdown');
    assert.ok(r.markdown.includes('- Added <name placeholder\nword0 word1'));
    assert.ok(r.markdown.includes('word1199'));
  });

  it('reads an extension-less file as text with a title from the file name', async () => {
    const r = await extractWeb('https://raw.example.com/o/r/main/LICENSE', {
      fetch: textResponse('MIT License\n\nCopyright <year> <owner>\n'),
    });
    assert.equal(r.source, 'text');
    assert.equal(r.markdown, '# LICENSE\n\nMIT License\n\nCopyright <year> <owner>\n');
  });

  it('reads source code served as text/plain as a code block', async () => {
    const r = await extractWeb('https://raw.example.com/o/r/main/tool.py', {
      fetch: textResponse('if a<b:\n    print("<x>")\n'),
    });
    assert.ok(r.markdown.includes('```python\nif a<b:\n    print("<x>")\n```'), r.markdown);
  });

  it('reads a file no reader knows as text (.gitignore, Cargo.lock, notes.v1.2)', async () => {
    const big = '- Added <name placeholder\n' + Array.from({ length: 1200 }, (_, i) => `word${i}`).join(' ') + '\n';
    for (const name of ['.gitignore', 'Cargo.lock', 'notes.v1.2']) {
      const r = await extractWeb(`https://raw.example.com/${name}`, { fetch: textResponse(big) });
      assert.equal(r.source, 'text', name);
      assert.ok(r.markdown.includes('- Added <name placeholder\nword0 word1'), name);
    }
  });

  it('falls back to text when the reader for the name refuses the file', async () => {
    const r = await extractWeb('https://raw.example.com/sample.eml', {
      fetch: textResponse('Not a mail, just <name text\n'),
    });
    assert.equal(r.source, 'text');
    assert.equal(r.markdown, '# sample\n\nNot a mail, just <name text\n');
  });

  it('reads server-side source (.php) as code, not as a web page', async () => {
    const r = await extractWeb('https://raw.example.com/index.php', { fetch: textResponse('<?php echo "<b>"; ?>\n') });
    assert.equal(r.source, 'code');
    assert.ok(r.markdown.includes('```php\n<?php echo "<b>"; ?>\n```'), r.markdown);
  });

  it('reads the file as text with comments=true as well', async () => {
    const r = await extractWeb('https://raw.example.com/CHANGELOG.md', { fetch: textResponse(CHANGELOG), comments: true });
    assert.equal(r.source, 'markdown');
    assert.equal(r.markdown, CHANGELOG);
  });

  it('returns 422 empty_file for an empty text file', async () => {
    await assert.rejects(
      extractWeb('https://raw.example.com/empty.txt', { fetch: textResponse('') }),
      (err) => err.status === 422 && err.code === 'empty_file',
    );
  });

  it('honours the charset of the response', async () => {
    const r = await extractWeb('https://raw.example.com/notes.txt', { fetch: latin1Response('Grüße aus Köln\n') });
    assert.equal(r.source, 'text');
    assert.ok(r.markdown.includes('Grüße aus Köln'));
  });

  it('keeps HTML served as text/plain on the HTML pipeline', async () => {
    const html = '<!DOCTYPE html><html><head><title>Page</title></head><body><article><h1>Page</h1>'
      + '<p>' + 'Real article text. '.repeat(40) + '</p></article></body></html>';
    for (const url of ['https://example.com/page', 'https://example.com/page.html']) {
      const r = await extractWeb(url, { fetch: textResponse(html) });
      assert.notEqual(r.source, 'text', url);
      assert.ok(!r.markdown.includes('<!DOCTYPE'), url);
    }
  });

  it('leaves the text/markdown passthrough as it is', async () => {
    const r = await extractWeb('https://example.com/article', {
      fetch: textResponse('# Hello World\n\nSome content here.', 'text/markdown; charset=utf-8'),
    });
    assert.equal(r.source, 'cloudflare');
  });
});
