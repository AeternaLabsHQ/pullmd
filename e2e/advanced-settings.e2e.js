// The collapsible "Erweitert" panel under the toggle bar: shell, persistence
// of open/closed, and the three controls that moved into it. The config
// answer is mocked: these tests are about the page, not the server.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp } from './helpers/app.js';
import { launchBrowser, openPage, waitForResult } from './helpers/browser.js';

const OPEN_KEY = 'pullmd-advanced-open';

const json = (route, body, status = 200) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

describe('advanced settings panel', () => {
  let browser;
  let app;
  before(async () => {
    browser = await launchBrowser();
    app = await startApp();
  });
  after(async () => { await app?.close(); await browser?.close(); });

  async function setup(t, { config = {}, mock, history = [], storage } = {}) {
    const { context, page } = await openPage(browser, app.baseUrl, { goto: false });
    t.after(() => context.close());
    const seen = [];
    page.on('request', (r) => seen.push(r.url()));
    await context.route('**/api/config', (route) => json(route, {
      authMode: 'disabled', markitdown: true, pdfOcr: true, imageHosting: true, uploadStore: true,
      trafilatura: true, playwright: true, embeddedImages: true, markitdownYoutube: true, vision: true, ...config,
    }));
    await context.route('**/api/history*', (route) => json(route, history));
    // A conversion: the stream is refused, the plain fallback answers.
    await context.route('**/api/stream*', (route) => route.abort());
    await context.route(/\/api\?/, (route) => route.fulfill({
      status: 200, contentType: 'text/markdown', headers: { 'X-Source': 'readability' }, body: '# Doc\n\nBody\n',
    }));
    if (mock) await mock(context);
    await page.goto(app.baseUrl + '/');
    if (storage) {
      await page.evaluate((entries) => {
        for (const [k, v] of Object.entries(entries)) localStorage.setItem(k, v);
      }, storage);
      await page.reload();
    }
    return { page, seen, context };
  }

  /** Waits until the /api/config answer has been applied: a capability-bound row shows up. */
  const configApplied = (page, selector = '#extractor-select') =>
    page.locator('#advanced-panel').evaluate((el) => { el.open = true; })
      .then(() => page.locator(selector).waitFor({ state: 'visible' }));

  /** Pulls `url` and returns the query of the /api/stream request it sent. */
  async function pull(page, url = 'https://example.test/page') {
    const request = page.waitForRequest((r) => new URL(r.url()).pathname === '/api/stream');
    await page.locator('#url-input').fill(url);
    await page.locator('#url-input').press('Enter');
    const params = new URL((await request).url()).searchParams;
    await waitForResult(page);
    return params;
  }

  const pick = (page, name, mimeType, text = 'hello') =>
    page.locator('#html-file-input').setInputFiles({ name, mimeType, buffer: Buffer.from(text) });

  /** Mocks the async file flow; every POST /api/file URL lands in `uploads`. */
  function mockFileJob(uploads) {
    return async (context) => {
      await context.route('**/api/file?*', (route) => {
        uploads.push(new URL(route.request().url()));
        return json(route, { jobId: '1'.repeat(32) }, 202);
      });
      await context.route('**/api/file/jobs/*', (route) => (route.request().method() === 'DELETE'
        ? route.fulfill({ status: 204 })
        : json(route, { status: 'done', markdown: '# Paper\n', source: 'markitdown' })));
    };
  }

  /** Sets a select or number field the way a user does (change fires). */
  async function setField(page, id, value) {
    const el = page.locator(`#${id}`);
    if (await el.evaluate((e) => e.tagName) === 'SELECT') await el.selectOption(value);
    else { await el.fill(value); await el.press('Tab'); }
  }

  const panel = (page) => page.locator('#advanced-panel');
  // The `toggle` event (and with it the storage write) fires a tick after the click.
  const stored = (page, value) => page.waitForFunction(
    ([k, v]) => localStorage.getItem(k) === v, [OPEN_KEY, value],
  );
  const openPanel = (page) => page.locator('#advanced-panel > summary').click();

  describe('the shell', () => {
    it('is closed on the first visit and hides its controls', async (t) => {
      const { page } = await setup(t);
      await panel(page).waitFor();
      assert.equal(await panel(page).evaluate((el) => el.open), false);
      assert.equal(await page.locator('#depth-input').isVisible(), false);
      assert.equal(await page.locator('#advanced-panel > summary [data-i18n="adv.title"]').innerText(), 'Erweitert');
    });

    it('sits directly after the toggle bar and spans the card', async (t) => {
      const { page } = await setup(t);
      const after = await page.locator('.controls + #advanced-panel').count();
      assert.equal(after, 1);
      const [card, box] = await Promise.all([
        page.locator('.card').boundingBox(),
        panel(page).boundingBox(),
      ]);
      assert.ok(box.width > card.width * 0.8, `panel ${box.width} vs card ${card.width}`);
    });

    it('remembers being open across a reload', async (t) => {
      const { page } = await setup(t);
      await openPanel(page);
      await stored(page, 'true');
      await page.reload();
      await panel(page).waitFor();
      assert.equal(await panel(page).evaluate((el) => el.open), true);
      assert.equal(await page.locator('#depth-input').isVisible(), true);
    });

    it('remembers being closed again', async (t) => {
      const { page } = await setup(t);
      await openPanel(page);
      await stored(page, 'true');
      await openPanel(page);
      await stored(page, 'false');
      await page.reload();
      await panel(page).waitFor();
      assert.equal(await panel(page).evaluate((el) => el.open), false);
    });

    it('has four groups, all shown when the server offers everything', async (t) => {
      const { page } = await setup(t);
      await configApplied(page);
      for (const id of ['comments', 'youtube', 'docs', 'web']) {
        assert.equal(await page.locator(`#adv-group-${id}`).isVisible(), true, id);
      }
      assert.equal(await page.locator('#advanced-count').count(), 1);
      assert.equal(await page.locator('#advanced-actions').count(), 1);
      for (const id of ['comments', 'youtube', 'docs', 'web']) {
        assert.ok(await page.locator(`#adv-group-${id} .adv-group-title`).textContent());
      }
    });

    it('shows its texts in both languages', async (t) => {
      const { page } = await setup(t);
      await openPanel(page);
      assert.equal(await page.locator('#adv-group-comments .adv-group-title').textContent(), 'Reddit und Hacker News');
      assert.equal(await page.locator('#adv-group-docs .adv-group-title').textContent(), 'PDF und Dokumente');
      await page.locator('#lang-toggle').click();
      assert.equal(await page.locator('#advanced-panel > summary [data-i18n="adv.title"]').innerText(), 'Advanced');
      assert.equal(await page.locator('#adv-group-comments .adv-group-title').textContent(), 'Reddit and Hacker News');
      assert.equal(await page.locator('#adv-group-docs .adv-group-title').textContent(), 'PDFs and documents');
    });
  });

  describe('moved controls', () => {
    it('depth and "all" live in the comments group, store in the docs group', async (t) => {
      const { page } = await setup(t);
      await openPanel(page);
      assert.equal(await page.locator('#adv-group-comments #depth-input').count(), 1);
      assert.equal(await page.locator('#adv-group-comments #all-comments-toggle').count(), 1);
      assert.equal(await page.locator('#adv-group-docs #store-images-toggle').count(), 1);
      assert.equal(await page.locator('.controls #depth-input').count(), 0);
      assert.equal(await page.locator('.controls #store-images-toggle').count(), 0);
    });

    it('every moved control has a visible hint line instead of a title', async (t) => {
      const { page } = await setup(t);
      await openPanel(page);
      for (const id of ['depth-label', 'all-comments-label', 'store-images-label']) {
        assert.equal(await page.locator(`#${id}`).getAttribute('title'), null, id);
      }
      await configApplied(page);
      const hints = page.locator('#adv-group-comments .adv-hint');
      assert.equal(await hints.count(), 4);
      assert.equal(await hints.nth(0).innerText(), 'Wie viele Antwortebenen mitkommen.');
      assert.match(await hints.nth(1).innerText(), /^Alle Kommentare ohne Tiefengrenze\./);
      assert.equal(await page.locator('#adv-row-store .adv-hint').innerText(),
        'Ergebnis bekommt einen Share-Link und erscheint im Verlauf.');
    });

    it('switching comments off greys the rows out but keeps them in the panel', async (t) => {
      const { page } = await setup(t);
      await openPanel(page);
      assert.equal(await page.locator('#adv-group-comments .adv-row.adv-disabled').count(), 0);
      await page.locator('label', { hasText: 'Kommentare' }).click();
      // Depth, "All" and the limit; the images row stays usable.
      assert.equal(await page.locator('#adv-group-comments .adv-row.adv-disabled').count(), 3);
      assert.equal(await page.locator('#comment-limit-input').isDisabled(), true);
      assert.equal(await page.locator('#images-select').isDisabled(), false);
      assert.equal(await page.locator('#depth-input').isDisabled(), true);
      assert.equal(await page.locator('#all-comments-toggle').isDisabled(), true);
      assert.equal(await page.locator('#depth-input').isVisible(), true);

      await page.locator('label', { hasText: 'Kommentare' }).click();
      assert.equal(await page.locator('#adv-group-comments .adv-row.adv-disabled').count(), 0);
      assert.equal(await page.locator('#depth-input').isDisabled(), false);
      assert.equal(await page.locator('#all-comments-toggle').isDisabled(), false);
    });

    it('"all" disables only the depth field', async (t) => {
      const { page } = await setup(t);
      await openPanel(page);
      await page.locator('#all-comments-label').click();
      assert.equal(await page.locator('#depth-input').isDisabled(), true);
      assert.equal(await page.locator('#all-comments-toggle').isDisabled(), false);
    });
  });

  describe('the store toggle', () => {
    it('reads "Uploads speichern" / "Store uploads"', async (t) => {
      const { page } = await setup(t);
      await openPanel(page);
      const label = page.locator('#store-images-label');
      await label.waitFor();
      assert.equal(await label.innerText(), 'Uploads speichern');
      await page.locator('#lang-toggle').click();
      assert.equal(await label.innerText(), 'Store uploads');
    });

    it('reads the same without image hosting', async (t) => {
      const { page } = await setup(t, { config: { imageHosting: false } });
      await openPanel(page);
      const label = page.locator('#store-images-label');
      await label.waitFor();
      assert.equal(await label.innerText(), 'Uploads speichern');
    });

    it('is hidden, and so is its group, when the server does not store uploads', async (t) => {
      const { page } = await setup(t, { config: { uploadStore: false, pdfOcr: false } });
      await configApplied(page);
      assert.equal(await page.locator('#store-images-label').isVisible(), false);
      assert.equal(await page.locator('#adv-group-docs').isVisible(), false);
      assert.equal(await page.locator('#adv-group-comments').isVisible(), true);
    });
  });

  describe('parameters', () => {
    const PANEL_PARAMS = ['comment_depth', 'comment_limit', 'images', 'yt_timecodes', 'yt_chunk',
      'pdf_images', 'extractor', 'render', 'store', 'nocache'];

    it('defaults send none of the panel parameters', async (t) => {
      const { page } = await setup(t, { storage: { 'pullmd-pdf-ocr': 'true' } });
      await configApplied(page);
      const params = await pull(page);
      for (const p of PANEL_PARAMS) assert.equal(params.has(p), false, p);
      assert.equal(params.get('pdf'), 'ocr');
    });

    // One case per setting: [field, storage key, value, parameter].
    const cases = [
      ['comment-limit-input', 'pullmd-comment-limit', '25', 'comment_limit'],
      ['images-select', 'pullmd-images', 'on', 'images'],
      ['images-select', 'pullmd-images', 'off', 'images'],
      ['yt-timecodes-select', 'pullmd-yt-timecodes', 'plain', 'yt_timecodes'],
      ['yt-timecodes-select', 'pullmd-yt-timecodes', 'none', 'yt_timecodes'],
      ['yt-chunk-input', 'pullmd-yt-chunk', '0', 'yt_chunk'],
      ['yt-chunk-input', 'pullmd-yt-chunk', '60', 'yt_chunk'],
      ['extractor-select', 'pullmd-extractor', 'readability', 'extractor'],
      ['extractor-select', 'pullmd-extractor', 'trafilatura', 'extractor'],
      ['extractor-select', 'pullmd-extractor', 'playwright', 'extractor'],
      ['render-select', 'pullmd-render', 'force', 'render'],
      ['render-select', 'pullmd-render', 'skip', 'render'],
    ];
    for (const [id, key, value, param] of cases) {
      it(`${id} = ${value} sends ${param}=${value} and survives a reload`, async (t) => {
        const { page } = await setup(t);
        await configApplied(page, `#${id}`);
        assert.equal((await pull(page)).has(param), false, 'default is not sent');

        await setField(page, id, value);
        assert.equal((await pull(page)).get(param), value);
        assert.equal(await page.evaluate((k) => localStorage.getItem(k), key), value);

        await page.reload();
        await configApplied(page, `#${id}`);
        assert.equal(await page.locator(`#${id}`).inputValue(), value);
        assert.equal((await pull(page)).get(param), value);
      });
    }

    it('comments off sends neither depth nor limit, but still images', async (t) => {
      const { page } = await setup(t);
      await configApplied(page, '#images-select');
      await setField(page, 'depth-input', '5');
      await setField(page, 'comment-limit-input', '10');
      await setField(page, 'images-select', 'on');
      let params = await pull(page);
      assert.equal(params.get('comment_depth'), '5');
      assert.equal(params.get('comment_limit'), '10');

      await page.locator('label', { hasText: 'Kommentare' }).click();
      params = await pull(page);
      assert.equal(params.get('comments'), 'false');
      assert.equal(params.has('comment_depth'), false);
      assert.equal(params.has('comment_limit'), false);
      assert.equal(params.get('images'), 'on');
    });
  });

  describe('PDF figures', () => {
    it('are not sent while OCR is off, even when set', async (t) => {
      const { page } = await setup(t, { storage: { 'pullmd-pdf-figures': 'caption' } });
      await configApplied(page, '#pdf-figures-select');
      assert.equal(await page.locator('#pdf-figures-select').inputValue(), 'caption');
      assert.equal(await page.locator('#adv-row-figures.adv-disabled').count(), 1);
      assert.equal(await page.locator('#pdf-figures-select').isDisabled(), true);
      const params = await pull(page);
      assert.equal(params.has('pdf_images'), false);
      assert.equal(params.has('pdf'), false);
    });

    it('OCR on and "describe" sends pdf_images=caption', async (t) => {
      const { page } = await setup(t);
      await configApplied(page, '#pdf-figures-select');
      await page.locator('#ocr-label').click();
      assert.equal(await page.locator('#adv-row-figures.adv-disabled').count(), 0);
      await setField(page, 'pdf-figures-select', 'caption');
      const params = await pull(page);
      assert.equal(params.get('pdf'), 'ocr');
      assert.equal(params.get('pdf_images'), 'caption');
    });

    it('"include" without storing: a URL sends hosted, a PDF upload caption', async (t) => {
      const uploads = [];
      const { page } = await setup(t, { mock: mockFileJob(uploads) });
      await configApplied(page, '#pdf-figures-select');
      await page.locator('#ocr-label').click();
      await setField(page, 'pdf-figures-select', 'hosted');
      assert.equal((await pull(page)).get('pdf_images'), 'hosted');

      await pick(page, 'paper.pdf', 'application/pdf');
      await waitForResult(page);
      assert.equal(uploads.length, 1);
      assert.equal(uploads[0].searchParams.get('pdf'), 'ocr');
      assert.equal(uploads[0].searchParams.get('pdf_images'), 'caption');
      assert.equal(uploads[0].searchParams.has('store'), false);
    });

    it('"include" with storing on: a PDF upload sends hosted and store=true', async (t) => {
      const uploads = [];
      const { page } = await setup(t, { mock: mockFileJob(uploads) });
      await configApplied(page, '#pdf-figures-select');
      await page.locator('#ocr-label').click();
      await setField(page, 'pdf-figures-select', 'hosted');
      await page.locator('#store-images-label').click();
      await pick(page, 'paper.pdf', 'application/pdf');
      await waitForResult(page);
      assert.equal(uploads[0].searchParams.get('pdf_images'), 'hosted');
      assert.equal(uploads[0].searchParams.get('store'), 'true');
    });

    it('without image hosting "include" is not offered and a stored one goes out as caption', async (t) => {
      const { page } = await setup(t, {
        config: { imageHosting: false },
        storage: { 'pullmd-pdf-ocr': 'true', 'pullmd-pdf-figures': 'hosted' },
      });
      await configApplied(page, '#pdf-figures-select');
      const hosted = page.locator('#pdf-figures-select option[value="hosted"]');
      assert.equal(await hosted.evaluate((o) => o.hidden && o.disabled), true);
      assert.equal((await pull(page)).get('pdf_images'), 'caption');
      assert.equal(await page.evaluate(() => localStorage.getItem('pullmd-pdf-figures')), 'hosted');
    });
  });

  describe('HTML upload', () => {
    async function uploadHtml(t, extractor) {
      const sent = [];
      const { page } = await setup(t, {
        mock: (context) => context.route('**/api/html*', (route) => {
          sent.push(new URL(route.request().url()));
          return json(route, { markdown: '# Page\n', source: 'readability' });
        }),
      });
      await configApplied(page);
      await setField(page, 'extractor-select', extractor);
      await pick(page, 'page.html', 'text/html', '<html><body><p>Hi</p></body></html>');
      await waitForResult(page);
      assert.equal(sent.length, 1);
      return sent[0].searchParams;
    }

    it('sends extractor=trafilatura', async (t) => {
      assert.equal((await uploadHtml(t, 'trafilatura')).get('extractor'), 'trafilatura');
    });

    it('does not send extractor=playwright', async (t) => {
      assert.equal((await uploadHtml(t, 'playwright')).has('extractor'), false);
    });
  });

  describe('stored values the page cannot use', () => {
    it('invalid stored values show the default and are not sent', async (t) => {
      const { page } = await setup(t, {
        storage: {
          'pullmd-extractor': 'foo', 'pullmd-yt-chunk': '-5', 'pullmd-comment-limit': 'abc', 'pullmd-render': '1',
        },
      });
      await configApplied(page, '#render-select');
      assert.equal(await page.locator('#extractor-select').inputValue(), '');
      assert.equal(await page.locator('#yt-chunk-input').inputValue(), '');
      assert.equal(await page.locator('#comment-limit-input').inputValue(), '');
      assert.equal(await page.locator('#render-select').inputValue(), '');
      const params = await pull(page);
      for (const p of ['extractor', 'yt_chunk', 'comment_limit', 'render']) assert.equal(params.has(p), false, p);
    });

    it('a failing /api/config hides the capability groups and sends only what needs none', async (t) => {
      const { page } = await setup(t, {
        mock: (context) => context.route('**/api/config', (route) => json(route, { error: 'boom' }, 500)),
        storage: { 'pullmd-extractor': 'trafilatura', 'pullmd-comment-depth': '5' },
      });
      await openPanel(page);
      const params = await pull(page);
      assert.equal(params.has('extractor'), false);
      assert.equal(params.get('comment_depth'), '5');
      for (const id of ['youtube', 'web', 'docs']) {
        assert.equal(await page.locator(`#adv-group-${id}`).isVisible(), false, id);
      }
      assert.equal(await page.locator('#adv-group-comments').isVisible(), true);
    });

    it('without playwright: no browser option, no render row, stored values not sent', async (t) => {
      const { page } = await setup(t, {
        config: { playwright: false },
        storage: { 'pullmd-extractor': 'playwright', 'pullmd-render': 'force' },
      });
      await configApplied(page);
      const option = page.locator('#extractor-select option[value="playwright"]');
      assert.equal(await option.evaluate((o) => o.hidden && o.disabled), true);
      assert.equal(await page.locator('#render-select').isVisible(), false);
      assert.equal(await page.locator('#adv-row-render').isVisible(), false);
      const params = await pull(page);
      assert.equal(params.has('extractor'), false);
      assert.equal(params.has('render'), false);
      assert.equal(await page.evaluate(() => localStorage.getItem('pullmd-extractor')), 'playwright');
    });
  });

  describe('a shared link (#url=)', () => {
    it('is a real pull and takes the capability-bound settings along', async (t) => {
      let release;
      const held = new Promise((r) => { release = r; });
      const { page } = await setup(t, {
        storage: { 'pullmd-extractor': 'trafilatura', 'pullmd-render': 'force' },
        // A slow config answer: the shared link is handled before it arrives.
        mock: (context) => context.route('**/api/config', async (route) => {
          await held;
          return json(route, {
            authMode: 'disabled', markitdown: true, pdfOcr: true, imageHosting: true, uploadStore: true,
            trafilatura: true, playwright: true, embeddedImages: true, markitdownYoutube: true, vision: true,
          });
        }),
      });
      const request = page.waitForRequest((r) => new URL(r.url()).pathname === '/api/stream');
      await page.goto(app.baseUrl + '/#url=' + encodeURIComponent('https://example.test/shared'));
      await page.waitForTimeout(200);
      release();
      const params = new URL((await request).url()).searchParams;
      assert.equal(params.get('url'), 'https://example.test/shared');
      assert.equal(params.get('extractor'), 'trafilatura');
      assert.equal(params.get('render'), 'force');
    });
  });

  describe('reopening from the history', () => {
    it('sends depth but none of the cache-skipping settings', async (t) => {
      const item = { id: 3, url: 'https://example.test/old', title: 'Old page', source: 'readability',
        share_id: 'a'.repeat(32), client: 'pwa', created_at: '2026-11-23 10:00:00' };
      const { page } = await setup(t, {
        history: [item],
        storage: {
          'pullmd-extractor': 'trafilatura', 'pullmd-render': 'force', 'pullmd-yt-timecodes': 'plain',
          'pullmd-yt-chunk': '60', 'pullmd-comment-limit': '10', 'pullmd-images': 'on', 'pullmd-comment-depth': '5',
        },
      });
      await configApplied(page, '#render-select');
      const request = page.waitForRequest((r) => new URL(r.url()).pathname === '/api/stream');
      await page.locator('#history-list .h-row', { hasText: 'Old page' }).click();
      const params = new URL((await request).url()).searchParams;
      await waitForResult(page);
      assert.equal(params.get('url'), item.url);
      assert.equal(params.get('comment_depth'), '5');
      for (const p of ['extractor', 'render', 'yt_timecodes', 'yt_chunk', 'comment_limit', 'images']) {
        assert.equal(params.has(p), false, p);
      }
    });
  });

  describe('migration of the old store toggle', () => {
    it('a stored "store + images" becomes "include" figures', async (t) => {
      const { page } = await setup(t, { storage: { 'pullmd-store-images': 'true' } });
      await configApplied(page, '#pdf-figures-select');
      assert.equal(await page.evaluate(() => localStorage.getItem('pullmd-pdf-figures')), 'hosted');
      assert.equal(await page.locator('#pdf-figures-select').inputValue(), 'hosted');
    });

    it('switching storing on in the new panel does not turn figures to "include"', async (t) => {
      const { page } = await setup(t);
      await configApplied(page, '#pdf-figures-select');
      await page.locator('#store-images-label').click();
      await page.reload();
      await configApplied(page, '#pdf-figures-select');
      assert.equal(await page.locator('#store-images-toggle').isChecked(), true);
      assert.equal(await page.locator('#pdf-figures-select').inputValue(), 'strip');
      assert.notEqual(await page.evaluate(() => localStorage.getItem('pullmd-pdf-figures')), 'hosted');
    });

    it('without image hosting nothing is migrated and no figures are asked for', async (t) => {
      const uploads = [];
      const { page } = await setup(t, {
        config: { imageHosting: false },
        storage: { 'pullmd-store-images': 'true', 'pullmd-pdf-ocr': 'true' },
        mock: mockFileJob(uploads),
      });
      await configApplied(page, '#pdf-figures-select');
      assert.equal(await page.locator('#pdf-figures-select').inputValue(), 'strip');
      const params = await pull(page);
      assert.equal(params.get('pdf'), 'ocr');
      assert.equal(params.has('pdf_images'), false);
      await pick(page, 'paper.pdf', 'application/pdf');
      await waitForResult(page);
      assert.equal(uploads[0].searchParams.get('store'), 'true');
      assert.equal(uploads[0].searchParams.has('pdf_images'), false);
      assert.equal(await page.evaluate(() => localStorage.getItem('pullmd-pdf-figures')), null);
    });

    it('a failing config migrates nothing', async (t) => {
      const { page } = await setup(t, {
        mock: (context) => context.route('**/api/config', (route) => json(route, { error: 'boom' }, 500)),
        storage: { 'pullmd-store-images': 'true' },
      });
      await openPanel(page);
      await pull(page);
      assert.equal(await page.evaluate(() => localStorage.getItem('pullmd-pdf-figures')), null);
      assert.equal(await page.locator('#pdf-figures-select').inputValue(), 'strip');
    });

    it('an existing figures choice is kept', async (t) => {
      const { page } = await setup(t, { storage: { 'pullmd-store-images': 'true', 'pullmd-pdf-figures': 'strip' } });
      await configApplied(page, '#pdf-figures-select');
      assert.equal(await page.evaluate(() => localStorage.getItem('pullmd-pdf-figures')), 'strip');
      assert.equal(await page.locator('#pdf-figures-select').inputValue(), 'strip');
    });
  });

  describe('counter, reset and fresh fetch', () => {
    const count = (page) => page.locator('#advanced-count');
    const waitCount = (page, text) => page.waitForFunction(
      (want) => document.getElementById('advanced-count').textContent === want, text,
    );
    const ALL_KEYS = ['pullmd-comment-depth', 'pullmd-comments-all', 'pullmd-comment-limit', 'pullmd-images',
      'pullmd-yt-timecodes', 'pullmd-yt-chunk', 'pullmd-pdf-figures', 'pullmd-store-images',
      'pullmd-extractor', 'pullmd-render'];

    it('is empty and hidden while everything is at its default', async (t) => {
      const { page } = await setup(t);
      await configApplied(page);
      await openPanel(page);
      assert.equal(await count(page).textContent(), '');
      assert.equal(await count(page).isVisible(), false);
    });

    it('counts changed settings, also while the panel is closed', async (t) => {
      const { page } = await setup(t, {
        storage: { 'pullmd-comment-depth': '5', 'pullmd-extractor': 'trafilatura' },
      });
      await waitCount(page, '2 geändert');
      assert.equal(await panel(page).evaluate((el) => el.open), false);
      assert.equal(await count(page).isVisible(), true);
      await page.locator('#lang-toggle').click();
      assert.equal(await count(page).textContent(), '2 changed');
    });

    it('follows a change made in the panel and a reset to the default value', async (t) => {
      const { page } = await setup(t);
      await configApplied(page);
      await setField(page, 'depth-input', '5');
      await waitCount(page, '1 geändert');
      await setField(page, 'depth-input', '3');
      await waitCount(page, '');
    });

    it('does not count what comments off greys out', async (t) => {
      const { page } = await setup(t, {
        storage: { 'pullmd-comment-depth': '5', 'pullmd-extractor': 'trafilatura', 'pullmd-comments': 'false' },
      });
      await waitCount(page, '1 geändert');
      await page.locator('#comments-toggle').evaluate((el) => el.click());
      await waitCount(page, '2 geändert');
    });

    it('does not count what the server does not offer', async (t) => {
      const { page } = await setup(t, {
        config: { trafilatura: false, markitdownYoutube: false },
        storage: { 'pullmd-comment-depth': '5', 'pullmd-extractor': 'trafilatura', 'pullmd-yt-chunk': '30' },
      });
      await configApplied(page);
      await waitCount(page, '1 geändert');
    });

    it('is right after the store migration, which fires no change event', async (t) => {
      const { page } = await setup(t, {
        storage: { 'pullmd-store-images': 'true', 'pullmd-pdf-ocr': 'true' },
      });
      await waitCount(page, '2 geändert');
      assert.equal(await page.locator('#pdf-figures-select').inputValue(), 'hosted');
    });

    it('reset restores the defaults and removes the keys, the bar stays', async (t) => {
      const { page } = await setup(t, {
        storage: {
          'pullmd-comment-depth': '5', 'pullmd-comments-all': 'true', 'pullmd-comment-limit': '25',
          'pullmd-images': 'on', 'pullmd-yt-timecodes': 'plain', 'pullmd-yt-chunk': '60',
          'pullmd-pdf-figures': 'caption', 'pullmd-store-images': 'true',
          'pullmd-extractor': 'trafilatura', 'pullmd-render': 'force',
          'pullmd-comments': 'true', 'pullmd-frontmatter': 'false', 'pullmd-pdf-ocr': 'true',
        },
      });
      await openPanel(page);
      await waitCount(page, '9 geändert');
      const barState = () => page.evaluate(() => ({
        bar: ['pullmd-comments', 'pullmd-frontmatter', 'pullmd-pdf-ocr'].map((k) => localStorage.getItem(k)),
        open: localStorage.getItem('pullmd-advanced-open'),
      }));
      await page.waitForFunction(() => localStorage.getItem('pullmd-advanced-open') === 'true');
      const before = await barState();
      await page.locator('#advanced-reset-btn').click();
      await waitCount(page, '');
      const want = { 'depth-input': '3', 'comment-limit-input': '', 'images-select': '', 'yt-timecodes-select': '',
        'yt-chunk-input': '', 'pdf-figures-select': 'strip', 'extractor-select': '', 'render-select': '' };
      for (const [id, v] of Object.entries(want)) {
        assert.equal(await page.locator(`#${id}`).inputValue(), v, id);
      }
      assert.equal(await page.locator('#all-comments-toggle').isChecked(), false);
      assert.equal(await page.locator('#store-images-toggle').isChecked(), false);
      assert.equal(await page.locator('#depth-input').isDisabled(), false);
      const gone = await page.evaluate((keys) => keys.map((k) => localStorage.getItem(k)), ALL_KEYS);
      assert.deepEqual(gone, ALL_KEYS.map(() => null));
      assert.deepEqual(await barState(), before);
      assert.deepEqual(before.bar, ['true', 'false', 'true']);
      // Nothing comes back after a reload either.
      await page.reload();
      await configApplied(page);
      assert.equal(await count(page).textContent(), '');
    });

    it('fetch fresh needs a URL and sends nocache once per click, storing nothing', async (t) => {
      const { page } = await setup(t);
      await openPanel(page);
      const fresh = page.locator('#fresh-pull-btn');
      assert.equal(await fresh.isDisabled(), true);
      await page.locator('#url-input').fill('https://example.test/page');
      assert.equal(await fresh.isDisabled(), false);
      for (let i = 0; i < 2; i++) {
        const request = page.waitForRequest((r) => new URL(r.url()).pathname === '/api/stream');
        await fresh.click();
        assert.equal(new URL((await request).url()).searchParams.get('nocache'), 'true', `click ${i}`);
        await waitForResult(page);
      }
      const request = page.waitForRequest((r) => new URL(r.url()).pathname === '/api/stream');
      await page.locator('#go-btn').click();
      assert.equal(new URL((await request).url()).searchParams.has('nocache'), false);
      await waitForResult(page);
      const keys = await page.evaluate(() => Object.keys(localStorage).concat(Object.values(localStorage)));
      assert.equal(keys.some((k) => /nocache/i.test(k)), false);
      await page.locator('#url-input').fill('');
      assert.equal(await fresh.isDisabled(), true);
    });

    it('fetch fresh keeps the panel settings in the request', async (t) => {
      const { page } = await setup(t, { storage: { 'pullmd-extractor': 'readability' } });
      await configApplied(page);
      await page.locator('#url-input').fill('https://example.test/page');
      const request = page.waitForRequest((r) => new URL(r.url()).pathname === '/api/stream');
      await page.locator('#fresh-pull-btn').click();
      const params = new URL((await request).url()).searchParams;
      assert.equal(params.get('extractor'), 'readability');
      assert.equal(params.get('nocache'), 'true');
    });

    it('texts in both languages', async (t) => {
      const { page } = await setup(t);
      await openPanel(page);
      assert.equal(await page.locator('#advanced-reset-btn').innerText(), 'Zurücksetzen');
      assert.equal(await page.locator('#fresh-pull-btn').innerText(), 'Frisch abrufen');
      assert.equal(await page.locator('#fresh-pull-hint').innerText(), 'Ruft die Seite einmal am Cache vorbei neu ab.');
      await page.locator('#lang-toggle').click();
      assert.equal(await page.locator('#advanced-reset-btn').innerText(), 'Reset');
      assert.equal(await page.locator('#fresh-pull-btn').innerText(), 'Fetch fresh');
      assert.equal(await page.locator('#fresh-pull-hint').innerText(), 'Fetches the page once, skipping the cache.');
    });
  });

  describe('a config answer that does not come', () => {
    it('shows the loading state at once and pulls after a short wait', async (t) => {
      const { page } = await setup(t, {
        mock: (context) => context.route('**/api/config', () => {}),
      });
      const request = page.waitForRequest((r) => new URL(r.url()).pathname === '/api/stream');
      await page.locator('#url-input').fill('https://example.test/page');
      await page.locator('#url-input').press('Enter');
      await page.locator('#loading.visible').waitFor({ timeout: 1000 });
      const params = new URL((await request).url()).searchParams;
      assert.equal(params.get('url'), 'https://example.test/page');
      await waitForResult(page);
    });
  });

  describe('texts', () => {
    it('labels, hints and options in both languages', async (t) => {
      const { page } = await setup(t);
      await configApplied(page);
      assert.equal(await page.locator('#adv-row-limit .adv-hint').innerText(),
        'Höchstzahl der Kommentare auf oberster Ebene. Leer heißt ohne Grenze.');
      assert.equal(await page.locator('#extractor-select option[value=""]').textContent(), 'automatisch');
      assert.equal(await page.locator('#images-select option[value=""]').textContent(), 'Server-Standard');
      assert.equal(await page.locator('#adv-group-youtube .adv-group-hint').innerText(),
        'Abweichende Werte umgehen den Cache und dauern länger.');
      await page.locator('#lang-toggle').click();
      assert.equal(await page.locator('#adv-row-limit .adv-hint').innerText(),
        'Maximum number of top-level comments. Empty means no cap.');
      assert.equal(await page.locator('#extractor-select option[value=""]').textContent(), 'Automatic');
      assert.equal(await page.locator('#adv-group-youtube .adv-group-hint').innerText(),
        'Non-default values skip the cache and take longer.');
      assert.equal(await page.locator('#pdf-figures-select option[value="hosted"]').textContent(), 'Include');
    });
  });
});
