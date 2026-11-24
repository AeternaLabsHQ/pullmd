// "Store uploads" toggle, hosted OCR figures and stored uploads in the PWA.
// The API answers are mocked with page.route: these tests are about what the
// page sends, shows and refuses to load, not about the server.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp } from './helpers/app.js';
import { launchBrowser, openPage, waitForResult } from './helpers/browser.js';

const PIXEL = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');
const HEX = '0123456789abcdef0123456789abcdef';
const SHARE_ID = 'f'.repeat(32);
const KEY = 'pullmd-store-images';

const json = (route, body, status = 200) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

describe('store uploads', () => {
  let browser;
  let app;
  before(async () => {
    browser = await launchBrowser();
    app = await startApp();
  });
  after(async () => { await app?.close(); await browser?.close(); });

  /**
   * Opens the app with /api/config mocked. Extra routes go in through
   * `mock(context)`; `seen` collects the URL of every request the page makes.
   */
  async function setup(t, { config = {}, mock, history = [] } = {}) {
    const { context, page } = await openPage(browser, app.baseUrl, { goto: false });
    t.after(() => context.close());
    const seen = [];
    page.on('request', (r) => seen.push(r.url()));
    await context.route('**/api/config', (route) => json(route, {
      authMode: 'disabled', markitdown: true, pdfOcr: true, imageHosting: true, uploadStore: true, ...config,
    }));
    await context.route('**/api/history*', (route) => json(route, history));
    if (mock) await mock(context);
    await page.goto(app.baseUrl + '/');
    // The toggle lives in the collapsed advanced panel.
    await page.locator('#advanced-panel > summary').click();
    return { page, seen };
  }

  const pick = (page, name, mimeType, text = 'hello') =>
    page.locator('#html-file-input').setInputFiles({ name, mimeType, buffer: Buffer.from(text) });

  /** Mocks the async file flow; every POST /api/file URL lands in `uploads`. */
  function mockFileJob(uploads, result) {
    return async (context) => {
      await context.route('**/api/file?*', (route) => {
        uploads.push(new URL(route.request().url()));
        return json(route, { jobId: '1'.repeat(32) }, 202);
      });
      await context.route('**/api/file/jobs/*', (route) => (route.request().method() === 'DELETE'
        ? route.fulfill({ status: 204 })
        : json(route, { status: 'done', ...result })));
    };
  }

  describe('the toggle', () => {
    it('is hidden when the server does not store uploads', async (t) => {
      const { page } = await setup(t, { config: { uploadStore: false } });
      // The same config answer shows the figures row: it has been applied.
      await page.locator('#pdf-figures-select').waitFor({ state: 'visible' });
      assert.equal(await page.locator('#store-images-label').isVisible(), false);
    });

    it('reads "Uploads speichern" with the hint underneath', async (t) => {
      const { page } = await setup(t);
      const label = page.locator('#store-images-label');
      await label.waitFor();
      assert.equal(await label.innerText(), 'Uploads speichern');
      assert.equal(await label.getAttribute('title'), null);
      const hint = page.locator('#adv-row-store .adv-hint');
      assert.equal(await hint.innerText(), 'Ergebnis bekommt einen Share-Link und erscheint im Verlauf.');

      await page.locator('#lang-toggle').click();
      assert.equal(await label.innerText(), 'Store uploads');
      assert.equal(await hint.innerText(), 'The result gets a share link and shows up in the history.');
    });

    it('reads the same when hosting is off', async (t) => {
      const { page } = await setup(t, { config: { imageHosting: false } });
      const label = page.locator('#store-images-label');
      await label.waitFor();
      assert.equal(await label.innerText(), 'Uploads speichern');
      assert.equal(await page.locator('#adv-row-store .adv-hint').innerText(),
        'Ergebnis bekommt einen Share-Link und erscheint im Verlauf.');
    });

    it('remembers its state', async (t) => {
      const { page } = await setup(t);
      await page.locator('#store-images-label').waitFor();
      await page.locator('#store-images-label').click();
      assert.equal(await page.evaluate((k) => localStorage.getItem(k), KEY), 'true');
      await page.reload();
      await page.locator('#store-images-label').waitFor();
      assert.equal(await page.locator('#store-images-toggle').isChecked(), true);
    });
  });

  describe('what is sent', () => {
    it('a PDF upload with OCR, "include" figures and the toggle on asks for store=true and hosted figures', async (t) => {
      const uploads = [];
      const { page } = await setup(t, { mock: mockFileJob(uploads, { markdown: '# Paper\n\nBody\n', source: 'markitdown', shareId: SHARE_ID }) });
      await page.locator('#store-images-label').waitFor();
      await page.locator('#ocr-label').click();
      await page.locator('#pdf-figures-select').selectOption('hosted');
      await page.locator('#store-images-label').click();

      await pick(page, 'paper.pdf', 'application/pdf');
      await waitForResult(page);
      assert.equal(uploads.length, 1);
      assert.equal(uploads[0].searchParams.get('pdf'), 'ocr');
      assert.equal(uploads[0].searchParams.get('store'), 'true');
      assert.equal(uploads[0].searchParams.get('pdf_images'), 'hosted');
      assert.equal(uploads[0].searchParams.get('async'), '1');
    });

    it('the share bar shows the link of a stored result', async (t) => {
      const uploads = [];
      const { page } = await setup(t, {
        mock: mockFileJob(uploads, { markdown: '# Paper\n\nBody\n', source: 'markitdown', shareId: SHARE_ID }),
      });
      await page.locator('#store-images-label').click();
      await pick(page, 'paper.pdf', 'application/pdf');
      await waitForResult(page);
      assert.equal(await page.locator('#permalink-bar').isVisible(), true);
      assert.equal(await page.locator('#permalink-url').innerText(), `${app.baseUrl}/s/${SHARE_ID}`);
      assert.equal(uploads.length, 1);
      assert.equal(uploads[0].searchParams.get('store'), 'true');
    });

    it('a result without a share id shows no share bar', async (t) => {
      const { page } = await setup(t, { mock: mockFileJob([], { markdown: '# Paper\n\nBody\n', source: 'markitdown' }) });
      await pick(page, 'paper.pdf', 'application/pdf');
      await waitForResult(page);
      assert.equal(await page.locator('#permalink-bar').isVisible(), false);
    });

    it('a stored non-PDF upload sends store=true but no pdf_images', async (t) => {
      const uploads = [];
      const { page } = await setup(t, { mock: mockFileJob(uploads, { markdown: '# Notes\n', source: 'local', shareId: SHARE_ID }) });
      await page.locator('#ocr-label').click();
      await page.locator('#store-images-label').click();
      await pick(page, 'notes.txt', 'text/plain');
      await waitForResult(page);
      assert.equal(uploads[0].searchParams.get('store'), 'true');
      assert.equal(uploads[0].searchParams.get('pdf_images'), null);
      assert.equal(uploads[0].searchParams.get('pdf'), null);
    });

    it('a PDF upload with the toggle on but OCR off sends store=true only', async (t) => {
      const uploads = [];
      const { page } = await setup(t, { mock: mockFileJob(uploads, { markdown: '# Paper\n', source: 'markitdown', shareId: SHARE_ID }) });
      await page.locator('#store-images-label').click();
      await pick(page, 'paper.pdf', 'application/pdf');
      await waitForResult(page);
      assert.equal(uploads[0].searchParams.get('store'), 'true');
      assert.equal(uploads[0].searchParams.get('pdf_images'), null);
    });

    it('with the toggle off and default figures neither parameter is sent; without hosting "include" goes out as caption', async (t) => {
      const uploads = [];
      const { page } = await setup(t, { mock: mockFileJob(uploads, { markdown: '# Paper\n', source: 'markitdown' }) });
      await page.locator('#ocr-label').click();
      await pick(page, 'paper.pdf', 'application/pdf');
      await waitForResult(page);
      assert.equal(uploads[0].searchParams.get('store'), null);
      assert.equal(uploads[0].searchParams.get('pdf_images'), null);

      const uploads2 = [];
      const second = await setup(t, {
        config: { imageHosting: false },
        mock: mockFileJob(uploads2, { markdown: '# Paper\n', source: 'markitdown', shareId: SHARE_ID }),
      });
      // A stored "include" from a hosting server goes out as "describe" here.
      await second.page.evaluate(() => localStorage.setItem('pullmd-pdf-figures', 'hosted'));
      await second.page.reload();
      await second.page.locator('#pdf-figures-select').waitFor({ state: 'visible' });
      await second.page.locator('#ocr-label').click();
      await second.page.locator('#store-images-label').click();
      await pick(second.page, 'paper.pdf', 'application/pdf');
      await waitForResult(second.page);
      assert.equal(uploads2[0].searchParams.get('store'), 'true');
      assert.equal(uploads2[0].searchParams.get('pdf_images'), 'caption');
    });

    it('a stored toggle state is ignored when the server does not store uploads', async (t) => {
      const uploads = [];
      const { page } = await setup(t, {
        config: { uploadStore: false },
        mock: mockFileJob(uploads, { markdown: '# Paper\n', source: 'markitdown' }),
      });
      await page.evaluate((k) => localStorage.setItem(k, 'true'), KEY);
      await page.reload();
      await pick(page, 'paper.pdf', 'application/pdf');
      await waitForResult(page);
      assert.equal(uploads[0].searchParams.get('store'), null);
    });

    it('a URL conversion with OCR and "include" figures asks for hosted figures, without the store toggle', async (t) => {
      const { page, seen } = await setup(t, {
        mock: async (context) => {
          await context.route('**/api/stream*', (route) => route.abort());
          await context.route(/\/api\?/, (route) => route.fulfill({
            status: 200, contentType: 'text/markdown', headers: { 'X-Source': 'markitdown' }, body: '# Doc\n\nBody\n',
          }));
        },
      });
      await page.locator('#ocr-label').click();
      await page.locator('#pdf-figures-select').selectOption('hosted');
      await page.locator('#url-input').fill('https://example.test/paper.pdf');
      await page.locator('#url-input').press('Enter');
      await waitForResult(page);
      const api = seen.map((u) => new URL(u)).filter((u) => u.pathname === '/api' || u.pathname === '/api/stream');
      assert.ok(api.length > 0);
      for (const u of api) {
        assert.equal(u.searchParams.get('pdf'), 'ocr');
        assert.equal(u.searchParams.get('pdf_images'), 'hosted');
      }
    });

    it('a URL conversion with default figures does not ask for hosted figures', async (t) => {
      const { page, seen } = await setup(t, {
        mock: async (context) => {
          await context.route('**/api/stream*', (route) => route.abort());
          await context.route(/\/api\?/, (route) => route.fulfill({ status: 200, contentType: 'text/markdown', body: '# Doc\n\nBody\n' }));
        },
      });
      await page.locator('#ocr-label').click();
      await page.locator('#url-input').fill('https://example.test/paper.pdf');
      await page.locator('#url-input').press('Enter');
      await waitForResult(page);
      const api = seen.map((u) => new URL(u)).filter((u) => u.pathname === '/api' || u.pathname === '/api/stream');
      assert.ok(api.length > 0);
      for (const u of api) assert.equal(u.searchParams.get('pdf_images'), null);
    });
  });

  describe('hosted figures in an uploaded document', () => {
    it('only a same-origin /img/<32 hex>.<ext> loads without a click', async (t) => {
      const origin = app.baseUrl;
      const hosted = `${origin}/img/${HEX}.jpeg`;
      const markdown = [
        '# Paper', '',
        `![a](${hosted})`,
        '![b](https://example.com/x.png)',
        `![c](${hosted}?x=1)`,
        `![d](${origin}/api?url=http://x)`,
        '',
      ].join('\n');
      const { page, seen } = await setup(t, {
        mock: async (context) => {
          await mockFileJob([], { markdown, source: 'markitdown', shareId: SHARE_ID })(context);
          await context.route(`**/img/${HEX}.jpeg`, (route) => route.fulfill({ status: 200, contentType: 'image/png', body: PIXEL }));
        },
      });
      await pick(page, 'paper.pdf', 'application/pdf');
      await waitForResult(page);

      // Raw view: the first is an image, the other three stay text.
      const rawImgs = page.locator('#result img');
      assert.equal(await rawImgs.count(), 1);
      assert.equal(await rawImgs.first().getAttribute('src'), hosted);
      const rawText = await page.locator('#result').innerText();
      assert.ok(rawText.includes('![b](https://example.com/x.png)'));
      assert.ok(rawText.includes(`![c](${hosted}?x=1)`));
      assert.ok(rawText.includes(`![d](${origin}/api?url=http://x)`));
      assert.equal(await page.locator('#remote-images-bar').isVisible(), true);

      // Rendered view: one image, three placeholders.
      await page.locator('#view-toggle button[data-mode="rendered"]').click();
      assert.equal(await page.locator('#result-rendered img').count(), 1);
      assert.equal(await page.locator('#result-rendered img').first().getAttribute('src'), hosted);
      assert.equal(await page.locator('#result-rendered .blocked-image').count(), 3);

      await page.waitForTimeout(500);
      const requested = seen.filter((u) => u.startsWith(origin + '/img/') || u.includes('example.com') || u.includes('/api?url='));
      assert.deepEqual(requested.filter((u) => u !== hosted), [], 'nothing but the hosted figure was requested');
      assert.ok(requested.includes(hosted), 'the hosted figure was requested');
    });

    it('a document of only hosted figures shows no hold-back bar', async (t) => {
      const markdown = `# Paper\n\n![a](${app.baseUrl}/img/${HEX}.png)\n`;
      const { page } = await setup(t, {
        mock: async (context) => {
          await mockFileJob([], { markdown, source: 'markitdown', shareId: SHARE_ID })(context);
          await context.route(`**/img/${HEX}.png`, (route) => route.fulfill({ status: 200, contentType: 'image/png', body: PIXEL }));
        },
      });
      await pick(page, 'paper.pdf', 'application/pdf');
      await waitForResult(page);
      assert.equal(await page.locator('#remote-images-bar').isVisible(), false);
      await page.locator('#view-toggle button[data-mode="rendered"]').click();
      assert.equal(await page.locator('#result-rendered img').count(), 1);
    });
  });

  describe('stored uploads in the history', () => {
    const stored = { id: 7, url: null, title: 'report.pdf', source: 'markitdown', share_id: SHARE_ID, client: 'pwa', created_at: '2026-11-23 10:00:00' };

    async function mockShare(context) {
      await context.route(`**/s/${SHARE_ID}`, (route) => route.fulfill({
        status: 200, contentType: 'text/markdown; charset=utf-8', body: '# Stored report\n\nFrom the store.\n',
      }));
    }

    it('a row without a URL shows its title and opens the stored result', async (t) => {
      const { page, seen } = await setup(t, { history: [stored], mock: mockShare });
      const row = page.locator('#history-list .h-row', { hasText: 'report.pdf' });
      await row.waitFor();
      assert.equal(await row.locator('.h-title').innerText(), 'report.pdf');
      assert.doesNotMatch(await row.innerText(), /null/);

      await row.click();
      assert.match(await waitForResult(page), /^# Stored report$/m);
      assert.equal(await page.locator('#permalink-url').innerText(), `${app.baseUrl}/s/${SHARE_ID}`);
      assert.equal(seen.filter((u) => new URL(u).pathname === '/api').length, 0, 'no conversion was started');
    });

    it('a row in the archive opens the stored result too', async (t) => {
      const { page, seen } = await setup(t, {
        history: [stored],
        mock: async (context) => {
          await mockShare(context);
          await context.route('**/api/archive*', (route) => json(route, { items: [stored], total: 1 }));
        },
      });
      await page.locator('#history-list .h-row').waitFor();
      await page.locator('#archive-link').click();
      const item = page.locator('#archive-list .archive-item', { hasText: 'report.pdf' });
      await item.waitFor();
      assert.doesNotMatch(await item.innerText(), /null/);

      await item.locator('.archive-item-content').click();
      assert.match(await waitForResult(page), /^# Stored report$/m);
      assert.equal(seen.filter((u) => new URL(u).pathname === '/api').length, 0);
    });
  });
});
