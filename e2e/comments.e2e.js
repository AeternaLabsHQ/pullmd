// Comment options for Reddit and Hacker News: what the controls send, and
// what the extractor finally receives.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, REDDIT_URL, HN_URL } from './helpers/app.js';
import { launchBrowser, openPage, convert, waitForResult } from './helpers/browser.js';

describe('comment options', () => {
  let browser;
  before(async () => { browser = await launchBrowser(); });
  after(async () => { await browser?.close(); });

  async function setup(t) {
    const app = await startApp();
    t.after(() => app.close());
    const { context, page } = await openPage(browser, app.baseUrl);
    t.after(() => context.close());
    return { app, page };
  }

  // Converts and returns the query of the /api/stream request it sent.
  async function convertAndCapture(page, url) {
    const request = page.waitForRequest((r) => new URL(r.url()).pathname === '/api/stream');
    await convert(page, url);
    const params = new URL((await request).url()).searchParams;
    await waitForResult(page);
    return params;
  }

  const commentsToggle = (page) => page.locator('label', { hasText: 'Kommentare' });
  const allToggle = (page) => page.locator('#all-comments-label');
  const depth = (page) => page.getByLabel('Tiefe');

  it('defaults: comments on, depth 3, no comment params sent', async (t) => {
    const { app, page } = await setup(t);
    const params = await convertAndCapture(page, REDDIT_URL);
    assert.equal(params.get('url'), REDDIT_URL);
    assert.equal(params.has('comments'), false);
    assert.equal(params.has('comment_depth'), false);
    assert.equal(params.get('lang'), 'de');
    assert.equal(params.get('client_mode'), 'browser');
    assert.equal(app.calls.reddit.length, 1);
    assert.equal(app.calls.reddit[0][1].comments, true);
    assert.equal(app.calls.reddit[0][1].commentDepth, 3);
  });

  it('switching comments off hides depth and sends comments=false', async (t) => {
    const { app, page } = await setup(t);
    await commentsToggle(page).click();
    assert.equal(await depth(page).isVisible(), false);
    assert.equal(await allToggle(page).isVisible(), false);

    const params = await convertAndCapture(page, REDDIT_URL);
    assert.equal(params.get('comments'), 'false');
    assert.equal(params.has('comment_depth'), false);
    assert.equal(app.calls.reddit[0][1].comments, false);
  });

  it('a depth other than 3 is sent as comment_depth and clamped to 10', async (t) => {
    const { app, page } = await setup(t);
    await depth(page).fill('5');
    let params = await convertAndCapture(page, REDDIT_URL);
    assert.equal(params.get('comment_depth'), '5');
    assert.equal(app.calls.reddit[0][1].commentDepth, 5);

    await depth(page).fill('42');
    await depth(page).press('Tab');
    assert.equal(await depth(page).inputValue(), '10');
    params = await convertAndCapture(page, HN_URL);
    assert.equal(params.get('comment_depth'), '10');
    assert.equal(app.calls.hn[0][1].commentDepth, 10);
  });

  it('"Alle" disables the depth field and sends comment_depth=all', async (t) => {
    const { app, page } = await setup(t);
    await allToggle(page).click();
    assert.equal(await depth(page).isDisabled(), true);

    const params = await convertAndCapture(page, HN_URL);
    assert.equal(params.get('comment_depth'), 'all');
    assert.equal(app.calls.hn[0][1].commentDepth, 'all');
  });

  it('comment settings survive a reload', async (t) => {
    const { page } = await setup(t);
    await depth(page).fill('7');
    await depth(page).press('Tab');
    await allToggle(page).click();
    await commentsToggle(page).click();

    await page.reload();
    assert.equal(await page.locator('#comments-toggle').isChecked(), false);
    assert.equal(await page.locator('#all-comments-toggle').isChecked(), true);
    assert.equal(await page.locator('#depth-input').inputValue(), '7');
    assert.equal(await depth(page).isVisible(), false);
  });
});
