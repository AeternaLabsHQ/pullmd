/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Ejected from @docusaurus/theme-classic 3.10.2. The only change: the page content comes
// before the sidebar in the HTML, so agents and text extractors reach the content first.
// CSS puts the sidebar back on the left (styles.module.css).

import React, {type ReactNode, useState} from 'react';
import {useDocsSidebar} from '@docusaurus/plugin-content-docs/client';
import BackToTopButton from '@theme/BackToTopButton';
import DocRootLayoutSidebar from '@theme/DocRoot/Layout/Sidebar';
import DocRootLayoutMain from '@theme/DocRoot/Layout/Main';
import type {Props} from '@theme/DocRoot/Layout';

import styles from './styles.module.css';

export default function DocRootLayout({children}: Props): ReactNode {
  const sidebar = useDocsSidebar();
  const [hiddenSidebarContainer, setHiddenSidebarContainer] = useState(false);
  return (
    <div className={styles.docsWrapper}>
      <BackToTopButton />
      <div className={styles.docRoot}>
        <DocRootLayoutMain hiddenSidebarContainer={hiddenSidebarContainer}>
          {children}
        </DocRootLayoutMain>
        {sidebar && (
          <DocRootLayoutSidebar
            sidebar={sidebar.items}
            hiddenSidebarContainer={hiddenSidebarContainer}
            setHiddenSidebarContainer={setHiddenSidebarContainer}
          />
        )}
      </div>
    </div>
  );
}
