import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createFileJobStore, readFileJobConfig } from '../lib/file-jobs.js';

const RESULT = { markdown: '# T\n\nbody', source: 'audio-transcript', metadata: null };
const RESULT_BYTES = Buffer.byteLength(JSON.stringify(RESULT));

function setup(opts = {}) {
  const clock = { t: 1_000 };
  const store = createFileJobStore({
    ttlMs: 60_000,
    maxBytes: 1_000,
    now: () => clock.t,
    sweepIntervalMs: 0,
    ...opts,
  });
  return { clock, store };
}

describe('file job store', () => {
  it('create returns a 32-hex id and the job is pending', () => {
    const { store } = setup();
    const id = store.create({ owner: null, clientKey: 'c' });
    assert.match(id, /^[0-9a-f]{32}$/);
    assert.deepEqual(store.get(id, null), { status: 'pending' });
  });

  it('finish makes the result fetchable repeatedly', () => {
    const { store } = setup();
    const id = store.create({ owner: null, clientKey: 'c' });
    assert.equal(store.finish(id, RESULT), true);
    assert.deepEqual(store.get(id, null), { status: 'done', result: RESULT });
    assert.deepEqual(store.get(id, null), { status: 'done', result: RESULT });
  });

  it('fail reports error and httpStatus', () => {
    const { store } = setup();
    const id = store.create({ owner: null, clientKey: 'c' });
    assert.equal(store.fail(id, { error: 'x', httpStatus: 502 }), true);
    assert.deepEqual(store.get(id, null), { status: 'error', error: 'x', httpStatus: 502 });
  });

  it('get and delete return null/false for a different owner', () => {
    const { store } = setup();
    const id = store.create({ owner: 1, clientKey: 'c' });
    store.finish(id, RESULT);
    assert.equal(store.get(id, 2), null);
    assert.equal(store.get(id, null), null);
    assert.equal(store.delete(id, 2), false);
    assert.equal(store.get(id, 1).status, 'done');
  });

  it('expires a finished job after ttlMs, counted from finish', () => {
    const { clock, store } = setup();
    const id = store.create({ owner: null, clientKey: 'c' });
    clock.t += 30_000; // time spent converting does not count against the TTL
    store.finish(id, RESULT);
    clock.t += 59_999;
    assert.equal(store.get(id, null).status, 'done');
    clock.t += 1;
    assert.equal(store.get(id, null), null);
    assert.deepEqual(store.stats(), { jobs: 0, bytes: 0 });
  });

  it('expires a failed job after ttlMs, counted from fail', () => {
    const { clock, store } = setup();
    const id = store.create({ owner: null, clientKey: 'c' });
    store.fail(id, { error: 'x', httpStatus: 500 });
    clock.t += 60_000;
    assert.equal(store.get(id, null), null);
  });

  it('sweep removes expired jobs without a get', () => {
    const { clock, store } = setup();
    const id = store.create({ owner: null, clientKey: 'c' });
    store.finish(id, RESULT);
    clock.t += 60_000;
    store.sweep();
    assert.deepEqual(store.stats(), { jobs: 0, bytes: 0 });
  });

  it('delete removes the job and frees bytes', () => {
    const { store } = setup();
    const id = store.create({ owner: null, clientKey: 'c' });
    store.finish(id, RESULT);
    assert.deepEqual(store.stats(), { jobs: 1, bytes: RESULT_BYTES });
    assert.equal(store.delete(id, null), true);
    assert.equal(store.get(id, null), null);
    assert.deepEqual(store.stats(), { jobs: 0, bytes: 0 });
    assert.equal(store.delete(id, null), false);
  });

  it('refuses a 4th job for the same clientKey, accepts another client', () => {
    const { store } = setup();
    for (let i = 0; i < 3; i++) assert.ok(store.create({ owner: null, clientKey: 'a' }));
    assert.equal(store.create({ owner: null, clientKey: 'a' }), null);
    assert.ok(store.create({ owner: null, clientKey: 'b' }));
  });

  it('counts finished jobs against the client limit', () => {
    const { store } = setup();
    for (let i = 0; i < 3; i++) store.finish(store.create({ owner: null, clientKey: 'a' }), RESULT);
    assert.equal(store.create({ owner: null, clientKey: 'a' }), null);
  });

  it('frees the client slot after delete', () => {
    const { store } = setup();
    const ids = [1, 2, 3].map(() => store.create({ owner: null, clientKey: 'a' }));
    assert.equal(store.create({ owner: null, clientKey: 'a' }), null);
    store.delete(ids[0], null);
    assert.ok(store.create({ owner: null, clientKey: 'a' }));
  });

  it('create sweeps expired jobs first, freeing their slots', () => {
    const { clock, store } = setup({ maxJobs: 1 });
    store.finish(store.create({ owner: null, clientKey: 'a' }), RESULT);
    assert.equal(store.create({ owner: null, clientKey: 'b' }), null);
    clock.t += 60_000;
    assert.ok(store.create({ owner: null, clientKey: 'b' }));
  });

  it('refuses when maxJobs is reached', () => {
    const { store } = setup({ maxJobs: 2 });
    assert.ok(store.create({ owner: null, clientKey: 'a' }));
    assert.ok(store.create({ owner: null, clientKey: 'b' }));
    assert.equal(store.create({ owner: null, clientKey: 'c' }), null);
  });

  it('is disabled with ttlMs 0', () => {
    const { store } = setup({ ttlMs: 0 });
    assert.equal(store.enabled, false);
    assert.equal(store.create({ owner: null, clientKey: 'a' }), null);
  });

  it('drops the same client\'s older finished job to make room', () => {
    const { store } = setup({ maxBytes: RESULT_BYTES + 5 });
    const first = store.create({ owner: null, clientKey: 'a' });
    store.finish(first, RESULT);
    const second = store.create({ owner: null, clientKey: 'a' });
    assert.equal(store.finish(second, RESULT), true);
    assert.equal(store.get(first, null), null);
    assert.equal(store.get(second, null).status, 'done');
    assert.deepEqual(store.stats(), { jobs: 1, bytes: RESULT_BYTES });
  });

  it('does not drop another client\'s job to make room', () => {
    const { store } = setup({ maxBytes: RESULT_BYTES + 5 });
    const other = store.create({ owner: null, clientKey: 'b' });
    store.finish(other, RESULT);
    const mine = store.create({ owner: null, clientKey: 'a' });
    assert.equal(store.finish(mine, RESULT), false);
    assert.equal(store.get(other, null).status, 'done');
    assert.equal(store.get(mine, null).httpStatus, 507);
  });

  it('keeps older jobs when the new result could not fit anyway', () => {
    const { store } = setup({ maxBytes: RESULT_BYTES + 5 });
    const first = store.create({ owner: null, clientKey: 'a' });
    store.finish(first, RESULT);
    const big = store.create({ owner: null, clientKey: 'a' });
    assert.equal(store.finish(big, { markdown: 'x'.repeat(RESULT_BYTES * 2) }), false);
    assert.equal(store.get(first, null).status, 'done');
  });

  it('fails the job with 507 when a single result exceeds maxBytes', () => {
    const { store } = setup({ maxBytes: 20 });
    const id = store.create({ owner: null, clientKey: 'a' });
    assert.equal(store.finish(id, RESULT), false);
    assert.deepEqual(store.get(id, null), {
      status: 'error',
      error: 'Result too large to hold for pickup, upload again. / Ergebnis zu groß zum Bereithalten, bitte erneut hochladen.',
      httpStatus: 507,
    });
    assert.deepEqual(store.stats(), { jobs: 1, bytes: 0 });
  });

  it('fails a pending job after pendingTimeoutMs with 504', () => {
    const { clock, store } = setup({ pendingTimeoutMs: 5_000 });
    const id = store.create({ owner: null, clientKey: 'a' });
    clock.t += 5_000;
    assert.deepEqual(store.get(id, null), { status: 'pending' });
    clock.t += 1;
    assert.deepEqual(store.get(id, null), {
      status: 'error',
      error: 'Conversion timed out. / Konvertierung abgebrochen (Zeitlimit).',
      httpStatus: 504,
    });
  });

  it('sweep applies the pending timeout, and the timeout error then expires', () => {
    const { clock, store } = setup({ pendingTimeoutMs: 5_000 });
    const id = store.create({ owner: null, clientKey: 'a' });
    clock.t += 5_001;
    store.sweep();
    assert.equal(store.stats().jobs, 1);
    clock.t += 60_000;
    assert.equal(store.get(id, null), null);
  });

  it('ignores a late finish for a job that already timed out', () => {
    const { clock, store } = setup({ pendingTimeoutMs: 5_000 });
    const id = store.create({ owner: null, clientKey: 'a' });
    clock.t += 5_001;
    assert.equal(store.finish(id, RESULT), false);
    assert.equal(store.get(id, null).httpStatus, 504);
    assert.deepEqual(store.stats(), { jobs: 1, bytes: 0 });
  });

  it('finish/fail on an unknown id return false', () => {
    const { store } = setup();
    assert.equal(store.finish('nope', RESULT), false);
    assert.equal(store.fail('nope', { error: 'x', httpStatus: 500 }), false);
  });

  it('close stops the sweep timer so the process can exit', () => {
    const store = createFileJobStore({ ttlMs: 60_000, maxBytes: 1_000, sweepIntervalMs: 10 });
    store.close();
    store.close();
  });
});

