import { describe, test, expect, beforeAll } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { getCheck } from '../../../src/checks/registry.js';
import { createContext } from '../../../src/runner.js';
import type { DiscoveredFile } from '../../../src/types.js';
import { mockSitemapNotFound } from '../../helpers/mock-sitemap-not-found.js';
import {
  hasLocaleCodeAt,
  filterToUnprefixedLocale,
  compileExclusionMatcher,
  extractOmittedPrefixes,
} from '../../../src/checks/observability/llms-txt-coverage.js';

const server = setupServer();

beforeAll(() => {
  server.listen({ onUnhandledRequest: 'bypass' });
  return () => server.close();
});

const check = getCheck('llms-txt-coverage');

/**
 * Build a minimal llms.txt content string from an array of URLs.
 */
function makeLlmsTxt(urls: string[]): string {
  return ['# Docs\n', ...urls.map((u) => `- [Page](${u})`)].join('\n');
}

/**
 * Build a minimal sitemap XML from an array of URLs.
 */
function makeSitemap(urls: string[]): string {
  const locs = urls.map((u) => `<url><loc>${u}</loc></url>`).join('\n');
  return `<?xml version="1.0"?>\n<urlset>\n${locs}\n</urlset>`;
}

/**
 * Build a sitemap index XML pointing to child sitemaps.
 */
function makeSitemapIndex(sitemapUrls: string[]): string {
  const entries = sitemapUrls.map((u) => `<sitemap><loc>${u}</loc></sitemap>`).join('\n');
  return `<?xml version="1.0"?>\n<sitemapindex>\n${entries}\n</sitemapindex>`;
}

/**
 * Create a test context with llms-txt-exists populated.
 */
function makeCtx(host: string, llmsTxtUrls: string[], basePath = '') {
  const baseUrl = `http://${host}${basePath}`;
  const ctx = createContext(baseUrl, { requestDelay: 0 });
  const content = makeLlmsTxt(llmsTxtUrls);
  const discovered: DiscoveredFile[] = [
    { url: `http://${host}/llms.txt`, content, status: 200, redirected: false },
  ];
  ctx.previousResults.set('llms-txt-exists', {
    id: 'llms-txt-exists',
    category: 'content-discoverability',
    status: 'pass',
    message: 'Found',
    details: { discoveredFiles: discovered },
  });
  return ctx;
}

