const PAGE_STYLE = `
<style>
  :root {
    --bg: #0e1016; --bg-elev: #14171f; --bg-input: #11141b;
    --fg: #e7e9ee; --fg-muted: #8b91a1; --border: #1f2330; --border-strong: #2a3040;
    --accent: #ff5722; --accent-hover: #ff7043; --accent-fg: #fff;
    --bad: #ff7a7a; --bad-bg: rgba(255,122,122,0.08);
  }
  @media (prefers-color-scheme: light) {
    :root {
      --bg: #f6f3ee; --bg-elev: #fff; --bg-input: #fff;
      --fg: #1c1a17; --fg-muted: #6b6557; --border: #e6e0d4; --border-strong: #cdc5b3;
      --accent: #d84315; --accent-hover: #bf360c;
      --bad: #c62828; --bad-bg: rgba(198,40,40,0.06);
    }
  }
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
    background: var(--bg); color: var(--fg);
    min-height: 100dvh; display: grid; place-items: center; padding: 2rem;
  }
  .card {
    background: var(--bg-elev); border: 1px solid var(--border);
    border-radius: 12px; padding: 2rem; width: 100%; max-width: 24rem;
    box-shadow: 0 8px 24px rgba(0,0,0,0.18);
  }
  .card-head {
    display: flex; justify-content: space-between; align-items: baseline;
    gap: 0.75rem; margin-bottom: 1rem;
  }
  .card-head h1 { margin: 0; }
  .lang-toggle {
    background: transparent; border: 1px solid var(--border-strong); border-radius: 6px;
    color: var(--fg-muted); font-size: 0.6875rem; font-weight: 600;
    letter-spacing: 0.06em; padding: 0.25rem 0.5rem; cursor: pointer;
    font-family: ui-monospace, SFMono-Regular, monospace;
    width: auto;
  }
  .lang-toggle:hover { color: var(--accent); border-color: var(--accent); }
  h1 { font-size: 1.25rem; margin-bottom: 1rem; }
  label { display: block; margin-top: 0.75rem; color: var(--fg-muted); font-size: 0.875rem; }
  input[type="email"], input[type="password"], input[type="text"] {
    width: 100%; padding: 0.625rem 0.75rem; margin-top: 0.25rem;
    background: var(--bg-input); color: var(--fg);
    border: 1px solid var(--border); border-radius: 6px; font-size: 1rem;
  }
  button {
    margin-top: 1.25rem; width: 100%; padding: 0.625rem;
    background: var(--accent); color: var(--accent-fg);
    border: 0; border-radius: 6px; font-size: 1rem; font-weight: 600; cursor: pointer;
  }
  button:hover { background: var(--accent-hover); }
  .error { background: var(--bad-bg); color: var(--bad);
           border: 1px solid var(--bad); border-radius: 6px;
           padding: 0.625rem; margin-bottom: 0.75rem; font-size: 0.875rem; }
  .muted { color: var(--fg-muted); font-size: 0.875rem; margin-top: 1rem; text-align: center; }
  .muted a { color: var(--accent); text-decoration: none; }
  .key-row { padding: 0.75rem; border-top: 1px solid var(--border);
             display: flex; justify-content: space-between; align-items: center; gap: 0.5rem; }
  .key-row:first-of-type { border-top: 0; }
  .key-prefix { font-family: ui-monospace, SFMono-Regular, monospace; }
  .key-label { color: var(--fg-muted); font-size: 0.875rem; }
  .key-actions form { display: inline; }
  .key-actions button { width: auto; padding: 0.375rem 0.625rem; font-size: 0.875rem;
                        background: transparent; color: var(--bad); border: 1px solid var(--bad); }
  .key-actions button:hover { background: var(--bad-bg); }
  .new-key-banner {
    background: rgba(107,255,156,0.08); border: 1px solid #6bff9c; color: var(--fg);
    border-radius: 6px; padding: 0.75rem; margin-bottom: 1rem; font-family: ui-monospace, monospace;
    font-size: 0.875rem; word-break: break-all;
  }
  /* i18n: hide the non-active language. Same pattern as help.html / index.html. */
  body[data-lang="de"] [lang="en"] { display: none; }
  body[data-lang="en"] [lang="de"] { display: none; }
</style>`;

// Inline pre-paint script: pick the lang from localStorage / navigator before
// first paint so the user never sees the wrong language flash.
const INIT_LANG_SCRIPT = `<script>
(function(){
  try {
    var l = localStorage.getItem('pullmd-lang');
    if (l !== 'de' && l !== 'en') {
      l = (navigator.language || 'en').toLowerCase().indexOf('de') === 0 ? 'de' : 'en';
    }
    document.body.setAttribute('data-lang', l);
    document.documentElement.lang = l;
    var btn = document.getElementById('lang-toggle');
    if (btn) {
      btn.textContent = l === 'de' ? 'EN' : 'DE';
      btn.addEventListener('click', function(){
        var next = document.body.getAttribute('data-lang') === 'de' ? 'en' : 'de';
        document.body.setAttribute('data-lang', next);
        document.documentElement.lang = next;
        btn.textContent = next === 'de' ? 'EN' : 'DE';
        try { localStorage.setItem('pullmd-lang', next); } catch (e) {}
      });
    }
  } catch (e) {}
})();
</script>`;

