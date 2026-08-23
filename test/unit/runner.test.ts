import { describe, it, expect, beforeAll, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { createContext, normalizeCanonical, normalizeUrl, runChecks } from '../../src/runner.js';
import { registerCheck } from '../../src/checks/registry.js';
import '../../src/checks/index.js';
import { mockSitemapNotFound } from '../helpers/mock-sitemap-not-found.js';

const server = setupServer();

beforeAll(() => {
  server.listen({ onUnhandledRequest: 'bypass' });
  return () => server.close();
});

describe('normalizeUrl', () => {
  it('prepends https:// to bare domains', () => {
    expect(normalizeUrl('example.com')).toBe('https://example.com');
  });

  it('prepends https:// to domains with paths', () => {
    expect(normalizeUrl('docs.example.com/api')).toBe('https://docs.example.com/api');
  });

  it('leaves https:// URLs unchanged', () => {
    expect(normalizeUrl('https://example.com')).toBe('https://example.com');
  });

  it('leaves http:// URLs unchanged', () => {
    expect(normalizeUrl('http://example.com')).toBe('http://example.com');
  });

  it('is case-insensitive for scheme detection', () => {
    expect(normalizeUrl('HTTPS://example.com')).toBe('HTTPS://example.com');
    expect(normalizeUrl('Http://example.com')).toBe('Http://example.com');
  });
});

describe('normalizeCanonical', () => {
  it('lowercases the host', () => {
    expect(normalizeCanonical('https://PROD.Example.com')).toBe('https://prod.example.com');
  });

  it('drops default ports', () => {
    expect(normalizeCanonical('https://prod.example.com:443')).toBe('https://prod.example.com');
    expect(normalizeCanonical('http://prod.example.com:80')).toBe('http://prod.example.com');
  });

  it('preserves a non-default port', () => {
    expect(normalizeCanonical('https://prod.example.com:8080')).toBe(
      'https://prod.example.com:8080',
    );
  });

  it('preserves a sub-path but strips the trailing slash', () => {
    expect(normalizeCanonical('https://prod.example.com/aws/en/')).toBe(
      'https://prod.example.com/aws/en',
    );
  });

  it('strips repeated trailing slashes', () => {
    expect(normalizeCanonical('https://prod.example.com/docs//')).toBe(
      'https://prod.example.com/docs',
    );
    expect(normalizeCanonical('https://prod.example.com//')).toBe('https://prod.example.com');
  });

  it('drops query and fragment', () => {
    expect(normalizeCanonical('https://prod.example.com/docs?x=1#h')).toBe(
      'https://prod.example.com/docs',
    );
  });
});

describe('createContext URL normalization', () => {
  it('prepends https:// when no scheme is provided', () => {
    const ctx = createContext('example.com');
    expect(ctx.baseUrl).toBe('https://example.com');
    expect(ctx.origin).toBe('https://example.com');
  });

  it('prepends https:// for bare domain with path', () => {
    const ctx = createContext('docs.example.com/api');
    expect(ctx.baseUrl).toBe('https://docs.example.com/api');
    expect(ctx.origin).toBe('https://docs.example.com');
  });

  it('leaves https:// URLs unchanged', () => {
    const ctx = createContext('https://example.com');
    expect(ctx.baseUrl).toBe('https://example.com');
  });

  it('leaves http:// URLs unchanged', () => {
    const ctx = createContext('http://example.com');
    expect(ctx.baseUrl).toBe('http://example.com');
  });

  it('strips trailing slash after normalization', () => {
    const ctx = createContext('example.com/');
    expect(ctx.baseUrl).toBe('https://example.com');
  });

  it('stores curatedPages on _curatedPages', () => {
    const pages = ['https://example.com/a', { url: 'https://example.com/b', tag: 'api' }];
    const ctx = createContext('https://example.com', { curatedPages: pages });
    expect(ctx._curatedPages).toEqual(pages);
  });

  it('leaves _curatedPages undefined when not provided', () => {
    const ctx = createContext('https://example.com');
    expect(ctx._curatedPages).toBeUndefined();
  });

  it('throws on invalid options', () => {
    expect(() => createContext('https://example.com', { maxConcurrency: -1 })).toThrow(
      'Invalid options',
    );
  });

  it('throws an actionable error when the target port is fetch-blocked', () => {
    expect(() => createContext('http://localhost:1719')).toThrow(/blocked-port list/);
    expect(() => createContext('http://localhost:1719')).toThrow(/1719/);
  });

  it('does not throw for safe local dev ports', () => {
    expect(() => createContext('http://localhost:1313')).not.toThrow();
    expect(() => createContext('http://localhost:5173')).not.toThrow();
  });

  it('normalizes bare domain in canonicalOrigin', () => {
    const ctx = createContext('https://preview.example.com', {
      canonicalOrigin: 'example.com',
    });
    expect(ctx.options.canonicalOrigin).toBe('https://example.com');
  });

  it('normalizes bare domain in llmsTxtUrl', () => {
    const ctx = createContext('https://example.com', {
      llmsTxtUrl: 'example.com/llms.txt',
    });
    expect(ctx.options.llmsTxtUrl).toBe('https://example.com/llms.txt');
  });
});

describe('createContext canonicalOrigin targetOrigin wiring', () => {
  it('rewrites canonical origin when canonicalOrigin has no sub-path', async () => {
    const body = 'See https://prod.example.com/docs/guide';
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: new Headers({ 'content-type': 'text/plain' }),
      url: 'http://preview.local/docs/guide',
      redirected: false,
      text: async () => body,
    })) as unknown as typeof fetch;

    try {
      const ctx = createContext('http://preview.local', {
        canonicalOrigin: 'https://prod.example.com',
      });
      const text = await (await ctx.http.fetch('http://preview.local/docs/guide')).text();
      expect(text).toBe('See http://preview.local/docs/guide');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('rewrites canonical base when canonicalOrigin has a sub-path', async () => {
    const body = 'See https://prod.example.com/aws/en/docs/guide';
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: new Headers({ 'content-type': 'text/plain' }),
      url: 'http://preview.local/preview/docs/guide',
      redirected: false,
      text: async () => body,
    })) as unknown as typeof fetch;

    try {
      const ctx = createContext('http://preview.local/preview', {
        canonicalOrigin: 'https://prod.example.com/aws/en',
      });
      const text = await (await ctx.http.fetch('http://preview.local/preview/docs/guide')).text();
      expect(text).toBe('See http://preview.local/preview/docs/guide');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('rewrites when a sub-path canonicalOrigin has a trailing slash', async () => {
    const body = 'See https://prod.example.com/aws/en/docs/guide';
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: new Headers({ 'content-type': 'text/plain' }),
      url: 'http://preview.local/preview/docs/guide',
      redirected: false,
      text: async () => body,
    })) as unknown as typeof fetch;

    try {
      const ctx = createContext('http://preview.local/preview', {
        canonicalOrigin: 'https://prod.example.com/aws/en/',
      });
      const text = await (await ctx.http.fetch('http://preview.local/preview/docs/guide')).text();
      expect(text).toBe('See http://preview.local/preview/docs/guide');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('rewrites when canonicalOrigin host is mixed-case (host is normalized)', async () => {
    const body = 'See https://prod.example.com/docs/guide?x=1 and https://prod.example.com/a#h';
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: new Headers({ 'content-type': 'text/plain' }),
      url: 'http://preview.local/x',
      redirected: false,
      text: async () => body,
    })) as unknown as typeof fetch;

    try {
      const ctx = createContext('http://preview.local', {
        canonicalOrigin: 'https://PROD.example.com',
      });
      const text = await (await ctx.http.fetch('http://preview.local/x')).text();
      // Host normalized to lowercase so the rewrite matches; query/fragment boundaries match too.
      expect(text).toBe('See http://preview.local/docs/guide?x=1 and http://preview.local/a#h');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('runner', () => {
  it('skips dependent checks when dependency fails', async () => {
    server.use(
      http.get('http://nodeps.local/llms.txt', () => new HttpResponse(null, { status: 404 })),
      http.get('http://nodeps.local/docs/llms.txt', () => new HttpResponse(null, { status: 404 })),
    );

    const report = await runChecks('http://nodeps.local', {
      checkIds: ['llms-txt-exists', 'llms-txt-valid', 'llms-txt-size'],
      requestDelay: 0,
    });

    expect(report.results[0].id).toBe('llms-txt-exists');
    expect(report.results[0].status).toBe('fail');

    // Dependent checks should be skipped
    expect(report.results[1].id).toBe('llms-txt-valid');
    expect(report.results[1].status).toBe('skip');
    expect(report.results[2].id).toBe('llms-txt-size');
    expect(report.results[2].status).toBe('skip');
  });

  it('runs dependent checks when dependency passes', async () => {
    const content = `# Test\n\n> Summary.\n\n## Links\n\n- [A](http://deps.local/a): A\n`;
    server.use(
      http.get('http://deps.local/llms.txt', () => HttpResponse.text(content)),
      http.get('http://deps.local/docs/llms.txt', () => new HttpResponse(null, { status: 404 })),
    );

    const report = await runChecks('http://deps.local', {
      checkIds: ['llms-txt-exists', 'llms-txt-valid', 'llms-txt-size'],
      requestDelay: 0,
    });

    expect(report.results[0].status).toBe('pass');
    expect(report.results[1].status).toBe('pass');
    expect(report.results[2].status).toBe('pass');
  });

  it('produces correct summary counts', async () => {
    server.use(
      http.get('http://summary.local/llms.txt', () => new HttpResponse(null, { status: 404 })),
      http.get('http://summary.local/docs/llms.txt', () => new HttpResponse(null, { status: 404 })),
    );

    const report = await runChecks('http://summary.local', {
      checkIds: ['llms-txt-exists', 'llms-txt-valid'],
      requestDelay: 0,
    });

    expect(report.summary.fail).toBe(1);
    expect(report.summary.skip).toBe(1);
    expect(report.summary.total).toBe(2);
  });

  it('auth-alternative-access skips when auth-gate-detection did not run', async () => {
    const report = await runChecks('http://stub.local', {
      checkIds: ['auth-alternative-access'],
      requestDelay: 0,
    });

    expect(report.results[0].status).toBe('skip');
    expect(report.results[0].message).toBe('auth-gate-detection did not run');
  });

  it('catches check errors and reports status "error"', async () => {
    registerCheck({
      id: '_test-throws',
      category: 'content-discoverability',
      description: 'Test check that throws',
      dependsOn: [],
      run: () => {
        throw new Error('Boom');
      },
    });

    const report = await runChecks('http://throws.local', {
      checkIds: ['_test-throws'],
      requestDelay: 0,
    });

    expect(report.results).toHaveLength(1);
    expect(report.results[0].id).toBe('_test-throws');
    expect(report.results[0].status).toBe('error');
    expect(report.results[0].message).toContain('Boom');
  });

  it('catches non-Error thrown values', async () => {
    registerCheck({
      id: '_test-throws-string',
      category: 'content-discoverability',
      description: 'Test check that throws a string',
      dependsOn: [],
      run: () => {
        throw 'string error';
      },
    });

    const report = await runChecks('http://throws-str.local', {
      checkIds: ['_test-throws-string'],
      requestDelay: 0,
    });

    expect(report.results[0].status).toBe('error');
    expect(report.results[0].message).toContain('string error');
  });

  it('lets check run in standalone mode when dependencies were not executed', async () => {
    // page-size-markdown depends on [['markdown-url-support', 'content-negotiation']]
    // When neither dependency runs (filtered out), page-size-markdown should still run
    // rather than being skipped.
    mockSitemapNotFound(server, 'http://standalone.local');
    server.use(
      http.get('http://standalone.local/llms.txt', () => new HttpResponse(null, { status: 404 })),
      http.get(
        'http://standalone.local/docs/llms.txt',
        () => new HttpResponse(null, { status: 404 }),
      ),
      http.get('http://standalone.local/robots.txt', () => new HttpResponse('', { status: 404 })),
      http.get('http://standalone.local/sitemap.xml', () => new HttpResponse('', { status: 404 })),
      http.get(
        'http://standalone.local',
        () =>
          new HttpResponse('<!DOCTYPE html><html><body>Home</body></html>', {
            status: 200,
            headers: { 'Content-Type': 'text/html' },
          }),
      ),
      http.get('http://standalone.local/.md', () => new HttpResponse('Not found', { status: 404 })),
      http.get(
        'http://standalone.local/index.md',
        () => new HttpResponse('Not found', { status: 404 }),
      ),
    );

    const report = await runChecks('http://standalone.local', {
      checkIds: ['page-size-markdown'],
      requestDelay: 0,
    });

    // Should NOT be 'skip' with "dependency check did not pass"
    expect(report.results).toHaveLength(1);
    expect(report.results[0].id).toBe('page-size-markdown');
    expect(report.results[0].message).not.toContain('dependency check did not pass');
  });

  it('skips check with OR-group deps when the dep that ran failed', async () => {
    // Register test checks to control the OR-group scenario precisely
    registerCheck({
      id: '_test-dep-a',
      category: 'content-discoverability',
      description: 'Dep A',
      dependsOn: [],
      run: async () => ({
        id: '_test-dep-a',
        category: 'content-discoverability',
        status: 'fail',
        message: 'Failed',
      }),
    });
    registerCheck({
      id: '_test-or-child',
      category: 'content-discoverability',
      description: 'Child with OR dep',
      dependsOn: [['_test-dep-a', '_test-dep-b']],
      run: async () => ({
        id: '_test-or-child',
        category: 'content-discoverability',
        status: 'pass',
        message: 'OK',
      }),
    });

    // Only dep-a runs (dep-b not in checkIds so never runs), and dep-a fails.
    // Since dep-a ran and failed, and dep-b didn't run, the OR-group has at least
    // one dep that ran and none passed → skip.
    const report = await runChecks('http://or-skip.local', {
      checkIds: ['_test-dep-a', '_test-or-child'],
      requestDelay: 0,
    });

    const child = report.results.find((r) => r.id === '_test-or-child');
    expect(child?.status).toBe('skip');
    expect(child?.message).toContain('dependency check did not pass');
  });

  it('runs check when OR-group dep passes', async () => {
    registerCheck({
      id: '_test-dep-pass',
      category: 'content-discoverability',
      description: 'Dep that passes',
      dependsOn: [],
      run: async () => ({
        id: '_test-dep-pass',
        category: 'content-discoverability',
        status: 'pass',
        message: 'OK',
      }),
    });
    registerCheck({
      id: '_test-or-passes',
      category: 'content-discoverability',
      description: 'Child with OR dep that passes',
      dependsOn: [['_test-dep-pass', '_test-dep-never']],
      run: async () => ({
        id: '_test-or-passes',
        category: 'content-discoverability',
        status: 'pass',
        message: 'OK',
      }),
    });

    const report = await runChecks('http://or-pass.local', {
      checkIds: ['_test-dep-pass', '_test-or-passes'],
      requestDelay: 0,
    });

    const child = report.results.find((r) => r.id === '_test-or-passes');
    expect(child?.status).toBe('pass');
  });

  it('skips checks listed in skipCheckIds without running them', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    server.use(
      http.get('http://skip-ids.local/llms.txt', () => new HttpResponse(null, { status: 404 })),
      http.get(
        'http://skip-ids.local/docs/llms.txt',
        () => new HttpResponse(null, { status: 404 }),
      ),
    );

    const report = await runChecks('http://skip-ids.local', {
      checkIds: ['llms-txt-exists', 'llms-txt-valid', 'llms-txt-size'],
      skipCheckIds: ['llms-txt-valid'],
      requestDelay: 0,
    });

    const skipped = report.results.find((r) => r.id === 'llms-txt-valid');
    expect(skipped).toBeDefined();
    expect(skipped?.status).toBe('skip');
    expect(skipped?.message).toContain('--skip-checks');

    // llms-txt-exists should still run (not in skipCheckIds)
    const exists = report.results.find((r) => r.id === 'llms-txt-exists');
    expect(exists).toBeDefined();
    expect(exists?.status).toBe('fail');

    // llms-txt-size depends on llms-txt-exists which failed, so it should be
    // skipped due to dependency — not due to skipCheckIds
    const size = report.results.find((r) => r.id === 'llms-txt-size');
    expect(size).toBeDefined();
    expect(size?.status).toBe('skip');
    expect(size?.message).toContain('dependency');
    warnSpy.mockRestore();
  });

  it('skipCheckIds does not cascade-skip dependent checks', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const content = `# Test\n\n> Summary.\n\n## Links\n\n- [A](http://skip-dep.local/a): A\n`;
    server.use(
      http.get('http://skip-dep.local/llms.txt', () => HttpResponse.text(content)),
      http.get(
        'http://skip-dep.local/docs/llms.txt',
        () => new HttpResponse(null, { status: 404 }),
      ),
    );

    // Skip llms-txt-exists; llms-txt-valid depends on it.
    // Since skipCheckIds doesn't store in previousResults, llms-txt-valid
    // should run in standalone mode (same as checkIds filtering).
    const report = await runChecks('http://skip-dep.local', {
      checkIds: ['llms-txt-exists', 'llms-txt-valid'],
      skipCheckIds: ['llms-txt-exists'],
      requestDelay: 0,
    });

    const exists = report.results.find((r) => r.id === 'llms-txt-exists');
    expect(exists?.status).toBe('skip');
    expect(exists?.message).toContain('--skip-checks');

    // llms-txt-valid should run in standalone mode, not cascade-skip
    const valid = report.results.find((r) => r.id === 'llms-txt-valid');
    expect(valid).toBeDefined();
    expect(valid?.message).not.toContain('dependency');
    warnSpy.mockRestore();
  });

  it('warns when checkIds and skipCheckIds overlap', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    server.use(
      http.get('http://overlap.local/llms.txt', () => new HttpResponse(null, { status: 404 })),
      http.get('http://overlap.local/docs/llms.txt', () => new HttpResponse(null, { status: 404 })),
    );

    const report = await runChecks('http://overlap.local', {
      checkIds: ['llms-txt-exists', 'llms-txt-valid'],
      skipCheckIds: ['llms-txt-valid'],
      requestDelay: 0,
    });

    expect(warnSpy).toHaveBeenCalledOnce();
    expect(warnSpy.mock.calls[0][0]).toContain('llms-txt-valid');
    expect(warnSpy.mock.calls[0][0]).toContain('--checks');
    expect(warnSpy.mock.calls[0][0]).toContain('--skip-checks');

    // The overlapping check should still be skipped (skip wins)
    const skipped = report.results.find((r) => r.id === 'llms-txt-valid');
    expect(skipped?.status).toBe('skip');

    warnSpy.mockRestore();
  });

  it('does not warn when checkIds and skipCheckIds do not overlap', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    server.use(
      http.get('http://no-overlap.local/llms.txt', () => new HttpResponse(null, { status: 404 })),
      http.get(
        'http://no-overlap.local/docs/llms.txt',
        () => new HttpResponse(null, { status: 404 }),
      ),
    );

    await runChecks('http://no-overlap.local', {
      checkIds: ['llms-txt-exists', 'llms-txt-valid'],
      skipCheckIds: ['llms-txt-size'],
      requestDelay: 0,
    });

    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('includes timestamp and url in report', async () => {
    mockSitemapNotFound(server, 'http://meta.local');
    server.use(
      http.get('http://meta.local/llms.txt', () => new HttpResponse(null, { status: 404 })),
      http.get('http://meta.local/docs/llms.txt', () => new HttpResponse(null, { status: 404 })),
      http.get('http://meta.local/robots.txt', () => new HttpResponse('', { status: 404 })),
      http.get('http://meta.local/sitemap.xml', () => new HttpResponse('', { status: 404 })),
      http.get(
        'http://meta.local',
        () =>
          new HttpResponse('<html><body><h1>Home</h1></body></html>', {
            status: 200,
            headers: { 'Content-Type': 'text/html' },
          }),
      ),
      http.get('http://meta.local.md', () => new HttpResponse(null, { status: 404 })),
      http.get('http://meta.local/index.md', () => new HttpResponse(null, { status: 404 })),
    );

    const report = await runChecks('http://meta.local', {
      checkIds: ['tabbed-content-serialization'],
      requestDelay: 0,
    });

    expect(report.url).toBe('http://meta.local');
    expect(report.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('includes discoverySources in report when page discovery runs', async () => {
    mockSitemapNotFound(server, 'http://sources.local');
    server.use(
      http.get('http://sources.local/llms.txt', () =>
        HttpResponse.text('# Docs\n## Links\n- [A](http://sources.local/docs/a): A\n'),
      ),
      http.get('http://sources.local/docs/llms.txt', () => new HttpResponse(null, { status: 404 })),
      http.get('http://sources.local/robots.txt', () => new HttpResponse('', { status: 404 })),
      http.get('http://sources.local/sitemap.xml', () => new HttpResponse('', { status: 404 })),
      http.get(
        'http://sources.local/docs/a',
        () =>
          new HttpResponse('<html><body><h1>A</h1></body></html>', {
            status: 200,
            headers: { 'Content-Type': 'text/html' },
          }),
      ),
      http.get('http://sources.local/docs/a.md', () => new HttpResponse(null, { status: 404 })),
      http.get(
        'http://sources.local/docs/a/index.md',
        () => new HttpResponse(null, { status: 404 }),
      ),
    );

    // markdown-url-support triggers discoverAndSamplePages, which populates sources
    const report = await runChecks('http://sources.local', {
      checkIds: ['llms-txt-exists', 'markdown-url-support'],
      requestDelay: 0,
    });

    expect(report.discoverySources).toBeDefined();
    expect(report.discoverySources).toContain('llms-txt');
  });

  it('throws on invalid options', async () => {
    await expect(runChecks('http://invalid-opts.local', { maxConcurrency: -1 })).rejects.toThrow(
      'Invalid options',
    );
  });

  it('throws on unknown check IDs', async () => {
    await expect(
      runChecks('http://invalid-opts.local', { checkIds: ['nonexistent-check'] }),
    ).rejects.toThrow('Unknown check ID');
  });
});
