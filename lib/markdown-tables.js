/**
 * Strip the column padding node-html-markdown puts into pipe tables.
 *
 * NHM pads every cell to the width of the longest cell in its column, so one
 * long cell inflates the whole column with spaces. Markdown renderers ignore
 * that padding, but it costs tokens when the output goes to an LLM - on wide
 * comparison tables it is most of the table's size. Cell content is left
 * alone; only runs of spaces next to a `|` and the dash runs of the separator
 * row shrink. Fenced code blocks are skipped.
 */

const FENCE_RE = /^ {0,3}(```|~~~)/;
const SEPARATOR_RE = /^\s*\|(\s*:?-+:?\s*\|)+\s*$/;

export function compactTables(markdown) {
  if (!markdown || !markdown.includes('|')) return markdown;
  let fence = null;
  const lines = markdown.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const f = line.match(FENCE_RE);
    if (f) {
      if (!fence) fence = f[1];
      else if (f[1] === fence) fence = null;
      continue;
    }
    if (fence) continue;
    const t = line.trim();
    if (t.length < 2 || t[0] !== '|' || t[t.length - 1] !== '|') continue;
    if (SEPARATOR_RE.test(line)) {
      lines[i] = line.replace(/\|\s*(:?)-+(:?)\s*(?=\|)/g, '| $1---$2 ');
    } else {
      lines[i] = line.replace(/ {2,}\|/g, ' |').replace(/\| {2,}/g, '| ');
    }
  }
  return lines.join('\n');
}
