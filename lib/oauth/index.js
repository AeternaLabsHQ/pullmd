import express from 'express';
import { createHash as _createHash } from 'node:crypto';
import { createOAuthStore } from './store.js';
import { createTokens } from './tokens.js';
import { createRateLimiter } from './rate-limit.js';
import { consentPage } from './pages.js';
import { verifyPkceS256 } from './pkce.js';

function sha256Hex(s) { return _createHash('sha256').update(s).digest('hex'); }

const SCOPE = 'mcp:full';

const HARDCODED_REDIRECT_ALLOWLIST = [
  'https://claude.ai/api/mcp/auth_callback',
  'https://claude.com/api/mcp/auth_callback',
];

// CORS for OAuth discovery / token / register / revoke and the MCP endpoint.
// MCP clients run in browsers (claude.ai web, MCP Inspector) with arbitrary
// origins, so we use a wildcard. Authorization tokens travel via the header,
// not cookies — Allow-Credentials stays false so the browser is permitted to
// read the response under wildcard origin.
//
// NOT applied to /oauth/authorize (it's a top-level browser redirect, not a
// fetch source) or any Phase-1 endpoint.
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, MCP-Protocol-Version',
  'Access-Control-Expose-Headers': 'WWW-Authenticate',
  'Access-Control-Max-Age': '86400',
};

export function oauthCors(req, res, next) {
  for (const [k, v] of Object.entries(CORS_HEADERS)) res.set(k, v);
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
}

const CORS_OAUTH_PATHS = [
  '/.well-known/oauth-authorization-server',
  '/.well-known/oauth-protected-resource',
  '/oauth/register',
  '/oauth/token',
  '/oauth/revoke',
];

export function createOAuth({ db, auth, env }) {
  if (!auth) throw new Error('createOAuth requires the Phase 1 auth instance');
  const issuer = (env.PUBLIC_URL || '').replace(/\/+$/, '');
  if (!issuer) throw new Error('createOAuth requires PUBLIC_URL to be set');
  const audience = `${issuer}/mcp`;
  const secret = env.OAUTH_JWT_SECRET;
  if (!secret) throw new Error('createOAuth requires OAUTH_JWT_SECRET');

  const store = createOAuthStore({ db });
  const tokens = createTokens({ secret, issuer, audience });

  const limits = {
    token:     createRateLimiter({ windowMs: 60_000, max: 60 }),
    authorize: createRateLimiter({ windowMs: 60_000, max: 60 }),
    register:  createRateLimiter({ windowMs: 60 * 60_000, max: 10 }),
  };

  return { store, tokens, limits, issuer, audience, scope: SCOPE };
}

function isAllowedRedirect(uri, client) {
  if (!uri) return false;
  if (HARDCODED_REDIRECT_ALLOWLIST.includes(uri)) return true;
  try {
    const list = JSON.parse(client.redirect_uris);
    // EXACT match per RFC 6749 §3.1.2
    return Array.isArray(list) && list.includes(uri);
  } catch {
    return false;
  }
}

function buildErrorRedirect(redirect_uri, error, state) {
  const u = new URL(redirect_uri);
  u.searchParams.set('error', error);
  if (state) u.searchParams.set('state', state);
  return u.toString();
}

