/**
 * Dependency chain integration tests.
 *
 * Tests the runner's dependency resolution logic:
 * - OR-gate dependencies (either dep passing is sufficient)
 * - --skip-checks interaction with dependency resolution
 * - Soft dependency chains (previousResults reads without dependsOn)
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { runChecks } from '../../src/runner.js';
import '../../src/checks/index.js';

const server = setupServer();

beforeAll(() => {
  server.listen({ onUnhandledRequest: 'bypass' });
  return () => server.close();
});

const prose =
  'This is comprehensive documentation content explaining the feature. ' +
  'It covers configuration, usage, and troubleshooting. ';

function setupSite(
  host: string,
  opts: {
    llmsTxt?: string;
    pages: Array<{
      path: string;
      html?: string;
      md?: string;
      contentNeg?: string;
    }>;
  },
) {
  const handlers = [];

  if (opts.llmsTxt) {
    handlers.push(http.get(`http://${host}/llms.txt`, () => HttpResponse.text(opts.llmsTxt!)));
  } else {
    handlers.push(
      http.get(`http://${host}/llms.txt`, () => new HttpResponse(null, { status: 404 })),
    );
  }
  handlers.push(
    http.get(`http://${host}/docs/llms.txt`, () => new HttpResponse(null, { status: 404 })),
    http.get(`http://${host}/robots.txt`, () => new HttpResponse('', { status: 404 })),
    http.get(`http://${host}/sitemap.xml`, () => new HttpResponse('', { status: 404 })),
    http.get(`http://${host}/sitemap-index.xml`, () => new HttpResponse('', { status: 404 })),
    http.get(`http://${host}/sitemap_index.xml`, () => new HttpResponse('', { status: 404 })),
  );

  for (const page of opts.pages) {
    handlers.push(
      http.get(`http://${host}${page.path}`, ({ request }) => {
        const accept = request.headers.get('accept') ?? '';
        if (accept.includes('text/markdown') && page.contentNeg) {
          return new HttpResponse(page.contentNeg, {
            status: 200,
            headers: { 'Content-Type': 'text/markdown' },
          });
        }
        return new HttpResponse(
          page.html ?? `<html><body><h1>Page</h1><p>${prose}</p></body></html>`,
          { status: 200, headers: { 'Content-Type': 'text/html' } },
        );
      }),
      http.head(`http://${host}${page.path}`, () => new HttpResponse(null, { status: 200 })),
    );

    if (page.md) {
      handlers.push(
        http.get(
          `http://${host}${page.path}.md`,
          () =>
            new HttpResponse(page.md!, {
              status: 200,
              headers: { 'Content-Type': 'text/markdown' },
            }),
        ),
        http.get(
          `http://${host}${page.path}/index.md`,
          () =>
            new HttpResponse(page.md!, {
              status: 200,
              headers: { 'Content-Type': 'text/markdown' },
            }),
        ),
      );
    } else {
      handlers.push(
        http.get(`http://${host}${page.path}.md`, () => new HttpResponse(null, { status: 404 })),
        http.get(
          `http://${host}${page.path}/index.md`,
          () => new HttpResponse(null, { status: 404 }),
        ),
      );
    }
  }

  server.use(...handlers);
}

describe('OR-gate dependencies', () => {
  it('page-size-markdown runs when markdown-url-support passes but content-negotiation fails', async () => {
    const host = 'dep-or-md.local';
    const md = `# Page\n\n${prose}\n`;
    setupSite(host, {
      llmsTxt: `# Docs\n## Links\n- [Page](http://${host}/docs/page): Page\n`,
      pages: [{ path: '/docs/page', md }],
    });

    const report = await runChecks(`http://${host}`, {
      requestDelay: 0,
      checkIds: [
        'llms-txt-exists',
        'markdown-url-support',
        'content-negotiation',
        'page-size-markdown',
      ],
    });

    expect(report.results.find((r) => r.id === 'markdown-url-support')?.status).toBe('pass');
    expect(report.results.find((r) => r.id === 'content-negotiation')?.status).toBe('fail');
    // OR-gate: one passed → page-size-markdown should run, not skip
    const psm = report.results.find((r) => r.id === 'page-size-markdown')!;
    expect(psm.status).not.toBe('skip');
  });

  it('page-size-markdown runs when content-negotiation passes but markdown-url-support fails', async () => {
    const host = 'dep-or-cn.local';
    const cnContent = `# Page\n\n${prose}\n`;
    setupSite(host, {
      llmsTxt: `# Docs\n## Links\n- [Page](http://${host}/docs/page): Page\n`,
      pages: [{ path: '/docs/page', contentNeg: cnContent }],
    });

    const report = await runChecks(`http://${host}`, {
      requestDelay: 0,
      checkIds: [
        'llms-txt-exists',
        'markdown-url-support',
        'content-negotiation',
        'page-size-markdown',
      ],
    });

    expect(report.results.find((r) => r.id === 'markdown-url-support')?.status).toBe('fail');
    expect(report.results.find((r) => r.id === 'content-negotiation')?.status).toBe('pass');
    const psm = report.results.find((r) => r.id === 'page-size-markdown')!;
    expect(psm.status).not.toBe('skip');
  });

  it('page-size-markdown skips when both OR-gate deps fail', async () => {
    const host = 'dep-or-both.local';
    setupSite(host, {
      llmsTxt: `# Docs\n## Links\n- [Page](http://${host}/docs/page): Page\n`,
      pages: [{ path: '/docs/page' }],
    });

    const report = await runChecks(`http://${host}`, {
      requestDelay: 0,
      checkIds: [
        'llms-txt-exists',
        'markdown-url-support',
        'content-negotiation',
        'page-size-markdown',
      ],
    });

    expect(report.results.find((r) => r.id === 'markdown-url-support')?.status).toBe('fail');
    expect(report.results.find((r) => r.id === 'content-negotiation')?.status).toBe('fail');
    const psm = report.results.find((r) => r.id === 'page-size-markdown')!;
    expect(psm.status).toBe('skip');
    expect(psm.message).toContain('dependency');
  });
});

describe('--skip-checks interaction with dependencies', () => {
  it('skipped check emits skip result but does not block downstream standalone mode', async () => {
    const host = 'dep-skipcheck.local';
    setupSite(host, {
      llmsTxt: `# Docs\n## Links\n- [Page](http://${host}/docs/page): Page\n`,
      pages: [{ path: '/docs/page', md: `# Page\n\n${prose}\n` }],
    });

    const report = await runChecks(`http://${host}`, {
      requestDelay: 0,
      checkIds: [
        'llms-txt-exists',
        'markdown-url-support',
        'content-negotiation',
        'page-size-markdown',
      ],
      skipCheckIds: ['markdown-url-support'],
    });

    // markdown-url-support should be explicitly skipped
    const mdUrl = report.results.find((r) => r.id === 'markdown-url-support')!;
    expect(mdUrl.status).toBe('skip');
    expect(mdUrl.message).toContain('--skip-checks');

    // content-negotiation should still run (not affected by skip)
    const cn = report.results.find((r) => r.id === 'content-negotiation')!;
    expect(cn.status).not.toBe('skip');

    // page-size-markdown depends on OR(markdown-url-support, content-negotiation).
    // markdown-url-support is skipped (not stored in previousResults, so not "ran and failed").
    // content-negotiation ran. Whether page-size-markdown runs depends on CN's result.
    const psm = report.results.find((r) => r.id === 'page-size-markdown')!;
    // If CN failed, the skip of md-url means "dep never ran" for md-url,
    // but CN DID run and failed, so the OR-gate has one "ran and failed"
    // and one "never ran". The runner behavior: anyDepRan = true (CN ran),
    // checkDependenciesMet: CN failed, md-url never ran → OR-group fails → skip
    if (cn.status === 'fail') {
      expect(psm.status).toBe('skip');
    }
  });

  it('skipping a dependency via --skip-checks lets runner invoke downstream, but check self-skips without data', async () => {
    const host = 'dep-skiponly.local';
    setupSite(host, {
      llmsTxt: `# Docs\n## Links\n- [Page](http://${host}/docs/page): Page\n`,
      pages: [{ path: '/docs/page', md: `# Page\n\n${prose}\n` }],
    });

    const report = await runChecks(`http://${host}`, {
      requestDelay: 0,
      checkIds: ['llms-txt-exists', 'llms-txt-valid'],
      skipCheckIds: ['llms-txt-exists'],
    });

    const exists = report.results.find((r) => r.id === 'llms-txt-exists')!;
    expect(exists.status).toBe('skip');
    expect(exists.message).toContain('--skip-checks');

    // The runner does NOT block llms-txt-valid (dep "never ran" from runner's
    // perspective, since --skip-checks results aren't stored in previousResults).
    // But llms-txt-valid reads previousResults.get('llms-txt-exists') for data
    // and self-skips with a different message — it can't validate without files.
    const valid = report.results.find((r) => r.id === 'llms-txt-valid')!;
    expect(valid.status).toBe('skip');
    expect(valid.message).toContain('No llms.txt files');
    // Crucially, the message should NOT say "dependency" (that's the runner's skip)
    expect(valid.message).not.toContain('dependency');
  });
});

describe('soft dependency chains', () => {
  it('rendering-strategy → tabbed-content-serialization → section-header-quality chain', async () => {
    const host = 'dep-soft-chain.local';
    // Tab panels must contain section headers for section-header-quality to analyze them
    const tabHtml = `
      <html><body>
        <h1>Docs</h1>
        <div class="sphinx-tabs">
          <div class="sphinx-tabs-tab">Python</div>
          <div class="sphinx-tabs-tab">JavaScript</div>
          <div class="sphinx-tabs-panel"><h2>Installation</h2><p>pip install foo</p><h2>Usage</h2><p>import foo</p></div>
          <div class="sphinx-tabs-panel"><h2>Installation</h2><p>npm install foo</p><h2>Usage</h2><p>require('foo')</p></div>
        </div>
        <p>${prose}</p>
      </body></html>
    `;
    setupSite(host, {
      llmsTxt: `# Docs\n## Links\n- [Page](http://${host}/docs/page): Page\n`,
      pages: [{ path: '/docs/page', html: tabHtml }],
    });

    const report = await runChecks(`http://${host}`, {
      requestDelay: 0,
      checkIds: [
        'llms-txt-exists',
        'rendering-strategy',
        'tabbed-content-serialization',
        'section-header-quality',
      ],
    });

    // rendering-strategy should pass (server-rendered HTML)
    expect(report.results.find((r) => r.id === 'rendering-strategy')?.status).toBe('pass');

    // tabbed-content-serialization should detect the sphinx tabs
    const tcs = report.results.find((r) => r.id === 'tabbed-content-serialization')!;
    expect(tcs.status).toBe('pass');
    expect(tcs.details?.totalGroupsFound).toBeGreaterThan(0);

    // section-header-quality reads from tabbed-content-serialization's tabbedPages
    const shq = report.results.find((r) => r.id === 'section-header-quality')!;
    // It should run (not skip) and analyze the tab groups
    expect(shq.status).not.toBe('skip');
    expect(shq.details?.analyses).toBeDefined();
  });

  it('section-header-quality skips when tabbed-content-serialization finds no tabs', async () => {
    const host = 'dep-soft-notabs.local';
    setupSite(host, {
      llmsTxt: `# Docs\n## Links\n- [Page](http://${host}/docs/page): Page\n`,
      pages: [{ path: '/docs/page' }],
    });

    const report = await runChecks(`http://${host}`, {
      requestDelay: 0,
      checkIds: ['llms-txt-exists', 'tabbed-content-serialization', 'section-header-quality'],
    });

    const tcs = report.results.find((r) => r.id === 'tabbed-content-serialization')!;
    expect(tcs.status).toBe('pass');
    expect(tcs.details?.totalGroupsFound).toBe(0);

    // section-header-quality should pass (no tabs to analyze)
    const shq = report.results.find((r) => r.id === 'section-header-quality')!;
    expect(shq.status).toBe('pass');
    expect(shq.message).toContain('No tabbed content');
  });

  it('llms-txt-exists fail cascades through all llms-txt-* checks', async () => {
    const host = 'dep-cascade.local';
    setupSite(host, { pages: [{ path: '/docs/page' }] });

    const report = await runChecks(`http://${host}`, {
      requestDelay: 0,
      checkIds: [
        'llms-txt-exists',
        'llms-txt-valid',
        'llms-txt-size',
        'llms-txt-links-resolve',
        'llms-txt-links-markdown',
        'llms-txt-coverage',
      ],
    });

    expect(report.results.find((r) => r.id === 'llms-txt-exists')?.status).toBe('fail');

    // All downstream checks should skip due to dependency failure
    for (const id of [
      'llms-txt-valid',
      'llms-txt-size',
      'llms-txt-links-resolve',
      'llms-txt-links-markdown',
      'llms-txt-coverage',
    ]) {
      const result = report.results.find((r) => r.id === id)!;
      expect(result.status, `${id} should skip`).toBe('skip');
      expect(result.message).toContain('dependency');
    }
  });
});
