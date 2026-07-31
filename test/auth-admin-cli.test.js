import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createCache } from '../lib/cache.js';
import { createAuth } from '../lib/auth.js';
import { resetPassword, listUsers, makeAdmin, createUserCmd } from '../scripts/admin.js';

const fastOpts = { timeCost: 1, memoryCost: 1024, parallelism: 1 };
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

describe('admin CLI commands', () => {
  let cache, auth;
  beforeEach(async () => {
    cache = createCache(':memory:');
    auth = createAuth({
      db: cache.db, mode: 'multi-user',
      env: { PULLMD_ADMIN_EMAIL: 'a@b.c', PULLMD_ADMIN_PASSWORD: 'pw1234567' },
      argon2Opts: fastOpts,
    });
    await auth.runMigration();
    await auth.createUser({ email: 'other@x.y', password: 'pw1234567' });
  });

  it('listUsers returns all users', () => {
    const users = listUsers({ db: cache.db });
    assert.equal(users.length, 2);
    const emails = users.map(u => u.email).sort();
    assert.deepEqual(emails, ['a@b.c', 'other@x.y']);
  });

  it('resetPassword updates the hash and invalidates sessions', async () => {
    const u = cache.db.prepare("SELECT id FROM users WHERE email = ?").get('other@x.y');
    auth.createSession(u.id);
    assert.equal(cache.db.prepare("SELECT COUNT(*) c FROM sessions WHERE user_id = ?").get(u.id).c, 1);

    const ok = await resetPassword({ db: cache.db, auth }, 'other@x.y', 'newpass1234');
    assert.equal(ok, true);
    assert.equal(await auth.authenticate('other@x.y', 'pw1234567'), null);
    const reauth = await auth.authenticate('other@x.y', 'newpass1234');
    assert.ok(reauth);
    assert.equal(cache.db.prepare("SELECT COUNT(*) c FROM sessions WHERE user_id = ?").get(u.id).c, 0);
  });

  it('resetPassword returns false for unknown email', async () => {
    const ok = await resetPassword({ db: cache.db, auth }, 'ghost@nowhere', 'pw1234567');
    assert.equal(ok, false);
  });

  it('makeAdmin promotes a user', () => {
    const ok = makeAdmin({ db: cache.db }, 'other@x.y');
    assert.equal(ok, true);
    const u = cache.db.prepare("SELECT is_admin FROM users WHERE email = ?").get('other@x.y');
    assert.equal(u.is_admin, 1);
  });
});

describe('admin CLI create-user', () => {
  let cache, auth;
  beforeEach(async () => {
    cache = createCache(':memory:');
    auth = createAuth({
      db: cache.db, mode: 'multi-user',
      env: { PULLMD_ADMIN_EMAIL: 'a@b.c', PULLMD_ADMIN_PASSWORD: 'pw1234567' },
      argon2Opts: fastOpts,
    });
    await auth.runMigration();
    await auth.createUser({ email: 'other@x.y', password: 'pw1234567' });
  });

  it('creates a non-admin user that can authenticate', async () => {
    const r = await createUserCmd({ db: cache.db, auth }, 'fresh@x.y', 'pw1234567');

    assert.equal(r.ok, true);
    assert.equal(r.user.email, 'fresh@x.y');
    assert.equal(r.user.is_admin, false);
    const u = await auth.authenticate('fresh@x.y', 'pw1234567');
    assert.ok(u, 'the new user must be able to log in');
    assert.equal(u.is_admin, false);
  });

  it('normalises the email like signup does', async () => {
    const r = await createUserCmd({ db: cache.db, auth }, '  MiXeD@X.Y  ', 'pw1234567');

    assert.equal(r.ok, true);
    assert.equal(r.user.email, 'mixed@x.y');
  });

  it('refuses a duplicate email without throwing', async () => {
    const r = await createUserCmd({ db: cache.db, auth }, 'other@x.y', 'pw1234567');

    assert.equal(r.ok, false);
    assert.equal(r.reason, 'exists');
    assert.equal(cache.db.prepare("SELECT COUNT(*) c FROM users WHERE email = ?").get('other@x.y').c, 1);
  });

  it('refuses a duplicate that differs only in case', async () => {
    const r = await createUserCmd({ db: cache.db, auth }, 'OTHER@X.Y', 'pw1234567');

    assert.equal(r.ok, false);
    assert.equal(r.reason, 'exists');
  });

  it('refuses a short password', async () => {
    const r = await createUserCmd({ db: cache.db, auth }, 'short@x.y', 'pw1');

    assert.equal(r.ok, false);
    assert.equal(r.reason, 'invalid');
    assert.match(r.message, /at least 8/);
  });

  it('refuses an invalid email', async () => {
    const r = await createUserCmd({ db: cache.db, auth }, 'not-an-email', 'pw1234567');

    assert.equal(r.ok, false);
    assert.equal(r.reason, 'invalid');
  });
});

