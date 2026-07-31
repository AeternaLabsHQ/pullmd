import { imageSize } from 'image-size';
import { resolveProvider, mapUsage, abortController } from './providers.js';

const TIMEOUT_MS = 60_000;
const DEFAULT_MODEL = 'gpt-4o-mini';
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
// max_tokens caps visible output. max_completion_tokens caps visible output
// *plus* the reasoning tokens a reasoning model never shows, so the same number
// would be spent thinking before a single word of caption is written.
const MAX_OUTPUT_TOKENS = 500;
const MAX_COMPLETION_TOKENS = 4000;
const PROMPT = 'Write a detailed caption describing this image.';

/**
 * Caption an image via an OpenAI-compatible vision chat endpoint.
 * @returns {Promise<{markdown:string, usage:object|null, imageSize:string|null}|null>}
 *          null when no vision provider is configured (caller degrades).
 */
export async function captionImage(buffer, opts = {}) {
  const { mimetype, fetch: fetchFn = globalThis.fetch } = opts;
  const { apiKey, baseUrl, model } = resolveProvider('VISION');
  if (!apiKey) return null;
  if (buffer.length > MAX_IMAGE_BYTES) throw new Error('image too large for captioning (max 20 MB)');

  const base = (baseUrl || 'https://api.openai.com/v1').replace(/\/$/, '');
  const mime = (mimetype || '').startsWith('image/') ? mimetype : 'image/jpeg';
  const dataUri = `data:${mime};base64,${buffer.toString('base64')}`;
  let size = null;
  try { const d = imageSize(buffer.subarray(0, 4096)); if (d?.width && d?.height) size = `${d.width}x${d.height}`; } catch { size = null; }

  const { signal, cleanup } = abortController(opts, TIMEOUT_MS);
  try {
    const post = (budget) => fetchFn(`${base}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: model || DEFAULT_MODEL,
        messages: [{ role: 'user', content: [
          { type: 'text', text: PROMPT },
          { type: 'image_url', image_url: { url: dataUri } },
        ] }],
        ...budget,
      }),
      signal,
    });
    const readBody = async (r) => { try { return (await r.text()) || ''; } catch { return ''; } };

    let res = await post({ max_tokens: MAX_OUTPUT_TOKENS });
    let detail = '';
    if (!res.ok) {
      detail = await readBody(res);
      // Newer OpenAI models refuse max_tokens and demand max_completion_tokens,
      // while plenty of other OpenAI-compatible endpoints only understand
      // max_tokens. So ask the way everything understands and switch over only
      // when the endpoint explicitly says to - guessing from the model name
      // would go stale with every release.
      if (res.status === 400 && detail.includes('max_completion_tokens')) {
        res = await post({ max_completion_tokens: MAX_COMPLETION_TOKENS });
        detail = res.ok ? '' : await readBody(res);
      }
    }
    if (!res.ok) {
      throw new Error(`captioning failed (${res.status})${detail ? ': ' + detail.slice(0, 200) : ''}`);
    }
    const data = await res.json();
    const choice = data?.choices?.[0];
    const caption = (choice?.message?.content || '').trim();
    if (!caption) {
      // Returning an empty caption would emit a "## Description" heading with
      // nothing under it and still claim the image-caption source. The caller
      // catches this and falls back, which is the honest outcome.
      const reasoned = data?.usage?.completion_tokens_details?.reasoning_tokens;
      throw new Error(choice?.finish_reason === 'length'
        ? `captioning produced no text: the whole token budget went to reasoning${reasoned ? ` (${reasoned} tokens)` : ''}`
        : 'captioning produced no text');
    }
    return {
      markdown: `## Description\n\n${caption}`,
      usage: mapUsage(data?.usage, data?.model || model || DEFAULT_MODEL),
      imageSize: size,
    };
  } finally { cleanup(); }
}
