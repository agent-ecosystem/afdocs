import { describe, it, expect } from 'vitest';
import { evaluateDiagnostics } from '../../../src/scoring/diagnostics.js';
import type { CheckResult, ReportResult } from '../../../src/types.js';

function r(
  id: string,
  status: CheckResult['status'],
  details?: Record<string, unknown>,
): CheckResult {
  return { id, category: 'test', status, message: '', details };
}

function resultsMap(...results: CheckResult[]): Map<string, CheckResult> {
  return new Map(results.map((res) => [res.id, res]));
}

function defaultReport(): ReportResult {
  return {
    url: 'https://example.com',
    timestamp: new Date().toISOString(),
    specUrl: 'https://agentdocsspec.com/spec/web/',
    results: [],
    summary: { total: 0, pass: 0, warn: 0, fail: 0, skip: 0, error: 0 },
    samplingStrategy: 'random',
    testedPages: 10,
  };
}

describe('diagnostics', () => {
  describe('markdown-undiscoverable', () => {
    it('triggers when markdown supported but no directive and no content negotiation', () => {
      const results = resultsMap(
        r('markdown-url-support', 'pass'),
        r('content-negotiation', 'fail'),
        r('llms-txt-directive-html', 'fail'),
      );
      const diags = evaluateDiagnostics(results, defaultReport());
      expect(diags.find((d) => d.id === 'markdown-undiscoverable')).toBeDefined();
    });

    it('does not trigger when directive-html passes', () => {
      const results = resultsMap(
        r('markdown-url-support', 'pass'),
        r('content-negotiation', 'fail'),
        r('llms-txt-directive-html', 'pass'),
      );
      const diags = evaluateDiagnostics(results, defaultReport());
      expect(diags.find((d) => d.id === 'markdown-undiscoverable')).toBeUndefined();
    });

    it('does not trigger when content-negotiation passes (partially-discoverable fires instead)', () => {
      const results = resultsMap(
        r('markdown-url-support', 'pass'),
        r('content-negotiation', 'pass'),
        r('llms-txt-directive-html', 'fail'),
      );
      const diags = evaluateDiagnostics(results, defaultReport());
      expect(diags.find((d) => d.id === 'markdown-undiscoverable')).toBeUndefined();
      expect(diags.find((d) => d.id === 'markdown-partially-discoverable')).toBeDefined();
    });

    it('does not trigger when markdown-url-support fails', () => {
      const results = resultsMap(
        r('markdown-url-support', 'fail'),
        r('content-negotiation', 'fail'),
        r('llms-txt-directive-html', 'fail'),
      );
      const diags = evaluateDiagnostics(results, defaultReport());
      expect(diags.find((d) => d.id === 'markdown-undiscoverable')).toBeUndefined();
    });
  });

  describe('markdown-partially-discoverable', () => {
    it('triggers when content negotiation passes but no HTML directive', () => {
      const results = resultsMap(
        r('markdown-url-support', 'pass'),
        r('content-negotiation', 'pass'),
        r('llms-txt-directive-html', 'fail'),
      );
      const diags = evaluateDiagnostics(results, defaultReport());
      const diag = diags.find((d) => d.id === 'markdown-partially-discoverable');
      expect(diag).toBeDefined();
      expect(diag!.severity).toBe('warning');
    });

    it('does not trigger when HTML directive passes', () => {
      const results = resultsMap(
        r('markdown-url-support', 'pass'),
        r('content-negotiation', 'pass'),
        r('llms-txt-directive-html', 'pass'),
      );
      const diags = evaluateDiagnostics(results, defaultReport());
      expect(diags.find((d) => d.id === 'markdown-partially-discoverable')).toBeUndefined();
    });

    it('does not trigger when content negotiation fails (undiscoverable fires instead)', () => {
      const results = resultsMap(
        r('markdown-url-support', 'pass'),
        r('content-negotiation', 'fail'),
        r('llms-txt-directive-html', 'fail'),
      );
      const diags = evaluateDiagnostics(results, defaultReport());
      expect(diags.find((d) => d.id === 'markdown-partially-discoverable')).toBeUndefined();
      expect(diags.find((d) => d.id === 'markdown-undiscoverable')).toBeDefined();
    });
  });

  describe('truncated-index', () => {
    it('triggers when llms.txt exists but is too large', () => {
      const results = resultsMap(
        r('llms-txt-exists', 'pass'),
        r('llms-txt-size', 'fail', {
          sizes: [{ characters: 250_000 }],
        }),
      );
      const diags = evaluateDiagnostics(results, defaultReport());
      const diag = diags.find((d) => d.id === 'truncated-index');
      expect(diag).toBeDefined();
      expect(diag!.message).toContain('250,000');
      expect(diag!.message).toContain('40%');
    });

    it('does not trigger when llms.txt is absent', () => {
      const results = resultsMap(r('llms-txt-exists', 'fail'), r('llms-txt-size', 'fail'));
      const diags = evaluateDiagnostics(results, defaultReport());
      expect(diags.find((d) => d.id === 'truncated-index')).toBeUndefined();
    });
  });

  describe('spa-shell-html-invalid', () => {
    it('triggers when >25% of pages are SPA shells', () => {
      const results = resultsMap(
        r('rendering-strategy', 'fail', {
          serverRendered: 5,
          sparseContent: 0,
          spaShells: 15,
        }),
      );
      const diags = evaluateDiagnostics(results, defaultReport());
      expect(diags.find((d) => d.id === 'spa-shell-html-invalid')).toBeDefined();
    });

    it('does not trigger when rendering-strategy passes', () => {
      const results = resultsMap(
        r('rendering-strategy', 'pass', {
          serverRendered: 20,
          sparseContent: 0,
          spaShells: 0,
        }),
      );
      const diags = evaluateDiagnostics(results, defaultReport());
      expect(diags.find((d) => d.id === 'spa-shell-html-invalid')).toBeUndefined();
    });

    it('does not trigger when only sparse content is present (no shells)', () => {
      // Archbee-style site: server-rendered short pages that the heuristic
      // classifies as sparse but no actual shells.
      const results = resultsMap(
        r('rendering-strategy', 'warn', {
          serverRendered: 36,
          sparseContent: 32,
          spaShells: 0,
        }),
      );
      const diags = evaluateDiagnostics(results, defaultReport());
      expect(diags.find((d) => d.id === 'spa-shell-html-invalid')).toBeUndefined();
    });

    it('does not trigger when sparse content is dominant but shells are below threshold', () => {
      // 1 shell out of 20 = 5%, below 25% threshold — should not fire as
      // shell diagnostic even though sparse-content-html will fire.
      const results = resultsMap(
        r('rendering-strategy', 'warn', {
          serverRendered: 5,
          sparseContent: 14,
          spaShells: 1,
        }),
      );
      const diags = evaluateDiagnostics(results, defaultReport());
      expect(diags.find((d) => d.id === 'spa-shell-html-invalid')).toBeUndefined();
    });

    it('includes markdown note when available', () => {
      const results = resultsMap(
        r('rendering-strategy', 'fail', {
          serverRendered: 5,
          sparseContent: 0,
          spaShells: 15,
        }),
        r('markdown-url-support', 'pass'),
      );
      const diags = evaluateDiagnostics(results, defaultReport());
      const diag = diags.find((d) => d.id === 'spa-shell-html-invalid');
      expect(diag!.message).toContain('markdown path still works');
    });

    it('describes shells specifically rather than client-side rendering generally', () => {
      const results = resultsMap(
        r('rendering-strategy', 'fail', {
          serverRendered: 5,
          sparseContent: 0,
          spaShells: 15,
        }),
      );
      const diags = evaluateDiagnostics(results, defaultReport());
      const diag = diags.find((d) => d.id === 'spa-shell-html-invalid');
      expect(diag!.message).toContain('client-side-rendered shells');
      expect(diag!.message).toContain('15 of 20');
    });
  });

  describe('sparse-content-html', () => {
    it('triggers when >25% of pages are sparse and no shells are present', () => {
      // Archbee-style: server-rendered short pages
      const results = resultsMap(
        r('rendering-strategy', 'warn', {
          serverRendered: 36,
          sparseContent: 32,
          spaShells: 0,
        }),
      );
      const diags = evaluateDiagnostics(results, defaultReport());
      const diag = diags.find((d) => d.id === 'sparse-content-html');
      expect(diag).toBeDefined();
      expect(diag!.severity).toBe('info');
      expect(diag!.message).toContain('32 of 68');
    });

    it('does not accuse the site of client-side rendering', () => {
      const results = resultsMap(
        r('rendering-strategy', 'warn', {
          serverRendered: 36,
          sparseContent: 32,
          spaShells: 0,
        }),
      );
      const diags = evaluateDiagnostics(results, defaultReport());
      const diag = diags.find((d) => d.id === 'sparse-content-html');
      expect(diag!.message).toContain('render server-side');
      expect(diag!.message).not.toContain('use client-side rendering');
      expect(diag!.message).not.toContain('empty shell');
    });

    it('does not trigger when rendering-strategy passes', () => {
      const results = resultsMap(
        r('rendering-strategy', 'pass', {
          serverRendered: 20,
          sparseContent: 0,
          spaShells: 0,
        }),
      );
      const diags = evaluateDiagnostics(results, defaultReport());
      expect(diags.find((d) => d.id === 'sparse-content-html')).toBeUndefined();
    });

    it('does not trigger when sparse count is below threshold', () => {
      const results = resultsMap(
        r('rendering-strategy', 'warn', {
          serverRendered: 18,
          sparseContent: 2,
          spaShells: 0,
        }),
      );
      const diags = evaluateDiagnostics(results, defaultReport());
      expect(diags.find((d) => d.id === 'sparse-content-html')).toBeUndefined();
    });

    it('is suppressed when spa-shell-html-invalid already fired', () => {
      // Mixed case: both shells and sparse over threshold. Shell diagnostic
      // is the bigger problem; sparse is suppressed to avoid double-reporting.
      const results = resultsMap(
        r('rendering-strategy', 'fail', {
          serverRendered: 3,
          sparseContent: 5,
          spaShells: 5,
        }),
      );
      const diags = evaluateDiagnostics(results, defaultReport());
      expect(diags.find((d) => d.id === 'spa-shell-html-invalid')).toBeDefined();
      expect(diags.find((d) => d.id === 'sparse-content-html')).toBeUndefined();
    });

    it('fires when sparse dominates and shells are below threshold', () => {
      // 1 shell out of 20 = 5%, below 25%. Sparse diagnostic should fire alone.
      const results = resultsMap(
        r('rendering-strategy', 'warn', {
          serverRendered: 5,
          sparseContent: 14,
          spaShells: 1,
        }),
      );
      const diags = evaluateDiagnostics(results, defaultReport());
      expect(diags.find((d) => d.id === 'spa-shell-html-invalid')).toBeUndefined();
      expect(diags.find((d) => d.id === 'sparse-content-html')).toBeDefined();
    });

    it('includes markdown note when markdown path is available', () => {
      const results = resultsMap(
        r('rendering-strategy', 'warn', {
          serverRendered: 36,
          sparseContent: 32,
          spaShells: 0,
        }),
        r('markdown-url-support', 'pass'),
      );
      const diags = evaluateDiagnostics(results, defaultReport());
      const diag = diags.find((d) => d.id === 'sparse-content-html');
      expect(diag!.message).toContain('markdown path still works');
    });

    it('notes no alternative path when markdown unavailable', () => {
      const results = resultsMap(
        r('rendering-strategy', 'warn', {
          serverRendered: 36,
          sparseContent: 32,
          spaShells: 0,
        }),
        r('markdown-url-support', 'fail'),
      );
      const diags = evaluateDiagnostics(results, defaultReport());
      const diag = diags.find((d) => d.id === 'sparse-content-html');
      expect(diag!.message).toContain('no alternative path');
    });
  });

  describe('no-viable-path', () => {
    it('triggers when no llms.txt, no rendering, and markdown undiscoverable', () => {
      const results = resultsMap(
        r('llms-txt-exists', 'fail'),
        r('rendering-strategy', 'fail', {
          serverRendered: 0,
          sparseContent: 0,
          spaShells: 20,
        }),
        r('markdown-url-support', 'pass'),
        r('content-negotiation', 'fail'),
        r('llms-txt-directive-html', 'fail'),
        r('llms-txt-directive-md', 'fail'),
        r('llms-txt-links-markdown', 'fail'),
      );
      const diags = evaluateDiagnostics(results, defaultReport());
      expect(diags.find((d) => d.id === 'no-viable-path')).toBeDefined();
      expect(diags.find((d) => d.id === 'no-viable-path')!.severity).toBe('critical');
    });

    it('triggers when markdown-url-support fails', () => {
      const results = resultsMap(
        r('llms-txt-exists', 'fail'),
        r('rendering-strategy', 'fail'),
        r('markdown-url-support', 'fail'),
      );
      const diags = evaluateDiagnostics(results, defaultReport());
      expect(diags.find((d) => d.id === 'no-viable-path')).toBeDefined();
    });

    it('does not trigger when llms-txt-exists passes and links resolve', () => {
      const results = resultsMap(
        r('llms-txt-exists', 'pass'),
        r('llms-txt-links-resolve', 'pass', { resolveRate: 100 }),
        r('rendering-strategy', 'fail'),
        r('markdown-url-support', 'fail'),
      );
      const diags = evaluateDiagnostics(results, defaultReport());
      expect(diags.find((d) => d.id === 'no-viable-path')).toBeUndefined();
    });

    it('triggers when llms.txt exists but links are broken (<10% resolve)', () => {
      const results = resultsMap(
        r('llms-txt-exists', 'pass'),
        r('llms-txt-links-resolve', 'fail', { resolveRate: 0 }),
        r('rendering-strategy', 'fail', {
          serverRendered: 0,
          sparseContent: 0,
          spaShells: 20,
        }),
        r('markdown-url-support', 'fail'),
      );
      const diags = evaluateDiagnostics(results, defaultReport());
      const diag = diags.find((d) => d.id === 'no-viable-path');
      expect(diag).toBeDefined();
      expect(diag!.message).toContain('0% of links resolve');
    });

    it('triggers when markdown is only partially discoverable', () => {
      const results = resultsMap(
        r('llms-txt-exists', 'fail'),
        r('rendering-strategy', 'fail', {
          serverRendered: 0,
          sparseContent: 0,
          spaShells: 20,
        }),
        r('markdown-url-support', 'pass'),
        r('content-negotiation', 'pass'),
        r('llms-txt-directive-html', 'fail'),
      );
      const diags = evaluateDiagnostics(results, defaultReport());
      expect(diags.find((d) => d.id === 'markdown-partially-discoverable')).toBeDefined();
      expect(diags.find((d) => d.id === 'no-viable-path')).toBeDefined();
    });

    it('does not trigger when llms.txt links resolve at 10%+', () => {
      const results = resultsMap(
        r('llms-txt-exists', 'pass'),
        r('llms-txt-links-resolve', 'fail', { resolveRate: 15 }),
        r('rendering-strategy', 'fail'),
        r('markdown-url-support', 'fail'),
      );
      const diags = evaluateDiagnostics(results, defaultReport());
      expect(diags.find((d) => d.id === 'no-viable-path')).toBeUndefined();
    });
  });

  describe('auth-no-alternative', () => {
    it('triggers when both auth checks fail', () => {
      const results = resultsMap(
        r('auth-gate-detection', 'fail'),
        r('auth-alternative-access', 'fail'),
      );
      const diags = evaluateDiagnostics(results, defaultReport());
      const diag = diags.find((d) => d.id === 'auth-no-alternative');
      expect(diag).toBeDefined();
      expect(diag!.severity).toBe('critical');
    });

    it('does not trigger when alternative access exists', () => {
      const results = resultsMap(
        r('auth-gate-detection', 'fail'),
        r('auth-alternative-access', 'pass'),
      );
      const diags = evaluateDiagnostics(results, defaultReport());
      expect(diags.find((d) => d.id === 'auth-no-alternative')).toBeUndefined();
    });
  });

  describe('page-size-no-markdown-escape', () => {
    it('triggers when HTML pages too big and no markdown path', () => {
      const results = resultsMap(
        r('page-size-html', 'fail', { failBucket: 12 }),
        r('markdown-url-support', 'fail'),
      );
      const diags = evaluateDiagnostics(results, defaultReport());
      const diag = diags.find((d) => d.id === 'page-size-no-markdown-escape');
      expect(diag).toBeDefined();
      expect(diag!.message).toContain('12 pages');
    });

    it('triggers when markdown is undiscoverable', () => {
      const results = resultsMap(
        r('page-size-html', 'fail', { failBucket: 5 }),
        r('markdown-url-support', 'pass'),
        r('content-negotiation', 'fail'),
        r('llms-txt-directive-html', 'fail'),
        r('llms-txt-directive-md', 'fail'),
        r('llms-txt-links-markdown', 'fail'),
      );
      const diags = evaluateDiagnostics(results, defaultReport());
      expect(diags.find((d) => d.id === 'page-size-no-markdown-escape')).toBeDefined();
    });

    it('triggers when markdown is only partially discoverable (content negotiation but no directive)', () => {
      const results = resultsMap(
        r('page-size-html', 'fail', { failBucket: 5 }),
        r('markdown-url-support', 'pass'),
        r('content-negotiation', 'pass'),
        r('llms-txt-directive-html', 'fail'),
      );
      const diags = evaluateDiagnostics(results, defaultReport());
      expect(diags.find((d) => d.id === 'page-size-no-markdown-escape')).toBeDefined();
    });

    it('does not trigger when markdown is discoverable via directive', () => {
      const results = resultsMap(
        r('page-size-html', 'fail', { failBucket: 5 }),
        r('markdown-url-support', 'pass'),
        r('llms-txt-directive-html', 'pass'),
      );
      const diags = evaluateDiagnostics(results, defaultReport());
      expect(diags.find((d) => d.id === 'page-size-no-markdown-escape')).toBeUndefined();
    });
  });

  // --- New diagnostics ---

  describe('single-page-sample', () => {
    it('triggers when testedPages is 1 and strategy is discovery-based', () => {
      const report = { ...defaultReport(), testedPages: 1, samplingStrategy: 'random' as const };
      const diags = evaluateDiagnostics(resultsMap(), report);
      const diag = diags.find((d) => d.id === 'single-page-sample');
      expect(diag).toBeDefined();
      expect(diag!.severity).toBe('warning');
    });

    it('triggers with deterministic sampling', () => {
      const report = {
        ...defaultReport(),
        testedPages: 1,
        samplingStrategy: 'deterministic' as const,
      };
      const diags = evaluateDiagnostics(resultsMap(), report);
      expect(diags.find((d) => d.id === 'single-page-sample')).toBeDefined();
    });

    it('does not trigger with curated sampling', () => {
      const report = { ...defaultReport(), testedPages: 1, samplingStrategy: 'curated' as const };
      const diags = evaluateDiagnostics(resultsMap(), report);
      expect(diags.find((d) => d.id === 'single-page-sample')).toBeUndefined();
    });

    it('does not trigger with none sampling', () => {
      const report = { ...defaultReport(), testedPages: 1, samplingStrategy: 'none' as const };
      const diags = evaluateDiagnostics(resultsMap(), report);
      expect(diags.find((d) => d.id === 'single-page-sample')).toBeUndefined();
    });

    it('does not trigger when testedPages >= threshold', () => {
      const report = { ...defaultReport(), testedPages: 5, samplingStrategy: 'random' as const };
      const diags = evaluateDiagnostics(resultsMap(), report);
      expect(diags.find((d) => d.id === 'single-page-sample')).toBeUndefined();
    });

    it('triggers when testedPages is below threshold but above 1', () => {
      const report = { ...defaultReport(), testedPages: 3, samplingStrategy: 'random' as const };
      const diags = evaluateDiagnostics(resultsMap(), report);
      const diag = diags.find((d) => d.id === 'single-page-sample');
      expect(diag).toBeDefined();
      expect(diag!.message).toContain('3 pages were');
      expect(diag!.message).toContain('minimum 5');
    });

    it('does not trigger when testedPages is undefined', () => {
      const report = { ...defaultReport(), testedPages: undefined };
      const diags = evaluateDiagnostics(resultsMap(), report);
      expect(diags.find((d) => d.id === 'single-page-sample')).toBeUndefined();
    });
  });

  describe('cross-origin-llms-txt', () => {
    it('triggers when all links are cross-origin', () => {
      const results = resultsMap(
        r('llms-txt-links-resolve', 'warn', {
          sameOrigin: { total: 0 },
          crossOrigin: { total: 15, dominantOrigin: 'https://docs.example.com' },
        }),
      );
      const diags = evaluateDiagnostics(results, defaultReport());
      const diag = diags.find((d) => d.id === 'cross-origin-llms-txt');
      expect(diag).toBeDefined();
      expect(diag!.severity).toBe('warning');
      expect(diag!.message).toContain('15 links');
      expect(diag!.message).toContain('https://docs.example.com');
    });

    it('does not trigger when there are same-origin links', () => {
      const results = resultsMap(
        r('llms-txt-links-resolve', 'pass', {
          sameOrigin: { total: 10 },
          crossOrigin: { total: 5 },
        }),
      );
      const diags = evaluateDiagnostics(results, defaultReport());
      expect(diags.find((d) => d.id === 'cross-origin-llms-txt')).toBeUndefined();
    });

    it('does not trigger when check is skipped', () => {
      const results = resultsMap(r('llms-txt-links-resolve', 'skip'));
      const diags = evaluateDiagnostics(results, defaultReport());
      expect(diags.find((d) => d.id === 'cross-origin-llms-txt')).toBeUndefined();
    });

    it('does not trigger when there are no cross-origin links', () => {
      const results = resultsMap(
        r('llms-txt-links-resolve', 'pass', {
          sameOrigin: { total: 0 },
          crossOrigin: { total: 0 },
        }),
      );
      const diags = evaluateDiagnostics(results, defaultReport());
      expect(diags.find((d) => d.id === 'cross-origin-llms-txt')).toBeUndefined();
    });
  });

  describe('gzipped-sitemap-skipped', () => {
    it('triggers when a check has a gzipped sitemap warning', () => {
      const results = resultsMap(
        r('page-size-html', 'pass', {
          discoveryWarnings: [
            'Skipped gzipped sitemap (not supported): https://example.com/sitemap.xml.gz',
          ],
        }),
      );
      const diags = evaluateDiagnostics(results, defaultReport());
      const diag = diags.find((d) => d.id === 'gzipped-sitemap-skipped');
      expect(diag).toBeDefined();
      expect(diag!.severity).toBe('info');
      expect(diag!.message).toContain('sitemap.xml.gz');
    });

    it('does not trigger without gzipped sitemap warnings', () => {
      const results = resultsMap(
        r('page-size-html', 'pass', {
          discoveryWarnings: ['Some other warning'],
        }),
      );
      const diags = evaluateDiagnostics(results, defaultReport());
      expect(diags.find((d) => d.id === 'gzipped-sitemap-skipped')).toBeUndefined();
    });

    it('does not trigger with no discovery warnings', () => {
      const results = resultsMap(r('page-size-html', 'pass'));
      const diags = evaluateDiagnostics(results, defaultReport());
      expect(diags.find((d) => d.id === 'gzipped-sitemap-skipped')).toBeUndefined();
    });
  });

  describe('rate-limiting-severe', () => {
    it('triggers when >20% of requests are rate-limited', () => {
      const results = resultsMap(
        r('llms-txt-links-resolve', 'warn', {
          testedLinks: 50,
          rateLimited: 15,
        }),
      );
      const diags = evaluateDiagnostics(results, defaultReport());
      const diag = diags.find((d) => d.id === 'rate-limiting-severe');
      expect(diag).toBeDefined();
      expect(diag!.severity).toBe('warning');
      expect(diag!.message).toContain('30%');
    });

    it('does not trigger when rate limiting is below threshold', () => {
      const results = resultsMap(
        r('llms-txt-links-resolve', 'pass', {
          testedLinks: 50,
          rateLimited: 5,
        }),
      );
      const diags = evaluateDiagnostics(results, defaultReport());
      expect(diags.find((d) => d.id === 'rate-limiting-severe')).toBeUndefined();
    });

    it('aggregates rate limiting across multiple checks', () => {
      const results = resultsMap(
        r('llms-txt-links-resolve', 'pass', {
          testedLinks: 50,
          rateLimited: 5,
        }),
        r('markdown-url-support', 'warn', {
          pageResults: Array.from({ length: 10 }, () => ({})),
          rateLimited: 8,
        }),
      );
      const diags = evaluateDiagnostics(results, defaultReport());
      // 13/60 = 21.7% -> triggers
      expect(diags.find((d) => d.id === 'rate-limiting-severe')).toBeDefined();
    });

    it('does not trigger when no checks have rate limiting data', () => {
      const results = resultsMap(r('page-size-html', 'pass'));
      const diags = evaluateDiagnostics(results, defaultReport());
      expect(diags.find((d) => d.id === 'rate-limiting-severe')).toBeUndefined();
    });

    it('uses pageResults length when testedLinks is absent', () => {
      const results = resultsMap(
        r('markdown-url-support', 'warn', {
          pageResults: Array.from({ length: 10 }, () => ({})),
          rateLimited: 5,
        }),
      );
      const diags = evaluateDiagnostics(results, defaultReport());
      const diag = diags.find((d) => d.id === 'rate-limiting-severe');
      expect(diag).toBeDefined();
      expect(diag!.message).toContain('50%');
    });
  });

  describe('gzipped-sitemap-skipped message', () => {
    it('includes URL from warning when regex matches', () => {
      const results = resultsMap(
        r('page-size-html', 'pass', {
          discoveryWarnings: [
            'Skipped gzipped sitemap (not supported): https://example.com/sitemap.xml.gz',
          ],
        }),
      );
      const diags = evaluateDiagnostics(results, defaultReport());
      const diag = diags.find((d) => d.id === 'gzipped-sitemap-skipped');
      expect(diag!.message).toContain('https://example.com/sitemap.xml.gz');
    });

    it('handles warning without URL pattern', () => {
      const results = resultsMap(
        r('page-size-html', 'pass', {
          discoveryWarnings: ['Skipped gzipped sitemap (not supported)'],
        }),
      );
      const diags = evaluateDiagnostics(results, defaultReport());
      const diag = diags.find((d) => d.id === 'gzipped-sitemap-skipped');
      expect(diag).toBeDefined();
      expect(diag!.message).toContain('gzipped sitemap was skipped');
    });
  });

  describe('spa-shell-html-invalid message', () => {
    it('notes no alternative path when markdown-url-support fails', () => {
      const results = resultsMap(
        r('rendering-strategy', 'fail', {
          serverRendered: 3,
          sparseContent: 5,
          spaShells: 5,
        }),
        r('markdown-url-support', 'fail'),
      );
      const diags = evaluateDiagnostics(results, defaultReport());
      const diag = diags.find((d) => d.id === 'spa-shell-html-invalid');
      expect(diag).toBeDefined();
      expect(diag!.message).toContain('no alternative path');
    });
  });

  describe('no-viable-path message', () => {
    it('describes missing llms.txt when status is fail', () => {
      const results = resultsMap(
        r('llms-txt-exists', 'fail'),
        r('rendering-strategy', 'fail'),
        r('markdown-url-support', 'fail'),
      );
      const diags = evaluateDiagnostics(results, defaultReport());
      const diag = diags.find((d) => d.id === 'no-viable-path');
      expect(diag!.message).toContain('no llms.txt');
    });

    it('describes broken llms.txt links when resolve rate is low', () => {
      const results = resultsMap(
        r('llms-txt-exists', 'pass'),
        r('llms-txt-links-resolve', 'fail', { resolveRate: 5 }),
        r('rendering-strategy', 'fail'),
        r('markdown-url-support', 'fail'),
      );
      const diags = evaluateDiagnostics(results, defaultReport());
      const diag = diags.find((d) => d.id === 'no-viable-path');
      expect(diag!.message).toContain('5% of links resolve');
    });
  });

  describe('truncated-index message', () => {
    it('computes visible percentage from file size', () => {
      const results = resultsMap(
        r('llms-txt-exists', 'pass'),
        r('llms-txt-size', 'fail', { sizes: [{ characters: 500_000 }] }),
      );
      const diags = evaluateDiagnostics(results, defaultReport());
      const diag = diags.find((d) => d.id === 'truncated-index');
      expect(diag!.message).toContain('500,000 characters');
      expect(diag!.message).toContain('20%');
    });
  });

  describe('page-size-no-markdown-escape message', () => {
    it('includes fail bucket count in message', () => {
      const results = resultsMap(
        r('page-size-html', 'fail', { failBucket: 7 }),
        r('markdown-url-support', 'fail'),
      );
      const diags = evaluateDiagnostics(results, defaultReport());
      const diag = diags.find((d) => d.id === 'page-size-no-markdown-escape');
      expect(diag!.message).toContain('7 pages');
    });
  });

  describe('single-page-sample message', () => {
    it('uses plural form for multiple pages', () => {
      const report = defaultReport();
      report.testedPages = 3;
      const results = resultsMap();
      const diags = evaluateDiagnostics(results, report);
      const diag = diags.find((d) => d.id === 'single-page-sample');
      expect(diag!.message).toContain('3 pages were');
    });
  });
  describe('bot-protection-scan-reliability', () => {
    it('triggers when the check warns, regardless of the failure rate', () => {
      const results = resultsMap(
        r('bot-protection-interference', 'warn', {
          requests: 100,
          failedRequests: 4,
          stalledBodies: 4,
          challengePages: 0,
          fetchErrors: 0,
        }),
      );
      const report = {
        ...defaultReport(),
        requestSummary: {
          requests: 100,
          stalledBodies: 4,
          challengePages: 0,
          fetchErrors: 0,
          failed: 4,
          failureRate: 4,
        },
      };
      const diag = evaluateDiagnostics(results, report).find(
        (d) => d.id === 'bot-protection-scan-reliability',
      );
      expect(diag).toBeDefined();
      expect(diag!.severity).toBe('warning');
      expect(diag!.message).toContain(
        '4% of HTTP requests during this scan failed, timed out, or were denied',
      );
      expect(diag!.message).toContain('4 stalled bodies');
      expect(diag!.message).toContain('only the 96 requests that completed');
      expect(diag!.message).toContain('intermittent interference');
    });

    it('reports denial-only interference from the check counts, not the request summary', () => {
      const results = resultsMap(
        r('bot-protection-interference', 'warn', {
          requests: 238,
          failedRequests: 57,
          stalledBodies: 0,
          challengePages: 0,
          fetchErrors: 0,
          deniedCounted: 57,
          affectedChecks: ['redirect-behavior', 'auth-gate-detection'],
        }),
      );
      const report = {
        ...defaultReport(),
        // The run-level summary knows nothing about correlated denials.
        requestSummary: {
          requests: 238,
          stalledBodies: 0,
          challengePages: 0,
          fetchErrors: 0,
          failed: 0,
          failureRate: 0,
        },
      };
      const diag = evaluateDiagnostics(results, report).find(
        (d) => d.id === 'bot-protection-scan-reliability',
      );
      expect(diag!.message).toContain('24% of HTTP requests');
      expect(diag!.message).toContain('57 denied responses');
      expect(diag!.message).toContain('only the 181 requests that completed');
    });

    it('names the checks that ran during the interference window', () => {
      const results = resultsMap(
        r('bot-protection-interference', 'warn', {
          requests: 200,
          failedRequests: 2,
          stalledBodies: 2,
          challengePages: 0,
          fetchErrors: 0,
          affectedChecks: ['auth-gate-detection'],
        }),
      );
      const diag = evaluateDiagnostics(results, defaultReport()).find(
        (d) => d.id === 'bot-protection-scan-reliability',
      );
      expect(diag!.message).toContain(
        'Checks that ran during the interference window: auth-gate-detection.',
      );
    });

    it('triggers when the check fails', () => {
      const results = resultsMap(r('bot-protection-interference', 'fail'));
      const diag = evaluateDiagnostics(results, defaultReport()).find(
        (d) => d.id === 'bot-protection-scan-reliability',
      );
      expect(diag).toBeDefined();
      expect(diag!.message).toContain('sustained interference');
    });

    it('triggers on a high run-level failure rate even when the check passed', () => {
      const results = resultsMap(r('bot-protection-interference', 'pass'));
      const report = {
        ...defaultReport(),
        requestSummary: {
          requests: 50,
          stalledBodies: 0,
          challengePages: 0,
          fetchErrors: 12,
          failed: 12,
          failureRate: 24,
        },
      };
      const diag = evaluateDiagnostics(results, report).find(
        (d) => d.id === 'bot-protection-scan-reliability',
      );
      expect(diag).toBeDefined();
      expect(diag!.message).toContain('24% of HTTP requests');
      expect(diag!.message).toContain('12 connection errors');
      expect(diag!.message).not.toContain('interference.');
    });

    it('triggers on a high failure rate when the check did not run', () => {
      const report = {
        ...defaultReport(),
        requestSummary: {
          requests: 20,
          stalledBodies: 4,
          challengePages: 0,
          fetchErrors: 0,
          failed: 4,
          failureRate: 20,
        },
      };
      const diags = evaluateDiagnostics(resultsMap(), report);
      expect(diags.find((d) => d.id === 'bot-protection-scan-reliability')).toBeDefined();
    });

    it('needs at least 20 requests before the rate alone can trigger it', () => {
      const report = {
        ...defaultReport(),
        requestSummary: {
          requests: 10,
          stalledBodies: 0,
          challengePages: 0,
          fetchErrors: 2,
          failed: 2,
          failureRate: 20,
        },
      };
      const diags = evaluateDiagnostics(resultsMap(), report);
      expect(diags.find((d) => d.id === 'bot-protection-scan-reliability')).toBeUndefined();
    });

    it('does not trigger below the failure-rate threshold when the check passed', () => {
      const results = resultsMap(r('bot-protection-interference', 'pass'));
      const report = {
        ...defaultReport(),
        requestSummary: {
          requests: 50,
          stalledBodies: 0,
          challengePages: 0,
          fetchErrors: 5,
          failed: 5,
          failureRate: 10,
        },
      };
      const diags = evaluateDiagnostics(results, report);
      expect(diags.find((d) => d.id === 'bot-protection-scan-reliability')).toBeUndefined();
    });

    it('does not trigger with no evidence at all', () => {
      const diags = evaluateDiagnostics(resultsMap(), defaultReport());
      expect(diags.find((d) => d.id === 'bot-protection-scan-reliability')).toBeUndefined();
    });
  });
});