describe('admin CLI create-user integration (non-TTY stdin)', () => {
  it('reads password from piped stdin and creates the user', async () => {
    const tmpDbPath = path.join(os.tmpdir(), `pullmd-cli-test-${Date.now()}-${Math.random().toString(16).slice(2)}.db`);

    try {
      // Spawn the CLI with piped stdin
      const proc = execFile('node', ['scripts/admin.js', 'create-user', 'someone@example.com'], {
        cwd: ROOT,
        env: {
          ...process.env,
          CACHE_DB: tmpDbPath,
          PULLMD_AUTH_MODE: 'multi-user',
          PULLMD_ADMIN_EMAIL: 'admin@x.y',
          PULLMD_ADMIN_PASSWORD: 'pw1234567',
        },
        timeout: 30000, // 30 seconds, accounting for argon2 cost
      });

      // Write password to stdin
      proc.stdin.write('pw1234567\n');
      proc.stdin.end();

      // Wait for process to complete
      const { stdout, stderr } = await new Promise((resolve, reject) => {
        let stdoutData = '';
        let stderrData = '';
        proc.stdout.on('data', (d) => { stdoutData += d; });
        proc.stderr.on('data', (d) => { stderrData += d; });
        proc.on('error', reject);
        proc.on('exit', (code) => {
          if (code === 0) {
            resolve({ stdout: stdoutData, stderr: stderrData });
          } else {
            reject(new Error(`CLI exited with code ${code}: ${stderrData}`));
          }
        });
      });

      // Verify the user was created in the database
      const dbCache = createCache(tmpDbPath);
      const user = dbCache.db.prepare("SELECT id, email, is_admin FROM users WHERE email = ?").get('someone@example.com');
      assert.ok(user, 'user should exist in the database');
      assert.equal(user.email, 'someone@example.com');
      assert.equal(user.is_admin, 0);
      assert.match(stdout, /Created someone@example\.com.*no admin rights/);
      assert.equal(stderr, '');
    } finally {
      // Clean up
      if (fs.existsSync(tmpDbPath)) {
        fs.unlinkSync(tmpDbPath);
      }
    }
  });
});

describe('admin CLI list-users without any bootstrap env (regression for runMigration removal)', () => {
  it('exits 0, reports no users, and leaves the users table empty', async () => {
    const tmpDbPath = path.join(os.tmpdir(), `pullmd-cli-test-${Date.now()}-${Math.random().toString(16).slice(2)}.db`);

    try {
      // Deliberately no PULLMD_AUTH_MODE, PULLMD_ADMIN_EMAIL or PULLMD_ADMIN_PASSWORD.
      // Built explicitly (not spread from process.env) so the test does not
      // depend on the caller's shell environment.
      const proc = execFile(process.execPath, ['scripts/admin.js', 'list-users'], {
        cwd: ROOT,
        env: {
          CACHE_DB: tmpDbPath,
        },
        timeout: 30000,
      });

      const { stdout, stderr, code } = await new Promise((resolve, reject) => {
        let stdoutData = '';
        let stderrData = '';
        proc.stdout.on('data', (d) => { stdoutData += d; });
        proc.stderr.on('data', (d) => { stderrData += d; });
        proc.on('error', reject);
        proc.on('exit', (exitCode) => {
          resolve({ stdout: stdoutData, stderr: stderrData, code: exitCode });
        });
      });

      assert.equal(code, 0, `expected exit 0, got ${code}. stderr: ${stderr}`);
      assert.match(stdout, /\(no users yet\)/);

      // The important assertion: no bootstrap admin was created as a side effect.
      const dbCache = createCache(tmpDbPath);
      const count = dbCache.db.prepare("SELECT COUNT(*) c FROM users").get().c;
      assert.equal(count, 0, 'the users table must remain empty');
    } finally {
      if (fs.existsSync(tmpDbPath)) {
        fs.unlinkSync(tmpDbPath);
      }
    }
  });
});
