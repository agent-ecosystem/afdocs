import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { createContext } from '../../../src/runner.js';
import { getCheck } from '../../../src/checks/registry.js';
import '../../../src/checks/index.js';
import type { CheckContext, DiscoveredFile } from '../../../src/types.js';
import type { CompletenessPageResult } from '../../../src/checks/page-size/single-fetch-completeness.js';
import { mockSitemapNotFound } from '../../helpers/mock-sitemap-not-found.js';

const server = setupServer();

beforeAll(() => {
  server.listen({ onUnhandledRequest: 'bypass' });
  return () => server.close();
});

afterEach(() => server.resetHandlers());

const check = getCheck('single-fetch-completeness')!;
const ORIGIN = 'http://sfc.local';

function markdown(body: string, headers: Record<string, string> = {}) {
  return () =>
    new HttpResponse(body, {
      status: 200,
      headers: { 'Content-Type': 'text/markdown', ...headers },
    });
}

/** A catalog page: 100 short entries, ~2.5K characters, well under the size threshold. */
function catalog(entries = 100): string {
  return Array.from({ length: entries }, (_, i) => `- model-${i}: a model`).join('\n');
}

const COMPLETE_PAGE = `# Guide\n\nAn ordinary page with [a link](/docs/other.md).\n`;

/** Context with markdown-url-support marked as passed and pages in the cache. */
function cachedCtx(
  pages: Array<{ url: string; mdUrl?: string; content: string; linkHeader?: string }>,
  opts: Record<string, unknown> = {},
): CheckContext {
  const ctx = createContext(ORIGIN, { requestDelay: 0, ...opts });
  ctx.previousResults.set('markdown-url-support', {
    id: 'markdown-url-support',
    category: 'markdown-availability',
    status: 'pass',
    message: 'OK',
  });
  for (const p of pages) {
    ctx.pageCache.set(p.url, {
      url: p.url,
      markdown: {
        content: p.content,
        source: 'md-url',
        mdUrl: p.mdUrl ?? `${p.url}.md`,
        ...(p.linkHeader && { linkHeader: p.linkHeader }),
      },
    });
  }
  return ctx;
}

function pageResults(result: { details?: Record<string, unknown> }): CompletenessPageResult[] {
  return result.details?.pageResults as CompletenessPageResult[];
}

