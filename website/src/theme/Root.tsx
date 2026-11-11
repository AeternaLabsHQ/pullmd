// Puts a visually hidden note for AI agents at the top of every page, pointing to llms.txt and
// the Markdown copies. The Markdown copies carry the same note (src/plugins/ai-readable.js).
import React, {type ReactNode} from 'react';
import useDocusaurusContext from '@docusaurus/useDocusaurusContext';

export default function Root({children}: {children: ReactNode}): ReactNode {
  const {siteConfig} = useDocusaurusContext();
  const index = `${siteConfig.url}${siteConfig.baseUrl}llms.txt`;
  return (
    <>
      <div className="llms-directive">
        For AI agents: fetch the complete documentation index at <a href={index}>{index}</a>.
        Every page is also available as Markdown: add <code>.md</code> to its URL.
      </div>
      {children}
    </>
  );
}