describe('llms-txt-coverage', () => {
  test('passes when llms.txt fully covers sitemap', async () => {
    const host = 'cov-pass.local';
    const pages = [
      `http://${host}/docs/getting-started`,
      `http://${host}/docs/api-reference`,
      `http://${host}/docs/guides/auth`,
    ];

    const ctx = makeCtx(host, pages, '/docs');

    server.use(
      http.get(
        `http://${host}/robots.txt`,
        () => new HttpResponse(`Sitemap: http://${host}/sitemap.xml`, { status: 200 }),
      ),
      http.get(
        `http://${host}/sitemap.xml`,
        () =>
          new HttpResponse(makeSitemap(pages), {
            status: 200,
            headers: { 'content-type': 'application/xml' },
          }),
      ),
    );

    const result = await check.run(ctx);
    expect(result.status).toBe('pass');
    expect(result.details?.coverageRate).toBe(100);
    expect(result.details?.unmatchedCount).toBe(0);
  });

  test('passes when llms.txt uses .md URLs matching sitemap HTML URLs', async () => {
    const host = 'cov-md.local';
    const llmsUrls = [
      `http://${host}/docs/getting-started.md`,
      `http://${host}/docs/api-reference.md`,
    ];
    const sitemapUrls = [
      `http://${host}/docs/getting-started`,
      `http://${host}/docs/api-reference`,
    ];

    const ctx = makeCtx(host, llmsUrls, '/docs');

    server.use(
      http.get(
        `http://${host}/robots.txt`,
        () => new HttpResponse(`Sitemap: http://${host}/sitemap.xml`, { status: 200 }),
      ),
      http.get(
        `http://${host}/sitemap.xml`,
        () =>
          new HttpResponse(makeSitemap(sitemapUrls), {
            status: 200,
            headers: { 'content-type': 'application/xml' },
          }),
      ),
    );

    const result = await check.run(ctx);
    expect(result.status).toBe('pass');
    expect(result.details?.coverageRate).toBe(100);
  });

  test('passes with trailing slash differences', async () => {
    const host = 'cov-slash.local';
    const llmsUrls = [`http://${host}/docs/guide`];
    const sitemapUrls = [`http://${host}/docs/guide/`];

    const ctx = makeCtx(host, llmsUrls, '/docs');

    server.use(
      http.get(
        `http://${host}/robots.txt`,
        () => new HttpResponse(`Sitemap: http://${host}/sitemap.xml`, { status: 200 }),
      ),
      http.get(
        `http://${host}/sitemap.xml`,
        () =>
          new HttpResponse(makeSitemap(sitemapUrls), {
            status: 200,
            headers: { 'content-type': 'application/xml' },
          }),
      ),
    );

    const result = await check.run(ctx);
    expect(result.status).toBe('pass');
    expect(result.details?.coverageRate).toBe(100);
  });

  test('warns when coverage is between 80% and 95%', async () => {
    const host = 'cov-warn.local';
    // llms.txt has 9 of 10 pages (90% coverage)
    const allPages = Array.from({ length: 10 }, (_, i) => `http://${host}/docs/page-${i}`);
    const llmsPages = allPages.slice(0, 9);

    const ctx = makeCtx(host, llmsPages, '/docs');

    server.use(
      http.get(
        `http://${host}/robots.txt`,
        () => new HttpResponse(`Sitemap: http://${host}/sitemap.xml`, { status: 200 }),
      ),
      http.get(
        `http://${host}/sitemap.xml`,
        () =>
          new HttpResponse(makeSitemap(allPages), {
            status: 200,
            headers: { 'content-type': 'application/xml' },
          }),
      ),
    );

    const result = await check.run(ctx);
    expect(result.status).toBe('warn');
    expect(result.details?.coverageRate).toBe(90);
    expect(result.details?.missingCount).toBe(1);
  });

  test('fails when coverage is below 80%', async () => {
    const host = 'cov-fail.local';
    // llms.txt has 5 of 10 pages (50% coverage)
    const allPages = Array.from({ length: 10 }, (_, i) => `http://${host}/docs/page-${i}`);
    const llmsPages = allPages.slice(0, 5);

    const ctx = makeCtx(host, llmsPages, '/docs');

    server.use(
      http.get(
        `http://${host}/robots.txt`,
        () => new HttpResponse(`Sitemap: http://${host}/sitemap.xml`, { status: 200 }),
      ),
      http.get(
        `http://${host}/sitemap.xml`,
        () =>
          new HttpResponse(makeSitemap(allPages), {
            status: 200,
            headers: { 'content-type': 'application/xml' },
          }),
      ),
    );

    const result = await check.run(ctx);
    expect(result.status).toBe('fail');
    expect(result.details?.coverageRate).toBe(50);
    expect(result.details?.missingCount).toBe(5);
  });

  test('reports unmatched llms.txt links not in sitemap', async () => {
    const host = 'cov-unmatched.local';
    const sitemapPages = Array.from({ length: 10 }, (_, i) => `http://${host}/docs/page-${i}`);
    // llms.txt has all sitemap pages plus 3 extras not in sitemap
    const llmsPages = [
      ...sitemapPages,
      `http://${host}/docs/extra-page-a`,
      `http://${host}/docs/extra-page-b`,
      `http://${host}/docs/extra-page-c`,
    ];

    const ctx = makeCtx(host, llmsPages, '/docs');

    server.use(
      http.get(
        `http://${host}/robots.txt`,
        () => new HttpResponse(`Sitemap: http://${host}/sitemap.xml`, { status: 200 }),
      ),
      http.get(
        `http://${host}/sitemap.xml`,
        () =>
          new HttpResponse(makeSitemap(sitemapPages), {
            status: 200,
            headers: { 'content-type': 'application/xml' },
          }),
      ),
    );

    const result = await check.run(ctx);
    // Unmatched links are informational; coverage is 100% so status is pass
    expect(result.status).toBe('pass');
    expect(result.details?.unmatchedCount).toBe(3);
    expect(result.details?.coverageRate).toBe(100);
  });

  test('unmatched links do not affect overall status', async () => {
    const host = 'cov-unmatched-pass.local';
    // Coverage is fine (100%) but many unmatched llms.txt links
    const sitemapPages = Array.from({ length: 5 }, (_, i) => `http://${host}/docs/page-${i}`);
    const llmsPages = [
      ...sitemapPages,
      `http://${host}/docs/unmatched-a`,
      `http://${host}/docs/unmatched-b`,
      `http://${host}/docs/unmatched-c`,
      `http://${host}/docs/unmatched-d`,
    ];

    const ctx = makeCtx(host, llmsPages, '/docs');

    server.use(
      http.get(
        `http://${host}/robots.txt`,
        () => new HttpResponse(`Sitemap: http://${host}/sitemap.xml`, { status: 200 }),
      ),
      http.get(
        `http://${host}/sitemap.xml`,
        () =>
          new HttpResponse(makeSitemap(sitemapPages), {
            status: 200,
            headers: { 'content-type': 'application/xml' },
          }),
      ),
    );

    const result = await check.run(ctx);
    // Status based on coverage only (pass), unmatched is informational
    expect(result.status).toBe('pass');
    expect(result.details?.unmatchedCount).toBe(4);
    expect(result.message).toContain('not in sitemap');
  });

  test('skips when no sitemap is available', async () => {
    const host = 'cov-no-sitemap.local';
    const ctx = makeCtx(host, [`http://${host}/docs/page`], '/docs');

    mockSitemapNotFound(server, `http://${host}/docs`);

    const result = await check.run(ctx);
    expect(result.status).toBe('skip');
    expect(result.message).toContain('No sitemap found');
  });

  test('skips when no page URLs in llms.txt', async () => {
    const host = 'cov-no-pages.local';
    const ctx = createContext(`http://${host}/docs`, { requestDelay: 0 });
    ctx.previousResults.set('llms-txt-exists', {
      id: 'llms-txt-exists',
      category: 'content-discoverability',
      status: 'pass',
      message: 'Found',
      details: {
        discoveredFiles: [
          {
            url: `http://${host}/llms.txt`,
            content: '# Docs\n\nNo links here.',
            status: 200,
            redirected: false,
          },
        ],
      },
    });

    const result = await check.run(ctx);
    expect(result.status).toBe('skip');
    expect(result.message).toContain('No page URLs found');
  });

  test('scopes sitemap URLs to baseUrl path prefix', async () => {
    const host = 'cov-scope.local';
    const docPages = [`http://${host}/docs/guide`, `http://${host}/docs/api`];
    const allSitemapPages = [
      ...docPages,
      `http://${host}/marketing/page`,
      `http://${host}/about`,
      `http://${host}/pricing`,
    ];

    const ctx = makeCtx(host, docPages, '/docs');

    server.use(
      http.get(
        `http://${host}/robots.txt`,
        () => new HttpResponse(`Sitemap: http://${host}/sitemap.xml`, { status: 200 }),
      ),
      http.get(
        `http://${host}/sitemap.xml`,
        () =>
          new HttpResponse(makeSitemap(allSitemapPages), {
            status: 200,
            headers: { 'content-type': 'application/xml' },
          }),
      ),
    );

    const result = await check.run(ctx);
    expect(result.status).toBe('pass');
    // Only 2 doc pages in scope, both covered
    expect(result.details?.sitemapDocPages).toBe(2);
    expect(result.details?.coverageRate).toBe(100);
  });

  test('excludes blog/pricing/careers paths from sitemap comparison', async () => {
    const host = 'cov-exclude.local';
    const docPages = [`http://${host}/guide`];
    const sitemapPages = [
      `http://${host}/guide`,
      `http://${host}/blog/post-1`,
      `http://${host}/pricing`,
      `http://${host}/careers/engineer`,
    ];

    // baseUrl is root, so all paths are in scope
    const ctx = makeCtx(host, docPages, '');

    server.use(
      http.get(
        `http://${host}/robots.txt`,
        () => new HttpResponse(`Sitemap: http://${host}/sitemap.xml`, { status: 200 }),
      ),
      http.get(
        `http://${host}/sitemap.xml`,
        () =>
          new HttpResponse(makeSitemap(sitemapPages), {
            status: 200,
            headers: { 'content-type': 'application/xml' },
          }),
      ),
    );

    const result = await check.run(ctx);
    // Only /guide should be in the doc pages set (others excluded)
    expect(result.details?.sitemapDocPages).toBe(1);
    expect(result.details?.excludedNonDocPages).toBe(3);
    expect(result.status).toBe('pass');
  });

  test('handles index.md normalization', async () => {
    const host = 'cov-index.local';
    const llmsUrls = [`http://${host}/docs/guide/index.md`];
    const sitemapUrls = [`http://${host}/docs/guide/`];

    const ctx = makeCtx(host, llmsUrls, '/docs');

    server.use(
      http.get(
        `http://${host}/robots.txt`,
        () => new HttpResponse(`Sitemap: http://${host}/sitemap.xml`, { status: 200 }),
      ),
      http.get(
        `http://${host}/sitemap.xml`,
        () =>
          new HttpResponse(makeSitemap(sitemapUrls), {
            status: 200,
            headers: { 'content-type': 'application/xml' },
          }),
      ),
    );

    const result = await check.run(ctx);
    expect(result.status).toBe('pass');
    expect(result.details?.coverageRate).toBe(100);
  });

  test('skips when sitemap has no URLs under docs path prefix', async () => {
    const host = 'cov-no-scope.local';
    const ctx = makeCtx(host, [`http://${host}/docs/page`], '/docs');
    const sitemapPages = [`http://${host}/marketing/page1`, `http://${host}/marketing/page2`];

    server.use(
      http.get(
        `http://${host}/robots.txt`,
        () => new HttpResponse(`Sitemap: http://${host}/sitemap.xml`, { status: 200 }),
      ),
      http.get(
        `http://${host}/sitemap.xml`,
        () =>
          new HttpResponse(makeSitemap(sitemapPages), {
            status: 200,
            headers: { 'content-type': 'application/xml' },
          }),
      ),
      http.get(`http://${host}/docs/sitemap.xml`, () => new HttpResponse('', { status: 404 })),
    );

    const result = await check.run(ctx);
    expect(result.status).toBe('skip');
    expect(result.message).toContain('none are under the docs path prefix');
  });

  test('does not count cross-origin llms.txt URLs as unmatched', async () => {
    const host = 'cov-cross.local';
    const sitemapPages = [`http://${host}/docs/page`];
    // llms.txt links to a page on a different host — should not be flagged
    const llmsPages = [`http://${host}/docs/page`, `http://other-host.local/docs/external`];

    const ctx = makeCtx(host, llmsPages, '/docs');

    server.use(
      http.get(
        `http://${host}/robots.txt`,
        () => new HttpResponse(`Sitemap: http://${host}/sitemap.xml`, { status: 200 }),
      ),
      http.get(
        `http://${host}/sitemap.xml`,
        () =>
          new HttpResponse(makeSitemap(sitemapPages), {
            status: 200,
            headers: { 'content-type': 'application/xml' },
          }),
      ),
    );

    const result = await check.run(ctx);
    expect(result.status).toBe('pass');
    expect(result.details?.unmatchedCount).toBe(0);
  });

  test('falls back to docs-specific sitemap when main sitemap has no docs URLs', async () => {
    const host = 'cov-docs-sitemap.local';
    const docPages = [`http://${host}/docs/guide`, `http://${host}/docs/api`];
    const marketingPages = [`http://${host}/about`, `http://${host}/pricing`];

    const ctx = makeCtx(host, docPages, '/docs');

    server.use(
      // Main sitemap has only marketing pages
      http.get(
        `http://${host}/robots.txt`,
        () => new HttpResponse(`Sitemap: http://${host}/sitemap.xml`, { status: 200 }),
      ),
      http.get(
        `http://${host}/sitemap.xml`,
        () =>
          new HttpResponse(makeSitemap(marketingPages), {
            status: 200,
            headers: { 'content-type': 'application/xml' },
          }),
      ),
      // Docs-specific sitemap has the doc pages
      http.get(
        `http://${host}/docs/sitemap.xml`,
        () =>
          new HttpResponse(makeSitemap(docPages), {
            status: 200,
            headers: { 'content-type': 'application/xml' },
          }),
      ),
    );

    const result = await check.run(ctx);
    expect(result.status).toBe('pass');
    expect(result.details?.sitemapDocPages).toBe(2);
    expect(result.details?.sitemapSource).toBe('/docs/sitemap.xml');
    expect(result.details?.coverageRate).toBe(100);
  });

  test('follows docs-specific sitemap index one level deep', async () => {
    const host = 'cov-docs-index.local';
    const docPages = [
      `http://${host}/docs/guide`,
      `http://${host}/docs/api`,
      `http://${host}/docs/reference`,
    ];

    const ctx = makeCtx(host, docPages, '/docs');

    mockSitemapNotFound(server, `http://${host}/docs`);
    server.use(
      // Docs sitemap is an index
      http.get(
        `http://${host}/docs/sitemap.xml`,
        () =>
          new HttpResponse(makeSitemapIndex([`http://${host}/docs/sitemap-pages.xml`]), {
            status: 200,
            headers: { 'content-type': 'application/xml' },
          }),
      ),
      http.get(
        `http://${host}/docs/sitemap-pages.xml`,
        () =>
          new HttpResponse(makeSitemap(docPages), {
            status: 200,
            headers: { 'content-type': 'application/xml' },
          }),
      ),
    );

    const result = await check.run(ctx);
    expect(result.status).toBe('pass');
    expect(result.details?.sitemapDocPages).toBe(3);
    // getUrlsFromSitemap now discovers the docs sitemap via subpath fallback,
    // so the coverage check's own fetchDocsSitemap fallback doesn't fire.
    expect(result.details?.sitemapSource).toBe('robots.txt/sitemap.xml');
  });

  test('filters sitemap to matching locale when locale pattern detected', async () => {
    const host = 'locale-filter.local';
    // llms.txt only covers English pages
    const llmsPages = [
      `http://${host}/docs/en/getting-started`,
      `http://${host}/docs/en/api-reference`,
      `http://${host}/docs/en/guides`,
    ];

    // Sitemap has 3 English + 3 German + 3 French = 9 pages
    const sitemapPages = [
      ...llmsPages,
      `http://${host}/docs/de/getting-started`,
      `http://${host}/docs/de/api-reference`,
      `http://${host}/docs/de/guides`,
      `http://${host}/docs/fr/getting-started`,
      `http://${host}/docs/fr/api-reference`,
      `http://${host}/docs/fr/guides`,
    ];

    const ctx = makeCtx(host, llmsPages, '/docs');

    server.use(
      http.get(
        `http://${host}/robots.txt`,
        () => new HttpResponse(`Sitemap: http://${host}/sitemap.xml`, { status: 200 }),
      ),
      http.get(
        `http://${host}/sitemap.xml`,
        () =>
          new HttpResponse(makeSitemap(sitemapPages), {
            headers: { 'content-type': 'application/xml' },
          }),
      ),
    );

    const result = await check.run(ctx);
    expect(result.status).toBe('pass');
    // Locale filtering now happens inside getUrlsFromSitemap, so the coverage
    // check receives only English URLs and its own locale detection is a no-op.
    expect(result.details?.sitemapDocPages).toBe(3);
  });

  test('filters sitemap to unprefixed default locale when llms.txt has no locale prefix', async () => {
    const host = 'unprefixed-locale.local';
    // llms.txt covers the default (unprefixed) language
    const llmsPages = [
      `http://${host}/docs/getting-started`,
      `http://${host}/docs/api-reference`,
      `http://${host}/docs/guides`,
    ];

    // Sitemap has 3 unprefixed + 3 German + 3 Japanese = 9 pages
    const sitemapPages = [
      ...llmsPages,
      `http://${host}/docs/de/getting-started`,
      `http://${host}/docs/de/api-reference`,
      `http://${host}/docs/de/guides`,
      `http://${host}/docs/ja/getting-started`,
      `http://${host}/docs/ja/api-reference`,
      `http://${host}/docs/ja/guides`,
    ];

    const ctx = makeCtx(host, llmsPages, '/docs');

    server.use(
      http.get(
        `http://${host}/robots.txt`,
        () => new HttpResponse(`Sitemap: http://${host}/sitemap.xml`, { status: 200 }),
      ),
      http.get(
        `http://${host}/sitemap.xml`,
        () =>
          new HttpResponse(makeSitemap(sitemapPages), {
            headers: { 'content-type': 'application/xml' },
          }),
      ),
    );

    const result = await check.run(ctx);
    expect(result.status).toBe('pass');
    expect(result.details?.sitemapDocPages).toBe(3);
    expect(result.details?.localeFiltered).toBe(true);
    expect(result.details?.detectedLocale).toBe('default');
  });

  test('detects single-locale site via structural duplication', async () => {
    const host = 'single-locale.local';
    // llms.txt covers the default (unprefixed) language
    const llmsPages = [
      `http://${host}/docs/getting-started`,
      `http://${host}/docs/api-reference`,
      `http://${host}/docs/guides`,
    ];

    // Sitemap has 3 unprefixed + 3 German (one locale only)
    const sitemapPages = [
      ...llmsPages,
      `http://${host}/docs/de/getting-started`,
      `http://${host}/docs/de/api-reference`,
      `http://${host}/docs/de/guides`,
    ];

    const ctx = makeCtx(host, llmsPages, '/docs');

    server.use(
      http.get(
        `http://${host}/robots.txt`,
        () => new HttpResponse(`Sitemap: http://${host}/sitemap.xml`, { status: 200 }),
      ),
      http.get(
        `http://${host}/sitemap.xml`,
        () =>
          new HttpResponse(makeSitemap(sitemapPages), {
            headers: { 'content-type': 'application/xml' },
          }),
      ),
    );

    const result = await check.run(ctx);
    expect(result.status).toBe('pass');
    expect(result.details?.sitemapDocPages).toBe(3);
    expect(result.details?.localeFiltered).toBe(true);
  });

  test('uses effectiveOrigin for sitemap discovery and scoping', async () => {
    const oldHost = 'old-host.local';
    const newHost = 'new-host.local';
    const pages = [
      `http://${newHost}/docs/getting-started`,
      `http://${newHost}/docs/api-reference`,
    ];

    const ctx = makeCtx(oldHost, pages, '/docs');
    // Simulate llms-txt-exists having detected a cross-host redirect
    ctx.effectiveOrigin = `http://${newHost}`;

    server.use(
      // robots.txt at old host fails
      http.get(`http://${oldHost}/robots.txt`, () => new HttpResponse(null, { status: 404 })),
      // robots.txt at new host works
      http.get(
        `http://${newHost}/robots.txt`,
        () => new HttpResponse(`Sitemap: http://${newHost}/sitemap.xml`, { status: 200 }),
      ),
      http.get(
        `http://${newHost}/sitemap.xml`,
        () =>
          new HttpResponse(makeSitemap(pages), {
            headers: { 'content-type': 'application/xml' },
          }),
      ),
    );

    const result = await check.run(ctx);
    expect(result.status).toBe('pass');
    expect(result.details?.sitemapDocPages).toBe(2);
  });

  test('scopes sitemap URLs across www vs bare-host (issue #83)', async () => {
    // swift.org-style: scored URL is `www.host`, but sitemap entries are on bare host.
    // Coverage scoping must treat these as same-origin or coverage = 0%.
    const wwwHost = 'www.www-cov.local';
    const bareHost = 'www-cov.local';
    const llmsTxtPages = [`http://${wwwHost}/docs/intro`, `http://${wwwHost}/docs/guide`];
    const sitemapPages = [
      `http://${bareHost}/docs/intro`,
      `http://${bareHost}/docs/guide`,
      `http://${bareHost}/docs/extra`,
    ];

    const ctx = makeCtx(wwwHost, llmsTxtPages, '/docs');

    server.use(
      http.get(
        `http://${wwwHost}/robots.txt`,
        () => new HttpResponse(`Sitemap: http://${wwwHost}/sitemap.xml`, { status: 200 }),
      ),
      http.get(
        `http://${wwwHost}/sitemap.xml`,
        () =>
          new HttpResponse(makeSitemap(sitemapPages), {
            headers: { 'content-type': 'application/xml' },
          }),
      ),
    );

    const result = await check.run(ctx);
    expect(result.details?.sitemapDocPages).toBe(3);
  });

  test('excludes paths relative to base URL prefix', async () => {
    const host = 'basepath-exclude.local';
    const pages = [`http://${host}/docs/getting-started`, `http://${host}/docs/api-reference`];

    // Sitemap includes /docs/blog and /docs/pricing pages that should be excluded
    const sitemapPages = [
      ...pages,
      `http://${host}/docs/blog/post-1`,
      `http://${host}/docs/blog/post-2`,
      `http://${host}/docs/pricing`,
    ];

    const ctx = makeCtx(host, pages, '/docs');

    server.use(
      http.get(
        `http://${host}/robots.txt`,
        () => new HttpResponse(`Sitemap: http://${host}/sitemap.xml`, { status: 200 }),
      ),
      http.get(
        `http://${host}/sitemap.xml`,
        () =>
          new HttpResponse(makeSitemap(sitemapPages), {
            headers: { 'content-type': 'application/xml' },
          }),
      ),
    );

    const result = await check.run(ctx);
    expect(result.status).toBe('pass');
    // Only 2 doc pages remain after excluding /docs/blog and /docs/pricing
    expect(result.details?.sitemapDocPages).toBe(2);
    expect(result.details?.excludedNonDocPages).toBe(3);
  });
});