export function mountOAuthRoutes(app, oauth) {
  const { issuer, audience, scope } = oauth;

  // CORS must run before the route handlers so OPTIONS preflight returns 204
  // without invoking rate limiters or body parsers.
  for (const p of CORS_OAUTH_PATHS) app.use(p, oauthCors);

  app.get('/.well-known/oauth-authorization-server', (_req, res) => {
    res.json({
      issuer,
      authorization_endpoint: `${issuer}/oauth/authorize`,
      token_endpoint: `${issuer}/oauth/token`,
      registration_endpoint: `${issuer}/oauth/register`,
      revocation_endpoint: `${issuer}/oauth/revoke`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none', 'client_secret_post'],
      scopes_supported: [scope],
    });
  });

  app.get('/.well-known/oauth-protected-resource', (_req, res) => {
    res.json({
      resource: audience,
      authorization_servers: [issuer],
      bearer_methods_supported: ['header'],
      scopes_supported: [scope],
    });
  });

  app.post(
    '/oauth/register',
    oauth.limits.register.middleware(),
    express.json({ limit: '8kb' }),
    (req, res) => {
      const body = req.body || {};
      try {
        const { client_id, client_secret } = oauth.store.registerClient({
          redirect_uris: body.redirect_uris,
          client_name: body.client_name,
          token_endpoint_auth_method: body.token_endpoint_auth_method || 'none',
        });
        const out = {
          client_id,
          redirect_uris: body.redirect_uris,
          client_name: body.client_name || null,
          token_endpoint_auth_method: body.token_endpoint_auth_method || 'none',
        };
        if (client_secret) out.client_secret = client_secret;
        return res.status(201).json(out);
      } catch (err) {
        // Normalise all store validation errors to invalid_client_metadata per RFC 7591
        return res.status(400).json({ error: 'invalid_client_metadata', error_description: err.message });
      }
    }
  );

  // express.json's parse-error handler — returns 400 instead of 500 on bad JSON
  app.use('/oauth/register', (err, _req, res, next) => {
    if (err && err.type === 'entity.parse.failed') {
      return res.status(400).json({ error: 'invalid_client_metadata', error_description: 'Malformed JSON' });
    }
    next(err);
  });

  const formParser = express.urlencoded({ extended: false, limit: '8kb' });

  app.get(
    '/oauth/authorize',
    oauth.limits.authorize.middleware(),
    (req, res) => {
      const {
        response_type, client_id, redirect_uri,
        code_challenge, code_challenge_method, state, scope: scopeParam,
      } = req.query;

      // ── Pre-redirect validation (no open redirect possible here) ─────────
      if (!client_id) {
        return res.status(400).json({ error: 'invalid_request', error_description: 'client_id is required' });
      }
      const client = oauth.store.getClient(client_id);
      if (!client) {
        return res.status(400).json({ error: 'invalid_client', error_description: 'Unknown client_id' });
      }
      if (!redirect_uri || typeof redirect_uri !== 'string') {
        return res.status(400).json({ error: 'invalid_request', error_description: 'redirect_uri is required' });
      }
      if (!isAllowedRedirect(redirect_uri, client)) {
        return res.status(400).json({ error: 'invalid_request', error_description: 'redirect_uri not in client allowlist' });
      }

      // ── Post-redirect validation ──────────────────────────────────────────
      if (response_type !== 'code') {
        return res.redirect(302, buildErrorRedirect(redirect_uri, 'unsupported_response_type', state));
      }
      // PKCE method and state are required — return 400 directly (can't safely
      // encode these errors into a redirect without a trusted state value).
      if (code_challenge_method !== 'S256') {
        return res.status(400).json({ error: 'invalid_request', error_description: 'code_challenge_method must be S256' });
      }
      if (!code_challenge || typeof code_challenge !== 'string') {
        return res.status(400).json({ error: 'invalid_request', error_description: 'code_challenge is required' });
      }
      if (!state) {
        return res.status(400).json({ error: 'invalid_request', error_description: 'state is required' });
      }
      const scope = scopeParam || oauth.scope;
      if (scope !== oauth.scope) {
        return res.redirect(302, buildErrorRedirect(redirect_uri, 'invalid_scope', state));
      }

      // ── Auth check (Phase-1 session) ─────────────────────────────────────
      if (!req.user) {
        const next = encodeURIComponent(req.originalUrl);
        return res.redirect(302, `/login?next=${next}`);
      }

      // ── Render consent page ──────────────────────────────────────────────
      const lang = (req.headers['accept-language'] || '').toLowerCase().startsWith('de') ? 'de' : 'en';
      res.set('Content-Type', 'text/html; charset=utf-8');
      res.send(consentPage({
        client_name: client.client_name || client.client_id,
        redirect_uri,
        scope,
        params: { client_id, redirect_uri, code_challenge, code_challenge_method, state, scope },
        lang,
        user_email: req.user.email,
      }));
    }
  );

  app.post(
    '/oauth/consent',
    oauth.limits.authorize.middleware(),
    formParser,
    (req, res) => {
      if (!req.user) {
        return res.status(401).json({ error: 'login_required' });
      }
      const {
        decision, client_id, redirect_uri, code_challenge, code_challenge_method, state, scope: scopeParam,
      } = req.body || {};

      const client = oauth.store.getClient(client_id);
      if (!client) return res.status(400).json({ error: 'invalid_client' });
      if (!isAllowedRedirect(redirect_uri, client)) {
        return res.status(400).json({ error: 'invalid_request', error_description: 'redirect_uri changed' });
      }
      if (code_challenge_method !== 'S256' || !code_challenge) {
        return res.status(400).json({ error: 'invalid_request' });
      }
      const scope = scopeParam || oauth.scope;

      if (decision !== 'allow') {
        return res.redirect(302, buildErrorRedirect(redirect_uri, 'access_denied', state));
      }

      const { code } = oauth.store.createAuthCode({
        client_id,
        user_id: req.user.id,
        redirect_uri,
        code_challenge,
        code_challenge_method,
        scope,
      });
      const u = new URL(redirect_uri);
      u.searchParams.set('code', code);
      if (state) u.searchParams.set('state', state);
      return res.redirect(302, u.toString());
    }
  );

  app.post(
    '/oauth/revoke',
    oauth.limits.token.middleware(),
    express.urlencoded({ extended: false, limit: '8kb' }),
    (req, res) => {
      const { token, client_id, client_secret } = req.body || {};
      if (!client_id) {
        return res.status(400).json({ error: 'invalid_request', error_description: 'client_id is required' });
      }
      const client = oauth.store.getClient(client_id);
      // RFC 7009 §2.1: invalid client → 401, but for unknown token still 200.
      if (!client) {
        return res.status(401).json({ error: 'invalid_client' });
      }
      if (client.token_endpoint_auth_method === 'client_secret_post') {
        if (!client_secret || !oauth.store.verifyClientSecret(client_id, client_secret)) {
          return res.status(401).json({ error: 'invalid_client' });
        }
      }
      if (token) {
        const hash = oauth.tokens.hashRefreshToken(token);
        oauth.store.revokeRefreshToken(hash);
      }
      return res.status(200).end();
    }
  );

  app.post(
    '/oauth/token',
    oauth.limits.token.middleware(),
    express.urlencoded({ extended: false, limit: '8kb' }),
    express.json({ limit: '8kb' }),
    async (req, res) => {
      const body = req.body || {};
      const grant = body.grant_type;

      if (grant === 'authorization_code') {
        return await handleCodeExchange(req, res, oauth, body);
      }
      if (grant === 'refresh_token') {
        return await handleRefresh(req, res, oauth, body);
      }
      return res.status(400).json({
        error: 'unsupported_grant_type',
        error_description: 'Supported grant_type values: authorization_code, refresh_token',
      });
    }
  );
}

