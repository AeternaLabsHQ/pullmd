import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { rewriteOcrImages, parseDataUri, IMAGE_EXT } from '../lib/ocr-images.js';

const IMG = (over = {}) => ({ id: 'img-0.jpeg', width: 648, height: 523, ...over });
const withDesc = (description) => IMG({ annotation: { imageType: 'chart', description } });

describe('rewriteOcrImages - modes', () => {
  it('strip: text line with dimensions', () => {
    const out = rewriteOcrImages('Vor\n\n![img-0.jpeg](img-0.jpeg)\n\nNach', [IMG()], { mode: 'strip' });
    assert.equal(out, 'Vor\n\n*[Abbildung: img-0.jpeg, 648×523 px]*\n\nNach');
  });

  it('strip: without known dimensions', () => {
    const out = rewriteOcrImages('![img-0.jpeg](img-0.jpeg)', [IMG({ width: null, height: null })], { mode: 'strip' });
    assert.equal(out, '*[Abbildung: img-0.jpeg]*');
  });

  it('caption: description block with dimensions', () => {
    const out = rewriteOcrImages('![img-0.jpeg](img-0.jpeg)', [withDesc('Ein Balkendiagramm')], { mode: 'caption' });
    assert.equal(out, '> **Abbildung** (img-0.jpeg, 648×523): Ein Balkendiagramm');
  });

  it('caption: without dimensions', () => {
    const out = rewriteOcrImages('![img-0.jpeg](img-0.jpeg)',
      [IMG({ width: null, height: null, annotation: { description: 'Foto' } })], { mode: 'caption' });
    assert.equal(out, '> **Abbildung** (img-0.jpeg): Foto');
  });

  it('hosted: image link with the description as alt text', () => {
    const urlById = new Map([['img-0.jpeg', 'https://x.test/img/abc.png']]);
    const out = rewriteOcrImages('![img-0.jpeg](img-0.jpeg)', [withDesc('Ein Balkendiagramm')], { mode: 'hosted', urlById });
    assert.equal(out, '![Ein Balkendiagramm](https://x.test/img/abc.png)');
  });

  it('hosted: alt falls back to "id, WxH" without a description', () => {
    const urlById = new Map([['img-0.jpeg', 'https://x.test/img/abc.png']]);
    const out = rewriteOcrImages('![img-0.jpeg](img-0.jpeg)', [IMG()], { mode: 'hosted', urlById });
    assert.equal(out, '![img-0.jpeg, 648×523](https://x.test/img/abc.png)');
  });

  it('unknown mode behaves like strip', () => {
    const out = rewriteOcrImages('![img-0.jpeg](img-0.jpeg)', [withDesc('Foto')], { mode: 'bogus' });
    assert.equal(out, '*[Abbildung: img-0.jpeg, 648×523 px]*');
  });

  it('lang en uses the label Figure', () => {
    assert.equal(rewriteOcrImages('![img-0.jpeg](img-0.jpeg)', [IMG()], { mode: 'strip', lang: 'en' }),
      '*[Figure: img-0.jpeg, 648×523 px]*');
    assert.equal(rewriteOcrImages('![img-0.jpeg](img-0.jpeg)', [withDesc('Photo')], { mode: 'caption', lang: 'en' }),
      '> **Figure** (img-0.jpeg, 648×523): Photo');
  });
});

