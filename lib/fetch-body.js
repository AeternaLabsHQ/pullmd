/**
 * Bounded reads of outbound HTTP response bodies.
 *
 * A declared Content-Length above the limit is refused before any byte is
 * read; otherwise the body stream is consumed chunk by chunk and cancelled as
 * soon as it passes the limit. Response objects without a stream (test mocks
 * that only implement arrayBuffer()) are read whole and checked afterwards.
 */

export const DEFAULT_MAX_FETCH_BYTES = 50 * 1024 * 1024;

/**
 * Body size limit in bytes from PULLMD_MAX_FETCH_BYTES (a positive integer).
 * Unset or unusable values give the 50 MB default.
 */
export function maxFetchBytes(env = process.env) {
  const raw = String(env.PULLMD_MAX_FETCH_BYTES ?? '').trim();
  if (!/^\d+$/.test(raw)) return DEFAULT_MAX_FETCH_BYTES;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n > 0 ? n : DEFAULT_MAX_FETCH_BYTES;
}

function formatLimit(bytes) {
  const mb = bytes / (1024 * 1024);
  return Number.isInteger(mb) ? `${mb} MB` : `${bytes} bytes`;
}

export class ResponseTooLargeError extends Error {
  constructor(maxBytes) {
    super(`response larger than the ${formatLimit(maxBytes)} limit`);
    this.name = 'ResponseTooLargeError';
    this.maxBytes = maxBytes;
  }
}

function abortError(signal) {
  const r = signal.reason;
  return r instanceof Error ? r : new Error('response body read aborted');
}

/**
 * Read a fetch Response body into a Buffer, enforcing `maxBytes`.
 *
 * @param {Response|object} res
 * @param {object} [opts]
 * @param {number} [opts.maxBytes]   Defaults to maxFetchBytes()
 * @param {AbortSignal} [opts.signal] Ends the read with the signal's reason
 * @returns {Promise<Buffer|null>} null when `res` offers neither a body
 *   stream nor arrayBuffer() (the caller falls back to text())
 */
export async function readBodyCapped(res, { maxBytes = maxFetchBytes(), signal } = {}) {
  const declared = Number(res.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    try { await res.body?.cancel?.(); } catch { /* already closed */ }
    throw new ResponseTooLargeError(maxBytes);
  }

  if (typeof res.body?.getReader === 'function') {
    if (signal?.aborted) {
      try { await res.body.cancel(); } catch { /* already closed */ }
      throw abortError(signal);
    }
    const reader = res.body.getReader();
    let onAbort;
    const aborted = signal
      ? new Promise((_, reject) => {
          onAbort = () => reject(abortError(signal));
          signal.addEventListener('abort', onAbort, { once: true });
        })
      : null;
    aborted?.catch(() => {}); // handled through the race below
    const chunks = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await (aborted ? Promise.race([reader.read(), aborted]) : reader.read());
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) throw new ResponseTooLargeError(maxBytes);
        chunks.push(value);
      }
    } catch (err) {
      reader.cancel().catch(() => {});
      throw err;
    } finally {
      if (onAbort) signal.removeEventListener('abort', onAbort);
    }
    return Buffer.concat(chunks, total);
  }

  if (typeof res.arrayBuffer === 'function') {
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > maxBytes) throw new ResponseTooLargeError(maxBytes);
    return buf;
  }

  return null;
}
