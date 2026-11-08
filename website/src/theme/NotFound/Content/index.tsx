// 404: say what happened, then offer search and the main entry points.
import React from 'react';
import Link from '@docusaurus/Link';
import useDocusaurusContext from '@docusaurus/useDocusaurusContext';
import type { SiteConfig } from '@site/site.config';
import { SearchTrigger } from '@site/src/components/SearchModal';

export default function NotFoundContent() {
  const { siteConfig } = useDocusaurusContext();
  const site = siteConfig.customFields?.site as SiteConfig;
  const links = [
    { label: 'Overview', to: '/' },
    { label: 'Quickstart', to: '/quickstart' },
    ...(site.openapiSpec ? [{ label: 'API reference', to: '/reference/api' }] : []),
  ];
  return (
    <main className="ds-not-found">
      <p className="ds-not-found__code">404</p>
      <h1>This page doesn't exist</h1>
      <p>It may have moved, or the link has a typo. Search the docs, or start from one of these pages.</p>
      <div className="ds-not-found__search"><SearchTrigger /></div>
      <nav className="ds-not-found__links" aria-label="Main pages">
        {links.map((l) => <Link key={l.to} to={l.to}>{l.label}</Link>)}
      </nav>
    </main>
  );
}
