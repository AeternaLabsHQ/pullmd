import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';

function sha256Hex(s) {
  return createHash('sha256').update(s).digest('hex');
}

function timingSafeEqString(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

function validateRedirectUris(uris) {
  if (!Array.isArray(uris) || uris.length === 0) {
    const e = new Error('redirect_uris must be a non-empty array');
    e.code = 'invalid_redirect_uri';
    throw e;
  }
  for (const u of uris) {
    if (typeof u !== 'string') {
      const e = new Error('redirect_uri must be a string');
      e.code = 'invalid_redirect_uri';
      throw e;
    }
    let parsed;
    try { parsed = new URL(u); } catch {
      const e = new Error(`redirect_uri is not a valid URL: ${u}`);
      e.code = 'invalid_redirect_uri';
      throw e;
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      const e = new Error(`redirect_uri must be http(s): ${u}`);
      e.code = 'invalid_redirect_uri';
      throw e;
    }
  }
}

export function createOAuthStore({ db }) {
  const stmts = {
    insertClient: db.prepare(`
      INSERT INTO oauth_clients (client_id, client_secret_hash, redirect_uris, client_name, token_endpoint_auth_method, created_via)
      VALUES (?, ?, ?, ?, ?, ?)
    `),
    getClient: db.prepare(`SELECT * FROM oauth_clients WHERE client_id = ?`),
    bumpClientUsed: db.prepare(`UPDATE oauth_clients SET last_used_at = datetime('now') WHERE client_id = ?`),
    insertCode: db.prepare(`
      INSERT INTO oauth_auth_codes (code_hash, client_id, user_id, redirect_uri, code_challenge, code_challenge_method, scope, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `),
    getCode: db.prepare(`SELECT * FROM oauth_auth_codes WHERE code_hash = ?`),
    markCodeUsed: db.prepare(`UPDATE oauth_auth_codes SET used_at = datetime('now') WHERE code_hash = ?`),
    pruneCodes: db.prepare(`DELETE FROM oauth_auth_codes WHERE expires_at < datetime('now', '-1 hour')`),
    insertRefresh: db.prepare(`
      INSERT INTO oauth_refresh_tokens (token_hash, client_id, user_id, scope, rotated_from, expires_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `),
    getRefresh: db.prepare(`SELECT * FROM oauth_refresh_tokens WHERE token_hash = ?`),
    revokeRefresh: db.prepare(`UPDATE oauth_refresh_tokens SET revoked_at = datetime('now') WHERE token_hash = ? AND revoked_at IS NULL`),
    revokeChain: db.prepare(`UPDATE oauth_refresh_tokens SET revoked_at = datetime('now') WHERE user_id = ? AND client_id = ? AND revoked_at IS NULL`),
  };

  function registerClient({ redirect_uris, client_name, token_endpoint_auth_method }) {
    validateRedirectUris(redirect_uris);
    if (!['none', 'client_secret_post'].includes(token_endpoint_auth_method)) {
      const e = new Error('token_endpoint_auth_method must be "none" or "client_secret_post"');
      e.code = 'invalid_client_metadata';
      throw e;
    }
    const client_id = 'pmd_oc_' + randomBytes(16).toString('hex');
    let client_secret;
    let client_secret_hash = null;
    if (token_endpoint_auth_method === 'client_secret_post') {
      client_secret = randomBytes(32).toString('base64url');
      client_secret_hash = sha256Hex(client_secret);
    }
    stmts.insertClient.run(
      client_id,
      client_secret_hash,
      JSON.stringify(redirect_uris),
      client_name || null,
      token_endpoint_auth_method,
      'dcr'
    );
    return { client_id, client_secret };
  }

  function getClient(client_id) {
    return stmts.getClient.get(client_id) || null;
  }

  function verifyClientSecret(client_id, secret) {
    const c = getClient(client_id);
    if (!c || !c.client_secret_hash) return false;
    return timingSafeEqString(c.client_secret_hash, sha256Hex(secret));
  }

  function bumpClientLastUsed(client_id) {
    stmts.bumpClientUsed.run(client_id);
  }

  // ── Auth codes ────────────────────────────────────────────────────────────
  const CODE_TTL_SEC = 10 * 60;

  function createAuthCode({ client_id, user_id, redirect_uri, code_challenge, code_challenge_method, scope }) {
    const code = randomBytes(32).toString('base64url');
    const codeHash = sha256Hex(code);
    const expiresAt = new Date(Date.now() + CODE_TTL_SEC * 1000).toISOString();
    stmts.insertCode.run(codeHash, client_id, user_id, redirect_uri, code_challenge, code_challenge_method, scope, expiresAt);
    stmts.pruneCodes.run();
    return { code, codeHash };
  }

  function consumeAuthCode(codeHash) {
    const row = stmts.getCode.get(codeHash);
    if (!row) return null;
    if (row.used_at) return null;
    if (new Date(row.expires_at).getTime() < Date.now()) return null;
    stmts.markCodeUsed.run(codeHash);
    return row;
  }

  function invalidateAuthCode(codeHash) {
    stmts.markCodeUsed.run(codeHash);
  }

  // ── Refresh tokens ────────────────────────────────────────────────────────
  function insertRefreshToken({ tokenHash, client_id, user_id, scope, expiresAt, rotated_from }) {
    stmts.insertRefresh.run(tokenHash, client_id, user_id, scope, rotated_from || null, expiresAt);
    return tokenHash;
  }

  function findRefreshToken(tokenHash) {
    return stmts.getRefresh.get(tokenHash) || null;
  }

  function isUsable(row) {
    if (!row) return false;
    if (row.revoked_at) return false;
    if (new Date(row.expires_at).getTime() < Date.now()) return false;
    return true;
  }

  function rotateRefreshToken({ oldHash, newHash, client_id, user_id, scope, expiresAt }) {
    const txn = db.transaction(() => {
      stmts.revokeRefresh.run(oldHash);
      stmts.insertRefresh.run(newHash, client_id, user_id, scope, oldHash, expiresAt);
    });
    txn();
    return newHash;
  }

  function invalidateRefreshChain({ user_id, client_id }) {
    stmts.revokeChain.run(user_id, client_id);
  }

  function revokeRefreshToken(tokenHash) {
    stmts.revokeRefresh.run(tokenHash);
  }

  return {
    registerClient,
    getClient,
    verifyClientSecret,
    bumpClientLastUsed,
    createAuthCode,
    consumeAuthCode,
    invalidateAuthCode,
    insertRefreshToken,
    findRefreshToken,
    isUsable,
    rotateRefreshToken,
    invalidateRefreshChain,
    revokeRefreshToken,
  };
}
