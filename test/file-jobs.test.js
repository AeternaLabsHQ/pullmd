import { describe, it, mock } from 'node:test';
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

  it('frees the client slot after deleting a finished job', () => {
    const { store } = setup();
    const ids = [1, 2, 3].map(() => store.create({ owner: null, clientKey: 'a' }));
    for (const id of ids) store.finish(id, RESULT);
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
    const { store } = setup({ maxBytes: RESULT_BYTES + 5, maxBytesPerClient: RESULT_BYTES + 5 });
    // Both created up front: admission refuses once half the pool is in use.
    const first = store.create({ owner: null, clientKey: 'a' });
    const second = store.create({ owner: null, clientKey: 'a' });
    store.finish(first, RESULT);
    assert.equal(store.finish(second, RESULT), true);
    assert.equal(store.get(first, null), null);
    assert.equal(store.get(second, null).status, 'done');
    assert.deepEqual(store.stats(), { jobs: 1, bytes: RESULT_BYTES });
  });

  it('does not drop another client\'s job to make room', () => {
    const { store } = setup({ maxBytes: RESULT_BYTES + 5, maxBytesPerClient: RESULT_BYTES + 5 });
    const other = store.create({ owner: null, clientKey: 'b' });
    const mine = store.create({ owner: null, clientKey: 'a' });
    store.finish(other, RESULT);
    assert.equal(store.finish(mine, RESULT), false);
    assert.equal(store.get(other, null).status, 'done');
    assert.equal(store.get(mine, null).httpStatus, 507);
  });

  it('keeps older jobs when the new result could not fit anyway', () => {
    const { store } = setup({ maxBytes: RESULT_BYTES + 5, maxBytesPerClient: RESULT_BYTES + 5 });
    const first = store.create({ owner: null, clientKey: 'a' });
    const big = store.create({ owner: null, clientKey: 'a' });
    store.finish(first, RESULT);
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

  // S1: a slot is held until the conversion really ends.
  it('DELETE on a pending job hides it but keeps the client slot', () => {
    const { store } = setup();
    const ids = [1, 2, 3].map(() => store.create({ owner: null, clientKey: 'a' }));
    assert.equal(store.delete(ids[0], null), true);
    assert.equal(store.get(ids[0], null), null);
    assert.equal(store.delete(ids[0], null), false);
    assert.equal(store.create({ owner: null, clientKey: 'a' }), null);
    assert.equal(store.stats().jobs, 3);
  });

  it('a late finish after DELETE returns false, frees the slot and stores nothing', () => {
    const { store } = setup();
    const ids = [1, 2, 3].map(() => store.create({ owner: null, clientKey: 'a' }));
    store.delete(ids[0], null);
    assert.equal(store.finish(ids[0], RESULT), false);
    assert.equal(store.get(ids[0], null), null);
    assert.deepEqual(store.stats(), { jobs: 2, bytes: 0 });
    assert.ok(store.create({ owner: null, clientKey: 'a' }));
  });

  it('a late fail after DELETE also frees the slot', () => {
    const { store } = setup();
    const id = store.create({ owner: null, clientKey: 'a' });
    store.delete(id, null);
    assert.equal(store.fail(id, { error: 'x', httpStatus: 502 }), false);
    assert.deepEqual(store.stats(), { jobs: 0, bytes: 0 });
  });

  it('a cancelled job keeps its slot past the TTL while still running', () => {
    const { clock, store } = setup({ maxJobs: 1, pendingTimeoutMs: 5_000 });
    const id = store.create({ owner: null, clientKey: 'a' });
    store.delete(id, null);
    clock.t += 60_000; // a finished job would be gone by now
    assert.equal(store.create({ owner: null, clientKey: 'b' }), null);
    assert.equal(store.stats().jobs, 1);
    assert.equal(store.finish(id, RESULT), false);
    assert.ok(store.create({ owner: null, clientKey: 'b' }));
  });

  it('the hard ceiling frees a cancelled job that never settles', () => {
    const { clock, store } = setup({ maxJobs: 1, pendingTimeoutMs: 5_000 });
    const id = store.create({ owner: null, clientKey: 'a' });
    store.delete(id, null);
    clock.t += 5_000 + 60_000; // createdAt + pendingTimeoutMs + ttlMs: still held
    assert.equal(store.create({ owner: null, clientKey: 'b' }), null);
    clock.t += 1;
    assert.ok(store.create({ owner: null, clientKey: 'b' }));
    assert.equal(store.finish(id, RESULT), false);
    assert.deepEqual(store.stats(), { jobs: 1, bytes: 0 });
  });

  it('a timed-out job that is still running keeps its slot until a late fail', () => {
    // For a 504 job the TTL end and the hard ceiling coincide:
    // finishedAt >= createdAt + pendingTimeoutMs, so finishedAt + ttlMs >= ceiling.
    const { clock, store } = setup({ maxJobs: 1, pendingTimeoutMs: 5_000 });
    const id = store.create({ owner: null, clientKey: 'a' });
    clock.t += 5_001;
    store.sweep();
    assert.equal(store.get(id, null).httpStatus, 504);
    clock.t = 1_000 + 5_000 + 60_000; // exactly at the ceiling
    store.sweep();
    assert.equal(store.get(id, null).httpStatus, 504);
    assert.equal(store.create({ owner: null, clientKey: 'b' }), null);
    assert.equal(store.fail(id, { error: 'late', httpStatus: 502 }), false);
    // Settled now: the 504 stays readable until its own TTL ends (1 ms later).
    assert.equal(store.get(id, null).httpStatus, 504);
    clock.t += 1;
    assert.ok(store.create({ owner: null, clientKey: 'b' }));
    assert.deepEqual(store.stats(), { jobs: 1, bytes: 0 });
  });

  it('the hard ceiling frees a timed-out job whose conversion never settles', () => {
    const { clock, store } = setup({ maxJobs: 1, pendingTimeoutMs: 5_000 });
    const id = store.create({ owner: null, clientKey: 'a' });
    clock.t += 5_001;
    store.sweep();
    clock.t = 1_000 + 5_000 + 60_000 + 1;
    assert.equal(store.get(id, null), null);
    assert.ok(store.create({ owner: null, clientKey: 'b' }));
    assert.equal(store.finish(id, RESULT), false);
    assert.deepEqual(store.stats(), { jobs: 1, bytes: 0 });
  });

  it('a late finish within the TTL leaves the 504 visible and stores nothing', () => {
    const { clock, store } = setup({ pendingTimeoutMs: 5_000 });
    const id = store.create({ owner: null, clientKey: 'a' });
    clock.t += 5_001;
    store.sweep();
    assert.equal(store.finish(id, RESULT), false);
    assert.equal(store.get(id, null).httpStatus, 504);
    assert.deepEqual(store.stats(), { jobs: 1, bytes: 0 });
    clock.t += 60_000;
    assert.equal(store.get(id, null), null);
    assert.deepEqual(store.stats(), { jobs: 0, bytes: 0 });
  });

  it('deleting a timed-out running job hides it and a late finish frees it', () => {
    const { clock, store } = setup({ maxJobs: 1, pendingTimeoutMs: 5_000 });
    const id = store.create({ owner: null, clientKey: 'a' });
    clock.t += 5_001;
    assert.equal(store.get(id, null).httpStatus, 504);
    assert.equal(store.delete(id, null), true);
    assert.equal(store.get(id, null), null);
    assert.equal(store.create({ owner: null, clientKey: 'b' }), null);
    assert.equal(store.finish(id, RESULT), false);
    assert.deepEqual(store.stats(), { jobs: 0, bytes: 0 });
  });

  it('another owner cannot cancel a running job', () => {
    const { store } = setup();
    const id = store.create({ owner: 1, clientKey: 'a' });
    assert.equal(store.delete(id, 2), false);
    assert.deepEqual(store.get(id, 1), { status: 'pending' });
    assert.equal(store.finish(id, RESULT), true);
    assert.equal(store.get(id, 1).status, 'done');
  });

  // S2: one client must not fill the shared result pool.
  it('a client holding its full share does not make another client\'s finish fail', () => {
    // maxBytes 4R: share R each, admission until 2R is in use.
    const { store } = setup({ maxBytes: RESULT_BYTES * 4 });
    const a1 = store.create({ owner: null, clientKey: 'a' });
    const b1 = store.create({ owner: null, clientKey: 'b' });
    assert.equal(store.finish(a1, RESULT), true);
    assert.equal(store.finish(b1, RESULT), true);
    assert.equal(store.get(a1, null).status, 'done');
    assert.deepEqual(store.stats(), { jobs: 2, bytes: RESULT_BYTES * 2 });
  });

  it('a client\'s next result evicts its own oldest when its share is full', () => {
    const { store } = setup({ maxBytes: RESULT_BYTES * 10 });
    // share: floor(10R / 4) = 2R (+ rounding), so two results fit, a third evicts.
    const ids = [1, 2, 3].map(() => store.create({ owner: null, clientKey: 'a' }));
    const other = store.create({ owner: null, clientKey: 'b' });
    assert.equal(store.finish(other, RESULT), true);
    for (const id of ids) assert.equal(store.finish(id, RESULT), true);
    assert.equal(store.get(ids[0], null), null);
    assert.equal(store.get(ids[1], null).status, 'done');
    assert.equal(store.get(ids[2], null).status, 'done');
    assert.equal(store.get(other, null).status, 'done');
    assert.deepEqual(store.stats(), { jobs: 3, bytes: RESULT_BYTES * 3 });
  });

  it('a result larger than the client share gets 507 and keeps the client\'s results', () => {
    const { store } = setup({ maxBytes: RESULT_BYTES * 10 });
    const first = store.create({ owner: null, clientKey: 'a' });
    const big = store.create({ owner: null, clientKey: 'a' });
    store.finish(first, RESULT);
    const bigResult = { markdown: 'x'.repeat(RESULT_BYTES * 3) };
    assert.equal(store.finish(big, bigResult), false);
    assert.equal(store.get(big, null).httpStatus, 507);
    assert.equal(store.get(first, null).status, 'done');
    assert.deepEqual(store.stats(), { jobs: 2, bytes: RESULT_BYTES });
  });

  it('maxBytesPerClient defaults to a quarter of maxBytes', () => {
    const { store } = setup({ maxBytes: RESULT_BYTES * 4 - 1 });
    const id = store.create({ owner: null, clientKey: 'a' });
    assert.equal(store.finish(id, RESULT), false);
    assert.equal(store.get(id, null).httpStatus, 507);
  });

  it('create returns null once half the pool is in use and works again after a delete', () => {
    const { store } = setup({ maxBytes: RESULT_BYTES * 4, maxBytesPerClient: RESULT_BYTES * 4 });
    const ids = [1, 2].map(() => store.create({ owner: null, clientKey: 'a' }));
    store.finish(ids[0], RESULT);
    assert.ok(store.create({ owner: null, clientKey: 'b' })); // R < 2R
    store.finish(ids[1], RESULT);
    assert.equal(store.create({ owner: null, clientKey: 'c' }), null); // 2R >= 2R
    store.delete(ids[0], null);
    assert.ok(store.create({ owner: null, clientKey: 'c' }));
  });

  it('the sweep timer drops expired jobs until close stops it', (t) => {
    mock.timers.enable({ apis: ['setInterval'] });
    t.after(() => mock.timers.reset());
    const { clock, store } = setup({ sweepIntervalMs: 10 });
    const expire = () => {
      const id = store.create({ owner: null, clientKey: 'c' });
      store.finish(id, RESULT);
      clock.t += 60_001;
    };

    // stats() does not sweep, so only the timer can empty the store.
    expire();
    assert.equal(store.stats().jobs, 1);
    mock.timers.tick(10);
    assert.equal(store.stats().jobs, 0);

    expire();
    store.close();
    store.close();
    mock.timers.tick(100);
    assert.equal(store.stats().jobs, 1, 'no sweep after close');
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
