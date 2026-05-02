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

describe('llms-txt-links-markdown', () => {
  const check = getCheck('llms-txt-links-markdown')!;

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

  it('skips when no HTTP links present', async () => {
    const content = `# Test
> Summary
## Links
Just text, no links here.
`;
    const result = await check.run(makeCtx(content));
    expect(result.status).toBe('skip');
    expect(result.message).toContain('No HTTP(S) links');
  });

  it('passes when links have .md extensions', async () => {
    const content = `# Test
> Summary
## Links
- [Page 1](http://test.local/page1.md): First
- [Page 2](http://test.local/page2.md): Second
`;
    const result = await check.run(makeCtx(content));
    expect(result.status).toBe('pass');
    expect(result.details?.markdownRate).toBe(100);
  });

  it('fails when same-origin links are HTML with no markdown alternatives', async () => {
    server.use(
      http.head(
        'http://test.local/page1',
        () =>
          new HttpResponse(null, {
            status: 200,
            headers: { 'content-type': 'text/html' },
          }),
      ),
      http.head('http://test.local/page1.md', () => new HttpResponse(null, { status: 404 })),
      http.head('http://test.local/page1/index.md', () => new HttpResponse(null, { status: 404 })),
      http.head(
        'http://test.local/page2',
        () =>
          new HttpResponse(null, {
            status: 200,
            headers: { 'content-type': 'text/html' },
          }),
      ),
      http.head('http://test.local/page2.md', () => new HttpResponse(null, { status: 404 })),
      http.head('http://test.local/page2/index.md', () => new HttpResponse(null, { status: 404 })),
    );

    const content = `# Test
> Summary
## Links
- [Page 1](http://test.local/page1): First
- [Page 2](http://test.local/page2): Second
`;
    const result = await check.run(makeCtx(content));
    expect(result.status).toBe('fail');
  });

  it('warns when .md variants are available', async () => {
    server.use(
      http.head(
        'http://test.local/page1',
        () =>
          new HttpResponse(null, {
            status: 200,
            headers: { 'content-type': 'text/html' },
          }),
      ),
      http.head('http://test.local/page1.md', () => new HttpResponse(null, { status: 200 })),
    );

    const content = `# Test
> Summary
## Links
- [Page 1](http://test.local/page1): First
`;
    const result = await check.run(makeCtx(content));
    expect(result.status).toBe('warn');
  });

  it('excludes cross-origin links from markdown assessment', async () => {
    server.use(
      http.head(
        'http://test.local/page1',
        () =>
          new HttpResponse(null, {
            status: 200,
            headers: { 'content-type': 'text/markdown' },
          }),
      ),
      // External link serves HTML, but should not affect the result
      http.head(
        'http://external.example/page',
        () =>
          new HttpResponse(null, {
            status: 200,
            headers: { 'content-type': 'text/html' },
          }),
      ),
    );

    const content = `# Test
> Summary
## Links
- [Page 1](http://test.local/page1): First
- [External](http://external.example/page): External
`;
    const result = await check.run(makeCtx(content));
    expect(result.status).toBe('pass');
    expect(result.details?.crossOriginExcluded).toBe(1);
  });

  it('skips when all links are cross-origin', async () => {
    const content = `# Test
> Summary
## Links
- [External](http://external.example/page): External
`;
    const result = await check.run(makeCtx(content));
    expect(result.status).toBe('skip');
    expect(result.message).toContain('external');
  });

  it('reports fetch errors in details and message', async () => {
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

  it('includes "sampled" in message when results are sampled', async () => {
    const links = Array.from(
      { length: 5 },
      (_, i) => `- [Page ${i}](http://test.local/page${i}.md): Page ${i}`,
    ).join('\n');

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

  it('passes for .txt companion files that contain markdown', async () => {
    server.use(
      http.head(
        'http://test.local/llms-full.txt',
        () =>
          new HttpResponse(null, {
            status: 200,
            headers: { 'content-type': 'text/plain' },
          }),
      ),
      http.get(
        'http://test.local/llms-full.txt',
        () =>
          new HttpResponse(
            '# Full docs\n\n## API Reference\n\n- [Endpoint](http://test.local/api.md): API',
            {
              status: 200,
              headers: { 'content-type': 'text/plain' },
            },
          ),
      ),
    );

    const content = `# Test\n> Summary\n## Links\n- [Full docs](http://test.local/llms-full.txt): Complete documentation\n`;
    const result = await check.run(makeCtx(content));
    expect(result.status).toBe('pass');
  });

  it('fails for .txt files that do not contain markdown', async () => {
    server.use(
      http.head(
        'http://test.local/robots.txt',
        () =>
          new HttpResponse(null, {
            status: 200,
            headers: { 'content-type': 'text/plain' },
          }),
      ),
      http.get(
        'http://test.local/robots.txt',
        () =>
          new HttpResponse('User-agent: *\nDisallow: /private/', {
            status: 200,
            headers: { 'content-type': 'text/plain' },
          }),
      ),
    );

    const content = `# Test\n> Summary\n## Links\n- [Robots](http://test.local/robots.txt): Robots file\n`;
    const result = await check.run(makeCtx(content));
    expect(result.status).toBe('fail');
  });

  // ── Path-prefix scoping ──

  it('scopes links to baseUrl path prefix', async () => {
    // llms.txt has both docs and non-docs links; only docs links should be tested
    const content = `# Site\n- [Intro](http://scope-md.local/docs/intro.md): Intro\n- [Blog](http://scope-md.local/blog/post.md): Blog\n- [Careers](http://scope-md.local/careers): Careers\n`;
    const ctx = createContext('http://scope-md.local/docs', { requestDelay: 0 });
    const discovered: DiscoveredFile[] = [
      { url: 'http://scope-md.local/llms.txt', content, status: 200, redirected: false },
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
    // Only the /docs/intro.md link should be tested (markdownRate 100%)
    expect(result.details?.testedLinks).toBe(1);
    expect(result.details?.markdownRate).toBe(100);
  });

  it('skips with descriptive message when all links are outside the baseUrl path prefix', async () => {
    const content = `# Site\n- [Blog](http://scope-md2.local/blog/post): Blog\n`;
    const ctx = createContext('http://scope-md2.local/docs', { requestDelay: 0 });
    const discovered: DiscoveredFile[] = [
      { url: 'http://scope-md2.local/llms.txt', content, status: 200, redirected: false },
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

  it('uses toMdUrls to find .md variants (handles trailing slash and .html)', async () => {
    server.use(
      http.head(
        'http://test.local/guide.html',
        () =>
          new HttpResponse(null, {
            status: 200,
            headers: { 'content-type': 'text/html' },
          }),
      ),
      // toMdUrls should produce /guide.md (stripping .html)
      http.head('http://test.local/guide.md', () => new HttpResponse(null, { status: 200 })),
    );

    const content = `# Test\n> Summary\n## Links\n- [Guide](http://test.local/guide.html): Guide\n`;
    const result = await check.run(makeCtx(content));
    expect(result.status).toBe('warn');
    expect(result.details?.mdVariantsAvailable).toBe(1);
  });

  // Issue #77 isolation: parent-clean candidate generation lives in
  // markdown-url-support only. If it ever leaks into toMdUrls, this links
  // check would falsely validate a link to /docs/auth/index.html via an
  // unrelated /docs/auth.md sibling. Guard against that.
  it('does not validate link via parent-clean .md candidate (issue #77 isolation)', async () => {
    const requestLog: string[] = [];
    server.use(
      http.head('http://test.local/docs/auth/index.html', () => {
        requestLog.push('HEAD /docs/auth/index.html');
        return new HttpResponse(null, { status: 200 });
      }),
      http.head('http://test.local/docs/auth/index.md', () => {
        requestLog.push('HEAD /docs/auth/index.md');
        return new HttpResponse(null, { status: 404 });
      }),
      http.head('http://test.local/docs/auth/index.html/index.md', () => {
        requestLog.push('HEAD /docs/auth/index.html/index.md');
        return new HttpResponse(null, { status: 404 });
      }),
      // The sibling /docs/auth.md exists but must not be requested.
      http.head('http://test.local/docs/auth.md', () => {
        requestLog.push('HEAD /docs/auth.md');
        return new HttpResponse(null, { status: 200 });
      }),
      http.get('http://test.local/docs/auth.md', () => {
        requestLog.push('GET /docs/auth.md');
        return new HttpResponse('# unrelated', {
          status: 200,
          headers: { 'Content-Type': 'text/markdown' },
        });
      }),
    );

    const content = `# Test\n> Summary\n## Links\n- [Auth](http://test.local/docs/auth/index.html): Auth\n`;
    await check.run(makeCtx(content));
    expect(requestLog).not.toContain('HEAD /docs/auth.md');
    expect(requestLog).not.toContain('GET /docs/auth.md');
  });
});
