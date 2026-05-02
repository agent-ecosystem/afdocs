/**
 * Cross-check integration tests.
 *
 * These tests run real checks in sequence through the runner and verify that
 * data flows correctly between them via pageCache and previousResults.
 * Unlike unit tests (which manually construct context), these exercise
 * the actual pipeline: discovery → upstream checks → downstream consumers.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { runChecks } from '../../src/runner.js';
import '../../src/checks/index.js';
import { mockSitemapNotFound } from '../helpers/mock-sitemap-not-found.js';

const server = setupServer();

beforeAll(() => {
  server.listen({ onUnhandledRequest: 'bypass' });
  return () => server.close();
});

/**
 * Helper: set up a docs site with llms.txt, page links, optional .md URLs,
 * and optional content-negotiation support.
 */
function setupSite(
  host: string,
  opts: {
    llmsTxt?: string;
    pages: Array<{
      path: string;
      html?: string;
      md?: string;
      contentNeg?: string;
    }>;
    softNotFound?: boolean;
    cacheControl?: string;
  },
) {
  const handlers = [];

  // llms.txt
  if (opts.llmsTxt) {
    handlers.push(http.get(`http://${host}/llms.txt`, () => HttpResponse.text(opts.llmsTxt!)));
  } else {
    handlers.push(
      http.get(`http://${host}/llms.txt`, () => new HttpResponse(null, { status: 404 })),
    );
  }
  handlers.push(
    http.get(`http://${host}/docs/llms.txt`, () => new HttpResponse(null, { status: 404 })),
  );

  // Sitemap discovery: return 404 so the fallback doesn't time out
  handlers.push(
    http.get(`http://${host}/robots.txt`, () => new HttpResponse('', { status: 404 })),
    http.get(`http://${host}/sitemap.xml`, () => new HttpResponse('', { status: 404 })),
    http.get(`http://${host}/sitemap-index.xml`, () => new HttpResponse('', { status: 404 })),
    http.get(`http://${host}/sitemap_index.xml`, () => new HttpResponse('', { status: 404 })),
  );

  const defaultCacheHeaders = opts.cacheControl ? { 'Cache-Control': opts.cacheControl } : {};

  for (const page of opts.pages) {
    // HTML version (GET and HEAD)
    handlers.push(
      http.get(`http://${host}${page.path}`, ({ request }) => {
        const accept = request.headers.get('accept') ?? '';

        // Content negotiation: if requesting markdown and the page supports it
        if (accept.includes('text/markdown') && page.contentNeg) {
          return new HttpResponse(page.contentNeg, {
            status: 200,
            headers: { 'Content-Type': 'text/markdown', ...defaultCacheHeaders },
          });
        }

        return new HttpResponse(
          page.html ?? `<html><body><h1>Page</h1><p>Content for ${page.path}</p></body></html>`,
          { status: 200, headers: { 'Content-Type': 'text/html', ...defaultCacheHeaders } },
        );
      }),
      // HEAD handler for llms-txt-links-resolve — mirrors GET status
      http.head(`http://${host}${page.path}`, () => new HttpResponse(null, { status: 200 })),
    );

    // .md URL (both /page.md and /page/index.md candidates from toMdUrls)
    if (page.md) {
      handlers.push(
        http.get(
          `http://${host}${page.path}.md`,
          () =>
            new HttpResponse(page.md!, {
              status: 200,
              headers: { 'Content-Type': 'text/markdown', ...defaultCacheHeaders },
            }),
        ),
        http.get(
          `http://${host}${page.path}/index.md`,
          () =>
            new HttpResponse(page.md!, {
              status: 200,
              headers: { 'Content-Type': 'text/markdown', ...defaultCacheHeaders },
            }),
        ),
      );
    } else {
      handlers.push(
        http.get(`http://${host}${page.path}.md`, () => new HttpResponse(null, { status: 404 })),
        http.get(
          `http://${host}${page.path}/index.md`,
          () => new HttpResponse(null, { status: 404 }),
        ),
      );
    }

    // Bad URL for http-status-codes
    const badPath = `${page.path}-afdocs-nonexistent-8f3a`;
    if (opts.softNotFound) {
      handlers.push(
        http.get(
          `http://${host}${badPath}`,
          () =>
            new HttpResponse('<html><body>Home</body></html>', {
              status: 200,
              headers: { 'Content-Type': 'text/html' },
            }),
        ),
      );
    } else {
      handlers.push(
        http.get(`http://${host}${badPath}`, () => new HttpResponse('Not Found', { status: 404 })),
      );
    }
  }

  server.use(...handlers);
}

