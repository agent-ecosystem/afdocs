/**
 * End-to-end scoring pipeline integration tests.
 *
 * These tests run real checks through the runner via runChecks(), then feed
 * the results through computeScore() to validate that the full pipeline
 * produces correct coefficients, diagnostics, caps, and category scores.
 *
 * Each test targets one specific scoring behavior using the minimum set of
 * checks needed, matching the established pattern in check-pipeline.test.ts.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { runChecks } from '../../src/runner.js';
import { computeScore } from '../../src/scoring/score.js';
import '../../src/checks/index.js';

const server = setupServer();

beforeAll(() => {
  server.listen({ onUnhandledRequest: 'bypass' });
  return () => server.close();
});

/**
 * Set up a mock docs site. Handles llms.txt, page variants, sitemap,
 * bad-URL 404s for http-status-codes, and HEAD handlers for link resolution.
 */
function setupSite(
  host: string,
  opts: {
    llmsTxt?: string;
    pages: Array<{
      path: string;
      html?: string;
      md?: string;
      contentNeg?: string;
      status?: number;
    }>;
    sitemap?: string[];
    cacheControl?: string;
  },
) {
  const handlers = [];
  const defaultCacheHeaders: Record<string, string> = {};
  if (opts.cacheControl) defaultCacheHeaders['Cache-Control'] = opts.cacheControl;

  // llms.txt
  if (opts.llmsTxt) {
    handlers.push(
      http.get(
        `http://${host}/llms.txt`,
        () =>
          new HttpResponse(opts.llmsTxt!, {
            status: 200,
            headers: { 'Content-Type': 'text/plain', ...defaultCacheHeaders },
          }),
      ),
    );
  } else {
    handlers.push(
      http.get(`http://${host}/llms.txt`, () => new HttpResponse(null, { status: 404 })),
    );
  }
  handlers.push(
    http.get(`http://${host}/docs/llms.txt`, () => new HttpResponse(null, { status: 404 })),
  );

  // Sitemap
  if (opts.sitemap) {
    const locs = opts.sitemap.map((u) => `<url><loc>${u}</loc></url>`).join('\n');
    const xml = `<?xml version="1.0"?>\n<urlset>\n${locs}\n</urlset>`;
    handlers.push(
      http.get(
        `http://${host}/robots.txt`,
        () => new HttpResponse(`Sitemap: http://${host}/sitemap.xml`, { status: 200 }),
      ),
      http.get(
        `http://${host}/sitemap.xml`,
        () =>
          new HttpResponse(xml, {
            status: 200,
            headers: { 'content-type': 'application/xml' },
          }),
      ),
    );
  } else {
    handlers.push(
      http.get(`http://${host}/robots.txt`, () => new HttpResponse('', { status: 404 })),
      http.get(`http://${host}/sitemap.xml`, () => new HttpResponse('', { status: 404 })),
    );
  }
  handlers.push(
    http.get(`http://${host}/sitemap-index.xml`, () => new HttpResponse('', { status: 404 })),
    http.get(`http://${host}/sitemap_index.xml`, () => new HttpResponse('', { status: 404 })),
  );

  // Root URL for homepage-based discovery
  const pageLinks = opts.pages
    .map((p) => `<a href="http://${host}${p.path}">${p.path}</a>`)
    .join('\n');
  const rootHtml = `<html><body><h1>Docs Home</h1><p>Welcome to the documentation site. Browse the pages below for comprehensive guides and API references.</p>${pageLinks}</body></html>`;
  handlers.push(
    http.get(
      `http://${host}/`,
      () =>
        new HttpResponse(rootHtml, {
          status: 200,
          headers: { 'Content-Type': 'text/html', ...defaultCacheHeaders },
        }),
    ),
  );

  // Prose long enough to pass content-start-position heuristics (>40 chars with punctuation)
  const defaultProse =
    'This is comprehensive documentation content explaining the feature in detail. ' +
    'It covers configuration options, usage patterns, and troubleshooting steps. ' +
    'Read through each section carefully for the best results.';

  for (const page of opts.pages) {
    const pageStatus = page.status ?? 200;
    const defaultHtml = `<html><body><h1>Documentation</h1><p>${defaultProse}</p></body></html>`;

    // GET handler (HTML or content-negotiation)
    handlers.push(
      http.get(`http://${host}${page.path}`, ({ request }) => {
        const accept = request.headers.get('accept') ?? '';
        if (accept.includes('text/markdown') && page.contentNeg) {
          return new HttpResponse(page.contentNeg, {
            status: pageStatus,
            headers: { 'Content-Type': 'text/markdown', ...defaultCacheHeaders },
          });
        }
        return new HttpResponse(page.html ?? defaultHtml, {
          status: pageStatus,
          headers: { 'Content-Type': 'text/html', ...defaultCacheHeaders },
        });
      }),
      http.head(
        `http://${host}${page.path}`,
        () => new HttpResponse(null, { status: pageStatus, headers: defaultCacheHeaders }),
      ),
    );

    // .md URL variants
    if (page.md) {
      for (const suffix of ['.md', '/index.md']) {
        handlers.push(
          http.get(
            `http://${host}${page.path}${suffix}`,
            () =>
              new HttpResponse(page.md!, {
                status: 200,
                headers: { 'Content-Type': 'text/markdown', ...defaultCacheHeaders },
              }),
          ),
          http.head(
            `http://${host}${page.path}${suffix}`,
            () =>
              new HttpResponse(null, {
                status: 200,
                headers: { 'Content-Type': 'text/markdown', ...defaultCacheHeaders },
              }),
          ),
        );
      }
    } else {
      handlers.push(
        http.get(`http://${host}${page.path}.md`, () => new HttpResponse(null, { status: 404 })),
        http.get(
          `http://${host}${page.path}/index.md`,
          () => new HttpResponse(null, { status: 404 }),
        ),
      );
    }

    // Bad URL for http-status-codes (proper 404)
    const badPath = `${page.path}-afdocs-nonexistent-8f3a`;
    handlers.push(
      http.get(`http://${host}${badPath}`, () => new HttpResponse('Not Found', { status: 404 })),
    );
  }

  // Catch-all bad URL pattern for pages discovered via homepage fallback
  handlers.push(
    http.get(
      `http://${host}/*afdocs-nonexistent*`,
      () => new HttpResponse('Not Found', { status: 404 }),
    ),
  );

  server.use(...handlers);
}

