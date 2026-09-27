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

describe('content-negotiation', () => {
  const check = getCheck('content-negotiation')!;

  function makeCtx(content?: string) {
    const ctx = createContext('http://test.local', { requestDelay: 0 });

    if (content) {
      const discovered: DiscoveredFile[] = [
        { url: 'http://test.local/llms.txt', content, status: 200, redirected: false },
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

    return ctx;
  }

  it('passes when server returns markdown with correct Content-Type', async () => {
    server.use(
      http.get(
        'http://test.local/docs/page1',
        () =>
          new HttpResponse('# Page 1\n\nContent here.', {
            status: 200,
            headers: { 'Content-Type': 'text/markdown; charset=utf-8' },
          }),
      ),
      http.get(
        'http://test.local/docs/page2',
        () =>
          new HttpResponse('# Page 2\n\n[Link](http://example.com)', {
            status: 200,
            headers: { 'Content-Type': 'text/markdown' },
          }),
      ),
    );

    const content = `# Docs
> Summary
## Links
- [Page 1](http://test.local/docs/page1): First
- [Page 2](http://test.local/docs/page2): Second
`;
    const result = await check.run(makeCtx(content));
    expect(result.status).toBe('pass');
    expect(result.details?.negotiationRate).toBe(100);
  });

  it('warns when server returns markdown but with wrong Content-Type', async () => {
    server.use(
      http.get(
        'http://test.local/docs/page1',
        () =>
          new HttpResponse('# Page 1\n\nMarkdown content [link](http://example.com)', {
            status: 200,
            headers: { 'Content-Type': 'text/html; charset=utf-8' },
          }),
      ),
    );

    const content = `# Docs
> Summary
## Links
- [Page 1](http://test.local/docs/page1): First
`;
    const result = await check.run(makeCtx(content));
    expect(result.status).toBe('warn');
    expect(result.details?.markdownWithWrongType).toBe(1);
  });

  it('fails when server returns HTML regardless of Accept header', async () => {
    server.use(
      http.get(
        'http://test.local/docs/page1',
        () =>
          new HttpResponse('<!DOCTYPE html><html><body><h1>Page 1</h1></body></html>', {
            status: 200,
            headers: { 'Content-Type': 'text/html' },
          }),
      ),
      http.get(
        'http://test.local/docs/page2',
        () =>
          new HttpResponse('<html><body>Page 2</body></html>', {
            status: 200,
            headers: { 'Content-Type': 'text/html' },
          }),
      ),
    );

    const content = `# Docs
> Summary
## Links
- [Page 1](http://test.local/docs/page1): First
- [Page 2](http://test.local/docs/page2): Second
`;
    const result = await check.run(makeCtx(content));
    expect(result.status).toBe('fail');
    expect(result.details?.htmlOnly).toBe(2);
  });

  it('handles mixed results across pages', async () => {
    server.use(
      http.get(
        'http://test.local/docs/page1',
        () =>
          new HttpResponse('# Page 1\n\nGood markdown.', {
            status: 200,
            headers: { 'Content-Type': 'text/markdown' },
          }),
      ),
      http.get(
        'http://test.local/docs/page2',
        () =>
          new HttpResponse('<!DOCTYPE html><html><body>HTML page</body></html>', {
            status: 200,
            headers: { 'Content-Type': 'text/html' },
          }),
      ),
    );

    const content = `# Docs
> Summary
## Links
- [Page 1](http://test.local/docs/page1): First
- [Page 2](http://test.local/docs/page2): Second
`;
    const result = await check.run(makeCtx(content));
    expect(result.status).toBe('warn');
    expect(result.details?.markdownWithCorrectType).toBe(1);
    expect(result.details?.htmlOnly).toBe(1);
  });

  it('samples when more links than maxLinksToTest', async () => {
    const links = Array.from(
      { length: 5 },
      (_, i) => `- [Page ${i}](http://test.local/docs/page${i}): Page ${i}`,
    ).join('\n');

    for (let i = 0; i < 5; i++) {
      server.use(
        http.get(
          `http://test.local/docs/page${i}`,
          () =>
            new HttpResponse(`# Page ${i}\n\nContent`, {
              status: 200,
              headers: { 'Content-Type': 'text/markdown' },
            }),
        ),
      );
    }

    const content = `# Docs\n> Summary\n## Links\n${links}\n`;
    const ctx = createContext('http://test.local', { requestDelay: 0, maxLinksToTest: 2 });
    const discovered: DiscoveredFile[] = [
      { url: 'http://test.local/llms.txt', content, status: 200, redirected: false },
    ];
    ctx.previousResults.set('llms-txt-exists', {
      id: 'llms-txt-exists',
      category: 'content-discoverability',
      status: 'pass',
      message: 'Found',
      details: { discoveredFiles: discovered },
    });
    mockSitemapNotFound(server, 'http://test.local');

    const result = await check.run(ctx);
    expect(result.details?.totalPages).toBe(5);
    expect(result.details?.testedPages).toBe(2);
    expect(result.details?.sampled).toBe(true);
  });

  it('handles fetch errors gracefully and reports error field', async () => {
    server.use(http.get('http://test.local/docs/page', () => HttpResponse.error()));

    const content = `# Docs\n> Summary\n## Links\n- [Page](http://test.local/docs/page): A page\n`;
    const result = await check.run(makeCtx(content));
    expect(result.status).toBe('fail');
    const pageResults = result.details?.pageResults as Array<{
      status: number;
      classification: string;
      error?: string;
    }>;
    expect(pageResults[0].status).toBe(0);
    expect(pageResults[0].classification).toBe('html');
    expect(pageResults[0].error).toBeDefined();
    expect(result.details?.fetchErrors).toBe(1);
    expect(result.message).toContain('failed to fetch');
  });

  it('reports rate-limited results (HTTP 429)', async () => {
    server.use(
      http.get(
        'http://test.local/docs/page',
        () => new HttpResponse('Too Many Requests', { status: 429 }),
      ),
    );

    const content = `# Docs\n> Summary\n## Links\n- [Page](http://test.local/docs/page): A page\n`;
    const result = await check.run(makeCtx(content));
    expect(result.details?.rateLimited).toBe(1);
    expect(result.message).toContain('rate-limited (HTTP 429)');
  });

  it('includes "sampled" in message when results are sampled', async () => {
    const links = Array.from(
      { length: 5 },
      (_, i) => `- [Page ${i}](http://test.local/docs/page${i}): Page ${i}`,
    ).join('\n');

    for (let i = 0; i < 5; i++) {
      server.use(
        http.get(
          `http://test.local/docs/page${i}`,
          () =>
            new HttpResponse('<!DOCTYPE html><html><body>HTML</body></html>', {
              status: 200,
              headers: { 'Content-Type': 'text/html' },
            }),
        ),
      );
    }

    const content = `# Docs\n> Summary\n## Links\n${links}\n`;
    const ctx = createContext('http://test.local', { requestDelay: 0, maxLinksToTest: 2 });
    const discovered: DiscoveredFile[] = [
      { url: 'http://test.local/llms.txt', content, status: 200, redirected: false },
    ];
    ctx.previousResults.set('llms-txt-exists', {
      id: 'llms-txt-exists',
      category: 'content-discoverability',
      status: 'pass',
      message: 'Found',
      details: { discoveredFiles: discovered },
    });
    mockSitemapNotFound(server, 'http://test.local');

    const result = await check.run(ctx);
    expect(result.details?.sampled).toBe(true);
    expect(result.message).toContain('sampled pages');
  });

  it('caches the fetched URL and Link header with the markdown', async () => {
    server.use(
      http.get(
        'http://test.local/docs/page',
        () =>
          new HttpResponse('# Page\n\nContent negotiated.', {
            status: 200,
            headers: {
              'Content-Type': 'text/markdown',
              Link: '</docs/page?page=2>; rel="next"',
            },
          }),
      ),
    );

    const content = `# Docs\n> Summary\n## Links\n- [Page](http://test.local/docs/page): A page\n`;
    const ctx = makeCtx(content);
    await check.run(ctx);
    const cached = ctx.pageCache.get('http://test.local/docs/page');
    expect(cached?.markdown).toEqual({
      content: '# Page\n\nContent negotiated.',
      source: 'content-negotiation',
      mdUrl: 'http://test.local/docs/page',
      linkHeader: '</docs/page?page=2>; rel="next"',
    });
  });

  it('does not overwrite pageCache when already populated', async () => {
    server.use(
      http.get(
        'http://test.local/docs/page',
        () =>
          new HttpResponse('# Page\n\nContent negotiated.', {
            status: 200,
            headers: { 'Content-Type': 'text/markdown' },
          }),
      ),
    );

    const content = `# Docs\n> Summary\n## Links\n- [Page](http://test.local/docs/page): A page\n`;
    const ctx = makeCtx(content);
    // Pre-populate the cache as if markdown-url-support already ran
    ctx.pageCache.set('http://test.local/docs/page', {
      url: 'http://test.local/docs/page',
      markdown: { content: '# From md-url', source: 'md-url' },
    });

    await check.run(ctx);
    const cached = ctx.pageCache.get('http://test.local/docs/page');
    expect(cached?.markdown?.source).toBe('md-url');
    expect(cached?.markdown?.content).toBe('# From md-url');
  });

  it('rejects markdown-formatted error pages as soft-404 (#29)', async () => {
    server.use(
      http.get(
        'http://test.local/docs/page1',
        () =>
          new HttpResponse(
            '# Page Not Found\n\nThe URL `/docs/page1` does not exist.\n\n## How to find the correct page\n',
            {
              status: 200,
              headers: { 'Content-Type': 'text/markdown' },
            },
          ),
      ),
    );

    const content = `# Docs\n> Summary\n## Links\n- [Page 1](http://test.local/docs/page1): First\n`;
    const ctx = makeCtx(content);
    const result = await check.run(ctx);

    expect(result.status).toBe('fail');
    expect(result.details?.softErrorPages).toBe(1);
    expect(result.details?.markdownWithCorrectType).toBe(0);

    // Soft-404 content must not poison the page cache
    expect(ctx.pageCache.has('http://test.local/docs/page1')).toBe(false);
  });

  it('rejects error pages even with 200 status and correct content type (#29)', async () => {
    server.use(
      http.get(
        'http://test.local/docs/page1',
        () =>
          new HttpResponse('# Page 1\n\nReal content here.', {
            status: 200,
            headers: { 'Content-Type': 'text/markdown' },
          }),
      ),
      http.get(
        'http://test.local/docs/page2',
        () =>
          new HttpResponse('# 404\n\nThis page could not be found.', {
            status: 200,
            headers: { 'Content-Type': 'text/markdown' },
          }),
      ),
    );

    const content = `# Docs\n> Summary\n## Links\n- [Page 1](http://test.local/docs/page1): First\n- [Page 2](http://test.local/docs/page2): Second\n`;
    const result = await check.run(makeCtx(content));

    expect(result.status).toBe('warn');
    expect(result.details?.markdownWithCorrectType).toBe(1);
    expect(result.details?.softErrorPages).toBe(1);
    expect(result.message).toContain('returned error pages');
  });

  it('normalizes .md URLs to canonical form before testing (#33)', async () => {
    // Curated pages bypass discovery, so .md URLs reach the check directly.
    // The check should strip the extension before fetching.
    server.use(
      http.get(
        'http://test.local/docs/page1',
        () =>
          new HttpResponse('<!DOCTYPE html><html><body>HTML</body></html>', {
            status: 200,
            headers: { 'Content-Type': 'text/html' },
          }),
      ),
    );

    const ctx = createContext('http://test.local', {
      requestDelay: 0,
      samplingStrategy: 'curated',
      curatedPages: ['http://test.local/docs/page1.md'],
    });
    const result = await check.run(ctx);

    expect(result.status).toBe('fail');
    expect(result.details?.normalizedMdUrls).toBe(1);
    expect(result.message).toContain('.md URLs normalized');
    // The canonical URL got HTML back, so no content negotiation support
    expect(result.details?.markdownWithCorrectType).toBe(0);
  });

  it('reports testedUrl when .md URL is normalized (#33)', async () => {
    // Curated pages bypass discovery, so .md URLs reach the check directly.
    server.use(
      http.get(
        'http://test.local/docs/page1',
        () =>
          new HttpResponse('# Page 1\n\nContent.', {
            status: 200,
            headers: { 'Content-Type': 'text/markdown' },
          }),
      ),
    );

    const ctx = createContext('http://test.local', {
      requestDelay: 0,
      samplingStrategy: 'curated',
      curatedPages: ['http://test.local/docs/page1.md'],
    });
    const result = await check.run(ctx);

    const pageResults = result.details?.pageResults as Array<{
      url: string;
      testedUrl?: string;
    }>;
    expect(pageResults[0].url).toBe('http://test.local/docs/page1.md');
    expect(pageResults[0].testedUrl).toBe('http://test.local/docs/page1');
  });

  it('classifies as correct type when content-type is text/markdown and body is plain text', async () => {
    // Body is not markdown-like and not HTML → still classified as correct type
    // because the server declared text/markdown and the body isn't HTML
    server.use(
      http.get(
        'http://test.local/docs/page1',
        () =>
          new HttpResponse('Just some plain text content without any markdown formatting.', {
            status: 200,
            headers: { 'Content-Type': 'text/markdown' },
          }),
      ),
    );

    const content = `# Docs\n> Summary\n## Links\n- [Page 1](http://test.local/docs/page1): First\n`;
    const result = await check.run(makeCtx(content));
    expect(result.details?.markdownWithCorrectType).toBe(1);
  });

  it('handles missing content-type header', async () => {
    server.use(
      http.get(
        'http://test.local/docs/page1',
        () => new HttpResponse('# Some markdown', { status: 200 }),
      ),
    );

    const content = `# Docs\n> Summary\n## Links\n- [Page 1](http://test.local/docs/page1): First\n`;
    const result = await check.run(makeCtx(content));
    // No content-type → not text/markdown → classified as wrong-type (body looks like markdown)
    expect(result.details?.markdownWithWrongType).toBe(1);
  });

  it('does not overwrite pageCache for markdown-with-wrong-type', async () => {
    server.use(
      http.get(
        'http://test.local/docs/page',
        () =>
          new HttpResponse('# Page\n\nMarkdown content [link](http://example.com)', {
            status: 200,
            headers: { 'Content-Type': 'text/html; charset=utf-8' },
          }),
      ),
    );

    const content = `# Docs\n> Summary\n## Links\n- [Page](http://test.local/docs/page): A page\n`;
    const ctx = makeCtx(content);
    ctx.pageCache.set('http://test.local/docs/page', {
      url: 'http://test.local/docs/page',
      markdown: { content: '# From md-url', source: 'md-url' },
    });

    await check.run(ctx);
    const cached = ctx.pageCache.get('http://test.local/docs/page');
    expect(cached?.markdown?.source).toBe('md-url');
  });

  it('skips non-page file types (e.g. .json, .xml)', async () => {
    const content = `# Docs\n> Summary\n## Links\n- [Schema](http://test.local/api/schema.json): API schema\n`;
    const result = await check.run(makeCtx(content));

    expect(result.details?.skippedPages).toBe(1);
    expect(result.details?.testedPages).toBe(0);
    const pageResults = result.details?.pageResults as Array<{ skipped?: boolean }>;
    expect(pageResults[0].skipped).toBe(true);
  });

  it('falls back to baseUrl when no llms.txt', async () => {
    server.use(
      http.get('http://test.local/robots.txt', () => new HttpResponse('', { status: 404 })),
      http.get(
        'http://test.local/sitemap.xml',
        () => new HttpResponse('Not Found', { status: 404 }),
      ),
      http.get(
        'http://test.local',
        () =>
          new HttpResponse('<!DOCTYPE html><html><body>Home</body></html>', {
            status: 200,
            headers: { 'Content-Type': 'text/html' },
          }),
      ),
    );

    const ctx = makeCtx();
    const result = await check.run(ctx);
    expect(result.details?.testedPages).toBe(1);
    expect(result.status).toBe('fail');
  });
});