describe('hasLocaleCodeAt', () => {
  test('returns true for 2-letter locale codes at position', () => {
    expect(hasLocaleCodeAt('http://x.com/docs/de/intro', 1)).toBe(true);
    expect(hasLocaleCodeAt('http://x.com/docs/ja/intro', 1)).toBe(true);
  });

  test('returns true for region subtags', () => {
    expect(hasLocaleCodeAt('http://x.com/docs/pt-br/intro', 1)).toBe(true);
    expect(hasLocaleCodeAt('http://x.com/docs/zh-cn/intro', 1)).toBe(true);
  });

  test('returns false for non-locale segments', () => {
    expect(hasLocaleCodeAt('http://x.com/docs/getting-started', 1)).toBe(false);
    expect(hasLocaleCodeAt('http://x.com/docs/api', 1)).toBe(false);
  });

  test('returns false when URL is shorter than position', () => {
    expect(hasLocaleCodeAt('http://x.com/docs', 1)).toBe(false);
  });
});

describe('filterToUnprefixedLocale', () => {
  test('removes URLs with locale codes at the given position', () => {
    const urls = [
      'http://x.com/docs/intro',
      'http://x.com/docs/de/intro',
      'http://x.com/docs/ja/intro',
      'http://x.com/docs/guides',
      'http://x.com/docs/fr/guides',
    ];
    const filtered = filterToUnprefixedLocale(urls, 1);
    expect(filtered).toEqual(['http://x.com/docs/intro', 'http://x.com/docs/guides']);
  });

  test('keeps all URLs when none have locale codes', () => {
    const urls = ['http://x.com/docs/intro', 'http://x.com/docs/guides'];
    expect(filterToUnprefixedLocale(urls, 1)).toEqual(urls);
  });
});

