import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { createContext } from '../../../src/runner.js';
import {
  fetchLlmsTxtLinkedMarkdown,
  getMarkdownContent,
} from '../../../src/helpers/get-markdown-content.js';
import type { DiscoveredFile } from '../../../src/types.js';
import { mockSitemapNotFound } from '../../helpers/mock-sitemap-not-found.js';

const server = setupServer();

beforeAll(() => {
  server.listen({ onUnhandledRequest: 'bypass' });
  return () => server.close();
});

afterEach(() => server.resetHandlers());

describe('getMarkdownContent', () => {
  describe('cached mode (dependency already ran)', () => {
    it('returns cached pages when markdown-url-support passed', async () => {
      const ctx = createContext('http://test.local', { requestDelay: 0 });
      ctx.previousResults.set('markdown-url-support', {
        id: 'markdown-url-support',
        category: 'markdown-availability',
        status: 'pass',
        message: 'Markdown supported',
      });
      ctx.pageCache.set('http://test.local/docs/page1', {
        url: 'http://test.local/docs/page1',
        markdown: { content: '# Page 1\n\nContent.', source: 'md-url' },
      });

      const result = await getMarkdownContent(ctx);
      expect(result.mode).toBe('cached');
      if (result.mode === 'cached') {
        expect(result.depPassed).toBe(true);
        expect(result.pages).toHaveLength(1);
        expect(result.pages[0].content).toBe('# Page 1\n\nContent.');
        expect(result.pages[0].source).toBe('md-url');
      }
    });

    it('returns cached pages when content-negotiation passed', async () => {
      const ctx = createContext('http://test.local', { requestDelay: 0 });
      ctx.previousResults.set('content-negotiation', {
        id: 'content-negotiation',
        category: 'markdown-availability',
        status: 'pass',
        message: 'Content negotiation supported',
      });
      ctx.pageCache.set('http://test.local/docs/page1', {
        url: 'http://test.local/docs/page1',
        markdown: { content: '# Page 1', source: 'content-negotiation' },
      });

      const result = await getMarkdownContent(ctx);
      expect(result.mode).toBe('cached');
      if (result.mode === 'cached') {
        expect(result.depPassed).toBe(true);
      }
    });

    it('sets depPassed false when dependency ran but failed', async () => {
      const ctx = createContext('http://test.local', { requestDelay: 0 });
      ctx.previousResults.set('markdown-url-support', {
        id: 'markdown-url-support',
        category: 'markdown-availability',
        status: 'fail',
        message: 'Not supported',
      });

      const result = await getMarkdownContent(ctx);
      expect(result.mode).toBe('cached');
      if (result.mode === 'cached') {
        expect(result.depPassed).toBe(false);
        expect(result.pages).toHaveLength(0);
      }
    });

    it('sets depPassed true when dependency warned', async () => {
      const ctx = createContext('http://test.local', { requestDelay: 0 });
      ctx.previousResults.set('content-negotiation', {
        id: 'content-negotiation',
        category: 'markdown-availability',
        status: 'warn',
        message: 'Partially supported',
      });
      ctx.pageCache.set('http://test.local/docs/page1', {
        url: 'http://test.local/docs/page1',
        markdown: { content: '# Page 1', source: 'content-negotiation' },
      });

      const result = await getMarkdownContent(ctx);
      expect(result.mode).toBe('cached');
      if (result.mode === 'cached') {
        expect(result.depPassed).toBe(true);
      }
    });

    it('passes the markdown URL and Link header through from the cache', async () => {
      const ctx = createContext('http://test.local', { requestDelay: 0 });
      ctx.previousResults.set('markdown-url-support', {
        id: 'markdown-url-support',
        category: 'markdown-availability',
        status: 'pass',
        message: 'OK',
      });
      ctx.pageCache.set('http://test.local/docs/page1', {
        url: 'http://test.local/docs/page1',
        markdown: {
          content: '# Page 1',
          source: 'md-url',
          mdUrl: 'http://test.local/docs/page1.md',
          linkHeader: '</docs/page1.md?page=2>; rel="next"',
        },
      });

      const result = await getMarkdownContent(ctx);
      expect(result.pages[0]).toEqual({
        url: 'http://test.local/docs/page1',
        content: '# Page 1',
        source: 'md-url',
        mdUrl: 'http://test.local/docs/page1.md',
        linkHeader: '</docs/page1.md?page=2>; rel="next"',
      });
    });

    it('skips cache entries without markdown content', async () => {
      const ctx = createContext('http://test.local', { requestDelay: 0 });
      ctx.previousResults.set('markdown-url-support', {
        id: 'markdown-url-support',
        category: 'markdown-availability',
        status: 'pass',
        message: 'OK',
      });
      ctx.pageCache.set('http://test.local/docs/page1', {
        url: 'http://test.local/docs/page1',
        markdown: { content: '# Has content', source: 'md-url' },
      });
      ctx.pageCache.set('http://test.local/docs/page2', {
        url: 'http://test.local/docs/page2',
        // No markdown field
      });

      const result = await getMarkdownContent(ctx);
      expect(result.mode).toBe('cached');
      expect(result.pages.filter((p) => p.source !== 'llms-txt')).toHaveLength(1);
    });
  });

  describe('llms.txt content collection', () => {
    it('includes llms.txt content from llms-txt-exists result', async () => {
      const ctx = createContext('http://test.local', { requestDelay: 0 });
      const discovered: DiscoveredFile[] = [
        {
          url: 'http://test.local/llms.txt',
          content: '# Docs\n\n- [Guide](/guide): A guide',
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
      ctx.previousResults.set('markdown-url-support', {
        id: 'markdown-url-support',
        category: 'markdown-availability',
        status: 'pass',
        message: 'OK',
      });

      const result = await getMarkdownContent(ctx);
      const llmsPages = result.pages.filter((p) => p.source === 'llms-txt');
      expect(llmsPages).toHaveLength(1);
      expect(llmsPages[0].url).toBe('http://test.local/llms.txt');
      expect(llmsPages[0].content).toContain('# Docs');
    });

    it('skips discovered files without content', async () => {
      const ctx = createContext('http://test.local', { requestDelay: 0 });
      const discovered: DiscoveredFile[] = [
        { url: 'http://test.local/llms.txt', status: 200, redirected: false },
      ];
      ctx.previousResults.set('llms-txt-exists', {
        id: 'llms-txt-exists',
        category: 'content-discoverability',
        status: 'pass',
        message: 'Found',
        details: { discoveredFiles: discovered },
      });
      ctx.previousResults.set('markdown-url-support', {
        id: 'markdown-url-support',
        category: 'markdown-availability',
        status: 'pass',
        message: 'OK',
      });

      const result = await getMarkdownContent(ctx);
      const llmsPages = result.pages.filter((p) => p.source === 'llms-txt');
      expect(llmsPages).toHaveLength(0);
    });

    it('handles missing llms-txt-exists result', async () => {
      const ctx = createContext('http://test.local', { requestDelay: 0 });
      ctx.previousResults.set('markdown-url-support', {
        id: 'markdown-url-support',
        category: 'markdown-availability',
        status: 'pass',
        message: 'OK',
      });

      const result = await getMarkdownContent(ctx);
      const llmsPages = result.pages.filter((p) => p.source === 'llms-txt');
      expect(llmsPages).toHaveLength(0);
    });
  });

  describe('standalone mode (no dependency ran)', () => {
    it('fetches markdown via .md URL candidates', async () => {
      const llmsTxt = '# Docs\n\n- [Page 1](http://test.local/docs/page1): Page';
      const ctx = createContext('http://test.local', { requestDelay: 0 });
      const discovered: DiscoveredFile[] = [
        { url: 'http://test.local/llms.txt', content: llmsTxt, status: 200, redirected: false },
      ];
      ctx.previousResults.set('llms-txt-exists', {
        id: 'llms-txt-exists',
        category: 'content-discoverability',
        status: 'pass',
        message: 'Found',
        details: { discoveredFiles: discovered },
      });
      mockSitemapNotFound(server, 'http://test.local');

      server.use(
        http.get(
          'http://test.local/docs/page1.md',
          () =>
            new HttpResponse('# Page 1\n\nMarkdown content here.', {
              status: 200,
              headers: { 'Content-Type': 'text/markdown' },
            }),
        ),
      );

      const result = await getMarkdownContent(ctx);
      expect(result.mode).toBe('standalone');
      const fetched = result.pages.filter((p) => p.source === 'standalone-md-url');
      expect(fetched).toHaveLength(1);
      expect(fetched[0].content).toContain('# Page 1');
      expect(fetched[0].mdUrl).toBe('http://test.local/docs/page1.md');
      expect(fetched[0].linkHeader).toBeUndefined();
    });

    it('falls back to content negotiation when .md URLs fail', async () => {
      const llmsTxt = '# Docs\n\n- [Page 1](http://test.local/docs/page1): Page';
      const ctx = createContext('http://test.local', { requestDelay: 0 });
      const discovered: DiscoveredFile[] = [
        { url: 'http://test.local/llms.txt', content: llmsTxt, status: 200, redirected: false },
      ];
      ctx.previousResults.set('llms-txt-exists', {
        id: 'llms-txt-exists',
        category: 'content-discoverability',
        status: 'pass',
        message: 'Found',
        details: { discoveredFiles: discovered },
      });
      mockSitemapNotFound(server, 'http://test.local');

      server.use(
        http.get('http://test.local/docs/page1.md', () => new HttpResponse('', { status: 404 })),
        http.get(
          'http://test.local/docs/page1/index.md',
          () => new HttpResponse('', { status: 404 }),
        ),
        http.get('http://test.local/docs/page1', ({ request }) => {
          const accept = request.headers.get('accept') ?? '';
          if (accept.includes('text/markdown')) {
            return new HttpResponse('# Page 1 via CN\n\nContent.', {
              status: 200,
              headers: { 'Content-Type': 'text/markdown' },
            });
          }
          return new HttpResponse('<html><body>Page 1</body></html>', {
            status: 200,
            headers: { 'Content-Type': 'text/html' },
          });
        }),
      );

      const result = await getMarkdownContent(ctx);
      expect(result.mode).toBe('standalone');
      const fetched = result.pages.filter((p) => p.source === 'standalone-content-negotiation');
      expect(fetched).toHaveLength(1);
      expect(fetched[0].content).toContain('# Page 1 via CN');
    });

    it('returns empty when no markdown is available', async () => {
      const llmsTxt = '# Docs\n\n- [Page 1](http://test.local/docs/page1): Page';
      const ctx = createContext('http://test.local', { requestDelay: 0 });
      const discovered: DiscoveredFile[] = [
        { url: 'http://test.local/llms.txt', content: llmsTxt, status: 200, redirected: false },
      ];
      ctx.previousResults.set('llms-txt-exists', {
        id: 'llms-txt-exists',
        category: 'content-discoverability',
        status: 'pass',
        message: 'Found',
        details: { discoveredFiles: discovered },
      });
      mockSitemapNotFound(server, 'http://test.local');

      server.use(
        http.get('http://test.local/docs/page1.md', () => new HttpResponse('', { status: 404 })),
        http.get(
          'http://test.local/docs/page1/index.md',
          () => new HttpResponse('', { status: 404 }),
        ),
        http.get(
          'http://test.local/docs/page1',
          () =>
            new HttpResponse('<html><body>HTML only</body></html>', {
              status: 200,
              headers: { 'Content-Type': 'text/html' },
            }),
        ),
      );

      const result = await getMarkdownContent(ctx);
      expect(result.mode).toBe('standalone');
      const fetched = result.pages.filter((p) => p.source !== 'llms-txt');
      expect(fetched).toHaveLength(0);
    });

    it('skips .md URLs that return non-markdown content', async () => {
      const llmsTxt = '# Docs\n\n- [Page 1](http://test.local/docs/page1): Page';
      const ctx = createContext('http://test.local', { requestDelay: 0 });
      const discovered: DiscoveredFile[] = [
        { url: 'http://test.local/llms.txt', content: llmsTxt, status: 200, redirected: false },
      ];
      ctx.previousResults.set('llms-txt-exists', {
        id: 'llms-txt-exists',
        category: 'content-discoverability',
        status: 'pass',
        message: 'Found',
        details: { discoveredFiles: discovered },
      });
      mockSitemapNotFound(server, 'http://test.local');

      server.use(
        http.get(
          'http://test.local/docs/page1.md',
          () =>
            new HttpResponse('<html><body>Not markdown</body></html>', {
              status: 200,
              headers: { 'Content-Type': 'text/html' },
            }),
        ),
        http.get(
          'http://test.local/docs/page1/index.md',
          () => new HttpResponse('', { status: 404 }),
        ),
        http.get(
          'http://test.local/docs/page1',
          () =>
            new HttpResponse('<html><body>HTML</body></html>', {
              status: 200,
              headers: { 'Content-Type': 'text/html' },
            }),
        ),
      );

      const result = await getMarkdownContent(ctx);
      expect(result.mode).toBe('standalone');
      const fetched = result.pages.filter((p) => p.source !== 'llms-txt');
      expect(fetched).toHaveLength(0);
    });

    it('handles fetch errors gracefully', async () => {
      const llmsTxt = '# Docs\n\n- [Page 1](http://test.local/docs/page1): Page';
      const ctx = createContext('http://test.local', { requestDelay: 0 });
      const discovered: DiscoveredFile[] = [
        { url: 'http://test.local/llms.txt', content: llmsTxt, status: 200, redirected: false },
      ];
      ctx.previousResults.set('llms-txt-exists', {
        id: 'llms-txt-exists',
        category: 'content-discoverability',
        status: 'pass',
        message: 'Found',
        details: { discoveredFiles: discovered },
      });
      mockSitemapNotFound(server, 'http://test.local');

      server.use(
        http.get('http://test.local/docs/page1.md', () => HttpResponse.error()),
        http.get('http://test.local/docs/page1/index.md', () => HttpResponse.error()),
        http.get('http://test.local/docs/page1', () => HttpResponse.error()),
      );

      const result = await getMarkdownContent(ctx);
      expect(result.mode).toBe('standalone');
      const fetched = result.pages.filter((p) => p.source !== 'llms-txt');
      expect(fetched).toHaveLength(0);
    });
  });
});

describe('fetchLlmsTxtLinkedMarkdown', () => {
  function ctxWithLlmsTxt(content: string, opts: Record<string, unknown> = {}) {
    const ctx = createContext('http://test.local', { requestDelay: 0, ...opts });
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

  it('returns nothing without an llms.txt', async () => {
    const ctx = createContext('http://test.local', { requestDelay: 0 });
    expect(await fetchLlmsTxtLinkedMarkdown(ctx)).toEqual([]);
  });

  it('fetches same-origin links that serve markdown and records the Link header', async () => {
    server.use(
      http.get(
        'http://test.local/agents/a.md',
        () =>
          new HttpResponse('# A\n\n- one', {
            status: 200,
            headers: {
              'Content-Type': 'text/markdown',
              Link: '</agents/a.md?page=2>; rel="next"',
            },
          }),
      ),
      http.get(
        'http://test.local/agents/b',
        () =>
          new HttpResponse('# B\n\nPlain text type but markdown shape.', {
            status: 200,
            headers: { 'Content-Type': 'text/plain' },
          }),
      ),
      http.get(
        'http://test.local/agents/html',
        () =>
          new HttpResponse('<!doctype html><html><body>no</body></html>', {
            status: 200,
            headers: { 'Content-Type': 'text/html' },
          }),
      ),
      http.get(
        'http://test.local/agents/missing.md',
        () =>
          new HttpResponse('# Page Not Found', {
            status: 200,
            headers: { 'Content-Type': 'text/markdown' },
          }),
      ),
    );
    const ctx = ctxWithLlmsTxt(
      [
        '# Docs',
        '- [A](http://test.local/agents/a.md): a',
        '- [B](http://test.local/agents/b): b',
        '- [H](http://test.local/agents/html): html',
        '- [M](http://test.local/agents/missing.md): soft 404',
        '- [X](https://other.example/x.md): external',
      ].join('\n'),
    );

    const pages = await fetchLlmsTxtLinkedMarkdown(ctx);
    expect(pages.map((p) => p.url).sort()).toEqual([
      'http://test.local/agents/a.md',
      'http://test.local/agents/b',
    ]);
    const a = pages.find((p) => p.url.endsWith('a.md'))!;
    expect(a).toMatchObject({
      source: 'llms-txt-link',
      mdUrl: 'http://test.local/agents/a.md',
      linkHeader: '</agents/a.md?page=2>; rel="next"',
    });
  });

  it('records the post-redirect URL as the markdown URL', async () => {
    server.use(
      http.get('http://test.local/agents/old.md', () =>
        HttpResponse.redirect('http://test.local/agents/v2/new.md', 302),
      ),
      http.get(
        'http://test.local/agents/v2/new.md',
        () =>
          new HttpResponse('# New\n\n- one', {
            status: 200,
            headers: { 'Content-Type': 'text/markdown' },
          }),
      ),
    );
    const ctx = ctxWithLlmsTxt('# Docs\n- [Old](http://test.local/agents/old.md): moved');
    const [page] = await fetchLlmsTxtLinkedMarkdown(ctx);
    expect(page.url).toBe('http://test.local/agents/old.md');
    expect(page.mdUrl).toBe('http://test.local/agents/v2/new.md');
  });

  it('prefers .md links and caps at maxLinksToTest', async () => {
    const requested: string[] = [];
    server.use(
      http.get('http://test.local/agents/:name', ({ request }) => {
        requested.push(request.url);
        return new HttpResponse('# Page\n\n- one', {
          status: 200,
          headers: { 'Content-Type': 'text/markdown' },
        });
      }),
    );
    const ctx = ctxWithLlmsTxt(
      [
        '# Docs',
        '- [P1](http://test.local/agents/plain-1): p',
        '- [M1](http://test.local/agents/md-1.md): m',
        '- [P2](http://test.local/agents/plain-2): p',
        '- [M2](http://test.local/agents/md-2.md): m',
      ].join('\n'),
      { maxLinksToTest: 3 },
    );

    const pages = await fetchLlmsTxtLinkedMarkdown(ctx);
    expect(pages).toHaveLength(3);
    expect(requested.sort()).toEqual([
      'http://test.local/agents/md-1.md',
      'http://test.local/agents/md-2.md',
      'http://test.local/agents/plain-1',
    ]);
  });
});
