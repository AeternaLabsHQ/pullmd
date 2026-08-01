/**
 * Download filename scheme.
 *
 * The PWA used to derive the download name client-side from the frontmatter
 * title alone, which produced cryptic names for YouTube (the video id ended up
 * as the title) and threw away the original basename for images and documents.
 * The server knows the extraction source, the URL and the title, so it builds
 * the suggestion and ships it as `X-Suggested-Filename`.
 *
 * Everything here is pure: no env reads, no clock reads. The caller passes
 * `datePrefixFormat` (from PULLMD_FILENAME_DATE_PREFIX) and `now`, so tests are
 * deterministic.
 */

/** Extraction sources whose URL basename is the real name of the thing. */
const FILE_SOURCES = new Set(['image-caption', 'audio-transcript', 'markitdown', 'pdf-ocr']);

/**
 * Slugify a string for use in a filename. Same semantics as the PWA's
 * slugifyFilename: lowercase, everything outside a-z0-9 becomes a hyphen (no
 * transliteration - "Über" becomes "ber"), runs collapse, capped at 60 chars
 * with no trailing hyphen.
 *
 * @param {*} s
 * @returns {string} slug, possibly empty
 */
export function slugify(s) {
  return String(s ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/, '');
}

/**
 * Extract a YouTube video id from a watch / youtu.be / shorts / live / embed URL.
 *
 * @param {string} url
 * @returns {string} the id, or '' when none can be found
 */
export function youtubeVideoId(url) {
  const clean = (v) => String(v || '').replace(/[^A-Za-z0-9_-]/g, '');
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, '').toLowerCase();
    if (host === 'youtu.be') return clean(u.pathname.split('/').filter(Boolean)[0]);
    const v = u.searchParams.get('v');
    if (v) return clean(v);
    const m = u.pathname.match(/^\/(?:shorts|live|embed|v)\/([^/]+)/);
    if (m) return clean(m[1]);
  } catch {
    // not a URL - no id
  }
  return '';
}

/**
 * Basename of a URL path: percent-decoded, query/hash stripped, extension
 * removed. Tolerates a bare filename instead of a URL (the local-upload paths
 * hand us one).
 *
 * @param {string} url
 * @returns {string} basename without extension, possibly empty
 */
export function urlBasename(url) {
  let pathname;
  try {
    pathname = new URL(url).pathname;
  } catch {
    pathname = String(url ?? '').split(/[?#]/)[0];
  }
  let base = pathname.split('/').filter(Boolean).pop() || '';
  try {
    base = decodeURIComponent(base);
  } catch {
    // malformed percent-escape - keep the raw form
  }
  return base.replace(/\.[A-Za-z0-9]{1,8}$/, '');
}

/**
 * Render a date prefix template. Tokens YYYY MM DD HH mm ss are substituted
 * zero-padded in local time; every other character passes through unchanged.
 *
 * @param {string} [format]  e.g. "YYYY-MM-DD-HH-mm-ss-"
 * @param {Date} [now]
 * @returns {string} rendered prefix, '' when no format is configured
 */
export function formatDatePrefix(format, now) {
  if (!format) return '';
  const d = (now instanceof Date && !Number.isNaN(now.getTime())) ? now : new Date();
  const p2 = (n) => String(n).padStart(2, '0');
  const tokens = {
    YYYY: String(d.getFullYear()),
    MM: p2(d.getMonth() + 1),
    DD: p2(d.getDate()),
    HH: p2(d.getHours()),
    mm: p2(d.getMinutes()),
    ss: p2(d.getSeconds()),
  };
  return String(format).replace(/YYYY|MM|DD|HH|mm|ss/g, (t) => tokens[t]);
}

/**
 * Suggest a download filename for a conversion.
 *
 * Rules by source:
 * - `youtube`          -> `YT-<title-slug>-<video-id>.md`
 * - file-based sources -> original URL basename (image-caption, audio-transcript,
 *   markitdown, pdf-ocr)
 * - everything else    -> `<title-slug>.md`
 *
 * Fallback chain when a rule yields nothing: title -> URL basename -> shareId
 * -> `pullmd`.
 *
 * @param {object} opts
 * @param {string} [opts.source]            extraction source label
 * @param {string} [opts.title]             the same title that goes into the frontmatter
 * @param {string} [opts.url]               source URL (or a bare filename for uploads)
 * @param {string} [opts.shareId]           share id, used as a last-resort name
 * @param {string} [opts.datePrefixFormat]  template, '' / undefined = no prefix
 * @param {Date} [opts.now]                 clock for the prefix
 * @returns {string} a header-safe filename ending in `.md`
 */
export function suggestFilename({ source, title, url, shareId, datePrefixFormat, now } = {}) {
  let base = '';

  if (source === 'youtube') {
    const parts = [slugify(title), youtubeVideoId(url)].filter(Boolean);
    // Keep the YT- marker uppercase so a folder of downloads sorts by kind.
    if (parts.length) base = 'YT-' + parts.join('-');
  } else if (FILE_SOURCES.has(source)) {
    base = slugify(urlBasename(url));
  }

  if (!base) {
    base = slugify(title) || slugify(urlBasename(url)) || slugify(shareId) || 'pullmd';
  }

  // The prefix template passes arbitrary characters through, so the assembled
  // name gets a final pass: an HTTP header value (and a filesystem) must not
  // see anything outside this set.
  const safe = (formatDatePrefix(datePrefixFormat, now) + base).replace(/[^A-Za-z0-9._-]/g, '-');
  return (safe || 'pullmd') + '.md';
}
