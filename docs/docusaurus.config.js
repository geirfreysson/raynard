// @ts-check

import {themes as prismThemes} from 'prism-react-renderer';

/** @type {import('@docusaurus/types').Config} */
const config = {
  title: 'Raynard',
  tagline: 'A desktop AI agent that builds the tools it needs',
  favicon: 'img/raynard-fox-logo.svg',

  future: {
    v4: true,
  },

  url: 'http://localhost',
  baseUrl: '/',
  onBrokenLinks: 'throw',

  i18n: {
    defaultLocale: 'en',
    locales: ['en'],
  },

  presets: [
    [
      'classic',
      /** @type {import('@docusaurus/preset-classic').Options} */
      ({
        docs: {
          sidebarPath: './sidebars.js',
          routeBasePath: 'docs',
        },
        blog: false,
        theme: {
          customCss: './src/css/custom.css',
        },
      }),
    ],
  ],

  themeConfig:
    /** @type {import('@docusaurus/preset-classic').ThemeConfig} */
    ({
      colorMode: {
        defaultMode: 'light',
        respectPrefersColorScheme: false,
      },
      navbar: {
        title: 'raynard',
        logo: {
          alt: 'Raynard fox',
          src: 'img/raynard-fox-logo.svg',
        },
        items: [
          {
            type: 'docSidebar',
            sidebarId: 'docsSidebar',
            position: 'right',
            label: 'Docs',
          },
          {
            to: '/docs/plugins',
            label: 'Extensions',
            position: 'right',
          },
          {
            to: '/docs/getting-started',
            label: 'Download',
            position: 'right',
            className: 'navbar-download',
          },
        ],
      },
      footer: {
        style: 'light',
        links: [
          {
            title: 'Documentation',
            items: [
              {label: 'Overview', to: '/docs/intro'},
              {label: 'Getting started', to: '/docs/getting-started'},
              {label: 'Chat and models', to: '/docs/chat-and-models'},
              {label: 'Scheduled tasks', to: '/docs/scheduled-tasks'},
            ],
          },
          {
            title: 'Extend Raynard',
            items: [
              {label: 'Generated plugins', to: '/docs/plugins'},
              {label: 'Development', to: '/docs/development'},
            ],
          },
        ],
        copyright: `Copyright © ${new Date().getFullYear()} Raynard.`,
      },
      prism: {
        theme: prismThemes.github,
        darkTheme: prismThemes.nightOwl,
      },
    }),
};

export default config;
