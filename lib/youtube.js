const YT_HOST_RE = /^(www\.|m\.|music\.)?youtube\.com$/i;

export function isYoutubeUrl(rawUrl) {
  let u;
  try { u = new URL(rawUrl); } catch { return false; }
  const host = u.hostname.toLowerCase();
  if (host === 'youtu.be') return u.pathname.length > 1;
  if (YT_HOST_RE.test(host)) {
    if (u.pathname === '/watch' && u.searchParams.get('v')) return true;
    if (u.pathname.startsWith('/shorts/')) return true;
  }
  return false;
}

export function normalizeYoutubeWatchUrl(rawUrl) {
  let u;
  try { u = new URL(rawUrl); } catch { return rawUrl; }
  const host = u.hostname.toLowerCase();
  let id = null;
  if (host === 'youtu.be') id = u.pathname.slice(1).split('/')[0];
  else if (u.pathname.startsWith('/shorts/')) id = u.pathname.split('/')[2];
  else if (u.pathname === '/watch') id = u.searchParams.get('v');
  if (!id) return rawUrl;
  return `https://www.youtube.com/watch?v=${id}`;
}
