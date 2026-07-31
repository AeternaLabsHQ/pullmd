import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { captionImage } from '../lib/llm/vision.js';

const save = () => ({ k: process.env.PULLMD_VISION_API_KEY, b: process.env.PULLMD_VISION_BASE_URL, m: process.env.PULLMD_VISION_MODEL, lk: process.env.PULLMD_LLM_API_KEY });
const restore = (s) => {
  for (const [env, v] of [['PULLMD_VISION_API_KEY', s.k], ['PULLMD_VISION_BASE_URL', s.b], ['PULLMD_VISION_MODEL', s.m], ['PULLMD_LLM_API_KEY', s.lk]]) {
    if (v === undefined) delete process.env[env]; else process.env[env] = v;
  }
};
// 1x1 PNG
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000002000154a24f3f0000000049454e44ae426082', 'hex');

describe('captionImage', () => {
  it('returns null when no provider is configured', async () => {
    const s = save(); delete process.env.PULLMD_VISION_API_KEY; delete process.env.PULLMD_LLM_API_KEY;
    assert.equal(await captionImage(PNG, { mimetype: 'image/png', fetch: async () => { throw new Error('should not call'); } }), null);
    restore(s);
  });

  it('POSTs a vision chat request and returns markdown + usage + imageSize', async () => {
    const s = save();
    process.env.PULLMD_VISION_API_KEY = 'k'; process.env.PULLMD_VISION_BASE_URL = 'https://vis/v1'; delete process.env.PULLMD_VISION_MODEL; delete process.env.PULLMD_LLM_API_KEY;
    let captured;
    const fetchFn = async (url, opts) => { captured = { url, opts }; return { ok: true, json: async () => ({ model: 'gpt-4o-mini', choices: [{ message: { content: 'A red square.' } }], usage: { prompt_tokens: 100, completion_tokens: 8, total_tokens: 108 } }) }; };
    const r = await captionImage(PNG, { mimetype: 'image/png', fetch: fetchFn });
    assert.equal(captured.url, 'https://vis/v1/chat/completions');
    assert.equal(captured.opts.headers.Authorization, 'Bearer k');
    const sent = JSON.parse(captured.opts.body);
    assert.equal(sent.model, 'gpt-4o-mini');
    assert.equal(sent.messages[0].content[1].image_url.url.startsWith('data:image/png;base64,'), true);
    assert.equal(r.markdown, '## Description\n\nA red square.');
    assert.deepEqual(r.usage, { model: 'gpt-4o-mini', prompt_tokens: 100, completion_tokens: 8, total_tokens: 108 });
    assert.equal(r.imageSize, '1x1');
    restore(s);
  });

  it('throws on a non-ok response', async () => {
    const s = save(); process.env.PULLMD_VISION_API_KEY = 'k'; delete process.env.PULLMD_LLM_API_KEY;
    await assert.rejects(() => captionImage(PNG, { mimetype: 'image/png', fetch: async () => ({ ok: false, status: 422, json: async () => ({}) }) }), /captioning failed/);
    restore(s);
  });

  // Newer OpenAI models reject max_tokens outright. Most other
  // OpenAI-compatible endpoints only know max_tokens, so the request keeps
  // asking that way and switches only when the endpoint says to.
  it('retries with max_completion_tokens when the endpoint rejects max_tokens', async () => {
    const s = save();
    process.env.PULLMD_VISION_API_KEY = 'k'; process.env.PULLMD_VISION_MODEL = 'newer-model';
    delete process.env.PULLMD_VISION_BASE_URL; delete process.env.PULLMD_LLM_API_KEY;
    const sent = [];
    const fetchFn = async (url, opts) => {
      sent.push(JSON.parse(opts.body));
      if (sent.length === 1) {
        return {
          ok: false, status: 400,
          text: async () => JSON.stringify({ error: { message: "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.", type: 'invalid_request_error', param: 'max_tokens' } }),
        };
      }
      return { ok: true, json: async () => ({ model: 'newer-model', choices: [{ message: { content: 'A gradient.' } }] }) };
    };

    const r = await captionImage(PNG, { mimetype: 'image/png', fetch: fetchFn });

    assert.equal(sent.length, 2, 'exactly one retry');
    assert.equal(sent[0].max_tokens, 500, 'the first attempt asks the way every endpoint understands');
    assert.equal(sent[0].max_completion_tokens, undefined);
    assert.equal(sent[1].max_completion_tokens, 4000, 'the retry uses the parameter the endpoint asked for, with a budget that leaves room for reasoning tokens');
    assert.equal(sent[1].max_tokens, undefined, 'and must not send both');
    assert.equal(sent[1].model, 'newer-model');
    assert.equal(r.markdown, '## Description\n\nA gradient.');
    restore(s);
  });

  // A reasoning model can burn the entire budget on invisible reasoning tokens
  // and return an empty message. Handing that back as a caption produces a
  // heading with nothing under it; throwing lets the caller fall back.
  it('throws instead of returning an empty caption when the budget ran out', async () => {
    const s = save(); process.env.PULLMD_VISION_API_KEY = 'k'; delete process.env.PULLMD_LLM_API_KEY;
    const fetchFn = async () => ({
      ok: true,
      json: async () => ({ model: 'reasoner', choices: [{ message: { content: '' }, finish_reason: 'length' }], usage: { completion_tokens: 4000, completion_tokens_details: { reasoning_tokens: 4000 } } }),
    });

    await assert.rejects(() => captionImage(PNG, { mimetype: 'image/png', fetch: fetchFn }),
      /token budget|no text/i);
    restore(s);
  });

  it('throws on an empty caption even when the model stopped normally', async () => {
    const s = save(); process.env.PULLMD_VISION_API_KEY = 'k'; delete process.env.PULLMD_LLM_API_KEY;
    const fetchFn = async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: '   ' }, finish_reason: 'stop' }] }) });

    await assert.rejects(() => captionImage(PNG, { mimetype: 'image/png', fetch: fetchFn }), /no text/i);
    restore(s);
  });

  it('does not retry a 400 that is about something else', async () => {
    const s = save();
    process.env.PULLMD_VISION_API_KEY = 'k'; delete process.env.PULLMD_VISION_MODEL; delete process.env.PULLMD_LLM_API_KEY;
    let calls = 0;
    const fetchFn = async () => {
      calls++;
      return { ok: false, status: 400, text: async () => JSON.stringify({ error: { message: 'The model `nope` does not exist.' } }) };
    };

    await assert.rejects(() => captionImage(PNG, { mimetype: 'image/png', fetch: fetchFn }),
      /captioning failed \(400\).*does not exist/s);
    assert.equal(calls, 1);
    restore(s);
  });

  it('falls back to image/jpeg data-uri when mimetype is missing', async () => {
    const s = save(); process.env.PULLMD_VISION_API_KEY = 'k'; delete process.env.PULLMD_VISION_BASE_URL; delete process.env.PULLMD_VISION_MODEL; delete process.env.PULLMD_LLM_API_KEY;
    let captured;
    const fetchFn = async (url, opts) => { captured = { url, opts }; return { ok: true, json: async () => ({ choices: [{ message: { content: 'x' } }] }) }; };
    await captionImage(PNG, { fetch: fetchFn }); // no mimetype
    assert.equal(captured.url, 'https://api.openai.com/v1/chat/completions'); // default base
    const sent = JSON.parse(captured.opts.body);
    assert.ok(sent.messages[0].content[1].image_url.url.startsWith('data:image/jpeg;base64,'));
    restore(s);
  });
});
