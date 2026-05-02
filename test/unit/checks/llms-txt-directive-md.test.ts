import { describe, it, expect, beforeAll } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { createContext } from '../../../src/runner.js';
import { getCheck } from '../../../src/checks/registry.js';
import '../../../src/checks/index.js';
import type { DiscoveredFile } from '../../../src/types.js';
import { mockSitemapNotFound } from '../../helpers/mock-sitemap-not-found.js';

const server = setupServer();

beforeAll(() => {
  server.listen({ onUnhandledRequest: 'bypass' });
  return () => server.close();
});

describe('llms-txt-directive-md', () => {
  const check = getCheck('llms-txt-directive-md')!;

  function makeCtx(llmsTxtContent?: string) {
    const ctx = createContext('http://test.local', { requestDelay: 0 });

    if (llmsTxtContent) {
      const discovered: DiscoveredFile[] = [
        {
          url: 'http://test.local/llms.txt',
          content: llmsTxtContent,
          status: 200,
          redirected: false,
        },
      ];
      ctx.previousResults.set('llms-txt-exists', {
        id: 'llms-txt-exists',
        category: 'content-discoverability',
        status: 'pass',
        message: 'Found',
        details: { discoveredFiles: discovered },
      });
      mockSitemapNotFound(server, 'http://test.local');
    } else {
      ctx.previousResults.set('llms-txt-exists', {
        id: 'llms-txt-exists',
        category: 'content-discoverability',
        status: 'fail',
        message: 'No llms.txt found',
        details: { discoveredFiles: [] },
      });
    }

    // Set markdown-url-support as passing so the dependency is satisfied
    ctx.previousResults.set('markdown-url-support', {
      id: 'markdown-url-support',
      category: 'markdown-availability',
      status: 'pass',
      message: 'Markdown supported',
    });

    return ctx;
  }

  const llms = (...pages: string[]) =>
    `# Docs\n## Links\n${pages.map((p, i) => `- [Page ${i + 1}](http://test.local${p}): Page\n`).join('')}`;

  it('passes when directive found in cached markdown content', async () => {
    const padding = '\n\nLorem ipsum dolor sit amet. '.repeat(20);
    const ctx = makeCtx(llms('/docs/page1'));
    // Simulate content cached by markdown-url-support check
    ctx.pageCache.set('http://test.local/docs/page1', {
      url: 'http://test.local/docs/page1',
      markdown: {
        content: `> See [llms.txt](/llms.txt) for the documentation index.\n\n# Welcome${padding}`,
        source: 'md-url',
      },
    });

    const result = await check.run(ctx);
    expect(result.status).toBe('pass');
    expect(result.details?.foundCount).toBe(1);
    expect(result.details?.nearTopCount).toBe(1);
  });

  it('passes when directive found via .md URL fetch', async () => {
    server.use(
      http.get(
        'http://test.local/docs/page1.md',
        () =>
          new HttpResponse(
            '> For AI agents: see [documentation index](/llms.txt) for navigation.\n\n# Welcome\n\nContent here.',
            { status: 200, headers: { 'Content-Type': 'text/markdown' } },
          ),
      ),
    );

    const result = await check.run(makeCtx(llms('/docs/page1')));
    expect(result.status).toBe('pass');
    expect(result.details?.foundCount).toBe(1);
    const pages = result.details?.pageResults as Array<{ mdUrl?: string }>;
    expect(pages[0].mdUrl).toBe('http://test.local/docs/page1.md');
  });

  it('passes when directive found via index.md URL', async () => {
    server.use(
      http.get('http://test.local/docs/page1.md', () => new HttpResponse('', { status: 404 })),
      http.get(
        'http://test.local/docs/page1/index.md',
        () =>
          new HttpResponse(
            '> For AI agents: see /llms.txt for a documentation index.\n\n# Docs\n\nContent.',
            { status: 200, headers: { 'Content-Type': 'text/markdown' } },
          ),
      ),
    );

    const result = await check.run(makeCtx(llms('/docs/page1')));
    expect(result.status).toBe('pass');
    expect(result.details?.foundCount).toBe(1);
    const pages = result.details?.pageResults as Array<{ mdUrl?: string }>;
    expect(pages[0].mdUrl).toBe('http://test.local/docs/page1/index.md');
  });

  it('passes when directive found via content negotiation', async () => {
    const padding = '\n\nLorem ipsum dolor sit amet. '.repeat(20);
    server.use(
      http.get('http://test.local/docs/page1.md', () => new HttpResponse('', { status: 404 })),
      http.get(
        'http://test.local/docs/page1/index.md',
        () => new HttpResponse('', { status: 404 }),
      ),
      http.get('http://test.local/docs/page1', ({ request }) => {
        const accept = request.headers.get('accept') ?? '';
        if (accept.includes('text/markdown')) {
          return new HttpResponse(
            `> See [llms.txt](/llms.txt) for the documentation index.\n\n# Welcome${padding}`,
            { status: 200, headers: { 'Content-Type': 'text/markdown' } },
          );
        }
        return new HttpResponse('<html><body><h1>Docs</h1></body></html>', {
          status: 200,
          headers: { 'Content-Type': 'text/html' },
        });
      }),
    );

    const result = await check.run(makeCtx(llms('/docs/page1')));
    expect(result.status).toBe('pass');
    expect(result.details?.foundCount).toBe(1);
  });

  it('warns when directive is buried deep in markdown', async () => {
    const padding = 'Lorem ipsum dolor sit amet.\n\n'.repeat(200);
    server.use(
      http.get(
        'http://test.local/docs/page1.md',
        () =>
          new HttpResponse(`# Docs\n\n${padding}> See /llms.txt for the index.\n`, {
            status: 200,
            headers: { 'Content-Type': 'text/markdown' },
          }),
      ),
    );

    const result = await check.run(makeCtx(llms('/docs/page1')));
    expect(result.status).toBe('warn');
    expect(result.details?.buriedCount).toBe(1);
    expect(result.message).toContain('buried deep');
  });

  it('warns when some pages have directive and some do not', async () => {
    server.use(
      http.get(
        'http://test.local/docs/page1.md',
        () =>
          new HttpResponse('> See [llms.txt](/llms.txt)\n\n# Page 1\n\nContent.', {
            status: 200,
            headers: { 'Content-Type': 'text/markdown' },
          }),
      ),
      http.get(
        'http://test.local/docs/page2.md',
        () =>
          new HttpResponse('# Page 2\n\nNo directive here.', {
            status: 200,
            headers: { 'Content-Type': 'text/markdown' },
          }),
      ),
    );

    // Also mock index.md and content-negotiation fallbacks as 404
    server.use(
      http.get(
        'http://test.local/docs/page1/index.md',
        () => new HttpResponse('', { status: 404 }),
      ),
      http.get(
        'http://test.local/docs/page2/index.md',
        () => new HttpResponse('', { status: 404 }),
      ),
    );

    const result = await check.run(makeCtx(llms('/docs/page1', '/docs/page2')));
    expect(result.status).toBe('warn');
    expect(result.details?.foundCount).toBe(1);
    expect(result.details?.notFoundCount).toBe(1);
    expect(result.message).toContain('missing');
  });

  it('fails when no directive found in any markdown page', async () => {
    server.use(
      http.get(
        'http://test.local/docs/page1.md',
        () =>
          new HttpResponse('# Welcome\n\nNo directive.', {
            status: 200,
            headers: { 'Content-Type': 'text/markdown' },
          }),
      ),
      http.get(
        'http://test.local/docs/page1/index.md',
        () => new HttpResponse('', { status: 404 }),
      ),
    );

    const result = await check.run(makeCtx(llms('/docs/page1')));
    expect(result.status).toBe('fail');
    expect(result.details?.foundCount).toBe(0);
  });

  it('reports error when no markdown version is available', async () => {
    server.use(
      http.get('http://test.local/docs/page1.md', () => new HttpResponse('', { status: 404 })),
      http.get(
        'http://test.local/docs/page1/index.md',
        () => new HttpResponse('', { status: 404 }),
      ),
      http.get(
        'http://test.local/docs/page1',
        () =>
          new HttpResponse('<html><body><h1>Docs</h1></body></html>', {
            status: 200,
            headers: { 'Content-Type': 'text/html' },
          }),
      ),
    );

    const result = await check.run(makeCtx(llms('/docs/page1')));
    expect(result.status).toBe('fail');
    expect(result.details?.fetchErrors).toBe(1);
  });

  it('skips content negotiation when content-type is not text/markdown', async () => {
    server.use(
      http.get('http://test.local/docs/page1.md', () => new HttpResponse('', { status: 404 })),
      http.get(
        'http://test.local/docs/page1/index.md',
        () => new HttpResponse('', { status: 404 }),
      ),
      http.get(
        'http://test.local/docs/page1',
        () =>
          new HttpResponse('<html><body>llms.txt mentioned here</body></html>', {
            status: 200,
            headers: { 'Content-Type': 'text/html' },
          }),
      ),
    );

    const result = await check.run(makeCtx(llms('/docs/page1')));
    expect(result.status).toBe('fail');
    expect(result.details?.fetchErrors).toBe(1);
  });

  it('skips content negotiation when response body is empty', async () => {
    server.use(
      http.get('http://test.local/docs/page1.md', () => new HttpResponse('', { status: 404 })),
      http.get(
        'http://test.local/docs/page1/index.md',
        () => new HttpResponse('', { status: 404 }),
      ),
      http.get(
        'http://test.local/docs/page1',
        () =>
          new HttpResponse('   ', {
            status: 200,
            headers: { 'Content-Type': 'text/markdown' },
          }),
      ),
    );

    const result = await check.run(makeCtx(llms('/docs/page1')));
    expect(result.status).toBe('fail');
    expect(result.details?.fetchErrors).toBe(1);
  });

  it('skips content negotiation when response is not ok', async () => {
    server.use(
      http.get('http://test.local/docs/page1.md', () => new HttpResponse('', { status: 404 })),
      http.get(
        'http://test.local/docs/page1/index.md',
        () => new HttpResponse('', { status: 404 }),
      ),
      http.get('http://test.local/docs/page1', () => new HttpResponse('', { status: 500 })),
    );

    const result = await check.run(makeCtx(llms('/docs/page1')));
    expect(result.status).toBe('fail');
    expect(result.details?.fetchErrors).toBe(1);
  });

  it('passes without "near the top" when directive is mid-page', async () => {
    const before = 'Lorem ipsum content paragraph.\n\n'.repeat(15);
    const after = 'More documentation content here.\n\n'.repeat(80);
    server.use(
      http.get(
        'http://test.local/docs/page1.md',
        () =>
          new HttpResponse(`# Docs\n\n${before}See /llms.txt for index.\n\n${after}`, {
            status: 200,
            headers: { 'Content-Type': 'text/markdown' },
          }),
      ),
    );

    const result = await check.run(makeCtx(llms('/docs/page1')));
    expect(result.status).toBe('pass');
    expect(result.message).not.toContain('near the top');
    expect(result.message).not.toContain('buried');
  });

  it('ignores bare "llms.txt" text without path context (documentation prose)', async () => {
    server.use(
      http.get(
        'http://test.local/docs/page1.md',
        () =>
          new HttpResponse('# About llms.txt\n\nCreate an llms.txt file to help agents.', {
            status: 200,
            headers: { 'Content-Type': 'text/markdown' },
          }),
      ),
    );

    const result = await check.run(makeCtx(llms('/docs/page1')));
    expect(result.status).toBe('fail');
    expect(result.details?.foundCount).toBe(0);
  });

  it('handles curated .md pages', async () => {
    server.use(
      http.get(
        'http://test.local/docs/page1/',
        () =>
          new HttpResponse('<html><body><h1>Docs</h1></body></html>', {
            status: 200,
            headers: { 'Content-Type': 'text/html' },
          }),
      ),
      http.get(
        'http://test.local/docs/page1/index.md',
        () =>
          new HttpResponse(
            '> For AI agents: see /llms.txt for a documentation index.\n\n# Docs\n\nContent.',
            { status: 200, headers: { 'Content-Type': 'text/markdown' } },
          ),
      ),
      http.get('http://test.local/docs/page1.md', () => new HttpResponse('', { status: 404 })),
    );

    const ctx = createContext('http://test.local', {
      requestDelay: 0,
      samplingStrategy: 'curated',
      curatedPages: ['http://test.local/docs/page1/index.md'],
    });
    ctx.previousResults.set('markdown-url-support', {
      id: 'markdown-url-support',
      category: 'markdown-availability',
      status: 'pass',
      message: 'Markdown supported',
    });

    const result = await check.run(ctx);
    expect(result.status).toBe('pass');
    expect(result.details?.foundCount).toBe(1);
  });

  // Issue #77 isolation: parent-clean candidate generation lives in
  // markdown-url-support only. If it ever leaks into toMdUrls, this directive
  // check would falsely pass when an unrelated /auth.md happens to contain
  // the directive — a known false-positive class. Guard against that.
  it('does not validate directive via parent-clean .md candidate (issue #77 isolation)', async () => {
    const requestLog: string[] = [];
    server.use(
      // The page URL would be /docs/auth/index.html (HTML form). Conventional
      // .md candidates 404…
      http.get('http://test.local/docs/auth/index.md', () => {
        requestLog.push('/docs/auth/index.md');
        return new HttpResponse('Not Found', { status: 404 });
      }),
      http.get('http://test.local/docs/auth/index.html/index.md', () => {
        requestLog.push('/docs/auth/index.html/index.md');
        return new HttpResponse('Not Found', { status: 404 });
      }),
      // …but a sibling /docs/auth.md exists with the directive. The
      // directive check must NOT request this URL.
      http.get('http://test.local/docs/auth.md', () => {
        requestLog.push('/docs/auth.md');
        return new HttpResponse(
          '> For AI agents: see [documentation index](/llms.txt) for navigation.\n\n# Wrong page',
          { status: 200, headers: { 'Content-Type': 'text/markdown' } },
        );
      }),
      // Content negotiation also fails so it can't pass that way
      http.get('http://test.local/docs/auth/index.html', () => {
        requestLog.push('/docs/auth/index.html [accept]');
        return new HttpResponse('<!DOCTYPE html><html></html>', {
          status: 200,
          headers: { 'Content-Type': 'text/html' },
        });
      }),
    );

    const ctx = makeCtx(llms('/docs/auth/index.html.md'));
    const result = await check.run(ctx);
    expect(result.status).not.toBe('pass');
    expect(requestLog).not.toContain('/docs/auth.md');
  });
});
