// What the result area does with a converted page: Raw|Rendered toggle,
// frontmatter toggle, copy and download.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { startApp, webResult, WEB_URL } from './helpers/app.js';
import { launchBrowser, openPage, convert, waitForResult, rawViewText } from './helpers/browser.js';

const BODY = '# Example Article\n\nFirst paragraph of the article.\n';

describe('result view', () => {
  let browser;
  let app;
  before(async () => {
    browser = await launchBrowser();
    app = await startApp({ extractWeb: async (url) => webResult(url, { body: BODY }) });
  });
  after(async () => { await app?.close(); await browser?.close(); });

  async function openConverted(t, opts) {
    const { context, page } = await openPage(browser, app.baseUrl, opts);
    t.after(() => context.close());
    await convert(page, WEB_URL);
    await waitForResult(page);
    return { context, page };
  }

  const frontmatterToggle = (page) => page.locator('label', { hasText: 'Frontmatter' });
  const tab = (page, name) => page.getByRole('tab', { name });

  it('Raw is the default; Rendered shows HTML and the choice survives a reload', async (t) => {
    const { page } = await openConverted(t);
    assert.equal(await tab(page, 'Raw').getAttribute('aria-selected'), 'true');
    assert.equal(await page.locator('#result').isVisible(), true);
    assert.equal(await page.locator('#result-rendered').isVisible(), false);

    await tab(page, 'Rendered').click();
    await page.locator('#result-rendered h1').waitFor();
    assert.equal(await page.locator('#result-rendered h1').innerText(), 'Example Article');
    assert.equal(await page.locator('#result-rendered p').first().innerText(), 'First paragraph of the article.');
    assert.equal(await page.locator('#result').isVisible(), false);
    assert.equal(await tab(page, 'Rendered').getAttribute('aria-selected'), 'true');
    assert.equal(await tab(page, 'Raw').getAttribute('aria-selected'), 'false');

    await page.reload();
    await convert(page, WEB_URL);
    await waitForResult(page);
    await page.locator('#result-rendered h1').waitFor();
    assert.equal(await tab(page, 'Rendered').getAttribute('aria-selected'), 'true');
    assert.equal(await page.locator('#result').isVisible(), false);
  });

  it('the rendered view does not run markup from the page', async (t) => {
    const hostile = await startApp({
      extractWeb: async (url) => webResult(url, {
        body: '# Hostile\n\n<img src="x" onerror="window.__xss = 1">\n\n<script>window.__xss = 2</script>\n\n[click](javascript:window.__xss=3)\n',
      }),
    });
    t.after(() => hostile.close());
    const { context, page } = await openPage(browser, hostile.baseUrl);
    t.after(() => context.close());

    await convert(page, WEB_URL);
    await waitForResult(page);
    await tab(page, 'Rendered').click();
    await page.locator('#result-rendered h1').waitFor();
    // Give a surviving onerror handler time to fire on the broken image.
    await page.waitForTimeout(300);
    assert.equal(await page.evaluate(() => window.__xss), undefined);
    assert.equal(await page.locator('#result-rendered script').count(), 0);
    assert.equal(await page.locator('#result-rendered [onerror]').count(), 0);
    const hrefs = await page.$$eval('#result-rendered a', (as) => as.map((a) => a.getAttribute('href') || ''));
    assert.ok(hrefs.every((h) => !/^javascript:/i.test(h)), `no javascript: link survives, got ${JSON.stringify(hrefs)}`);
  });

  it('the frontmatter toggle swaps the block in and out without a new request', async (t) => {
    const { page } = await openPage(browser, app.baseUrl);
    t.after(() => page.context().close());
    const conversions = [];
    page.on('request', (r) => { if (/^\/api(\/stream)?$/.test(new URL(r.url()).pathname)) conversions.push(r.url()); });

    await convert(page, WEB_URL);
    const off = await waitForResult(page);
    assert.match(off, /^# Example Article\n/, 'off by default: the result starts with the body');
    assert.doesNotMatch(off, /^---$/m);

    await frontmatterToggle(page).click();
    await page.waitForFunction(() => document.querySelector('#result .ln')?.textContent === '---');
    const on = await rawViewText(page);
    assert.match(on, /^---\ntitle: Example Article\nurl: https:\/\/example\.test\/article\nsource: readability\n/);
    assert.ok(on.endsWith(off), 'the body after the block is unchanged');

    await frontmatterToggle(page).click();
    await page.waitForFunction(() => document.querySelector('#result .ln')?.textContent === '# Example Article');
    assert.equal(await rawViewText(page), off);
    assert.equal(conversions.length, 1, 'toggling never re-fetches');
    assert.equal(new URL(conversions[0]).searchParams.get('frontmatter'), 'true', 'the PWA always asks for the block');
  });

  it('the frontmatter preference survives a reload', async (t) => {
    const { page } = await openPage(browser, app.baseUrl);
    t.after(() => page.context().close());
    await frontmatterToggle(page).click();
    assert.equal(await page.locator('#frontmatter-toggle').isChecked(), true);
    await page.reload();
    assert.equal(await page.locator('#frontmatter-toggle').isChecked(), true);
    await convert(page, WEB_URL);
    assert.match(await waitForResult(page), /^---\ntitle: Example Article\n/);
  });

  it('rendered view shows frontmatter as a code box, not as a heading', async (t) => {
    const { page } = await openConverted(t);
    await frontmatterToggle(page).click();
    await tab(page, 'Rendered').click();
    await page.locator('#result-rendered pre.fm-block').waitFor();
    const block = await page.locator('#result-rendered pre.fm-block').innerText();
    assert.match(block, /^title: Example Article\n/);
    assert.doesNotMatch(block, /^---/m);
    assert.deepEqual(await page.locator('#result-rendered h1, #result-rendered h2').allInnerTexts(), ['Example Article']);
  });

  it('copy puts exactly the visible markdown on the clipboard', async (t) => {
    const { context, page } = await openPage(browser, app.baseUrl, { goto: false });
    t.after(() => context.close());
    // Headless clipboard access depends on permissions; capture writes instead.
    await context.addInitScript(() => {
      window.__copied = [];
      navigator.clipboard.writeText = (text) => { window.__copied.push(text); return Promise.resolve(); };
    });
    await page.goto(app.baseUrl + '/');
    await convert(page, WEB_URL);
    const off = await waitForResult(page);

    const copyBtn = page.locator('#copy-btn');
    await copyBtn.click();
    await page.waitForFunction(() => window.__copied.length === 1);
    assert.equal(await page.evaluate(() => window.__copied[0]), off);
    assert.equal(await copyBtn.locator('.label').innerText(), 'Kopiert!');

    await frontmatterToggle(page).click();
    await page.waitForFunction(() => document.querySelector('#result .ln')?.textContent === '---');
    await copyBtn.click();
    await page.waitForFunction(() => window.__copied.length === 2);
    const copied = await page.evaluate(() => window.__copied[1]);
    assert.equal(copied, await rawViewText(page));
    assert.match(copied, /^---\ntitle: Example Article\n/);
  });

  it('download saves the visible markdown under the suggested file name', async (t) => {
    const { page } = await openConverted(t);
    const off = await rawViewText(page);

    let [download] = await Promise.all([page.waitForEvent('download'), page.locator('#download-btn').click()]);
    assert.equal(download.suggestedFilename(), 'example-article.md');
    assert.equal(fs.readFileSync(await download.path(), 'utf8'), off);

    await frontmatterToggle(page).click();
    await page.waitForFunction(() => document.querySelector('#result .ln')?.textContent === '---');
    [download] = await Promise.all([page.waitForEvent('download'), page.locator('#download-btn').click()]);
    const saved = fs.readFileSync(await download.path(), 'utf8');
    assert.match(saved, /^---\ntitle: Example Article\n/);
    assert.ok(saved.endsWith(off));
  });
});
