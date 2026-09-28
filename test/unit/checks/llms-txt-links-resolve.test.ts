import { describe, it, expect, beforeAll } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { createContext } from '../../../src/runner.js';
import { getCheck } from '../../../src/checks/registry.js';
import '../../../src/checks/index.js';
import type { DiscoveredFile } from '../../../src/types.js';

const server = setupServer();

beforeAll(() => {
  server.listen({ onUnhandledRequest: 'bypass' });
  return () => server.close();
});

describe('llms-txt-links-resolve', () => {
  const check = getCheck('llms-txt-links-resolve')!;

  function makeCtx(content: string) {
    const ctx = createContext('http://test.local', { requestDelay: 0 });
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
    return ctx;
  }

  it('skips when no discovered files', async () => {
    const ctx = createContext('http://test.local', { requestDelay: 0 });
    ctx.previousResults.set('llms-txt-exists', {
      id: 'llms-txt-exists',
      category: 'content-discoverability',
      status: 'fail',
      message: 'Not found',
      details: { discoveredFiles: [] },
    });
    const result = await check.run(ctx);
    expect(result.status).toBe('skip');
    expect(result.message).toContain('No llms.txt files');
  });

  it('falls back to GET when HEAD returns 405', async () => {
    server.use(
      http.head('http://test.local/page1', () => new HttpResponse(null, { status: 405 })),
      http.get('http://test.local/page1', () => new HttpResponse('OK', { status: 200 })),
    );

    const content = `# Test\n> Summary\n## Links\n- [Page 1](http://test.local/page1): First\n`;
    const result = await check.run(makeCtx(content));
    expect(result.status).toBe('pass');
    expect(result.details?.resolved).toBe(1);
  });

  it.each([200, 404])(
    'checks reference links normally (HTTP %i), never code or comments',
    async (status) => {
      const url = 'http://test.local/guide_(intro)?x=&amp;y';
      const requests: string[] = [];
      server.use(
        http.all('http://test.local/*', ({ request }) => {
          requests.push(`${request.method} ${request.url}`);
          return new HttpResponse(null, { status });
        }),
      );
      const content = `# Docs\n\n[guide][ref]\n\n[ref]: http://test.local/guide_(intro)?x=&amp;amp;y\n\n    [code](http://test.local/code)\n\n<!-- [hidden](http://test.local/hidden) -->\n\n![image](http://test.local/image.png)`;
      const result = await check.run(makeCtx(content));
      expect(result.status).toBe(status === 200 ? 'pass' : 'fail');
      expect(result.details?.sameOrigin).toMatchObject({
        tested: 1,
        resolved: status === 200 ? 1 : 0,
      });
      expect(requests).toEqual([`HEAD ${url}`]);
    },
  );

  it('warns when resolve rate is above threshold but not 100%', async () => {
    // 10 resolve, 1 broken = ~91% resolve rate (> 0.9 threshold → warn)
    const urls: string[] = [];
    for (let i = 0; i < 10; i++) {
      urls.push(`http://test.local/page${i}`);
      server.use(
        http.head(`http://test.local/page${i}`, () => new HttpResponse(null, { status: 200 })),
      );
    }
    urls.push('http://test.local/broken');
    server.use(
      http.head('http://test.local/broken', () => new HttpResponse(null, { status: 404 })),
    );

    const links = urls.map((u, i) => `- [Page ${i}](${u}): Page ${i}`).join('\n');
    const content = `# Test\n> Summary\n## Links\n${links}\n`;
    const result = await check.run(makeCtx(content));
    expect(result.status).toBe('warn');
    expect(result.details?.broken).toHaveLength(1);
  });

  it('passes when all same-origin links resolve', async () => {
    server.use(
      http.head('http://test.local/page1', () => new HttpResponse(null, { status: 200 })),
      http.head('http://test.local/page2', () => new HttpResponse(null, { status: 200 })),
    );

    const content = `# Test
> Summary
## Links
- [Page 1](http://test.local/page1): First
- [Page 2](http://test.local/page2): Second
`;
    const result = await check.run(makeCtx(content));
    expect(result.status).toBe('pass');
  });

  it('fails when most same-origin links are broken', async () => {
    server.use(
      http.head('http://test.local/page1', () => new HttpResponse(null, { status: 404 })),
      http.head('http://test.local/page2', () => new HttpResponse(null, { status: 404 })),
      http.head('http://test.local/page3', () => new HttpResponse(null, { status: 200 })),
    );

    const content = `# Test
> Summary
## Links
- [Page 1](http://test.local/page1): First
- [Page 2](http://test.local/page2): Second
- [Page 3](http://test.local/page3): Third
`;
    const result = await check.run(makeCtx(content));
    expect(result.status).toBe('fail');
  });

  it('does not fail when only cross-origin links are broken', async () => {
    server.use(
      http.head('http://test.local/page1', () => new HttpResponse(null, { status: 200 })),
      http.head('http://external.example/pkg', () => new HttpResponse(null, { status: 403 })),
    );

    const content = `# Test
> Summary
## Links
- [Page 1](http://test.local/page1): First
- [Package](http://external.example/pkg): External
`;
    const result = await check.run(makeCtx(content));
    // Same-origin link passes, so overall should warn (not fail) due to external failure
    expect(result.status).toBe('warn');
    expect(result.message).toContain('same-origin');
    expect(result.message).toContain('external');
  });

  it('passes when all same-origin resolve and no cross-origin issues', async () => {
    server.use(
      http.head('http://test.local/page1', () => new HttpResponse(null, { status: 200 })),
      http.head('http://external.example/ok', () => new HttpResponse(null, { status: 200 })),
    );

    const content = `# Test
> Summary
## Links
- [Page 1](http://test.local/page1): First
- [External](http://external.example/ok): External
`;
    const result = await check.run(makeCtx(content));
    expect(result.status).toBe('pass');
  });

  it('warns (not fails) when only cross-origin links exist and some fail', async () => {
    server.use(
      http.head('http://external.example/ok', () => new HttpResponse(null, { status: 200 })),
      http.head('http://other.example/blocked', () => new HttpResponse(null, { status: 403 })),
    );

    const content = `# Test
> Summary
## Links
- [External](http://external.example/ok): OK
- [Blocked](http://other.example/blocked): Blocked
`;
    const result = await check.run(makeCtx(content));
    expect(result.status).toBe('warn');
  });

  it('skips when no HTTP links present', async () => {
    const content = `# Test
> Summary
## Links
Just text, no links.
`;
    const result = await check.run(makeCtx(content));
    expect(result.status).toBe('skip');
  });

  it('reports fetch errors in details', async () => {
    server.use(
      http.head('http://test.local/page1', () => HttpResponse.error()),
      http.get('http://test.local/page1', () => HttpResponse.error()),
    );

    const content = `# Test\n> Summary\n## Links\n- [Page 1](http://test.local/page1): First\n`;
    const result = await check.run(makeCtx(content));
    expect(result.details?.fetchErrors).toBe(1);
    expect(result.message).toContain('failed to fetch');
  });

  it('reports rate-limited results (HTTP 429)', async () => {
    server.use(http.head('http://test.local/page1', () => new HttpResponse(null, { status: 429 })));

    const content = `# Test\n> Summary\n## Links\n- [Page 1](http://test.local/page1): First\n`;
    const result = await check.run(makeCtx(content));
    expect(result.details?.rateLimited).toBe(1);
    expect(result.message).toContain('rate-limited (HTTP 429)');
  });

  // ── Path-prefix scoping ──

  it('scopes links to baseUrl path prefix', async () => {
    server.use(
      http.head('http://scope-res.local/docs/page1', () => new HttpResponse(null, { status: 200 })),
    );

    // llms.txt has both docs and non-docs links; only docs links should be tested
    const content = `# Site\n- [Page](http://scope-res.local/docs/page1): Page\n- [Blog](http://scope-res.local/blog/post): Blog\n`;
    const ctx = createContext('http://scope-res.local/docs', { requestDelay: 0 });
    const discovered: DiscoveredFile[] = [
      { url: 'http://scope-res.local/llms.txt', content, status: 200, redirected: false },
    ];
    ctx.previousResults.set('llms-txt-exists', {
      id: 'llms-txt-exists',
      category: 'content-discoverability',
      status: 'pass',
      message: 'Found',
      details: { discoveredFiles: discovered },
    });

    const result = await check.run(ctx);
    expect(result.status).toBe('pass');
    // Only the /docs/page1 link should be tested
    expect(result.details?.sameOrigin).toMatchObject({ tested: 1, resolved: 1 });
  });

  it('skips with descriptive message when all links are outside the baseUrl path prefix', async () => {
    const content = `# Site\n- [Blog](http://scope-res2.local/blog/post): Blog\n`;
    const ctx = createContext('http://scope-res2.local/docs', { requestDelay: 0 });
    const discovered: DiscoveredFile[] = [
      { url: 'http://scope-res2.local/llms.txt', content, status: 200, redirected: false },
    ];
    ctx.previousResults.set('llms-txt-exists', {
      id: 'llms-txt-exists',
      category: 'content-discoverability',
      status: 'pass',
      message: 'Found',
      details: { discoveredFiles: discovered },
    });

    const result = await check.run(ctx);
    expect(result.status).toBe('skip');
    expect(result.message).toContain('1 link');
    expect(result.message).toContain('none are under /docs');
  });

  it('includes "sampled" in message when results are sampled', async () => {
    const links = Array.from(
      { length: 5 },
      (_, i) => `- [Page ${i}](http://test.local/page${i}): Page ${i}`,
    ).join('\n');

    for (let i = 0; i < 5; i++) {
      server.use(
        http.head(`http://test.local/page${i}`, () => new HttpResponse(null, { status: 200 })),
      );
    }

    const content = `# Test\n> Summary\n## Links\n${links}\n`;
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

    const result = await check.run(ctx);
    expect(result.details?.sampled).toBe(true);
    expect(result.message).toContain('sampled links');
  });
});
