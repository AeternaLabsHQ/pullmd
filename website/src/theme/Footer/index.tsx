// Pages outside the docs (such as the 404 page) get the same site footer as docs pages.
// Docs pages render it in their main column instead, so it is hidden there (theme.css).
import React from 'react';
import SiteFooter from '@site/src/components/SiteFooter';

export default function Footer() {
  return <div className="ds-page-footer"><SiteFooter /></div>;
}
