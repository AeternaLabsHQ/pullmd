import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loginPage, signupPage, settingsPage } from '../lib/auth-pages.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

function bothLangs(html, dePattern, enPattern) {
  assert.match(html, new RegExp(`<span lang="de"[^>]*>[^<]*${dePattern}`), `expected DE span: ${dePattern}`);
  assert.match(html, new RegExp(`<span lang="en"[^>]*>[^<]*${enPattern}`), `expected EN span: ${enPattern}`);
}

describe('auth-pages: parallel lang spans', () => {
  it('login page contains both DE and EN spans for every label', () => {
    const html = loginPage({ signupOpen: true });
    // Page uses the parallel-lang i18n pattern from help.html.
    assert.match(html, /body\[data-lang="de"\] \[lang="en"\] \{ display: none/);
    assert.match(html, /body\[data-lang="en"\] \[lang="de"\] \{ display: none/);
    bothLangs(html, 'PullMD anmelden', 'Sign in to PullMD');
    bothLangs(html, 'E-Mail', 'Email');
    bothLangs(html, 'Passwort', 'Password');
    bothLangs(html, 'Anmelden', 'Sign in');
    bothLangs(html, 'Konto erstellen', 'Create an account');
    // Pre-paint script to set lang before first paint.
    assert.match(html, /localStorage\.getItem\('pullmd-lang'\)/);
    assert.match(html, /id="lang-toggle"/);
  });

  it('login page error key renders both DE and EN error text', () => {
    const html = loginPage({ error: 'wrong_credentials' });
    assert.match(html, /Falsche E-Mail oder falsches Passwort/);
    assert.match(html, /Wrong email or password/);
  });

  it('login page free-form error string still renders (back-compat)', () => {
    const html = loginPage({ error: 'Custom transient error' });
    assert.match(html, /Custom transient error/);
  });

  it('signup page contains both DE and EN spans for every label', () => {
    const html = signupPage({});
    bothLangs(html, 'PullMD-Konto erstellen', 'Create your PullMD account');
    bothLangs(html, 'Passwort \\(mindestens 8 Zeichen\\)', 'Password \\(min 8 chars\\)');
    bothLangs(html, 'Passwort bestätigen', 'Confirm password');
    bothLangs(html, 'Registrieren', 'Sign up');
  });

  it('signup error keys translate to both languages', () => {
    for (const [key, dePat, enPat] of [
      ['passwords_dont_match', /stimmen nicht überein/, /Passwords do not match/],
      ['password_too_short', /mindestens 8 Zeichen/, /at least 8 characters/],
      ['invalid_email', /Ungültige E-Mail/, /Invalid email/],
      ['email_taken', /bereits registriert/, /already registered/],
      ['create_failed', /Konto konnte nicht angelegt werden/, /Could not create account/],
    ]) {
      const html = signupPage({ error: key });
      assert.match(html, dePat, `DE for ${key}`);
      assert.match(html, enPat, `EN for ${key}`);
    }
  });

  it('settings page contains both DE and EN for headers, buttons, key list', () => {
    const html = settingsPage({
      user: { email: 'admin@x.y', is_admin: true },
      keys: [],
    });
    bothLangs(html, 'Einstellungen', 'Settings');
    bothLangs(html, 'Angemeldet als', 'Signed in as');
    bothLangs(html, 'Zurück zu PullMD', 'Back to PullMD');
    bothLangs(html, 'Abmelden', 'Log out');
    bothLangs(html, 'API-Schlüssel', 'API keys');
    bothLangs(html, 'Erstellen', 'Generate');
    bothLangs(html, 'Noch keine API-Schlüssel', 'No API keys yet');
  });

  it('settings page renders revoke button in both languages', () => {
    const html = settingsPage({
      user: { email: 'u@x.y', is_admin: false },
      keys: [{ id: 1, key_prefix: 'pmd_aaaaaaaa', label: 'k', created_at: '2026-01-01', last_used_at: null }],
    });
    bothLangs(html, 'Widerrufen', 'Revoke');
    // Confirm string should be translated, stored as data-attrs read by JS.
    assert.match(html, /data-confirm-de="[^"]*widerrufen/);
    assert.match(html, /data-confirm-en="[^"]*Revoke/);
  });

  it('settings page shows the new-key banner in both languages when newKey is set', () => {
    const html = settingsPage({
      user: { email: 'u@x.y', is_admin: false },
      keys: [],
      newKey: 'pmd_TESTKEY',
    });
    assert.match(html, /Speichere diesen Schlüssel jetzt/);
    assert.match(html, /Save this key now/);
    assert.match(html, /pmd_TESTKEY/);
  });
});