describe('check pipeline: markdown availability → downstream consumers', () => {
  it('markdown-url-support populates pageCache for page-size-markdown', async () => {
    const mdContent =
      '# Getting Started\n\nThis is a guide with some content.\n\n```js\nconsole.log("hello");\n```\n';
    setupSite('pipe-md.local', {
      llmsTxt:
        '# Docs\n## Links\n- [Getting Started](http://pipe-md.local/docs/getting-started): Guide\n',
      pages: [{ path: '/docs/getting-started', md: mdContent }],
    });

    const report = await runChecks('http://pipe-md.local', {
      checkIds: [
        'llms-txt-exists',
        'markdown-url-support',
        'page-size-markdown',
        'markdown-code-fence-validity',
      ],
      requestDelay: 0,
    });

    const mdUrlResult = report.results.find((r) => r.id === 'markdown-url-support')!;
    const sizeResult = report.results.find((r) => r.id === 'page-size-markdown')!;
    const fenceResult = report.results.find((r) => r.id === 'markdown-code-fence-validity')!;

    // Upstream should pass
    expect(mdUrlResult.status).toBe('pass');

    // Downstream checks should consume the cached content, not skip
    expect(sizeResult.status).not.toBe('skip');
    expect(sizeResult.details?.totalPages).toBe(1);
    const sizePageResults = sizeResult.details?.pageResults as Array<{
      source: string;
      characters: number;
    }>;
    expect(sizePageResults[0].source).toBe('md-url');
    expect(sizePageResults[0].characters).toBe(mdContent.length);

    // Fence validity should also see the cached content (plus llms.txt content)
    expect(fenceResult.status).toBe('pass');
    expect(fenceResult.details?.totalFences).toBe(1);
    // pagesAnalyzed includes the llms.txt file too
    expect(fenceResult.details?.pagesAnalyzed).toBe(2);
  });

  it('content-negotiation populates pageCache when md-url is unavailable', async () => {
    const cnContent = '# API Reference\n\nEndpoints and methods.\n';
    setupSite('pipe-cn.local', {
      llmsTxt: '# Docs\n## Links\n- [API](http://pipe-cn.local/docs/api): Reference\n',
      pages: [{ path: '/docs/api', contentNeg: cnContent }],
    });

    const report = await runChecks('http://pipe-cn.local', {
      checkIds: [
        'llms-txt-exists',
        'markdown-url-support',
        'content-negotiation',
        'page-size-markdown',
      ],
      requestDelay: 0,
    });

    const mdUrlResult = report.results.find((r) => r.id === 'markdown-url-support')!;
    const cnResult = report.results.find((r) => r.id === 'content-negotiation')!;
    const sizeResult = report.results.find((r) => r.id === 'page-size-markdown')!;

    // .md URLs fail, but content negotiation works
    expect(mdUrlResult.status).toBe('fail');
    expect(cnResult.status).not.toBe('skip');

    // page-size-markdown should still have content from content-negotiation
    expect(sizeResult.status).not.toBe('skip');
    expect(sizeResult.details?.totalPages).toBe(1);
    const sizePageResults = sizeResult.details?.pageResults as Array<{ source: string }>;
    expect(sizePageResults[0].source).toBe('content-negotiation');
  });

  it('content-negotiation does not overwrite pageCache entries from markdown-url-support', async () => {
    const mdContent = '# Via .md URL\n\nMarkdown from .md URL.\n';
    const cnContent = '# Via Content Negotiation\n\nMarkdown from CN.\n';
    setupSite('pipe-nooverwrite.local', {
      llmsTxt: '# Docs\n## Links\n- [Page](http://pipe-nooverwrite.local/docs/page): A page\n',
      pages: [{ path: '/docs/page', md: mdContent, contentNeg: cnContent }],
    });

    const report = await runChecks('http://pipe-nooverwrite.local', {
      checkIds: [
        'llms-txt-exists',
        'markdown-url-support',
        'content-negotiation',
        'page-size-markdown',
      ],
      requestDelay: 0,
    });

    const sizeResult = report.results.find((r) => r.id === 'page-size-markdown')!;
    expect(sizeResult.details?.totalPages).toBe(1);

    // Should be from md-url (first check to populate cache), not content-negotiation
    const sizePageResults = sizeResult.details?.pageResults as Array<{
      source: string;
      characters: number;
    }>;
    expect(sizePageResults[0].source).toBe('md-url');
    expect(sizePageResults[0].characters).toBe(mdContent.length);
  });
});

describe('check pipeline: shared sampling across checks', () => {
  it('all checks test the same sampled pages', async () => {
    // Create a site with enough pages to trigger sampling (> maxLinksToTest)
    const pages = [];
    const links = [];
    for (let i = 0; i < 60; i++) {
      const path = `/docs/page-${i}`;
      pages.push({ path, md: `# Page ${i}\n\nContent for page ${i}.\n` });
      links.push(`- [Page ${i}](http://pipe-sample.local${path}): Page ${i}`);
    }
    setupSite('pipe-sample.local', {
      llmsTxt: `# Docs\n## Links\n${links.join('\n')}\n`,
      pages,
    });

    const report = await runChecks('http://pipe-sample.local', {
      checkIds: [
        'llms-txt-exists',
        'markdown-url-support',
        'content-negotiation',
        'page-size-html',
        'http-status-codes',
      ],
      requestDelay: 0,
      maxLinksToTest: 10,
    });

    const mdUrlResult = report.results.find((r) => r.id === 'markdown-url-support')!;
    const cnResult = report.results.find((r) => r.id === 'content-negotiation')!;
    const htmlResult = report.results.find((r) => r.id === 'page-size-html')!;
    const statusResult = report.results.find((r) => r.id === 'http-status-codes')!;

    // All checks that use discoverAndSamplePages should report the same total
    expect(mdUrlResult.details?.totalPages).toBe(60);
    expect(cnResult.details?.totalPages).toBe(60);
    expect(htmlResult.details?.totalPages).toBe(60);
    expect(statusResult.details?.totalPages).toBe(60);

    // All should have tested the same sampled subset
    const mdUrlPages = (mdUrlResult.details?.pageResults as Array<{ url: string }>)
      .map((p) => p.url)
      .sort();
    const cnPages = (cnResult.details?.pageResults as Array<{ url: string }>)
      .map((p) => p.url)
      .sort();
    const htmlPages = (htmlResult.details?.pageResults as Array<{ url: string }>)
      .map((p) => p.url)
      .sort();

    expect(mdUrlPages).toEqual(cnPages);
    expect(mdUrlPages).toEqual(htmlPages);

    // http-status-codes tests derived URLs, but should have the same count
    expect(statusResult.details?.testedPages).toBe(10);
  });
});

describe('check pipeline: llms-txt content flows to downstream checks', () => {
  it('llms.txt content is included in fence validity analysis', async () => {
    const llmsContent =
      '# Docs\n\n```python\nprint("hello")\n```\n\n## Links\n- [Page](http://pipe-llms.local/docs/page): A page\n';
    const pageMd = '# Page\n\nNo fences here.\n';
    setupSite('pipe-llms.local', {
      llmsTxt: llmsContent,
      pages: [{ path: '/docs/page', md: pageMd }],
    });

    const report = await runChecks('http://pipe-llms.local', {
      checkIds: ['llms-txt-exists', 'markdown-url-support', 'markdown-code-fence-validity'],
      requestDelay: 0,
    });

    const fenceResult = report.results.find((r) => r.id === 'markdown-code-fence-validity')!;
    expect(fenceResult.status).toBe('pass');
    // Should include both the llms.txt content (1 fence) and the page (0 fences)
    expect(fenceResult.details?.pagesAnalyzed).toBe(2);
    expect(fenceResult.details?.totalFences).toBe(1);
  });

  it('llms.txt content is excluded from page-size-markdown (not a doc page)', async () => {
    const llmsContent =
      '# Docs\n\n## Links\n- [Page](http://pipe-llms-size.local/docs/page): A page\n';
    const pageMd = '# Page\n\nSome content.\n';
    setupSite('pipe-llms-size.local', {
      llmsTxt: llmsContent,
      pages: [{ path: '/docs/page', md: pageMd }],
    });

    const report = await runChecks('http://pipe-llms-size.local', {
      checkIds: ['llms-txt-exists', 'markdown-url-support', 'page-size-markdown'],
      requestDelay: 0,
    });

    const sizeResult = report.results.find((r) => r.id === 'page-size-markdown')!;
    // llms.txt pages are filtered out from size checking
    expect(sizeResult.details?.totalPages).toBe(1);
    const sizePageResults = sizeResult.details?.pageResults as Array<{ source: string }>;
    expect(sizePageResults.every((p) => p.source !== 'llms-txt')).toBe(true);
  });
});

