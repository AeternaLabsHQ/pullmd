// Site brand: icon + wordmark (+ optional "Docs" label), configured in site.config.ts.
// Replaces Docusaurus's Logo so the icon is one fixed-size image (no light/dark pair
// rendered before hydration, no layout shift while a raster logo loads).
import React from 'react';
import clsx from 'clsx';
import Link from '@docusaurus/Link';
import useBaseUrl from '@docusaurus/useBaseUrl';
import useDocusaurusContext from '@docusaurus/useDocusaurusContext';
import type { SiteConfig } from '@site/site.config';

export default function Brand({ className }: { className?: string }) {
  const { siteConfig } = useDocusaurusContext();
  const site = siteConfig.customFields?.site as SiteConfig;
  const { brand, theme } = site;
  const icon = useBaseUrl(theme.logoLight);
  const iconDark = useBaseUrl(theme.logoDark);
  const parts = brand?.wordmark ?? [{ text: site.productName }];
  return (
    <Link to="/" className={clsx('ds-brand', className)} aria-label={`${site.productName} ${brand?.suffix ?? ''}`.trim()}>
      <img className={clsx('ds-brand__icon', iconDark !== icon && 'ds-brand__icon--light')} src={icon} alt="" width={28} height={28} />
      {iconDark !== icon && <img className="ds-brand__icon ds-brand__icon--dark" src={iconDark} alt="" width={28} height={28} />}
      <span className="ds-brand__wordmark" style={brand?.font ? { fontFamily: brand.font } : undefined}>
        {parts.map((p, i) => <span key={i} className={clsx(p.accent && 'ds-brand__accent')}>{p.text}</span>)}
      </span>
      {brand?.suffix && <span className="ds-brand__suffix">{brand.suffix}</span>}
    </Link>
  );
}
