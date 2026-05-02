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

describe('page-size-html', () => {
  const check = getCheck('page-size-html')!;

  function makeCtx(content?: string, opts?: Record<string, unknown>) {
    const ctx = createContext('http://test.local', { requestDelay: 0, ...opts });

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

  it('passes when HTML converts to small markdown', async () => {
    server.use(
      http.get(
        'http://test.local/docs/page1',
        () =>
          new HttpResponse('<html><body><h1>Hello</h1><p>Short page.</p></body></html>', {
            status: 200,
            headers: { 'Content-Type': 'text/html' },
          }),
      ),
    );

    const content = `# Docs\n> Summary\n## Links\n- [Page 1](http://test.local/docs/page1): First\n`;
    const result = await check.run(makeCtx(content));
    expect(result.status).toBe('pass');
    expect(result.details?.testedPages).toBe(1);
    const pageResults = result.details?.pageResults as Array<{
      htmlCharacters: number;
      convertedCharacters: number;
    }>;
    expect(pageResults[0].htmlCharacters).toBeGreaterThan(0);
    expect(pageResults[0].convertedCharacters).toBeLessThan(pageResults[0].htmlCharacters);
  });

  it('fails when converted markdown exceeds threshold', async () => {
    const bigContent = '<p>' + 'x'.repeat(200) + '</p>';
    server.use(
      http.get(
        'http://test.local/docs/page1',
        () =>
          new HttpResponse(`<html><body>${bigContent}</body></html>`, {
            status: 200,
            headers: { 'Content-Type': 'text/html' },
          }),
      ),
    );

    const content = `# Docs\n> Summary\n## Links\n- [Page 1](http://test.local/docs/page1): First\n`;
    const ctx = createContext('http://test.local', {
      requestDelay: 0,
      thresholds: { pass: 10, fail: 50 },
    });
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
    expect(result.status).toBe('fail');
    expect(result.details?.failBucket).toBeGreaterThan(0);
  });

  it('reports conversion ratio (boilerplate percentage)', async () => {
    const html = `<html><head><style>body { color: red; }</style></head><body><h1>Title</h1></body></html>`;
    server.use(
      http.get(
        'http://test.local/docs/page1',
        () =>
          new HttpResponse(html, {
            status: 200,
            headers: { 'Content-Type': 'text/html' },
          }),
      ),
    );

    const content = `# Docs\n> Summary\n## Links\n- [Page 1](http://test.local/docs/page1): First\n`;
    const result = await check.run(makeCtx(content));
    const pageResults = result.details?.pageResults as Array<{
      conversionRatio: number;
    }>;
    expect(pageResults[0].conversionRatio).toBeGreaterThan(0);
    expect(result.details?.avgBoilerplatePercent).toBeGreaterThan(0);
  });

  it('handles fetch errors gracefully', async () => {
    server.use(http.get('http://test.local/docs/page1', () => HttpResponse.error()));

    const content = `# Docs\n> Summary\n## Links\n- [Page 1](http://test.local/docs/page1): First\n`;
    const result = await check.run(makeCtx(content));
    expect(result.status).toBe('fail');
    expect(result.details?.fetchErrors).toBe(1);
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
            new HttpResponse(`<html><body><h1>Page ${i}</h1></body></html>`, {
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
    expect(result.details?.totalPages).toBe(5);
    expect(result.details?.testedPages).toBe(2);
    expect(result.details?.sampled).toBe(true);
  });

  it('skips Turndown conversion when response is already markdown', async () => {
    const markdownContent =
      '# API Guide\n\nThis is a markdown page about the `<head>` element.\n\nMore content here.';
    server.use(
      http.get(
        'http://test.local/docs/page1',
        () =>
          new HttpResponse(markdownContent, {
            status: 200,
            headers: { 'Content-Type': 'text/markdown; charset=utf-8' },
          }),
      ),
    );

    const content = `# Docs\n> Summary\n## Links\n- [Page 1](http://test.local/docs/page1): First\n`;
    const result = await check.run(makeCtx(content));
    expect(result.status).toBe('pass');
    const pageResults = result.details?.pageResults as Array<{
      htmlCharacters: number;
      convertedCharacters: number;
    }>;
    // When response is markdown, htmlCharacters should be 0 and converted = raw length
    expect(pageResults[0].htmlCharacters).toBe(0);
    expect(pageResults[0].convertedCharacters).toBe(markdownContent.length);
  });

  it('skips Turndown conversion when response is text/plain', async () => {
    const markdownContent = '# Checkout Guide\n\nSet up `<head>` tags in your HTML page.\n';
    server.use(
      http.get(
        'http://test.local/docs/page1',
        () =>
          new HttpResponse(markdownContent, {
            status: 200,
            headers: { 'Content-Type': 'text/plain; charset=utf-8' },
          }),
      ),
    );

    const content = `# Docs\n> Summary\n## Links\n- [Page 1](http://test.local/docs/page1): First\n`;
    const result = await check.run(makeCtx(content));
    const pageResults = result.details?.pageResults as Array<{
      htmlCharacters: number;
      convertedCharacters: number;
    }>;
    expect(pageResults[0].htmlCharacters).toBe(0);
    expect(pageResults[0].convertedCharacters).toBe(markdownContent.length);
  });

  it('warns when converted size is between thresholds', async () => {
    // Create HTML that converts to ~25 chars (between pass=10 and fail=50)
    server.use(
      http.get(
        'http://test.local/docs/page1',
        () =>
          new HttpResponse('<html><body><p>Some medium length content here.</p></body></html>', {
            status: 200,
            headers: { 'Content-Type': 'text/html' },
          }),
      ),
    );

    const content = `# Docs\n> Summary\n## Links\n- [Page 1](http://test.local/docs/page1): First\n`;
    const ctx = createContext('http://test.local', {
      requestDelay: 0,
      thresholds: { pass: 10, fail: 50 },
    });
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
    expect(result.status).toBe('warn');
    expect(result.details?.warnBucket).toBe(1);
  });

  it('uses looksLikeHtml fallback when content-type is ambiguous', async () => {
    // Response with no standard content-type but body is clearly HTML
    server.use(
      http.get(
        'http://test.local/docs/page1',
        () =>
          new HttpResponse(
            '<!DOCTYPE html><html><body><h1>Detected</h1><p>HTML content.</p></body></html>',
            {
              status: 200,
              headers: { 'Content-Type': 'application/octet-stream' },
            },
          ),
      ),
    );

    const content = `# Docs\n> Summary\n## Links\n- [Page 1](http://test.local/docs/page1): First\n`;
    const result = await check.run(makeCtx(content));
    const pageResults = result.details?.pageResults as Array<{
      htmlCharacters: number;
      convertedCharacters: number;
    }>;
    // Should have detected as HTML and converted
    expect(pageResults[0].htmlCharacters).toBeGreaterThan(0);
    expect(pageResults[0].convertedCharacters).toBeLessThan(pageResults[0].htmlCharacters);
  });

  it('includes fetch error count in message suffix', async () => {
    server.use(
      http.get(
        'http://test.local/docs/good',
        () =>
          new HttpResponse('<html><body><h1>OK</h1></body></html>', {
            status: 200,
            headers: { 'Content-Type': 'text/html' },
          }),
      ),
      http.get('http://test.local/docs/broken', () => HttpResponse.error()),
    );

    const content = `# Docs\n> Summary\n## Links
- [Good](http://test.local/docs/good): OK
- [Broken](http://test.local/docs/broken): Broken
`;
    const result = await check.run(makeCtx(content));
    expect(result.details?.fetchErrors).toBe(1);
    expect(result.message).toContain('failed to fetch');
  });

  it('falls back to baseUrl when no llms.txt', async () => {
    mockSitemapNotFound(server, 'http://ps-html-fb.local');
    server.use(
      http.get(
        'http://ps-html-fb.local/llms.txt',
        () => new HttpResponse('Not found', { status: 404 }),
      ),
      http.get(
        'http://ps-html-fb.local/docs/llms.txt',
        () => new HttpResponse('Not found', { status: 404 }),
      ),
      http.get('http://ps-html-fb.local/robots.txt', () => new HttpResponse('', { status: 404 })),
      http.get(
        'http://ps-html-fb.local/sitemap.xml',
        () => new HttpResponse('Not Found', { status: 404 }),
      ),
      http.get(
        'http://ps-html-fb.local',
        () =>
          new HttpResponse('<!DOCTYPE html><html><body><h1>Home</h1></body></html>', {
            status: 200,
            headers: { 'Content-Type': 'text/html' },
          }),
      ),
    );

    const ctx = createContext('http://ps-html-fb.local', { requestDelay: 0 });
    const result = await check.run(ctx);
    expect(result.details?.testedPages).toBe(1);
    expect(result.status).toBe('pass');
  });
});
