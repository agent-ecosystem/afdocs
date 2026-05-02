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

describe('content-start-position', () => {
  const check = getCheck('content-start-position')!;

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

  function singlePageCtx(path: string) {
    return makeCtx(`# Docs\n> Summary\n## Links\n- [Page](http://test.local${path}): A page\n`);
  }

  // ── Setext heading detection ──

  it('passes when content starts immediately (setext heading)', async () => {
    // Turndown converts <h1> to setext (underline) style by default
    server.use(
      http.get(
        'http://test.local/docs/csp-pass',
        () =>
          new HttpResponse(
            '<html><body><h1>Getting Started</h1><p>Welcome to our documentation.</p></body></html>',
            { status: 200, headers: { 'Content-Type': 'text/html' } },
          ),
      ),
    );

    const result = await check.run(singlePageCtx('/docs/csp-pass'));
    expect(result.status).toBe('pass');
    expect(result.details?.medianPercent).toBe(0);
  });

  // ── ATX heading detection ──

  it('passes when content starts with an ATX heading (h3–h4)', async () => {
    // Turndown uses ATX style for h3+
    server.use(
      http.get(
        'http://test.local/docs/csp-atx',
        () =>
          new HttpResponse(
            '<html><body><h3>API Reference</h3><p>Endpoint details below.</p></body></html>',
            { status: 200, headers: { 'Content-Type': 'text/html' } },
          ),
      ),
    );

    const result = await check.run(singlePageCtx('/docs/csp-atx'));
    expect(result.status).toBe('pass');
    const pageResults = result.details?.pageResults as Array<{ contentStartPercent: number }>;
    expect(pageResults[0].contentStartPercent).toBe(0);
  });

  // ── CSS skip pattern ──

  it('skips CSS-like lines before content', async () => {
    // Inline <style> content sometimes leaks through Turndown as plain text.
    // Simulate this with a page that has CSS text before the heading.
    const html = `<html><body>
      <div>color: red;</div>
      <div>font-size: 14px;</div>
      <h1>Real Content</h1>
      <p>Documentation starts here.</p>
    </body></html>`;

    server.use(
      http.get(
        'http://test.local/docs/csp-css',
        () => new HttpResponse(html, { status: 200, headers: { 'Content-Type': 'text/html' } }),
      ),
    );

    const result = await check.run(singlePageCtx('/docs/csp-css'));
    // Content should be found (the heading after CSS), not at position 0
    const pageResults = result.details?.pageResults as Array<{
      contentStartChar: number;
      totalChars: number;
    }>;
    expect(pageResults[0].contentStartChar).toBeGreaterThan(0);
    expect(pageResults[0].totalChars).toBeGreaterThan(0);
  });

  // ── JS skip pattern ──

  it('skips JS-like lines before content', async () => {
    const html = `<html><body>
      <div>function init() {</div>
      <div>const x = 42;</div>
      <div>// some comment</div>
      <h1>Documentation</h1>
      <p>Actual content here.</p>
    </body></html>`;

    server.use(
      http.get(
        'http://test.local/docs/csp-js',
        () => new HttpResponse(html, { status: 200, headers: { 'Content-Type': 'text/html' } }),
      ),
    );

    const result = await check.run(singlePageCtx('/docs/csp-js'));
    const pageResults = result.details?.pageResults as Array<{ contentStartChar: number }>;
    expect(pageResults[0].contentStartChar).toBeGreaterThan(0);
  });

  // ── Nav-like token skip ──

  it('skips short nav-like tokens before content', async () => {
    const html = `<html><body>
      <span>Home</span>
      <span>Docs</span>
      <span>API</span>
      <h1>Welcome</h1>
      <p>This is the main documentation page.</p>
    </body></html>`;

    server.use(
      http.get(
        'http://test.local/docs/csp-nav',
        () => new HttpResponse(html, { status: 200, headers: { 'Content-Type': 'text/html' } }),
      ),
    );

    const result = await check.run(singlePageCtx('/docs/csp-nav'));
    const pageResults = result.details?.pageResults as Array<{ contentStartChar: number }>;
    expect(pageResults[0].contentStartChar).toBeGreaterThan(0);
  });

  // ── Prose paragraph detection (no heading) ──

  it('detects a prose paragraph as content start when no heading present', async () => {
    const html = `<html><body>
      <span>Menu</span>
      <p>This documentation explains how to integrate our API into your application.</p>
    </body></html>`;

    server.use(
      http.get(
        'http://test.local/docs/csp-prose',
        () => new HttpResponse(html, { status: 200, headers: { 'Content-Type': 'text/html' } }),
      ),
    );

    const result = await check.run(singlePageCtx('/docs/csp-prose'));
    const pageResults = result.details?.pageResults as Array<{
      contentStartChar: number;
      totalChars: number;
    }>;
    // Should find the paragraph, not the "Menu" token
    expect(pageResults[0].contentStartChar).toBeGreaterThan(0);
    expect(pageResults[0].contentStartChar).toBeLessThan(pageResults[0].totalChars);
  });

  // ── All-boilerplate fallback ──

  it('reports 100% when page has no meaningful content', async () => {
    // Page with only short nav-like tokens, no headings, no prose
    const html = `<html><body>
      <span>Home</span>
      <span>Login</span>
      <span>Menu</span>
    </body></html>`;

    server.use(
      http.get(
        'http://test.local/docs/csp-empty',
        () => new HttpResponse(html, { status: 200, headers: { 'Content-Type': 'text/html' } }),
      ),
    );

    const result = await check.run(singlePageCtx('/docs/csp-empty'));
    expect(result.status).toBe('fail');
    const pageResults = result.details?.pageResults as Array<{ contentStartPercent: number }>;
    expect(pageResults[0].contentStartPercent).toBeGreaterThan(50);
  });

  // ── Empty markdown (totalChars === 0) ──

  it('handles empty HTML gracefully', async () => {
    server.use(
      http.get(
        'http://test.local/docs/csp-blank',
        () => new HttpResponse('', { status: 200, headers: { 'Content-Type': 'text/html' } }),
      ),
    );

    const result = await check.run(singlePageCtx('/docs/csp-blank'));
    const pageResults = result.details?.pageResults as Array<{ contentStartPercent: number }>;
    // 0% when totalChars is 0
    expect(pageResults[0].contentStartPercent).toBe(0);
    expect(result.status).toBe('pass');
  });

  // ── Status threshold: warn (10–50%) ──

  it('warns when content starts between 10–50%', async () => {
    // Build HTML where nav boilerplate pushes content start to ~25%.
    // Nav links are skipped by the link-density heuristic, so we need enough
    // of them relative to the content to land in the 10-50% range.
    const navLinks = Array.from(
      { length: 10 },
      (_, i) => `<li><a href="/nav${i}">Navigation Link Item ${i}</a></li>`,
    ).join('');
    // Enough content paragraphs so nav is ~25% of total, not >50%
    const contentParagraphs = Array.from(
      { length: 10 },
      (_, i) =>
        `<p>This is documentation paragraph ${i} with enough words to be substantial real content that agents would process.</p>`,
    ).join('');
    const html = `<html><body><nav><ul>${navLinks}</ul></nav><article><h1>Content Title</h1>${contentParagraphs}</article></body></html>`;

    server.use(
      http.get(
        'http://test.local/docs/csp-warnp',
        () => new HttpResponse(html, { status: 200, headers: { 'Content-Type': 'text/html' } }),
      ),
    );

    const result = await check.run(singlePageCtx('/docs/csp-warnp'));
    const pageResults = result.details?.pageResults as Array<{
      contentStartPercent: number;
      status: string;
    }>;
    expect(pageResults[0].contentStartPercent).toBeGreaterThan(10);
    expect(pageResults[0].contentStartPercent).toBeLessThanOrEqual(50);
    expect(result.status).toBe('warn');
    expect(result.details?.warnBucket).toBe(1);
    expect(result.message).toContain('10–50%');
  });

  // ── Status threshold: fail (>50%) ──

  it('fails when content starts past 50%', async () => {
    // Massive nav boilerplate before a tiny content section
    const navLinks = Array.from(
      { length: 100 },
      (_, i) => `<li><a href="/nav${i}">Navigation Link ${i}</a></li>`,
    ).join('');
    const html = `<html><body><nav><ul>${navLinks}</ul></nav><h3>Tiny Content</h3><p>A short paragraph of documentation.</p></body></html>`;

    server.use(
      http.get(
        'http://test.local/docs/csp-failp',
        () => new HttpResponse(html, { status: 200, headers: { 'Content-Type': 'text/html' } }),
      ),
    );

    const result = await check.run(singlePageCtx('/docs/csp-failp'));
    expect(result.status).toBe('fail');
    expect(result.details?.failBucket).toBe(1);
    expect(result.message).toContain('past 50%');
  });

  // ── Worst-status across multiple pages ──

  it('uses worst status across multiple pages', async () => {
    // Page 1: content starts immediately (pass)
    server.use(
      http.get(
        'http://test.local/docs/good',
        () =>
          new HttpResponse('<html><body><h1>Docs</h1><p>Good page.</p></body></html>', {
            status: 200,
            headers: { 'Content-Type': 'text/html' },
          }),
      ),
    );

    // Page 2: massive nav boilerplate before content (fail)
    const navLinks = Array.from(
      { length: 100 },
      (_, i) => `<li><a href="/nav${i}">Navigation Link ${i}</a></li>`,
    ).join('');
    server.use(
      http.get(
        'http://test.local/docs/bad',
        () =>
          new HttpResponse(
            `<html><body><nav><ul>${navLinks}</ul></nav><h3>Late Content</h3><p>A short paragraph.</p></body></html>`,
            { status: 200, headers: { 'Content-Type': 'text/html' } },
          ),
      ),
    );

    const content = `# Docs\n> Summary\n## Links\n- [Good](http://test.local/docs/good): Good\n- [Bad](http://test.local/docs/bad): Bad\n`;
    const result = await check.run(makeCtx(content));
    expect(result.status).toBe('fail');
    expect(result.details?.passBucket).toBeGreaterThanOrEqual(1);
    expect(result.details?.failBucket).toBeGreaterThanOrEqual(1);
  });

  // ── Fetch errors ──

  it('handles fetch errors gracefully and includes count in message', async () => {
    server.use(http.get('http://test.local/docs/csp-err', () => HttpResponse.error()));

    const result = await check.run(singlePageCtx('/docs/csp-err'));
    expect(result.status).toBe('fail');
    expect(result.details?.fetchErrors).toBe(1);
    expect(result.message).toContain('failed to fetch');
  });

  // ── Fetch error with successful pages produces suffix ──

  it('appends fetch error count when some pages succeed', async () => {
    server.use(
      http.get(
        'http://test.local/docs/good',
        () =>
          new HttpResponse('<html><body><h1>Works</h1><p>Content.</p></body></html>', {
            status: 200,
            headers: { 'Content-Type': 'text/html' },
          }),
      ),
      http.get('http://test.local/docs/broken', () => HttpResponse.error()),
    );

    const content = `# Docs\n> Summary\n## Links\n- [Good](http://test.local/docs/good): OK\n- [Broken](http://test.local/docs/broken): Broken\n`;
    const result = await check.run(makeCtx(content));
    expect(result.details?.fetchErrors).toBe(1);
    expect(result.message).toContain('1 failed to fetch');
  });

  // ── Sampling ──

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
            new HttpResponse(`<html><body><h1>Page ${i}</h1><p>Content here.</p></body></html>`, {
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
    expect(result.message).toContain('sampled pages');
  });

  // ── Per-page details ──

  it('reports per-page position details', async () => {
    server.use(
      http.get(
        'http://test.local/docs/csp-detail',
        () =>
          new HttpResponse(
            '<html><body><h1>Title</h1><p>A paragraph of meaningful documentation content for testing.</p></body></html>',
            { status: 200, headers: { 'Content-Type': 'text/html' } },
          ),
      ),
    );

    const result = await check.run(singlePageCtx('/docs/csp-detail'));
    const pageResults = result.details?.pageResults as Array<{
      url: string;
      contentStartChar: number;
      totalChars: number;
      contentStartPercent: number;
    }>;
    expect(pageResults).toHaveLength(1);
    expect(pageResults[0].url).toBe('http://test.local/docs/csp-detail');
    expect(pageResults[0].totalChars).toBeGreaterThan(0);
    expect(pageResults[0].contentStartChar).toBeGreaterThanOrEqual(0);
    expect(pageResults[0].contentStartPercent).toBeGreaterThanOrEqual(0);
  });

  // ── Markdown responses (no Turndown conversion) ──

  it('analyzes markdown directly when response is text/markdown', async () => {
    const markdownContent = '# API Guide\n\nThis page documents the `<head>` element.\n';
    server.use(
      http.get(
        'http://test.local/docs/csp-md',
        () =>
          new HttpResponse(markdownContent, {
            status: 200,
            headers: { 'Content-Type': 'text/markdown; charset=utf-8' },
          }),
      ),
    );

    const result = await check.run(singlePageCtx('/docs/csp-md'));
    expect(result.status).toBe('pass');
    const pageResults = result.details?.pageResults as Array<{
      contentStartChar: number;
      contentStartPercent: number;
    }>;
    // ATX heading at position 0
    expect(pageResults[0].contentStartChar).toBe(0);
    expect(pageResults[0].contentStartPercent).toBe(0);
  });

  it('analyzes markdown directly when response is text/plain', async () => {
    const markdownContent = '# Checkout\n\nSet up `<head>` tags in your HTML page.\n';
    server.use(
      http.get(
        'http://test.local/docs/csp-plain',
        () =>
          new HttpResponse(markdownContent, {
            status: 200,
            headers: { 'Content-Type': 'text/plain; charset=utf-8' },
          }),
      ),
    );

    const result = await check.run(singlePageCtx('/docs/csp-plain'));
    expect(result.status).toBe('pass');
    const pageResults = result.details?.pageResults as Array<{
      contentStartPercent: number;
    }>;
    expect(pageResults[0].contentStartPercent).toBe(0);
  });

  // ── Fallback to baseUrl ──

  it('falls back to baseUrl when no llms.txt', async () => {
    mockSitemapNotFound(server, 'http://csp-fb.local');
    server.use(
      http.get(
        'http://csp-fb.local/llms.txt',
        () => new HttpResponse('Not found', { status: 404 }),
      ),
      http.get(
        'http://csp-fb.local/docs/llms.txt',
        () => new HttpResponse('Not found', { status: 404 }),
      ),
      http.get('http://csp-fb.local/robots.txt', () => new HttpResponse('', { status: 404 })),
      http.get(
        'http://csp-fb.local/sitemap.xml',
        () => new HttpResponse('Not Found', { status: 404 }),
      ),
      http.get(
        'http://csp-fb.local',
        () =>
          new HttpResponse(
            '<!DOCTYPE html><html><body><h1>Welcome</h1><p>Documentation home page with some real content.</p></body></html>',
            { status: 200, headers: { 'Content-Type': 'text/html' } },
          ),
      ),
    );

    const ctx = createContext('http://csp-fb.local', { requestDelay: 0 });
    const result = await check.run(ctx);
    expect(result.details?.testedPages).toBe(1);
    expect(result.status).toBe('pass');
  });

  // ── Table content after headings (issue #20) ──

  it('detects markdown table as content after heading', async () => {
    const html = `<html><body>
      <h1>Limits for Scheduled Triggers</h1>
      <table><tr><th>Trigger interval</th><th>Max executions</th></tr>
      <tr><td>Every 5 minutes</td><td>50 per hour</td></tr></table>
    </body></html>`;

    server.use(
      http.get(
        'http://test.local/docs/table-after-heading',
        () => new HttpResponse(html, { status: 200, headers: { 'Content-Type': 'text/html' } }),
      ),
    );

    const result = await check.run(singlePageCtx('/docs/table-after-heading'));
    expect(result.status).toBe('pass');
  });

  it('detects markdown table in .md content as content after heading', async () => {
    const md = `# Limits\n\n| Trigger interval | Max executions |\n|-----------------|----------------|\n| Every 5 minutes | 50 per hour    |\n`;

    server.use(
      http.get(
        'http://test.local/docs/table-md',
        () => new HttpResponse(md, { status: 200, headers: { 'Content-Type': 'text/markdown' } }),
      ),
    );

    const result = await check.run(singlePageCtx('/docs/table-md'));
    expect(result.status).toBe('pass');
  });

  it('detects HTML table in .md content as content after heading', async () => {
    const md = `# Limits\n\n<table>\n  <tr><th>Col A</th><th>Col B</th></tr>\n  <tr><td>val</td><td>val</td></tr>\n</table>\n`;

    server.use(
      http.get(
        'http://test.local/docs/table-html-in-md',
        () => new HttpResponse(md, { status: 200, headers: { 'Content-Type': 'text/markdown' } }),
      ),
    );

    const result = await check.run(singlePageCtx('/docs/table-html-in-md'));
    expect(result.status).toBe('pass');
  });

  // ── Lines that don't match any skip pattern and aren't prose ──

  it('skips short multi-word non-prose lines (breadcrumbs)', async () => {
    // Short lines with spaces but under 20 chars and under NAV_MAX_LENGTH
    // These fall through all skip patterns to the final charPos increment
    const html = `<html><body>
      <span>Go back</span>
      <span>Up next</span>
      <h1>Real Content</h1>
      <p>Documentation paragraph.</p>
    </body></html>`;

    server.use(
      http.get(
        'http://test.local/docs/csp-breadcrumb',
        () => new HttpResponse(html, { status: 200, headers: { 'Content-Type': 'text/html' } }),
      ),
    );

    const result = await check.run(singlePageCtx('/docs/csp-breadcrumb'));
    const pageResults = result.details?.pageResults as Array<{ contentStartChar: number }>;
    // "Go back" and "Up next" should be skipped, content starts at heading
    expect(pageResults[0].contentStartChar).toBeGreaterThan(0);
  });
});
