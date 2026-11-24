// The collapsible "Erweitert" panel under the toggle bar: shell, persistence
// of open/closed, and the three controls that moved into it. The config
// answer is mocked: these tests are about the page, not the server.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp } from './helpers/app.js';
import { launchBrowser, openPage } from './helpers/browser.js';

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

  async function setup(t, { config = {}, mock, history = [] } = {}) {
    const { context, page } = await openPage(browser, app.baseUrl, { goto: false });
    t.after(() => context.close());
    const seen = [];
    page.on('request', (r) => seen.push(r.url()));
    await context.route('**/api/config', (route) => json(route, {
      authMode: 'disabled', markitdown: true, pdfOcr: true, imageHosting: true, uploadStore: true,
      trafilatura: true, playwright: true, embeddedImages: true, markitdownYoutube: true, vision: true, ...config,
    }));
    await context.route('**/api/history*', (route) => json(route, history));
    if (mock) await mock(context);
    await page.goto(app.baseUrl + '/');
    return { page, seen };
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

    it('has four groups, two of them empty and hidden for now', async (t) => {
      const { page } = await setup(t);
      await openPanel(page);
      assert.equal(await page.locator('#adv-group-comments').isVisible(), true);
      assert.equal(await page.locator('#adv-group-docs').isVisible(), true);
      assert.equal(await page.locator('#adv-group-youtube').isVisible(), false);
      assert.equal(await page.locator('#adv-group-web').isVisible(), false);
      assert.equal(await page.locator('#advanced-count').count(), 1);
      assert.equal(await page.locator('#advanced-actions').count(), 1);
      for (const id of ['comments', 'docs']) {
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
      const hints = page.locator('#adv-group-comments .adv-hint');
      assert.equal(await hints.count(), 2);
      assert.equal(await hints.nth(0).innerText(), 'Wie viele Antwortebenen mitkommen.');
      assert.match(await hints.nth(1).innerText(), /^Alle Kommentare ohne Tiefengrenze\./);
      assert.equal(await page.locator('#adv-group-docs .adv-hint').innerText(),
        'Ergebnis bekommt einen Share-Link und erscheint im Verlauf.');
    });

    it('switching comments off greys the rows out but keeps them in the panel', async (t) => {
      const { page } = await setup(t);
      await openPanel(page);
      assert.equal(await page.locator('#adv-group-comments .adv-row.adv-disabled').count(), 0);
      await page.locator('label', { hasText: 'Kommentare' }).click();
      assert.equal(await page.locator('#adv-group-comments .adv-row.adv-disabled').count(), 2);
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
      const { page } = await setup(t, { config: { uploadStore: false } });
      await openPanel(page);
      await page.locator('#ocr-toggle').waitFor({ state: 'attached' });
      await page.waitForTimeout(300);
      assert.equal(await page.locator('#store-images-label').isVisible(), false);
      assert.equal(await page.locator('#adv-group-docs').isVisible(), false);
      assert.equal(await page.locator('#adv-group-comments').isVisible(), true);
    });
  });
});
