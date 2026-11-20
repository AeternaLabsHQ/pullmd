// Stand-in for lib/convert-worker.js in test/convert-pool.test.js: speaks the
// same protocol, but its jobs spin, allocate, crash or call Trafilatura on
// demand, so the pool's limits can be tested without depending on which
// documents the input budgets happen to let through.
import { parentPort } from 'node:worker_threads';
import { serializeError } from '../../lib/convert-pool.js';

const spin = (ms) => { const end = Date.now() + ms; while (Date.now() < end); };
const pending = new Map();
let nextRpc = 0;

// node --test also loads files under test/ as test files; outside a worker
// this module does nothing.
parentPort?.on('message', async (msg) => {
  if (msg?.type === 'trafilatura-reply') {
    pending.get(msg.rpc)?.(msg.result);
    pending.delete(msg.rpc);
    return;
  }
  if (msg?.type !== 'job') return;
  parentPort.postMessage({ type: 'started', id: msg.id });
  const { job } = msg;
  const trafilatura = (html) => new Promise((resolve) => {
    const rpc = ++nextRpc;
    pending.set(rpc, resolve);
    parentPort.postMessage({ type: 'trafilatura', id: msg.id, rpc, html });
  });
  try {
    let result;
    if (job.op === 'spin') { spin(job.ms); result = 'spun'; }
    else if (job.op === 'alloc') { const keep = []; for (;;) keep.push(new Array(1e6).fill(keep.length)); }
    else if (job.op === 'exit') process.exit(3);
    else if (job.op === 'throw') throw Object.assign(new Error('bad doc'), { status: 422, code: 'document_too_complex', limit: 'x' });
    else if (job.op === 'rpc') {
      spin(job.before ?? 0);
      const reply = await trafilatura(job.html);
      spin(job.after ?? 0);
      result = reply;
    } else result = job.value;
    parentPort.postMessage({ type: 'done', id: msg.id, result });
  } catch (err) {
    parentPort.postMessage({ type: 'fail', id: msg.id, error: serializeError(err) });
  }
});
