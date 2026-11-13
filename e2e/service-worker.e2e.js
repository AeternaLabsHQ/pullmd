// public/sw.js contract: pre-cache the app shell on install, then answer
// every request network-first and fall back to the cache only when the
// network fails. Nothing else is ever written to the cache, so API answers
// are never served stale.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, WEB_URL } from './helpers/app.js';
import { launchBrowser, openPage, convert, waitForResult, waitForError } from './helpers/browser.js';

const SHELL = ['/', '/index.html', '/manifest.json', '/vendor/marked.min.js', '/vendor/purify.min.js'];

describe('service worker', () => {
  let browser;
  let app;
  before(async () => {
    browser = await launchBrowser();
    app = await startApp();
  });
  after(async () => { await app?.close(); await browser?.close(); });

  // Opens the app with the worker allowed and waits until it controls the page.
  async function openControlled(t) {
    const { context, page } = await openPage(browser, app.baseUrl, { serviceWorkers: 'allow' });
    t.after(() => context.close());
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.waitForFunction(() => !!navigator.serviceWorker.controller);
    return { context, page };
  }

  const cachedPaths = (page) => page.evaluate(async () => {
    const out = {};
    for (const name of await caches.keys()) {
      const cache = await caches.open(name);
      out[name] = (await cache.keys()).map((r) => new URL(r.url).pathname).sort();
    }
    return out;
  });

  it('registers and pre-caches exactly the app shell', async (t) => {
    const { page } = await openControlled(t);
    const caches = await cachedPaths(page);
    const names = Object.keys(caches);
    assert.equal(names.length, 1, `one cache, got ${names.join(', ')}`);
    assert.deepEqual(caches[names[0]], [...SHELL].sort());
  });

  it('serves the shell when the network is gone', async (t) => {
    const { context, page } = await openControlled(t);
    await context.setOffline(true);
    await page.reload();
    assert.equal(await page.getByRole('heading', { level: 1 }).innerText(), 'Alles rein, Markdown raus.');
    await page.locator('#status-meta[data-status="offline"]').waitFor();
  });

  it('API answers are not cached: online they are fresh, offline they fail', async (t) => {
    const { context, page } = await openControlled(t);
    await convert(page, WEB_URL);
    await waitForResult(page);
    const paths = Object.values(await cachedPaths(page)).flat();
    assert.deepEqual(paths.filter((p) => p.startsWith('/api') || p.startsWith('/s/')), []);

    await context.setOffline(true);
    await convert(page, WEB_URL);
    assert.equal(await waitForError(page), 'Netzwerkfehler: Server nicht erreichbar.');
  });
});
