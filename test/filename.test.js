import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { suggestFilename, slugify, youtubeVideoId, urlBasename, formatDatePrefix } from '../lib/filename.js';

// Fixed clock so the date-prefix assertions are deterministic. Local time by
// construction (the module formats in local time, and so does this Date).
const NOW = new Date(2026, 7, 1, 13, 33, 42);

describe('slugify', () => {
  it('lowercases and hyphenates', () => {
    assert.equal(slugify('Hello World'), 'hello-world');
  });

  it('drops non-ASCII letters instead of transliterating', () => {
    assert.equal(slugify('Über Äpfel'), 'ber-pfel');
  });

  it('collapses runs and trims leading/trailing hyphens', () => {
    assert.equal(slugify('  --a???b--  '), 'a-b');
  });

  it('caps at 60 chars', () => {
    const out = slugify('a'.repeat(58) + ' bbbb');
    assert.equal(out.length, 60);
    assert.equal(out, 'a'.repeat(58) + '-b');
  });

  it('leaves no trailing hyphen when the cap lands on one', () => {
    const out = slugify('a'.repeat(59) + ' bbbb');
    assert.doesNotMatch(out, /-$/);
    assert.equal(out, 'a'.repeat(59));
  });

  it('returns empty for empty-ish input', () => {
    for (const v of ['', null, undefined, '???']) assert.equal(slugify(v), '');
  });
});

