// Language (DE/EN) and theme (dark/paper): defaults from the browser, the
// toggles, and persistence across reloads.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp } from './helpers/app.js';
import { launchBrowser, openPage } from './helpers/browser.js';

describe('language and theme', () => {
  let browser;
  let app;
  before(async () => {
    browser = await launchBrowser();
    app = await startApp();
  });
  after(async () => { await app?.close(); await browser?.close(); });

  async function open(t, opts) {
    const { context, page } = await openPage(browser, app.baseUrl, opts);
    t.after(() => context.close());
    return page;
  }
  const heading = (page) => page.getByRole('heading', { level: 1 });
  const lang = (page) => page.evaluate(() => document.body.dataset.lang);
  const theme = (page) => page.evaluate(() => document.body.dataset.theme);

  it('follows the browser language when nothing is stored', async (t) => {
    const de = await open(t, { locale: 'de-DE' });
    assert.equal(await lang(de), 'de');
    assert.equal(await heading(de).innerText(), 'Alles rein, Markdown raus.');
    const en = await open(t, { locale: 'en-US' });
    assert.equal(await lang(en), 'en');
    assert.equal(await heading(en).innerText(), 'Anything in, Markdown out.');
  });

  it('the language toggle switches the UI and the choice survives a reload', async (t) => {
    const page = await open(t, { locale: 'de-DE' });
    const toggle = page.getByRole('button', { name: 'Sprache wechseln' });
    assert.equal(await toggle.innerText(), 'EN', 'the toggle names the target language');

    await toggle.click();
    await page.waitForFunction(() => document.documentElement.lang === 'en');
    assert.equal(await heading(page).innerText(), 'Anything in, Markdown out.');
    assert.equal(await page.getByRole('button', { name: 'Toggle language' }).innerText(), 'DE');
    assert.equal(await page.locator('label', { hasText: 'Comments' }).count(), 1);

    await page.reload();
    assert.equal(await lang(page), 'en');
    assert.equal(await heading(page).innerText(), 'Anything in, Markdown out.');
  });

  it('follows the colour scheme when no theme is stored', async (t) => {
    assert.equal(await theme(await open(t, { colorScheme: 'dark' })), 'dark');
    assert.equal(await theme(await open(t, { colorScheme: 'light' })), 'paper');
  });

  it('the theme toggle switches dark/paper and the choice survives a reload', async (t) => {
    const page = await open(t, { colorScheme: 'dark' });
    const themeColor = () => page.locator('meta[name="theme-color"]').getAttribute('content');
    assert.equal(await themeColor(), '#0e1016');

    await page.getByRole('button', { name: 'Theme wechseln' }).click();
    assert.equal(await theme(page), 'paper');
    assert.equal(await themeColor(), '#f6f3ee');

    await page.reload();
    assert.equal(await theme(page), 'paper', 'a stored choice beats the dark colour scheme');
    assert.equal(await themeColor(), '#f6f3ee');

    await page.getByRole('button', { name: 'Theme wechseln' }).click();
    assert.equal(await theme(page), 'dark');
  });
});