async function handleCodeExchange(req, res, oauth, body) {
  const { code, code_verifier, redirect_uri, client_id, client_secret } = body;
  if (!code || !code_verifier || !redirect_uri || !client_id) {
    return res.status(400).json({ error: 'invalid_request', error_description: 'code, code_verifier, redirect_uri, client_id are required' });
  }
  const client = oauth.store.getClient(client_id);
  if (!client) {
    return res.status(401).json({ error: 'invalid_client' });
  }
  if (client.token_endpoint_auth_method === 'client_secret_post') {
    if (!client_secret || !oauth.store.verifyClientSecret(client_id, client_secret)) {
      return res.status(401).json({ error: 'invalid_client' });
    }
  }

  const codeHash = sha256Hex(code);
  const row = oauth.store.consumeAuthCode(codeHash);
  if (!row) {
    return res.status(400).json({ error: 'invalid_grant', error_description: 'Code is invalid, expired, or already used' });
  }
  if (row.client_id !== client_id) {
    return res.status(400).json({ error: 'invalid_grant', error_description: 'client_id does not match the code' });
  }
  if (row.redirect_uri !== redirect_uri) {
    return res.status(400).json({ error: 'invalid_grant', error_description: 'redirect_uri does not match' });
  }
  if (!verifyPkceS256(code_verifier, row.code_challenge)) {
    return res.status(400).json({ error: 'invalid_grant', error_description: 'PKCE verification failed' });
  }

  return await issueTokenPair(res, oauth, {
    user_id: row.user_id, client_id, scope: row.scope,
  });
}

