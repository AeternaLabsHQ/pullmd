// Conversion worker pool. Parsing and converting a document is pure CPU work
// on untrusted input, and parser mismatches the input budgets in
// lib/parse-guard.js miss can let a small document block the event loop or
// exhaust memory. Running the conversion in a worker thread gives it a hard
// boundary: a time limit (the worker is terminated on expiry), a heap limit,
// and bounded concurrency with a short queue.
//
// The worker never opens a network connection. The one network call inside a
// conversion (the Trafilatura sidecar) is a round-trip to the main thread,
// which runs it with the caller's own function; the time limit is paused
// while that round-trip is outstanding.
//
// This module does not import lib/web.js: callers pass their hooks per job,
// so every module copy (tests import web.js with a query string) talks to the
// same pool with its own Trafilatura function.
import { SHARE_ENV, Worker } from 'node:worker_threads';
import { isTooComplex, tooComplexError } from './parse-guard.js';

export const DEFAULT_CONVERT_WORKERS = 2;
export const DEFAULT_CONVERT_TIMEOUT_MS = 60_000;
export const MAX_QUEUED_JOBS = 16;
export const MAX_QUEUE_WAIT_MS = 30_000;
export const WORKER_HEAP_MB = 512;
export const BUSY_RETRY_AFTER_SECONDS = 5;

const TIMEOUT_CODE = 'conversion_timeout';
const BUSY_CODE = 'converter_busy';
const DEFAULT_WORKER_URL = new URL('./convert-worker.js', import.meta.url);

function intFromEnv(raw, fallback, { allowZero }) {
  const s = String(raw ?? '').trim();
  if (!/^\d+$/.test(s)) return fallback;
  const n = Number(s);
  if (!Number.isSafeInteger(n)) return fallback;
  if (n === 0 && !allowZero) return fallback;
  return n;
}

/** Pool size from PULLMD_CONVERT_WORKERS; 0 = convert in-process (no isolation). */
export function convertWorkers(env = process.env) {
  return intFromEnv(env.PULLMD_CONVERT_WORKERS, DEFAULT_CONVERT_WORKERS, { allowZero: true });
}

/** Per-conversion time limit from PULLMD_CONVERT_TIMEOUT_MS. */
export function convertTimeoutMs(env = process.env) {
  return intFromEnv(env.PULLMD_CONVERT_TIMEOUT_MS, DEFAULT_CONVERT_TIMEOUT_MS, { allowZero: false });
}

export function conversionTimeoutError() {
  return Object.assign(new Error('Document took too long to convert'), { status: 422, code: TIMEOUT_CODE });
}

export function converterBusyError() {
  return Object.assign(new Error('The converter is busy, try again shortly'), {
    status: 503,
    code: BUSY_CODE,
    retryAfter: BUSY_RETRY_AFTER_SECONDS,
  });
}

export function isConverterBusy(err) {
  return err?.code === BUSY_CODE;
}

/**
 * The document itself is the problem: over a budget, out of memory (reported
 * as too complex) or over the time limit. Such a page gets no Playwright
 * retry, and a rendered pass that hits it keeps the static result.
 */
export function isConversionLimit(err) {
  return isTooComplex(err) || err?.code === TIMEOUT_CODE;
}

// Errors cross the thread boundary as plain data: structured clone keeps only
// name and message, but the HTTP layer needs status and code.
export function serializeError(err) {
  return {
    name: err?.name ?? 'Error',
    message: String(err?.message ?? err),
    status: err?.status,
    code: err?.code,
    limit: err?.limit,
  };
}

function deserializeError(data) {
  const err = new Error(data.message);
  if (data.name) err.name = data.name;
  for (const key of ['status', 'code', 'limit']) {
    if (data[key] !== undefined) err[key] = data[key];
  }
  return err;
}

/**
 * @param {object} options
 * @param {number} options.size          number of worker threads (>= 1)
 * @param {number} [options.timeoutMs]   default time limit per job
 * @param {number} [options.maxQueue]    jobs allowed to wait for a worker
 * @param {number} [options.maxWaitMs]   longest wait for a worker
 * @param {number} [options.heapMb]      old-generation heap limit per worker
 * @param {URL}    [options.workerUrl]   worker script (tests)
 */