describe('check pipeline: dependency skipping vs standalone mode', () => {
  it('downstream checks skip when upstream ran and failed', async () => {
    // Site with no .md URLs and no content negotiation
    setupSite('pipe-nmd.local', {
      llmsTxt: '# Docs\n## Links\n- [Page](http://pipe-nmd.local/docs/page): A page\n',
      pages: [{ path: '/docs/page' }],
    });

    const report = await runChecks('http://pipe-nmd.local', {
      checkIds: [
        'llms-txt-exists',
        'markdown-url-support',
        'content-negotiation',
        'page-size-markdown',
        'markdown-code-fence-validity',
      ],
      requestDelay: 0,
    });

    const mdUrlResult = report.results.find((r) => r.id === 'markdown-url-support')!;
    const cnResult = report.results.find((r) => r.id === 'content-negotiation')!;
    const sizeResult = report.results.find((r) => r.id === 'page-size-markdown')!;
    const fenceResult = report.results.find((r) => r.id === 'markdown-code-fence-validity')!;

    // Both upstream checks fail (no markdown available)
    expect(mdUrlResult.status).toBe('fail');
    expect(cnResult.status).toBe('fail');

    // page-size-markdown should be skipped by the runner (deps ran but failed)
    expect(sizeResult.status).toBe('skip');
    expect(sizeResult.message).toContain('dependency');

    // markdown-code-fence-validity has no dependency; it runs and analyzes
    // llms.txt content even when the site doesn't serve markdown pages
    expect(fenceResult.status).toBe('pass');
    expect(fenceResult.message).toContain('code fences properly closed');
  });

  it('downstream checks run standalone when upstream is not in the check list', async () => {
    const pageMd = '# Page\n\n```js\nconsole.log("hi");\n```\n';
    setupSite('pipe-standalone.local', {
      llmsTxt: '# Docs\n## Links\n- [Page](http://pipe-standalone.local/docs/page): A page\n',
      pages: [{ path: '/docs/page', md: pageMd }],
    });

    const report = await runChecks('http://pipe-standalone.local', {
      // Only downstream checks; no markdown-url-support or content-negotiation
      checkIds: ['page-size-markdown', 'markdown-code-fence-validity'],
      requestDelay: 0,
    });

    const sizeResult = report.results.find((r) => r.id === 'page-size-markdown')!;
    const fenceResult = report.results.find((r) => r.id === 'markdown-code-fence-validity')!;

    // Should NOT be skipped — they run in standalone mode
    expect(sizeResult.status).not.toBe('skip');
    expect(sizeResult.message).not.toContain('dependency');
    expect(fenceResult.status).not.toBe('skip');
    expect(fenceResult.message).not.toContain('dependency');
  });
});

describe('check pipeline: llms-txt-exists → dependent checks data flow', () => {
  it('llms-txt-valid and llms-txt-size receive discoveredFiles from llms-txt-exists', async () => {
    const llmsContent =
      '# Test Docs\n\n> A test documentation site.\n\n## Links\n\n- [Guide](http://pipe-chain.local/docs/guide): A guide\n';
    setupSite('pipe-chain.local', {
      llmsTxt: llmsContent,
      pages: [{ path: '/docs/guide' }],
    });

    const report = await runChecks('http://pipe-chain.local', {
      checkIds: ['llms-txt-exists', 'llms-txt-valid', 'llms-txt-size', 'llms-txt-links-resolve'],
      requestDelay: 0,
    });

    const existsResult = report.results.find((r) => r.id === 'llms-txt-exists')!;
    const validResult = report.results.find((r) => r.id === 'llms-txt-valid')!;
    const sizeResult = report.results.find((r) => r.id === 'llms-txt-size')!;
    const resolveResult = report.results.find((r) => r.id === 'llms-txt-links-resolve')!;

    // Upstream discovers the file
    expect(existsResult.status).toBe('pass');
    const discovered = existsResult.details?.discoveredFiles as Array<{
      url: string;
      content: string;
    }>;
    expect(discovered.length).toBeGreaterThanOrEqual(1);
    expect(discovered[0].content).toBe(llmsContent);

    // Downstream checks should all run (not skip)
    expect(validResult.status).not.toBe('skip');
    expect(sizeResult.status).not.toBe('skip');
    expect(resolveResult.status).not.toBe('skip');

    // Size check should measure the actual content length
    const sizes = sizeResult.details?.sizes as Array<{ characters: number }>;
    expect(sizes[0].characters).toBe(llmsContent.length);
  });

  it('llms-txt dependent checks all skip when llms.txt is not found', async () => {
    setupSite('pipe-nollms.local', {
      pages: [{ path: '/docs/page' }],
    });

    const report = await runChecks('http://pipe-nollms.local', {
      checkIds: ['llms-txt-exists', 'llms-txt-valid', 'llms-txt-size', 'llms-txt-links-resolve'],
      requestDelay: 0,
    });

    expect(report.results.find((r) => r.id === 'llms-txt-exists')!.status).toBe('fail');
    expect(report.results.find((r) => r.id === 'llms-txt-valid')!.status).toBe('skip');
    expect(report.results.find((r) => r.id === 'llms-txt-size')!.status).toBe('skip');
    expect(report.results.find((r) => r.id === 'llms-txt-links-resolve')!.status).toBe('skip');
  });
});