function makePages(
  host: string,
  count: number,
  opts?: { md?: boolean; contentNeg?: boolean; directive?: boolean },
) {
  const pages = [];
  const links = [];
  const prose =
    'This is comprehensive documentation content explaining the feature in detail. ' +
    'It covers configuration, usage patterns, and troubleshooting. ';
  for (let i = 0; i < count; i++) {
    const path = `/docs/page-${i}`;
    const directiveHtml = opts?.directive ? '<a href="/llms.txt">Documentation Index</a>' : '';
    const directiveMd = opts?.directive
      ? '> See [llms.txt](/llms.txt) for the documentation index.\n\n'
      : '';
    const html = `<html><body>${directiveHtml}<h1>Page ${i}</h1><p>${prose}</p></body></html>`;
    const md = opts?.md ? `${directiveMd}# Page ${i}\n\n${prose}\n` : undefined;
    const contentNeg = opts?.contentNeg ? `${directiveMd}# Page ${i}\n\n${prose}\n` : undefined;
    pages.push({ path, html, md, contentNeg });
    links.push(`- [Page ${i}](http://${host}${path}): Page ${i}`);
  }
  return { pages, links };
}

describe('scoring pipeline: discovery coefficient 0.8 tier', () => {
  const host = 'score-disc-08.local';

  it('directive passes without content-negotiation → coefficient 0.8 on markdown checks', async () => {
    const { pages, links } = makePages(host, 6, { md: true, directive: true });
    const llmsTxt = `# Docs\n\n> Index.\n\n## Links\n${links.join('\n')}\n`;

    setupSite(host, { llmsTxt, pages, cacheControl: 'max-age=300' });

    const report = await runChecks(`http://${host}`, {
      requestDelay: 0,
      checkIds: [
        'llms-txt-exists',
        'llms-txt-directive-html',
        'markdown-url-support',
        'content-negotiation',
        'page-size-markdown',
        'markdown-code-fence-validity',
      ],
    });
    const score = computeScore(report);

    expect(report.results.find((r) => r.id === 'content-negotiation')?.status).toBe('fail');
    expect(report.results.find((r) => r.id === 'llms-txt-directive-html')?.status).toBe('pass');

    const mdSizeScore = score.checkScores['page-size-markdown'];
    if (mdSizeScore) {
      expect(mdSizeScore.coefficient).toBe(0.8);
    }
    const fenceScore = score.checkScores['markdown-code-fence-validity'];
    if (fenceScore) {
      expect(fenceScore.coefficient).toBe(0.8);
    }
  });
});

