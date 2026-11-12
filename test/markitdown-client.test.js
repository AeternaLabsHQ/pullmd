import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { convertViaMarkitdown, convertYoutubeViaSidecar } from '../lib/markitdown-client.js';

const okResp = (json) => ({ ok: true, json: async () => json });

describe('convertViaMarkitdown', () => {
  it('returns null without calling fetch when no URL is configured', async () => {
    const saved = process.env.MARKITDOWN_URL;
    delete process.env.MARKITDOWN_URL;
    let calls = 0;
    try {
      const out = await convertViaMarkitdown(Buffer.from('x'), {
        fetch: async () => { calls++; return okResp({ markdown: '# Doc', title: 'Doc' }); },
      });
      assert.equal(out, null);
      assert.equal(calls, 0);
    } finally {
      if (saved !== undefined) process.env.MARKITDOWN_URL = saved;
    }
  });

  it('POSTs bytes to the sidecar and returns {markdown,title}', async () => {
    let captured;
    const fetchFn = async (url, opts) => { captured = { url, opts }; return okResp({ markdown: '# Doc\n\nhi', title: 'Doc' }); };
    const out = await convertViaMarkitdown(Buffer.from('PDFBYTES'), {
      url: 'http://markitdown:8003/convert',
      contentType: 'application/pdf',
      filename: 'a b.pdf',
      fetch: fetchFn,
    });
    assert.deepEqual(out, { markdown: '# Doc\n\nhi', title: 'Doc', usage: null, audioSeconds: null, imageSize: null });
    assert.equal(captured.url, 'http://markitdown:8003/convert');
    assert.equal(captured.opts.method, 'POST');
    assert.equal(captured.opts.headers['Content-Type'], 'application/pdf');
    assert.equal(captured.opts.headers['X-Filename'], encodeURIComponent('a b.pdf'));
  });

  it('returns null on a non-ok response', async () => {
    const out = await convertViaMarkitdown(Buffer.from('x'), {
      url: 'http://m/convert', fetch: async () => ({ ok: false, status: 422, json: async () => ({}) }),
    });
    assert.equal(out, null);
  });

  it('returns null when the sidecar throws', async () => {
    const out = await convertViaMarkitdown(Buffer.from('x'), {
      url: 'http://m/convert', fetch: async () => { throw new Error('econnrefused'); },
    });
    assert.equal(out, null);
  });

  it('returns null when the response lacks a markdown string', async () => {
    const out = await convertViaMarkitdown(Buffer.from('x'), {
      url: 'http://m/convert', fetch: async () => okResp({ title: 'x' }),
    });
    assert.equal(out, null);
  });

  // The client does not short-circuit: it still calls fetch, but with an
  // internal signal that is already aborted, and maps the rejection to null.
  it('hands fetch an already-aborted signal and returns null when it rejects', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    let abortedAtCall = null;
    const out = await convertViaMarkitdown(Buffer.from('x'), {
      url: 'http://m/convert',
      signal: ctrl.signal,
      fetch: async (u, o) => {
        abortedAtCall = o.signal.aborted;
        if (o.signal.aborted) throw new DOMException('aborted', 'AbortError');
        return okResp({ markdown: '# Doc', title: 'Doc' });
      },
    });
    assert.equal(abortedAtCall, true, 'internal signal must already be aborted when fetch is invoked');
    assert.equal(out, null);
  });
});

describe('convertYoutubeViaSidecar', () => {
  it('returns null without calling fetch when sourceUrl is missing', async () => {
    let calls = 0;
    const out = await convertYoutubeViaSidecar('<html>', {
      url: 'http://m/convert',
      fetch: async () => { calls++; return okResp({ markdown: 'x', title: 't' }); },
    });
    assert.equal(out, null);
    assert.equal(calls, 0);
  });

  it('POSTs to /youtube with X-Source-Url + format headers', async () => {
    let cap;
    const out = await convertYoutubeViaSidecar('<html>p</html>', {
      url: 'http://markitdown:8003/convert',
      sourceUrl: 'https://www.youtube.com/watch?v=abc123',
      timecodes: 'plain', chunk: 0,
      fetch: async (u, o) => { cap = { u, o }; return okResp({ markdown: '## Transcript\n\nhi', title: 'V', fields: { channel: 'C' } }); },
    });
    assert.equal(out.title, 'V');
    assert.equal(out.fields.channel, 'C');
    assert.equal(cap.u, 'http://markitdown:8003/youtube');
    assert.equal(cap.o.headers['X-Source-Url'], 'https://www.youtube.com/watch?v=abc123');
    assert.equal(cap.o.headers['X-YT-Timecodes'], 'plain');
    assert.equal(cap.o.headers['X-YT-Chunk'], '0');
  });

  it('passes transcript_status through as transcriptStatus', async () => {
    const out = await convertYoutubeViaSidecar('<html>', {
      url: 'http://m/convert', sourceUrl: 'https://www.youtube.com/watch?v=x',
      fetch: async () => okResp({ markdown: '## Transcript\n\n_x_', title: 'V', fields: {}, transcript_status: 'blocked' }),
    });
    assert.equal(out.transcriptStatus, 'blocked');
  });

  it('omits format headers when not given', async () => {
    let cap;
    await convertYoutubeViaSidecar('<html>', {
      url: 'http://m/convert', sourceUrl: 'https://www.youtube.com/watch?v=x',
      fetch: async (u, o) => { cap = o; return okResp({ markdown: 'x', title: 't' }); },
    });
    assert.equal(cap.headers['X-YT-Timecodes'], undefined);
    assert.equal(cap.headers['X-YT-Chunk'], undefined);
  });

  it('derives the /youtube endpoint when MARKITDOWN_URL has no /convert suffix', async () => {
    let cap;
    await convertYoutubeViaSidecar('<html>', {
      url: 'http://markitdown:8003', sourceUrl: 'https://www.youtube.com/watch?v=x',
      fetch: async (u) => { cap = u; return okResp({ markdown: 'x', title: 't' }); },
    });
    assert.equal(cap, 'http://markitdown:8003/youtube');
  });

  it('derives the /youtube endpoint when the base has a trailing slash', async () => {
    let cap;
    await convertYoutubeViaSidecar('<html>', {
      url: 'http://markitdown:8003/convert/', sourceUrl: 'https://www.youtube.com/watch?v=x',
      fetch: async (u) => { cap = u; return okResp({ markdown: 'x', title: 't' }); },
    });
    assert.equal(cap, 'http://markitdown:8003/youtube');
  });

  it('propagates an already-aborted signal to the fetch (no dangling request)', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    let abortedAtCall = null;
    await convertYoutubeViaSidecar('<html>', {
      url: 'http://m/convert', sourceUrl: 'https://www.youtube.com/watch?v=x',
      signal: ctrl.signal,
      fetch: async (u, o) => { abortedAtCall = o.signal.aborted; return okResp({ markdown: 'x', title: 't' }); },
    });
    assert.equal(abortedAtCall, true, 'internal signal must already be aborted when fetch is invoked');
  });
});
