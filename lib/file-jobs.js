import crypto from 'node:crypto';

const DEFAULT_TTL_MINUTES = 60;
const DEFAULT_MAX_MB = 64;

const ERR_TOO_LARGE = 'Result too large to hold for pickup, upload again. / Ergebnis zu groß zum Bereithalten, bitte erneut hochladen.';
const ERR_TIMEOUT = 'Conversion timed out. / Konvertierung abgebrochen (Zeitlimit).';

function readDigits(raw) {
  const s = String(raw ?? '').trim();
  if (!/^\d+$/.test(s)) return null;
  const n = Number(s);
  return Number.isSafeInteger(n) ? n : null;
}

/**
 * Settings for the async upload job store. `PULLMD_FILE_JOB_TTL_MINUTES` is how
 * long a finished result waits for pickup (0 turns async jobs off);
 * `PULLMD_FILE_JOB_MAX_MB` caps the memory all held results may use together.
 * Unset or unparsable values use the defaults.
 */
export function readFileJobConfig(env = process.env) {
  const ttl = readDigits(env.PULLMD_FILE_JOB_TTL_MINUTES);
  const mb = readDigits(env.PULLMD_FILE_JOB_MAX_MB);
  return {
    ttlMs: (ttl ?? DEFAULT_TTL_MINUTES) * 60_000,
    maxBytes: (mb > 0 ? mb : DEFAULT_MAX_MB) * 1024 * 1024,
  };
}

/**
 * In-memory store for results of asynchronous file conversions. A slow upload
 * (audio transcription, OCR) can outlive a proxy's request timeout, so the
 * client gets a job id and polls for the result instead. Results live only in
 * this process: never on disk, never in the cache, gone after `ttlMs` or on a
 * restart. Memory is bounded three ways: total jobs, jobs per client, and total
 * result bytes.
 *
 * A job is owned by whoever created it (`owner`: the user id, or null when
 * auth is off); other owners get the same answer as for an unknown id.
 */
export function createFileJobStore({
  ttlMs,
  maxBytes,
  maxJobs = 100,
  maxPerClient = 3,
  pendingTimeoutMs = 15 * 60_000,
  now = () => Date.now(),
  sweepIntervalMs = 60_000,
} = {}) {
  if (ttlMs === undefined || maxBytes === undefined) {
    const cfg = readFileJobConfig();
    ttlMs ??= cfg.ttlMs;
    maxBytes ??= cfg.maxBytes;
  }
  const enabled = ttlMs > 0;
  // id -> { owner, clientKey, state, result, error, httpStatus, bytes, createdAt, finishedAt }
  const jobs = new Map();
  // Running total of held result bytes, so a size check does not walk the Map.
  let totalBytes = 0;

  function remove(id) {
    const job = jobs.get(id);
    if (!job) return;
    totalBytes -= job.bytes;
    jobs.delete(id);
  }

  function settleAsError(job, error, httpStatus) {
    totalBytes -= job.bytes;
    job.state = 'error';
    job.result = null;
    job.error = error;
    job.httpStatus = httpStatus;
    job.bytes = 0;
    job.finishedAt = now();
  }

  /** Drops the job if its TTL passed, turns a stuck pending job into a 504. */
  function refresh(id) {
    const job = jobs.get(id);
    if (!job) return null;
    if (job.state === 'pending') {
      if (now() - job.createdAt > pendingTimeoutMs) settleAsError(job, ERR_TIMEOUT, 504);
    } else if (job.finishedAt + ttlMs <= now()) {
      remove(id);
      return null;
    }
    return job;
  }

  function sweep() {
    for (const id of [...jobs.keys()]) refresh(id);
  }

  function create({ owner, clientKey }) {
    if (!enabled) return null;
    sweep();
    if (jobs.size >= maxJobs) return null;
    let held = 0;
    for (const job of jobs.values()) if (job.clientKey === clientKey) held++;
    if (held >= maxPerClient) return null;
    const id = crypto.randomBytes(16).toString('hex');
    jobs.set(id, {
      owner, clientKey, state: 'pending', result: null, error: null, httpStatus: null,
      bytes: 0, createdAt: now(), finishedAt: null,
    });
    return id;
  }

  function finish(id, result) {
    const job = refresh(id);
    if (!job || job.state !== 'pending') return false;
    const size = Buffer.byteLength(JSON.stringify(result));
    // Only this client's own finished jobs may be evicted, so one client cannot
    // push out another's results. Evict only if that is enough, otherwise the
    // older results would be lost for nothing.
    const own = [];
    let reclaimable = 0;
    for (const [otherId, other] of jobs) {
      if (other.clientKey === job.clientKey && other.state === 'done') {
        own.push(otherId);
        reclaimable += other.bytes;
      }
    }
    if (totalBytes - reclaimable + size > maxBytes) {
      settleAsError(job, ERR_TOO_LARGE, 507);
      return false;
    }
    // Map iteration is insertion order, so `own` is oldest first.
    for (const otherId of own) {
      if (totalBytes + size <= maxBytes) break;
      remove(otherId);
    }
    job.state = 'done';
    job.result = result;
    job.bytes = size;
    job.finishedAt = now();
    totalBytes += size;
    return true;
  }

  function fail(id, { error, httpStatus }) {
    const job = refresh(id);
    if (!job || job.state !== 'pending') return false;
    settleAsError(job, error, httpStatus);
    return true;
  }

  function get(id, owner) {
    const job = refresh(id);
    if (!job || job.owner !== owner) return null;
    if (job.state === 'done') return { status: 'done', result: job.result };
    if (job.state === 'error') return { status: 'error', error: job.error, httpStatus: job.httpStatus };
    return { status: 'pending' };
  }

  function del(id, owner) {
    const job = refresh(id);
    if (!job || job.owner !== owner) return false;
    remove(id);
    return true;
  }

  function stats() {
    return { jobs: jobs.size, bytes: totalBytes };
  }

  // unref() so the timer never keeps the process (or a test run) alive.
  const timer = enabled && sweepIntervalMs > 0 ? setInterval(sweep, sweepIntervalMs) : null;
  timer?.unref();

  function close() {
    if (timer) clearInterval(timer);
  }

  return { enabled, create, finish, fail, get, delete: del, sweep, stats, close };
}