describe('scoring pipeline: discovery coefficient zeroes out markdown checks', () => {
  const host = 'score-disc-zero.local';

  it('no discovery signal → coefficient 0 on markdown quality checks', async () => {
    const { pages, links } = makePages(host, 6);
    const llmsTxt = `# Docs\n\n> Index.\n\n## Links\n${links.join('\n')}\n`;

    setupSite(host, { llmsTxt, pages, cacheControl: 'max-age=300' });

    const report = await runChecks(`http://${host}`, {
      requestDelay: 0,
      checkIds: [
        'llms-txt-exists',
        'llms-txt-directive-html',
        'markdown-url-support',
        'content-negotiation',
        'page-size-markdown',
        'markdown-code-fence-validity',
      ],
    });
    const score = computeScore(report);

    expect(report.results.find((r) => r.id === 'content-negotiation')?.status).toBe('fail');
    expect(report.results.find((r) => r.id === 'markdown-url-support')?.status).toBe('fail');
    expect(report.results.find((r) => r.id === 'llms-txt-directive-html')?.status).toBe('fail');

    for (const checkId of ['page-size-markdown', 'markdown-code-fence-validity']) {
      const cs = score.checkScores[checkId];
      if (cs) {
        expect(cs.coefficient).toBe(0);
        expect(cs.effectiveWeight).toBe(0);
      }
    }
  });
});

describe('scoring pipeline: SPA diagnostics and HTML path coefficient', () => {
  const host = 'score-spa.local';

  it('SPA shells fire diagnostics and discount HTML path checks', async () => {
    const { pages, links } = makePages(host, 6, { md: true });
    const llmsTxt = `# Docs\n\n> Index.\n\n## Links\n${links.join('\n')}\n`;

    const spaHtml =
      '<html><head><style>' +
      'x'.repeat(5000) +
      '</style></head><body><div id="__next"></div></body></html>';
    const spaPages = pages.map((p) => ({ ...p, html: spaHtml }));

    setupSite(host, { llmsTxt, pages: spaPages, cacheControl: 'max-age=300' });

    const report = await runChecks(`http://${host}`, {
      requestDelay: 0,
      checkIds: [
        'llms-txt-exists',
        'markdown-url-support',
        'content-negotiation',
        'llms-txt-directive-html',
        'rendering-strategy',
        'page-size-html',
      ],
    });
    const score = computeScore(report);

    expect(report.results.find((r) => r.id === 'rendering-strategy')?.status).toBe('fail');
    expect(score.diagnostics.find((d) => d.id === 'markdown-undiscoverable')).toBeDefined();
    expect(score.diagnostics.find((d) => d.id === 'spa-shell-html-invalid')).toBeDefined();

    const htmlSizeScore = score.checkScores['page-size-html'];
    if (htmlSizeScore) {
      expect(htmlSizeScore.coefficient).toBeLessThan(1.0);
    }
  });
});

