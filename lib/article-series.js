/**
 * Article series: pages that publish one piece of writing as many short
 * <article> blocks by the same author - threads, serial posts, live notes.
 *
 * Readability commits to a single best candidate, so on these pages it keeps one
 * block and drops the rest. The coverage guard does not help: these pages are
 * short (it needs a 20,000c body), and the blocks often have page chrome between
 * them, so converting a common container would drag that chrome along. Each block
 * is converted on its own instead.
 *
 * The hard part is not firing on what merely looks similar. The signal is the
 * lead link - the first link inside each block:
 *   - a series repeats it, because every block opens with the same author link
 *   - a teaser list does not, because every card opens with a link to itself
 *   - a discussion does not either, because the authors differ
 * Headlines and link density then rule out the card lists that do open with a
 * shared link, such as an author's archive page.
 */

export const SERIES_LIMITS = {
  // Fewer blocks than this sharing a lead link is not a series.
  MIN_BLOCKS: 2,
  // Blocks from others tolerated next to a series. Above this it is a discussion.
  MAX_OTHERS_SHARE: 1 / 3,
  // Aggregate share of link text. Above this the blocks are navigation or cards.
  MAX_LINK_DENSITY: 0.5,
  // Share of the body text the series must hold to be what the page is about.
  MIN_BODY_SHARE: 0.4,
  // One block above this share of the series is an article, not a series.
  MAX_BLOCK_SHARE: 0.75,
  // Below this the series is too thin to be worth overriding the extractor.
  MIN_TEXT: 200,
  // How much larger the series must be before it replaces the chosen extract.
  MIN_GAIN: 1.5,
  // A trailing run this long of bare numbers is a counter row, not content.
  MIN_COUNTER_RUN: 2,
};

const HEADINGS = 'h1, h2, h3, h4';
const COUNTER_LINE = /^(?:\[[\d.,]+\s*[KMBkmb]?\]\([^)]*\)|[\d.,]+\s*[KMBkmb]?)$/;
const EMPTY_LINK_LINE = /^(?:>\s*)?\[\]\([^)]*\)$/;

/** Read at call time, so operators and tests can toggle it. */
export function isEnabled() {
  return String(process.env.PULLMD_ARTICLE_SERIES || '').trim().toLowerCase() !== 'off';
}

const normalize = (s) => (s || '').replace(/\s+/g, ' ').trim();
const textLength = (el) => normalize(el?.textContent).length;

function leadLink(block) {
  return block.querySelector('a[href]')?.getAttribute('href') || null;
}

/** Cheap pre-check on the raw HTML, to skip a re-parse on the ordinary page. */
export function mayContainSeries(html) {
  const first = html.indexOf('<article');
  return first !== -1 && html.indexOf('<article', first + 1) !== -1;
}

/**
 * Returns { blocks, duplicates, others, textLen } or null.
 *
 * A duplicate keeps its LAST position: a page that shows the linked post at the
 * top and again in its place in the series must not move it out of order.
 */
export function findArticleSeries(document) {
  const body = document.querySelector('body');
  if (!body) return null;
  const top = [...document.querySelectorAll('article')]
    .filter((a) => !a.parentElement?.closest('article'));
  if (top.length < SERIES_LIMITS.MIN_BLOCKS) return null;

  const distinct = new Map();
  for (const block of top) {
    const key = normalize(block.textContent);
    if (!key) continue;
    distinct.delete(key);
    distinct.set(key, block);
  }
  const unique = [...distinct.values()];
  const duplicates = top.length - unique.length;

  const groups = new Map();
  for (const block of unique) {
    const lead = leadLink(block);
    if (!lead) continue;
    if (!groups.has(lead)) groups.set(lead, []);
    groups.get(lead).push(block);
  }
  let blocks = [];
  for (const group of groups.values()) {
    if (group.length > blocks.length) blocks = group;
  }
  if (blocks.length < SERIES_LIMITS.MIN_BLOCKS) return null;

  const others = unique.length - blocks.length;
  if (others / unique.length > SERIES_LIMITS.MAX_OTHERS_SHARE) return null;
  if (blocks.some((b) => b.querySelector(HEADINGS))) return null;

  const lengths = blocks.map(textLength);
  const textLen = lengths.reduce((a, b) => a + b, 0);
  if (textLen < SERIES_LIMITS.MIN_TEXT) return null;
  if (Math.max(...lengths) / textLen > SERIES_LIMITS.MAX_BLOCK_SHARE) return null;

  const linkLen = blocks.reduce(
    (sum, b) => sum + [...b.querySelectorAll('a')].reduce((s, a) => s + textLength(a), 0),
    0,
  );
  if (linkLen / textLen > SERIES_LIMITS.MAX_LINK_DENSITY) return null;

  const bodyLen = textLength(body);
  if (bodyLen === 0 || textLen / bodyLen < SERIES_LIMITS.MIN_BODY_SHARE) return null;

  return { blocks, duplicates, others, textLen };
}

function dropEmptyLinks(lines) {
  return lines.filter((line) => !EMPTY_LINK_LINE.test(line.trim()));
}

function dropTrailingCounters(lines) {
  let end = lines.length;
  while (end > 0 && (lines[end - 1].trim() === '' || COUNTER_LINE.test(lines[end - 1].trim()))) end--;
  const counters = lines.slice(end).filter((l) => l.trim() !== '').length;
  return counters >= SERIES_LIMITS.MIN_COUNTER_RUN ? lines.slice(0, end) : lines;
}

/** Drop the leading lines a block repeats from the first one - the byline. */
function dropRepeatedLead(lines, firstLines) {
  const reference = firstLines.filter((l) => l.trim() !== '');
  let matched = 0;
  let cut = 0;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === '') continue;
    if (lines[i] !== reference[matched]) break;
    matched++;
    cut = i + 1;
  }
  const rest = lines.slice(cut);
  return rest.some((l) => l.trim() !== '') ? rest : lines;
}

/**
 * Convert each block on its own and join them. Mutates the blocks: nested
 * articles become blockquotes, so hand it a throwaway document.
 */
export function seriesToMarkdown(blocks, translate) {
  const converted = blocks.map((block) => {
    for (const nested of [...block.querySelectorAll('article')]) {
      const quote = block.ownerDocument.createElement('blockquote');
      quote.innerHTML = nested.innerHTML;
      nested.replaceWith(quote);
    }
    return dropTrailingCounters(dropEmptyLinks(translate(block.innerHTML).trim().split('\n')));
  });
  return converted
    .map((lines, i) => (i === 0 ? lines : dropRepeatedLead(lines, converted[0])).join('\n').trim())
    .join('\n\n---\n\n');
}

/** The transparency channel, like the coverage guard's: state what was done. */
export function seriesReason(series, seriesLen, extractLen, priorReason) {
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  return `article series: ${series.blocks.length} articles joined `
    + `(${plural(series.duplicates, 'duplicate')} and ${plural(series.others, 'other')} left out), `
    + `${seriesLen}c instead of ${extractLen}c; prior pick: ${priorReason}`;
}