describe('rewriteOcrImages - degrade per image', () => {
  it('hosted without URL but with annotation falls back to caption form', () => {
    const out = rewriteOcrImages('![img-0.jpeg](img-0.jpeg)', [withDesc('Foto')], { mode: 'hosted', urlById: new Map() });
    assert.equal(out, '> **Abbildung** (img-0.jpeg, 648×523): Foto');
  });

  it('hosted without urlById option degrades the same way', () => {
    const out = rewriteOcrImages('![img-0.jpeg](img-0.jpeg)', [withDesc('Foto')], { mode: 'hosted' });
    assert.equal(out, '> **Abbildung** (img-0.jpeg, 648×523): Foto');
  });

  it('hosted without URL and without annotation falls back to strip form', () => {
    const out = rewriteOcrImages('![img-0.jpeg](img-0.jpeg)', [IMG()], { mode: 'hosted', urlById: new Map() });
    assert.equal(out, '*[Abbildung: img-0.jpeg, 648×523 px]*');
  });

  it('caption without annotation falls back to strip form', () => {
    const out = rewriteOcrImages('![img-0.jpeg](img-0.jpeg)', [IMG()], { mode: 'caption' });
    assert.equal(out, '*[Abbildung: img-0.jpeg, 648×523 px]*');
  });

  it('caption with a description that flattens to empty falls back to strip form', () => {
    const out = rewriteOcrImages('![img-0.jpeg](img-0.jpeg)', [withDesc(' [] `` ')], { mode: 'caption' });
    assert.equal(out, '*[Abbildung: img-0.jpeg, 648×523 px]*');
  });

  it('degrades per image, not per document', () => {
    const images = [IMG(), IMG({ id: 'img-1.jpeg', width: 10, height: 20, annotation: { description: 'Zwei' } })];
    const urlById = new Map([['img-0.jpeg', 'https://x.test/img/a.jpeg']]);
    const out = rewriteOcrImages('![img-0.jpeg](img-0.jpeg) und ![img-1.jpeg](img-1.jpeg)', images, { mode: 'hosted', urlById });
    assert.equal(out, '![img-0.jpeg, 648×523](https://x.test/img/a.jpeg) und > **Abbildung** (img-1.jpeg, 10×20): Zwei');
  });
});

describe('rewriteOcrImages - matching', () => {
  it('placeholder without an entry gets the dimensionless strip form, in every mode', () => {
    for (const mode of ['strip', 'caption', 'hosted']) {
      const out = rewriteOcrImages('![img-7.png](img-7.png)', [], { mode, urlById: new Map() });
      assert.equal(out, '*[Abbildung: img-7.png]*', mode);
    }
  });

  it('works with an empty images array and untouched text', () => {
    assert.equal(rewriteOcrImages('# Titel\n\nText', [], { mode: 'strip' }), '# Titel\n\nText');
  });

  it('replaces the same id twice', () => {
    const out = rewriteOcrImages('![img-0.jpeg](img-0.jpeg) a ![img-0.jpeg](img-0.jpeg)', [IMG()], { mode: 'strip' });
    assert.equal(out, '*[Abbildung: img-0.jpeg, 648×523 px]* a *[Abbildung: img-0.jpeg, 648×523 px]*');
  });

  it('treats the id literally: img-0.jpeg does not match img-0xjpeg', () => {
    const md = '![img-0xjpeg](img-0xjpeg)';
    assert.equal(rewriteOcrImages(md, [IMG()], { mode: 'strip' }), md);
  });

  it('known ids with regex metacharacters are matched literally', () => {
    const img = IMG({ id: 'a+b$.jpeg' });
    assert.equal(rewriteOcrImages('![a+b$.jpeg](a+b$.jpeg) ![aabb.jpeg](aabb.jpeg)', [img], { mode: 'strip' }),
      '*[Abbildung: a+b$.jpeg, 648×523 px]* ![aabb.jpeg](aabb.jpeg)');
  });

  it('hosted: foreign links stay byte-identical while a known placeholder is rewritten', () => {
    const urlById = new Map([['img-0.jpeg', 'https://x.test/img/a.png']]);
    const foreign = [
      '![x](https://other-host/img/0123456789abcdef0123456789abcdef.jpeg)',
      '![x](/api?url=http://a)',
      '![chart](chart)',
    ];
    const out = rewriteOcrImages(`${foreign.join('\n')}\n![img-0.jpeg](img-0.jpeg)`, [IMG()], { mode: 'hosted', urlById });
    assert.equal(out, `${foreign.join('\n')}\n![img-0.jpeg, 648×523](https://x.test/img/a.png)`);
  });

  it('leaves ordinary image links and other links untouched', () => {
    const md = '![chart](https://example.com/a.png) ![x](/api?url=http://a) ![img-0.jpeg](other.jpeg) ![](img-0.jpeg)';
    assert.equal(rewriteOcrImages(md, [IMG()], { mode: 'strip' }), md);
  });

  it('does not replace a replacement result again', () => {
    const urlById = new Map([['img-0.jpeg', 'https://x.test/img/img-0.jpeg']]);
    const out = rewriteOcrImages('![img-0.jpeg](img-0.jpeg)', [IMG()], { mode: 'hosted', urlById });
    assert.equal(out, '![img-0.jpeg, 648×523](https://x.test/img/img-0.jpeg)');
  });

  it('does not interpret $ sequences in descriptions', () => {
    const out = rewriteOcrImages('![img-0.jpeg](img-0.jpeg)', [withDesc("Preis $& und $1 und $'")], { mode: 'caption' });
    assert.equal(out, "> **Abbildung** (img-0.jpeg, 648×523): Preis $& und $1 und $'");
  });
});

