import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { convertViaMarkitdown } from '../lib/markitdown-client.js';

const okResp = (json) => ({ ok: true, json: async () => json });

describe('convertViaMarkitdown', () => {
  it('returns null when no URL is configured', async () => {
    const out = await convertViaMarkitdown(Buffer.from('x'), { fetch: async () => okResp({}) });
    assert.equal(out, null);
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
    assert.deepEqual(out, { markdown: '# Doc\n\nhi', title: 'Doc' });
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

  it('returns null immediately when the signal is already aborted', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const out = await convertViaMarkitdown(Buffer.from('x'), {
      url: 'http://m/convert',
      signal: ctrl.signal,
      fetch: async () => { throw new Error('should not hang'); },
    });
    assert.equal(out, null);
  });
});
