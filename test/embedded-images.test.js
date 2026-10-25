import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  EMBEDDED_IMAGE_HOSTS,
  readEmbeddedImagesMode,
  embeddedImagesModeWarning,
  readEmbeddedImagesMax,
  parseImagesParam,
  resolveEmbeddedImages,
  visionConfigured,
  buildImagePrompt,
  parseCaption,
  renderImageBlock,
  renderImageMarker,
  cachedImagesIncomplete,
} from '../lib/embedded-images.js';

const KEYS = ['PULLMD_VISION_API_KEY', 'PULLMD_LLM_API_KEY'];

/** Run fn with the vision key env set to `vision` / `shared` (undefined = unset), then restore. */
function withKeys({ vision, shared } = {}, fn) {
  const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  try {
    for (const k of KEYS) delete process.env[k];
    if (vision !== undefined) process.env.PULLMD_VISION_API_KEY = vision;
    if (shared !== undefined) process.env.PULLMD_LLM_API_KEY = shared;
    return fn();
  } finally {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
  }
}

describe('EMBEDDED_IMAGE_HOSTS', () => {
  test('allows the two Reddit image hosts only', () => {
    assert.deepEqual([...EMBEDDED_IMAGE_HOSTS].sort(), ['i.redd.it', 'preview.redd.it']);
  });
});

describe('readEmbeddedImagesMode / embeddedImagesModeWarning', () => {
  test('unset defaults to on-request without a warning', () => {
    assert.equal(readEmbeddedImagesMode({}), 'on-request');
    assert.equal(embeddedImagesModeWarning({}), null);
  });
  test('valid values pass through', () => {
    for (const v of ['off', 'on-request', 'always']) {
      assert.equal(readEmbeddedImagesMode({ PULLMD_EMBEDDED_IMAGES: v }), v);
      assert.equal(embeddedImagesModeWarning({ PULLMD_EMBEDDED_IMAGES: v }), null);
    }
  });
  test('invalid value falls back and warns', () => {
    const env = { PULLMD_EMBEDDED_IMAGES: 'yes' };
    assert.equal(readEmbeddedImagesMode(env), 'on-request');
    assert.match(embeddedImagesModeWarning(env), /PULLMD_EMBEDDED_IMAGES/);
  });
  test('empty string counts as unset', () => {
    assert.equal(readEmbeddedImagesMode({ PULLMD_EMBEDDED_IMAGES: '' }), 'on-request');
    assert.equal(embeddedImagesModeWarning({ PULLMD_EMBEDDED_IMAGES: '' }), null);
  });
});

describe('readEmbeddedImagesMax', () => {
  test('default 4, valid 1-20 accepted, others fall back', () => {
    assert.equal(readEmbeddedImagesMax({}), 4);
    assert.equal(readEmbeddedImagesMax({ PULLMD_EMBEDDED_IMAGES_MAX: '7' }), 7);
    assert.equal(readEmbeddedImagesMax({ PULLMD_EMBEDDED_IMAGES_MAX: '1' }), 1);
    assert.equal(readEmbeddedImagesMax({ PULLMD_EMBEDDED_IMAGES_MAX: '20' }), 20);
    for (const bad of ['0', '21', 'x', '-3', '2.5']) {
      assert.equal(readEmbeddedImagesMax({ PULLMD_EMBEDDED_IMAGES_MAX: bad }), 4, bad);
    }
  });
});

describe('parseImagesParam', () => {
  test('on / off aliases', () => {
    for (const v of ['on', 'true', '1']) assert.equal(parseImagesParam(v), 'on', v);
    for (const v of ['off', 'false', '0']) assert.equal(parseImagesParam(v), 'off', v);
  });
  test('absent or empty is undefined', () => {
    assert.equal(parseImagesParam(undefined), undefined);
    assert.equal(parseImagesParam(''), undefined);
  });
  test('invalid is null', () => {
    assert.equal(parseImagesParam('maybe'), null);
  });
});

describe('resolveEmbeddedImages', () => {
  const env = (mode) => ({ PULLMD_EMBEDDED_IMAGES: mode });
  test('off instance overrides the request', () => {
    assert.equal(resolveEmbeddedImages('on', env('off')), 'off');
    assert.equal(resolveEmbeddedImages(undefined, env('off')), 'off');
  });
  test('on-request is off unless asked', () => {
    assert.equal(resolveEmbeddedImages(undefined, env('on-request')), 'off');
    assert.equal(resolveEmbeddedImages('on', env('on-request')), 'on');
    assert.equal(resolveEmbeddedImages('off', env('on-request')), 'off');
  });
  test('always is on unless the request says off', () => {
    assert.equal(resolveEmbeddedImages(undefined, env('always')), 'on');
    assert.equal(resolveEmbeddedImages('off', env('always')), 'off');
    assert.equal(resolveEmbeddedImages('on', env('always')), 'on');
  });
});