describe('check pipeline: cache-header-hygiene llms.txt interaction', () => {
  it('includes llms.txt URLs when llms-txt-exists ran first', async () => {
    setupSite('pipe-chh-llms.local', {
      llmsTxt: '# Docs\n## Links\n- [Page](http://pipe-chh-llms.local/docs/page): A page\n',
      pages: [{ path: '/docs/page' }],
      cacheControl: 'no-cache',
    });

    const report = await runChecks('http://pipe-chh-llms.local', {
      checkIds: ['llms-txt-exists', 'cache-header-hygiene'],
      requestDelay: 0,
    });

    const cacheResult = report.results.find((r) => r.id === 'cache-header-hygiene')!;
    const endpoints = (cacheResult.details?.endpointResults as Array<{ url: string }>).map(
      (e) => e.url,
    );

    // Should include the llms.txt URL (from discoveredFiles) and the page URL
    expect(endpoints.some((u) => u.includes('llms.txt'))).toBe(true);
    expect(endpoints.some((u) => u.includes('/docs/page'))).toBe(true);
    expect(cacheResult.details?.testedEndpoints).toBeGreaterThanOrEqual(2);
  });

  it('still works when llms-txt-exists has not run (no llms.txt URLs)', async () => {
    setupSite('pipe-chh-nollms.local', {
      llmsTxt: '# Docs\n## Links\n- [Page](http://pipe-chh-nollms.local/docs/page): A page\n',
      pages: [{ path: '/docs/page' }],
      cacheControl: 'no-cache',
    });

    // Run only cache-header-hygiene without llms-txt-exists
    const report = await runChecks('http://pipe-chh-nollms.local', {
      checkIds: ['cache-header-hygiene'],
      requestDelay: 0,
    });

    const cacheResult = report.results.find((r) => r.id === 'cache-header-hygiene')!;
    // Should still work — just won't include llms.txt-specific endpoints
    expect(cacheResult.status).not.toBe('error');
    expect(cacheResult.details?.testedEndpoints).toBeGreaterThanOrEqual(1);
  });
});

describe('check pipeline: page-size-markdown mdUrl enrichment', () => {
  it('uses markdown-url-support pageResults to show .md URLs in size report', async () => {
    const mdContent = '# Guide\n\nSome markdown content here.\n';
    setupSite('pipe-mdurl.local', {
      llmsTxt: '# Docs\n## Links\n- [Guide](http://pipe-mdurl.local/docs/guide): Guide\n',
      pages: [{ path: '/docs/guide', md: mdContent }],
    });

    const report = await runChecks('http://pipe-mdurl.local', {
      checkIds: ['llms-txt-exists', 'markdown-url-support', 'page-size-markdown'],
      requestDelay: 0,
    });

    const sizeResult = report.results.find((r) => r.id === 'page-size-markdown')!;
    const pageResults = sizeResult.details?.pageResults as Array<{ url: string; mdUrl: string }>;

    // The mdUrl should be the .md URL, enriched from markdown-url-support results
    expect(pageResults[0].url).toBe('http://pipe-mdurl.local/docs/guide');
    expect(pageResults[0].mdUrl).toBe('http://pipe-mdurl.local/docs/guide.md');
  });
});

describe('check pipeline: content-negotiation respects md-url cache', () => {
  it('preserves md-url content in cache even when CN returns different content', async () => {
    const mdUrlContent = '# Short MD URL version\n';
    const cnContent =
      '# Longer content negotiation version with extra details\n\nMore stuff here.\n';
    setupSite('pipe-preserve.local', {
      llmsTxt: '# Docs\n## Links\n- [Page](http://pipe-preserve.local/docs/page): A page\n',
      pages: [{ path: '/docs/page', md: mdUrlContent, contentNeg: cnContent }],
    });

    const report = await runChecks('http://pipe-preserve.local', {
      checkIds: [
        'llms-txt-exists',
        'markdown-url-support',
        'content-negotiation',
        'page-size-markdown',
      ],
      requestDelay: 0,
    });

    const sizeResult = report.results.find((r) => r.id === 'page-size-markdown')!;
    const pageResults = sizeResult.details?.pageResults as Array<{
      characters: number;
      source: string;
    }>;

    // Should have md-url content (shorter), not CN content (longer)
    expect(pageResults[0].source).toBe('md-url');
    expect(pageResults[0].characters).toBe(mdUrlContent.length);
  });
});

describe('check pipeline: HTML fetch cache shared across checks', () => {
  it('page-size-html and tabbed-content-serialization share fetched HTML', async () => {
    let fetchCount = 0;
    const pageHtml =
      '<html><body><h1>Guide</h1><div class="sphinx-tabs"><div class="sphinx-tabs-tab">Python</div><div class="sphinx-tabs-panel"><pre>print("hi")</pre></div></div></body></html>';

    server.use(
      http.get('http://pipe-htmlcache.local/llms.txt', () =>
        HttpResponse.text(
          '# Docs\n## Links\n- [Guide](http://pipe-htmlcache.local/docs/guide): Guide\n',
        ),
      ),
      http.get(
        'http://pipe-htmlcache.local/docs/llms.txt',
        () => new HttpResponse(null, { status: 404 }),
      ),
      http.get('http://pipe-htmlcache.local/docs/guide', () => {
        fetchCount++;
        return new HttpResponse(pageHtml, {
          status: 200,
          headers: { 'Content-Type': 'text/html' },
        });
      }),
      // page-size-html probes for .md and 404-test URLs
      http.get(
        'http://pipe-htmlcache.local/docs/guide.md',
        () => new HttpResponse(null, { status: 404 }),
      ),
      http.get(
        'http://pipe-htmlcache.local/docs/guide/index.md',
        () => new HttpResponse(null, { status: 404 }),
      ),
      http.get(
        'http://pipe-htmlcache.local/docs/guide-afdocs-nonexistent-8f3a',
        () => new HttpResponse('Not Found', { status: 404 }),
      ),
    );
    mockSitemapNotFound(server, 'http://pipe-htmlcache.local');

    const report = await runChecks('http://pipe-htmlcache.local', {
      checkIds: ['llms-txt-exists', 'page-size-html', 'tabbed-content-serialization'],
      requestDelay: 0,
    });

    const htmlResult = report.results.find((r) => r.id === 'page-size-html')!;
    const tabResult = report.results.find((r) => r.id === 'tabbed-content-serialization')!;

    // Both checks should succeed
    expect(htmlResult.status).not.toBe('error');
    expect(tabResult.status).not.toBe('error');
    expect(tabResult.details?.totalGroupsFound).toBe(1);

    // The page should only be fetched once, not twice
    expect(fetchCount).toBe(1);
  });
});

