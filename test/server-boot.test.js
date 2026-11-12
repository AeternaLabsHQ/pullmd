import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { formatBootstrapError } from '../lib/auth.js';
import { computeRecipesHash } from '../lib/recipes.js';

// Boots `node server.js` for real. Nothing else executes the startup block at
// the bottom of server.js (cache, auth migration, recipes, OAuth, listen).

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_RECIPES = path.join(ROOT, 'site-recipes.default.json');
const BOOT_DEADLINE_MS = 20000;

const children = new Set();
let dir;

before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pullmd-boot-')); });
after(() => {
  // Last line of defence: no server may outlive this file, whatever failed.
  for (const child of children) child.kill('SIGKILL');
  fs.rmSync(dir, { recursive: true, force: true });
});

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/**
 * Spawns server.js. cwd must be the checkout (public/ and
 * site-recipes.default.json are resolved from it); every write goes to `dir`.
 * The env is built from scratch, so no sidecar URL (TRAFILATURA_URL,
 * PLAYWRIGHT_URL, MARKITDOWN_URL), API key or auth setting leaks in from the
 * machine running the tests.
 */
function spawnServer(name, port, env = {}) {
  const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    env: {
      PATH: process.env.PATH,
      PORT: String(port),
      CACHE_DB: path.join(dir, `${name}.db`),
      // Explicit path: keeps ./data/site-recipes.json of the checkout out of it.
      PULLMD_SITE_RECIPES: path.join(dir, `${name}-recipes.json`),
      // Empty = never refresh the user-agent pool from the network.
      PULLMD_UA_FEED_URL: '',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.add(child);
  child.out = '';
  child.err = '';
  child.stdout.on('data', (d) => { child.out += d; });
  child.stderr.on('data', (d) => { child.err += d; });
  child.closed = new Promise((resolve) => {
    child.on('close', (code, signal) => { children.delete(child); resolve({ code, signal }); });
  });
  return child;
}

// Resolves once the listening line is printed; rejects if the child dies first.
function listening(child) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`server did not start within ${BOOT_DEADLINE_MS} ms\nstdout: ${child.out}\nstderr: ${child.err}`));
    }, BOOT_DEADLINE_MS);
    const check = () => {
      if (!child.out.includes('PullMD running on')) return;
      clearTimeout(timer);
      resolve();
    };
    child.stdout.on('data', check);
    child.closed.then(({ code, signal }) => {
      clearTimeout(timer);
      reject(new Error(`server exited before listening (code ${code}, signal ${signal})\nstderr: ${child.err}`));
    });
    check();
  });
}

// Picks a free port and boots; retries when another process grabbed the port
// between the probe and the listen.
async function boot(name, envFor = () => ({})) {
  for (let attempt = 1; ; attempt++) {
    const port = await freePort();
    const child = spawnServer(name, port, envFor(port));
    try {
      await listening(child);
      return { child, port, base: `http://127.0.0.1:${port}` };
    } catch (err) {
      child.kill('SIGKILL');
      await child.closed;
      if (attempt < 3 && child.err.includes('EADDRINUSE')) continue;
      throw err;
    }
  }
}

async function stop(child) {
  child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
  const result = await child.closed;
  clearTimeout(timer);
  return result;
}

async function assertGone(child, port) {
  assert.ok(child.exitCode !== null || child.signalCode !== null, 'the child process must have ended');
  await assert.rejects(fetch(`http://127.0.0.1:${port}/api/status`), 'the port must be closed after shutdown');
}

function readMeta(name) {
  const db = new Database(path.join(dir, `${name}.db`), { readonly: true });
  try {
    return Object.fromEntries(db.prepare('SELECT key, value FROM meta').all().map((r) => [r.key, r.value]));
  } finally {
    db.close();
  }
}