describe('scoring pipeline: dependency skip propagation into scoring', () => {
  const host = 'score-skip.local';

  it('skipped checks are excluded from score computation', async () => {
    const { pages } = makePages(host, 6);
    setupSite(host, { pages, cacheControl: 'max-age=300' });

    const report = await runChecks(`http://${host}`, {
      requestDelay: 0,
      checkIds: ['llms-txt-exists', 'llms-txt-valid', 'llms-txt-size'],
    });
    const score = computeScore(report);

    expect(report.results.find((r) => r.id === 'llms-txt-exists')?.status).toBe('fail');
    expect(report.results.find((r) => r.id === 'llms-txt-valid')?.status).toBe('skip');
    expect(report.results.find((r) => r.id === 'llms-txt-size')?.status).toBe('skip');

    expect(score.checkScores['llms-txt-valid']).toBeUndefined();
    expect(score.checkScores['llms-txt-size']).toBeUndefined();
    expect(score.checkScores['llms-txt-exists']).toBeDefined();
  });
});

describe('scoring pipeline: index truncation coefficient', () => {
  const host = 'score-trunc.local';

  it('large llms.txt reduces weight of downstream index quality checks', async () => {
    const { pages, links } = makePages(host, 6);
    // Pad with long descriptions (not extra links) to exceed 100K
    const longDesc = 'A'.repeat(200);
    const filler = Array.from(
      { length: 500 },
      (_, i) => `- [Filler ${i}](http://${host}/docs/filler-${i}): ${longDesc}`,
    ).join('\n');
    const llmsTxt = `# Docs\n\n> Index.\n\n## Links\n${links.join('\n')}\n${filler}\n`;

    setupSite(host, { llmsTxt, pages, cacheControl: 'max-age=300' });

    // Only size-related checks — skip link resolution (would HEAD 500+ URLs)
    const report = await runChecks(`http://${host}`, {
      requestDelay: 0,
      checkIds: ['llms-txt-exists', 'llms-txt-valid', 'llms-txt-size'],
    });
    const score = computeScore(report);

    expect(report.results.find((r) => r.id === 'llms-txt-size')?.status).toBe('fail');
    expect(score.diagnostics.find((d) => d.id === 'truncated-index')).toBeDefined();

    const validScore = score.checkScores['llms-txt-valid'];
    expect(validScore).toBeDefined();
    expect(validScore.coefficient).toBeLessThan(1.0);
    expect(validScore.coefficient).toBeGreaterThan(0);
  });
});

describe('scoring pipeline: single-page fallback produces notApplicable scoring', () => {
  const host = 'score-single.local';

  it('page-level checks get notApplicable when only 1 page is discovered', async () => {
    // No llms.txt, no sitemap → discovery falls back to [baseUrl], testedPages = 1
    setupSite(host, {
      pages: [{ path: '/' }],
      cacheControl: 'max-age=300',
    });

    const report = await runChecks(`http://${host}`, {
      requestDelay: 0,
      checkIds: ['llms-txt-exists', 'rendering-strategy', 'page-size-html', 'http-status-codes'],
    });
    const score = computeScore(report);

    expect(score.checkScores['llms-txt-exists'].scoreDisplayMode).toBe('numeric');

    // Page-level checks should be notApplicable with only 1 discovered page
    for (const checkId of ['rendering-strategy', 'page-size-html', 'http-status-codes']) {
      const cs = score.checkScores[checkId];
      if (cs) {
        expect(cs.scoreDisplayMode, `${checkId} should be notApplicable`).toBe('notApplicable');
      }
    }

    expect(score.diagnostics.find((d) => d.id === 'single-page-sample')).toBeDefined();
  });
});

