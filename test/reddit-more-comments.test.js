import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import {
  expandMoreComments,
  extractPost,
  formatComments,
  readMoreRequestBudget,
} from '../lib/reddit.js';

const t1 = (id, parent, body, replies = []) => ({
  kind: 't1',
  data: {
    id,
    name: `t1_${id}`,
    parent_id: parent,
    author: id,
    score: 1,
    body,
    replies: replies.length ? { kind: 'Listing', data: { children: replies } } : '',
  },
});
const more = (parent, children = [], count = children.length) => ({
  kind: 'more',
  data: { id: children[0] || '_', name: `t1_${children[0] || '_'}`, parent_id: parent, children, count, depth: 0 },
});

function jsonResponse(body, { status = 200, headers = {} } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(headers),
    json: async () => body,
  };
}

/** Route fetches by URL; records every requested URL. */
function router(routes) {
  const calls = [];
  const fn = async (url) => {
    calls.push(url);
    for (const [pattern, handler] of routes) {
      if (pattern.test(url)) return handler(url);
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  fn.calls = calls;
  return fn;
}

const listing = (children) => ({ kind: 'Listing', data: { children } });

describe('expandMoreComments', () => {
  it('splices a continued thread under its parent at absolute depth', async () => {
    // a (0) -> b (1) -> [continue this thread]
    const tree = listing([t1('a', 't3_p', 'A', [t1('b', 't1_a', 'B', [more('t1_b')])])]);
    const fetchFn = router([
      [/\/r\/sub\/comments\/p\/_\/b\.json/, () => jsonResponse([
        listing([]),
        listing([t1('b', 't1_a', 'B', [t1('c', 't1_b', 'C', [t1('d', 't1_c', 'D')])])]),
      ])],
    ]);

    const r = await expandMoreComments(tree, { postId: 'p', subreddit: 'sub', maxDepth: 10, fetchFn });
    assert.equal(r.requests, 1);
    assert.deepEqual(r.notLoaded, { comments: 0, threads: 0 });
    assert.match(fetchFn.calls[0], /raw_json=1/);

    const md = formatComments(tree, { totalComments: 4, depth: 10, lang: 'en' });
    assert.equal(md, [
      '## Comments (4 of 4)',
      '',
      '**u/a** [+1]: A',
      '  **u/b** [+1]: B',
      '    **u/c** [+1]: C',
      '      **u/d** [+1]: D',
    ].join('\n'));
  });

  it('resolves load-more ids via morechildren in place, nesting by parent_id', async () => {
    const tree = listing([t1('a', 't3_p', 'A'), more('t3_p', ['x', 'y'], 3), t1('z', 't3_p', 'Z')]);
    const fetchFn = router([
      [/\/api\/morechildren\.json/, (url) => {
        const q = new URL(url).searchParams;
        assert.equal(q.get('link_id'), 't3_p');
        assert.equal(q.get('children'), 'x,y');
        assert.equal(q.get('api_type'), 'json');
        return jsonResponse({ json: { errors: [], data: { things: [
          t1('x', 't3_p', 'X'),
          t1('x1', 't1_x', 'X1'),
          t1('y', 't3_p', 'Y'),
        ] } } });
      }],
    ]);

    await expandMoreComments(tree, { postId: 'p', subreddit: 'sub', maxDepth: 5, fetchFn });
    const md = formatComments(tree, { totalComments: 5, depth: 5, lang: 'en' });
    assert.equal(md, [
      '## Comments (5 of 5)',
      '',
      '**u/a** [+1]: A',
      '',
      '**u/x** [+1]: X',
      '  **u/x1** [+1]: X1',
      '',
      '**u/y** [+1]: Y',
      '',
      '**u/z** [+1]: Z',
    ].join('\n'));
  });

  it('follows stubs found inside loaded results', async () => {
    const tree = listing([more('t3_p', ['x'])]);
    const fetchFn = router([
      [/\/api\/morechildren\.json/, () => jsonResponse({ json: { data: { things: [
        t1('x', 't3_p', 'X'),
        more('t1_x'),
      ] } } })],
      [/\/_\/x\.json/, () => jsonResponse([listing([]), listing([t1('x', 't3_p', 'X', [t1('x1', 't1_x', 'X1')])])])],
    ]);
    const r = await expandMoreComments(tree, { postId: 'p', maxDepth: 5, fetchFn });
    assert.equal(r.requests, 2);
    assert.match(fetchFn.calls[1], /^https:\/\/www\.reddit\.com\/comments\/p\/_\/x\.json/);
    const md = formatComments(tree, { totalComments: 2, depth: 5, lang: 'en' });
    assert.match(md, /\*\*u\/x\*\* \[\+1\]: X\n {2}\*\*u\/x1\*\* \[\+1\]: X1/);
  });

  it('chunks morechildren requests at 100 ids', async () => {
    const ids = Array.from({ length: 250 }, (_, i) => `c${i}`);
    const tree = listing([more('t3_p', ids)]);
    const sizes = [];
    const fetchFn = router([
      [/\/api\/morechildren\.json/, (url) => {
        const chunk = new URL(url).searchParams.get('children').split(',');
        sizes.push(chunk.length);
        return jsonResponse({ json: { data: { things: chunk.map((id) => t1(id, 't3_p', id)) } } });
      }],
    ]);
    await expandMoreComments(tree, { postId: 'p', maxDepth: 3, fetchFn });
    assert.deepEqual(sizes, [100, 100, 50]);
    assert.equal(tree.data.children.length, 250);
    assert.equal(tree.data.children[249].data.id, 'c249');
  });

  it('makes no requests for stubs that would render below the depth limit', async () => {
    const tree = listing([t1('a', 't3_p', 'A', [t1('b', 't1_a', 'B', [more('t1_b'), more('t1_b', ['q'])])])]);
    const fetchFn = router([]);
    const r = await expandMoreComments(tree, { postId: 'p', maxDepth: 2, fetchFn });
    assert.equal(r.requests, 0);
    assert.deepEqual(r.notLoaded, { comments: 0, threads: 0 });
  });

  it('skips top-level stubs once comment_limit is satisfied', async () => {
    const tree = listing([t1('a', 't3_p', 'A'), t1('b', 't3_p', 'B'), more('t3_p', ['x'])]);
    const r = await expandMoreComments(tree, { postId: 'p', maxDepth: 3, limit: 2, fetchFn: router([]) });
    assert.equal(r.requests, 0);
    assert.deepEqual(r.notLoaded, { comments: 0, threads: 0 });
  });

  it('stops at the request budget and reports what is missing', async () => {
    const tree = listing([t1('a', 't3_p', 'A', [more('t1_a')]), more('t3_p', ['x', 'y'], 7)]);
    const fetchFn = router([
      [/\/_\/a\.json/, () => jsonResponse([listing([]), listing([t1('a', 't3_p', 'A')])])],
    ]);
    const r = await expandMoreComments(tree, { postId: 'p', maxDepth: 5, budget: 1, fetchFn });
    assert.equal(r.requests, 1);
    assert.deepEqual(r.notLoaded, { comments: 7, threads: 0 });

    const none = listing([t1('a', 't3_p', 'A', [more('t1_a')])]);
    const r0 = await expandMoreComments(none, { postId: 'p', maxDepth: 5, budget: 0, fetchFn: router([]) });
    assert.deepEqual(r0, { requests: 0, notLoaded: { comments: 0, threads: 1 } });
  });

  it('stops on 429 without throwing and leaves the rest as not loaded', async () => {
    const tree = listing([t1('a', 't3_p', 'A', [more('t1_a')]), more('t3_p', ['x'])]);
    const fetchFn = router([[/./, () => jsonResponse({}, { status: 429 })]]);
    const r = await expandMoreComments(tree, { postId: 'p', maxDepth: 5, fetchFn });
    assert.equal(r.requests, 1);
    assert.deepEqual(r.notLoaded, { comments: 1, threads: 1 });
  });

  it('stops when the rate limit is nearly used up', async () => {
    const tree = listing([more('t3_p', ['x']), t1('a', 't3_p', 'A', [more('t1_a')])]);
    const fetchFn = router([
      [/morechildren/, () => jsonResponse(
        { json: { data: { things: [t1('x', 't3_p', 'X')] } } },
        { headers: { 'x-ratelimit-remaining': '2.0' } },
      )],
    ]);
    const r = await expandMoreComments(tree, { postId: 'p', maxDepth: 5, fetchFn });
    assert.equal(r.requests, 1);
    assert.deepEqual(r.notLoaded, { comments: 0, threads: 1 });
  });

  it('keeps going after a single failed request', async () => {
    const tree = listing([t1('a', 't3_p', 'A', [more('t1_a')]), more('t3_p', ['x'])]);
    const warn = mock.method(console, 'warn', () => {});
    try {
      const fetchFn = router([
        [/\/_\/a\.json/, () => jsonResponse({}, { status: 500 })],
        [/morechildren/, () => jsonResponse({ json: { data: { things: [t1('x', 't3_p', 'X')] } } })],
      ]);
      const r = await expandMoreComments(tree, { postId: 'p', maxDepth: 5, fetchFn });
      assert.equal(r.requests, 2);
      assert.deepEqual(r.notLoaded, { comments: 0, threads: 1 });
      assert.equal(tree.data.children[1].data.id, 'x');
    } finally {
      warn.mock.restore();
    }
  });
});

describe('formatComments deleted parents and scores', () => {
  it('keeps live replies under a deleted comment behind a placeholder', () => {
    const del = t1('d', 't3_p', '[deleted]', [t1('r', 't1_d', 'R')]);
    del.data.author = '[deleted]';
    const gone = t1('g', 't3_p', '[removed]');
    gone.data.author = '[deleted]';
    const md = formatComments(listing([del, gone]), { totalComments: 3, depth: 3, lang: 'en' });
    assert.equal(md, '## Comments (1 of 3)\n\n*[deleted]*\n  **u/r** [+1]: R\n');
  });
  it('prints negative scores without a plus sign', () => {
    const c = t1('n', 't3_p', 'N');
    c.data.score = -3;
    assert.match(formatComments(listing([c]), { totalComments: 1, depth: 3 }), /\*\*u\/n\*\* \[-3\]: N/);
  });
});

describe('formatComments not-loaded hint', () => {
  const tree = listing([t1('a', 't3_p', 'A')]);
  it('renders in German and English, without zero counts', () => {
    assert.match(
      formatComments(tree, { totalComments: 5, depth: 3, notLoaded: { comments: 3, threads: 1 } }),
      /\n\n_Nicht geladen: 3 weitere Kommentare, 1 Thread-Fortsetzung\._$/,
    );
    assert.match(
      formatComments(tree, { totalComments: 5, depth: 3, lang: 'en', notLoaded: { comments: 0, threads: 2 } }),
      /\n\n_Not loaded: 2 continued threads\._$/,
    );
    assert.doesNotMatch(
      formatComments(tree, { totalComments: 1, depth: 3, notLoaded: { comments: 0, threads: 0 } }),
      /Nicht geladen/,
    );
  });
});

describe('readMoreRequestBudget', () => {
  const oauth = { REDDIT_CLIENT_ID: 'id', REDDIT_CLIENT_SECRET: 'secret' };
  it('defaults to 20 with API credentials and 5 without', () => {
    assert.equal(readMoreRequestBudget(oauth), 20);
    assert.equal(readMoreRequestBudget({}), 5);
    assert.equal(readMoreRequestBudget({ PULLMD_REDDIT_MORE_REQUESTS: '' }), 5);
  });
  it('accepts 0, clamps and rejects junk', () => {
    assert.equal(readMoreRequestBudget({ ...oauth, PULLMD_REDDIT_MORE_REQUESTS: '0' }), 0);
    assert.equal(readMoreRequestBudget({ PULLMD_REDDIT_MORE_REQUESTS: '12' }), 12);
    assert.equal(readMoreRequestBudget({ ...oauth, PULLMD_REDDIT_MORE_REQUESTS: '9999' }), 200);
    assert.equal(readMoreRequestBudget({ ...oauth, PULLMD_REDDIT_MORE_REQUESTS: 'abc' }), 20);
    assert.equal(readMoreRequestBudget({ PULLMD_REDDIT_MORE_REQUESTS: '-1' }), 5);
  });
});

describe('extractPost loads more comments', () => {
  let originalFetch;
  beforeEach(() => {
    originalFetch = global.fetch;
    delete process.env.REDDIT_CLIENT_ID;
    delete process.env.REDDIT_CLIENT_SECRET;
  });
  afterEach(() => {
    global.fetch = originalFetch;
    delete process.env.PULLMD_REDDIT_MORE_REQUESTS;
  });

  const post = {
    id: 'p', title: 'T', author: 'op', subreddit: 'sub', score: 1, created_utc: 1,
    selftext: 'body', is_self: true, url: '', num_comments: 3, is_video: false,
  };

  it('fetches the continued thread so its replies show up and count', async () => {
    const fetchFn = router([
      [/\/_\/a\.json/, () => jsonResponse([listing([]), listing([t1('a', 't3_p', 'A', [t1('b', 't1_a', 'B')])])])],
      [/\/comments\/p\/t\.json/, () => jsonResponse([
        listing([{ kind: 't3', data: post }]),
        listing([t1('a', 't3_p', 'A', [more('t1_a')]), t1('c', 't3_p', 'C')]),
      ])],
    ]);
    global.fetch = fetchFn;
    const md = await extractPost('https://www.reddit.com/r/sub/comments/p/t/', { commentDepth: 5, lang: 'en' });
    assert.match(md, /## Comments \(3 of 3\)/);
    assert.match(md, /\*\*u\/a\*\* \[\+1\]: A\n {2}\*\*u\/b\*\* \[\+1\]: B/);
    assert.doesNotMatch(md, /Not loaded/);
  });

  it('honours PULLMD_REDDIT_MORE_REQUESTS=0 and says what is missing', async () => {
    process.env.PULLMD_REDDIT_MORE_REQUESTS = '0';
    global.fetch = router([
      [/\/comments\/p\/t\.json/, () => jsonResponse([
        listing([{ kind: 't3', data: post }]),
        listing([t1('a', 't3_p', 'A'), more('t3_p', ['x', 'y'])]),
      ])],
    ]);
    const md = await extractPost('https://www.reddit.com/r/sub/comments/p/t/', { lang: 'de' });
    assert.match(md, /## Kommentare \(1 von 3\)/);
    assert.match(md, /_Nicht geladen: 2 weitere Kommentare\._$/);
  });
});