describe('edge cases', () => {
  test('handles malformed URLs in sitemap gracefully', async () => {
    const host = 'cov-malformed.local';
    const goodPages = [`http://${host}/docs/guide`];

    const ctx = makeCtx(host, goodPages, '/docs');

    const sitemapXml = `<?xml version="1.0"?>
<urlset>
<url><loc>http://${host}/docs/guide</loc></url>
<url><loc>not-a-valid-url</loc></url>
</urlset>`;

    server.use(
      http.get(
        `http://${host}/robots.txt`,
        () => new HttpResponse(`Sitemap: http://${host}/sitemap.xml`, { status: 200 }),
      ),
      http.get(
        `http://${host}/sitemap.xml`,
        () =>
          new HttpResponse(sitemapXml, {
            status: 200,
            headers: { 'content-type': 'application/xml' },
          }),
      ),
    );

    const result = await check.run(ctx);
    expect(result.status).toBe('pass');
    expect(result.details?.coverageRate).toBe(100);
  });

  test('handles malformed URLs in llms.txt unmatched link check', async () => {
    const host = 'cov-malformed-llms.local';
    const sitemapPages = [`http://${host}/docs/guide`];

    const llmsTxt = [
      '# Docs\n',
      `- [Guide](http://${host}/docs/guide)`,
      '- [Bad](not-a-valid-url)',
    ].join('\n');

    const baseUrl = `http://${host}/docs`;
    const ctx = createContext(baseUrl, { requestDelay: 0 });
    const discovered: DiscoveredFile[] = [
      { url: `http://${host}/llms.txt`, content: llmsTxt, status: 200, redirected: false },
    ];
    ctx.previousResults.set('llms-txt-exists', {
      id: 'llms-txt-exists',
      category: 'content-discoverability',
      status: 'pass',
      message: 'Found',
      details: { discoveredFiles: discovered },
    });

    server.use(
      http.get(
        `http://${host}/robots.txt`,
        () => new HttpResponse(`Sitemap: http://${host}/sitemap.xml`, { status: 200 }),
      ),
      http.get(
        `http://${host}/sitemap.xml`,
        () =>
          new HttpResponse(makeSitemap(sitemapPages), {
            status: 200,
            headers: { 'content-type': 'application/xml' },
          }),
      ),
    );

    const result = await check.run(ctx);
    expect(result.status).toBe('pass');
    expect(result.details?.coverageRate).toBe(100);
  });

  test('does not count llms.txt links outside baseUrl path as unmatched', async () => {
    const host = 'cov-outside-base.local';
    const sitemapPages = [`http://${host}/docs/guide`];
    // llms.txt links include one outside the /docs base path
    const llmsPages = [`http://${host}/docs/guide`, `http://${host}/other/page`];

    const ctx = makeCtx(host, llmsPages, '/docs');

    server.use(
      http.get(
        `http://${host}/robots.txt`,
        () => new HttpResponse(`Sitemap: http://${host}/sitemap.xml`, { status: 200 }),
      ),
      http.get(
        `http://${host}/sitemap.xml`,
        () =>
          new HttpResponse(makeSitemap(sitemapPages), {
            status: 200,
            headers: { 'content-type': 'application/xml' },
          }),
      ),
    );

    const result = await check.run(ctx);
    expect(result.status).toBe('pass');
    // /other/page is outside /docs base path, so not counted as unmatched
    expect(result.details?.unmatchedCount).toBe(0);
  });

  test('excludes blog/pricing from unmatched llms.txt link check', async () => {
    const host = 'cov-exclude-unmatched.local';
    const sitemapPages = [`http://${host}/docs/guide`];
    const llmsPages = [`http://${host}/docs/guide`, `http://${host}/docs/blog/post-1`];

    const ctx = makeCtx(host, llmsPages, '/docs');

    server.use(
      http.get(
        `http://${host}/robots.txt`,
        () => new HttpResponse(`Sitemap: http://${host}/sitemap.xml`, { status: 200 }),
      ),
      http.get(
        `http://${host}/sitemap.xml`,
        () =>
          new HttpResponse(makeSitemap(sitemapPages), {
            status: 200,
            headers: { 'content-type': 'application/xml' },
          }),
      ),
    );

    const result = await check.run(ctx);
    expect(result.status).toBe('pass');
    // /docs/blog/post-1 is excluded by built-in patterns, not counted as unmatched
    expect(result.details?.unmatchedCount).toBe(0);
  });
});

