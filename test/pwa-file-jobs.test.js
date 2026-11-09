import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

// Static-content assertions on the PWA source, same convention as
// pwa-download-button.test.js: there is no DOM harness for public/index.html,
// so the guard sits on the code itself. The real-browser behaviour of the
// async upload flow is checked separately.
describe('PWA index.html: async file jobs', () => {
  const html = readFileSync(join(ROOT, 'public/index.html'), 'utf8');

  const COPY = {
    'upload.sending': {
      de: 'Datei wird hochgeladen ({pct} %). Bitte App geöffnet lassen.',
      en: 'Uploading file ({pct}%). Please keep the app open.',
    },
    'upload.processing': {
      de: 'Hochgeladen, wird verarbeitet. Du kannst die App verlassen und später wiederkommen.',
      en: 'Uploaded, processing. You can leave the app and come back later.',
    },
    'upload.resumed': {
      de: '"{name}" ist noch in Arbeit. Du kannst die App verlassen und später wiederkommen.',
      en: '"{name}" is still being processed. You can leave the app and come back later.',
    },
    'err.uploadInterrupted': {
      de: 'Upload unterbrochen. Bitte die App während des Uploads geöffnet lassen und erneut versuchen.',
      en: 'Upload interrupted. Keep the app open during the upload and try again.',
    },
    'err.jobGone': {
      de: 'Das Ergebnis ist nicht mehr vorhanden (abgelaufen oder Server neu gestartet). Bitte die Datei erneut hochladen.',
      en: 'The result is no longer available (expired or server restarted). Please upload the file again.',
    },
  };

  function binaryFnBody() {
    const start = html.indexOf('function convertBinaryFile(');
    assert.ok(start >= 0, 'convertBinaryFile must exist');
    // The function ends where the next top-level comment of the IIFE starts.
    const end = html.indexOf('// --- File picker', start);
    assert.ok(end > start, 'file picker block must follow convertBinaryFile');
    return html.slice(start, end);
  }

  it('defines all five new i18n keys in both languages', () => {
    for (const [key, { de, en }] of Object.entries(COPY)) {
      const entries = html.match(new RegExp(`'${key.replace('.', '\\.')}':`, 'g')) || [];
      assert.equal(entries.length, 2, `${key} must appear once per dictionary`);
      assert.ok(html.includes(de), `${key} DE copy`);
      assert.ok(html.includes(en), `${key} EN copy`);
    }
  });

  it('uploads documents with async=1', () => {
    // Not just /async/: today's body already has `async function`.
    assert.match(binaryFnBody(), /params\.set\('async', '1'\)/);
    assert.match(binaryFnBody(), /XMLHttpRequest/);
  });

  it('tracks upload progress', () => {
    assert.match(binaryFnBody(), /upload\.onprogress|upload\.addEventListener\('progress'/);
  });

  it('persists the job under pullmd-file-job', () => {
    assert.match(html, /'pullmd-file-job'/);
    for (const op of ['setItem', 'getItem', 'removeItem']) {
      assert.match(html, new RegExp(`localStorage\\.${op}\\(FILE_JOB_KEY`), `${op} on the job key`);
    }
  });

  it('polls the job endpoint and deletes after pickup', () => {
    assert.match(html, /\/api\/file\/jobs\//);
    assert.match(html, /fetch\('\/api\/file\/jobs\/' \+ [^\n]*\{ method: 'DELETE' \}/);
  });

  it('re-checks when the app becomes visible again', () => {
    assert.match(html, /visibilitychange/);
    assert.match(html, /pageshow/);
  });

  it('contains no em-dash in the new copy', () => {
    for (const { de, en } of Object.values(COPY)) {
      assert.ok(!de.includes('—') && !en.includes('—'));
    }
  });
});
