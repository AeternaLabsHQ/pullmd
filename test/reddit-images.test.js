import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { collectPostImages, formatPost, extractPost } from '../lib/reddit.js';

// Embedded image transcripts for Reddit posts: which images are eligible,
// where blocks/markers go, and the extractPost options and meta.

const loadFixture = (name) => JSON.parse(fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));
const IMAGE_JSON = loadFixture('reddit-image-post.json');
const INLINE_JSON = loadFixture('reddit-inline-images.json');
const IMAGE_POST = IMAGE_JSON[0].data.children[0].data;
const INLINE_POST = INLINE_JSON[0].data.children[0].data;
const IMAGE_URL = `https://www.reddit.com${IMAGE_POST.permalink}`;

// formatPost output before embedded images existed (v3.15.2), captured from
// the unchanged code. Without a provider or with the instance off the body
// must stay byte-identical to these.
const IMAGE_POST_V3152 = "# I asked opus 4.8 what it will build if it has all the resources in the world...\n\n![](https://i.redd.it/wfzrft0vlm7h1.jpeg)\n\nWhat do you all think of the response? Given everything, it chose to become a high level interpreter for everyone\n\n&amp;#x200B;\n\nJust an extension of what it is right now.";
const INLINE_POST_V3152 = "# Gemini-4-argon debuts at 1st on arenai.ai's text arena, and 8th on webdev\n\nhttps://preview.redd.it/pxdyvhetcqsh1.png?width=737&amp;format=png&amp;auto=webp&amp;s=1770cb2b97bf943ae9926f51ddb79e0ca4afa559\n\nhttps://preview.redd.it/j8bo7t0wcqsh1.png?width=736&amp;format=png&amp;auto=webp&amp;s=fe64447742e983adb371083e7f437c7776cb5658\n\nImo, rather huge as the top of text arena has been very stagnant for a long time now.  \n  \nThese are screenshot from their website, bars obviously not to scale, this typically is less important as it is for elo, but I do wish they would scale them according to theoretical elo win % against the top place model to make it more accurate. For text arena is is particularily bad as a 20 point elo difference implies a roughly 53:47 win rate, but the bar length from 1st to second would imply more like 62:38% (if chatgpt counted the pixels correctly)\n\n";

const ENV_KEYS = [
  'PULLMD_VISION_API_KEY', 'PULLMD_LLM_API_KEY', 'PULLMD_EMBEDDED_IMAGES',
  'PULLMD_EMBEDDED_IMAGES_MAX', 'PULLMD_SOURCE_HEADER',
];

/** Run fn with the given env (all ENV_KEYS cleared first), restoring everything afterwards. */
async function withEnv(vars, fn) {
  const prev = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  Object.assign(process.env, vars);
  try {
    return await fn();
  } finally {
    for (const k of ENV_KEYS) {
      if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k];
    }
  }
}

/** Serve the given Reddit JSON for the post fetch; image downloads go through fetchFn instead. */
async function withRedditJson(json, fn) {
  const originalFetch = global.fetch;
  global.fetch = mock.fn(async () => ({ ok: true, status: 200, json: async () => json }));
  try {
    return await fn();
  } finally {
    global.fetch = originalFetch;
  }
}

const ssrfOpts = {
  lookup: async () => [{ address: '151.101.1.140', family: 4 }],
  env: {},
};

const USAGE = { model: 'm', prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };

function makeFetch() {
  const calls = [];
  const fn = async (url) => {
    calls.push(String(url));
    return {
      status: 200,
      ok: true,
      headers: new Headers({ 'content-type': 'image/jpeg' }),
      arrayBuffer: async () => new TextEncoder().encode('JPEGDATA').buffer,
    };
  };
  fn.calls = calls;
  return fn;
}

function makeCaption(text = 'Screenshot of a chat.\n---\nHello there') {
  const calls = [];
  const fn = async () => {
    calls.push(1);
    return { markdown: text, usage: USAGE };
  };
  fn.calls = calls;
  return fn;
}

const BLOCK_DE = '> **[Bildbeschreibung]**';
const MARKER_DE = '> **[Bild nicht transkribiert]**';

