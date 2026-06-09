/**
 * Resolve an OpenAI-compatible provider config for a modality, with an optional
 * shared fallback. Mirrors the sidecar's old _env() "first non-empty wins" behaviour.
 * @param {'VISION'|'STT'|'PDF_OCR'} modality
 * @param {{ sharedFallback?: boolean }} [opts]
 * @returns {{apiKey:string|undefined, baseUrl:string|undefined, model:string|undefined}}
 */
export function resolveProvider(modality, { sharedFallback = true } = {}) {
  const pick = (...names) => {
    for (const n of names) { const v = process.env[n]; if (v) return v; }
    return undefined;
  };
  const keyNames  = [`PULLMD_${modality}_API_KEY`];
  const baseNames = [`PULLMD_${modality}_BASE_URL`];
  if (sharedFallback) { keyNames.push('PULLMD_LLM_API_KEY'); baseNames.push('PULLMD_LLM_BASE_URL'); }
  return {
    apiKey:  pick(...keyNames),
    baseUrl: pick(...baseNames),
    model:   pick(`PULLMD_${modality}_MODEL`),
  };
}

/** Build an OpenAI-style usage object, or null when there's nothing to report. */
export function mapUsage(usage, model) {
  const out = {};
  if (model) out.model = model;
  if (usage) {
    for (const k of ['prompt_tokens', 'completion_tokens', 'total_tokens']) {
      if (usage[k] != null) out[k] = usage[k];
    }
  }
  return Object.keys(out).length ? out : null;
}

/**
 * Create an AbortSignal that fires after `ms`, linked to an optional caller
 * signal. Returns the signal plus a cleanup() to clear the timer/listener.
 */
export function abortController(opts = {}, ms) {
  const ctrl = new AbortController();
  if (opts.signal?.aborted) {
    ctrl.abort();
    return { signal: ctrl.signal, cleanup: () => {} };
  }
  const timer = setTimeout(() => ctrl.abort(), ms);
  const onAbort = () => ctrl.abort();
  if (opts.signal) opts.signal.addEventListener('abort', onAbort, { once: true });
  return {
    signal: ctrl.signal,
    cleanup: () => { clearTimeout(timer); opts.signal?.removeEventListener('abort', onAbort); },
  };
}