describe('scoring pipeline: resolutions populated for real check failures', () => {
  const host = 'score-resolutions.local';

  it('each failing check produces a resolution string', async () => {
    const { pages } = makePages(host, 6);
    setupSite(host, { pages, cacheControl: 'max-age=300' });

    const report = await runChecks(`http://${host}`, {
      requestDelay: 0,
      checkIds: ['llms-txt-exists', 'markdown-url-support', 'content-negotiation'],
    });
    const score = computeScore(report);

    // All three should fail
    for (const id of ['llms-txt-exists', 'markdown-url-support', 'content-negotiation']) {
      expect(report.results.find((r) => r.id === id)?.status).toBe('fail');
      expect(score.resolutions[id], `missing resolution for ${id}`).toBeDefined();
      expect(score.resolutions[id].length).toBeGreaterThan(0);
    }
  });
});

describe('scoring pipeline: category scores from mixed results', () => {
  const host = 'score-categories.local';

  it('computes per-category scores from a realistic mixed run', async () => {
    const { pages, links } = makePages(host, 8, { md: true, contentNeg: true, directive: true });
    const llmsTxt = `# Docs\n\n> Complete documentation index.\n\n## Links\n${links.join('\n')}\n`;

    setupSite(host, {
      llmsTxt,
      pages,
      sitemap: pages.map((p) => `http://${host}${p.path}`),
      cacheControl: 'max-age=300',
    });

    const report = await runChecks(`http://${host}`, {
      requestDelay: 0,
      checkIds: [
        'llms-txt-exists',
        'llms-txt-valid',
        'llms-txt-size',
        'markdown-url-support',
        'content-negotiation',
        'rendering-strategy',
        'page-size-html',
        'page-size-markdown',
        'http-status-codes',
        'auth-gate-detection',
        'cache-header-hygiene',
      ],
    });
    const score = computeScore(report);

    // content-discoverability should be high (llms-txt-exists, valid, size all pass)
    expect(score.categoryScores['content-discoverability']).toBeDefined();
    expect(score.categoryScores['content-discoverability'].score).toBeGreaterThanOrEqual(80);

    // markdown-availability should pass (both CN and md-url pass)
    expect(score.categoryScores['markdown-availability']).toBeDefined();
    expect(score.categoryScores['markdown-availability'].score).toBe(100);

    // Each category should have a grade
    for (const [, catScore] of Object.entries(score.categoryScores)) {
      if (catScore.score !== null) {
        expect(catScore.grade).toBeDefined();
      }
    }
  });
});

describe('scoring pipeline: no-viable-path diagnostic', () => {
  const host = 'score-novpath.local';

  it('fires when no llms.txt, SPA shells, and no markdown', async () => {
    const spaHtml =
      '<html><head><style>' +
      'x'.repeat(5000) +
      '</style></head><body><div id="__next"></div></body></html>';

    const pageUrls = Array.from({ length: 6 }, (_, i) => `http://${host}/docs/page-${i}`);

    setupSite(host, {
      pages: pageUrls.map((url) => ({
        path: new URL(url).pathname,
        html: spaHtml,
      })),
      sitemap: pageUrls,
      cacheControl: 'max-age=300',
    });

    const report = await runChecks(`http://${host}`, {
      requestDelay: 0,
      checkIds: [
        'llms-txt-exists',
        'rendering-strategy',
        'markdown-url-support',
        'content-negotiation',
        'llms-txt-directive-html',
      ],
    });
    const score = computeScore(report);

    expect(report.results.find((r) => r.id === 'llms-txt-exists')?.status).toBe('fail');
    expect(report.results.find((r) => r.id === 'rendering-strategy')?.status).toBe('fail');
    expect(report.results.find((r) => r.id === 'markdown-url-support')?.status).toBe('fail');

    const nvp = score.diagnostics.find((d) => d.id === 'no-viable-path');
    expect(nvp).toBeDefined();
    expect(nvp!.severity).toBe('critical');
  });
});

