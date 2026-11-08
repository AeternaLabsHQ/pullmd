// Previous / next as two button cards in a tray: a small direction label over the page title.
import React from 'react';
import Link from '@docusaurus/Link';
import type { Props } from '@theme/DocPaginator';

const chevron = (d: string) => (
  <svg className="ds-pager__chevron" width="10" height="10" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={d} /></svg>
);

function Card({ page, dir }: { page: { title: string; permalink: string }; dir: 'prev' | 'next' }) {
  const text = (
    <span className="ds-pager__text">
      <span className="ds-pager__label">{dir === 'prev' ? 'Previous' : 'Next'}</span>
      <span className="ds-pager__title">{page.title}</span>
    </span>
  );
  return (
    <Link className={`ds-pager__card ds-pager__card--${dir}`} to={page.permalink} rel={dir} aria-label={`${dir === 'prev' ? 'Previous' : 'Next'}: ${page.title}`}>
      {dir === 'prev' ? <>{chevron('M11.5 15.25L5.25 9L11.5 2.75')}{text}</> : <>{text}{chevron('M6.5 2.75L12.75 9L6.5 15.25')}</>}
    </Link>
  );
}

export default function DocPaginator({ previous, next }: Props) {
  if (!previous && !next) return null;
  return (
    <nav className="ds-pager" aria-label="Docs pages">
      {previous && <Card page={previous} dir="prev" />}
      {next && <Card page={next} dir="next" />}
    </nav>
  );
}
