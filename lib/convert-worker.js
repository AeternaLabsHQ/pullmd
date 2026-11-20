// Worker side of lib/convert-pool.js: runs one conversion job at a time with
// convertDocument() from lib/web.js. Pure CPU; the Trafilatura sidecar is
// reached through the main thread (see trafilatura() below).
import { parentPort } from 'node:worker_threads';
import { convertDocument } from './web.js';
import { serializeError } from './convert-pool.js';

const pendingRpcs = new Map();
let nextRpc = 0;

parentPort.on('message', async (msg) => {
  if (msg?.type === 'trafilatura-reply') {
    const resolve = pendingRpcs.get(msg.rpc);
    pendingRpcs.delete(msg.rpc);
    resolve?.(msg.result);
    return;
  }
  if (msg?.type !== 'job') return;
  parentPort.postMessage({ type: 'started', id: msg.id });
  const trafilatura = (html) => new Promise((resolve) => {
    const rpc = ++nextRpc;
    pendingRpcs.set(rpc, resolve);
    parentPort.postMessage({ type: 'trafilatura', id: msg.id, rpc, html });
  });
  try {
    const result = await convertDocument(msg.job, trafilatura);
    parentPort.postMessage({ type: 'done', id: msg.id, result });
  } catch (err) {
    parentPort.postMessage({ type: 'fail', id: msg.id, error: serializeError(err) });
  }
});