describe('auth-pages: login env-var hint (single-admin mode)', () => {
  it('renders the env-var hint in both languages when mode is single-admin', () => {
    const html = loginPage({ mode: 'single-admin' });
    assert.match(html, /<span lang="de">[^<]*PULLMD_ADMIN_EMAIL/);
    assert.match(html, /<span lang="en">[^<]*PULLMD_ADMIN_EMAIL/);
    assert.match(html, /PULLMD_ADMIN_PASSWORD/);
    assert.match(html, /Environment-Konfiguration/);
    assert.match(html, /from your environment/);
  });

  it('does NOT render the hint in multi-user mode', () => {
    const html = loginPage({ mode: 'multi-user' });
    assert.doesNotMatch(html, /PULLMD_ADMIN_EMAIL/);
  });

  it('does NOT render the hint when mode is omitted (back-compat)', () => {
    const html = loginPage({});
    assert.doesNotMatch(html, /PULLMD_ADMIN_EMAIL/);
  });

  it('does NOT render the hint for an unrecognised mode value', () => {
    const html = loginPage({ mode: 'foo' });
    assert.doesNotMatch(html, /PULLMD_ADMIN_EMAIL/);
  });

  it('hint is styled muted (env-hint class on a muted block)', () => {
    const html = loginPage({ mode: 'single-admin' });
    // The hint sits inside a .muted block (existing helper class). Allow either order.
    assert.match(html, /class="muted env-hint"|class="env-hint muted"/);
  });
});

describe('PWA index.html: misconfig banner DOM', () => {
  const html = readFileSync(join(ROOT, 'public/index.html'), 'utf8');

  it('declares a sticky auth-warning banner with hidden attribute by default', () => {
    assert.match(html, /<div id="auth-warning-banner"[^>]*class="auth-warning"[^>]*hidden/);
  });

  it('contains both DE and EN span versions of the banner copy', () => {
    assert.match(html, /<span lang="de">[^<]*Authentifizierung ist derzeit deaktiviert/);
    assert.match(html, /<span lang="en">[^<]*Authentication is currently disabled/);
  });

  it('mentions PULLMD_AUTH_MODE / single-admin / MIGRATION.md in both spans', () => {
    const deBlock = html.match(/<span lang="de">[\s\S]*?MIGRATION\.md[\s\S]*?<\/span>/);
    const enBlock = html.match(/<span lang="en">[\s\S]*?MIGRATION\.md[\s\S]*?<\/span>/);
    assert.ok(deBlock, 'DE banner span must contain MIGRATION.md link');
    assert.ok(enBlock, 'EN banner span must contain MIGRATION.md link');
    for (const block of [deBlock[0], enBlock[0]]) {
      assert.match(block, /PULLMD_AUTH_MODE=single-admin/);
      assert.match(block, /PULLMD_ADMIN_EMAIL/);
      assert.match(block, /PULLMD_ADMIN_PASSWORD/);
    }
  });

  it('declares the parallel-lang CSS hide rule for the banner', () => {
    assert.match(html, /body\[data-lang="de"\][^{]*\[lang="en"\]\s*\{\s*display:\s*none/);
    assert.match(html, /body\[data-lang="en"\][^{]*\[lang="de"\]\s*\{\s*display:\s*none/);
  });

  it('toggles the banner via /api/config.authMisconfigured', () => {
    assert.match(html, /cfg\.authMisconfigured/);
    assert.match(html, /removeAttribute\(['"]hidden['"]\)/);
  });

  it('initialises body[data-lang] before first paint and on lang change', () => {
    // pre-paint sets data-lang
    assert.match(html, /document\.body\.setAttribute\(['"]data-lang['"]/);
    // applyLang() mirrors lang to body
    assert.match(html, /Mirror onto body so the parallel-lang CSS pattern/);
  });
});
