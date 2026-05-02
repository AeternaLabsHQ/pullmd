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
}

// Exposed so test files can read it
export { HARDCODED_REDIRECT_ALLOWLIST };
