/**
 * Product name, addresses, colours and navigation for the docs site.
 */
export type SiteConfig = {
  productName: string;
  tagline: string;
  /** Where the site is served, e.g. https://acme.github.io */
  url: string;
  /** '/' on a custom domain, '/<repo>/' on <org>.github.io/<repo> */
  baseUrl: string;
  /** GitHub org/user and repo, used for "Edit this page" and deploy */
  githubOrg: string;
  githubRepo: string;
  /** Folder of the docs site inside the repo ('' if the repo IS the site) */
  docsPathInRepo: string;
  /** Path to the OpenAPI spec, relative to this repo. Empty string disables the API reference. */
  openapiSpec: string;
  /** Wordmark next to the icon. Parts with accent: true use the brand colour. */
  brand?: {
    wordmark: { text: string; accent?: boolean }[];
    /** Label after the wordmark, e.g. 'Docs'. Omit for none. */
    suffix?: string;
    /** Font for the wordmark (load it with fontsUrl); defaults to the body font. */
    font?: string;
  };
  /** Google Fonts css2 URL for extra fonts (e.g. the wordmark font). */
  fontsUrl?: string;
  theme: {
    primary: string;        // brand colour, light mode
    primaryDark: string;    // brand colour, dark mode
    logoLight: string;      // path under static/
    logoDark: string;
    favicon: string;
  };
  /** Text links in the middle of the page footer (registry, support, status, product site) */
  footerLinks: { label: string; href: string }[];
  /** Links pinned to the bottom of the desktop sidebar (keep it to one or two) */
  sidebarLinks?: { label: string; href: string; icon?: 'github' | 'x' | 'discord' | 'linkedin' }[];
  /** Icon links on the right of the page footer */
  footerSocials?: { icon: 'github' | 'x' | 'discord' | 'linkedin'; href: string; label: string }[];
  /** Top tabs, in order. Each opens its own sidebar from sidebars.ts. The 'api' tab is skipped when openapiSpec is empty. */
  tabs: { label: string; sidebarId: string }[];
  /** Extra navbar links after the tabs (external pages, dashboards) */
  navbarLinks: { label: string; to?: string; href?: string }[];
};

const site: SiteConfig = {
  productName: 'PullMD',
  tagline: 'Anything in, clean Markdown out.',
  url: 'https://aeternalabshq.github.io',
  baseUrl: '/pullmd/',
  githubOrg: 'AeternaLabsHQ',
  githubRepo: 'pullmd',
  docsPathInRepo: 'website',
  openapiSpec: 'openapi/pullmd.yaml',
  brand: {
    wordmark: [{ text: 'Pull', accent: true }, { text: 'MD' }],
    suffix: 'Docs',
    font: "'Geist', var(--ds-font)",
  },
  fontsUrl: 'https://fonts.googleapis.com/css2?family=Geist:wght@700&display=swap',
  theme: {
    primary: '#d84315',
    primaryDark: '#ff5722',
    logoLight: 'img/logo.png',
    logoDark: 'img/logo.png',
    favicon: 'img/favicon.ico',
  },
  footerLinks: [
    { label: 'Docker Hub', href: 'https://hub.docker.com/r/aeternalabshq/pullmd' },
    { label: 'Report an issue', href: 'https://github.com/AeternaLabsHQ/pullmd/issues' },
  ],
  sidebarLinks: [{ label: 'GitHub', href: 'https://github.com/AeternaLabsHQ/pullmd', icon: 'github' }],
  footerSocials: [{ icon: 'github', href: 'https://github.com/AeternaLabsHQ/pullmd', label: 'GitHub' }],
  tabs: [
    { label: 'Docs', sidebarId: 'docs' },
    { label: 'API reference', sidebarId: 'api' },
    { label: 'Changelog', sidebarId: 'changelog' },
  ],
  navbarLinks: [],
};

export default site;
