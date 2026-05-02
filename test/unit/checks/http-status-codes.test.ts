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

describe('http-status-codes', () => {
  const check = getCheck('http-status-codes')!;

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

    return ctx;
  }

  it('passes when bad URLs return 404', async () => {
    server.use(
      http.get(
        'http://test.local/docs/page1-afdocs-nonexistent-8f3a',
        () => new HttpResponse('Not Found', { status: 404 }),
      ),
    );

    const content = `# Docs\n## Links\n- [Page 1](http://test.local/docs/page1): First\n`;
    const result = await check.run(makeCtx(content));
    expect(result.status).toBe('pass');
    expect(result.details?.soft404Count).toBe(0);
    expect(result.details?.correctErrorCount).toBe(1);
  });

  it('fails when bad URL returns 200 (soft 404)', async () => {
    server.use(
      http.get(
        'http://test.local/docs/page1-afdocs-nonexistent-8f3a',
        () =>
          new HttpResponse('<html><body><h1>Welcome!</h1></body></html>', {
            status: 200,
            headers: { 'Content-Type': 'text/html' },
          }),
      ),
    );

    const content = `# Docs\n## Links\n- [Page 1](http://test.local/docs/page1): First\n`;
    const result = await check.run(makeCtx(content));
    expect(result.status).toBe('fail');
    expect(result.details?.soft404Count).toBe(1);
  });

  it('detects body hints in soft 404 responses', async () => {
    server.use(
      http.get(
        'http://test.local/docs/page1-afdocs-nonexistent-8f3a',
        () =>
          new HttpResponse('<html><body><h1>Page Not Found</h1></body></html>', {
            status: 200,
            headers: { 'Content-Type': 'text/html' },
          }),
      ),
    );

    const content = `# Docs\n## Links\n- [Page 1](http://test.local/docs/page1): First\n`;
    const result = await check.run(makeCtx(content));
    expect(result.status).toBe('fail');
    const pageResults = result.details?.pageResults as Array<{ bodyHint?: string }>;
    expect(pageResults[0].bodyHint).toContain('not found');
  });

  it('handles mixed results (some 404, some soft 404)', async () => {
    server.use(
      http.get(
        'http://test.local/docs/page1-afdocs-nonexistent-8f3a',
        () => new HttpResponse('Not Found', { status: 404 }),
      ),
      http.get(
        'http://test.local/docs/page2-afdocs-nonexistent-8f3a',
        () => new HttpResponse('<html><body>OK</body></html>', { status: 200 }),
      ),
    );

    const content = `# Docs\n## Links\n- [Page 1](http://test.local/docs/page1): First\n- [Page 2](http://test.local/docs/page2): Second\n`;
    const result = await check.run(makeCtx(content));
    expect(result.status).toBe('fail');
    expect(result.details?.soft404Count).toBe(1);
    expect(result.details?.correctErrorCount).toBe(1);
  });

  it('handles fetch errors gracefully', async () => {
    server.use(
      http.get('http://test.local/docs/page1-afdocs-nonexistent-8f3a', () => HttpResponse.error()),
    );

    const content = `# Docs\n## Links\n- [Page 1](http://test.local/docs/page1): First\n`;
    const result = await check.run(makeCtx(content));
    expect(result.details?.fetchErrors).toBe(1);
  });

  it('passes when redirect leads to 404', async () => {
    server.use(
      http.get(
        'http://test.local/docs/page1-afdocs-nonexistent-8f3a',
        () =>
          new HttpResponse(null, {
            status: 301,
            headers: { Location: 'http://test.local/not-found' },
          }),
      ),
      http.get('http://test.local/not-found', () => new HttpResponse('Not Found', { status: 404 })),
    );

    const content = `# Docs\n## Links\n- [Page 1](http://test.local/docs/page1): First\n`;
    const result = await check.run(makeCtx(content));
    expect(result.status).toBe('pass');
    expect(result.details?.correctErrorCount).toBe(1);
  });

  it('fails when redirect leads to 200 (soft 404)', async () => {
    server.use(
      http.get(
        'http://test.local/docs/page1-afdocs-nonexistent-8f3a',
        () =>
          new HttpResponse(null, {
            status: 301,
            headers: { Location: 'http://test.local/' },
          }),
      ),
      http.get(
        'http://test.local/',
        () =>
          new HttpResponse('<html><body><h1>Home</h1></body></html>', {
            status: 200,
            headers: { 'Content-Type': 'text/html' },
          }),
      ),
    );

    const content = `# Docs\n## Links\n- [Page 1](http://test.local/docs/page1): First\n`;
    const result = await check.run(makeCtx(content));
    expect(result.status).toBe('fail');
    expect(result.details?.soft404Count).toBe(1);
  });

  it('fails when all fetches error out', async () => {
    server.use(
      http.get('http://test.local/docs/page1-afdocs-nonexistent-8f3a', () => HttpResponse.error()),
    );

    const content = `# Docs\n## Links\n- [Page 1](http://test.local/docs/page1): First\n`;
    const result = await check.run(makeCtx(content));
    // The one result is a fetch-error, so tested.length === 0
    expect(result.status).toBe('fail');
    expect(result.message).toContain('Could not test any URLs');
    expect(result.details?.fetchErrors).toBe(1);
  });

  it('includes fetch error count in pass message suffix', async () => {
    server.use(
      http.get(
        'http://test.local/docs/page1-afdocs-nonexistent-8f3a',
        () => new HttpResponse('Not Found', { status: 404 }),
      ),
      http.get('http://test.local/docs/page2-afdocs-nonexistent-8f3a', () => HttpResponse.error()),
    );

    const content = `# Docs\n## Links\n- [Page 1](http://test.local/docs/page1): First\n- [Page 2](http://test.local/docs/page2): Second\n`;
    const result = await check.run(makeCtx(content));
    expect(result.status).toBe('pass');
    expect(result.message).toContain('1 failed to fetch');
  });

  it('classifies HTTP 202 as indeterminate, not soft-404', async () => {
    server.use(
      http.get(
        'http://test.local/docs/page1-afdocs-nonexistent-8f3a',
        () => new HttpResponse(null, { status: 202 }),
      ),
      http.get(
        'http://test.local/docs/page2-afdocs-nonexistent-8f3a',
        () => new HttpResponse('Not Found', { status: 404 }),
      ),
    );

    const content = `# Docs\n## Links\n- [Page 1](http://test.local/docs/page1): First\n- [Page 2](http://test.local/docs/page2): Second\n`;
    const result = await check.run(makeCtx(content));
    expect(result.status).toBe('pass');
    expect(result.details?.soft404Count).toBe(0);
    expect(result.details?.correctErrorCount).toBe(1);
    expect(result.details?.indeterminateCount).toBe(1);
    const pageResults = result.details?.pageResults as Array<{
      classification: string;
      indeterminateReason?: string;
    }>;
    const indet = pageResults.find((p) => p.classification === 'indeterminate');
    expect(indet?.indeterminateReason).toContain('202');
  });

  it('classifies 5xx as indeterminate', async () => {
    server.use(
      http.get(
        'http://test.local/docs/page1-afdocs-nonexistent-8f3a',
        () => new HttpResponse('Server Error', { status: 503 }),
      ),
    );

    const content = `# Docs\n## Links\n- [Page 1](http://test.local/docs/page1): First\n`;
    const result = await check.run(makeCtx(content));
    const pageResults = result.details?.pageResults as Array<{ classification: string }>;
    expect(pageResults[0].classification).toBe('indeterminate');
    expect(result.details?.indeterminateCount).toBe(1);
  });

  it('warns when all responses are indeterminate', async () => {
    server.use(
      http.get(
        'http://test.local/docs/page1-afdocs-nonexistent-8f3a',
        () => new HttpResponse(null, { status: 202 }),
      ),
      http.get(
        'http://test.local/docs/page2-afdocs-nonexistent-8f3a',
        () => new HttpResponse('Server Error', { status: 503 }),
      ),
    );

    const content = `# Docs\n## Links\n- [Page 1](http://test.local/docs/page1): First\n- [Page 2](http://test.local/docs/page2): Second\n`;
    const result = await check.run(makeCtx(content));
    expect(result.status).toBe('warn');
    expect(result.message).toContain('Could not determine');
    expect(result.details?.indeterminateCount).toBe(2);
  });

  it('strips fragments from test URLs', async () => {
    server.use(
      http.get(
        'http://test.local/docs/page1-afdocs-nonexistent-8f3a',
        () => new HttpResponse('Not Found', { status: 404 }),
      ),
    );

    const content = `# Docs\n## Links\n- [Page 1](http://test.local/docs/page1#section): First\n`;
    const result = await check.run(makeCtx(content));
    expect(result.status).toBe('pass');
    const pageResults = result.details?.pageResults as Array<{ testUrl: string }>;
    expect(pageResults[0].testUrl).not.toContain('#');
  });
});
