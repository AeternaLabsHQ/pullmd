// Share links (/s/:id) shown after a conversion, and the PWA share target
// (/share?link=... redirects to /#url=..., which index.html converts).
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, WEB_URL } from './helpers/app.js';
import { launchBrowser, openPage, convert, waitForResult } from './helpers/browser.js';

describe('share links and share target', () => {
  let browser;
  let app;
  before(async () => {
    browser = await launchBrowser();
    app = await startApp();
  });
  after(async () => { await app?.close(); await browser?.close(); });

  it('a conversion shows a permalink that serves the same markdown', async (t) => {
    const { context, page } = await openPage(browser, app.baseUrl);
    t.after(() => context.close());

    await convert(page, WEB_URL);
    const shown = await waitForResult(page);
    await page.locator('#permalink-bar').waitFor();
    const permalink = await page.locator('#permalink-url').innerText();
    const shareId = app.cache.get(WEB_URL).share_id;
    assert.equal(permalink, `${app.baseUrl}/s/${shareId}`);

    const res = await context.request.get(permalink);
    assert.equal(res.status(), 200);
    assert.match(res.headers()['content-type'], /text\/markdown/);
    // The share link serves the body; the PWA shows it without frontmatter by default.
    assert.equal(await res.text(), shown);
  });

  it('the permalink copy button copies the link', async (t) => {
    const { context, page } = await openPage(browser, app.baseUrl, { goto: false });
    t.after(() => context.close());
    await context.addInitScript(() => {
      window.__copied = [];
      navigator.clipboard.writeText = (text) => { window.__copied.push(text); return Promise.resolve(); };
    });
    await page.goto(app.baseUrl + '/');
    await convert(page, WEB_URL);
    await waitForResult(page);

    await page.locator('#permalink-copy-btn').click();
    await page.waitForFunction(() => window.__copied.length === 1);
    assert.equal(await page.evaluate(() => window.__copied[0]), await page.locator('#permalink-url').innerText());
    assert.equal(await page.locator('#permalink-copy-btn').innerText(), 'Kopiert!');
  });

  it('/share?link= opens the app with the URL filled in and converted', async (t) => {
    const { context, page } = await openPage(browser, app.baseUrl, { goto: false });
    t.after(() => context.close());

    await page.goto(`${app.baseUrl}/share?link=${encodeURIComponent(WEB_URL)}`);
    assert.match(await waitForResult(page), /^# Example Article$/m);
    assert.equal(await page.locator('#url-input').inputValue(), WEB_URL);
    // The #url= fragment is consumed, so a reload does not convert again.
    assert.equal(new URL(page.url()).hash, '');
    assert.equal(new URL(page.url()).pathname, '/');
  });

  it('/share?text= picks the URL out of shared text', async (t) => {
    const { context, page } = await openPage(browser, app.baseUrl, { goto: false });
    t.after(() => context.close());

    const other = 'https://example.test/shared-from-text';
    await page.goto(`${app.baseUrl}/share?text=${encodeURIComponent(`Look at this ${other}`)}`);
    await waitForResult(page);
    assert.equal(await page.locator('#url-input').inputValue(), other);
  });
});
