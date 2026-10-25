import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { withRawJson, cleanRedditText, fetchRedditJson, formatPost, formatComments } from '../lib/reddit.js';

describe('withRawJson', () => {
  it('adds raw_json=1 and keeps existing parameters', () => {
    assert.equal(withRawJson('https://www.reddit.com/r/x/comments/abc/t.json'), 'https://www.reddit.com/r/x/comments/abc/t.json?raw_json=1');
    assert.equal(withRawJson('https://www.reddit.com/r/x/hot.json?limit=25'), 'https://www.reddit.com/r/x/hot.json?limit=25&raw_json=1');
  });

  it('is what fetchRedditJson requests', async () => {
    const originalFetch = global.fetch;
    let calledUrl;
    global.fetch = mock.fn(async (url) => { calledUrl = url; return { ok: true, status: 200, json: async () => [] }; });
    try {
      await fetchRedditJson('https://www.reddit.com/r/x/comments/abc/t/');
      assert.equal(calledUrl, 'https://www.reddit.com/r/x/comments/abc/t.json?raw_json=1');
    } finally {
      global.fetch = originalFetch;
    }
  });
});

describe('cleanRedditText', () => {
  it('drops zero-width-space paragraph lines', () => {
    assert.equal(cleanRedditText('one\n\n&#x200B;\n\ntwo'), 'one\n\ntwo');
    assert.equal(cleanRedditText('one\n\n&#x200b;\n\n​\n\ntwo'), 'one\n\ntwo');
    assert.equal(cleanRedditText('one\n\n &#8203; \n\ntwo'), 'one\n\ntwo');
  });

  it('leaves all other whitespace alone', () => {
    assert.equal(cleanRedditText('keep\n\n\n\nthis\n\n'), 'keep\n\n\n\nthis\n\n');
    assert.equal(cleanRedditText('one\n\n&#x200B;\n\n&#x200B;\n\ntwo'), 'one\n\ntwo');
    assert.equal(cleanRedditText('&#x200B;\n\ntwo'), 'two');
    assert.equal(cleanRedditText('a\n&#x200B;\nb'), 'a\nb');
  });

  it('keeps text that merely contains the entity and other content', () => {
    assert.equal(cleanRedditText('a&#x200B;b\n> quote & more'), 'a&#x200B;b\n> quote & more');
  });
});

describe('formatting with raw_json text', () => {
  it('post body loses the zero-width line', () => {
    const md = formatPost({ title: 'T', selftext: 'Question?\n\n&#x200B;\n\nMore.', is_self: true }, 'https://www.reddit.com/r/x/comments/abc/t/');
    assert.match(md, /Question\?\n\nMore\./);
    assert.doesNotMatch(md, /x200B/);
  });

  it('comment quotes stay Markdown quotes', () => {
    const out = formatComments({ data: { children: [
      { kind: 't1', data: { author: 'a', score: 1, body: '> quoted line\n\n&#x200B;\n\nreply', replies: '' } },
    ] } }, { totalComments: 1, limit: 10, depth: 3 });
    assert.match(out, /\*\*u\/a\*\* \[\+1\]: > quoted line\n\nreply/);
    assert.doesNotMatch(out, /x200B/);
  });
});

describe('cleanRedditText cost', () => {
  it('stays linear on a crafted body (markers followed by as many blank lines)', () => {
    const body = 'x' + '\n&#x200B;'.repeat(5000) + '\n'.repeat(5001) + 'y';
    const t = Date.now();
    assert.equal(cleanRedditText(body), 'x\ny');
    assert.ok(Date.now() - t < 100, `took ${Date.now() - t} ms`);
  });
});
