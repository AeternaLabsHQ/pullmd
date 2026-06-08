import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isYoutubeUrl, normalizeYoutubeWatchUrl } from '../lib/youtube.js';

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