async function handleRefresh(req, res, oauth, body) {
  const { refresh_token, client_id, client_secret } = body;
  if (!refresh_token || !client_id) {
    return res.status(400).json({ error: 'invalid_request', error_description: 'refresh_token and client_id are required' });
  }
  const client = oauth.store.getClient(client_id);
  if (!client) {
    return res.status(401).json({ error: 'invalid_client' });
  }
  if (client.token_endpoint_auth_method === 'client_secret_post') {
    if (!client_secret || !oauth.store.verifyClientSecret(client_id, client_secret)) {
      return res.status(401).json({ error: 'invalid_client' });
    }
  }

  const tokenHash = oauth.tokens.hashRefreshToken(refresh_token);
  const row = oauth.store.findRefreshToken(tokenHash);
  if (!row) {
    return res.status(400).json({ error: 'invalid_grant', error_description: 'Unknown refresh token' });
  }
  if (row.client_id !== client_id) {
    return res.status(400).json({ error: 'invalid_grant', error_description: 'client_id does not match the refresh token' });
  }

  // ── Reuse detection: this token has already been rotated or revoked ─────
  if (row.revoked_at) {
    oauth.store.invalidateRefreshChain({ user_id: row.user_id, client_id: row.client_id });
    return res.status(400).json({ error: 'invalid_grant', error_description: 'Refresh token reuse detected — chain invalidated' });
  }
  if (new Date(row.expires_at).getTime() < Date.now()) {
    return res.status(400).json({ error: 'invalid_grant', error_description: 'Refresh token expired' });
  }

  // ── Rotate ──────────────────────────────────────────────────────────────
  const { token: newToken, tokenHash: newHash } = oauth.tokens.generateRefreshToken();
  const expiresAt = new Date(Date.now() + oauth.tokens.REFRESH_TOKEN_TTL_SEC * 1000).toISOString();
  oauth.store.rotateRefreshToken({
    oldHash: tokenHash, newHash,
    client_id: row.client_id, user_id: row.user_id, scope: row.scope, expiresAt,
  });

  const access_token = await oauth.tokens.issueAccessToken({ sub: row.user_id, scope: row.scope });
  oauth.store.bumpClientLastUsed(client_id);
  return res.json({
    access_token,
    token_type: 'Bearer',
    expires_in: oauth.tokens.ACCESS_TOKEN_TTL_SEC,
    refresh_token: newToken,
    scope: row.scope,
  });
}

async function issueTokenPair(res, oauth, { user_id, client_id, scope }) {
  const access_token = await oauth.tokens.issueAccessToken({ sub: user_id, scope });
  const { token: refresh_token, tokenHash } = oauth.tokens.generateRefreshToken();
  const expiresAt = new Date(Date.now() + oauth.tokens.REFRESH_TOKEN_TTL_SEC * 1000).toISOString();
  oauth.store.insertRefreshToken({
    tokenHash, client_id, user_id, scope, expiresAt, rotated_from: null,
  });
  oauth.store.bumpClientLastUsed(client_id);
  return res.json({
    access_token,
    token_type: 'Bearer',
    expires_in: oauth.tokens.ACCESS_TOKEN_TTL_SEC,
    refresh_token,
    scope,
  });
}

// Exposed so test files can read it
export { HARDCODED_REDIRECT_ALLOWLIST };
