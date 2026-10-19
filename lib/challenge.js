/**
 * Bot-protection challenge detection (issues #67, #68).
 *
 * Some CDNs answer a plain fetch with an interstitial that a browser would
 * solve with JavaScript (Cloudflare "Just a moment...", Bunny Shield
 * proof-of-work). PullMD does not try to solve these - the headless sidecar
 * is rejected by them as well - but it must not pass the interstitial off as
 * the article (gocomics.com returned it with HTTP 200, so the extractor
 * happily produced "Establishing a secure connection ... Request ID: ...").
 *
 * Detection is header-first (both vendors label their challenges) with a
 * narrow body fallback for the cases where the header is missing.
 */

export class BotChallengeError extends Error {
  /** @param {string} vendor  Human-readable vendor name, e.g. "Cloudflare". */
  constructor(vendor, status) {
    super(`Site is behind a bot-protection challenge (${vendor}); PullMD does not solve these. Workaround: save the page from your browser and upload the HTML via POST /api/html.`);
    this.name = 'BotChallengeError';
    this.vendor = vendor;
    this.status = status;
  }
}

/**
 * Inspect response headers for a vendor challenge marker.
 * @param {{ get(name: string): string | null }} headers
 * @returns {string | null} vendor name, or null when no marker is present
 */
export function challengeVendorFromHeaders(headers) {
  const cf = (headers.get('cf-mitigated') || '').toLowerCase();
  if (cf === 'challenge') return 'Cloudflare';
  const bunny = (headers.get('cdn-challenge') || '').toLowerCase();
  if (bunny === 'true') return 'Bunny Shield';
  return null;
}

/**
 * Body fallback. Only the first few KB matter - both interstitials announce
 * themselves in <head>. Patterns are deliberately specific so a page that
 * merely mentions Cloudflare in its text is never mistaken for a challenge.
 * @param {string} html
 * @returns {string | null}
 */
export function challengeVendorFromBody(html) {
  if (typeof html !== 'string' || !html) return null;
  const head = html.slice(0, 8192);
  if (/<title>\s*Just a moment\.\.\.\s*<\/title>/i.test(head) && /cdn-cgi\/challenge-platform|cf-chl|_cf_chl_opt/i.test(head)) {
    return 'Cloudflare';
  }
  if (/\/\.bunny-shield\//i.test(head) && /data-pow=|shield-challenge\.js/i.test(head)) {
    return 'Bunny Shield';
  }
  return null;
}
