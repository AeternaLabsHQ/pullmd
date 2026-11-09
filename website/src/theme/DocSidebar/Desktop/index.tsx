// Desktop sidebar: logo + theme switch + search on top, nav in the middle, pinned links (sidebarLinks) at the bottom
// (the navbar on doc pages then only carries the section tabs).
import React from 'react';
import clsx from 'clsx';
import Logo from '@theme/Logo';
import { SearchTrigger } from '@site/src/components/SearchModal';
import Content from '@theme/DocSidebar/Desktop/Content';
import type { Props } from '@theme/DocSidebar/Desktop';
import ThemeSwitch from '@site/src/components/ThemeSwitch';
import useDocusaurusContext from '@docusaurus/useDocusaurusContext';
import type { SiteConfig } from '@site/site.config';
import Icon from '@site/src/components/icons';
import { socialPaths } from '@site/src/components/socialIcons';

function DocSidebarDesktop({ path, sidebar, isHidden }: Props) {
  const { siteConfig } = useDocusaurusContext();
  const links = (siteConfig.customFields?.site as SiteConfig).sidebarLinks ?? [];
  return (
    <div className={clsx('ds-sidebar', isHidden && 'ds-sidebar--hidden')}>
      <div className="ds-sidebar__top">
        <div className="ds-sidebar__brand">
          <Logo className="ds-sidebar__logo" imageClassName="ds-sidebar__logo-img" titleClassName="ds-sidebar__logo-title" />
          <ThemeSwitch />
        </div>
        <div className="ds-sidebar__search"><SearchTrigger /></div>
      </div>
      <Content path={path} sidebar={sidebar} />
      {links.length > 0 && (
        <div className="ds-sidebar__pinned">
          {links.map((l) => (
            <a key={l.href} href={l.href} target="_blank" rel="noopener noreferrer">
              {l.icon && (
                <span className="ds-sidebar__pinned-icon">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d={socialPaths[l.icon]} /></svg>
                </span>
              )}
              <span>{l.label}</span>
              <span className="ds-sidebar__pinned-ext"><Icon name="arrow" size={14} /></span>
            </a>
          ))}
        </div>
      )}
    </div>
  );
}

export default React.memo(DocSidebarDesktop);
