// Page footer: Suggest edits (replaces the stock edit-link row). Issues are linked from the site footer.
import React from 'react';
import { useDoc } from '@docusaurus/plugin-content-docs/client';

export default function DocItemFooter() {
  const { metadata } = useDoc();
  if (!metadata.editUrl) return null;
  return (
    <footer className="ds-doc-footer">
      <div className="ds-doc-footer__links">
        <a href={metadata.editUrl} target="_blank" rel="noopener noreferrer">Suggest edits</a>
      </div>
    </footer>
  );
}
