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

/**
 * The shared PULLMD_LLM_* fallback covers the key and the base URL, but not the
 * model - one name cannot be a vision chat model, a speech model and an OCR
 * model at once. Setting PULLMD_LLM_MODEL is the obvious wrong guess, and it
 * would otherwise be swallowed in silence, leaving each modality on its default.
 * @returns {string|null} the warning to print, or null when there is nothing to say
 */
export function ignoredModelEnvWarning(env = process.env) {
  if (!env.PULLMD_LLM_MODEL) return null;
  return 'PULLMD_LLM_MODEL is set but nothing reads it. The shared PULLMD_LLM_* fallback '
    + 'covers PULLMD_LLM_API_KEY and PULLMD_LLM_BASE_URL only; the model is per modality. '
    + 'Use PULLMD_VISION_MODEL, PULLMD_STT_MODEL or PULLMD_PDF_OCR_MODEL instead.';
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
