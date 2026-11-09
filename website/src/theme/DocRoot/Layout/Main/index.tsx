// Adds the site footer at the end of every docs page's main column.
import React from 'react';
import Main from '@theme-original/DocRoot/Layout/Main';
import type MainType from '@theme/DocRoot/Layout/Main';
import type { WrapperProps } from '@docusaurus/types';
import SiteFooter from '@site/src/components/SiteFooter';

type Props = WrapperProps<typeof MainType>;

export default function MainWrapper(props: Props) {
  return (
    <Main {...props}>
      {props.children}
      <SiteFooter />
    </Main>
  );
}