describe('single-fetch-completeness', () => {
  it('registers as a Category 3 check with the inverted OR-group prerequisite', () => {
    expect(check.category).toBe('page-size');
    expect(check.dependsOn).toEqual([
      ['markdown-url-support', 'content-negotiation', 'llms-txt-links-markdown'],
    ]);
  });

  it('passes complete pages with no pagination signals', async () => {
    const ctx = cachedCtx([
      { url: `${ORIGIN}/docs/a`, content: COMPLETE_PAGE },
      { url: `${ORIGIN}/docs/b`, content: `# B\n\nStep 2 of 5: run the installer.\n` },
    ]);
    const result = await check.run(ctx);
    expect(result.status).toBe('pass');
    expect(result.details?.paginatedPages).toBe(0);
    expect(result.details?.passBucket).toBe(2);
    expect(result.message).toBe(
      'All 2 markdown pages deliver complete content in one fetch (no pagination detected)',
    );
    for (const p of pageResults(result)) {
      expect(p.paginated).toBe(false);
      expect(p.issues).toEqual([]);
    }
  });

  it('passes pagination declared at the top with an absolute URL that resolves', async () => {
    const next = `${ORIGIN}/docs/models.md?page=2`;
    server.use(http.get(`${ORIGIN}/docs/models.md`, markdown(catalog(2))));
    const content = `# Models\n\n> Showing 100 of 102 models. Continue at [${next}](${next}).\n\n${catalog()}`;
    const ctx = cachedCtx([{ url: `${ORIGIN}/docs/models`, content }]);

    const result = await check.run(ctx);
    expect(result.status).toBe('pass');
    expect(result.details?.paginatedPages).toBe(1);
    const [page] = pageResults(result);
    expect(page.paginated).toBe(true);
    expect(page.continuation).toMatchObject({
      url: next,
      absolute: true,
      declaredIn: 'content',
      atTop: true,
      outcome: 'ok',
      status: 200,
    });
    expect(result.message).toContain('1 of 1 markdown pages paginate; every continuation works');
  });

  it('warns when the continuation works but is declared only at the bottom with a relative URL', async () => {
    server.use(http.get(`${ORIGIN}/docs/models`, markdown(catalog(2))));
    const content = `# Models\n\n${catalog()}\n\nShowing 100 of 102 models. [Next page](/docs/models?page=2)\n`;
    const ctx = cachedCtx([{ url: `${ORIGIN}/docs/models`, content }]);

    const result = await check.run(ctx);
    expect(result.status).toBe('warn');
    expect(result.details?.warnBucket).toBe(1);
    const [page] = pageResults(result);
    expect(page.continuation).toMatchObject({
      url: '/docs/models?page=2',
      resolvedUrl: `${ORIGIN}/docs/models?page=2`,
      absolute: false,
      atTop: false,
      outcome: 'ok',
    });
    expect(page.continuation?.positionPercent).toBeGreaterThan(90);
    expect(page.issues).toEqual([
      'relative URL',
      `declared at ${page.continuation?.positionPercent}% of content`,
    ]);
    expect(result.details?.reasons).toMatchObject({ relativeUrl: 1, declaredLate: 1 });
    expect(result.message).toContain('working but fragile continuation');
    expect(result.message).toContain('declared only late in the content (1)');
    expect(result.message).toContain('relative URL (1)');
  });

  it('warns when the continuation is discoverable only from the Link header', async () => {
    server.use(http.get(`${ORIGIN}/docs/models.md`, markdown(catalog(2))));
    const ctx = cachedCtx([
      {
        url: `${ORIGIN}/docs/models`,
        content: `# Models\n\n${catalog()}`,
        linkHeader: `<${ORIGIN}/docs/models.md?page=2>; rel="next"`,
      },
    ]);

    const result = await check.run(ctx);
    expect(result.status).toBe('warn');
    const [page] = pageResults(result);
    expect(page.signals).toEqual([
      { type: 'link-header', text: 'Link: rel="next"', url: `${ORIGIN}/docs/models.md?page=2` },
    ]);
    expect(page.continuation).toMatchObject({ declaredIn: 'header', atTop: false, outcome: 'ok' });
    expect(page.issues).toEqual(['discoverable only from the Link header']);
    expect(result.details?.reasons).toMatchObject({ headerOnly: 1 });
  });

  it('fails when the content is partial and no continuation link exists', async () => {
    const content = `# Models\n\n${catalog()}\n\nShowing 100 of 102 models.\n`;
    const ctx = cachedCtx([{ url: `${ORIGIN}/docs/models`, content }]);

    const result = await check.run(ctx);
    expect(result.status).toBe('fail');
    const [page] = pageResults(result);
    expect(page.continuation).toBeUndefined();
    expect(page.issues).toEqual(['no continuation link found']);
    expect(result.details?.reasons).toMatchObject({ missing: 1 });
    expect(result.message).toContain('1 of 1 markdown pages are partial');
    expect(result.message).toContain('no continuation link (1)');
  });

  it('fails when the continuation returns an empty body (the spec’s production case)', async () => {
    server.use(http.get(`${ORIGIN}/models`, markdown('')));
    const content = `# Models\n\n${catalog()}\n\nShowing 100 of 102 models. [Next page](/models?page=2)\n`;
    const ctx = cachedCtx([{ url: `${ORIGIN}/models`, content }]);

    const result = await check.run(ctx);
    expect(result.status).toBe('fail');
    const [page] = pageResults(result);
    expect(page.continuation).toMatchObject({ outcome: 'empty', status: 200 });
    expect(page.issues).toEqual(['continuation returned an empty body']);
    expect(result.details?.reasons).toMatchObject({ broken: 1 });
  });

  it('fails on a non-success status', async () => {
    server.use(
      http.get(`${ORIGIN}/docs/models.md`, () => new HttpResponse('nope', { status: 404 })),
    );
    const content = `# Models\n\n> Page 1 of 2: [next page](${ORIGIN}/docs/models.md?page=2)\n\n${catalog()}`;
    const result = await check.run(cachedCtx([{ url: `${ORIGIN}/docs/models`, content }]));
    expect(result.status).toBe('fail');
    const [page] = pageResults(result);
    expect(page.continuation).toMatchObject({ outcome: 'http-error', status: 404 });
    expect(page.issues).toEqual(['continuation returned HTTP 404']);
  });

  it('fails on a soft 404', async () => {
    server.use(
      http.get(`${ORIGIN}/docs/models.md`, markdown('# Page Not Found\n\nThat page is gone.')),
    );
    const content = `# Models\n\n> Page 1 of 2: [next page](${ORIGIN}/docs/models.md?page=2)\n\n${catalog()}`;
    const result = await check.run(cachedCtx([{ url: `${ORIGIN}/docs/models`, content }]));
    expect(pageResults(result)[0].continuation?.outcome).toBe('soft-404');
    expect(result.status).toBe('fail');
  });

  it('fails when the continuation serves HTML instead of markdown', async () => {
    server.use(
      http.get(
        `${ORIGIN}/models`,
        () =>
          new HttpResponse('<!doctype html><html><body>Models page 2</body></html>', {
            status: 200,
            headers: { 'Content-Type': 'text/html' },
          }),
      ),
    );
    const content = `# Models\n\n> Page 1 of 2: [next page](/models?page=2)\n\n${catalog()}`;
    const result = await check.run(cachedCtx([{ url: `${ORIGIN}/models`, content }]));
    expect(pageResults(result)[0].continuation?.outcome).toBe('not-markdown');
    expect(pageResults(result)[0].issues).toEqual(['continuation returned HTML, not markdown']);
    expect(result.status).toBe('fail');
  });

  it('fails when the server ignores the paging parameter and returns the same content', async () => {
    const content = `# Models\n\n> Page 1 of 2: [next page](${ORIGIN}/docs/models.md?page=2)\n\n${catalog()}`;
    server.use(http.get(`${ORIGIN}/docs/models.md`, markdown(content)));
    const result = await check.run(cachedCtx([{ url: `${ORIGIN}/docs/models`, content }]));
    expect(pageResults(result)[0].continuation?.outcome).toBe('same-content');
    expect(result.status).toBe('fail');
  });

  it('sends Accept: text/markdown when verifying the continuation', async () => {
    let accept: string | null = null;
    server.use(
      http.get(`${ORIGIN}/docs/models.md`, ({ request }) => {
        accept = request.headers.get('accept');
        return markdown(catalog(2))();
      }),
    );
    const content = `# Models\n\n> Page 1 of 2: [next page](${ORIGIN}/docs/models.md?page=2)\n\n${catalog()}`;
    await check.run(cachedCtx([{ url: `${ORIGIN}/docs/models`, content }]));
    expect(accept).toBe('text/markdown');
  });

  it('resolves relative continuations against the markdown URL, not the page URL', async () => {
    let requested: string | null = null;
    server.use(
      http.get(`${ORIGIN}/md/models/page-2.md`, ({ request }) => {
        requested = request.url;
        return markdown(catalog(2))();
      }),
    );
    const content = `# Models\n\n> Page 1 of 2: [next page](page-2.md)\n\n${catalog()}`;
    const result = await check.run(
      cachedCtx([
        { url: `${ORIGIN}/docs/models`, mdUrl: `${ORIGIN}/md/models/page-1.md`, content },
      ]),
    );
    expect(requested).toBe(`${ORIGIN}/md/models/page-2.md`);
    // Relative, so fragile even though it resolves and works.
    expect(result.status).toBe('warn');
    expect(pageResults(result)[0].issues).toEqual(['relative URL']);
  });

  it('scores proportionally across pages and reports the worst status', async () => {
    server.use(http.get(`${ORIGIN}/docs/models.md`, markdown(catalog(2))));
    const ctx = cachedCtx([
      { url: `${ORIGIN}/docs/a`, content: COMPLETE_PAGE },
      { url: `${ORIGIN}/docs/b`, content: COMPLETE_PAGE },
      {
        url: `${ORIGIN}/docs/models`,
        content: `# Models\n\n${catalog()}\n\n[Next page](${ORIGIN}/docs/models.md?page=2)`,
      },
      {
        url: `${ORIGIN}/docs/partial`,
        content: `# Partial\n\n${catalog()}\n\nShowing 100 of 250 models.`,
      },
    ]);
    const result = await check.run(ctx);
    expect(result.status).toBe('fail');
    expect(result.details).toMatchObject({
      totalPages: 4,
      testedPages: 4,
      paginatedPages: 2,
      passBucket: 2,
      warnBucket: 1,
      failBucket: 1,
    });
    expect(result.message).toContain('1 of 4 markdown pages are partial');
    expect(result.message).toContain('; 1 more fragile');
  });

  it('ignores llms.txt files themselves', async () => {
    const ctx = cachedCtx([{ url: `${ORIGIN}/docs/a`, content: COMPLETE_PAGE }]);
    const discovered: DiscoveredFile[] = [
      {
        url: `${ORIGIN}/llms.txt`,
        content: `# Docs\n\nShowing 10 of 500 pages.\n\n- [A](${ORIGIN}/docs/a)`,
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
    const result = await check.run(ctx);
    expect(result.status).toBe('pass');
    expect(result.details?.totalPages).toBe(1);
  });

  it('skips when the markdown-availability checks ran and the site serves no markdown', async () => {
    const ctx = createContext(ORIGIN, { requestDelay: 0 });
    ctx.previousResults.set('markdown-url-support', {
      id: 'markdown-url-support',
      category: 'markdown-availability',
      status: 'fail',
      message: 'None',
    });
    const result = await check.run(ctx);
    expect(result.status).toBe('skip');
    expect(result.message).toContain('does not serve markdown by any detected path');
  });

  it('falls back to llms.txt-linked markdown when the page cache is empty', async () => {
    const content = `# Docs\n> Summary\n## Links\n- [Models](${ORIGIN}/agents/models.md): Catalog\n- [Guide](${ORIGIN}/agents/guide.md): Guide\n- [Elsewhere](https://other.example/x.md): External\n`;
    server.use(
      http.get(
        `${ORIGIN}/agents/models.md`,
        markdown(`# Models\n\n${catalog()}\n\nShowing 100 of 102 models.`),
      ),
      http.get(`${ORIGIN}/agents/guide.md`, markdown(COMPLETE_PAGE)),
    );
    mockSitemapNotFound(server, ORIGIN);

    const ctx = createContext(ORIGIN, { requestDelay: 0 });
    const discovered: DiscoveredFile[] = [
      { url: `${ORIGIN}/llms.txt`, content, status: 200, redirected: false },
    ];
    ctx.previousResults.set('llms-txt-exists', {
      id: 'llms-txt-exists',
      category: 'content-discoverability',
      status: 'pass',
      message: 'Found',
      details: { discoveredFiles: discovered },
    });
    // The page-level checks found nothing, but llms.txt links to markdown.
    ctx.previousResults.set('markdown-url-support', {
      id: 'markdown-url-support',
      category: 'markdown-availability',
      status: 'fail',
      message: 'None',
    });
    ctx.previousResults.set('llms-txt-links-markdown', {
      id: 'llms-txt-links-markdown',
      category: 'content-discoverability',
      status: 'pass',
      message: 'Markdown links',
    });

    const result = await check.run(ctx);
    expect(result.status).toBe('fail');
    expect(result.details?.viaLlmsTxtLinks).toBe(true);
    expect(result.details?.totalPages).toBe(2);
    const partial = pageResults(result).find((p) => p.url.endsWith('models.md'))!;
    expect(partial.source).toBe('llms-txt-link');
    expect(partial.mdUrl).toBe(`${ORIGIN}/agents/models.md`);
    expect(partial.issues).toEqual(['no continuation link found']);
  });

  it('runs standalone when no dependency ran, fetching markdown itself', async () => {
    const llmsTxt = `# Docs\n> Summary\n## Links\n- [Page](${ORIGIN}/docs/page): A page\n`;
    server.use(
      http.get(`${ORIGIN}/llms.txt`, markdown(llmsTxt)),
      http.get(`${ORIGIN}/docs/llms.txt`, () => new HttpResponse('', { status: 404 })),
      http.get(`${ORIGIN}/docs/page.md`, markdown(COMPLETE_PAGE)),
    );
    mockSitemapNotFound(server, ORIGIN);

    const ctx = createContext(ORIGIN, { requestDelay: 0 });
    const result = await check.run(ctx);
    expect(result.status).toBe('pass');
    expect(result.details?.totalPages).toBe(1);
    expect(pageResults(result)[0].mdUrl).toBe(`${ORIGIN}/docs/page.md`);
  });

  it('records the pass size threshold for the fix text', async () => {
    const ctx = cachedCtx([{ url: `${ORIGIN}/docs/a`, content: COMPLETE_PAGE }], {
      thresholds: { pass: 20_000, fail: 40_000 },
    });
    const result = await check.run(ctx);
    expect(result.details?.thresholds).toEqual({ pass: 20_000 });
  });
});