describe('configurable thresholds', () => {
  test('uses custom pass threshold', async () => {
    const host = 'cov-custom-pass.local';
    // 9 of 10 pages = 90% coverage. Default would warn, but pass=80 makes it pass.
    const allPages = Array.from({ length: 10 }, (_, i) => `http://${host}/docs/page-${i}`);
    const llmsPages = allPages.slice(0, 9);

    const ctx = makeCtx(host, llmsPages, '/docs');
    ctx.options.coveragePassThreshold = 80;
    ctx.options.coverageWarnThreshold = 50;

    server.use(
      http.get(
        `http://${host}/robots.txt`,
        () => new HttpResponse(`Sitemap: http://${host}/sitemap.xml`, { status: 200 }),
      ),
      http.get(
        `http://${host}/sitemap.xml`,
        () =>
          new HttpResponse(makeSitemap(allPages), {
            status: 200,
            headers: { 'content-type': 'application/xml' },
          }),
      ),
    );

    const result = await check.run(ctx);
    expect(result.status).toBe('pass');
    expect(result.details?.coverageRate).toBe(90);
    expect(result.details?.coveragePassThreshold).toBe(80);
    expect(result.details?.coverageWarnThreshold).toBe(50);
  });

  test('threshold of 0 makes check informational (always passes)', async () => {
    const host = 'cov-informational.local';
    // Only 2 of 10 pages = 20% coverage. With thresholds at 0, this passes.
    const allPages = Array.from({ length: 10 }, (_, i) => `http://${host}/docs/page-${i}`);
    const llmsPages = allPages.slice(0, 2);

    const ctx = makeCtx(host, llmsPages, '/docs');
    ctx.options.coveragePassThreshold = 0;
    ctx.options.coverageWarnThreshold = 0;

    server.use(
      http.get(
        `http://${host}/robots.txt`,
        () => new HttpResponse(`Sitemap: http://${host}/sitemap.xml`, { status: 200 }),
      ),
      http.get(
        `http://${host}/sitemap.xml`,
        () =>
          new HttpResponse(makeSitemap(allPages), {
            status: 200,
            headers: { 'content-type': 'application/xml' },
          }),
      ),
    );

    const result = await check.run(ctx);
    expect(result.status).toBe('pass');
    expect(result.details?.coverageRate).toBe(20);
  });
});

