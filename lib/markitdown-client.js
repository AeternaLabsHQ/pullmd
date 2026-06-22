const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Convert document bytes to Markdown via the markitdown sidecar.
 *
 * @param {Buffer} buffer                         raw document bytes
 * @param {object} [opts]
 * @param {string} [opts.url]                     sidecar URL (defaults to MARKITDOWN_URL env)
 * @param {string} [opts.contentType]            original mimetype (converter hint)
 * @param {string} [opts.filename]               original file name (extension hint)
 * @param {AbortSignal} [opts.signal]            caller cancellation
 * @param {typeof fetch} [opts.fetch]            injectable fetch (tests)
 * @returns {Promise<{markdown: string, title: string|null}|null>}  null on any failure
 */
export async function convertViaMarkitdown(buffer, opts = {}) {
  const url = opts.url || process.env.MARKITDOWN_URL;
  if (!url) return null;

  const fetchFn = opts.fetch || globalThis.fetch;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), DEFAULT_TIMEOUT_MS);
  const onAbort = () => ctrl.abort();
  if (opts.signal) {
    if (opts.signal.aborted) ctrl.abort();
    else opts.signal.addEventListener('abort', onAbort, { once: true });
  }

  try {
    const headers = { 'Content-Type': opts.contentType || 'application/octet-stream' };
    if (opts.filename) headers['X-Filename'] = encodeURIComponent(opts.filename);

    const res = await fetchFn(url, { method: 'POST', headers, body: buffer, signal: ctrl.signal });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data || typeof data.markdown !== 'string') return null;
    return {
      markdown: data.markdown,
      title: data.title || null,
      usage: data.usage || null,
      audioSeconds: data.audio_seconds ?? null,
      imageSize: data.image_size || null,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    if (opts.signal) opts.signal.removeEventListener('abort', onAbort);
  }
}

/**
 * Convert a YouTube video via the sidecar's /youtube endpoint.
 * @returns {Promise<{markdown:string,title:string|null,fields?:object}|null>}
 */
export async function convertYoutubeViaSidecar(html, opts = {}) {
  const base = opts.url || process.env.MARKITDOWN_URL;
  if (!base || !opts.sourceUrl) return null;
  // Swap a trailing /convert for /youtube; if the base has no /convert suffix
  // (e.g. it points at a reverse-proxy root), append /youtube instead of
  // silently sending the request to the wrong path.
  const endpoint = /\/convert\/?$/.test(base)
    ? base.replace(/\/convert\/?$/, '/youtube')
    : base.replace(/\/+$/, '') + '/youtube';

  const fetchFn = opts.fetch || globalThis.fetch;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), DEFAULT_TIMEOUT_MS);
  const onAbort = () => ctrl.abort();
  if (opts.signal) {
    if (opts.signal.aborted) ctrl.abort();
    else opts.signal.addEventListener('abort', onAbort, { once: true });
  }

  try {
    const headers = { 'Content-Type': 'text/html', 'X-Source-Url': opts.sourceUrl };
    if (opts.timecodes) headers['X-YT-Timecodes'] = String(opts.timecodes);
    if (opts.chunk !== undefined && opts.chunk !== null) headers['X-YT-Chunk'] = String(opts.chunk);

    const res = await fetchFn(endpoint, { method: 'POST', headers, body: html, signal: ctrl.signal });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data || typeof data.markdown !== 'string') return null;
    return { markdown: data.markdown, title: data.title || null, fields: data.fields || {}, transcriptStatus: data.transcript_status || null };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    if (opts.signal) opts.signal.removeEventListener('abort', onAbort);
  }
}
