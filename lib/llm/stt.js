import { resolveProvider, mapUsage, abortController } from './providers.js';

const TIMEOUT_MS = 120_000;
const DEFAULT_MODEL = 'whisper-1';
const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

/**
 * Transcribe audio via an OpenAI-compatible /audio/transcriptions endpoint.
 * @returns {Promise<{markdown:string, usage:object|null, audioSeconds:number|null}|null>}
 *          null when no STT provider is configured (caller degrades).
 */
export async function transcribeAudio(buffer, opts = {}) {
  const { filename, mimetype, fetch: fetchFn = globalThis.fetch } = opts;
  const { apiKey, baseUrl, model } = resolveProvider('STT');
  if (!apiKey) return null;
  if (buffer.length > MAX_AUDIO_BYTES) throw new Error('audio too large for transcription (max 25 MB)');

  const base = (baseUrl || 'https://api.openai.com/v1').replace(/\/$/, '');
  const mdl = model || DEFAULT_MODEL;
  const form = new FormData();
  form.append('model', mdl);
  form.append('file', new Blob([buffer], { type: mimetype || 'audio/mpeg' }), filename || 'audio.mp3');
  if (/whisper/i.test(mdl)) form.append('response_format', 'verbose_json'); // verbose_json adds duration

  const { signal, cleanup } = abortController(opts, TIMEOUT_MS);
  try {
    const res = await fetchFn(`${base}/audio/transcriptions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` }, // multipart boundary set by fetch
      body: form,
      signal,
    });
    if (!res.ok) {
      let detail = '';
      try { detail = (await res.text())?.slice(0, 200) || ''; } catch { detail = ''; }
      throw new Error(`transcription failed (${res.status})${detail ? ': ' + detail : ''}`);
    }
    const data = await res.json();
    const text = (data?.text || '').trim();
    const out = {
      markdown: text ? `### Audio Transcript\n\n${text}` : '',
      usage: mapUsage(data?.usage, mdl),
      audioSeconds: null,
    };
    if (data?.duration != null) {
      const secs = Math.round(Number(data.duration) * 10) / 10;
      if (!Number.isNaN(secs)) out.audioSeconds = secs;
    }
    return out;
  } finally { cleanup(); }
}