describe('coverage exclusions', () => {
  test('user exclusion patterns remove matching sitemap URLs from denominator', async () => {
    const host = 'cov-exclusions.local';
    const docPages = [`http://${host}/docs/guide`, `http://${host}/docs/api`];
    const sitemapPages = [
      ...docPages,
      `http://${host}/docs/reference/v1/endpoint-a`,
      `http://${host}/docs/reference/v1/endpoint-b`,
      `http://${host}/docs/reference/v2/endpoint-a`,
    ];

    const ctx = makeCtx(host, docPages, '/docs');
    ctx.options.coverageExclusions = ['/docs/reference/**'];

    server.use(
      http.get(
        `http://${host}/robots.txt`,
        () => new HttpResponse(`Sitemap: http://${host}/sitemap.xml`, { status: 200 }),
      ),
      http.get(
        `http://${host}/sitemap.xml`,
        () =>
          new HttpResponse(makeSitemap(sitemapPages), {
            status: 200,
            headers: { 'content-type': 'application/xml' },
          }),
      ),
    );

    const result = await check.run(ctx);
    expect(result.status).toBe('pass');
    expect(result.details?.sitemapDocPages).toBe(2);
    expect(result.details?.userExcludedPages).toBe(3);
    expect(result.details?.coverageRate).toBe(100);
  });

  test('exclusion patterns work relative to base path', async () => {
    const host = 'cov-exclusions-rel.local';
    const docPages = [`http://${host}/docs/guide`];
    const sitemapPages = [...docPages, `http://${host}/docs/archive/old-page`];

    const ctx = makeCtx(host, docPages, '/docs');
    ctx.options.coverageExclusions = ['/archive/**'];

    server.use(
      http.get(
        `http://${host}/robots.txt`,
        () => new HttpResponse(`Sitemap: http://${host}/sitemap.xml`, { status: 200 }),
      ),
      http.get(
        `http://${host}/sitemap.xml`,
        () =>
          new HttpResponse(makeSitemap(sitemapPages), {
            status: 200,
            headers: { 'content-type': 'application/xml' },
          }),
      ),
    );

    const result = await check.run(ctx);
    expect(result.status).toBe('pass');
    expect(result.details?.sitemapDocPages).toBe(1);
    expect(result.details?.userExcludedPages).toBe(1);
  });
});

