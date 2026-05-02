function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const SCOPE_DESCRIPTIONS = {
  'mcp:full': {
    de: 'PullMD Vollzugriff: URLs konvertieren und deine History lesen.',
    en: 'PullMD full access: convert URLs and read your history.',
  },
};

function describeScope(scope, lang) {
  const desc = SCOPE_DESCRIPTIONS[scope];
  return desc ? desc[lang] || desc.en : scope;
}

export function consentPage({ client_name, redirect_uri, scope, params, lang = 'de', user_email }) {
  const t = lang === 'de'
    ? {
        title: 'Zugriff autorisieren',
        intro: (name) => `<strong>${escapeHtml(name)}</strong> möchte auf dein PullMD-Konto zugreifen.`,
        loggedIn: (e) => `Angemeldet als <strong>${escapeHtml(e)}</strong>.`,
        wants: 'Angeforderte Berechtigung:',
        redirect: 'Du wirst nach der Bestätigung weitergeleitet zu:',
        allow: 'Zulassen',
        deny: 'Ablehnen',
      }
    : {
        title: 'Authorize access',
        intro: (name) => `<strong>${escapeHtml(name)}</strong> would like to access your PullMD account.`,
        loggedIn: (e) => `Signed in as <strong>${escapeHtml(e)}</strong>.`,
        wants: 'Requested permission:',
        redirect: 'After confirming you will be redirected to:',
        allow: 'Allow',
        deny: 'Deny',
      };

  const hidden = Object.entries(params)
    .map(([k, v]) => `<input type="hidden" name="${escapeHtml(k)}" value="${escapeHtml(v)}">`)
    .join('\n');

  return `<!doctype html>
<html lang="${lang}">
<head>
  <meta charset="utf-8">
  <title>${t.title} — PullMD</title>
  <link rel="stylesheet" href="/styles.css">
  <style>
    body { font-family: system-ui, sans-serif; max-width: 480px; margin: 4rem auto; padding: 0 1rem; }
    .card { padding: 1.5rem; border: 1px solid #ccc; border-radius: 8px; }
    .scope { background: #f4f4f4; padding: 0.75rem; border-radius: 4px; margin: 1rem 0; }
    .redirect { font-family: monospace; font-size: 0.85rem; color: #555; word-break: break-all; }
    .btn-row { display: flex; gap: 0.5rem; margin-top: 1.5rem; }
    button { padding: 0.5rem 1rem; border-radius: 4px; border: 1px solid #888; cursor: pointer; }
    button[name="decision"][value="allow"] { background: #2a6df4; color: white; border-color: #2a6df4; }
  </style>
</head>
<body>
  <div class="card">
    <h1>${t.title}</h1>
    <p>${t.intro(client_name || 'Unknown client')}</p>
    <p>${t.loggedIn(user_email)}</p>
    <p>${t.wants}</p>
    <div class="scope">${escapeHtml(describeScope(scope, lang))}</div>
    <p>${t.redirect}</p>
    <div class="redirect">${escapeHtml(redirect_uri)}</div>
    <form method="POST" action="/oauth/consent">
      ${hidden}
      <div class="btn-row">
        <button type="submit" name="decision" value="allow">${t.allow}</button>
        <button type="submit" name="decision" value="deny">${t.deny}</button>
      </div>
    </form>
  </div>
</body>
</html>`;
}