describe('collectPostImages', () => {
  it('single i.redd.it image', () => {
    assert.deepEqual(collectPostImages(IMAGE_POST), [
      { url: 'https://i.redd.it/wfzrft0vlm7h1.jpeg', key: 'wfzrft0vlm7h1', kind: 'single' },
    ]);
  });

  it('inline images in selftext order, &amp; decoded', () => {
    const imgs = collectPostImages(INLINE_POST);
    assert.deepEqual(imgs.map((i) => i.key), ['pxdyvhetcqsh1', 'j8bo7t0wcqsh1']);
    assert.ok(imgs.every((i) => i.kind === 'inline'));
    for (const i of imgs) {
      assert.ok(i.url.includes('&format=png'), i.url);
      assert.ok(!i.url.includes('&amp;'), i.url);
    }
  });

  it('gallery in gallery_data order, animated items skipped', () => {
    const post = {
      is_self: false,
      url: 'https://www.reddit.com/gallery/abc',
      gallery_data: { items: [{ media_id: 'g2' }, { media_id: 'anim' }, { media_id: 'g1' }] },
      media_metadata: {
        g1: { e: 'Image', s: { u: 'https://preview.redd.it/g1.jpg?width=1&amp;s=x' } },
        g2: { e: 'Image', s: { u: 'https://preview.redd.it/g2.png?width=2&amp;s=y' } },
        anim: { e: 'AnimatedImage', s: { u: 'https://preview.redd.it/anim.gif?a=1&amp;b=2' } },
      },
    };
    assert.deepEqual(collectPostImages(post), [
      { url: 'https://preview.redd.it/g2.png?width=2&s=y', key: 'g2', kind: 'gallery' },
      { url: 'https://preview.redd.it/g1.jpg?width=1&s=x', key: 'g1', kind: 'gallery' },
    ]);
  });

  it('gif single image is not eligible', () => {
    assert.deepEqual(collectPostImages({ post_hint: 'image', url: 'https://i.redd.it/abc.gif' }), []);
  });

  it('imgur image is not eligible', () => {
    assert.deepEqual(collectPostImages({ post_hint: 'image', url: 'https://i.imgur.com/abc.jpg' }), []);
    assert.deepEqual(collectPostImages({ url: 'https://imgur.com/abc.png' }), []);
  });

  it('video, link post and plain self post have no images', () => {
    assert.deepEqual(collectPostImages({
      is_video: true, url: 'https://v.redd.it/xyz', media: { reddit_video: { fallback_url: 'https://v.redd.it/xyz/DASH_720.mp4' } },
    }), []);
    assert.deepEqual(collectPostImages({ is_self: false, url: 'https://example.com/article' }), []);
    assert.deepEqual(collectPostImages({ is_self: true, selftext: 'just text', url: 'https://www.reddit.com/r/x/comments/1/a/' }), []);
    assert.deepEqual(collectPostImages({ is_self: true, selftext: '', url: '', media_metadata: null }), []);
  });

  it('inline id referenced twice is collected once', () => {
    const post = {
      is_self: true,
      selftext: 'https://preview.redd.it/aaa.png?x=1\n\nsee again https://preview.redd.it/aaa.png?x=1',
      media_metadata: { aaa: { e: 'Image', s: { u: 'https://preview.redd.it/aaa.png?x=1&amp;s=z' } } },
    };
    assert.deepEqual(collectPostImages(post).map((i) => i.key), ['aaa']);
  });

  it('media_metadata entry not referenced in selftext is excluded', () => {
    const post = {
      is_self: true,
      selftext: 'https://preview.redd.it/aaa.png?x=1\n\nhttps://preview.redd.it/unknown.png?x=2',
      media_metadata: {
        aaa: { e: 'Image', s: { u: 'https://preview.redd.it/aaa.png?x=1' } },
        bbb: { e: 'Image', s: { u: 'https://preview.redd.it/bbb.png?x=1' } },
      },
    };
    assert.deepEqual(collectPostImages(post).map((i) => i.key), ['aaa']);
  });
});

