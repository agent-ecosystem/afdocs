import { defineConfig } from 'vitepress';

export default defineConfig({
  title: 'AFDocs',
  description: 'Test your documentation site against the Agent-Friendly Documentation Spec',
  cleanUrls: true,

  sitemap: {
    hostname: 'https://afdocs.dev',
  },

  head: [
    ['meta', { property: 'og:image', content: 'https://afdocs.dev/social-card.png' }],
    ['meta', { property: 'og:title', content: 'AFDocs' }],
    [
      'meta',
      {
        property: 'og:description',
        content: 'Test your documentation site against the Agent-Friendly Documentation Spec',
      },
    ],
    ['meta', { property: 'og:url', content: 'https://afdocs.dev' }],
    ['meta', { name: 'twitter:card', content: 'summary_large_image' }],
    ['meta', { name: 'twitter:image', content: 'https://afdocs.dev/social-card.png' }],
    ['link', { rel: 'icon', type: 'image/x-icon', href: '/favicons/favicon.ico' }],
    [
      'link',
      { rel: 'icon', type: 'image/png', sizes: '32x32', href: '/favicons/favicon-32x32.png' },
    ],
    [
      'link',
      { rel: 'icon', type: 'image/png', sizes: '16x16', href: '/favicons/favicon-16x16.png' },
    ],
    [
      'link',
      { rel: 'apple-touch-icon', sizes: '180x180', href: '/favicons/apple-icon-180x180.png' },
    ],
  ],

  themeConfig: {
    siteTitle: 'AFDocs',
    logo: {
      light: '/logos/afdoc_logo_light.svg',
      dark: '/logos/afdoc_logo_dark.svg',
    },

    search: {
      provider: 'local',
    },

    nav: [
      { text: 'Guide', link: '/what-is-agent-score' },
      { text: 'Checks', link: '/checks/' },
      { text: 'Reference', link: '/reference/cli' },
    ],

    sidebar: [
      {
        text: 'The Score',
        items: [
          { text: 'What Is the Agent Score?', link: '/what-is-agent-score' },
          {
            text: 'Why Agent-Friendliness Matters',
            link: '/why-agent-friendliness-matters',
          },
          {
            text: 'Score Calculation',
            link: '/agent-score-calculation',
          },
          {
            text: 'Interaction Diagnostics',
            link: '/interaction-diagnostics',
          },
        ],
      },
      {
        text: 'Get Started',
        items: [
          { text: 'Quick Start', link: '/quick-start' },
          { text: 'Run Locally', link: '/run-locally' },
          { text: 'Improve Your Score', link: '/improve-your-score' },
          { text: 'CI Integration', link: '/ci-integration' },
        ],
      },
      {
        text: 'Checks Reference',
        items: [
          { text: 'Overview', link: '/checks/' },
          {
            text: 'Content Discoverability',
            link: '/checks/content-discoverability',
          },
          {
            text: 'Markdown Availability',
            link: '/checks/markdown-availability',
          },
          { text: 'Page Size', link: '/checks/page-size' },
          { text: 'Content Structure', link: '/checks/content-structure' },
          { text: 'URL Stability', link: '/checks/url-stability' },
          { text: 'Observability', link: '/checks/observability' },
          { text: 'Authentication', link: '/checks/authentication' },
        ],
      },
      {
        text: 'API Reference',
        items: [
          { text: 'CLI', link: '/reference/cli' },
          { text: 'Programmatic API', link: '/reference/programmatic-api' },
          { text: 'Scoring API', link: '/reference/scoring-api' },
          { text: 'Config File', link: '/reference/config-file' },
        ],
      },
      {
        text: 'Migration',
        items: [{ text: 'v0.17.0', link: '/migration/v0.17.0' }],
      },
      {
        text: 'About',
        items: [{ text: 'About AFDocs', link: '/about' }],
      },
    ],

    socialLinks: [
      {
        icon: 'github',
        link: 'https://github.com/agent-ecosystem/afdocs',
      },
    ],

    editLink: {
      pattern: 'https://github.com/agent-ecosystem/afdocs/edit/main/docs/:path',
    },

    footer: {
      message:
        'Released under the MIT License. By <a href="https://dacharycarey.com">Dachary Carey</a> · <a href="https://agentdocsspec.com">Agent-Friendly Documentation Spec</a>',
    },
  },
});
