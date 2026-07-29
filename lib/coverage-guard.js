/**
 * Coverage guard: detect extractions that kept only a sliver of the page.
 *
 * Readability commits to a single best candidate container. On pages whose body
 * is one wrapper full of flat sibling blocks — the shape page builders emit for
 * one-pagers — it keeps one block and silently drops the rest. The output looks
 * well-formed, so nothing downstream notices.
 *
 * The signal is the ratio between the chosen extract and the cleaned body text.
 * A tiny ratio alone is not enough (listing pages legitimately extract little),
 * so the guard additionally requires that a single container holds nearly all of
 * the body text — that is what distinguishes "one article split across siblings"
 * from "many separate teasers".
 *
 * Thresholds are calibrated against an 85-page live corpus; see
 * docs/superpowers/specs/2026-07-29-coverage-guard-design.md.
 */
import { metrics } from './scoring.js';

export const GUARD_LIMITS = {
  // Below this much cleaned body text a small extract is unremarkable.
  MIN_BODY_TEXT: 20_000,
  // Extract / body ratio under which the extraction is treated as suspect.
  MAX_COVERAGE: 0.10,
  // Share of its parent's text a child must hold to be descended into.
  DOMINANCE: 0.90,
  // How much larger the recovered candidate must be before it is trusted.
  MIN_GAIN: 3,
  // Prose floor that separates a real body from nav soup.
  MIN_PARAGRAPHS: 5,
  // Backstop against pathological markup.
  MAX_DEPTH: 30,
};

/**
 * The guard is on by default and switched off with PULLMD_COVERAGE_GUARD=off.
 * Read at call time, not at module load, so operators and tests can toggle it.
 */
export function isEnabled() {
  return String(process.env.PULLMD_COVERAGE_GUARD || '').trim().toLowerCase() !== 'off';
}

function textLength(el) {
  if (!el) return 0;
  return (el.textContent || '').replace(/\s+/g, ' ').trim().length;
}

/** Visible-text length of the document body, whitespace collapsed. */
export function bodyTextLength(document) {
  return textLength(document?.querySelector('body'));
}

/** Cheap pre-check: is this extraction suspect enough to look for a better one? */
export function shouldAttempt(bodyTextLen, extractLen) {
  if (!isEnabled()) return false;
  if (bodyTextLen < GUARD_LIMITS.MIN_BODY_TEXT) return false;
  return extractLen / bodyTextLen < GUARD_LIMITS.MAX_COVERAGE;
}

/**
 * Descend from the body while a single child holds DOMINANCE of its parent's
 * text; stop where the text branches out across siblings. That stopping point is
 * the content root — on a page-builder one-pager it is the wrapper holding every
 * chapter, which is exactly what a hand-written `select.content` recipe names.
 *
 * Returns null when the descent never leaves the body: that means no single
 * container owns the page, which is the signature of a listing or index page.
 */
export function findDominantContainer(body) {
  if (!body) return null;
  let node = body;
  for (let depth = 0; depth < GUARD_LIMITS.MAX_DEPTH; depth++) {
    const literalChildren = Array.from(node.children);
    if (literalChildren.length !== 1) break; // Stop if branching (2+ children) or no children
    const child = literalChildren[0];
    const childLen = textLength(child);
    const parentLen = textLength(node);
    if (parentLen === 0 || childLen / parentLen < GUARD_LIMITS.DOMINANCE) break;
    node = child;
  }
  return node === body ? null : node;
}

/**
 * Only take the recovered candidate when it is substantially larger AND reads
 * like prose. The size floor keeps the guard from swapping in a marginally
 * different extract; the paragraph floor keeps it from swapping in nav soup.
 */
export function acceptCandidate(candidateMd, extractLen) {
  const md = (candidateMd || '').trim();
  if (md.length < GUARD_LIMITS.MIN_GAIN * Math.max(extractLen, 1)) return false;
  return metrics(md).paragraphs >= GUARD_LIMITS.MIN_PARAGRAPHS;
}

/** Short human-readable handle for a DOM node, for the extractor reason. */
export function containerLabel(node) {
  const tag = node.tagName.toLowerCase();
  if (node.id) return `${tag}#${node.id}`;
  const cls = String(node.getAttribute('class') || '').trim().split(/\s+/).filter(Boolean)[0];
  return cls ? `${tag}.${cls}` : tag;
}

/**
 * The transparency channel: an operator reading metadata.extractorReason must be
 * able to judge afterwards whether the intervention was warranted, so the reason
 * carries the numbers it was based on and the decision it overrode.
 */
export function guardReason(bodyTextLen, extractLen, node, candidateLen, priorReason) {
  const coverage = ((extractLen / bodyTextLen) * 100).toFixed(1);
  const gain = (candidateLen / Math.max(extractLen, 1)).toFixed(1);
  return `coverage guard: ${coverage}% coverage of ${bodyTextLen}c body, `
    + `recovered ${containerLabel(node)} (${gain}x); prior pick: ${priorReason}`;
}