describe('readFileJobConfig', () => {
  it('uses defaults for an empty env', () => {
    assert.deepEqual(readFileJobConfig({}), { ttlMs: 3_600_000, maxBytes: 64 * 1024 * 1024 });
  });

  it('reads minutes and megabytes', () => {
    assert.deepEqual(
      readFileJobConfig({ PULLMD_FILE_JOB_TTL_MINUTES: '5', PULLMD_FILE_JOB_MAX_MB: '8' }),
      { ttlMs: 300_000, maxBytes: 8 * 1024 * 1024 },
    );
  });

  it('0 disables the TTL', () => {
    assert.equal(readFileJobConfig({ PULLMD_FILE_JOB_TTL_MINUTES: '0' }).ttlMs, 0);
  });

  it('garbage uses the defaults', () => {
    for (const bad of ['abc', '-5', '1.5', '']) {
      assert.equal(readFileJobConfig({ PULLMD_FILE_JOB_TTL_MINUTES: bad }).ttlMs, 3_600_000, bad);
    }
    assert.equal(readFileJobConfig({ PULLMD_FILE_JOB_MAX_MB: '0' }).maxBytes, 64 * 1024 * 1024);
    assert.equal(readFileJobConfig({ PULLMD_FILE_JOB_MAX_MB: 'x' }).maxBytes, 64 * 1024 * 1024);
  });
});