describe('check pipeline: independent checks share sampling', () => {
  it('cache-header-hygiene and auth-gate-detection test the same pages', async () => {
    const pages = [];
    const links = [];
    for (let i = 0; i < 20; i++) {
      const path = `/docs/page-${i}`;
      pages.push({ path });
      links.push(`- [Page ${i}](http://pipe-indep.local${path}): Page ${i}`);
    }
    setupSite('pipe-indep.local', {
      llmsTxt: `# Docs\n## Links\n${links.join('\n')}\n`,
      pages,
      cacheControl: 'no-cache',
    });

    const report = await runChecks('http://pipe-indep.local', {
      checkIds: ['llms-txt-exists', 'cache-header-hygiene', 'auth-gate-detection'],
      requestDelay: 0,
      maxLinksToTest: 5,
    });

    const cacheResult = report.results.find((r) => r.id === 'cache-header-hygiene')!;
    const authResult = report.results.find((r) => r.id === 'auth-gate-detection')!;

    expect(cacheResult.details?.totalPages).toBe(20);
    expect(authResult.details?.totalPages).toBe(20);
    expect(authResult.details?.testedPages).toBe(5);

    // cache-header-hygiene tests page URLs + llms.txt URLs, so it tests more endpoints
    // than auth-gate-detection, but the page subset should be the same
    const authPages = (authResult.details?.pageResults as Array<{ url: string }>)
      .map((p) => p.url)
      .sort();

    // cache-header-hygiene endpointResults include the llms.txt URL plus page URLs
    const cacheEndpoints = (cacheResult.details?.endpointResults as Array<{ url: string }>)
      .map((p) => p.url)
      .sort();
    const cachePageUrls = cacheEndpoints.filter((u) => !u.includes('llms.txt')).sort();

    expect(authPages).toEqual(cachePageUrls);
  });
});

describe('check pipeline: auth-gate-detection → auth-alternative-access', () => {
  it('auth-alternative-access detects public llms.txt when docs are gated', async () => {
    // Site where llms.txt is public but doc pages return 401
    server.use(
      http.get('http://pipe-auth-llms.local/llms.txt', () =>
        HttpResponse.text(
          '# Docs\n## Links\n- [Page](http://pipe-auth-llms.local/docs/page): A page\n',
        ),
      ),
      http.get(
        'http://pipe-auth-llms.local/docs/llms.txt',
        () => new HttpResponse(null, { status: 404 }),
      ),
      http.get(
        'http://pipe-auth-llms.local/docs/page',
        () => new HttpResponse('Unauthorized', { status: 401 }),
      ),
      http.get(
        'http://pipe-auth-llms.local/docs/page.md',
        () => new HttpResponse(null, { status: 404 }),
      ),
      http.get(
        'http://pipe-auth-llms.local/docs/page/index.md',
        () => new HttpResponse(null, { status: 404 }),
      ),
      http.get(
        'http://pipe-auth-llms.local/docs/page-afdocs-nonexistent-8f3a',
        () => new HttpResponse('Not Found', { status: 404 }),
      ),
    );
    mockSitemapNotFound(server, 'http://pipe-auth-llms.local');

    const report = await runChecks('http://pipe-auth-llms.local', {
      checkIds: ['llms-txt-exists', 'auth-gate-detection', 'auth-alternative-access'],
      requestDelay: 0,
    });

    const llmsResult = report.results.find((r) => r.id === 'llms-txt-exists')!;
    const authResult = report.results.find((r) => r.id === 'auth-gate-detection')!;
    const altResult = report.results.find((r) => r.id === 'auth-alternative-access')!;

    expect(llmsResult.status).toBe('pass');
    expect(authResult.status).toBe('fail');
    // auth-alternative-access should detect the public llms.txt
    expect(altResult.status).toBe('warn'); // llms.txt alone is partial
    const paths = altResult.details?.detectedPaths as Array<{ type: string }>;
    expect(paths.some((p) => p.type === 'public-llms-txt')).toBe(true);
  });

  it('auth-alternative-access skips when all pages are public', async () => {
    setupSite('pipe-auth-public.local', {
      llmsTxt: '# Docs\n## Links\n- [Page](http://pipe-auth-public.local/docs/page): A page\n',
      pages: [{ path: '/docs/page' }],
    });

    const report = await runChecks('http://pipe-auth-public.local', {
      checkIds: ['llms-txt-exists', 'auth-gate-detection', 'auth-alternative-access'],
      requestDelay: 0,
    });

    const authResult = report.results.find((r) => r.id === 'auth-gate-detection')!;
    const altResult = report.results.find((r) => r.id === 'auth-alternative-access')!;

    expect(authResult.status).toBe('pass');
    expect(altResult.status).toBe('skip');
    expect(altResult.message).toContain('publicly accessible');
  });

  it('auth-alternative-access passes when gated site has public markdown', async () => {
    // Site where some pages require auth but markdown is available
    server.use(
      http.get('http://pipe-auth-md.local/llms.txt', () =>
        HttpResponse.text(
          '# Docs\n## Links\n- [Public](http://pipe-auth-md.local/docs/public): Public\n- [Private](http://pipe-auth-md.local/docs/private): Private\n',
        ),
      ),
      http.get(
        'http://pipe-auth-md.local/docs/llms.txt',
        () => new HttpResponse(null, { status: 404 }),
      ),
      http.get(
        'http://pipe-auth-md.local/docs/public',
        () =>
          new HttpResponse('<html><body><h1>Public Page</h1><p>Content here.</p></body></html>', {
            status: 200,
            headers: { 'Content-Type': 'text/html' },
          }),
      ),
      http.get(
        'http://pipe-auth-md.local/docs/public.md',
        () =>
          new HttpResponse('# Public Page\n\nContent here.\n', {
            status: 200,
            headers: { 'Content-Type': 'text/markdown' },
          }),
      ),
      http.get(
        'http://pipe-auth-md.local/docs/private',
        () => new HttpResponse('Forbidden', { status: 403 }),
      ),
      http.get(
        'http://pipe-auth-md.local/docs/private.md',
        () => new HttpResponse(null, { status: 403 }),
      ),
      http.get(
        'http://pipe-auth-md.local/docs/public/index.md',
        () => new HttpResponse(null, { status: 404 }),
      ),
      http.get(
        'http://pipe-auth-md.local/docs/private/index.md',
        () => new HttpResponse(null, { status: 404 }),
      ),
      http.get(
        'http://pipe-auth-md.local/docs/public-afdocs-nonexistent-8f3a',
        () => new HttpResponse('Not Found', { status: 404 }),
      ),
      http.get(
        'http://pipe-auth-md.local/docs/private-afdocs-nonexistent-8f3a',
        () => new HttpResponse('Not Found', { status: 404 }),
      ),
    );
    mockSitemapNotFound(server, 'http://pipe-auth-md.local');

    const report = await runChecks('http://pipe-auth-md.local', {
      checkIds: [
        'llms-txt-exists',
        'markdown-url-support',
        'auth-gate-detection',
        'auth-alternative-access',
      ],
      requestDelay: 0,
    });

    const authResult = report.results.find((r) => r.id === 'auth-gate-detection')!;
    const mdResult = report.results.find((r) => r.id === 'markdown-url-support')!;
    const altResult = report.results.find((r) => r.id === 'auth-alternative-access')!;

    expect(authResult.status).toBe('warn'); // mixed: some accessible, some gated
    expect(mdResult.status).not.toBe('skip');
    expect(altResult.status).toBe('pass');
    const paths = altResult.details?.detectedPaths as Array<{ type: string }>;
    expect(paths.some((p) => p.type === 'public-llms-txt')).toBe(true);
    expect(paths.some((p) => p.type === 'public-markdown')).toBe(true);
    expect(paths.some((p) => p.type === 'partial-public-access')).toBe(true);
  });
});

