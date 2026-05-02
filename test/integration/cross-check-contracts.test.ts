/**
 * Cross-check field contract and previousResults safety tests.
 *
 * These tests validate that:
 * 1. Downstream checks handle missing/empty upstream details gracefully
 * 2. Every check that reads previousResults works in isolation (no deps ran)
 * 3. Data shape contracts between checks are maintained
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { createContext } from '../../src/runner.js';
import { getCheck } from '../../src/checks/registry.js';
import '../../src/checks/index.js';
import type { DiscoveredFile } from '../../src/types.js';
import { mockSitemapNotFound } from '../helpers/mock-sitemap-not-found.js';

const server = setupServer();

beforeAll(() => {
  server.listen({ onUnhandledRequest: 'bypass' });
  return () => server.close();
});

const prose =
  'This is comprehensive documentation content explaining the feature. ' +
  'It covers configuration, usage, and troubleshooting. ';

function makeCtx(
  host: string,
  opts?: {
    llmsTxt?: string;
    llmsTxtStatus?: 'pass' | 'fail';
  },
) {
  const ctx = createContext(`http://${host}`, { requestDelay: 0 });

  if (opts?.llmsTxt) {
    const discovered: DiscoveredFile[] = [
      { url: `http://${host}/llms.txt`, content: opts.llmsTxt, status: 200, redirected: false },
    ];
    ctx.previousResults.set('llms-txt-exists', {
      id: 'llms-txt-exists',
      category: 'content-discoverability',
      status: opts.llmsTxtStatus ?? 'pass',
      message: 'Found',
      details: { discoveredFiles: discovered },
    });
  }

  mockSitemapNotFound(server, `http://${host}`);
  return ctx;
}

describe('previousResults safety: checks handle missing dependencies gracefully', () => {
  describe('checks with declared dependsOn', () => {
    it('page-size-markdown skips when no markdown deps ran (standalone mode)', async () => {
      const host = 'contract-psmk.local';
      const llms = `# Docs\n## Links\n- [Page](http://${host}/docs/page): Page\n`;
      const ctx = makeCtx(host, { llmsTxt: llms });
      // No markdown-url-support or content-negotiation in previousResults

      server.use(
        http.get(`http://${host}/docs/page.md`, () => new HttpResponse(null, { status: 404 })),
        http.get(
          `http://${host}/docs/page/index.md`,
          () => new HttpResponse(null, { status: 404 }),
        ),
        http.get(
          `http://${host}/docs/page`,
          () =>
            new HttpResponse(`<html><body><h1>Page</h1><p>${prose}</p></body></html>`, {
              status: 200,
              headers: { 'Content-Type': 'text/html' },
            }),
        ),
      );

      const check = getCheck('page-size-markdown')!;
      const result = await check.run(ctx);
      // Should not crash — either skips or runs in standalone mode
      expect(['pass', 'warn', 'fail', 'skip']).toContain(result.status);
    });
  });

  describe('checks with soft dependencies (no dependsOn but reads previousResults)', () => {
    it('section-header-quality skips cleanly without tabbed-content-serialization', async () => {
      const host = 'contract-shq.local';
      const ctx = makeCtx(host);
      // No tabbed-content-serialization in previousResults

      const check = getCheck('section-header-quality')!;
      const result = await check.run(ctx);
      expect(result.status).toBe('skip');
      expect(result.message).toContain('tabbed-content-serialization');
    });

    it('auth-alternative-access skips cleanly without auth-gate-detection', async () => {
      const host = 'contract-aaa.local';
      const ctx = makeCtx(host);
      // No auth-gate-detection in previousResults

      const check = getCheck('auth-alternative-access')!;
      const result = await check.run(ctx);
      expect(result.status).toBe('skip');
    });

    it('auth-alternative-access skips when auth-gate-detection passed', async () => {
      const host = 'contract-aaa-pass.local';
      const ctx = makeCtx(host);
      ctx.previousResults.set('auth-gate-detection', {
        id: 'auth-gate-detection',
        category: 'authentication',
        status: 'pass',
        message: 'All accessible',
      });

      const check = getCheck('auth-alternative-access')!;
      const result = await check.run(ctx);
      expect(result.status).toBe('skip');
      expect(result.message).toContain('publicly accessible');
    });

    it('tabbed-content-serialization works without rendering-strategy', async () => {
      const host = 'contract-tcs.local';
      const llms = `# Docs\n## Links\n- [Page](http://${host}/docs/page): Page\n`;
      const ctx = makeCtx(host, { llmsTxt: llms });
      // No rendering-strategy in previousResults

      server.use(
        http.get(
          `http://${host}/docs/page`,
          () =>
            new HttpResponse(`<html><body><h1>Page</h1><p>${prose}</p></body></html>`, {
              status: 200,
              headers: { 'Content-Type': 'text/html' },
            }),
        ),
        http.head(`http://${host}/docs/page`, () => new HttpResponse(null, { status: 200 })),
      );

      const check = getCheck('tabbed-content-serialization')!;
      const result = await check.run(ctx);
      // Should run and not crash — just won't try SPA fallback
      expect(['pass', 'warn', 'fail']).toContain(result.status);
    });

    it('cache-header-hygiene works without llms-txt-exists', async () => {
      const host = 'contract-chh.local';
      const ctx = createContext(`http://${host}`, { requestDelay: 0 });
      // No llms-txt-exists in previousResults, no llms.txt

      mockSitemapNotFound(server, `http://${host}`);
      server.use(
        http.get(`http://${host}/llms.txt`, () => new HttpResponse(null, { status: 404 })),
        http.get(`http://${host}/docs/llms.txt`, () => new HttpResponse(null, { status: 404 })),
        http.get(`http://${host}/robots.txt`, () => new HttpResponse('', { status: 404 })),
        http.get(`http://${host}/sitemap.xml`, () => new HttpResponse('', { status: 404 })),
        http.get(
          `http://${host}/`,
          () =>
            new HttpResponse(
              `<html><body><h1>Home</h1><a href="http://${host}/docs/page">Page</a></body></html>`,
              {
                status: 200,
                headers: { 'Content-Type': 'text/html', 'Cache-Control': 'max-age=300' },
              },
            ),
        ),
        http.get(
          `http://${host}/docs/page`,
          () =>
            new HttpResponse(`<html><body><h1>Page</h1><p>${prose}</p></body></html>`, {
              status: 200,
              headers: { 'Content-Type': 'text/html', 'Cache-Control': 'max-age=300' },
            }),
        ),
        http.get(`http://${host}/docs/page.md`, () => new HttpResponse(null, { status: 404 })),
        http.get(
          `http://${host}/docs/page/index.md`,
          () => new HttpResponse(null, { status: 404 }),
        ),
      );

      const check = getCheck('cache-header-hygiene')!;
      const result = await check.run(ctx);
      // Should run without crashing; won't include llms.txt URL in endpoints
      expect(['pass', 'warn', 'fail']).toContain(result.status);
    });

    it('llms-txt-directive-md works without cached markdown (fetches independently)', async () => {
      const host = 'contract-ldm.local';
      const llms = `# Docs\n## Links\n- [Page](http://${host}/docs/page): Page\n`;
      const ctx = makeCtx(host, { llmsTxt: llms });
      // No markdown-url-support or content-negotiation in previousResults
      // No pageCache entries

      server.use(
        http.get(
          `http://${host}/docs/page.md`,
          () =>
            new HttpResponse('> See [llms.txt](/llms.txt) for the docs.\n\n# Page\n\nContent.', {
              status: 200,
              headers: { 'Content-Type': 'text/markdown' },
            }),
        ),
        http.get(
          `http://${host}/docs/page/index.md`,
          () => new HttpResponse(null, { status: 404 }),
        ),
        http.get(
          `http://${host}/docs/page`,
          () =>
            new HttpResponse(`<html><body><p>${prose}</p></body></html>`, {
              status: 200,
              headers: { 'Content-Type': 'text/html' },
            }),
        ),
      );

      const check = getCheck('llms-txt-directive-md')!;
      const result = await check.run(ctx);
      // Should find directive via .md URL fetch (standalone mode)
      expect(result.status).toBe('pass');
      expect(result.details?.foundCount).toBe(1);
    });
  });
});

describe('cross-check field contracts: empty/missing upstream details', () => {
  it('page-size-markdown handles mdUrlResult with no details', async () => {
    const host = 'contract-psm-empty.local';
    const llms = `# Docs\n## Links\n- [Page](http://${host}/docs/page): Page\n`;
    const ctx = makeCtx(host, { llmsTxt: llms });

    // markdown-url-support exists but with no details at all
    ctx.previousResults.set('markdown-url-support', {
      id: 'markdown-url-support',
      category: 'markdown-availability',
      status: 'pass',
      message: 'OK',
      // No details field
    });
    // Populate pageCache so the check has content
    ctx.pageCache.set(`http://${host}/docs/page`, {
      url: `http://${host}/docs/page`,
      markdown: { content: '# Page\n\nContent.', source: 'md-url' },
    });

    const check = getCheck('page-size-markdown')!;
    const result = await check.run(ctx);
    // Should not crash — mdUrlMap will be empty, falling back to page.url
    expect(['pass', 'warn', 'fail']).toContain(result.status);
    const pageResults = result.details?.pageResults as Array<{ url: string; mdUrl: string }>;
    expect(pageResults).toBeDefined();
    // Without mdUrlResult details, mdUrl falls back to the page URL
    expect(pageResults[0].mdUrl).toBe(`http://${host}/docs/page`);
  });

  it('page-size-markdown handles mdUrlResult with empty pageResults', async () => {
    const host = 'contract-psm-empty2.local';
    const llms = `# Docs\n## Links\n- [Page](http://${host}/docs/page): Page\n`;
    const ctx = makeCtx(host, { llmsTxt: llms });

    ctx.previousResults.set('markdown-url-support', {
      id: 'markdown-url-support',
      category: 'markdown-availability',
      status: 'pass',
      message: 'OK',
      details: { pageResults: [] },
    });
    ctx.pageCache.set(`http://${host}/docs/page`, {
      url: `http://${host}/docs/page`,
      markdown: { content: '# Page\n\nContent.', source: 'md-url' },
    });

    const check = getCheck('page-size-markdown')!;
    const result = await check.run(ctx);
    expect(['pass', 'warn', 'fail']).toContain(result.status);
  });

  it('section-header-quality handles tabbed-content-serialization with empty tabbedPages', async () => {
    const host = 'contract-shq-empty.local';
    const ctx = makeCtx(host);

    ctx.previousResults.set('tabbed-content-serialization', {
      id: 'tabbed-content-serialization',
      category: 'content-structure',
      status: 'pass',
      message: 'No tabs',
      details: { tabbedPages: [] },
    });

    const check = getCheck('section-header-quality')!;
    const result = await check.run(ctx);
    expect(result.status).toBe('pass');
    expect(result.message).toContain('No tabbed content');
  });

  it('section-header-quality handles tabbed-content-serialization with no details', async () => {
    const host = 'contract-shq-nodet.local';
    const ctx = makeCtx(host);

    ctx.previousResults.set('tabbed-content-serialization', {
      id: 'tabbed-content-serialization',
      category: 'content-structure',
      status: 'pass',
      message: 'No tabs',
    });

    const check = getCheck('section-header-quality')!;
    const result = await check.run(ctx);
    expect(result.status).toBe('pass');
  });

  it('auth-alternative-access handles auth-gate-detection with empty details', async () => {
    const host = 'contract-aaa-empty.local';
    const ctx = makeCtx(host);

    ctx.previousResults.set('auth-gate-detection', {
      id: 'auth-gate-detection',
      category: 'authentication',
      status: 'fail',
      message: 'Auth required',
      // Empty details — all numeric fields default to 0 via ?? operator
      details: {},
    });

    const check = getCheck('auth-alternative-access')!;
    const result = await check.run(ctx);
    // Should not crash — gatedCount/accessibleCount default to 0
    expect(['pass', 'warn', 'fail']).toContain(result.status);
  });

  it('auth-alternative-access handles missing llms-txt-exists and markdown results', async () => {
    const host = 'contract-aaa-nodeps.local';
    const ctx = makeCtx(host);

    ctx.previousResults.set('auth-gate-detection', {
      id: 'auth-gate-detection',
      category: 'authentication',
      status: 'fail',
      message: 'Auth required',
      details: {
        accessible: 0,
        authRequired: 5,
        softAuthGate: 0,
        authRedirect: 0,
        testedPages: 5,
      },
    });
    // No llms-txt-exists, no markdown-url-support, no content-negotiation

    const check = getCheck('auth-alternative-access')!;
    const result = await check.run(ctx);
    // Should return fail (no alternative paths found)
    expect(result.status).toBe('fail');
  });

  it('cache-header-hygiene handles llms-txt-exists with no discoveredFiles', async () => {
    const host = 'contract-chh-nofiles.local';
    const ctx = createContext(`http://${host}`, { requestDelay: 0 });

    ctx.previousResults.set('llms-txt-exists', {
      id: 'llms-txt-exists',
      category: 'content-discoverability',
      status: 'pass',
      message: 'Found',
      details: { discoveredFiles: [] },
    });

    mockSitemapNotFound(server, `http://${host}`);
    server.use(
      http.get(`http://${host}/llms.txt`, () => new HttpResponse(null, { status: 404 })),
      http.get(`http://${host}/docs/llms.txt`, () => new HttpResponse(null, { status: 404 })),
      http.get(`http://${host}/robots.txt`, () => new HttpResponse('', { status: 404 })),
      http.get(`http://${host}/sitemap.xml`, () => new HttpResponse('', { status: 404 })),
      http.get(
        `http://${host}/`,
        () =>
          new HttpResponse(
            `<html><body><h1>Home</h1><a href="http://${host}/docs/page">Page</a></body></html>`,
            {
              status: 200,
              headers: { 'Content-Type': 'text/html', 'Cache-Control': 'max-age=300' },
            },
          ),
      ),
      http.get(
        `http://${host}/docs/page`,
        () =>
          new HttpResponse(`<html><body><p>${prose}</p></body></html>`, {
            status: 200,
            headers: { 'Content-Type': 'text/html', 'Cache-Control': 'max-age=300' },
          }),
      ),
      http.get(`http://${host}/docs/page.md`, () => new HttpResponse(null, { status: 404 })),
      http.get(`http://${host}/docs/page/index.md`, () => new HttpResponse(null, { status: 404 })),
    );

    const check = getCheck('cache-header-hygiene')!;
    const result = await check.run(ctx);
    // Should work fine — just fewer endpoints to test
    expect(['pass', 'warn', 'fail']).toContain(result.status);
  });
});
