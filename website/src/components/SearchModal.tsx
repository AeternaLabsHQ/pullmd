// Search: a trigger field + a centred ⌘K modal over a build-time index.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import clsx from 'clsx';
import { usePluginData } from '@docusaurus/useGlobalData';
import { useHistory } from '@docusaurus/router';
import useBaseUrl from '@docusaurus/useBaseUrl';

type Entry = { t: string; s: string; u: string; c: string; x: string; m?: string };

function score(e: Entry, terms: string[]) {
  const t = e.t.toLowerCase(), s = e.s.toLowerCase(), x = e.x.toLowerCase();
  let total = 0;
  for (const q of terms) {
    let best = 0;
    if (t === q) best = 12; else if (t.startsWith(q)) best = 9; else if (t.includes(q)) best = 7;
    if (s.startsWith(q)) best = Math.max(best, 6); else if (s.includes(q)) best = Math.max(best, 5);
    if (x.includes(q)) best = Math.max(best, 2);
    if (!best) return 0;
    total += best;
  }
  return total + (e.s ? 0 : 0.5);
}

function highlight(text: string, terms: string[]) {
  if (!terms.length) return text;
  const re = new RegExp(`(${terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'ig');
  return text.split(re).map((p, i) => (re.test(p) ? <mark key={i}>{p}</mark> : <React.Fragment key={i}>{p}</React.Fragment>));
}

function snippet(x: string, terms: string[]) {
  const i = terms.length ? x.toLowerCase().indexOf(terms[0]) : -1;
  const start = Math.max(0, i - 40);
  return (start > 0 ? '…' : '') + x.slice(start, start + 140) + (x.length > start + 140 ? '…' : '');
}

const isMac = () => typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

export function SearchTrigger({ compact = false }: { compact?: boolean }) {
  const [open, setOpen] = useState(false);
  const [mac, setMac] = useState(true);
  const button = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    setMac(isMac());
    const onKey = (e: KeyboardEvent) => {
      // A page can have several triggers (sidebar, navbar, 404 page); only the first visible one answers ⌘K.
      const first = [...document.querySelectorAll<HTMLElement>('.ds-search-trigger')].find((el) => el.offsetParent);
      if (first !== button.current) return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setOpen((o) => !o); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  return (
    <>
      <button ref={button} type="button" className={clsx('ds-search-trigger', compact && 'ds-search-trigger--compact')} onClick={() => setOpen(true)} aria-label="Search">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
        {!compact && <span className="ds-search-trigger__label">Search...</span>}
        {!compact && <kbd className="ds-search-trigger__kbd">{mac ? '⌘K' : 'Ctrl K'}</kbd>}
      </button>
      {open && <SearchModal onClose={() => setOpen(false)} />}
    </>
  );
}

function SearchModal({ onClose }: { onClose: () => void }) {
  const data = usePluginData('search-index') as { entries: Entry[] } | undefined;
  const entries = data?.entries ?? [];
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const history = useHistory();
  const base = useBaseUrl('/');
  const terms = q.toLowerCase().split(/\s+/).filter(Boolean);

  const results = useMemo(() => {
    if (!terms.length) return entries.filter((e) => !e.s).slice(0, 8);
    return entries.map((e) => ({ e, s: score(e, terms) })).filter((r) => r.s > 0)
      .sort((a, b) => b.s - a.s).slice(0, 12).map((r) => r.e);
  }, [q, entries]);

  useEffect(() => { input.current?.focus(); document.body.style.overflow = 'hidden'; return () => { document.body.style.overflow = ''; }; }, []);
  useEffect(() => { setActive(0); }, [q]);
  useEffect(() => { list.current?.querySelector('.is-active')?.scrollIntoView({ block: 'nearest' }); }, [active]);

  const go = (e?: Entry) => { if (!e) return; onClose(); history.push(base.replace(/\/$/, '') + e.u); };
  const onKey = (ev: React.KeyboardEvent) => {
    if (ev.key === 'Escape') onClose();
    else if (ev.key === 'ArrowDown') { ev.preventDefault(); setActive((a) => Math.min(a + 1, results.length - 1)); }
    else if (ev.key === 'ArrowUp') { ev.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
    else if (ev.key === 'Enter') { ev.preventDefault(); go(results[active]); }
  };

  return createPortal(
    <div className="ds-search" role="dialog" aria-modal="true" aria-label="Search docs" onMouseDown={onClose}>
      <div className="ds-search__panel" onMouseDown={(e) => e.stopPropagation()} onKeyDown={onKey}>
        <div className="ds-search__field">
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
          <input ref={input} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search the docs..." aria-label="Search the docs" />
          <kbd onClick={onClose}>Esc</kbd>
        </div>
        <div className="ds-search__results" ref={list}>
          {!terms.length && <div className="ds-search__group">Pages</div>}
          {results.length === 0 && <div className="ds-search__empty">No results for “{q}”</div>}
          {results.map((e, i) => (
            <a key={e.u + i} href={base.replace(/\/$/, '') + e.u} className={clsx('ds-search__item', i === active && 'is-active')}
               onMouseMove={() => setActive(i)} onClick={(ev) => { ev.preventDefault(); go(e); }}>
              <span className="ds-search__icon">
                {e.m ? <span className={clsx('ds-method', `ds-method--${e.m.toLowerCase()}`)}>{e.m === 'DELETE' ? 'DEL' : e.m}</span>
                  : <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><path d="M14 3v5h5" /><path d="M6 3h8l5 5v13H6z" /></svg>}
              </span>
              <span className="ds-search__text">
                <span className="ds-search__crumb">{Array.from(new Set([e.c, e.s ? e.t : ''].filter(Boolean).map((x) => x.toLowerCase()))).join(' › ') || ' '}</span>
                <span className="ds-search__title">{highlight(e.s || e.t, terms)}</span>
                {terms.length > 0 && e.x && <span className="ds-search__snippet">{highlight(snippet(e.x, terms), terms)}</span>}
              </span>
              <svg className="ds-search__enter" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M9 10 4 15l5 5" /><path d="M20 4v7a4 4 0 0 1-4 4H4" /></svg>
            </a>
          ))}
        </div>
        <div className="ds-search__foot"><span><kbd>↑</kbd><kbd>↓</kbd> navigate</span><span><kbd>↵</kbd> open</span><span><kbd>Esc</kbd> close</span></div>
      </div>
    </div>,
    document.body,
  );
}
