// File upload through the picker: HTML goes to POST /api/html, documents to
// POST /api/file?async=1 (202 + job id, then polling /api/file/jobs/:id),
// and a job still running survives a reload via localStorage.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, deferred } from './helpers/app.js';
import { launchBrowser, openPage, waitForResult, waitForError } from './helpers/browser.js';

const JOB_KEY = 'pullmd-file-job';

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
});
