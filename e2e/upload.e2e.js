// File upload through the picker: HTML goes to POST /api/html, documents to
// POST /api/file?async=1 (202 + job id, then polling /api/file/jobs/:id),
// and a job still running survives a reload via localStorage.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startApp, deferred, webResult, WEB_URL } from './helpers/app.js';
import { launchBrowser, openPage, convert, waitForResult, waitForError } from './helpers/browser.js';
import { extractHtml } from '../lib/web.js';

const JOB_KEY = 'pullmd-file-job';

// A 1x1 transparent PNG.
const PIXEL = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');
const PIXEL_DATA_URI = `data:image/png;base64,${PIXEL.toString('base64')}`;

/**
 * Stand-in for a remote image host on 127.0.0.1 (a different origin than the
 * app): records every request it gets, headers included.
 */
async function startImageServer() {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push({ url: req.url, headers: req.headers });
    res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' });
    res.end(PIXEL);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  return {
    origin,
    requests,
    close: () => { server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)); },
  };
}

/** Polls until fn() is truthy or the timeout runs out. */
async function until(fn, ms = 5000) {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe('file upload', () => {
  let browser;
  before(async () => { browser = await launchBrowser(); });
  after(async () => { await browser?.close(); });

  async function setup(t, appOpts) {
    const app = await startApp(appOpts);
    t.after(() => app.close());
    const { context, page } = await openPage(browser, app.baseUrl);
    t.after(() => context.close());
    return { app, page };
  }

  const pick = (page, name, mimeType, text) =>
    page.locator('#html-file-input').setInputFiles({ name, mimeType, buffer: Buffer.from(text) });
  const storedJob = (page) => page.evaluate((k) => localStorage.getItem(k), JOB_KEY);

  it('a document is converted as an async job and the job is cleaned up', async (t) => {
    const { app, page } = await setup(t);
    const upload = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/file');
    const cleanup = page.waitForRequest((r) => r.method() === 'DELETE' && r.url().includes('/api/file/jobs/'));

    await pick(page, 'notes.txt', 'text/plain', 'hello from a text file');
    const res = await upload;
    assert.equal(res.status(), 202);
    assert.equal(new URL(res.url()).searchParams.get('async'), '1');
    const { jobId } = await res.json();

    const text = await waitForResult(page);
    assert.match(text, /^# notes\.txt$/m);
    assert.match(text, /hello from a text file/);
    assert.equal(app.calls.file[0][1].filename, 'notes.txt');
    assert.ok((await cleanup).url().endsWith(`/api/file/jobs/${jobId}`));
    assert.equal(await storedJob(page), null);
  });

  it('a job still running when the page reloads is picked up again', async (t) => {
    const gate = deferred();
    const { page } = await setup(t, {
      extractFile: async (buf, { filename }) => {
        await gate.promise;
        return { markdown: `# ${filename}\n\nlong job done\n`, title: filename, source: 'local', metadata: { title: filename } };
      },
    });

    await pick(page, 'interview.md', 'text/markdown', 'audio-ish');
    await page.locator('#loading-label', { hasText: 'Hochgeladen, wird verarbeitet' }).waitFor();
    assert.match(await storedJob(page), /"name":"interview\.md"/);

    await page.reload();
    await page.locator('#loading-label', { hasText: '"interview.md" ist noch in Arbeit' }).waitFor();
    assert.equal(await page.locator('#loading').isVisible(), true);

    gate.resolve();
    assert.match(await waitForResult(page), /long job done/);
    assert.equal(await storedJob(page), null);
  });

  it('a failed job shows its error', async (t) => {
    t.mock.method(console, 'error', () => {});
    const { page } = await setup(t, { extractFile: async () => { throw new Error('sidecar exploded'); } });
    await pick(page, 'broken.txt', 'text/plain', 'x');
    assert.equal(await waitForError(page), 'Failed to convert file: sidecar exploded');
    assert.equal(await storedJob(page), null);
  });

  it('a job the server no longer knows ends with a "re-upload" message', async (t) => {
    const { page } = await setup(t);
    await page.evaluate((k) => localStorage.setItem(k, JSON.stringify({ id: '0'.repeat(32), name: 'gone.pdf' })), JOB_KEY);
    await page.reload();
    assert.match(await waitForError(page), /nicht mehr vorhanden/);
    assert.equal(await storedJob(page), null);
  });

  it('an HTML file is converted synchronously via /api/html', async (t) => {
    const { app, page } = await setup(t);
    const request = page.waitForRequest((r) => new URL(r.url()).pathname === '/api/html');
    await pick(page, 'saved page.html', 'text/html', '<html><body><p>hi</p></body></html>');
    const sent = await request;
    assert.equal(sent.headers()['x-filename'], encodeURIComponent('saved page.html'));
    assert.match(await waitForResult(page), /^# Uploaded page$/m);
    assert.equal(app.calls.html[0][0], '<html><body><p>hi</p></body></html>');
    assert.equal(app.calls.file.length, 0);
  });

  it('an unsupported file type is refused before upload', async (t) => {
    const { app, page } = await setup(t);
    await pick(page, 'tool.exe', 'application/octet-stream', 'MZ');
    assert.equal(await waitForError(page), 'Dieses Dateiformat wird nicht unterstützt.');
    assert.equal(app.calls.file.length + app.calls.html.length, 0);
  });

  describe('remote images in uploaded documents', () => {
    async function setupWithImages(t, appOpts) {
      const img = await startImageServer();
      t.after(() => img.close());
      const { app, page } = await setup(t, appOpts);
      // openPage() aborts every request off the app's origin; let the
      // stand-in image host through (the latest route wins).
      await page.context().route((url) => url.origin === img.origin, (route) => route.continue());
      return { app, page, img };
    }
    const bar = (page) => page.locator('#remote-images-bar');
    const remoteImgs = (page, src) => page.locator(`#result img[src="${src}"], #result-rendered img[src="${src}"]`);

    it('are held back until "Load images" and then load without a Referer', async (t) => {
      const { page, img } = await setupWithImages(t, { extractHtml });
      const remote = `${img.origin}/pixel.png`;
      const paras = Array.from({ length: 12 }, (_, i) =>
        `<p>Paragraph ${i + 1} of the uploaded article, with enough words in it to count as real content for the extractor.</p>`);
      const html = `<html><head><title>Mail</title></head><body><article><h1>Mail</h1>${paras[0]}`
        + `<p><img src="${remote}" alt="tracker"></p><p><img src="${PIXEL_DATA_URI}" alt="inline"></p>`
        + `${paras.slice(1).join('')}</article></body></html>`;

      await pick(page, 'mail.html', 'text/html', html);
      const text = await waitForResult(page);
      assert.ok(text.includes(`![tracker](${remote})`), 'the image markdown stays visible as text');
      await page.waitForTimeout(500);
      assert.equal(img.requests.length, 0);
      assert.equal(await bar(page).isVisible(), true);
      assert.equal(await bar(page).innerText(), 'Externe Bilder in diesem Dokument wurden nicht geladen.\nBilder laden');
      assert.equal(await remoteImgs(page, remote).count(), 0);

      // The Rendered view shows a placeholder with the URL as text.
      await page.locator('#view-toggle button[data-mode="rendered"]').click();
      assert.equal(await remoteImgs(page, remote).count(), 0);
      assert.match(await page.locator('#result-rendered').innerText(), new RegExp(remote.replace(/[.]/g, '\\.')));
      assert.equal(await page.locator('#result-rendered').evaluate((el, src) => el.innerHTML.includes(`src="${src}"`), remote), false);

      // A language switch re-renders, the block survives and the bar follows.
      await page.locator('#lang-toggle').click();
      assert.equal(await bar(page).innerText(), 'Remote images in this document were not loaded.\nLoad images');
      await page.locator('#view-toggle button[data-mode="raw"]').click();
      assert.equal(await remoteImgs(page, remote).count(), 0);
      await page.waitForTimeout(300);
      assert.equal(img.requests.length, 0);

      await bar(page).getByRole('button', { name: 'Load images' }).click();
      assert.equal(await bar(page).isVisible(), false);
      const shown = page.locator(`#result img[src="${remote}"]`);
      await shown.scrollIntoViewIfNeeded();
      await until(() => img.requests.length > 0);
      assert.equal(img.requests[0].url, '/pixel.png');
      assert.equal(img.requests[0].headers.referer, undefined);
      assert.equal(await shown.getAttribute('referrerpolicy'), 'no-referrer');

      await page.locator('#view-toggle button[data-mode="rendered"]').click();
      const rendered = page.locator(`#result-rendered img[src="${remote}"]`);
      assert.equal(await rendered.count(), 1);
      assert.equal(await rendered.getAttribute('referrerpolicy'), 'no-referrer');
    });

    it('are held back in forms only marked recognises (reference links, entity-encoded tags)', async (t) => {
      const { page, img } = await setupWithImages(t);
      const ref = `${img.origin}/ref.png`;
      const encoded = `&#104;ttp://127.0.0.1:${new URL(img.origin).port}/entity.png`;
      await pick(page, 'notes.md', 'text/markdown', `Intro\n\n![a ref][1]\n\n<img src="${encoded}" alt="raw">\n\n[1]: ${ref}\n`);
      await waitForResult(page);
      await page.locator('#view-toggle button[data-mode="rendered"]').click();
      await page.waitForTimeout(500);
      assert.equal(img.requests.length, 0);
      assert.equal(await page.locator('#result-rendered img').count(), 0);
      assert.equal(await bar(page).isVisible(), true);

      await bar(page).getByRole('button', { name: 'Bilder laden' }).click();
      await until(() => img.requests.length === 2);
      assert.deepEqual(img.requests.map((r) => r.url).sort(), ['/entity.png', '/ref.png']);
    });

    it('an image pointing at the instance itself is held back too', async (t) => {
      const { app, page } = await setupWithImages(t);
      // The instance's own /api would fetch the URL in its query string.
      const target = 'https://example.test/pixel-id';
      const src = `/api?url=${encodeURIComponent(target)}&nocache=1`;
      const reached = () => app.calls.web.filter(([url]) => url === target).length;
      const apiRequests = [];
      page.on('request', (r) => {
        const u = new URL(r.url());
        if (u.pathname === '/api' && u.searchParams.get('url') === target) apiRequests.push(r.url());
      });

      await pick(page, 'notes.md', 'text/markdown', `Intro\n\n![pixel](${src})\n\nText.\n`);
      await waitForResult(page);
      await page.locator('#view-toggle button[data-mode="rendered"]').click();
      await page.waitForTimeout(500);
      assert.equal(apiRequests.length, 0);
      assert.equal(reached(), 0);
      assert.equal(await page.locator('#result-rendered img').count(), 0);
      assert.equal(await bar(page).isVisible(), true);

      await bar(page).getByRole('button', { name: 'Bilder laden' }).click();
      await until(() => reached() > 0);
      assert.ok(apiRequests.length > 0);
    });

    it('a URL result cannot fake a held-back image with its own data-blocked-src', async (t) => {
      const { page, img } = await setupWithImages(t, {
        extractWeb: async (url) => webResult(url, {
          body: `# Web page\n\n<img data-blocked-src="x" src="${img.origin}/own.png" alt="own">\n\nText.\n`,
        }),
      });
      await convert(page, WEB_URL);
      await waitForResult(page);
      await page.locator('#view-toggle button[data-mode="rendered"]').click();
      const shown = page.locator(`#result-rendered img[src="${img.origin}/own.png"]`);
      assert.equal(await shown.count(), 1);
      assert.equal(await shown.getAttribute('data-blocked-src'), null);
      assert.equal(await page.locator('#result-rendered .blocked-image').count(), 0);
      await until(() => img.requests.some((r) => r.url === '/own.png'));
    });

    it('data: images still show, and the next URL result loads its images again', async (t) => {
      const { page, img } = await setupWithImages(t, {
        extractWeb: async (url) => webResult(url, { body: `# Web page\n\n![photo](${img.origin}/web.png)\n\nText.\n` }),
      });
      const remote = `${img.origin}/mail.png`;
      // A .md upload: the HTML extractor turns data: images into their alt
      // text (stripDataUriImages), markdown files keep them.
      await pick(page, 'notes.md', 'text/markdown', `Intro\n\n![inline](${PIXEL_DATA_URI})\n\n![tracker](${remote})\n`);
      await waitForResult(page);
      assert.equal(await page.locator('#result img[src^="data:"]').count(), 1);
      assert.equal(await remoteImgs(page, remote).count(), 0);
      assert.equal(await bar(page).isVisible(), true);

      await convert(page, WEB_URL);
      await page.locator('#result img[src$="/web.png"]').waitFor();
      assert.equal(await bar(page).isVisible(), false);
      await until(() => img.requests.some((r) => r.url === '/web.png'));
      assert.equal(img.requests.some((r) => r.url === '/mail.png'), false);
    });
  });
});