// Boots are independent (own port, own database), so they run side by side.
describe('node server.js', { concurrency: true }, () => {
  it('boots without auth and serves the app and its status', async () => {
    const name = 'plain';
    const recipes = path.join(dir, `${name}-recipes.json`);
    fs.writeFileSync(recipes, JSON.stringify([{ name: 'boot-test', host: 'boot.example.com' }]));

    const { child, port, base } = await boot(name, () => ({ PULLMD_CACHE_RETENTION_DAYS: '7' }));
    try {
      assert.ok(child.out.includes(`PullMD running on http://localhost:${port} (auth: disabled)`), child.out);
      assert.match(child.out, /OAuth disabled/);

      const home = await fetch(`${base}/`);
      assert.equal(home.status, 200);
      assert.match(home.headers.get('content-type'), /text\/html/);
      assert.match(await home.text(), /<html/i);

      const status = await fetch(`${base}/api/status`);
      assert.equal(status.status, 200);
      const body = await status.json();
      assert.equal(body.ok, true);
      assert.equal(body.version, JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version);
      for (const [svc, state] of Object.entries(body.services)) {
        assert.equal(state.status, 'not-configured', `sidecar ${svc} must not be configured in the test env`);
      }

      // Both recipe files were loaded at boot.
      const recipeStatus = await (await fetch(`${base}/api/recipes/status`)).json();
      assert.equal(recipeStatus.rejected, 0);
      assert.deepEqual(recipeStatus.sources.map((s) => s.path), [DEFAULT_RECIPES, recipes]);
      assert.equal(recipeStatus.sources[1].loaded, 1);
      assert.ok(recipeStatus.sources[0].loaded > 0);

      // The app got the cache on the temp database, with the retention from the env.
      const storage = await (await fetch(`${base}/api/storage`)).json();
      assert.equal(storage.total, 0);
      assert.equal(storage.retentionDays, 7);
      assert.ok(storage.dbSizeBytes > 0, 'storage stats must come from the database file');
      assert.ok(fs.existsSync(path.join(dir, `${name}.db`)));
      assert.equal((await (await fetch(`${base}/api/config`)).json()).authMode, 'disabled');

      // No OAuth without OAUTH_JWT_SECRET.
      assert.equal((await fetch(`${base}/.well-known/oauth-authorization-server`)).status, 404);
    } finally {
      await stop(child);
    }
    await assertGone(child, port);
    assert.equal(child.err.includes('Error'), false, `unexpected error output: ${child.err}`);

    // First boot records the recipe hash but invalidates nothing.
    const firstMeta = readMeta(name);
    assert.equal(firstMeta.recipes_hash, computeRecipesHash([DEFAULT_RECIPES, recipes]));
    assert.equal(firstMeta.recipes_invalidated_at, undefined);

    // Changed recipes + reboot on the same database: cache rows get invalidated.
    fs.writeFileSync(recipes, JSON.stringify([{ name: 'boot-test', host: 'changed.example.com' }]));
    const second = await boot(name, () => ({ PULLMD_CACHE_RETENTION_DAYS: '7' }));
    try {
      assert.equal((await fetch(`${second.base}/api/status`)).status, 200);
    } finally {
      await stop(second.child);
    }
    await assertGone(second.child, second.port);
    const secondMeta = readMeta(name);
    assert.equal(secondMeta.recipes_hash, computeRecipesHash([DEFAULT_RECIPES, recipes]));
    assert.notEqual(secondMeta.recipes_hash, firstMeta.recipes_hash);
    assert.match(secondMeta.recipes_invalidated_at, /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/);
  });

  it('boots with multi-user auth and OAuth and answers the discovery endpoints', async () => {
    const name = 'oauth';
    const { child, port, base } = await boot(name, (p) => ({
      PULLMD_AUTH_MODE: 'multi-user',
      PULLMD_ADMIN_EMAIL: 'admin@example.com',
      PULLMD_ADMIN_PASSWORD: 'pw1234567',
      OAUTH_JWT_SECRET: 'x'.repeat(48),
      PUBLIC_URL: `http://127.0.0.1:${p}/`,
    }));
    try {
      assert.ok(child.out.includes(`(auth: multi-user)`), child.out);
      assert.doesNotMatch(child.out, /OAuth disabled/);

      const as = await fetch(`${base}/.well-known/oauth-authorization-server`);
      assert.equal(as.status, 200);
      const meta = await as.json();
      // The trailing slash of PUBLIC_URL is dropped from the issuer.
      assert.equal(meta.issuer, base);
      assert.equal(meta.token_endpoint, `${base}/oauth/token`);
      assert.equal(meta.authorization_endpoint, `${base}/oauth/authorize`);
      assert.deepEqual(meta.code_challenge_methods_supported, ['S256']);

      const pr = await fetch(`${base}/.well-known/oauth-protected-resource`);
      assert.equal(pr.status, 200);
      assert.deepEqual((await pr.json()).authorization_servers, [base]);

      assert.equal((await fetch(`${base}/api/status`)).status, 200);
      assert.equal((await (await fetch(`${base}/api/config`)).json()).authMode, 'multi-user');

      // Auth is really on, and the access-token verifier wired at boot rejects
      // a token it did not issue instead of crashing.
      assert.equal((await fetch(`${base}/api/history`, { redirect: 'manual' })).status, 401);
      const mcp = await fetch(`${base}/mcp`, {
        method: 'POST',
        headers: { Authorization: 'Bearer not-a-real-token', 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
      });
      assert.equal(mcp.status, 401);
      assert.equal((await fetch(`${base}/api/status`)).status, 200, 'the server must survive the bad token');
    } finally {
      await stop(child);
    }
    await assertGone(child, port);

    // The migration bootstrapped the admin from the env.
    const db = new Database(path.join(dir, `${name}.db`), { readonly: true });
    try {
      assert.deepEqual(db.prepare('SELECT email, is_admin FROM users').all(), [{ email: 'admin@example.com', is_admin: 1 }]);
    } finally {
      db.close();
    }
  });

  it('exits 1 with the bootstrap help when auth is on but no admin credentials are set', async () => {
    const port = await freePort();
    const child = spawnServer('misconfigured', port, { PULLMD_AUTH_MODE: 'multi-user' });
    const timer = setTimeout(() => child.kill('SIGKILL'), BOOT_DEADLINE_MS);
    const { code, signal } = await child.closed;
    clearTimeout(timer);

    assert.equal(signal, null, 'the server must exit on its own');
    assert.equal(code, 1);
    assert.ok(child.err.includes(formatBootstrapError('multi-user')), child.err);
    assert.match(child.err, /PULLMD_ADMIN_EMAIL/);
    assert.doesNotMatch(child.err, /\n\s+at /, 'a configuration error must not print a stack trace');
    assert.doesNotMatch(child.out, /PullMD running on/);
    await assertGone(child, port);
  });

  it('exits 1 when OAuth is requested without PUBLIC_URL', async () => {
    const port = await freePort();
    const child = spawnServer('oauth-misconfigured', port, { OAUTH_JWT_SECRET: 'x'.repeat(48) });
    const timer = setTimeout(() => child.kill('SIGKILL'), BOOT_DEADLINE_MS);
    const { code, signal } = await child.closed;
    clearTimeout(timer);

    assert.equal(signal, null, 'the server must exit on its own');
    assert.equal(code, 1);
    assert.match(child.err, /OAuth setup failed: createOAuth requires PUBLIC_URL to be set/);
    assert.doesNotMatch(child.out, /PullMD running on/);
    await assertGone(child, port);
  });
});
