// Makes the docs components (and Tabs) available in every .md/.mdx page without imports.
import MDXComponents from '@theme-original/MDXComponents';
import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';
import * as ds from '@site/src/components';

export default { ...MDXComponents, Tabs, TabItem, ...ds };
