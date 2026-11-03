// Subtitle files (.srt, .vtt) to readable text: cue numbers, timestamps and
// styling go, rolling auto-caption repeats collapse, longer pauses start a
// new paragraph.
import { decodeTextFile, filenameStem, looksBinary } from './text-decode.js';
import { unprocessable } from './mail-render.js';

const PARAGRAPH_GAP_SECONDS = 2;
const TIMING_RE = /^\s*((?:\d+:)?\d{1,2}:\d{2}[.,]\d{1,3})\s*-->\s*((?:\d+:)?\d{1,2}:\d{2}[.,]\d{1,3})/;

export function isSubtitleFile(contentType, filename) {
  if (/\.(srt|vtt)$/i.test(filename || '')) return true;
  if (/\.[^./\\]+$/.test(filename || '')) return false;
  return /^(text\/vtt|application\/x-subrip|text\/srt)\b/i.test(contentType || '');
}

function toSeconds(ts) {
  const parts = ts.replace(',', '.').split(':').map(Number);
  return parts.reduce((acc, n) => acc * 60 + n, 0);
}

function cleanLine(line) {
  return line
    .replace(/<[^>]*>/g, '')            // <i>, <c.color>, <v Speaker>, <00:00:01.000>
    .replace(/\{\\[^}]*\}/g, '')         // SSA override tags in SRT: {\an8}
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

/** @returns {Array<{start:number,end:number,lines:string[]}>} */
export function parseCues(text) {
  const blocks = text.replace(/\r\n?/g, '\n').split(/\n{2,}/);
  const cues = [];
  for (const block of blocks) {
    const lines = block.split('\n');
    const idx = lines.findIndex((l) => TIMING_RE.test(l));
    if (idx === -1) continue;                       // WEBVTT header, NOTE, STYLE, REGION, stray text
    const m = lines[idx].match(TIMING_RE);
    const cueLines = lines.slice(idx + 1).map(cleanLine).filter(Boolean);
    if (cueLines.length) cues.push({ start: toSeconds(m[1]), end: toSeconds(m[2]), lines: cueLines });
  }
  return cues;
}

export function cuesToParagraphs(cues) {
  const paragraphs = [];
  let current = [];
  let lastEnd = null;
  let lastLine = null;
  for (const cue of cues) {
    if (lastEnd !== null && cue.start - lastEnd >= PARAGRAPH_GAP_SECONDS && current.length) {
      paragraphs.push(current.join(' '));
      current = [];
    }
    for (const line of cue.lines) {
      // Rolling captions repeat the previous cue's last line(s).
      if (line === lastLine) continue;
      current.push(line);
      lastLine = line;
    }
    lastEnd = Math.max(lastEnd ?? 0, cue.end);
  }
  if (current.length) paragraphs.push(current.join(' '));
  return paragraphs;
}

/**
 * @param {Buffer} buffer
 * @param {object} [options]  filename
 */
export async function extractSubtitles(buffer, options = {}) {
  const text = decodeTextFile(buffer);
  if (looksBinary(text)) {
    throw unprocessable('This does not look like a subtitle file. / Das sieht nicht nach einer Untertiteldatei aus.', 'not_subtitles');
  }
  const cues = parseCues(text);
  if (!cues.length) {
    throw unprocessable('No subtitle cues found (expected SRT or WebVTT timestamps). / Keine Untertitel gefunden (SRT- oder WebVTT-Zeitstempel erwartet).', 'not_subtitles');
  }
  const paragraphs = cuesToParagraphs(cues);
  const title = filenameStem(options.filename) || 'Subtitles';
  const body = paragraphs.join('\n\n');
  return {
    markdown: `# ${title}\n\n${body}\n`,
    title,
    source: 'subtitles',
    metadata: { title, sourceUrl: null, contentLength: body.length },
  };
}
