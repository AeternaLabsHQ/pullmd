import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { reexecCommand } from '../scripts/admin.js';

// In the container the CLI is often started as root (`docker compose exec`
// without -u), but the database belongs to the app user and the container has
// no capability to write files it does not own. reexecCommand() decides when
// the CLI hands itself over to the app user via su-exec.

const base = {
  uid: 0,
  hasAppUser: true,
  env: { PATH: '/usr/bin', CACHE_DB: '/data/cache.db' },
  execPath: '/usr/local/bin/node',
  execArgv: ['--no-warnings'],
  argv: ['/usr/local/bin/node', '/app/scripts/admin.js', 'create-user', 'someone@example.com'],
};

describe('admin CLI re-exec as the app user', () => {
  it('re-execs as app:app via su-exec when it runs as root', () => {
    const cmd = reexecCommand(base);
    assert.equal(cmd.file, 'su-exec');
    assert.deepEqual(cmd.args, [
      'app:app', '/usr/local/bin/node', '--no-warnings',
      '/app/scripts/admin.js', 'create-user', 'someone@example.com',
    ]);
    assert.equal(cmd.env.CACHE_DB, '/data/cache.db');
    assert.equal(cmd.env.PULLMD_ADMIN_REEXEC, '1');
  });

  it('runs in-process when not root', () => {
    assert.equal(reexecCommand({ ...base, uid: 1000 }), null);
  });

  it('runs in-process where uid is unknown (no getuid, e.g. Windows)', () => {
    assert.equal(reexecCommand({ ...base, uid: undefined }), null);
  });

  it('runs in-process when there is no app user (root outside the container)', () => {
    assert.equal(reexecCommand({ ...base, hasAppUser: false }), null);
  });

  it('does not re-exec a second time', () => {
    assert.equal(reexecCommand({ ...base, env: { ...base.env, PULLMD_ADMIN_REEXEC: '1' } }), null);
  });
});
