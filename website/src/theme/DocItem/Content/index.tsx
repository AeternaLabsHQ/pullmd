// "Copy page" split button: copy the page as Markdown, or view the Markdown.
// Uses the per-page .md copy that the ai-readable plugin writes at build time.
import React, { useEffect, useRef, useState } from 'react';
import Content from '@theme-original/DocItem/Content';
import type ContentType from '@theme/DocItem/Content';
import type { WrapperProps } from '@docusaurus/types';
import { useLocation } from '@docusaurus/router';
import useBaseUrl from '@docusaurus/useBaseUrl';

type Props = WrapperProps<typeof ContentType>;

const Ico = ({ d }: { d: React.ReactNode }) => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">{d}</svg>
);
const copyIcon = <><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V5a2 2 0 0 1 2-2h10" /></>;

function CopyPage() {
  const { pathname } = useLocation();
  const base = useBaseUrl('/');
  const [state, setState] = useState<'idle' | 'done' | 'error'>('idle');
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const rel = pathname.replace(base, '/').replace(/\/$/, '') || '/index';
  const mdPath = `${base.replace(/\/$/, '')}${rel === '/' ? '/index' : rel}.md`;

  useEffect(() => {
    const close = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);

  async function copy() {
    try {
      const res = await fetch(mdPath);
      const text = res.ok ? await res.text() : document.querySelector('article')?.innerText ?? '';
      await navigator.clipboard.writeText(text);
      setState('done');
    } catch {
      setState('error');
    }
    setOpen(false);
    setTimeout(() => setState('idle'), 1600);
  }

  const items = [
    { label: 'Copy page', hint: 'Copy this page as Markdown for LLMs', icon: copyIcon, onClick: copy },
    { label: 'View as Markdown', hint: 'View this page as plain text', icon: <><path d="M14 3v5h5" /><path d="M6 3h8l5 5v13H6z" /></>, href: mdPath },
  ];

  return (
    <div className="ds-copy-page" ref={ref}>
      <button type="button" className="ds-copy-page__main" onClick={copy}>
        <Ico d={state === 'done' ? <path d="M20 6 9 17l-5-5" /> : copyIcon} />
        {state === 'done' ? 'Copied' : state === 'error' ? 'Copy failed' : 'Copy page'}
      </button>
      <button type="button" className="ds-copy-page__more" aria-label="More options" aria-expanded={open} onClick={() => setOpen(!open)}>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><path d="m6 9 6 6 6-6" /></svg>
      </button>
      {open && (
        <div className="ds-copy-page__menu" role="menu">
          {items.map((it) => {
            const inner = (
              <>
                <span className="ds-copy-page__icon"><Ico d={it.icon} /></span>
                <span><span className="ds-copy-page__label">{it.label}{it.href && !it.href.startsWith('/') && ' ↗'}</span><span className="ds-copy-page__hint">{it.hint}</span></span>
              </>
            );
            return it.href
              ? <a key={it.label} role="menuitem" className="ds-copy-page__item" href={it.href} target="_blank" rel="noopener noreferrer" onClick={() => setOpen(false)}>{inner}</a>
              : <button key={it.label} role="menuitem" type="button" className="ds-copy-page__item" onClick={it.onClick}>{inner}</button>;
          })}
        </div>
      )}
    </div>
  );
}

export default function ContentWrapper(props: Props) {
  return (
    <div className="ds-doc">
      <CopyPage />
      <Content {...props} />
    </div>
  );
}
