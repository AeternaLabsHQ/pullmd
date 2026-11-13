// "Letzte Abrufe" list, the archive view, and the DISABLE_PUBLIC_HISTORY
// switch. The list loads on page load (and on language switch / leaving the
// archive), not after each conversion, so the tests reload to see it.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, WEB_URL } from './helpers/app.js';
import { launchBrowser, openPage, convert, waitForResult } from './helpers/browser.js';

describe('history', () => {
  let browser;
  before(async () => { browser = await launchBrowser(); });
  after(async () => { await browser?.close(); });

  async function setup(t, appOpts, pageOpts) {
    const app = await startApp(appOpts);
    t.after(() => app.close());
    const { context, page } = await openPage(browser, app.baseUrl, pageOpts);
    t.after(() => context.close());
    return { app, page };
  }

  it('stays hidden while nothing was converted', async (t) => {
    const { app, page } = await setup(t, undefined, { goto: false });
    // Listen before loading: the local answer can beat a later listener.
    const history = page.waitForResponse((r) => r.url().includes('/api/history'));
    await page.goto(app.baseUrl + '/');
    await history;
    assert.equal(await page.locator('#history-section').isVisible(), false);
  });

  it('lists a conversion after a reload, and clicking it shows it again', async (t) => {
    const { app, page } = await setup(t);
    await convert(page, WEB_URL);
    await waitForResult(page);

    await page.reload();
    const row = page.locator('#history-list .h-row', { hasText: 'Example Article' });
    await row.waitFor();
    assert.match(await row.innerText(), /example\.test/);
    assert.equal(await page.locator('#result-container').isVisible(), false);

    await row.click();
    assert.match(await waitForResult(page), /^# Example Article$/m);
    assert.equal(await page.locator('#url-input').inputValue(), WEB_URL);
    assert.equal(app.calls.web.length, 1, 'the second view came from the cache');
  });

  it('the delete button removes the entry from the list and the server', async (t) => {
    const { app, page } = await setup(t);
    await convert(page, WEB_URL);
    await waitForResult(page);
    await page.reload();
    const row = page.locator('#history-list .h-row', { hasText: 'Example Article' });
    await row.waitFor();

    const deleted = page.waitForResponse((r) => r.request().method() === 'DELETE' && r.url().includes('/api/cache/'));
    // No auth configured: every delete is global, and the title says so.
    await row.getByTitle('Global löschen').click();
    assert.equal((await deleted).status(), 200);
    await row.waitFor({ state: 'detached' });
    assert.equal(app.cache.historyPage().total, 0);
    assert.equal(await page.locator('#result-container').isVisible(), false, 'deleting does not open the entry');
  });

  it('the archive lists entries and "Alles löschen" empties it after confirmation', async (t) => {
    const { app, page } = await setup(t);
    await convert(page, WEB_URL);
    await waitForResult(page);
    await page.reload();
    await page.getByRole('link', { name: 'Archiv →' }).click();

    await page.locator('#archive-list .archive-item', { hasText: 'Example Article' }).waitFor();
    assert.equal(await page.locator('#archive-count').innerText(), '1 Einträge');
    assert.equal(await page.locator('.card').isVisible(), false, 'the archive replaces the main view');

    let dismissed = '';
    page.once('dialog', (d) => { dismissed = d.message(); d.dismiss(); });
    await page.getByRole('button', { name: 'Alles löschen' }).click();
    assert.match(dismissed, /global löschen/);
    assert.equal(app.cache.historyPage().total, 1, 'cancelling the dialog deletes nothing');

    page.once('dialog', (d) => d.accept());
    await page.getByRole('button', { name: 'Alles löschen' }).click();
    await page.locator('#archive-list .archive-item').waitFor({ state: 'detached' });
    assert.equal(await page.locator('#archive-count').innerText(), '0 Einträge');
    assert.equal(app.cache.historyPage().total, 0);

    await page.getByRole('link', { name: '← Zurück' }).click();
    await page.locator('.card').waitFor();
  });

  it('with public history disabled, no list and no history request', async (t) => {
    const { page } = await setup(t, { disablePublicHistory: true });
    const historyCalls = [];
    page.on('request', (r) => { if (/\/api\/(history|archive)/.test(r.url())) historyCalls.push(r.url()); });

    await convert(page, WEB_URL);
    await waitForResult(page);
    await page.reload();
    await page.locator('#status-meta[data-status="online"]').waitFor();
    // The link sits in the hidden section; a click must still not open the archive.
    await page.locator('#archive-link').dispatchEvent('click');
    await page.waitForTimeout(300);

    assert.equal(await page.locator('#history-section').isVisible(), false);
    assert.equal(await page.locator('#archive-view').isVisible(), false);
    assert.deepEqual(historyCalls, []);
  });
});
