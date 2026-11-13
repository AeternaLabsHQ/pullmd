// Converting a URL: the main flow of the PWA (index.html fetchPost()).
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, deferred, webResult, WEB_URL, REDDIT_URL } from './helpers/app.js';
import { launchBrowser, openPage, convert, waitForResult, waitForError } from './helpers/browser.js';

describe('converting a URL', () => {
  let browser;
  before(async () => { browser = await launchBrowser(); });
  after(async () => { await browser?.close(); });

  it('shows the markdown, the source badge and ends the loading state', async (t) => {
    const gate = deferred();
    const app = await startApp({ extractWeb: async (url) => { await gate.promise; return webResult(url); } });
    t.after(() => app.close());
    const { context, page } = await openPage(browser, app.baseUrl);
    t.after(() => context.close());

    await convert(page, WEB_URL);
    // While the extractor is busy: spinner shown, button disabled.
    await page.locator('#loading.visible').waitFor();
    assert.equal(await page.locator('#go-btn').isDisabled(), true);

    gate.resolve();
    const text = await waitForResult(page);
    assert.match(text, /^# Example Article$/m);
    assert.match(text, /First paragraph of the article\./);
    assert.equal(await page.locator('#loading').isVisible(), false);
    assert.equal(await page.locator('#go-btn').isDisabled(), false);
    assert.equal(await page.locator('#source-badge').textContent(), 'readability');
    assert.equal(app.calls.web.length, 1);
    assert.equal(app.calls.web[0][0], WEB_URL);
  });

  it('the Pull button submits like Enter does', async (t) => {
    const app = await startApp();
    t.after(() => app.close());
    const { context, page } = await openPage(browser, app.baseUrl);
    t.after(() => context.close());

    await page.locator('#url-input').fill(WEB_URL);
    await page.getByRole('button', { name: /Pull/ }).click();
    assert.match(await waitForResult(page), /^# Example Article$/m);
  });

  it('an empty input converts nothing', async (t) => {
    const app = await startApp();
    t.after(() => app.close());
    const { context, page } = await openPage(browser, app.baseUrl);
    t.after(() => context.close());

    await page.locator('#url-input').press('Enter');
    await page.waitForTimeout(300);
    assert.equal(await page.locator('#loading').isVisible(), false);
    assert.equal(app.calls.web.length, 0);
    assert.equal(await page.evaluate(() => document.activeElement.id), 'url-input');
  });

  it('an extractor failure shows the error and ends the loading state', async (t) => {
    t.mock.method(console, 'error', () => {});
    const app = await startApp({ extractWeb: async () => { throw new Error('Upstream returned 503'); } });
    t.after(() => app.close());
    const { context, page } = await openPage(browser, app.baseUrl);
    t.after(() => context.close());

    await convert(page, WEB_URL);
    assert.match(await waitForError(page), /Upstream returned 503/);
    assert.equal(await page.locator('#loading').isVisible(), false);
    assert.equal(await page.locator('#result-container').isVisible(), false);
    assert.equal(await page.locator('#go-btn').isDisabled(), false);
  });

  it('a later success clears an earlier error', async (t) => {
    t.mock.method(console, 'error', () => {});
    let fail = true;
    const app = await startApp({ extractWeb: async (url) => { if (fail) throw new Error('first try fails'); return webResult(url); } });
    t.after(() => app.close());
    const { context, page } = await openPage(browser, app.baseUrl);
    t.after(() => context.close());

    await convert(page, WEB_URL);
    await waitForError(page);
    fail = false;
    await convert(page, WEB_URL);
    await waitForResult(page);
    assert.equal(await page.locator('#error').isVisible(), false);
  });

  describe('without EventSource (plain /api fallback)', () => {
    async function openWithoutEventSource(app) {
      const opened = await openPage(browser, app.baseUrl, { goto: false });
      await opened.context.addInitScript(() => { delete window.EventSource; });
      await opened.page.goto(app.baseUrl + '/');
      return opened;
    }

    it('converts through GET /api', async (t) => {
      const app = await startApp();
      t.after(() => app.close());
      const { context, page } = await openWithoutEventSource(app);
      t.after(() => context.close());

      const request = page.waitForRequest((r) => new URL(r.url()).pathname === '/api');
      await convert(page, WEB_URL);
      const sent = new URL((await request).url());
      assert.equal(sent.searchParams.get('url'), WEB_URL);
      assert.match(await waitForResult(page), /^# Example Article$/m);
    });

    it('shows the error message from the JSON error body', async (t) => {
      const app = await startApp({ extractPost: async () => { throw new Error('Rate limited by Reddit'); } });
      t.after(() => app.close());
      const { context, page } = await openWithoutEventSource(app);
      t.after(() => context.close());

      await convert(page, REDDIT_URL);
      assert.equal(await waitForError(page), 'Reddit rate limit. Try again later.');
      assert.equal(await page.locator('#loading').isVisible(), false);
    });
  });
});