describe('omitted subtrees', () => {
  test('excludes sitemap pages under omitted subtree prefixes', async () => {
    const host = 'cov-omitted.local';
    // Root llms.txt links to section indexes (depth 0)
    const rootLlmsTxt = [
      '# Docs\n',
      `- [Chains](http://${host}/docs/chains/llms.txt)`,
      `- [Intro](http://${host}/docs/intro)`,
    ].join('\n');

    // chains/llms.txt links to sub-section indexes (depth 1, omitted) + pages
    const chainsLlmsTxt = [
      '# Chains\n',
      `- [Ethereum](http://${host}/docs/chains/ethereum/llms.txt)`,
      `- [Solana](http://${host}/docs/chains/solana/llms.txt)`,
      `- [Overview](http://${host}/docs/chains/overview)`,
    ].join('\n');

    // Sitemap has pages under the omitted subtrees
    const sitemapPages = [
      `http://${host}/docs/intro`,
      `http://${host}/docs/chains/overview`,
      `http://${host}/docs/chains/ethereum/method-a`,
      `http://${host}/docs/chains/ethereum/method-b`,
      `http://${host}/docs/chains/solana/method-a`,
    ];

    const baseUrl = `http://${host}/docs`;
    const ctx = createContext(baseUrl, { requestDelay: 0 });
    const discovered: DiscoveredFile[] = [
      { url: `http://${host}/llms.txt`, content: rootLlmsTxt, status: 200, redirected: false },
    ];
    ctx.previousResults.set('llms-txt-exists', {
      id: 'llms-txt-exists',
      category: 'content-discoverability',
      status: 'pass',
      message: 'Found',
      details: { discoveredFiles: discovered },
    });

    server.use(
      // Depth-0 aggregate fetch: chains/llms.txt
      http.get(
        `http://${host}/docs/chains/llms.txt`,
        () =>
          new HttpResponse(chainsLlmsTxt, {
            status: 200,
            headers: { 'content-type': 'text/plain' },
          }),
      ),
      http.get(
        `http://${host}/robots.txt`,
        () => new HttpResponse(`Sitemap: http://${host}/sitemap.xml`, { status: 200 }),
      ),
      http.get(
        `http://${host}/sitemap.xml`,
        () =>
          new HttpResponse(makeSitemap(sitemapPages), {
            status: 200,
            headers: { 'content-type': 'application/xml' },
          }),
      ),
    );

    const result = await check.run(ctx);
    // Pages directly verified: /docs/intro, /docs/chains/overview = 2
    // Omitted subtrees: /docs/chains/ethereum (2 pages), /docs/chains/solana (1 page) = 3 excluded
    // Coverage: 2/2 = 100%
    expect(result.status).toBe('pass');
    expect(result.details?.sitemapDocPages).toBe(2);
    expect(result.details?.omittedSubtrees).toBe(2);
    expect(result.details?.omittedSubtreePages).toBe(3);
    expect(result.details?.coverageRate).toBe(100);
    expect(result.message).toContain('nested indexes omitted');
  });

  test('omitted subtrees without matching sitemap pages do not affect results', async () => {
    const host = 'cov-omitted-empty.local';
    const rootLlmsTxt = [
      '# Docs\n',
      `- [Section](http://${host}/docs/section/llms.txt)`,
      `- [Guide](http://${host}/docs/guide)`,
    ].join('\n');

    const sectionLlmsTxt = [
      '# Section\n',
      `- [SubSection](http://${host}/docs/section/sub/llms.txt)`,
      `- [Page](http://${host}/docs/section/page)`,
    ].join('\n');

    const sitemapPages = [`http://${host}/docs/guide`, `http://${host}/docs/section/page`];

    const baseUrl = `http://${host}/docs`;
    const ctx = createContext(baseUrl, { requestDelay: 0 });
    ctx.previousResults.set('llms-txt-exists', {
      id: 'llms-txt-exists',
      category: 'content-discoverability',
      status: 'pass',
      message: 'Found',
      details: {
        discoveredFiles: [
          { url: `http://${host}/llms.txt`, content: rootLlmsTxt, status: 200, redirected: false },
        ],
      },
    });

    server.use(
      http.get(
        `http://${host}/docs/section/llms.txt`,
        () =>
          new HttpResponse(sectionLlmsTxt, {
            status: 200,
            headers: { 'content-type': 'text/plain' },
          }),
      ),
      http.get(
        `http://${host}/robots.txt`,
        () => new HttpResponse(`Sitemap: http://${host}/sitemap.xml`, { status: 200 }),
      ),
      http.get(
        `http://${host}/sitemap.xml`,
        () =>
          new HttpResponse(makeSitemap(sitemapPages), {
            status: 200,
            headers: { 'content-type': 'application/xml' },
          }),
      ),
    );

    const result = await check.run(ctx);
    expect(result.status).toBe('pass');
    expect(result.details?.coverageRate).toBe(100);
    // Omitted subtree /docs/section/sub has no matching sitemap pages
    expect(result.details?.omittedSubtreePages ?? 0).toBe(0);
  });
});