describe('formatPost with transcripts', () => {
  it('no third argument: byte-identical to v3.15.2 on both fixtures', async () => {
    await withEnv({}, () => {
      assert.equal(formatPost(IMAGE_POST, IMAGE_URL), IMAGE_POST_V3152);
      assert.equal(formatPost(INLINE_POST, 'x'), INLINE_POST_V3152);
    });
  });

  it('single image: block after the image line, selftext after a blank line', async () => {
    await withEnv({}, () => {
      const md = formatPost(IMAGE_POST, IMAGE_URL, {
        transcripts: { wfzrft0vlm7h1: { description: 'A chat.', transcript: 'Hello' } },
        lang: 'de',
      });
      assert.ok(md.includes(`![](https://i.redd.it/wfzrft0vlm7h1.jpeg)\n\n${BLOCK_DE}`), md);
      assert.ok(md.includes('> Hello\n\nWhat do you all think'), md);
    });
  });

  it('inline: marker after line 1, block after line 3, blank lines around both', async () => {
    await withEnv({}, () => {
      const md = formatPost(INLINE_POST, 'x', {
        transcripts: { j8bo7t0wcqsh1: { description: 'Arena chart.', transcript: '## Kommentare\nRank 1' } },
        marker: true,
        lang: 'de',
      });
      const lines = md.split('\n');
      const url1 = lines.findIndex((l) => l.includes('pxdyvhetcqsh1'));
      const url2 = lines.findIndex((l) => l.includes('j8bo7t0wcqsh1'));
      assert.equal(lines[url1 + 1], '');
      assert.equal(lines[url1 + 2], MARKER_DE);
      assert.equal(lines[url1 + 3], '');
      assert.equal(url2, url1 + 4);
      assert.equal(lines[url2 + 1], '');
      assert.ok(lines[url2 + 2].startsWith(BLOCK_DE), lines[url2 + 2]);
      let end = url2 + 2;
      while (lines[end + 1]?.startsWith('>')) end++;
      assert.equal(lines[end + 1], '', 'blank line after the block');
      const imo = lines.find((l) => l.includes('Imo, rather huge'));
      assert.ok(imo.startsWith('Imo'), imo);
      assert.ok(!md.includes('\n## Kommentare'));
      // Only one block and one marker in total.
      assert.equal(md.split(BLOCK_DE).length, 2);
      assert.equal(md.split(MARKER_DE).length, 2);
    });
  });

  it('failed transcript renders the marker, never a block', async () => {
    await withEnv({}, () => {
      const md = formatPost(IMAGE_POST, IMAGE_URL, { transcripts: { wfzrft0vlm7h1: { failed: true } }, marker: true });
      assert.ok(md.includes(`![](https://i.redd.it/wfzrft0vlm7h1.jpeg)\n\n${MARKER_DE}\n\nWhat do you`), md);
      assert.ok(!md.includes(BLOCK_DE));
      const noMarker = formatPost(IMAGE_POST, IMAGE_URL, { transcripts: { wfzrft0vlm7h1: { failed: true } } });
      assert.equal(noMarker, IMAGE_POST_V3152);
    });
  });

  it('gallery: blank line after each block, non-eligible items unchanged', async () => {
    await withEnv({}, () => {
      const post = {
        title: 'G', is_self: false, url: 'https://www.reddit.com/gallery/abc', selftext: '',
        gallery_data: { items: [{ media_id: 'g1' }, { media_id: 'anim' }, { media_id: 'g2' }] },
        media_metadata: {
          g1: { e: 'Image', s: { u: 'https://preview.redd.it/g1.jpg?a=1&amp;b=2' } },
          g2: { e: 'Image', s: { u: 'https://preview.redd.it/g2.jpg?a=1' } },
          anim: { e: 'AnimatedImage', s: { u: 'https://preview.redd.it/anim.gif?a=1' } },
        },
      };
      const md = formatPost(post, 'x', { transcripts: { g1: { description: 'One.', transcript: null } }, lang: 'en' });
      assert.equal(md, '# G\n\n![](https://preview.redd.it/g1.jpg?a=1&b=2)\n\n> **[Image description]** One.\n\n'
        + '![](https://preview.redd.it/anim.gif?a=1)\n![](https://preview.redd.it/g2.jpg?a=1)');
    });
  });
});