describe('scoring pipeline: auth-no-alternative diagnostic', () => {
  const host = 'score-authno.local';

  it('fires when all pages are auth-gated with no alternative access', async () => {
    const pageUrls = Array.from({ length: 6 }, (_, i) => `http://${host}/docs/page-${i}`);

    // All pages return 401
    const handlers = [
      http.get(`http://${host}/llms.txt`, () => new HttpResponse(null, { status: 404 })),
      http.get(`http://${host}/docs/llms.txt`, () => new HttpResponse(null, { status: 404 })),
      http.get(
        `http://${host}/robots.txt`,
        () => new HttpResponse(`Sitemap: http://${host}/sitemap.xml`, { status: 200 }),
      ),
      http.get(`http://${host}/sitemap.xml`, () => {
        const locs = pageUrls.map((u) => `<url><loc>${u}</loc></url>`).join('\n');
        return new HttpResponse(`<?xml version="1.0"?>\n<urlset>\n${locs}\n</urlset>`, {
          status: 200,
          headers: { 'content-type': 'application/xml' },
        });
      }),
      http.get(
        `http://${host}/`,
        () =>
          new HttpResponse('<html><body><h1>Login Required</h1></body></html>', {
            status: 200,
            headers: { 'Content-Type': 'text/html' },
          }),
      ),
    ];

    for (const url of pageUrls) {
      const path = new URL(url).pathname;
      handlers.push(
        http.get(`http://${host}${path}`, () => new HttpResponse('Unauthorized', { status: 401 })),
        http.head(`http://${host}${path}`, () => new HttpResponse(null, { status: 401 })),
        http.get(`http://${host}${path}.md`, () => new HttpResponse(null, { status: 404 })),
        http.get(`http://${host}${path}/index.md`, () => new HttpResponse(null, { status: 404 })),
      );
    }

    server.use(...handlers);

    const report = await runChecks(`http://${host}`, {
      requestDelay: 0,
      checkIds: [
        'llms-txt-exists',
        'auth-gate-detection',
        'auth-alternative-access',
        'markdown-url-support',
        'content-negotiation',
      ],
    });
    const score = computeScore(report);

    expect(report.results.find((r) => r.id === 'auth-gate-detection')?.status).toBe('fail');
    expect(report.results.find((r) => r.id === 'auth-alternative-access')?.status).toBe('fail');

    const authDiag = score.diagnostics.find((d) => d.id === 'auth-no-alternative');
    expect(authDiag).toBeDefined();
    expect(authDiag!.severity).toBe('critical');
  });
});

describe('scoring pipeline: page-size-no-markdown-escape diagnostic', () => {
  const host = 'score-bightml.local';

  it('fires when HTML pages are oversized and no markdown path exists', async () => {
    const bigContent = 'x'.repeat(110_000);
    const bigHtml = `<html><body><h1>Docs</h1><p>${bigContent}</p></body></html>`;
    const { links } = makePages(host, 6);
    const llmsTxt = `# Docs\n\n> Index.\n\n## Links\n${links.join('\n')}\n`;

    // Override pages with huge HTML
    const pages = Array.from({ length: 6 }, (_, i) => ({
      path: `/docs/page-${i}`,
      html: bigHtml,
    }));

    setupSite(host, {
      llmsTxt,
      pages,
      cacheControl: 'max-age=300',
    });

    const report = await runChecks(`http://${host}`, {
      requestDelay: 0,
      checkIds: [
        'llms-txt-exists',
        'markdown-url-support',
        'content-negotiation',
        'llms-txt-directive-html',
        'page-size-html',
      ],
    });
    const score = computeScore(report);

    expect(report.results.find((r) => r.id === 'page-size-html')?.status).toBe('fail');
    expect(report.results.find((r) => r.id === 'markdown-url-support')?.status).toBe('fail');

    const diag = score.diagnostics.find((d) => d.id === 'page-size-no-markdown-escape');
    expect(diag).toBeDefined();
    expect(diag!.severity).toBe('warning');
  });
});
