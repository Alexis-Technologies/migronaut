import { defineConfig } from 'vitepress';

const ogTitle = 'migronaut — MongoDB migrations for Node.js';
const ogDescription =
  'MongoDB migration toolkit for Node.js & TypeScript. Run a single migration, ' +
  'roll back any batch, preview with dry-run, transactions, checksums, and native locking.';
const repo = 'https://github.com/Alexis-Technologies/migronaut';
const base = '/';
const hostname = 'https://migronaut.vercel.app/';
const ogImage = `${hostname}logo.png`;

const keywords = [
  'mongodb migration',
  'mongodb migrations',
  'mongo migration',
  'mongodb migration tool',
  'mongodb migration nodejs',
  'mongodb migration typescript',
  'node mongodb migration',
  'database migration mongodb',
  'schema migration mongodb',
  'migrate-mongo alternative',
  'mongoose migration',
  'mongodb migration cli',
  'migronaut',
  '@alexify/migronaut',
].join(', ');

// schema.org structured data — helps search and AI engines understand the package
// as a software entity, not just text on a page.
const jsonLd = {
  '@context': 'https://schema.org',
  '@type': 'SoftwareApplication',
  name: '@alexify/migronaut',
  alternateName: 'migronaut',
  description: ogDescription,
  applicationCategory: 'DeveloperApplication',
  operatingSystem: 'Node.js >= 22.18',
  url: hostname,
  downloadUrl: 'https://www.npmjs.com/package/@alexify/migronaut',
  codeRepository: repo,
  license: 'https://opensource.org/licenses/MIT',
  keywords,
  author: { '@type': 'Organization', name: 'Alexis Technologies' },
  offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
};

// https://vitepress.dev/reference/site-config
export default defineConfig({
  title: '@alexify/migronaut',
  titleTemplate: ':title — MongoDB migrations for Node.js',
  description: ogDescription,
  lang: 'en-US',
  base,
  cleanUrls: true,
  lastUpdated: true,
  sitemap: { hostname },

  head: [
    ['link', { rel: 'icon', type: 'image/svg+xml', href: `${base}logo-mark.svg` }],
    ['link', { rel: 'icon', type: 'image/png', href: `${base}favicon.png` }],
    ['meta', { name: 'theme-color', content: '#00ED64' }],
    ['meta', { name: 'author', content: 'Alexis Technologies' }],
    ['meta', { name: 'keywords', content: keywords }],
    ['meta', { name: 'robots', content: 'index, follow' }],
    ['meta', { property: 'og:type', content: 'website' }],
    ['meta', { property: 'og:site_name', content: '@alexify/migronaut' }],
    ['meta', { property: 'og:title', content: ogTitle }],
    ['meta', { property: 'og:description', content: ogDescription }],
    ['meta', { property: 'og:image', content: ogImage }],
    ['meta', { name: 'twitter:card', content: 'summary_large_image' }],
    ['meta', { name: 'twitter:title', content: ogTitle }],
    ['meta', { name: 'twitter:description', content: ogDescription }],
    ['meta', { name: 'twitter:image', content: ogImage }],
    ['script', { type: 'application/ld+json' }, JSON.stringify(jsonLd)],
  ],

  // Per-page canonical + og:url for clean SEO indexing
  transformPageData(pageData) {
    const path = pageData.relativePath.replace(/index\.md$/, '').replace(/\.md$/, '');
    const canonical = `${hostname}${path}`;
    pageData.frontmatter.head ??= [];
    pageData.frontmatter.head.push(
      ['link', { rel: 'canonical', href: canonical }],
      ['meta', { property: 'og:url', content: canonical }],
    );
  },

  themeConfig: {
    logo: '/logo-mark.svg',

    // ─── Top navigation ──────────────────────────────────────────────
    nav: [
      { text: 'Guide', link: '/guide/getting-started', activeMatch: '/guide/' },
      { text: 'Commands', link: '/commands/up', activeMatch: '/commands/' },
      { text: 'Reference', link: '/reference/cli', activeMatch: '/reference/' },
      {
        text: 'v1.0.0',
        items: [
          { text: 'Changelog', link: `${repo}/blob/main/CHANGELOG.md` },
          { text: 'npm', link: 'https://www.npmjs.com/package/@alexify/migronaut' },
          { text: 'Releases', link: `${repo}/releases` },
        ],
      },
    ],

    // ─── Sidebar ─────────────────────────────────────────────────────
    sidebar: {
      '/guide/': [
        {
          text: 'Introduction',
          items: [
            { text: 'Why migronaut?', link: '/guide/why' },
            { text: 'Core Concepts', link: '/guide/concepts' },
            { text: 'Getting Started', link: '/guide/getting-started' },
            { text: 'Tutorial', link: '/guide/tutorial' },
            { text: 'Configuration', link: '/guide/configuration' },
          ],
        },
        {
          text: 'Writing Migrations',
          items: [
            { text: 'Migration Files', link: '/guide/writing-migrations' },
            { text: 'Transactions', link: '/guide/transactions' },
            { text: 'Lifecycle Hooks', link: '/guide/hooks' },
          ],
        },
        {
          text: 'Going Further',
          items: [
            { text: 'Programmatic API', link: '/guide/api' },
            { text: 'CI/CD & Deployment', link: '/guide/ci-cd' },
            { text: 'Troubleshooting', link: '/guide/troubleshooting' },
            { text: 'Migrating from migrate-mongo', link: '/guide/migrate-mongo' },
            { text: 'FAQ', link: '/guide/faq' },
          ],
        },
      ],
      '/reference/': [
        {
          text: 'Reference',
          items: [
            { text: 'CLI Cheatsheet', link: '/reference/cli' },
            { text: 'Error Codes', link: '/reference/error-codes' },
          ],
        },
      ],
      '/commands/': [
        {
          text: 'Running migrations',
          items: [
            { text: 'migronaut up', link: '/commands/up' },
            { text: 'migronaut down', link: '/commands/down' },
            { text: 'migronaut redo', link: '/commands/redo' },
          ],
        },
        {
          text: 'Inspecting & authoring',
          items: [
            { text: 'migronaut status / list', link: '/commands/status' },
            { text: 'migronaut create / init', link: '/commands/create' },
            { text: 'migronaut dry-run', link: '/commands/dry-run' },
            { text: 'migronaut audit', link: '/commands/audit' },
          ],
        },
        {
          text: 'Operations',
          items: [
            { text: 'migronaut import', link: '/commands/import' },
            { text: 'migronaut lock', link: '/commands/lock' },
            { text: 'migronaut unlock', link: '/commands/unlock' },
          ],
        },
      ],
    },

    // ─── Local, zero-config full-text search ─────────────────────────
    search: { provider: 'local' },

    socialLinks: [{ icon: 'github', link: repo }],

    editLink: {
      pattern: `${repo}/edit/main/docs/:path`,
      text: 'Edit this page on GitHub',
    },

    footer: {
      message: 'Released under the MIT License.',
      copyright: 'Copyright © 2026 Alexis Technologies',
    },

    docFooter: {
      prev: 'Previous page',
      next: 'Next page',
    },
  },
});