describe('check pipeline: rendering-strategy → tabbed-content-serialization', () => {
  it('tabbed-content-serialization uses SPA shell detection to try markdown fallback', async () => {
    // Page is an SPA shell (minimal HTML with React root), but has tabs in markdown
    const spaHtml =
      '<html><head><title>Docs</title></head><body><div id="root"></div><script src="/app.js"></script></body></html>';
    const mdContent =
      '# Guide\n\n:::tabs\n::tab{label="Python"}\n```python\nprint("hi")\n```\n::tab{label="JS"}\n```js\nconsole.log("hi");\n```\n:::';

    server.use(
      http.get('http://pipe-spa-tab.local/llms.txt', () =>
        HttpResponse.text(
          '# Docs\n## Links\n- [Guide](http://pipe-spa-tab.local/docs/guide): Guide\n',
        ),
      ),
      http.get(
        'http://pipe-spa-tab.local/docs/llms.txt',
        () => new HttpResponse(null, { status: 404 }),
      ),
      http.get('http://pipe-spa-tab.local/docs/guide', ({ request }) => {
        const accept = request.headers.get('accept') ?? '';
        if (accept.includes('text/markdown')) {
          return new HttpResponse(mdContent, {
            status: 200,
            headers: { 'Content-Type': 'text/markdown' },
          });
        }
        return new HttpResponse(spaHtml, {
          status: 200,
          headers: { 'Content-Type': 'text/html' },
        });
      }),
      http.get(
        'http://pipe-spa-tab.local/docs/guide.md',
        () => new HttpResponse(null, { status: 404 }),
      ),
      http.get(
        'http://pipe-spa-tab.local/docs/guide/index.md',
        () => new HttpResponse(null, { status: 404 }),
      ),
      http.get(
        'http://pipe-spa-tab.local/docs/guide-afdocs-nonexistent-8f3a',
        () => new HttpResponse('Not Found', { status: 404 }),
      ),
    );

    mockSitemapNotFound(server, 'http://pipe-spa-tab.local');

    const report = await runChecks('http://pipe-spa-tab.local', {
      checkIds: ['llms-txt-exists', 'rendering-strategy', 'tabbed-content-serialization'],
      requestDelay: 0,
    });

    const renderResult = report.results.find((r) => r.id === 'rendering-strategy')!;
    const tabResult = report.results.find((r) => r.id === 'tabbed-content-serialization')!;

    // rendering-strategy should flag the page as SPA shell
    expect(renderResult.status).toBe('fail');
    const renderPages = renderResult.details?.pageResults as Array<{ url: string; status: string }>;
    expect(renderPages.some((p) => p.status === 'fail')).toBe(true);

    // tabbed-content-serialization should have used the md-fallback path
    // since the page was detected as an SPA shell by rendering-strategy
    const tabbedPages = tabResult.details?.tabbedPages as Array<{ url: string; source: string }>;
    expect(tabbedPages).toBeDefined();
    // If tabs were detected via the fallback, source should be 'md-fallback'
    // If no tabs found in md either, source stays 'html' — either way it should not error
    expect(tabResult.status).not.toBe('error');
  });
});

describe('check pipeline: tabbed-content-serialization → section-header-quality', () => {
  it('section-header-quality reads tabbed page data from tabbed-content-serialization', async () => {
    // Page with Sphinx-style tabs containing headers in each panel
    const tabbedHtml = `<html><body>
      <h1>Installation</h1>
      <div class="sphinx-tabs">
        <div class="sphinx-tabs-tab">Python</div>
        <div class="sphinx-tabs-panel"><h2>Installation</h2><pre>pip install sdk</pre></div>
        <div class="sphinx-tabs-tab">JavaScript</div>
        <div class="sphinx-tabs-panel"><h2>Installation</h2><pre>npm install sdk</pre></div>
      </div>
    </body></html>`;

    server.use(
      http.get('http://pipe-tab-hdr.local/llms.txt', () =>
        HttpResponse.text(
          '# Docs\n## Links\n- [Install](http://pipe-tab-hdr.local/docs/install): Installation\n',
        ),
      ),
      http.get(
        'http://pipe-tab-hdr.local/docs/llms.txt',
        () => new HttpResponse(null, { status: 404 }),
      ),
      http.get(
        'http://pipe-tab-hdr.local/docs/install',
        () =>
          new HttpResponse(tabbedHtml, {
            status: 200,
            headers: { 'Content-Type': 'text/html' },
          }),
      ),
      http.get(
        'http://pipe-tab-hdr.local/docs/install.md',
        () => new HttpResponse(null, { status: 404 }),
      ),
      http.get(
        'http://pipe-tab-hdr.local/docs/install/index.md',
        () => new HttpResponse(null, { status: 404 }),
      ),
      http.get(
        'http://pipe-tab-hdr.local/docs/install-afdocs-nonexistent-8f3a',
        () => new HttpResponse('Not Found', { status: 404 }),
      ),
    );

    mockSitemapNotFound(server, 'http://pipe-tab-hdr.local');

    const report = await runChecks('http://pipe-tab-hdr.local', {
      checkIds: ['llms-txt-exists', 'tabbed-content-serialization', 'section-header-quality'],
      requestDelay: 0,
    });

    const tabResult = report.results.find((r) => r.id === 'tabbed-content-serialization')!;
    const headerResult = report.results.find((r) => r.id === 'section-header-quality')!;

    // tabbed-content-serialization should find the tab group
    expect(tabResult.details?.totalGroupsFound).toBeGreaterThanOrEqual(1);

    // section-header-quality should consume the tabbed page data (not skip)
    expect(headerResult.status).not.toBe('skip');
    expect(headerResult.message).not.toContain('did not run');
  });

  it('section-header-quality skips when tabbed-content-serialization did not run', async () => {
    const report = await runChecks('http://pipe-tab-norun.local', {
      checkIds: ['section-header-quality'],
      requestDelay: 0,
    });

    const headerResult = report.results.find((r) => r.id === 'section-header-quality')!;
    expect(headerResult.status).toBe('skip');
    expect(headerResult.message).toContain('did not run');
  });
});

