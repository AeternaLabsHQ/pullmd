import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { redditFetch, getToken, clearTokenCache, isAuthConfigured, getUserAgent, RedditAuthError } from '../lib/reddit-auth.js';

describe('reddit-auth', () => {
  beforeEach(() => clearTokenCache());

  describe('isAuthConfigured', () => {
    it('returns false when env vars missing', () => {
      assert.equal(isAuthConfigured({}), false);
      assert.equal(isAuthConfigured({ REDDIT_CLIENT_ID: 'x' }), false);
      assert.equal(isAuthConfigured({ REDDIT_CLIENT_SECRET: 'x' }), false);
    });
    it('returns true when both set', () => {
      assert.equal(isAuthConfigured({ REDDIT_CLIENT_ID: 'a', REDDIT_CLIENT_SECRET: 'b' }), true);
    });
  });

  describe('getUserAgent', () => {
    it('uses default if env unset', () => {
      assert.match(getUserAgent({}), /^PullMD/);
    });
    it('uses env override', () => {
      assert.equal(getUserAgent({ REDDIT_USER_AGENT: 'Custom/2.0' }), 'Custom/2.0');
    });
  });

  describe('getToken', () => {
    it('returns null when unconfigured', async () => {
      const token = await getToken({ env: {}, fetchFn: async () => { throw new Error('should not be called'); } });
      assert.equal(token, null);
    });

    it('fetches and caches token when configured', async () => {
      let callCount = 0;
      const fakeFetch = async (url, opts) => {
        callCount++;
        assert.equal(url, 'https://www.reddit.com/api/v1/access_token');
        assert.match(opts.headers['Authorization'], /^Basic /);
        assert.equal(opts.body, 'grant_type=client_credentials');
        return { ok: true, json: async () => ({ access_token: 'tok-abc', expires_in: 3600 }) };
      };
      const env = { REDDIT_CLIENT_ID: 'cid', REDDIT_CLIENT_SECRET: 'sec' };
      const t1 = await getToken({ env, fetchFn: fakeFetch });
      const t2 = await getToken({ env, fetchFn: fakeFetch });
      assert.equal(t1, 'tok-abc');
      assert.equal(t2, 'tok-abc');
      assert.equal(callCount, 1, 'token cached, only fetched once');
    });

    it('throws on token endpoint failure', async () => {
      const fakeFetch = async () => ({ ok: false, status: 401 });
      const env = { REDDIT_CLIENT_ID: 'cid', REDDIT_CLIENT_SECRET: 'sec' };
      await assert.rejects(() => getToken({ env, fetchFn: fakeFetch }), /401/);
    });
  });

  describe('redditFetch', () => {
    it('uses public Reddit when unconfigured', async () => {
      let calledWith = null;
      const fakeFetch = async (url, opts) => {
        calledWith = { url, opts };
        return { ok: true, json: async () => ({}) };
      };
      await redditFetch('https://www.reddit.com/r/programming/hot.json', {}, { env: {}, fetchFn: fakeFetch });
      assert.equal(calledWith.url, 'https://www.reddit.com/r/programming/hot.json');
      assert.equal(calledWith.opts.headers['Authorization'], undefined);
      assert.match(calledWith.opts.headers['User-Agent'], /PullMD/);
    });

    it('rewrites to oauth.reddit.com and adds Bearer when configured', async () => {
      let tokenCalls = 0;
      let dataCalls = 0;
      let dataUrl = null;
      const fakeFetch = async (url, opts) => {
        if (url.includes('access_token')) {
          tokenCalls++;
          return { ok: true, json: async () => ({ access_token: 'bearer-xyz', expires_in: 3600 }) };
        }
        dataCalls++;
        dataUrl = url;
        assert.equal(opts.headers['Authorization'], 'Bearer bearer-xyz');
        return { ok: true, json: async () => ({}) };
      };
      const env = { REDDIT_CLIENT_ID: 'cid', REDDIT_CLIENT_SECRET: 'sec', REDDIT_USER_AGENT: 'Test/1.0' };
      await redditFetch('https://www.reddit.com/r/programming/hot.json', {}, { env, fetchFn: fakeFetch });
      assert.equal(dataUrl, 'https://oauth.reddit.com/r/programming/hot.json');
      assert.equal(tokenCalls, 1);
      assert.equal(dataCalls, 1);
    });

    it('does not rewrite non-Reddit URLs', async () => {
      let calledUrl = null;
      const fakeFetch = async (url) => {
        if (url.includes('access_token')) return { ok: true, json: async () => ({ access_token: 't', expires_in: 3600 }) };
        calledUrl = url;
        return { ok: true, json: async () => ({}) };
      };
      const env = { REDDIT_CLIENT_ID: 'cid', REDDIT_CLIENT_SECRET: 'sec' };
      await redditFetch('https://example.com/foo', {}, { env, fetchFn: fakeFetch });
      assert.equal(calledUrl, 'https://example.com/foo');
    });
  });

  describe('rejected credentials (#98)', () => {
    const env = { REDDIT_CLIENT_ID: 'bad', REDDIT_CLIENT_SECRET: 'bad' };
    for (const status of [401, 403]) {
      it(`throws RedditAuthError on a ${status} from the token endpoint`, async () => {
        const fetchFn = async () => ({ ok: false, status, json: async () => ({}) });
        await assert.rejects(() => getToken({ env, fetchFn }), (err) => err instanceof RedditAuthError && err.status === status);
      });
    }
    it('keeps the generic error for other statuses', async () => {
      const fetchFn = async () => ({ ok: false, status: 500, json: async () => ({}) });
      await assert.rejects(() => getToken({ env, fetchFn }), (err) => !(err instanceof RedditAuthError) && /failed: 500/.test(err.message));
    });
  });
});