describe('visionConfigured', () => {
  test('reflects the vision key including the shared fallback', () => {
    assert.equal(withKeys({}, () => visionConfigured()), false);
    assert.equal(withKeys({ vision: 'k' }, () => visionConfigured()), true);
    assert.equal(withKeys({ shared: 'k' }, () => visionConfigured()), true);
  });
});

describe('buildImagePrompt', () => {
  test('fills the description language', () => {
    assert.match(buildImagePrompt('de'), /written in German\./);
    assert.match(buildImagePrompt('en'), /written in English\./);
    assert.doesNotMatch(buildImagePrompt('de'), /\{LANG\}/);
  });
});

describe('parseCaption', () => {
  test('splits at the first --- line only', () => {
    assert.deepEqual(parseCaption('Desc\n---\nLine1\n---\nLine2'),
      { description: 'Desc', transcript: 'Line1\n---\nLine2' });
  });
  test('no separator means description only', () => {
    assert.deepEqual(parseCaption('Only desc'), { description: 'Only desc', transcript: null });
  });
  test('empty or whitespace is null', () => {
    assert.equal(parseCaption('  '), null);
    assert.equal(parseCaption(''), null);
    assert.equal(parseCaption(undefined), null);
  });
  test('empty transcript is null', () => {
    assert.deepEqual(parseCaption('Desc\n---\n'), { description: 'Desc', transcript: null });
  });
  test('tolerates CRLF and trailing spaces on the separator', () => {
    assert.deepEqual(parseCaption('Desc\r\n--- \r\nText'), { description: 'Desc', transcript: 'Text' });
  });
  test('a --- inside a line is not a separator', () => {
    assert.deepEqual(parseCaption('a --- b'), { description: 'a --- b', transcript: null });
  });
});

describe('renderImageBlock', () => {
  test('description and transcript, every line quoted', () => {
    const block = renderImageBlock({ description: 'D', transcript: 'a\n\n## Kommentare' }, 'de');
    assert.equal(block, '> **[Bildbeschreibung]** D\n>\n> **[Bildtranskript]**\n> a\n>\n> ## Kommentare');
    assert.ok(!block.includes('\n## '));
    for (const line of block.split('\n')) assert.ok(line.startsWith('>'), line);
  });
  test('english labels', () => {
    assert.equal(renderImageBlock({ description: 'D', transcript: 'T' }, 'en'),
      '> **[Image description]** D\n>\n> **[Image transcript]**\n> T');
  });
  test('description only is a single line', () => {
    assert.equal(renderImageBlock({ description: 'D', transcript: null }, 'de'),
      '> **[Bildbeschreibung]** D');
  });
  test('multi-line description keeps the quote prefix', () => {
    const block = renderImageBlock({ description: 'D1\nD2\n# H', transcript: null }, 'en');
    for (const line of block.split('\n')) assert.ok(line.startsWith('>'), line);
  });
  test('CRLF transcript is normalised', () => {
    const block = renderImageBlock({ description: 'D', transcript: 'a\r\n\r\nb' }, 'en');
    assert.ok(!block.includes('\r'));
    assert.ok(block.endsWith('> a\n>\n> b'));
  });
});

describe('renderImageMarker', () => {
  test('exact strings', () => {
    assert.equal(renderImageMarker('de'), '> **[Bild nicht transkribiert]**');
    assert.equal(renderImageMarker('en'), '> **[Image not transcribed]**');
  });
});

describe('cachedImagesIncomplete', () => {
  const env = {};
  const inc = (meta, key = 'k') => withKeys(key ? { vision: key } : {}, () => cachedImagesIncomplete(meta, env));
  test('nothing transcribed yet is incomplete', () => {
    assert.equal(inc({ imagesTranscribed: '0/1' }), true);
  });
  test('all done is complete', () => {
    assert.equal(inc({ imagesTranscribed: '1/1' }), false);
  });
  test('capped by max (default 4)', () => {
    assert.equal(inc({ imagesTranscribed: '4/6' }), false);
    assert.equal(inc({ imagesTranscribed: '3/6' }), true);
  });
  test('honours PULLMD_EMBEDDED_IMAGES_MAX from the passed env', () => {
    const e = { PULLMD_EMBEDDED_IMAGES_MAX: '6' };
    assert.equal(withKeys({ vision: 'k' }, () => cachedImagesIncomplete({ imagesTranscribed: '4/6' }, e)), true);
  });
  test('permanently failed images count as resolved', () => {
    assert.equal(inc({ imagesTranscribed: '0/1', imagesResolved: 1 }), false);
  });
  test('no metadata or no field is not incomplete', () => {
    assert.equal(inc(null), false);
    assert.equal(inc({}), false);
    assert.equal(inc({ imagesTranscribed: 'garbage' }), false);
  });
  test('without a vision provider never incomplete', () => {
    assert.equal(inc({ imagesTranscribed: '0/1' }, null), false);
  });
});
