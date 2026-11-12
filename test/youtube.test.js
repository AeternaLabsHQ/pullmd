import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isYoutubeUrl, isYoutubeEnabled, normalizeYoutubeWatchUrl } from '../lib/youtube.js';

describe('isYoutubeEnabled', () => {
  it('is on only for true/1/yes/on', () => {
    for (const v of ['true', 'TRUE', '1', 'yes', 'on', ' true ']) {
      assert.equal(isYoutubeEnabled({ MARKITDOWN_YOUTUBE: v }), true, v);
    }
  });
  it('is off when unset, empty or a false value (#98)', () => {
    assert.equal(isYoutubeEnabled({}), false);
    for (const v of ['', 'false', 'FALSE', '0', 'no', 'off']) {
      assert.equal(isYoutubeEnabled({ MARKITDOWN_YOUTUBE: v }), false, v);
    }
  });
});

describe('isYoutubeUrl', () => {
  it('matches watch, youtu.be, shorts, mobile', () => {
    assert.equal(isYoutubeUrl('https://www.youtube.com/watch?v=abc123'), true);
    assert.equal(isYoutubeUrl('https://youtu.be/abc123'), true);
    assert.equal(isYoutubeUrl('https://www.youtube.com/shorts/abc123'), true);
    assert.equal(isYoutubeUrl('https://m.youtube.com/watch?v=abc123'), true);
  });
  it('rejects channels, playlists, non-YouTube', () => {
    assert.equal(isYoutubeUrl('https://www.youtube.com/@x'), false);
    assert.equal(isYoutubeUrl('https://www.youtube.com/playlist?list=PL1'), false);
    assert.equal(isYoutubeUrl('https://example.com/watch?v=a'), false);
    assert.equal(isYoutubeUrl('not a url'), false);
  });
});

describe('normalizeYoutubeWatchUrl', () => {
  it('normalizes to canonical watch URL', () => {
    assert.equal(normalizeYoutubeWatchUrl('https://youtu.be/abc123'), 'https://www.youtube.com/watch?v=abc123');
    assert.equal(normalizeYoutubeWatchUrl('https://www.youtube.com/shorts/abc123'), 'https://www.youtube.com/watch?v=abc123');
    assert.equal(normalizeYoutubeWatchUrl('https://m.youtube.com/watch?v=abc123&t=30s'), 'https://www.youtube.com/watch?v=abc123');
    assert.equal(normalizeYoutubeWatchUrl('https://youtu.be/abc123?si=xyz'), 'https://www.youtube.com/watch?v=abc123');
  });
});
