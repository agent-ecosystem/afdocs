import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { createContext } from '../../../src/runner.js';
import { getCheck } from '../../../src/checks/registry.js';
import '../../../src/checks/index.js';
import type { CheckContext, DiscoveredFile } from '../../../src/types.js';
import type { PortabilityPageResult } from '../../../src/checks/content-structure/markdown-link-portability.js';
import { mockSitemapNotFound } from '../../helpers/mock-sitemap-not-found.js';

const server = setupServer();

beforeAll(() => {
  server.listen({ onUnhandledRequest: 'bypass' });
  return () => server.close();
});

afterEach(() => server.resetHandlers());

const check = getCheck('markdown-link-portability')!;
const ORIGIN = 'http://mlp.local';

function markdown(body: string, headers: Record<string, string> = {}) {
  return () =>
    new HttpResponse(body, {
      status: 200,
      headers: { 'Content-Type': 'text/markdown', ...headers },
    });
}

function html(body: string, status = 200) {
  return () => new HttpResponse(body, { status, headers: { 'Content-Type': 'text/html' } });
}

/** An HTML SPA shell: 200, a body, and nothing that says it failed. */
const SPA_SHELL =
  '<!doctype html><html><head><title>Example</title></head><body><div id="root"></div>' +
  '<script>window.__NEXT_DATA__={"err":{"digest":"NEXT_NOT_FOUND"}}</script></body></html>';

/** Context with markdown-url-support marked as passed and pages in the cache. */
function cachedCtx(
  pages: Array<{ url: string; mdUrl?: string; content: string }>,
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
      markdown: { content: p.content, source: 'md-url', mdUrl: p.mdUrl ?? `${p.url}.md` },
    });
  }
  return ctx;
}

function pageResults(result: { details?: Record<string, unknown> }): PortabilityPageResult[] {
  return result.details?.pageResults as PortabilityPageResult[];
}

