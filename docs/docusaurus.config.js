// @ts-check

import {themes as prismThemes} from 'prism-react-renderer';

const isProduction = process.env.NODE_ENV === 'production';

/** @type {import('@docusaurus/types').Config} */
const config = {
  title: 'Raynard',
  tagline: 'A desktop AI agent that builds the tools it needs',
  favicon: 'img/raynard-fox-logo.svg',

  future: {
    v4: true,
  },

  url: 'https://raynard.ai',
  baseUrl: '/',
  organizationName: 'geirfreysson',
  projectName: 'raynard',
  onBrokenLinks: 'throw',
  clientModules: isProduction ? ['./src/lib/analytics-client.js'] : [],
  headTags: isProduction ? [
    {
      tagName: 'script',
      attributes: {},
      innerHTML: `
        if (window.location.hostname === 'raynard.ai' || window.location.hostname === 'www.raynard.ai') {
          window.dataLayer = window.dataLayer || [];
          window.gtag = function(){window.dataLayer.push(arguments);};

          var analyticsScript = document.createElement('script');
          analyticsScript.async = true;
          analyticsScript.src = 'https://www.googletagmanager.com/gtag/js?id=G-T58M9890TY';
          document.head.appendChild(analyticsScript);

          window.gtag('js', new Date());
          window.gtag('config', 'G-T58M9890TY', {
            page_location: window.location.href.split('#')[0],
            page_path: window.location.pathname + window.location.search,
          });
        }
      `,
    },
  ] : [],

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