export function createConvertPool({
  size,
  timeoutMs = DEFAULT_CONVERT_TIMEOUT_MS,
  maxQueue = MAX_QUEUED_JOBS,
  maxWaitMs = MAX_QUEUE_WAIT_MS,
  heapMb = WORKER_HEAP_MB,
  workerUrl = DEFAULT_WORKER_URL,
} = {}) {
  if (!(size >= 1)) throw new Error('createConvertPool: size must be at least 1');
  const slots = new Set();
  const queue = [];
  let nextId = 0;
  let retiring = false;
  // Killed workers whose thread is still ending. They count toward the size,
  // so a replacement starts only after the old thread is gone.
  let ending = 0;

  const hasRoom = () => slots.size + ending < size;

  function spawn() {
    const worker = new Worker(workerUrl, {
      env: SHARE_ENV,
      resourceLimits: { maxOldGenerationSizeMb: heapMb },
    });
    const slot = { worker, task: null };
    worker.unref();
    worker.on('message', (msg) => onMessage(slot, msg));
    worker.on('error', (err) => {
      const out = err?.code === 'ERR_WORKER_OUT_OF_MEMORY'
        ? tooComplexError('memory')
        : new Error(`Conversion worker crashed: ${err?.message ?? err}`);
      drop(slot, out);
    });
    worker.on('exit', (code) => drop(slot, new Error(`Conversion worker exited (code ${code})`)));
    slots.add(slot);
    return slot;
  }

  // Remove a dead or killed worker; fail the job it held. Safe to call twice.
  function drop(slot, err) {
    if (!slots.delete(slot)) return;
    if (slot.task) settle(slot.task, err);
    slot.task = null;
    pump();
  }

  function kill(slot, err) {
    if (slot.task) settle(slot.task, err);
    slot.task = null;
    slots.delete(slot);
    ending++;
    slot.worker.terminate().catch(() => {}).then(() => {
      ending--;
      pump();
    });
  }

  function settle(task, err, result) {
    if (task.settled) return;
    task.settled = true;
    clearTimeout(task.timer);
    clearTimeout(task.waitTimer);
    if (err) task.reject(err);
    else task.resolve(result);
  }

  function armTimer(slot, task) {
    task.startedAt = Date.now();
    task.timer = setTimeout(() => {
      if (slot.task === task) kill(slot, conversionTimeoutError());
    }, task.remainingMs);
  }

  function pauseTimer(task) {
    clearTimeout(task.timer);
    task.remainingMs = Math.max(0, task.remainingMs - (Date.now() - task.startedAt));
  }

  function dispatch(slot, task) {
    clearTimeout(task.waitTimer);
    slot.task = task;
    slot.worker.ref();
    // The time limit starts with the worker's 'started' message, so loading
    // the worker's modules on a fresh thread does not count.
    try {
      slot.worker.postMessage({ type: 'job', id: task.id, job: task.job });
    } catch (err) {
      // The job could not be cloned (a caller bug); the worker is fine.
      settle(task, err);
      release(slot);
    }
  }

  function release(slot) {
    slot.task = null;
    slot.worker.unref();
    if (retiring) {
      slots.delete(slot);
      slot.worker.terminate().catch(() => {});
      return;
    }
    pump();
  }

  // Hand the oldest waiting job to an idle worker, or to a new one while the
  // pool is below its size.
  function pump() {
    while (queue.length) {
      let slot = [...slots].find((s) => !s.task);
      if (!slot && hasRoom() && !retiring) slot = spawn();
      if (!slot) return;
      dispatch(slot, queue.shift());
    }
  }

  function onMessage(slot, msg) {
    const task = slot.task;
    if (!task || msg?.id !== task.id) return;
    if (msg.type === 'started') {
      armTimer(slot, task);
      return;
    }
    if (msg.type === 'trafilatura') {
      if (task.rpcs++ === 0) pauseTimer(task);
      Promise.resolve()
        .then(() => (task.hooks.trafilatura ? task.hooks.trafilatura(msg.html) : null))
        .catch(() => null)
        .then((result) => {
          if (slot.task !== task) return;
          slot.worker.postMessage({ type: 'trafilatura-reply', rpc: msg.rpc, result: result ?? null });
          if (--task.rpcs === 0) armTimer(slot, task);
        });
      return;
    }
    if (msg.type === 'done') {
      settle(task, null, msg.result);
      release(slot);
    } else if (msg.type === 'fail') {
      settle(task, deserializeError(msg.error));
      release(slot);
    }
  }

  /**
   * Run one conversion job in a worker.
   *
   * @param {object} job                     structured-cloneable job description
   * @param {object} [hooks]
   * @param {(html: string) => Promise<string|null>} [hooks.trafilatura]  runs in the main thread
   * @param {number} [hooks.timeoutMs]       overrides the pool default
   */
  function run(job, hooks = {}) {
    return new Promise((resolve, reject) => {
      if (retiring) { reject(new Error('Conversion pool is closed')); return; }
      const task = {
        id: ++nextId, job, hooks, resolve, reject,
        settled: false, rpcs: 0,
        remainingMs: hooks.timeoutMs ?? timeoutMs,
      };
      const idle = [...slots].find((s) => !s.task);
      if (idle || hasRoom()) { dispatch(idle || spawn(), task); return; }
      if (queue.length >= maxQueue) { reject(converterBusyError()); return; }
      queue.push(task);
      task.waitTimer = setTimeout(() => {
        const i = queue.indexOf(task);
        if (i >= 0) queue.splice(i, 1);
        settle(task, converterBusyError());
      }, maxWaitMs);
    });
  }

  /**
   * Stop taking jobs. Idle workers end now, busy ones when their job is done;
   * jobs still waiting are refused as busy.
   */
  function retire() {
    retiring = true;
    for (const task of queue.splice(0)) settle(task, converterBusyError());
    for (const slot of [...slots]) {
      if (!slot.task) {
        slots.delete(slot);
        slot.worker.terminate().catch(() => {});
      }
    }
  }

  return {
    run,
    retire,
    get workers() { return slots.size; },
    get queued() { return queue.length; },
  };
}

// Process-wide pool, built lazily. The size is read per call so a changed
// PULLMD_CONVERT_WORKERS (tests) gets a pool of the new size.
let shared = null;

/**
 * Run a job in the shared pool with the current PULLMD_CONVERT_TIMEOUT_MS.
 * Callers handle PULLMD_CONVERT_WORKERS=0 themselves (in-process).
 */
export function runInPool(job, hooks = {}) {
  const size = convertWorkers();
  if (!shared || shared.size !== size) {
    shared?.pool.retire();
    shared = { size, pool: createConvertPool({ size }) };
  }
  return shared.pool.run(job, { ...hooks, timeoutMs: convertTimeoutMs() });
}