describe('rewriteOcrImages - description flattening', () => {
  it('flattens to one line without brackets or backticks', () => {
    const urlById = new Map([['img-0.jpeg', 'https://x.test/img/a.png']]);
    const out = rewriteOcrImages('![img-0.jpeg](img-0.jpeg)', [withDesc('a]\n(b) `c`')], { mode: 'hosted', urlById });
    assert.equal(out, '![a (b) c](https://x.test/img/a.png)');
    assert.ok(!out.includes('\n'));
  });

  it('collapses whitespace and trims in caption form', () => {
    const out = rewriteOcrImages('![img-0.jpeg](img-0.jpeg)', [withDesc('  eins\n\n zwei\t[drei]  ')], { mode: 'caption' });
    assert.equal(out, '> **Abbildung** (img-0.jpeg, 648×523): eins zwei drei');
  });

  it('removes angle brackets so raw HTML and autolinks cannot reach the output', () => {
    const urlById = new Map([['img-0.jpeg', 'https://h/img/a.png']]);
    const description = '<img src=//evil/x> and <https://evil>';
    const caption = rewriteOcrImages('![img-0.jpeg](img-0.jpeg)', [withDesc(description)], { mode: 'caption' });
    const hosted = rewriteOcrImages('![img-0.jpeg](img-0.jpeg)', [withDesc(description)], { mode: 'hosted', urlById });
    assert.equal(caption, '> **Abbildung** (img-0.jpeg, 648×523): img src=//evil/x and https://evil');
    assert.equal(hosted, '![img src=//evil/x and https://evil](https://h/img/a.png)');
  });

  it('removes backslashes so a trailing one cannot break the hosted link', () => {
    const urlById = new Map([['img-0.jpeg', 'https://h/img/a.png']]);
    const out = rewriteOcrImages('![img-0.jpeg](img-0.jpeg)', [withDesc('ends with backslash \\')], { mode: 'hosted', urlById });
    assert.equal(out, '![ends with backslash](https://h/img/a.png)');
  });

  it('caps descriptions at 600 characters', () => {
    const out = rewriteOcrImages('![img-0.jpeg](img-0.jpeg)', [withDesc('x'.repeat(700))], { mode: 'caption' });
    assert.equal(out, `> **Abbildung** (img-0.jpeg, 648×523): ${'x'.repeat(600)}`);
  });
});

describe('parseDataUri', () => {
  const B64 = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]).toString('base64');

  it('parses a JPEG data URI', () => {
    const r = parseDataUri(`data:image/jpeg;base64,${B64}`);
    assert.equal(r.mime, 'image/jpeg');
    assert.deepEqual([...r.bytes], [0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
  });

  it('parses png, webp and gif', () => {
    for (const mime of ['image/png', 'image/webp', 'image/gif']) {
      assert.equal(parseDataUri(`data:${mime};base64,${B64}`).mime, mime);
    }
  });

  it('accepts bare base64 as image/jpeg', () => {
    const r = parseDataUri(B64);
    assert.equal(r.mime, 'image/jpeg');
    assert.equal(r.bytes.length, 6);
  });

  it('returns null for a MIME outside the allowlist', () => {
    assert.equal(parseDataUri(`data:image/svg+xml;base64,${B64}`), null);
    assert.equal(parseDataUri(`data:text/html;base64,${B64}`), null);
  });

  it('returns null for an empty payload', () => {
    assert.equal(parseDataUri('data:image/jpeg;base64,'), null);
    assert.equal(parseDataUri(''), null);
  });

  it('returns null for garbage and non-strings', () => {
    assert.equal(parseDataUri('not base64 at all!!'), null);
    assert.equal(parseDataUri('data:image/jpeg;base64,@@@@'), null);
    assert.equal(parseDataUri('data:image/jpeg,plain'), null);
    assert.equal(parseDataUri(null), null);
    assert.equal(parseDataUri(undefined), null);
    assert.equal(parseDataUri(42), null);
  });
});

describe('IMAGE_EXT', () => {
  it('maps the allowlisted MIME types to extensions', () => {
    assert.deepEqual(IMAGE_EXT, { 'image/jpeg': 'jpeg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' });
  });
});