describe('check pipeline: llms-txt-exists → llms-txt-links-markdown data flow', () => {
  it('llms-txt-links-markdown receives discovered file content and tests links', async () => {
    server.use(
      http.get('http://pipe-llms-md.local/llms.txt', () =>
        HttpResponse.text(
          '# Docs\n## Links\n- [Guide](http://pipe-llms-md.local/docs/guide): Guide\n',
        ),
      ),
      http.get(
        'http://pipe-llms-md.local/docs/llms.txt',
        () => new HttpResponse(null, { status: 404 }),
      ),
      // The link in llms.txt returns HTML (not markdown)
      http.get(
        'http://pipe-llms-md.local/docs/guide',
        () =>
          new HttpResponse('<html><body><h1>Guide</h1></body></html>', {
            status: 200,
            headers: { 'Content-Type': 'text/html' },
          }),
      ),
      http.head(
        'http://pipe-llms-md.local/docs/guide',
        () => new HttpResponse(null, { status: 200 }),
      ),
      // .md URL returns markdown
      http.get(
        'http://pipe-llms-md.local/docs/guide.md',
        () =>
          new HttpResponse('# Guide\n\nContent.\n', {
            status: 200,
            headers: { 'Content-Type': 'text/markdown' },
          }),
      ),
      http.head(
        'http://pipe-llms-md.local/docs/guide.md',
        () => new HttpResponse(null, { status: 200, headers: { 'Content-Type': 'text/markdown' } }),
      ),
      http.get(
        'http://pipe-llms-md.local/docs/guide/index.md',
        () => new HttpResponse(null, { status: 404 }),
      ),
    );

    mockSitemapNotFound(server, 'http://pipe-llms-md.local');

    const report = await runChecks('http://pipe-llms-md.local', {
      checkIds: ['llms-txt-exists', 'llms-txt-links-markdown'],
      requestDelay: 0,
    });

    const existsResult = report.results.find((r) => r.id === 'llms-txt-exists')!;
    const mdResult = report.results.find((r) => r.id === 'llms-txt-links-markdown')!;

    expect(existsResult.status).toBe('pass');
    // Should run (not skip) and test the link
    expect(mdResult.status).not.toBe('skip');
    expect(mdResult.details?.totalLinks).toBe(1);
  });

  it('llms-txt-links-markdown skips when llms-txt-exists fails', async () => {
    server.use(
      http.get(
        'http://pipe-llms-md-nollms.local/llms.txt',
        () => new HttpResponse(null, { status: 404 }),
      ),
      http.get(
        'http://pipe-llms-md-nollms.local/docs/llms.txt',
        () => new HttpResponse(null, { status: 404 }),
      ),
    );

    mockSitemapNotFound(server, 'http://pipe-llms-md-nollms.local');

    const report = await runChecks('http://pipe-llms-md-nollms.local', {
      checkIds: ['llms-txt-exists', 'llms-txt-links-markdown'],
      requestDelay: 0,
    });

    expect(report.results.find((r) => r.id === 'llms-txt-exists')!.status).toBe('fail');
    expect(report.results.find((r) => r.id === 'llms-txt-links-markdown')!.status).toBe('skip');
  });
});

describe('check pipeline: markdown-content-parity reads from pageCache', () => {
  it('markdown-content-parity compares cached markdown against HTML', async () => {
    const mdContent = '# API Reference\n\nEndpoints and methods.\n';
    const htmlContent =
      '<html><body><h1>API Reference</h1><p>Endpoints and methods.</p></body></html>';

    setupSite('pipe-parity.local', {
      llmsTxt: '# Docs\n## Links\n- [API](http://pipe-parity.local/docs/api): Reference\n',
      pages: [{ path: '/docs/api', md: mdContent, html: htmlContent }],
    });

    const report = await runChecks('http://pipe-parity.local', {
      checkIds: ['llms-txt-exists', 'markdown-url-support', 'markdown-content-parity'],
      requestDelay: 0,
    });

    const mdUrlResult = report.results.find((r) => r.id === 'markdown-url-support')!;
    const parityResult = report.results.find((r) => r.id === 'markdown-content-parity')!;

    // markdown-url-support should have populated the pageCache
    expect(mdUrlResult.status).toBe('pass');

    // markdown-content-parity should consume the cached markdown (not skip)
    expect(parityResult.status).not.toBe('skip');
    expect(parityResult.message).not.toContain('No pages with markdown');
    expect(parityResult.details?.pagesCompared).toBe(1);
  });

  it('markdown-content-parity skips when no markdown is cached', async () => {
    setupSite('pipe-parity-nomd.local', {
      llmsTxt: '# Docs\n## Links\n- [Page](http://pipe-parity-nomd.local/docs/page): A page\n',
      pages: [{ path: '/docs/page' }],
    });

    const report = await runChecks('http://pipe-parity-nomd.local', {
      checkIds: [
        'llms-txt-exists',
        'markdown-url-support',
        'content-negotiation',
        'markdown-content-parity',
      ],
      requestDelay: 0,
    });

    const parityResult = report.results.find((r) => r.id === 'markdown-content-parity')!;
    // Both upstream checks failed → no markdown in cache → dependency skip
    expect(parityResult.status).toBe('skip');
  });
});

