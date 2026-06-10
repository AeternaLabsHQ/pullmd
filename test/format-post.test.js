import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { formatPost } from '../lib/reddit.js';

const makePostData = (overrides = {}) => ({
  title: 'Test Post Title',
  author: 'testuser',
  subreddit: 'javascript',
  score: 142,
  created_utc: Math.floor(Date.now() / 1000) - 7200,
  selftext: 'This is the post body.\n\nWith multiple paragraphs.',
  is_self: true,
  url: 'https://www.reddit.com/r/javascript/comments/abc123/test_post/',
  num_comments: 234,
  is_video: false,
  media: null,
  gallery_data: null,
  media_metadata: null,
  post_hint: undefined,
  ...overrides,
});

// The inline meta line (**r/sub** · u/user · N ↑ · …) is legacy behavior,
// emitted only with PULLMD_SOURCE_HEADER set (clean body is the v3 default —
// the meta lives in the frontmatter; see reddit-frontmatter.test.js).
function withSourceHeader(fn) {
  process.env.PULLMD_SOURCE_HEADER = 'true';
  try { return fn(); } finally { delete process.env.PULLMD_SOURCE_HEADER; }
}

describe('formatPost', () => {
  it('formats a self-text post correctly (legacy header)', () => withSourceHeader(() => {
    const result = formatPost(makePostData(), 'https://www.reddit.com/r/javascript/comments/abc123/test_post/');
    assert.ok(result.startsWith('# Test Post Title\n'));
    assert.ok(result.includes('u/testuser'));
    assert.ok(result.includes('**r/javascript**'));
    assert.ok(result.includes('142 ↑'));
    assert.ok(result.includes('This is the post body.'));
    assert.ok(result.includes('With multiple paragraphs.'));
    assert.ok(result.includes('https://www.reddit.com/r/javascript/comments/abc123/test_post/'));
  }));

  it('formats a link post with the URL', () => {
    const result = formatPost(makePostData({
      is_self: false,
      selftext: '',
      url: 'https://example.com/article',
      post_hint: 'link',
    }), 'https://www.reddit.com/r/javascript/comments/abc123/test_post/');
    assert.ok(result.includes('https://example.com/article'));
  });

  it('formats an image post', () => {
    const result = formatPost(makePostData({
      is_self: false,
      selftext: '',
      url: 'https://i.redd.it/example.jpg',
      post_hint: 'image',
    }), 'https://www.reddit.com/r/javascript/comments/abc123/test_post/');
    assert.ok(result.includes('![](https://i.redd.it/example.jpg)'));
  });

  it('formats a video post with fallback URL', () => {
    const result = formatPost(makePostData({
      is_self: false,
      is_video: true,
      selftext: '',
      url: 'https://v.redd.it/abc123',
      media: { reddit_video: { fallback_url: 'https://v.redd.it/abc123/DASH_720.mp4' } },
    }), 'https://www.reddit.com/r/javascript/comments/abc123/test_post/');
    assert.ok(result.includes('https://v.redd.it/abc123/DASH_720.mp4'));
  });

  it('shows relative time for recent posts (legacy header)', () => withSourceHeader(() => {
    const result = formatPost(makePostData({
      created_utc: Math.floor(Date.now() / 1000) - 7200,
    }));
    assert.ok(result.includes('2h ago'));
  }));

  it('handles deleted author (legacy header)', () => withSourceHeader(() => {
    const result = formatPost(makePostData({ author: '[deleted]' }));
    assert.ok(result.includes('u/[deleted]'));
  }));

  it('formats a gallery post with multiple images', () => {
    const result = formatPost(makePostData({
      is_self: false,
      selftext: '',
      url: 'https://www.reddit.com/gallery/abc123',
      gallery_data: {
        items: [
          { media_id: 'img1' },
          { media_id: 'img2' },
        ]
      },
      media_metadata: {
        img1: { s: { u: 'https://preview.redd.it/img1.jpg?width=1080&amp;format=png' } },
        img2: { s: { u: 'https://preview.redd.it/img2.jpg?width=1080&amp;format=png' } },
      },
    }));
    assert.ok(result.includes('![](https://preview.redd.it/img1.jpg?width=1080&format=png)'));
    assert.ok(result.includes('![](https://preview.redd.it/img2.jpg?width=1080&format=png)'));
  });

  it('renders selftext alongside an image when an image post has a body', () => {
    // Reddit lets non-self posts (post_hint=image, is_gallery=true, video, link)
    // also carry selftext. Previously the image branch dropped selftext silently.
    const result = formatPost(makePostData({
      is_self: false,
      selftext: 'Body paragraph one.\n\nBody paragraph two with **markdown**.',
      url: 'https://i.redd.it/example.png',
      post_hint: 'image',
    }), 'https://www.reddit.com/r/javascript/comments/abc123/test_post/');
    assert.ok(result.includes('# Test Post Title'), 'header missing');
    assert.ok(result.includes('![](https://i.redd.it/example.png)'), 'image embed missing');
    assert.ok(result.includes('Body paragraph one.'), 'selftext missing');
    assert.ok(result.includes('Body paragraph two with **markdown**.'), 'selftext markdown missing');
    // Order: header → image → selftext (matches Reddit's visual layout:
    // image directly under the title, selftext below as OP's explanation)
    const headerIdx = result.indexOf('# Test Post Title');
    const imageIdx = result.indexOf('![](https://i.redd.it/example.png)');
    const selftextIdx = result.indexOf('Body paragraph one.');
    assert.ok(headerIdx < imageIdx && imageIdx < selftextIdx,
      `expected header < image < selftext, got ${headerIdx} < ${imageIdx} < ${selftextIdx}`);
  });

  it('renders selftext alongside a gallery when a gallery post has a body', () => {
    const result = formatPost(makePostData({
      is_self: false,
      selftext: 'Caption for the gallery.',
      url: 'https://www.reddit.com/gallery/abc123',
      gallery_data: { items: [{ media_id: 'img1' }, { media_id: 'img2' }] },
      media_metadata: {
        img1: { s: { u: 'https://preview.redd.it/img1.jpg' } },
        img2: { s: { u: 'https://preview.redd.it/img2.jpg' } },
      },
    }));
    assert.ok(result.includes('![](https://preview.redd.it/img1.jpg)'));
    assert.ok(result.includes('![](https://preview.redd.it/img2.jpg)'));
    assert.ok(result.includes('Caption for the gallery.'), 'selftext caption missing');
  });

  it('renders selftext alongside a video when a video post has a body', () => {
    const result = formatPost(makePostData({
      is_self: false,
      is_video: true,
      selftext: 'Description below the video.',
      url: 'https://v.redd.it/abc',
      media: { reddit_video: { fallback_url: 'https://v.redd.it/abc/DASH_720.mp4' } },
    }));
    assert.ok(result.includes('https://v.redd.it/abc/DASH_720.mp4'));
    assert.ok(result.includes('Description below the video.'));
  });

  it('renders selftext alongside a link when a link post has a body', () => {
    const result = formatPost(makePostData({
      is_self: false,
      selftext: 'Why this article matters.',
      url: 'https://example.com/article',
      post_hint: 'link',
    }));
    assert.ok(result.includes('https://example.com/article'));
    assert.ok(result.includes('Why this article matters.'));
  });
});
