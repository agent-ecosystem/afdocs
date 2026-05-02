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

describe('page-size-markdown', () => {
  const check = getCheck('page-size-markdown')!;

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
    }

    return ctx;
  }

  /** Mock llms.txt endpoints to return 404 for a given domain (used in standalone tests). */
  function mockNoLlmsTxt(domain: string) {
    server.use(
      http.get(`http://${domain}/llms.txt`, () => new HttpResponse('Not found', { status: 404 })),
      http.get(
        `http://${domain}/docs/llms.txt`,
        () => new HttpResponse('Not found', { status: 404 }),
      ),
    );
  }

  it('passes when cached markdown is under threshold', async () => {
    const ctx = makeCtx();
    // Simulate markdown-url-support having passed and cached content
    ctx.previousResults.set('markdown-url-support', {
      id: 'markdown-url-support',
      category: 'markdown-availability',
      status: 'pass',
      message: 'OK',
    });
    ctx.pageCache.set('http://test.local/docs/page1', {
      url: 'http://test.local/docs/page1',
      markdown: { content: '# Hello\n\nShort page.', source: 'md-url' },
    });

    const result = await check.run(ctx);
    expect(result.status).toBe('pass');
    expect(result.details?.testedPages).toBe(1);
    expect(result.details?.max).toBe(20);
  });

  it('warns when cached markdown is between thresholds', async () => {
    const ctx = createContext('http://test.local', {
      requestDelay: 0,
      thresholds: { pass: 10, fail: 30 },
    });
    ctx.previousResults.set('content-negotiation', {
      id: 'content-negotiation',
      category: 'markdown-availability',
      status: 'pass',
      message: 'OK',
    });
    ctx.pageCache.set('http://test.local/docs/page1', {
      url: 'http://test.local/docs/page1',
      markdown: { content: '# Title\n\n' + 'x'.repeat(15), source: 'content-negotiation' },
    });

    const result = await check.run(ctx);
    expect(result.status).toBe('warn');
    expect(result.details?.warnBucket).toBe(1);
  });

  it('fails when cached markdown exceeds fail threshold', async () => {
    const ctx = createContext('http://test.local', {
      requestDelay: 0,
      thresholds: { pass: 10, fail: 20 },
    });
    ctx.previousResults.set('markdown-url-support', {
      id: 'markdown-url-support',
      category: 'markdown-availability',
      status: 'warn',
      message: 'Partial',
    });
    ctx.pageCache.set('http://test.local/docs/page1', {
      url: 'http://test.local/docs/page1',
      markdown: { content: 'x'.repeat(25), source: 'md-url' },
    });

    const result = await check.run(ctx);
    expect(result.status).toBe('fail');
    expect(result.details?.failBucket).toBe(1);
  });

  it('skips when dependency checks failed', async () => {
    const ctx = makeCtx();
    ctx.previousResults.set('markdown-url-support', {
      id: 'markdown-url-support',
      category: 'markdown-availability',
      status: 'fail',
      message: 'No support',
    });
    ctx.previousResults.set('content-negotiation', {
      id: 'content-negotiation',
      category: 'markdown-availability',
      status: 'fail',
      message: 'No support',
    });

    const result = await check.run(ctx);
    expect(result.status).toBe('skip');
    expect(result.message).toContain('does not serve markdown');
  });

  it('skips when dependency passed but no cached pages', async () => {
    const ctx = makeCtx();
    ctx.previousResults.set('markdown-url-support', {
      id: 'markdown-url-support',
      category: 'markdown-availability',
      status: 'pass',
      message: 'OK',
    });
    // No pages in cache

    const result = await check.run(ctx);
    expect(result.status).toBe('skip');
    expect(result.message).toContain('No cached markdown');
  });

  it('works in standalone mode when dependencies never ran', async () => {
    mockNoLlmsTxt('ps-md-standalone.local');
    mockSitemapNotFound(server, 'http://ps-md-standalone.local');
    server.use(
      http.get(
        'http://ps-md-standalone.local/robots.txt',
        () => new HttpResponse('', { status: 404 }),
      ),
      http.get(
        'http://ps-md-standalone.local/sitemap.xml',
        () => new HttpResponse('', { status: 404 }),
      ),
      http.get(
        'http://ps-md-standalone.local',
        () =>
          new HttpResponse('<!DOCTYPE html><html><body>Home</body></html>', {
            status: 200,
            headers: { 'Content-Type': 'text/html' },
          }),
      ),
      http.get(
        'http://ps-md-standalone.local/.md',
        () => new HttpResponse('Not found', { status: 404 }),
      ),
      http.get(
        'http://ps-md-standalone.local/index.md',
        () =>
          new HttpResponse('# Welcome\n\nThis is a doc site.', {
            status: 200,
            headers: { 'Content-Type': 'text/markdown' },
          }),
      ),
    );

    const ctx = createContext('http://ps-md-standalone.local', { requestDelay: 0 });
    // No previousResults set at all — standalone mode
    const result = await check.run(ctx);
    expect(result.status).toBe('pass');
    expect(result.details?.source !== undefined || result.details?.pageResults).toBeTruthy();
  });

  it('skips in standalone mode when no markdown found', async () => {
    mockNoLlmsTxt('ps-md-nomd.local');
    mockSitemapNotFound(server, 'http://ps-md-nomd.local');
    server.use(
      http.get('http://ps-md-nomd.local/robots.txt', () => new HttpResponse('', { status: 404 })),
      http.get('http://ps-md-nomd.local/sitemap.xml', () => new HttpResponse('', { status: 404 })),
      http.get(
        'http://ps-md-nomd.local',
        () =>
          new HttpResponse('<!DOCTYPE html><html><body>Home</body></html>', {
            status: 200,
            headers: { 'Content-Type': 'text/html' },
          }),
      ),
      http.get('http://ps-md-nomd.local/.md', () => new HttpResponse('Not found', { status: 404 })),
      http.get(
        'http://ps-md-nomd.local/index.md',
        () => new HttpResponse('Not found', { status: 404 }),
      ),
    );

    const ctx = createContext('http://ps-md-nomd.local', { requestDelay: 0 });
    const result = await check.run(ctx);
    expect(result.status).toBe('skip');
    expect(result.message).toContain('No markdown content found');
  });

  it('reports worst status across multiple pages', async () => {
    const ctx = createContext('http://test.local', {
      requestDelay: 0,
      thresholds: { pass: 10, fail: 30 },
    });
    ctx.previousResults.set('markdown-url-support', {
      id: 'markdown-url-support',
      category: 'markdown-availability',
      status: 'pass',
      message: 'OK',
    });
    ctx.pageCache.set('http://test.local/docs/small', {
      url: 'http://test.local/docs/small',
      markdown: { content: 'short', source: 'md-url' },
    });
    ctx.pageCache.set('http://test.local/docs/big', {
      url: 'http://test.local/docs/big',
      markdown: { content: 'x'.repeat(50), source: 'md-url' },
    });

    const result = await check.run(ctx);
    expect(result.status).toBe('fail');
    expect(result.details?.passBucket).toBe(1);
    expect(result.details?.failBucket).toBe(1);
  });
});