describe('youtubeVideoId', () => {
  const cases = [
    ['https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
    ['https://youtube.com/watch?v=dQw4w9WgXcQ&t=42s', 'dQw4w9WgXcQ'],
    ['https://youtu.be/dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
    ['https://youtu.be/dQw4w9WgXcQ?si=abc', 'dQw4w9WgXcQ'],
    ['https://www.youtube.com/shorts/dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
    ['https://www.youtube.com/live/dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
    ['https://www.youtube.com/embed/dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
  ];
  for (const [url, id] of cases) {
    it(`extracts from ${url}`, () => assert.equal(youtubeVideoId(url), id));
  }

  it('returns empty when there is no id', () => {
    assert.equal(youtubeVideoId('https://www.youtube.com/'), '');
    assert.equal(youtubeVideoId('not a url'), '');
    assert.equal(youtubeVideoId(undefined), '');
  });
});

describe('urlBasename', () => {
  it('percent-decodes, strips query and extension', () => {
    assert.equal(urlBasename('https://x.example/pics/Urlaubsfoto%202.jpg?w=100'), 'Urlaubsfoto 2');
  });

  it('ignores the hash', () => {
    assert.equal(urlBasename('https://x.example/docs/report.pdf#page=3'), 'report');
  });

  it('handles a bare filename (upload paths hand us one)', () => {
    assert.equal(urlBasename('Quartalsbericht Q3.docx'), 'Quartalsbericht Q3');
  });

  it('returns empty for a bare host', () => {
    assert.equal(urlBasename('https://example.com/'), '');
  });

  it('survives a malformed percent-escape', () => {
    assert.equal(urlBasename('report%.txt'), 'report%');
  });
});

describe('formatDatePrefix', () => {
  it('substitutes every token zero-padded', () => {
    assert.equal(formatDatePrefix('YYYY-MM-DD-HH-mm-ss-', NOW), '2026-08-01-13-33-42-');
  });

  it('returns empty when no format is configured', () => {
    assert.equal(formatDatePrefix('', NOW), '');
    assert.equal(formatDatePrefix(undefined, NOW), '');
  });

  it('passes unknown characters through', () => {
    assert.equal(formatDatePrefix('pull_YYYY.MM@', NOW), 'pull_2026.08@');
  });
});

describe('suggestFilename: YouTube', () => {
  it('prefixes YT- and appends the video id', () => {
    assert.equal(
      suggestFilename({ source: 'youtube', title: 'Video Title', url: 'https://www.youtube.com/watch?v=abc123' }),
      'YT-video-title-abc123.md',
    );
  });

  it('drops the id part when none can be extracted', () => {
    assert.equal(
      suggestFilename({ source: 'youtube', title: 'Video Title', url: 'https://www.youtube.com/feed/x' }),
      'YT-video-title.md',
    );
  });

  it('keeps the id when the title slugifies to nothing', () => {
    assert.equal(
      suggestFilename({ source: 'youtube', title: '???', url: 'https://youtu.be/dQw4w9WgXcQ' }),
      'YT-dQw4w9WgXcQ.md',
    );
  });

  it('falls back when neither title nor id survive', () => {
    assert.equal(
      suggestFilename({ source: 'youtube', title: '', url: 'https://www.youtube.com/', shareId: 'a1b2c3d4' }),
      'a1b2c3d4.md',
    );
  });
});

describe('suggestFilename: file-based sources', () => {
  for (const source of ['image-caption', 'audio-transcript', 'markitdown', 'pdf-ocr']) {
    it(`${source} uses the original basename`, () => {
      assert.equal(
        suggestFilename({ source, title: 'x.example', url: 'https://x.example/pics/Urlaubsfoto%202.jpg?w=100' }),
        'urlaubsfoto-2.md',
      );
    });
  }

  it('falls through to the title when the basename is unusable', () => {
    assert.equal(
      suggestFilename({ source: 'markitdown', title: 'Quarterly Report', url: 'https://x.example/' }),
      'quarterly-report.md',
    );
  });
});

describe('suggestFilename: everything else', () => {
  for (const source of ['readability', 'trafilatura', 'playwright', 'cloudflare', 'coverage-guard', 'recipe-content']) {
    it(`${source} uses the title slug`, () => {
      assert.equal(
        suggestFilename({ source, title: 'A Long Read', url: 'https://example.com/posts/slug-here' }),
        'a-long-read.md',
      );
    });
  }

  it('reddit gets no subreddit prefix', () => {
    assert.equal(
      suggestFilename({ source: 'reddit', title: 'TIL something', url: 'https://www.reddit.com/r/todayilearned/comments/abc/til/' }),
      'til-something.md',
    );
  });

  it('hackernews uses the title too', () => {
    assert.equal(
      suggestFilename({ source: 'hackernews', title: 'Show HN: thing', url: 'https://news.ycombinator.com/item?id=1' }),
      'show-hn-thing.md',
    );
  });
});

describe('suggestFilename: fallback chain', () => {
  it('title first', () => {
    assert.equal(suggestFilename({ title: 'The Title', url: 'https://e.example/base.html', shareId: 'a1b2c3d4' }), 'the-title.md');
  });

  it('then the URL basename', () => {
    assert.equal(suggestFilename({ title: '', url: 'https://e.example/base.html', shareId: 'a1b2c3d4' }), 'base.md');
  });

  it('then the share id', () => {
    assert.equal(suggestFilename({ title: '', url: 'https://e.example/', shareId: 'a1b2c3d4' }), 'a1b2c3d4.md');
  });

  it('then pullmd', () => {
    assert.equal(suggestFilename({}), 'pullmd.md');
  });
});

describe('suggestFilename: date prefix', () => {
  it('prepends the rendered template', () => {
    assert.equal(
      suggestFilename({
        source: 'youtube', title: 'Video Title', url: 'https://youtu.be/abc123',
        datePrefixFormat: 'YYYY-MM-DD-HH-mm-ss-', now: NOW,
      }),
      '2026-08-01-13-33-42-YT-video-title-abc123.md',
    );
  });

  it('adds nothing when unset', () => {
    assert.equal(suggestFilename({ title: 'Plain', now: NOW }), 'plain.md');
  });

  it('replaces header-unsafe pass-through characters', () => {
    assert.equal(
      suggestFilename({ title: 'Plain', datePrefixFormat: 'YYYY/MM/DD ', now: NOW }),
      '2026-08-01-plain.md',
    );
  });

  it('never emits a character outside [A-Za-z0-9._-]', () => {
    const out = suggestFilename({ title: 'Plain', datePrefixFormat: 'a b\nc:d"eä', now: NOW });
    assert.match(out, /^[A-Za-z0-9._-]+\.md$/);
  });
});
