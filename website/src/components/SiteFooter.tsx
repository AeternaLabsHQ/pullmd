// Page footer, one band across the content area: brand on the left, text links in the
// middle, icon links on the right (footerLinks / footerSocials in site.config.ts).
import React from 'react';
import useDocusaurusContext from '@docusaurus/useDocusaurusContext';
import type { SiteConfig } from '@site/site.config';
import Brand from './Brand';
import { socialPaths } from './socialIcons';


export default function SiteFooter() {
  const { siteConfig } = useDocusaurusContext();
  const site = siteConfig.customFields?.site as SiteConfig;
  const socials = site.footerSocials ?? [];
  return (
    <footer className="ds-site-footer">
      <div className="ds-site-footer__inner">
        <Brand className="ds-site-footer__brand" />
        {site.footerLinks?.length > 0 && (
          <nav className="ds-site-footer__links" aria-label="Footer">
            {site.footerLinks.map((l) => (
              <a key={l.href} href={l.href} target="_blank" rel="noopener noreferrer">{l.label}</a>
            ))}
          </nav>
        )}
        {socials.length > 0 && (
          <div className="ds-site-footer__socials">
            {socials.map((s) => (
              <a key={s.href} href={s.href} target="_blank" rel="noopener noreferrer" aria-label={s.label} title={s.label}>
                <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d={socialPaths[s.icon]} /></svg>
              </a>
            ))}
          </div>
        )}
      </div>
    </footer>
  );
}
