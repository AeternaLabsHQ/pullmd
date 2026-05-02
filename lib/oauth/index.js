import express from 'express';
import { createOAuthStore } from './store.js';
import { createTokens } from './tokens.js';
import { createRateLimiter } from './rate-limit.js';

const SCOPE = 'mcp:full';

const HARDCODED_REDIRECT_ALLOWLIST = [
  'https://claude.ai/api/mcp/auth_callback',
  'https://claude.com/api/mcp/auth_callback',
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

export function mountOAuthRoutes(app, oauth) {
  const { issuer, audience, scope } = oauth;

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
}

// Exposed so test files can read it
export { HARDCODED_REDIRECT_ALLOWLIST };