describe('compileExclusionMatcher', () => {
  test('matches ** across segments', () => {
    const matcher = compileExclusionMatcher(['/docs/reference/**']);
    expect(matcher('/docs/reference/v1/endpoint')).toBe(true);
    expect(matcher('/docs/reference')).toBe(true);
    expect(matcher('/docs/guide')).toBe(false);
  });

  test('matches * within a segment', () => {
    const matcher = compileExclusionMatcher(['/docs/v*/api']);
    expect(matcher('/docs/v1/api')).toBe(true);
    expect(matcher('/docs/v2/api')).toBe(true);
    expect(matcher('/docs/v1/guide')).toBe(false);
  });

  test('multiple patterns', () => {
    const matcher = compileExclusionMatcher(['/docs/changelog/**', '/docs/blog/**']);
    expect(matcher('/docs/changelog/v1')).toBe(true);
    expect(matcher('/docs/blog/post-1')).toBe(true);
    expect(matcher('/docs/guide')).toBe(false);
  });

  test('empty patterns never match', () => {
    const matcher = compileExclusionMatcher([]);
    expect(matcher('/docs/anything')).toBe(false);
  });
});

describe('extractOmittedPrefixes', () => {
  test('extracts directory from .txt URLs', () => {
    const prefixes = extractOmittedPrefixes([
      'http://example.com/docs/chains/ethereum/llms.txt',
      'http://example.com/docs/chains/solana/llms.txt',
    ]);
    expect(prefixes).toEqual(['/docs/chains/ethereum', '/docs/chains/solana']);
  });

  test('returns empty for empty input', () => {
    expect(extractOmittedPrefixes([])).toEqual([]);
  });
});
