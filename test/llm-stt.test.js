import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { transcribeAudio } from '../lib/llm/stt.js';

const save = () => ({ k: process.env.PULLMD_STT_API_KEY, b: process.env.PULLMD_STT_BASE_URL, m: process.env.PULLMD_STT_MODEL, lk: process.env.PULLMD_LLM_API_KEY });
const restore = (s) => {
  for (const [env, v] of [['PULLMD_STT_API_KEY', s.k], ['PULLMD_STT_BASE_URL', s.b], ['PULLMD_STT_MODEL', s.m], ['PULLMD_LLM_API_KEY', s.lk]]) {
    if (v === undefined) delete process.env[env]; else process.env[env] = v;
  }
};

describe('transcribeAudio', () => {
  it('returns null when no provider is configured', async () => {
    const s = save(); delete process.env.PULLMD_STT_API_KEY; delete process.env.PULLMD_LLM_API_KEY;
    assert.equal(await transcribeAudio(Buffer.from('x'), { filename: 'a.mp3', fetch: async () => { throw new Error('no'); } }), null);
    restore(s);
  });

  it('POSTs multipart to /audio/transcriptions (whisper → verbose_json) and returns transcript + audioSeconds', async () => {
    const s = save(); process.env.PULLMD_STT_API_KEY = 'k'; process.env.PULLMD_STT_BASE_URL = 'https://stt/v1'; delete process.env.PULLMD_STT_MODEL; delete process.env.PULLMD_LLM_API_KEY;
    let captured;
    const fetchFn = async (url, opts) => { captured = { url, opts }; return { ok: true, json: async () => ({ text: 'Hello world.', duration: 12.34, usage: { total_tokens: 7 } }) }; };
    const r = await transcribeAudio(Buffer.from('AUDIO'), { filename: 'clip.mp3', mimetype: 'audio/mpeg', fetch: fetchFn });
    assert.equal(captured.url, 'https://stt/v1/audio/transcriptions');
    assert.equal(captured.opts.headers.Authorization, 'Bearer k');
    assert.ok(captured.opts.body instanceof FormData);
    assert.equal(captured.opts.body.get('model'), 'whisper-1');
    assert.equal(captured.opts.body.get('response_format'), 'verbose_json');
    assert.equal(r.markdown, '### Audio Transcript\n\nHello world.');
    assert.equal(r.audioSeconds, 12.3);
    assert.deepEqual(r.usage, { model: 'whisper-1', total_tokens: 7 });
    restore(s);
  });

  it('non-whisper model omits response_format', async () => {
    const s = save(); process.env.PULLMD_STT_API_KEY = 'k'; process.env.PULLMD_STT_MODEL = 'gpt-4o-transcribe'; delete process.env.PULLMD_LLM_API_KEY;
    let captured;
    await transcribeAudio(Buffer.from('A'), { filename: 'a.wav', fetch: async (u, o) => { captured = o; return { ok: true, json: async () => ({ text: 'hi' }) }; } });
    assert.equal(captured.body.get('response_format'), null);
    restore(s);
  });

  it('throws on a non-ok response and surfaces the body', async () => {
    const s = save(); process.env.PULLMD_STT_API_KEY = 'k'; delete process.env.PULLMD_LLM_API_KEY;
    await assert.rejects(
      () => transcribeAudio(Buffer.from('x'), { filename: 'a.mp3', fetch: async () => ({ ok: false, status: 500, text: async () => 'upstream boom' }) }),
      /transcription failed \(500\): upstream boom/
    );
    restore(s);
  });
});
