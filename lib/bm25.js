/**
 * Pure, dependency-free tokenizer and BM25 scorer.
 *
 * No HTTP, no cache, no imports from server.js or elsewhere in the repo —
 * this module only turns text into tokens (`tokenize`) and scores token
 * arrays against a query using Okapi BM25 with Lucene-style IDF
 * (`scoreBm25`). It is the scoring half of the (later, opt-in) query-extract
 * feature; the section tree it scores against is produced by
 * `lib/markdown-sections.js`.
 */

const TOKEN_RE = /[\p{L}\p{N}]+(?:[-.][\p{L}\p{N}]+)*/gu;

/**
 * Tokenizes text for BM25 scoring: lowercases, then extracts runs of
 * letters/digits that may contain internal hyphens or dots (e.g.
 * `os.path`, `better-sqlite3`), splitting on everything else. No stopword
 * list, no stemming.
 *
 * @param {string} text  Raw text to tokenize.
 * @returns {string[]} Tokens in order of appearance; `[]` for empty or
 *   no-match input.
 */
export function tokenize(text) {
  if (!text) return [];
  const matches = text.toLowerCase().match(TOKEN_RE);
  return matches ? matches : [];
}

/**
 * Scores each doc against a query using Okapi BM25 with Lucene-style IDF.
 *
 * The corpus is exactly `docs` (all docs passed in this call) — IDF and
 * average document length are computed per-call, not globally. Duplicate
 * query tokens are deduped before scoring (each unique query term
 * contributes once). Guards against NaN when `docs` is empty, a doc is
 * empty, or the whole corpus is empty (avgdl would be 0).
 *
 * @param {string[]} queryTokens  Query tokens, e.g. from {@link tokenize}.
 * @param {string[][]} docs  Corpus: one token array per doc.
 * @param {{k1?: number, b?: number}} [opts]  BM25 parameters.
 *   `k1` controls term-frequency saturation (default 1.5), `b` controls
 *   length normalization strength (default 0.75).
 * @returns {number[]} One score per doc, in `docs` order. `0` when a doc
 *   matches no query term or has no tokens.
 */
export function scoreBm25(queryTokens, docs, { k1 = 1.5, b = 0.75 } = {}) {
  const n = docs.length;
  if (n === 0) return [];

  const scores = new Array(n).fill(0);

  const queryTerms = [...new Set(queryTokens)];
  if (queryTerms.length === 0) return scores;

  const docLengths = docs.map(doc => doc.length);
  const totalLength = docLengths.reduce((sum, len) => sum + len, 0);
  const avgdl = n > 0 ? totalLength / n : 0;
  if (avgdl === 0) return scores;

  // Precompute per-doc term frequencies.
  const docTermFreqs = docs.map(doc => {
    const freqs = new Map();
    for (const term of doc) {
      freqs.set(term, (freqs.get(term) || 0) + 1);
    }
    return freqs;
  });

  for (const term of queryTerms) {
    const df = docTermFreqs.reduce((count, freqs) => count + (freqs.has(term) ? 1 : 0), 0);
    if (df === 0) continue;

    // idf is always > 0 here: df in [1, n] means the numerator (n - df + 0.5)
    // is always >= 0.5, so log(1 + positive) never reaches 0.
    const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));

    for (let i = 0; i < n; i++) {
      const tf = docTermFreqs[i].get(term);
      if (!tf) continue;
      const dl = docLengths[i];
      const denom = tf + k1 * (1 - b + (b * dl) / avgdl);
      scores[i] += (idf * (tf * (k1 + 1))) / denom;
    }
  }

  return scores;
}