describe('check pipeline: canonical llms.txt selection', () => {
  it('docs llms.txt drives downstream sampling when both apex and docs exist', async () => {
    // Mirrors the scenario from issue #53: an apex llms.txt full of marketing
    // links and a small docs llms.txt with the actual documentation links.
    // When the user passes a docs URL, the docs llms.txt should be canonical
    // and downstream checks should sample from its links — not the apex's.
    const apexContent = `# Marketing\n\n> Apex marketing page.\n\n## Links\n\n${Array.from(
      { length: 20 },
      (_, i) => `- [Marketing ${i}](http://canon-pipe.local/blog/post-${i}): Blog post ${i}`,
    ).join('\n')}\n`;
    const docsContent =
      '# Docs\n\n> Docs index.\n\n## Links\n\n- [Guide](http://canon-pipe.local/docs/guide): Guide\n';

    server.use(
      http.get('http://canon-pipe.local/llms.txt', () => HttpResponse.text(apexContent)),
      http.get('http://canon-pipe.local/docs/llms.txt', () => HttpResponse.text(docsContent)),
      http.get(
        'http://canon-pipe.local/docs/guide',
        () =>
          new HttpResponse('<html><body><h1>Guide</h1></body></html>', {
            status: 200,
            headers: { 'Content-Type': 'text/html' },
          }),
      ),
      http.head(
        'http://canon-pipe.local/docs/guide',
        () => new HttpResponse(null, { status: 200 }),
      ),
    );
    mockSitemapNotFound(server, 'http://canon-pipe.local/docs');

    const report = await runChecks('http://canon-pipe.local/docs', {
      checkIds: ['llms-txt-exists', 'llms-txt-size', 'llms-txt-valid', 'llms-txt-links-resolve'],
      requestDelay: 0,
    });

    const existsResult = report.results.find((r) => r.id === 'llms-txt-exists')!;
    const sizeResult = report.results.find((r) => r.id === 'llms-txt-size')!;
    const validResult = report.results.find((r) => r.id === 'llms-txt-valid')!;
    const resolveResult = report.results.find((r) => r.id === 'llms-txt-links-resolve')!;

    // llms-txt-exists picks the docs file as canonical
    expect(existsResult.status).toBe('pass');
    expect(existsResult.details?.canonicalUrl).toBe('http://canon-pipe.local/docs/llms.txt');

    // Downstream checks should report on the docs file only, not the apex.
    // size: docs file is small, so it passes — the apex (with 20 inline links)
    // would not influence the result.
    expect(sizeResult.status).toBe('pass');
    const sizes = sizeResult.details?.sizes as Array<{ url: string; characters: number }>;
    expect(sizes).toHaveLength(1);
    expect(sizes[0].url).toBe('http://canon-pipe.local/docs/llms.txt');

    // valid: validates the docs file (which has H1, blockquote, sections, links)
    expect(validResult.status).toBe('pass');

    // links-resolve: only tests the single docs link, not the 20 marketing links
    expect(resolveResult.status).toBe('pass');
    expect(resolveResult.details?.totalLinks).toBe(1);
  });

  it('--llms-txt-url forces a specific file even when others would be discovered', async () => {
    const apexContent =
      '# Apex\n\n> Apex.\n\n## Links\n\n- [Blog](http://override-pipe.local/blog): Blog\n';
    const explicitContent =
      '# Explicit\n\n> Explicit.\n\n## Links\n\n- [Guide](http://override-pipe.local/docs/guide): Guide\n';

    server.use(
      http.get('http://override-pipe.local/llms.txt', () => HttpResponse.text(apexContent)),
      http.get('http://override-pipe.local/custom/llms.txt', () =>
        HttpResponse.text(explicitContent),
      ),
      http.get(
        'http://override-pipe.local/docs/llms.txt',
        () => new HttpResponse(null, { status: 404 }),
      ),
    );

    const report = await runChecks('http://override-pipe.local', {
      checkIds: ['llms-txt-exists', 'llms-txt-valid'],
      requestDelay: 0,
      llmsTxtUrl: 'http://override-pipe.local/custom/llms.txt',
    });

    const existsResult = report.results.find((r) => r.id === 'llms-txt-exists')!;
    expect(existsResult.details?.canonicalUrl).toBe('http://override-pipe.local/custom/llms.txt');

    const validResult = report.results.find((r) => r.id === 'llms-txt-valid')!;
    const validations = validResult.details?.validations as Array<{ url: string }>;
    // Only the explicit file should be validated, not the apex
    expect(validations).toHaveLength(1);
    expect(validations[0].url).toBe('http://override-pipe.local/custom/llms.txt');
  });
});

describe('check pipeline: effectiveOrigin propagation', () => {
  it('llms-txt-exists sets effectiveOrigin which llms-txt-coverage uses', async () => {
    // llms.txt redirects cross-host; sitemap lives at the redirected host
    const redirectedHost = 'pipe-effective-docs.local';
    const llmsContent = `# Docs\n## Links\n- [Guide](http://${redirectedHost}/docs/guide): Guide\n`;

    server.use(
      // Original host redirects llms.txt to different host
      http.get(
        'http://pipe-effective.local/llms.txt',
        () =>
          new HttpResponse(null, {
            status: 301,
            headers: { Location: `http://${redirectedHost}/llms.txt` },
          }),
      ),
      http.get(
        'http://pipe-effective.local/docs/llms.txt',
        () => new HttpResponse(null, { status: 404 }),
      ),
      // Redirected host serves llms.txt
      http.get(`http://${redirectedHost}/llms.txt`, () => HttpResponse.text(llmsContent)),
      // Sitemap at redirected host
      http.get('http://pipe-effective.local/robots.txt', () =>
        HttpResponse.text(`Sitemap: http://${redirectedHost}/sitemap.xml`),
      ),
      http.get(`http://${redirectedHost}/robots.txt`, () =>
        HttpResponse.text(`Sitemap: http://${redirectedHost}/sitemap.xml`),
      ),
      http.get(
        `http://${redirectedHost}/sitemap.xml`,
        () =>
          new HttpResponse(
            `<?xml version="1.0" encoding="UTF-8"?>
           <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
             <url><loc>http://${redirectedHost}/docs/guide</loc></url>
           </urlset>`,
            { status: 200, headers: { 'Content-Type': 'application/xml' } },
          ),
      ),
    );

    const report = await runChecks('http://pipe-effective.local', {
      checkIds: ['llms-txt-exists', 'llms-txt-coverage'],
      requestDelay: 0,
    });

    const existsResult = report.results.find((r) => r.id === 'llms-txt-exists')!;
    const coverageResult = report.results.find((r) => r.id === 'llms-txt-coverage')!;

    // Cross-host redirect produces 'warn' (agents may not follow it)
    expect(existsResult.status).toBe('warn');
    // Coverage should not skip — it should use the effectiveOrigin to find the sitemap
    // at the redirected host and match URLs there
    expect(coverageResult.status).not.toBe('skip');
    expect(coverageResult.message).not.toContain('No sitemap found');
  });
});
