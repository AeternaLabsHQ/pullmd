#!/usr/bin/env node
import { createCache } from '../lib/cache.js';
import { createAuth, hashPassword } from '../lib/auth.js';

export function listUsers({ db }) {
  return db.prepare(`
    SELECT id, email, is_admin, created_at FROM users ORDER BY id ASC
  `).all();
}

export async function resetPassword({ db, auth }, email, newPassword) {
  const cleanEmail = (email || '').trim().toLowerCase();
  const u = db.prepare("SELECT id FROM users WHERE email = ?").get(cleanEmail);
  if (!u) return false;
  if (!newPassword || newPassword.length < 8) {
    throw new Error('Password must be at least 8 characters');
  }
  const hash = await hashPassword(newPassword, auth._argon2Opts);
  db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(hash, u.id);
  db.prepare("DELETE FROM sessions WHERE user_id = ?").run(u.id);
  return true;
}

export function makeAdmin({ db }, email) {
  const cleanEmail = (email || '').trim().toLowerCase();
  const r = db.prepare("UPDATE users SET is_admin = 1 WHERE email = ?").run(cleanEmail);
  return r.changes > 0;
}

export async function createUserCmd({ db, auth }, email, password) {
  const clean = String(email || '').trim().toLowerCase();
  if (db.prepare("SELECT 1 FROM users WHERE email = ?").get(clean)) {
    return { ok: false, reason: 'exists' };
  }
  try {
    const user = await auth.createUser({ email, password, isAdmin: false });
    return { ok: true, user };
  } catch (err) {
    return { ok: false, reason: 'invalid', message: err?.message || 'could not create user' };
  }
}

function noStdinError() {
  const err = new Error(
    'Could not read a password: stdin is not connected.\n' +
    'Run this with a terminal attached:\n' +
    '  docker compose exec pullmd node scripts/admin.js ...\n' +
    '  docker exec -it <container> node scripts/admin.js ...\n' +
    'or pipe the password in:\n' +
    '  echo "thepassword" | docker exec -i <container> node scripts/admin.js ...'
  );
  err.code = 'ENOSTDIN';
  return err;
}

async function readPassword(prompt = 'New password: ') {
  process.stdout.write(prompt);
  // Non-interactive stdin (a pipe, or a test). Read the stream directly rather
  // than through readline: readline neither settles when stdin is already at
  // EOF - which is what `docker exec` without -i hands over, and used to make
  // this exit 0 having done nothing - nor hands over a final line that arrives
  // without a trailing newline.
  if (!process.stdin.isTTY) {
    process.stdin.setEncoding('utf8');
    let buf = '';
    for await (const chunk of process.stdin) {
      buf += chunk;
      const nl = buf.indexOf('\n');
      if (nl !== -1) return buf.slice(0, nl).replace(/\r$/, '');
    }
    if (buf === '') throw noStdinError();
    return buf;
  }
  return new Promise((resolve) => {
    process.stdin.setRawMode(true);
    let buf = '';
    const onData = (chunk) => {
      const s = chunk.toString('utf8');
      for (const ch of s) {
        if (ch === '\r' || ch === '\n') {
          process.stdin.setRawMode(false);
          process.stdin.removeListener('data', onData);
          process.stdout.write('\n');
          return resolve(buf);
        }
        if (ch === '') { // Ctrl-C
          process.stdin.setRawMode(false);
          process.exit(130);
        }
        if (ch === '' || ch === '\b') { // Backspace
          buf = buf.slice(0, -1);
          continue;
        }
        buf += ch;
      }
    };
    process.stdin.on('data', onData);
  });
}

async function main() {
  const [, , cmd, ...args] = process.argv;
  if (!cmd) {
    console.error('Usage: node scripts/admin.js <list-users|create-user|reset-password|make-admin> [email]');
    process.exit(1);
  }
  const dbPath = process.env.CACHE_DB || './data/cache.db';
  const cache = createCache(dbPath);
  const auth = createAuth({
    db: cache.db,
    mode: process.env.PULLMD_AUTH_MODE || 'multi-user',
    env: process.env,
  });

  if (cmd === 'list-users') {
    const users = listUsers({ db: cache.db });
    if (users.length === 0) { console.log('(no users yet)'); return; }
    for (const u of users) {
      console.log(`#${u.id}  ${u.email}${u.is_admin ? '  [admin]' : ''}  created ${u.created_at}`);
    }
    return;
  }

  if (cmd === 'reset-password') {
    const email = args[0];
    if (!email) { console.error('Usage: reset-password <email>'); process.exit(2); }
    const pw = await readPassword();
    if (!pw || pw.length < 8) { console.error('Password must be at least 8 characters.'); process.exit(2); }
    const ok = await resetPassword({ db: cache.db, auth }, email, pw);
    if (!ok) { console.error(`No user with email ${email}`); process.exit(2); }
    console.log(`Password reset for ${email}.`);
    return;
  }

  if (cmd === 'make-admin') {
    const email = args[0];
    if (!email) { console.error('Usage: make-admin <email>'); process.exit(2); }
    const ok = makeAdmin({ db: cache.db }, email);
    if (!ok) { console.error(`No user with email ${email}`); process.exit(2); }
    console.log(`${email} is now an admin.`);
    return;
  }

  if (cmd === 'create-user') {
    const email = args[0];
    if (!email) { console.error('Usage: create-user <email>'); process.exit(2); }
    const pw = await readPassword();
    if (!pw || pw.length < 8) { console.error('Password must be at least 8 characters.'); process.exit(2); }
    const r = await createUserCmd({ db: cache.db, auth }, email, pw);
    if (!r.ok) {
      console.error(r.reason === 'exists'
        ? `A user with email ${email} already exists.`
        : r.message);
      process.exit(2);
    }
    console.log(`Created ${r.user.email} (no admin rights). Use make-admin to promote.`);
    return;
  }

  console.error(`Unknown command: ${cmd}`);
  process.exit(1);
}

const isDirectRun = import.meta.url === `file://${process.argv[1]}`
  || process.argv[1]?.endsWith('admin.js');
if (isDirectRun) {
  main().catch((err) => {
    if (err?.code === 'ENOSTDIN') {
      // An operator error, not a crash - a stack trace would only bury the fix.
      console.error(`\n${err.message}`);
      process.exit(2);
    }
    console.error(err);
    process.exit(1);
  });
}
