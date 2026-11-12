import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createCache } from '../lib/cache.js';
import { createAuth } from '../lib/auth.js';

// Runs scripts/admin.js as a child process against a temp database and checks
// exit code, output and the effect in the database. Passwords always arrive on
// piped stdin: the raw-mode TTY branch of readPassword() needs a pty and is
// not covered here.

const fastOpts = { timeCost: 1, memoryCost: 1024, parallelism: 1 };
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const ADMIN_JS = path.join(ROOT, 'scripts', 'admin.js');

const OLD_PW = 'altes-passwort';
const NEW_PW = 'neues-passwort';

let dir;
let dbPath;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pullmd-admin-cli-'));
  dbPath = path.join(dir, 'cache.db');
});
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

// Opens the database only for the duration of fn, so the CLI child never
// competes with a connection held by the test.
async function withDb(fn) {
  const cache = createCache(dbPath);
  const auth = createAuth({ db: cache.db, mode: 'multi-user', env: {}, argon2Opts: fastOpts });
  try { return await fn({ db: cache.db, auth }); }
  finally { cache.db.close(); }
}

async function seedUser(email = 'user@x.y') {
  return withDb(async ({ db, auth }) => {
    const user = await auth.createUser({ email, password: OLD_PW });
    auth.createSession(user.id);
    assert.equal(db.prepare('SELECT COUNT(*) c FROM sessions WHERE user_id = ?').get(user.id).c, 1);
    return user;
  });
}

const canLogIn = (email, password) => withDb(async ({ auth }) => !!(await auth.authenticate(email, password)));

/** @param {string[]} args  @param {string} [stdin]  piped to the child, then closed */
function run(args, stdin) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [ADMIN_JS, ...args], {
      // cwd is the temp dir: a forgotten CACHE_DB would create ./data there, not in the checkout.
      cwd: dir,
      env: { PATH: process.env.PATH, CACHE_DB: dbPath },
      stdio: [stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      timeout: 30000,
      killSignal: 'SIGKILL',
    });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => { stdout += d; });
    proc.stderr.on('data', (d) => { stderr += d; });
    proc.on('error', reject);
    proc.on('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
    if (stdin !== undefined) proc.stdin.end(stdin);
  });
}

describe('admin CLI - command dispatch', () => {
  it('no command: usage on stderr, exit 1, database not touched', async () => {
    const r = await run([]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /^Usage: node scripts\/admin\.js <list-users\|create-user\|reset-password\|make-admin> \[email\]/);
    assert.equal(r.stdout, '');
    assert.equal(fs.existsSync(dbPath), false, 'printing the usage must not create a database');
  });

  it('unknown command: names it, exit 1', async () => {
    await seedUser();
    const r = await run(['delete-user', 'user@x.y']);
    assert.equal(r.code, 1);
    assert.equal(r.stderr.trim(), 'Unknown command: delete-user');
    assert.equal(r.stdout, '');
    assert.equal(await canLogIn('user@x.y', OLD_PW), true);
  });

  it('list-users prints id, email and the admin tag', async () => {
    await seedUser('first@x.y');
    await withDb(({ auth }) => auth.createUser({ email: 'boss@x.y', password: OLD_PW, isAdmin: true }));
    const r = await run(['list-users']);
    assert.equal(r.code, 0);
    const lines = r.stdout.trim().split('\n');
    assert.equal(lines.length, 2);
    assert.match(lines[0], /^#1 {2}first@x\.y {2}created \d{4}-\d\d-\d\d /);
    assert.match(lines[1], /^#2 {2}boss@x\.y {2}\[admin\] {2}created /);
  });
});

describe('admin CLI - reset-password', () => {
  it('sets the new password, invalidates the old one and all sessions', async () => {
    await seedUser();

    const r = await run(['reset-password', 'user@x.y'], `${NEW_PW}\n`);

    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stderr, '');
    assert.equal(r.stdout, 'New password: Password reset for user@x.y.\n');
    assert.equal(await canLogIn('user@x.y', NEW_PW), true, 'the new password must authenticate');
    assert.equal(await canLogIn('user@x.y', OLD_PW), false, 'the old password must stop working');
    await withDb(({ db }) => {
      assert.equal(db.prepare('SELECT COUNT(*) c FROM sessions').get().c, 0, 'existing sessions must be logged out');
      assert.equal(db.prepare('SELECT COUNT(*) c FROM users').get().c, 1);
    });
  });

  it('finds the user regardless of case and surrounding spaces', async () => {
    await seedUser();
    const r = await run(['reset-password', '  USER@X.Y '], `${NEW_PW}\n`);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(await canLogIn('user@x.y', NEW_PW), true);
  });

  it('unknown email: exit 2 with a message, nobody is changed', async () => {
    await seedUser();

    const r = await run(['reset-password', 'ghost@x.y'], `${NEW_PW}\n`);

    assert.equal(r.code, 2);
    assert.equal(r.stderr.trim(), 'No user with email ghost@x.y');
    assert.doesNotMatch(r.stdout, /Password reset/);
    assert.equal(await canLogIn('user@x.y', OLD_PW), true);
    assert.equal(await canLogIn('user@x.y', NEW_PW), false);
    await withDb(({ db }) => assert.equal(db.prepare('SELECT COUNT(*) c FROM users').get().c, 1));
  });

  it('password shorter than 8 characters: exit 2, old password and sessions stay', async () => {
    await seedUser();

    const r = await run(['reset-password', 'user@x.y'], '1234567\n');

    assert.equal(r.code, 2);
    assert.equal(r.stderr.trim(), 'Password must be at least 8 characters.');
    assert.equal(await canLogIn('user@x.y', OLD_PW), true);
    assert.equal(await canLogIn('user@x.y', '1234567'), false);
    await withDb(({ db }) => assert.equal(db.prepare('SELECT COUNT(*) c FROM sessions').get().c, 1));
  });

  it('accepts exactly 8 characters', async () => {
    await seedUser();
    const r = await run(['reset-password', 'user@x.y'], '12345678\n');
    assert.equal(r.code, 0, r.stderr);
    assert.equal(await canLogIn('user@x.y', '12345678'), true);
  });

  it('an empty line is not a password: exit 2', async () => {
    await seedUser();
    const r = await run(['reset-password', 'user@x.y'], '\n');
    assert.equal(r.code, 2);
    assert.match(r.stderr, /at least 8 characters/);
    assert.equal(await canLogIn('user@x.y', OLD_PW), true);
  });

  it('missing email: usage, exit 2, without waiting for a password', async () => {
    // stdin is left unconnected: reading it would fail with the stdin error instead.
    const r = await run(['reset-password']);
    assert.equal(r.code, 2);
    assert.equal(r.stderr.trim(), 'Usage: reset-password <email>');
    assert.equal(r.stdout, '', 'no password prompt before the usage error');
  });
});

describe('admin CLI - make-admin', () => {
  it('promotes the user and only that user', async () => {
    await seedUser('user@x.y');
    await seedUser('other@x.y');

    const r = await run(['make-admin', 'User@X.Y']);

    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout, 'User@X.Y is now an admin.\n');
    assert.equal(r.stderr, '');
    await withDb(({ db }) => {
      assert.deepEqual(db.prepare('SELECT email, is_admin FROM users ORDER BY id').all(), [
        { email: 'user@x.y', is_admin: 1 },
        { email: 'other@x.y', is_admin: 0 },
      ]);
    });
    // Promotion does not touch the password.
    assert.equal(await canLogIn('user@x.y', OLD_PW), true);
  });

  it('unknown email: exit 2 with a message, nobody is promoted', async () => {
    await seedUser();
    const r = await run(['make-admin', 'ghost@x.y']);
    assert.equal(r.code, 2);
    assert.equal(r.stderr.trim(), 'No user with email ghost@x.y');
    assert.equal(r.stdout, '');
    await withDb(({ db }) => assert.equal(db.prepare('SELECT COUNT(*) c FROM users WHERE is_admin = 1').get().c, 0));
  });

  it('missing email: usage, exit 2', async () => {
    await seedUser();
    const r = await run(['make-admin']);
    assert.equal(r.code, 2);
    assert.equal(r.stderr.trim(), 'Usage: make-admin <email>');
    await withDb(({ db }) => assert.equal(db.prepare('SELECT COUNT(*) c FROM users WHERE is_admin = 1').get().c, 0));
  });
});

