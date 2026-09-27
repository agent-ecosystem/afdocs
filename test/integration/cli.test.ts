import { describe, it, expect, beforeAll } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';

const VALID_LLMS_TXT = `# CLI Test

> A test project for CLI integration tests.

## Docs

- [Guide](http://cli-test.local/guide): A guide
`;

const server = setupServer();

beforeAll(() => {
  server.listen({ onUnhandledRequest: 'bypass' });
  return () => server.close();
});

describe('CLI', () => {
  it('outputs JSON format', async () => {
    server.use(
      http.get('http://cli-test.local/llms.txt', () => HttpResponse.text(VALID_LLMS_TXT)),
      http.get(
        'http://cli-test.local/docs/llms.txt',
        () => new HttpResponse(null, { status: 404 }),
      ),
    );

    // We can't easily test the CLI binary with MSW since it runs in a subprocess.
    // Instead, test the programmatic API that the CLI uses.
    const { runChecks } = await import('../../src/runner.js');
    await import('../../src/checks/index.js');

    const report = await runChecks('http://cli-test.local', {
      checkIds: ['llms-txt-exists'],
      requestDelay: 0,
    });

    const json = JSON.parse(JSON.stringify(report));
    expect(json.url).toBe('http://cli-test.local');
    expect(json.results).toBeInstanceOf(Array);
    expect(json.summary).toBeDefined();
    expect(json.summary.total).toBeGreaterThan(0);
  });

  it('reports all categories when no filter applied', async () => {
    server.use(
      http.get('http://cli-all.local/llms.txt', () => new HttpResponse(null, { status: 404 })),
      http.get('http://cli-all.local/docs/llms.txt', () => new HttpResponse(null, { status: 404 })),
      http.get('http://cli-all.local/robots.txt', () => new HttpResponse('', { status: 404 })),
      http.get('http://cli-all.local/sitemap.xml', () => new HttpResponse('', { status: 404 })),
      // Catch-all for the test host so new checks don't hang on unresolvable requests
      http.get(
        'http://cli-all.local/*',
        () =>
          new HttpResponse('<html><body>OK</body></html>', {
            status: 200,
            headers: { 'Content-Type': 'text/html' },
          }),
      ),
    );

    const { runChecks } = await import('../../src/runner.js');

    const report = await runChecks('http://cli-all.local', {
      requestDelay: 0,
    });

    // Should have results from multiple categories
    const categories = new Set(report.results.map((r) => r.category));
    expect(categories.size).toBeGreaterThan(1);
    expect(report.summary.total).toBe(25);
  });
});
