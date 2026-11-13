import { themes as prismThemes } from 'prism-react-renderer';
import type { Config } from '@docusaurus/types';
import type * as Preset from '@docusaurus/preset-classic';

const config: Config = {
  title: 'seal',
  tagline: 'SEAL v1 signing + verification for TypeScript/JavaScript',
  favicon: undefined,

  // TypeDoc HTML is staged into static/typedoc post-typedoc, pre-build; the
  // checker can't see it, so follow exiftool-ts and warn instead of throw.
  onBrokenLinks: 'warn',

  future: {
    v4: true,
  },

  url: 'https://woss.github.io',
  baseUrl: '/seal/',

  organizationName: 'woss',
  projectName: 'seal',
  onBrokenMarkdownLinks: 'warn',

  i18n: {
    defaultLocale: 'en',
    locales: ['en'],
  },

  presets: [
    [
      'classic',
      {
        docs: {
          sidebarPath: './sidebars.ts',
          editUrl: 'https://github.com/woss/seal/tree/main/docs/',
          routeBasePath: '/',
        },
        blog: false,
      } satisfies Preset.Options,
    ],
  ],

  themeConfig: {
    colorMode: {
      respectPrefersColorScheme: true,
    },
    navbar: {
      title: 'seal',
      items: [
        { to: '/signing', label: 'Sign', position: 'left' },
        { to: '/verifying', label: 'Verify', position: 'left' },
        { to: '/keys', label: 'Keys', position: 'left' },
        { href: '/seal/typedoc/', label: 'API (TypeDoc)', position: 'left' },
        {
          href: 'https://github.com/woss/seal',
          label: 'GitHub',
          position: 'right',
        },
      ],
    },
    footer: {
      style: 'dark',
      links: [
        {
          title: 'Docs',
          items: [
            { label: 'Getting Started', to: '/' },
            { label: 'Signing', to: '/signing' },
            { label: 'Verification', to: '/verifying' },
          ],
        },
        {
          title: 'More',
          items: [
            { label: 'GitHub', href: 'https://github.com/woss/seal' },
            {
              label: 'SEAL Specification',
              href: 'https://github.com/hackerfactor/SEAL/blob/main/SPECIFICATION.md',
            },
          ],
        },
      ],
      copyright: `Copyright © ${new Date().getFullYear()} seal. Built with Docusaurus. Made with Human and AI effort — <a href="https://woss.io" target="_blank" rel="noopener noreferrer">woss.io</a>.`,
    },
    prism: {
      theme: prismThemes.github,
      darkTheme: prismThemes.dracula,
      additionalLanguages: ['typescript', 'json', 'bash'],
    },
  } satisfies Preset.ThemeConfig,
};

export default config;