describe('admin CLI - create-user', () => {
  it('creates a non-admin user who can log in', async () => {
    const r = await run(['create-user', 'New@X.Y'], `${NEW_PW}\n`);

    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout, 'New password: Created new@x.y (no admin rights). Use make-admin to promote.\n');
    assert.equal(await canLogIn('new@x.y', NEW_PW), true);
    await withDb(({ db }) => {
      assert.deepEqual(db.prepare('SELECT email, is_admin FROM users').all(), [{ email: 'new@x.y', is_admin: 0 }]);
    });
  });

  it('duplicate email: exit 2 with the "already exists" message, password unchanged', async () => {
    await seedUser();

    const r = await run(['create-user', 'USER@x.y'], `${NEW_PW}\n`);

    assert.equal(r.code, 2);
    assert.equal(r.stderr.trim(), 'A user with email USER@x.y already exists.');
    assert.doesNotMatch(r.stdout, /Created/);
    assert.equal(await canLogIn('user@x.y', OLD_PW), true);
    assert.equal(await canLogIn('user@x.y', NEW_PW), false, 'create-user must not act as a password reset');
    await withDb(({ db }) => assert.equal(db.prepare('SELECT COUNT(*) c FROM users').get().c, 1));
  });

  it('password shorter than 8 characters: exit 2, no user', async () => {
    const r = await run(['create-user', 'new@x.y'], 'short\n');
    assert.equal(r.code, 2);
    assert.equal(r.stderr.trim(), 'Password must be at least 8 characters.');
    await withDb(({ db }) => assert.equal(db.prepare('SELECT COUNT(*) c FROM users').get().c, 0));
  });

  it('invalid email: exit 2 with the reason from the auth layer, no user', async () => {
    const r = await run(['create-user', 'not-an-email'], `${NEW_PW}\n`);
    assert.equal(r.code, 2);
    assert.notEqual(r.stderr.trim(), '', 'the reason must be printed');
    assert.doesNotMatch(r.stderr, /already exists/);
    assert.doesNotMatch(r.stderr, /\n\s+at /, 'an operator error must not print a stack trace');
    await withDb(({ db }) => assert.equal(db.prepare('SELECT COUNT(*) c FROM users').get().c, 0));
  });

  it('missing email: usage, exit 2, without waiting for a password', async () => {
    const r = await run(['create-user']);
    assert.equal(r.code, 2);
    assert.equal(r.stderr.trim(), 'Usage: create-user <email>');
    assert.equal(r.stdout, '');
  });
});