describe('markdown-link-portability', () => {
  it('registers as a Category 4 check with the inverted OR-group prerequisite', () => {
    expect(check.category).toBe('content-structure');
    expect(check.dependsOn).toEqual([
      ['markdown-url-support', 'content-negotiation', 'llms-txt-links-markdown'],
    ]);
  });

  it('passes absolute links that resolve to the representation they promise', async () => {
    server.use(http.get(`${ORIGIN}/docs/b.md`, markdown('# B\n\nContent.\n')));
    const content = `# A\n\nSee [B](${ORIGIN}/docs/b.md) and [jump](#usage).\n`;
    const ctx = cachedCtx([{ url: `${ORIGIN}/docs/a`, content }]);

    const result = await check.run(ctx);
    expect(result.status).toBe('pass');
    expect(result.details?.passBucket).toBe(1);
    const [page] = pageResults(result);
    expect(page.links).toMatchObject({ absolute: 1, fragment: 1, rootRelative: 0 });
    expect(page.samples).toEqual([
      {
        url: `${ORIGIN}/docs/b.md`,
        resolvedUrl: `${ORIGIN}/docs/b.md`,
        promisesMarkdown: true,
        outcome: 'ok',
        status: 200,
      },
    ]);
    expect(result.message).toContain('are absolute');
  });

  it('passes a page with no links at all', async () => {
    const ctx = cachedCtx([{ url: `${ORIGIN}/docs/a`, content: '# A\n\nJust prose.\n' }]);
    const result = await check.run(ctx);
    expect(result.status).toBe('pass');
    expect(result.message).toBe('No links found in 1 markdown pages');
  });

  it('warns on root-relative links that still resolve', async () => {
    server.use(http.get(`${ORIGIN}/docs/b.md`, markdown('# B\n\nContent.\n')));
    const content = '# A\n\nSee [B](/docs/b.md).\n';
    const ctx = cachedCtx([{ url: `${ORIGIN}/docs/a`, content }]);

    const result = await check.run(ctx);
    expect(result.status).toBe('warn');
    const [page] = pageResults(result);
    expect(page.links.rootRelative).toBe(1);
    expect(page.samples[0].outcome).toBe('ok');
    expect(page.issues).toEqual(['1 root-relative link']);
    expect(result.message).toContain('root-relative links (1)');
  });

  it('counts protocol-relative links with the root-relative ones', async () => {
    server.use(http.get(`${ORIGIN}/docs/b.md`, markdown('# B\n\nContent.\n')));
    const content = `# A\n\nSee [B](//mlp.local/docs/b.md).\n`;
    const ctx = cachedCtx([{ url: `${ORIGIN}/docs/a`, content }]);

    const result = await check.run(ctx);
    expect(result.status).toBe('warn');
    expect(pageResults(result)[0].links.protocolRelative).toBe(1);
  });

  it('fails on path-relative links even when they resolve', async () => {
    server.use(http.get(`${ORIGIN}/md/docs/b.md`, markdown('# B\n\nContent.\n')));
    const content = '# A\n\nSee [B](b.md).\n';
    const ctx = cachedCtx([{ url: `${ORIGIN}/docs/a`, mdUrl: `${ORIGIN}/md/docs/a.md`, content }]);

    const result = await check.run(ctx);
    expect(result.status).toBe('fail');
    const [page] = pageResults(result);
    expect(page.links.pathRelative).toBe(1);
    // Resolved against the markdown URL, not the page URL.
    expect(page.samples[0].resolvedUrl).toBe(`${ORIGIN}/md/docs/b.md`);
    expect(page.samples[0].outcome).toBe('ok');
    expect(result.message).toContain('path-relative links (1)');
  });

  it('fails a .md link that returns an HTML shell with a 200, the grounding case', async () => {
    server.use(http.get(`${ORIGIN}/wrong/b.md`, html(SPA_SHELL)));
    const content = `# A\n\nSee [B](${ORIGIN}/wrong/b.md).\n`;
    const ctx = cachedCtx([{ url: `${ORIGIN}/docs/a`, content }]);

    const result = await check.run(ctx);
    expect(result.status).toBe('fail');
    const [page] = pageResults(result);
    expect(page.samples[0]).toMatchObject({ outcome: 'not-markdown', status: 200 });
    expect(page.issues).toEqual([`${ORIGIN}/wrong/b.md returned HTML, not markdown`]);
    expect(result.message).toContain('broken sampled links (1)');
  });

  it('fails a link that hard 404s and one that soft 404s', async () => {
    server.use(
      http.get(`${ORIGIN}/gone.md`, () => new HttpResponse('nope', { status: 404 })),
      http.get(`${ORIGIN}/soft.md`, markdown('# Page Not Found\n\nTry the index.\n')),
    );
    const ctx = cachedCtx([
      { url: `${ORIGIN}/docs/a`, content: `# A\n\n[gone](${ORIGIN}/gone.md)\n` },
      { url: `${ORIGIN}/docs/b`, content: `# B\n\n[soft](${ORIGIN}/soft.md)\n` },
    ]);

    const result = await check.run(ctx);
    expect(result.status).toBe('fail');
    const outcomes = pageResults(result).map((p) => p.samples[0].outcome);
    expect(outcomes).toEqual(['http-error', 'soft-404']);
    expect(result.details?.brokenSamples).toBe(2);
  });

  it('fails a link that returns an empty body', async () => {
    server.use(http.get(`${ORIGIN}/empty.md`, markdown('   \n')));
    const ctx = cachedCtx([
      { url: `${ORIGIN}/docs/a`, content: `# A\n\n[empty](${ORIGIN}/empty.md)\n` },
    ]);
    const result = await check.run(ctx);
    expect(result.status).toBe('fail');
    expect(pageResults(result)[0].samples[0].outcome).toBe('empty');
  });

  it('warns when a .md link redirects to an HTML page with real content', async () => {
    server.use(
      http.get(`${ORIGIN}/docs/b.md`, () => HttpResponse.redirect(`${ORIGIN}/docs/b`, 302)),
      http.get(
        `${ORIGIN}/docs/b`,
        html('<!doctype html><html><body><h1>B</h1><p>Real content.</p></body></html>'),
      ),
    );
    const content = `# A\n\nSee [B](${ORIGIN}/docs/b.md).\n`;
    const ctx = cachedCtx([{ url: `${ORIGIN}/docs/a`, content }]);

    const result = await check.run(ctx);
    expect(result.status).toBe('warn');
    const [page] = pageResults(result);
    expect(page.samples[0]).toMatchObject({
      outcome: 'html-redirect',
      redirectedTo: `${ORIGIN}/docs/b`,
    });
    expect(result.message).toContain('.md links redirecting to HTML (1)');
  });

  it('fails a .md link that redirects to another .md URL still serving HTML', async () => {
    // The final URL still promises markdown, so this is the SPA-shell failure
    // with a redirect in front of it, not the spec's minor mismatch.
    server.use(
      http.get(`${ORIGIN}/docs/b.md`, () => HttpResponse.redirect(`${ORIGIN}/moved/b.md`, 302)),
      http.get(`${ORIGIN}/moved/b.md`, html(SPA_SHELL)),
    );
    const ctx = cachedCtx([
      { url: `${ORIGIN}/docs/a`, content: `# A\n\n[B](${ORIGIN}/docs/b.md)\n` },
    ]);

    const result = await check.run(ctx);
    expect(result.status).toBe('fail');
    expect(pageResults(result)[0].samples[0]).toMatchObject({
      outcome: 'not-markdown',
      redirectedTo: `${ORIGIN}/moved/b.md`,
    });
  });

  it('fails a page whose link never parsed as a URL rather than counting it absolute', async () => {
    const ctx = cachedCtx([{ url: `${ORIGIN}/docs/a`, content: '# A\n\n[broken](https://[)\n' }]);
    const result = await check.run(ctx);
    expect(result.status).toBe('fail');
    const [page] = pageResults(result);
    expect(page.links).toMatchObject({ absolute: 1, unresolvable: 1 });
    expect(page.samples).toEqual([]);
    expect(page.issues).toEqual(['1 malformed link that never parsed as a URL']);
    expect(result.message).toContain('malformed links (1)');
  });

  it('fails a .md link that declares a non-text content type', async () => {
    // One bracket in a JSON string must not sniff its way past an explicit
    // contradictory type.
    server.use(
      http.get(`${ORIGIN}/api/b.md`, () =>
        HttpResponse.json({ note: 'see [guide](/guide) for details' }),
      ),
    );
    const ctx = cachedCtx([
      { url: `${ORIGIN}/docs/a`, content: `# A\n\n[B](${ORIGIN}/api/b.md)\n` },
    ]);

    const result = await check.run(ctx);
    expect(result.status).toBe('fail');
    expect(pageResults(result)[0].samples[0]).toMatchObject({
      outcome: 'not-markdown',
      status: 200,
    });
  });

  it('accepts a .md link served as text/plain', async () => {
    server.use(
      http.get(
        `${ORIGIN}/docs/b.md`,
        () =>
          new HttpResponse('# B\n\nContent.\n', {
            status: 200,
            headers: { 'Content-Type': 'text/plain; charset=utf-8' },
          }),
      ),
    );
    const ctx = cachedCtx([
      { url: `${ORIGIN}/docs/a`, content: `# A\n\n[B](${ORIGIN}/docs/b.md)\n` },
    ]);

    const result = await check.run(ctx);
    expect(result.status).toBe('pass');
    expect(pageResults(result)[0].samples[0].outcome).toBe('ok');
  });

  it('sniffs the body when the response declares no content type', async () => {
    server.use(
      http.get(`${ORIGIN}/docs/b.md`, () => new HttpResponse('# B\n\nContent.\n', { status: 200 })),
    );
    const ctx = cachedCtx([
      { url: `${ORIGIN}/docs/a`, content: `# A\n\n[B](${ORIGIN}/docs/b.md)\n` },
    ]);

    const result = await check.run(ctx);
    expect(result.status).toBe('pass');
    expect(pageResults(result)[0].samples[0].outcome).toBe('ok');
  });

  it('still catches an HTML shell that declares text/markdown', async () => {
    // Sniffing may not rescue a contradictory type, but it must still condemn.
    server.use(
      http.get(
        `${ORIGIN}/docs/b.md`,
        () =>
          new HttpResponse(SPA_SHELL, {
            status: 200,
            headers: { 'Content-Type': 'text/markdown' },
          }),
      ),
    );
    const ctx = cachedCtx([
      { url: `${ORIGIN}/docs/a`, content: `# A\n\n[B](${ORIGIN}/docs/b.md)\n` },
    ]);

    const result = await check.run(ctx);
    expect(result.status).toBe('fail');
    expect(pageResults(result)[0].samples[0].outcome).toBe('not-markdown');
  });

  it('accepts HTML for a link that never promised markdown', async () => {
    server.use(http.get(`${ORIGIN}/docs/b`, html('<!doctype html><html><body>B</body></html>')));
    const content = `# A\n\nSee [B](${ORIGIN}/docs/b).\n`;
    const ctx = cachedCtx([{ url: `${ORIGIN}/docs/a`, content }]);

    const result = await check.run(ctx);
    expect(result.status).toBe('pass');
    expect(pageResults(result)[0].samples[0].outcome).toBe('ok');
  });

  it('does not negotiate a representation the .md path already asked for', async () => {
    // MongoDB's docs answer a .md URL with 404 when the request asks for
    // text/markdown, and with 200 markdown when it doesn't. Negotiating here
    // would report their links as broken and blame link generation for it.
    let accept: string | null = 'unset';
    server.use(
      http.get(`${ORIGIN}/docs/b.md`, ({ request }) => {
        accept = request.headers.get('accept');
        return new HttpResponse('# B\n\nContent.\n', {
          status: 200,
          headers: { 'Content-Type': 'text/markdown' },
        });
      }),
    );
    const ctx = cachedCtx([
      { url: `${ORIGIN}/docs/a`, content: `# A\n\n[B](${ORIGIN}/docs/b.md)\n` },
    ]);

    const result = await check.run(ctx);
    expect(result.status).toBe('pass');
    expect(accept ?? '').not.toContain('text/markdown');
  });

  it('never sends a fragment to the server, and fetches two anchors once', async () => {
    const requested: string[] = [];
    server.use(
      http.get(`${ORIGIN}/docs/b.md`, ({ request }) => {
        requested.push(request.url);
        return new HttpResponse('# B\n\nContent.\n', {
          status: 200,
          headers: { 'Content-Type': 'text/markdown' },
        });
      }),
    );
    const content = `# A\n\n[one](${ORIGIN}/docs/b.md#first) and [two](${ORIGIN}/docs/b.md#second)\n`;
    const ctx = cachedCtx([{ url: `${ORIGIN}/docs/a`, content }]);

    const result = await check.run(ctx);
    expect(result.status).toBe('pass');
    expect(requested).toEqual([`${ORIGIN}/docs/b.md`]);
    expect(result.details?.linksVerified).toBe(1);
    expect(pageResults(result)[0].samples).toHaveLength(1);
  });

  it('classifies cross-origin links as absolute but never fetches them', async () => {
    let externalHits = 0;
    server.use(
      http.get('https://external.example/a.md', () => {
        externalHits++;
        return new HttpResponse('nope', { status: 404 });
      }),
    );
    const content = '# A\n\nSee [ext](https://external.example/a.md).\n';
    const ctx = cachedCtx([{ url: `${ORIGIN}/docs/a`, content }]);

    const result = await check.run(ctx);
    expect(result.status).toBe('pass');
    expect(externalHits).toBe(0);
    const [page] = pageResults(result);
    expect(page.links).toMatchObject({ absolute: 1, crossOrigin: 1 });
    expect(page.samples).toEqual([]);
  });

  it('never spends a request on fragments or non-HTTP schemes', async () => {
    const content = '# A\n\n[jump](#usage) [mail](mailto:docs@example.com)\n';
    const ctx = cachedCtx([{ url: `${ORIGIN}/docs/a`, content }]);
    const result = await check.run(ctx);
    expect(result.status).toBe('pass');
    expect(result.details?.linksVerified).toBe(0);
    expect(pageResults(result)[0].links).toMatchObject({ fragment: 1, otherScheme: 1 });
  });

  it('spreads the link budget across pages and fetches a shared link once', async () => {
    let bHits = 0;
    server.use(
      http.get(`${ORIGIN}/shared.md`, () => {
        bHits++;
        return new HttpResponse('# Shared\n\nContent.\n', {
          status: 200,
          headers: { 'Content-Type': 'text/markdown' },
        });
      }),
    );
    const content = `# Page\n\n[shared](${ORIGIN}/shared.md)\n`;
    const ctx = cachedCtx(
      [
        { url: `${ORIGIN}/docs/a`, content },
        { url: `${ORIGIN}/docs/b`, content },
        { url: `${ORIGIN}/docs/c`, content },
      ],
      { maxLinksToTest: 3 },
    );

    const result = await check.run(ctx);
    expect(result.status).toBe('pass');
    expect(bHits).toBe(1);
    expect(result.details?.linksVerified).toBe(1);
    expect(result.details?.perPageQuota).toBe(1);
    // Every page still gets the outcome, without a second request.
    expect(pageResults(result).map((p) => p.samples.length)).toEqual([1, 1, 1]);
  });

  it('tries links that promise markdown before the rest when the quota is small', async () => {
    const fetched: string[] = [];
    server.use(
      http.get(`${ORIGIN}/*`, ({ request }) => {
        fetched.push(new URL(request.url).pathname);
        return new HttpResponse('# X\n\nContent.\n', {
          status: 200,
          headers: { 'Content-Type': 'text/markdown' },
        });
      }),
    );
    const content = `# A\n\n[html](${ORIGIN}/first) then [md](${ORIGIN}/second.md)\n`;
    const ctx = cachedCtx([{ url: `${ORIGIN}/docs/a`, content }], { maxLinksToTest: 1 });

    await check.run(ctx);
    expect(fetched).toEqual(['/second.md']);
  });

  it('skips when the site serves no markdown by any detected path', async () => {
    const ctx = createContext(ORIGIN, { requestDelay: 0 });
    ctx.previousResults.set('markdown-url-support', {
      id: 'markdown-url-support',
      category: 'markdown-availability',
      status: 'fail',
      message: 'no',
    });
    const result = await check.run(ctx);
    expect(result.status).toBe('skip');
    expect(result.message).toContain('does not serve markdown by any detected path');
  });

  it('falls back to markdown linked from llms.txt when the page cache is empty', async () => {
    mockSitemapNotFound(server, ORIGIN);
    server.use(
      http.get(`${ORIGIN}/docs/one.md`, markdown('# One\n\nSee [two](/docs/two.md).\n')),
      http.get(`${ORIGIN}/docs/two.md`, markdown('# Two\n\nContent.\n')),
    );
    const ctx = createContext(ORIGIN, { requestDelay: 0 });
    ctx.previousResults.set('markdown-url-support', {
      id: 'markdown-url-support',
      category: 'markdown-availability',
      status: 'fail',
      message: 'no',
    });
    const discoveredFiles: DiscoveredFile[] = [
      {
        url: `${ORIGIN}/llms.txt`,
        content: `# Site\n\n- [One](${ORIGIN}/docs/one.md)\n`,
        status: 200,
        redirected: false,
      },
    ];
    ctx.previousResults.set('llms-txt-exists', {
      id: 'llms-txt-exists',
      category: 'content-discoverability',
      status: 'pass',
      message: 'found',
      details: { discoveredFiles },
    });

    const result = await check.run(ctx);
    expect(result.status).toBe('warn');
    expect(result.details?.viaLlmsTxtLinks).toBe(true);
    expect(pageResults(result)[0].links.rootRelative).toBe(1);
  });

  it('ignores links inside the llms.txt files themselves', async () => {
    server.use(http.get(`${ORIGIN}/docs/b.md`, markdown('# B\n\nContent.\n')));
    const ctx = cachedCtx([
      { url: `${ORIGIN}/docs/a`, content: `# A\n\n[B](${ORIGIN}/docs/b.md)\n` },
    ]);
    ctx.previousResults.set('llms-txt-exists', {
      id: 'llms-txt-exists',
      category: 'content-discoverability',
      status: 'pass',
      message: 'found',
      details: {
        discoveredFiles: [
          {
            url: `${ORIGIN}/llms.txt`,
            content: '# Site\n\n- [Rel](/docs/a.md)\n',
            status: 200,
            redirected: false,
          },
        ],
      },
    });

    const result = await check.run(ctx);
    expect(result.status).toBe('pass');
    expect(pageResults(result)).toHaveLength(1);
    expect(pageResults(result)[0].url).toBe(`${ORIGIN}/docs/a`);
  });

  it('reports images separately and never lets them decide the status', async () => {
    server.use(http.get(`${ORIGIN}/docs/b.md`, markdown('# B\n\nContent.\n')));
    const content = `# A\n\n![flow](../img/flow.png)\n\n[B](${ORIGIN}/docs/b.md)\n`;
    const ctx = cachedCtx([{ url: `${ORIGIN}/docs/a`, content }]);

    const result = await check.run(ctx);
    expect(result.status).toBe('pass');
    const [page] = pageResults(result);
    expect(page.images).toMatchObject({ pathRelative: 1, total: 1 });
    expect(page.links.pathRelative).toBe(0);
  });
});
