import type { Config } from '@docusaurus/types';
import type * as Preset from '@docusaurus/preset-classic';
import { themes as prismThemes } from 'prism-react-renderer';
import site from './site.config';
import { prismVarTheme } from './src/lib/prismVarTheme';

const codeTheme = prismVarTheme(prismThemes.github, prismThemes.oneDark);

// Site-specific values come from site.config.ts.
const hasApi = Boolean(site.openapiSpec);
// Where the site is served. The deploy workflow passes the real address from GitHub Pages;
// local builds use site.config.ts.
const siteUrl = process.env.SITE_URL || site.url;
const baseUrl = process.env.SITE_BASE_URL || site.baseUrl;
const editBase = `https://github.com/${site.githubOrg}/${site.githubRepo}/edit/main/${site.docsPathInRepo ? site.docsPathInRepo + '/' : ''}`;

const config: Config = {
  title: site.productName,
  tagline: site.tagline,
  favicon: site.theme.favicon,
  url: siteUrl,
  baseUrl,
  organizationName: site.githubOrg,
  projectName: site.githubRepo,
  trailingSlash: false,
  onBrokenLinks: 'throw',
  markdown: { mermaid: false, hooks: { onBrokenMarkdownLinks: 'throw' } },
  customFields: { site },
  headTags: [
    { tagName: 'style', attributes: { id: 'ds-code-colours' }, innerHTML: codeTheme.css },
    { tagName: 'link', attributes: { rel: 'preconnect', href: 'https://fonts.googleapis.com' } },
    { tagName: 'link', attributes: { rel: 'preconnect', href: 'https://fonts.gstatic.com', crossorigin: 'anonymous' } },
    {
      tagName: 'link',
      attributes: {
        rel: 'stylesheet',
        href: 'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap',
      },
    },
    ...(site.fontsUrl ? [{ tagName: 'link', attributes: { rel: 'stylesheet', href: site.fontsUrl } }] : []),
  ],

  presets: [
    [
      'classic',
      {
        docs: {
          routeBasePath: '/',
          sidebarPath: './sidebars.ts',
          editUrl: editBase,
          showLastUpdateTime: false,
        },
        blog: false,
        theme: { customCss: './src/css/theme.css' },
        sitemap: { changefreq: 'weekly', priority: 0.5 },
      } satisfies Preset.Options,
    ],
  ],

  plugins: [
    './src/plugins/search-index.js',
    // llms.txt sections follow the top tabs: their order, and their labels as headings.
    ['./src/plugins/ai-readable.js', {
      openapiSpec: site.openapiSpec, productName: site.productName, tagline: site.tagline,
      sidebarOrder: site.tabs.map((t) => t.sidebarId),
      sidebarTitles: Object.fromEntries(site.tabs.map((t) => [t.sidebarId, t.label])),
      specSidebar: 'api',
    }],
  ],


  themeConfig: {
    colorMode: { respectPrefersColorScheme: true },
    navbar: {
      title: site.productName,
      logo: { alt: site.productName, src: site.theme.logoLight, srcDark: site.theme.logoDark },
      hideOnScroll: false,
      items: [
        ...site.tabs
          .filter((t) => hasApi || t.sidebarId !== 'api')
          .map((t) => ({ type: 'docSidebar', sidebarId: t.sidebarId, label: t.label, position: 'left' as const })),
        ...site.navbarLinks.map((l) => ({ ...l, position: 'left' as const })),
        { type: 'custom-search', position: 'right' },
      ],
    },
    docs: { sidebar: { hideable: false, autoCollapseCategories: false } },
    prism: {
      // One CSS-variable theme for both modes, so code never flashes the wrong colours on load
      theme: codeTheme.theme,
      darkTheme: codeTheme.theme,
      additionalLanguages: ['bash', 'json', 'yaml', 'docker', 'python', 'typescript'],
    },
  } satisfies Preset.ThemeConfig,
};

export default config;