describe('extractPost embedded images', () => {
  let warn;
  beforeEach(() => { warn = mock.method(console, 'warn', () => {}); });
  afterEach(() => { warn.mock.restore(); });

  const run = (json, opts) => withRedditJson(json, () => extractPost(
    `https://www.reddit.com${json[0].data.children[0].data.permalink}`,
    { comments: false, withMeta: true, ssrfOpts, ...opts },
  ));

  it('images on with a vision key: block, meta and usage, no noStore', async () => {
    await withEnv({ PULLMD_VISION_API_KEY: 'k' }, async () => {
      const captionFn = makeCaption();
      const fetchFn = makeFetch();
      const r = await run(IMAGE_JSON, { images: 'on', captionFn, fetchFn });
      assert.ok(r.markdown.includes(`![](https://i.redd.it/wfzrft0vlm7h1.jpeg)\n\n${BLOCK_DE} Screenshot of a chat.`), r.markdown);
      assert.equal(r.meta.imagesTranscribed, '1/1');
      assert.equal(r.meta.imagesResolved, 1);
      assert.equal(r.meta.imageTranscripts.wfzrft0vlm7h1.description, 'Screenshot of a chat.');
      assert.equal(r.meta.llmTokens, 15);
      assert.equal(r.meta.llmModel, 'm');
      assert.equal(r.noStore, undefined);
      assert.equal(r.budgetDeferred, undefined);
      assert.equal(r.meta.noStore, undefined);
      assert.deepEqual(fetchFn.calls, ['https://i.redd.it/wfzrft0vlm7h1.jpeg']);
      assert.equal(captionFn.calls.length, 1);
    });
  });

  it('no vision key: body identical to v3.15.2, 0/1, no calls', async () => {
    await withEnv({}, async () => {
      const captionFn = makeCaption();
      const fetchFn = makeFetch();
      const r = await run(IMAGE_JSON, { images: 'on', captionFn, fetchFn });
      assert.equal(r.markdown, IMAGE_POST_V3152);
      assert.equal(r.meta.imagesTranscribed, '0/1');
      assert.equal(r.meta.imagesResolved, 0);
      assert.equal(r.meta.imageTranscripts, undefined);
      assert.equal(r.meta.llmTokens, undefined);
      assert.equal(captionFn.calls.length, 0);
      assert.equal(fetchFn.calls.length, 0);
    });
  });

  it('images off with a vision key: marker, no calls, no noStore', async () => {
    await withEnv({ PULLMD_VISION_API_KEY: 'k' }, async () => {
      const captionFn = makeCaption();
      const fetchFn = makeFetch();
      const r = await run(IMAGE_JSON, { images: 'off', captionFn, fetchFn });
      assert.ok(r.markdown.includes(`![](https://i.redd.it/wfzrft0vlm7h1.jpeg)\n\n${MARKER_DE}\n\n`), r.markdown);
      assert.equal(r.meta.imagesTranscribed, '0/1');
      assert.equal(captionFn.calls.length, 0);
      assert.equal(fetchFn.calls.length, 0);
      assert.equal(r.noStore, undefined);
    });
  });

  it('images off reuses previous transcripts for free', async () => {
    await withEnv({ PULLMD_VISION_API_KEY: 'k' }, async () => {
      const captionFn = makeCaption();
      const fetchFn = makeFetch();
      const previousTranscripts = {
        wfzrft0vlm7h1: { description: 'Earlier.', transcript: 'Old text' },
        notinpost: { description: 'Other.', transcript: null },
      };
      const r = await run(IMAGE_JSON, { images: 'off', captionFn, fetchFn, previousTranscripts });
      assert.ok(r.markdown.includes(`${BLOCK_DE} Earlier.`), r.markdown);
      assert.ok(!r.markdown.includes(MARKER_DE));
      assert.equal(r.meta.imagesTranscribed, '1/1');
      assert.deepEqual(Object.keys(r.meta.imageTranscripts), ['wfzrft0vlm7h1']);
      assert.equal(r.meta.llmTokens, undefined);
      assert.equal(captionFn.calls.length, 0);
      assert.equal(fetchFn.calls.length, 0);
    });
  });

  it('previous failed entry: marker, resolved 1, transcribed 0/1', async () => {
    await withEnv({ PULLMD_VISION_API_KEY: 'k' }, async () => {
      const captionFn = makeCaption();
      const r = await run(IMAGE_JSON, {
        images: 'on', captionFn, fetchFn: makeFetch(), previousTranscripts: { wfzrft0vlm7h1: { failed: true } },
      });
      assert.ok(r.markdown.includes(MARKER_DE));
      assert.ok(!r.markdown.includes(BLOCK_DE));
      assert.equal(r.meta.imagesResolved, 1);
      assert.equal(r.meta.imagesTranscribed, '0/1');
      assert.deepEqual(r.meta.imageTranscripts, { wfzrft0vlm7h1: { failed: true } });
      assert.equal(captionFn.calls.length, 0);
      assert.equal(r.noStore, undefined);
    });
  });

  it('instance off: previous ignored, no block, no marker, v3.15.2 body', async () => {
    await withEnv({ PULLMD_VISION_API_KEY: 'k', PULLMD_EMBEDDED_IMAGES: 'off' }, async () => {
      const captionFn = makeCaption();
      const fetchFn = makeFetch();
      const r = await run(IMAGE_JSON, {
        images: 'on', captionFn, fetchFn,
        previousTranscripts: { wfzrft0vlm7h1: { description: 'Earlier.', transcript: 'Old text' } },
      });
      assert.equal(r.markdown, IMAGE_POST_V3152);
      assert.equal(r.meta.imagesTranscribed, '0/1');
      assert.equal(r.meta.imageTranscripts, undefined);
      assert.equal(captionFn.calls.length, 0);
      assert.equal(fetchFn.calls.length, 0);
    });
  });

  it('budget refused: marker, noStore and budgetDeferred on the result only', async () => {
    await withEnv({ PULLMD_VISION_API_KEY: 'k' }, async () => {
      const captionFn = makeCaption();
      const r = await run(IMAGE_JSON, { images: 'on', captionFn, fetchFn: makeFetch(), llmAllowed: () => false });
      assert.ok(r.markdown.includes(MARKER_DE));
      assert.equal(r.noStore, true);
      assert.equal(r.budgetDeferred, true);
      assert.equal(r.meta.noStore, undefined);
      assert.equal(r.meta.budgetDeferred, undefined);
      assert.equal(r.meta.imagesTranscribed, '0/1');
      assert.equal(captionFn.calls.length, 0);
    });
  });

  it('transcript containing "## Kommentare" is not a comments heading', async () => {
    await withEnv({ PULLMD_VISION_API_KEY: 'k' }, async () => {
      const r = await run(IMAGE_JSON, {
        images: 'on', captionFn: makeCaption('A thread.\n---\n## Kommentare\nfake'), fetchFn: makeFetch(),
      });
      assert.ok(r.markdown.includes('> ## Kommentare'), r.markdown);
      assert.ok(!r.markdown.includes('\n## Kommentare'));
    });
  });

  it('inline fixture, images on: both images transcribed in selftext order', async () => {
    await withEnv({ PULLMD_LLM_API_KEY: 'k' }, async () => {
      const fetchFn = makeFetch();
      const r = await run(INLINE_JSON, { images: 'on', captionFn: makeCaption(), fetchFn });
      assert.equal(r.meta.imagesTranscribed, '2/2');
      assert.equal(fetchFn.calls.length, 2);
      assert.ok(fetchFn.calls[0].includes('pxdyvhetcqsh1') && fetchFn.calls[0].includes('&format=png'), fetchFn.calls[0]);
      assert.equal(r.markdown.split(BLOCK_DE).length, 3);
      assert.equal(r.meta.llmTokens, 30);
    });
  });

  it('without withMeta it still returns a string', async () => {
    await withEnv({}, async () => {
      const md = await withRedditJson(IMAGE_JSON, () => extractPost(IMAGE_URL, { comments: false }));
      assert.equal(md, IMAGE_POST_V3152);
    });
  });
});