const LANG_TOGGLE_BTN = `<button type="button" id="lang-toggle" class="lang-toggle" title="Language">DE</button>`;

function escape(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Translations for the small set of dynamic strings the server injects
// (form errors). Static strings live as parallel <span lang="..."> in the
// templates below.
const ERR = {
  'wrong_credentials': {
    de: 'Falsche E-Mail oder falsches Passwort.',
    en: 'Wrong email or password.',
  },
  'passwords_dont_match': {
    de: 'Die Passwörter stimmen nicht überein.',
    en: 'Passwords do not match.',
  },
  'password_too_short': {
    de: 'Das Passwort muss mindestens 8 Zeichen lang sein.',
    en: 'Password must be at least 8 characters.',
  },
  'invalid_email': {
    de: 'Ungültige E-Mail-Adresse.',
    en: 'Invalid email.',
  },
  'email_taken': {
    de: 'Diese E-Mail ist bereits registriert.',
    en: 'That email is already registered.',
  },
  'create_failed': {
    de: 'Konto konnte nicht angelegt werden.',
    en: 'Could not create account.',
  },
};

/**
 * Render an error block as parallel <span lang> when the caller passes a
 * known key, otherwise fall back to a single <span> so legacy/free-form
 * messages still render.
 */
function errorBlock(error) {
  if (!error) return '';
  if (typeof error === 'string' && ERR[error]) {
    const t = ERR[error];
    return `<div class="error"><span lang="de">${escape(t.de)}</span><span lang="en">${escape(t.en)}</span></div>`;
  }
  return `<div class="error">${escape(error)}</div>`;
}

export const _ERR_KEYS = Object.keys(ERR); // exposed for tests

export function loginPage({ error = '', email = '', next = '', mode = '', signupOpen = false } = {}) {
  const hint = mode === 'single-admin'
    ? `<div class="muted env-hint" style="font-size: 0.75rem; margin-top: 0.5rem;">
         <span lang="de">Verwende PULLMD_ADMIN_EMAIL und PULLMD_ADMIN_PASSWORD aus deiner Environment-Konfiguration.</span><span lang="en">Use the PULLMD_ADMIN_EMAIL and PULLMD_ADMIN_PASSWORD from your environment.</span>
       </div>`
    : '';
  // Only render the link when /signup is actually mounted. It is gated on the
  // effective value, not on the mode - see PULLMD_ALLOW_SIGNUP.
  const signupLink = signupOpen
    ? `<div class="muted">
    <a href="/signup"><span lang="de">Konto erstellen</span><span lang="en">Create an account</span></a>
  </div>`
    : '';
  return `<!DOCTYPE html><html lang="de"><head><meta charset="UTF-8"><title>Login — PullMD</title>${PAGE_STYLE}</head>
<body>
<form class="card" method="POST" action="/login">
  <div class="card-head">
    <h1><span lang="de">Bei PullMD anmelden</span><span lang="en">Sign in to PullMD</span></h1>
    ${LANG_TOGGLE_BTN}
  </div>
  ${errorBlock(error)}
  <input type="hidden" name="next" value="${escape(next)}">
  <label>
    <span lang="de">E-Mail</span><span lang="en">Email</span>
    <input type="email" name="email" required autofocus value="${escape(email)}">
  </label>
  <label>
    <span lang="de">Passwort</span><span lang="en">Password</span>
    <input type="password" name="password" required>
  </label>
  <button type="submit"><span lang="de">Anmelden</span><span lang="en">Sign in</span></button>
  ${signupLink}
  ${hint}
</form>
${INIT_LANG_SCRIPT}
</body></html>`;
}

export function signupPage({ error = '', email = '' } = {}) {
  return `<!DOCTYPE html><html lang="de"><head><meta charset="UTF-8"><title>Sign up — PullMD</title>${PAGE_STYLE}</head>
<body>
<form class="card" method="POST" action="/signup">
  <div class="card-head">
    <h1><span lang="de">PullMD-Konto erstellen</span><span lang="en">Create your PullMD account</span></h1>
    ${LANG_TOGGLE_BTN}
  </div>
  ${errorBlock(error)}
  <label>
    <span lang="de">E-Mail</span><span lang="en">Email</span>
    <input type="email" name="email" required autofocus value="${escape(email)}">
  </label>
  <label>
    <span lang="de">Passwort (mindestens 8 Zeichen)</span><span lang="en">Password (min 8 chars)</span>
    <input type="password" name="password" required minlength="8">
  </label>
  <label>
    <span lang="de">Passwort bestätigen</span><span lang="en">Confirm password</span>
    <input type="password" name="password_confirm" required minlength="8">
  </label>
  <button type="submit"><span lang="de">Registrieren</span><span lang="en">Sign up</span></button>
  <div class="muted">
    <a href="/login"><span lang="de">Ich habe bereits ein Konto</span><span lang="en">I already have an account</span></a>
  </div>
</form>
${INIT_LANG_SCRIPT}
</body></html>`;
}

export function settingsPage({ user, keys, newKey = null, error = '' } = {}) {
  const newKeyBlock = newKey
    ? `<div class="new-key-banner">
         <strong>
           <span lang="de">Speichere diesen Schlüssel jetzt — er wird nicht mehr angezeigt:</span>
           <span lang="en">Save this key now — it won't be shown again:</span>
         </strong><br>${escape(newKey)}
       </div>`
    : '';

  const rows = keys.length === 0
    ? `<div class="key-row">
         <span class="key-label">
           <span lang="de">Noch keine API-Schlüssel.</span>
           <span lang="en">No API keys yet.</span>
         </span>
       </div>`
    : keys.map(k => `
      <div class="key-row">
        <div>
          <div class="key-prefix">${escape(k.key_prefix)}…</div>
          <div class="key-label">
            ${escape(k.label || '')}${k.label ? ' · ' : ''}
            <span lang="de">erstellt ${escape(k.created_at)}${k.last_used_at ? ` · zuletzt verwendet ${escape(k.last_used_at)}` : ' · nie verwendet'}</span><span lang="en">created ${escape(k.created_at)}${k.last_used_at ? ` · last used ${escape(k.last_used_at)}` : ' · never used'}</span>
          </div>
        </div>
        <div class="key-actions">
          <form method="POST" action="/api/keys/${k.id}/revoke" data-confirm-de="Diesen Schlüssel widerrufen? Programmatische Clients, die ihn verwenden, schlagen danach fehl." data-confirm-en="Revoke this key? Programmatic clients using it will start failing.">
            <button type="submit"><span lang="de">Widerrufen</span><span lang="en">Revoke</span></button>
          </form>
        </div>
      </div>`).join('');

  return `<!DOCTYPE html><html lang="de"><head><meta charset="UTF-8"><title>Settings — PullMD</title>${PAGE_STYLE}
  <style>
    body { display: block; padding: 2rem; max-width: 40rem; margin: 0 auto; }
    .card { max-width: none; margin-top: 1rem; padding: 1.5rem; }
    .page-head { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 0.5rem; }
  </style></head>
<body>
  <div class="page-head">
    <h1 style="margin:0;"><span lang="de">Einstellungen</span><span lang="en">Settings</span></h1>
    ${LANG_TOGGLE_BTN.replace('class="lang-toggle"', 'class="lang-toggle" style="position:static;"')}
  </div>
  <div class="muted" style="text-align: left; margin: 0 0 1rem;">
    <span lang="de">Angemeldet als ${escape(user.email)}${user.is_admin ? ' (Admin)' : ''}</span><span lang="en">Signed in as ${escape(user.email)}${user.is_admin ? ' (admin)' : ''}</span>
    · <a href="/"><span lang="de">Zurück zu PullMD</span><span lang="en">Back to PullMD</span></a>
    · <form style="display:inline" method="POST" action="/logout"><button type="submit" style="display:inline; padding: 0; background: transparent; color: var(--accent); width:auto;"><span lang="de">Abmelden</span><span lang="en">Log out</span></button></form>
  </div>

  <div class="card">
    <h2 style="font-size:1rem; margin-bottom:0.75rem;"><span lang="de">API-Schlüssel</span><span lang="en">API keys</span></h2>
    ${error ? errorBlock(error) : ''}
    ${newKeyBlock}
    <form method="POST" action="/api/keys" style="display:flex; gap:0.5rem; margin-bottom:0.75rem;">
      <input type="text" name="label" data-i18n-placeholder-de="Bezeichnung (z. B. Claude Code auf cortex)" data-i18n-placeholder-en="Label (e.g. Claude Code on cortex)" style="flex:1;">
      <button type="submit" style="width:auto; padding:0.5rem 0.75rem;"><span lang="de">Erstellen</span><span lang="en">Generate</span></button>
    </form>
    ${rows}
  </div>
${INIT_LANG_SCRIPT}
<script>
(function(){
  function applyDynamic() {
    var l = document.body.getAttribute('data-lang') || 'de';
    document.querySelectorAll('[data-i18n-placeholder-de]').forEach(function(el){
      el.setAttribute('placeholder', el.getAttribute('data-i18n-placeholder-' + l) || '');
    });
    document.querySelectorAll('form[data-confirm-de]').forEach(function(form){
      form.onsubmit = function(){
        return confirm(form.getAttribute('data-confirm-' + l) || '');
      };
    });
  }
  applyDynamic();
  var btn = document.getElementById('lang-toggle');
  if (btn) btn.addEventListener('click', applyDynamic);
})();
</script>
</body></html>`;
}
