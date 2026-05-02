import { describe, it, expect } from 'vitest';
import { getCheckProportion } from '../../../src/scoring/proportions.js';
import type { CheckResult } from '../../../src/types.js';
import type { CheckWeight } from '../../../src/scoring/weights.js';

function makeResult(
  id: string,
  status: CheckResult['status'],
  details?: Record<string, unknown>,
): CheckResult {
  return { id, category: 'test', status, message: '', details };
}

function makeWeight(weight: number, warnCoefficient?: number): CheckWeight {
  return { tier: 'high', weight, warnCoefficient };
}

describe('proportions', () => {
  describe('single-resource checks (status fallback)', () => {
    it('returns 1.0 for pass', () => {
      const result = getCheckProportion(makeResult('llms-txt-exists', 'pass'), makeWeight(10, 0.5));
      expect(result).toEqual({ proportion: 1.0, tested: 1 });
    });

    it('uses warn coefficient for warn', () => {
      const result = getCheckProportion(makeResult('llms-txt-exists', 'warn'), makeWeight(10, 0.5));
      expect(result).toEqual({ proportion: 0.5, tested: 1 });
    });

    it('returns 0.0 for fail', () => {
      const result = getCheckProportion(makeResult('llms-txt-exists', 'fail'), makeWeight(10, 0.5));
      expect(result).toEqual({ proportion: 0.0, tested: 1 });
    });

    it('returns undefined for skip', () => {
      const result = getCheckProportion(makeResult('llms-txt-exists', 'skip'), makeWeight(10, 0.5));
      expect(result).toBeUndefined();
    });

    it('returns undefined for error', () => {
      const result = getCheckProportion(
        makeResult('llms-txt-exists', 'error'),
        makeWeight(10, 0.5),
      );
      expect(result).toBeUndefined();
    });
  });

  describe('bucket-based checks', () => {
    it('computes proportion from pass/warn/fail buckets', () => {
      const result = getCheckProportion(
        makeResult('page-size-html', 'warn', {
          passBucket: 40,
          warnBucket: 5,
          failBucket: 5,
        }),
        makeWeight(7, 0.5),
      );
      // (40 + 5*0.5) / 50 = 42.5 / 50 = 0.85
      expect(result!.proportion).toBeCloseTo(0.85);
      expect(result!.tested).toBe(50);
    });

    it('handles all-pass buckets', () => {
      const result = getCheckProportion(
        makeResult('page-size-html', 'pass', {
          passBucket: 50,
          warnBucket: 0,
          failBucket: 0,
        }),
        makeWeight(7, 0.5),
      );
      expect(result!.proportion).toBe(1.0);
    });

    it('handles all-fail buckets', () => {
      const result = getCheckProportion(
        makeResult('page-size-html', 'fail', {
          passBucket: 0,
          warnBucket: 0,
          failBucket: 50,
        }),
        makeWeight(7, 0.5),
      );
      expect(result!.proportion).toBe(0.0);
    });
  });

  describe('pageResults-based checks (CheckStatus status field)', () => {
    it('counts statuses from markdown-code-fence-validity pageResults', () => {
      const result = getCheckProportion(
        makeResult('markdown-code-fence-validity', 'fail', {
          pageResults: [
            { url: '/a', status: 'pass', fenceCount: 3, issues: [] },
            { url: '/b', status: 'pass', fenceCount: 1, issues: [] },
            { url: '/c', status: 'fail', fenceCount: 2, issues: [{ line: 5 }] },
          ],
        }),
        makeWeight(4),
      );
      // 2 pass, 1 fail = 2/3
      expect(result!.proportion).toBeCloseTo(0.667, 2);
      expect(result!.tested).toBe(3);
    });
  });

  describe('http-status-codes', () => {
    it('maps classifications to pass/fail', () => {
      const result = getCheckProportion(
        makeResult('http-status-codes', 'fail', {
          pageResults: [
            { url: '/a', classification: 'correct-error', status: 404 },
            { url: '/b', classification: 'correct-error', status: 404 },
            { url: '/c', classification: 'soft-404', status: 200 },
          ],
        }),
        makeWeight(7),
      );
      // 2 correct-error (pass), 1 soft-404 (fail) = 2/3
      expect(result!.proportion).toBeCloseTo(0.667, 2);
      expect(result!.tested).toBe(3);
    });

    it('skips indeterminate items from the proportion', () => {
      const result = getCheckProportion(
        makeResult('http-status-codes', 'fail', {
          pageResults: [
            { url: '/a', classification: 'correct-error', status: 404 },
            { url: '/b', classification: 'soft-404', status: 200 },
            { url: '/c', classification: 'indeterminate', status: 202 },
          ],
        }),
        makeWeight(7),
      );
      // 1 pass, 1 fail, 1 skipped = 1/2
      expect(result!.proportion).toBeCloseTo(0.5, 2);
      expect(result!.tested).toBe(2);
    });

    it('falls back to top-level warn status when all items are indeterminate', () => {
      // Extractor returns undefined for all-indeterminate, so scoring falls
      // back to the top-level 'warn' status. The site gets warn-coefficient
      // credit for the check rather than a hard 0 (we couldn't measure).
      const result = getCheckProportion(
        makeResult('http-status-codes', 'warn', {
          pageResults: [
            { url: '/a', classification: 'indeterminate', status: 202 },
            { url: '/b', classification: 'indeterminate', status: 503 },
          ],
        }),
        makeWeight(7),
      );
      expect(result!.proportion).toBe(0.5);
      expect(result!.tested).toBe(1);
    });
  });

  describe('markdown-url-support', () => {
    it('maps supported boolean to pass/fail', () => {
      const result = getCheckProportion(
        makeResult('markdown-url-support', 'warn', {
          pageResults: [
            { url: '/a', mdUrl: '/a.md', supported: true, status: 200 },
            { url: '/b', mdUrl: '/b.md', supported: true, status: 200 },
            { url: '/c', mdUrl: '/c.md', supported: false, status: 404 },
          ],
        }),
        makeWeight(7, 0.5),
      );
      // 2 pass, 1 fail = 2/3
      expect(result!.proportion).toBeCloseTo(0.667, 2);
    });

    it('excludes skipped pages', () => {
      const result = getCheckProportion(
        makeResult('markdown-url-support', 'pass', {
          pageResults: [
            { url: '/a', mdUrl: '/a.md', supported: true, status: 200 },
            { url: '/b', skipped: true, status: 0 },
          ],
        }),
        makeWeight(7, 0.5),
      );
      expect(result!.proportion).toBe(1.0);
      expect(result!.tested).toBe(1);
    });
  });

  describe('content-negotiation', () => {
    it('maps classifications to pass/warn/fail', () => {
      const result = getCheckProportion(
        makeResult('content-negotiation', 'warn', {
          pageResults: [
            { url: '/a', classification: 'markdown-with-correct-type', status: 200 },
            { url: '/b', classification: 'markdown-with-wrong-type', status: 200 },
            { url: '/c', classification: 'html', status: 200 },
          ],
        }),
        makeWeight(4, 0.75),
      );
      // (1 + 0.75) / 3 = 0.5833
      expect(result!.proportion).toBeCloseTo(0.583, 2);
    });
  });

  describe('llms-txt-directive-html', () => {
    it('maps found boolean and position to pass/warn/fail', () => {
      const result = getCheckProportion(
        makeResult('llms-txt-directive-html', 'warn', {
          pageResults: [
            { url: '/a', found: true, positionPercent: 5 },
            { url: '/b', found: true, positionPercent: 60 },
            { url: '/c', found: false },
          ],
        }),
        makeWeight(7, 0.6),
      );
      // pass=1 (found, near top), warn=1 (found, buried), fail=1 (not found)
      // (1 + 0.6) / 3 = 0.5333
      expect(result!.proportion).toBeCloseTo(0.533, 2);
    });

    it('excludes pages with errors', () => {
      const result = getCheckProportion(
        makeResult('llms-txt-directive-html', 'pass', {
          pageResults: [
            { url: '/a', found: true, positionPercent: 5 },
            { url: '/b', error: 'fetch failed' },
          ],
        }),
        makeWeight(7, 0.6),
      );
      expect(result!.proportion).toBe(1.0);
      expect(result!.tested).toBe(1);
    });
  });

  describe('rendering-strategy', () => {
    it('uses serverRendered/sparseContent/spaShells', () => {
      const result = getCheckProportion(
        makeResult('rendering-strategy', 'warn', {
          serverRendered: 45,
          sparseContent: 3,
          spaShells: 2,
        }),
        makeWeight(10, 0.5),
      );
      // (45 + 3*0.5) / 50 = 46.5 / 50 = 0.93
      expect(result!.proportion).toBeCloseTo(0.93);
      expect(result!.tested).toBe(50);
    });
  });

  describe('tabbed-content-serialization', () => {
    it('uses tabbedPages array', () => {
      const result = getCheckProportion(
        makeResult('tabbed-content-serialization', 'warn', {
          tabbedPages: [
            { url: '/a', status: 'pass' },
            { url: '/b', status: 'warn' },
            { url: '/c', status: 'fail' },
          ],
        }),
        makeWeight(4, 0.5),
      );
      // (1 + 0.5) / 3 = 0.5
      expect(result!.proportion).toBe(0.5);
    });
  });

  describe('section-header-quality', () => {
    it('derives status from analysis fields', () => {
      const result = getCheckProportion(
        makeResult('section-header-quality', 'warn', {
          analyses: [
            { hasGenericMajority: false, hasCrossGroupGeneric: false },
            { hasGenericMajority: false, hasCrossGroupGeneric: true },
            { hasGenericMajority: true, hasCrossGroupGeneric: true },
          ],
        }),
        makeWeight(2, 0.5),
      );
      // pass=1, warn=1 (crossGroup but not generic majority), fail=1
      // (1 + 0.5) / 3 = 0.5
      expect(result!.proportion).toBe(0.5);
    });
  });

  describe('redirect-behavior', () => {
    it('maps classifications to statuses', () => {
      const result = getCheckProportion(
        makeResult('redirect-behavior', 'warn', {
          pageResults: [
            { url: '/a', classification: 'no-redirect' },
            { url: '/b', classification: 'same-host' },
            { url: '/c', classification: 'cross-host' },
            { url: '/d', classification: 'js-redirect' },
          ],
        }),
        makeWeight(4, 0.6),
      );
      // pass=2 (no-redirect, same-host), warn=1 (cross-host), fail=1 (js)
      // (2 + 0.6) / 4 = 0.65
      expect(result!.proportion).toBeCloseTo(0.65);
    });
  });

  describe('auth-gate-detection', () => {
    it('maps classifications to statuses', () => {
      const result = getCheckProportion(
        makeResult('auth-gate-detection', 'warn', {
          pageResults: [
            { url: '/a', classification: 'accessible' },
            { url: '/b', classification: 'accessible' },
            { url: '/c', classification: 'soft-auth-gate' },
            { url: '/d', classification: 'auth-required' },
          ],
        }),
        makeWeight(10, 0.5),
      );
      // pass=2, warn=1, fail=1 => (2 + 0.5) / 4 = 0.625
      expect(result!.proportion).toBe(0.625);
    });
  });

  describe('llms-txt per-file checks', () => {
    it('llms-txt-valid: derives status from validation fields', () => {
      const result = getCheckProportion(
        makeResult('llms-txt-valid', 'warn', {
          validations: [
            { hasH1: true, hasBlockquote: true, linkCount: 10 },
            { hasH1: true, hasBlockquote: false, linkCount: 5 },
          ],
        }),
        makeWeight(4, 0.75),
      );
      // File 1: pass (has H1, blockquote, links)
      // File 2: warn (has links but missing blockquote)
      // (1 + 0.75) / 2 = 0.875
      expect(result!.proportion).toBe(0.875);
    });

    it('llms-txt-valid: fail for no links', () => {
      const result = getCheckProportion(
        makeResult('llms-txt-valid', 'fail', {
          validations: [{ hasH1: false, hasBlockquote: false, linkCount: 0 }],
        }),
        makeWeight(4, 0.75),
      );
      expect(result!.proportion).toBe(0.0);
    });

    it('llms-txt-size: uses thresholds to derive status', () => {
      const result = getCheckProportion(
        makeResult('llms-txt-size', 'warn', {
          sizes: [{ characters: 30_000 }, { characters: 70_000 }],
          thresholds: { pass: 50_000, fail: 100_000 },
        }),
        makeWeight(7, 0.5),
      );
      // File 1: 30K -> pass, File 2: 70K -> warn
      // (1 + 0.5) / 2 = 0.75
      expect(result!.proportion).toBe(0.75);
    });

    it('llms-txt-links-resolve: uses resolveRate directly', () => {
      const result = getCheckProportion(
        makeResult('llms-txt-links-resolve', 'warn', {
          resolveRate: 95,
          testedLinks: 20,
        }),
        makeWeight(7, 0.75),
      );
      expect(result!.proportion).toBe(0.95);
      expect(result!.tested).toBe(20);
    });

    it('llms-txt-links-markdown: uses markdownRate', () => {
      const result = getCheckProportion(
        makeResult('llms-txt-links-markdown', 'fail', {
          markdownRate: 30,
          testedLinks: 10,
        }),
        makeWeight(2),
      );
      expect(result!.proportion).toBe(0.3);
    });

    it('llms-txt-coverage: uses coverageRate', () => {
      const result = getCheckProportion(
        makeResult('llms-txt-coverage', 'warn', {
          coverageRate: 88,
        }),
        makeWeight(4, 0.75),
      );
      expect(result!.proportion).toBe(0.88);
    });
  });

  describe('edge cases with empty or malformed details', () => {
    it('bucket check: returns undefined when all buckets are zero', () => {
      const result = getCheckProportion(
        makeResult('page-size-html', 'warn', {
          passBucket: 0,
          warnBucket: 0,
          failBucket: 0,
        }),
        makeWeight(7, 0.5),
      );
      // Falls back to status-based proportion
      expect(result!.proportion).toBe(0.5);
    });

    it('pageResults: returns undefined when array is empty', () => {
      const result = getCheckProportion(
        makeResult('markdown-code-fence-validity', 'pass', {
          pageResults: [],
        }),
        makeWeight(4),
      );
      // Falls back to status-based
      expect(result!.proportion).toBe(1.0);
    });

    it('rendering-strategy: returns undefined when all counts are zero', () => {
      const result = getCheckProportion(
        makeResult('rendering-strategy', 'warn', {
          serverRendered: 0,
          sparseContent: 0,
          spaShells: 0,
        }),
        makeWeight(10, 0.5),
      );
      // Falls back to status-based
      expect(result!.proportion).toBe(0.5);
    });

    it('tabbed-content: returns undefined when tabbedPages is empty', () => {
      const result = getCheckProportion(
        makeResult('tabbed-content-serialization', 'warn', {
          tabbedPages: [],
        }),
        makeWeight(4, 0.5),
      );
      // Falls back to status-based
      expect(result!.proportion).toBe(0.5);
    });

    it('section-header: returns undefined when analyses is empty', () => {
      const result = getCheckProportion(
        makeResult('section-header-quality', 'warn', {
          analyses: [],
        }),
        makeWeight(2, 0.5),
      );
      // Falls back to status-based
      expect(result!.proportion).toBe(0.5);
    });

    it('http-status-codes: returns undefined when pageResults is empty', () => {
      const result = getCheckProportion(
        makeResult('http-status-codes', 'pass', {
          pageResults: [],
        }),
        makeWeight(7),
      );
      // Falls back to status-based
      expect(result!.proportion).toBe(1.0);
    });

    it('content-negotiation: excludes skipped and handles unknown classification', () => {
      const result = getCheckProportion(
        makeResult('content-negotiation', 'warn', {
          pageResults: [
            { url: '/a', classification: 'unknown-type', status: 200 },
            { url: '/b', classification: 'markdown-with-correct-type', status: 200 },
            { url: '/c', skipped: true, status: 0 },
          ],
        }),
        makeWeight(4, 0.75),
      );
      // unknown → skip (excluded), markdown-with-correct-type → pass
      // Only 1 item counted (pass), skip items excluded from proportion
      expect(result!.proportion).toBe(1.0);
      expect(result!.tested).toBe(1);
    });

    it('redirect-behavior: handles unknown classification as skip', () => {
      const result = getCheckProportion(
        makeResult('redirect-behavior', 'pass', {
          pageResults: [
            { url: '/a', classification: 'no-redirect' },
            { url: '/b', classification: 'unknown-type' },
          ],
        }),
        makeWeight(4, 0.6),
      );
      // no-redirect → pass, unknown → skip
      expect(result!.proportion).toBe(1.0);
      expect(result!.tested).toBe(1);
    });

    it('auth-gate: handles auth-redirect classification', () => {
      const result = getCheckProportion(
        makeResult('auth-gate-detection', 'fail', {
          pageResults: [{ url: '/a', classification: 'auth-redirect' }],
        }),
        makeWeight(10, 0.5),
      );
      expect(result!.proportion).toBe(0.0);
    });

    it('llms-txt-size: uses default thresholds when not provided', () => {
      const result = getCheckProportion(
        makeResult('llms-txt-size', 'warn', {
          sizes: [{ characters: 30_000 }, { characters: 70_000 }],
        }),
        makeWeight(7, 0.5),
      );
      // Default thresholds: pass=50K, fail=100K
      // 30K → pass, 70K → warn
      expect(result!.proportion).toBe(0.75);
    });

    it('llms-txt-size: fail file exceeding fail threshold', () => {
      const result = getCheckProportion(
        makeResult('llms-txt-size', 'fail', {
          sizes: [{ characters: 150_000 }],
          thresholds: { pass: 50_000, fail: 100_000 },
        }),
        makeWeight(7, 0.5),
      );
      expect(result!.proportion).toBe(0.0);
    });

    it('llms-txt-size: returns undefined when sizes is empty', () => {
      const result = getCheckProportion(
        makeResult('llms-txt-size', 'warn', { sizes: [] }),
        makeWeight(7, 0.5),
      );
      // Falls back to status-based
      expect(result!.proportion).toBe(0.5);
    });

    it('markdown-url-support: all pages skipped yields zero proportion', () => {
      const result = getCheckProportion(
        makeResult('markdown-url-support', 'pass', {
          pageResults: [
            { url: '/a', skipped: true },
            { url: '/b', skipped: true },
          ],
        }),
        makeWeight(7, 0.5),
      );
      // All pages filtered out → countByStatus returns 0/0
      expect(result!.proportion).toBe(0);
      expect(result!.tested).toBe(0);
    });

    it('llms-txt-directive: all pages have errors', () => {
      const result = getCheckProportion(
        makeResult('llms-txt-directive-html', 'fail', {
          pageResults: [
            { url: '/a', error: 'fetch failed' },
            { url: '/b', error: 'timeout' },
          ],
        }),
        makeWeight(7, 0.6),
      );
      // All filtered out, countByStatus returns 0/0
      expect(result!.proportion).toBe(0);
      expect(result!.tested).toBe(0);
    });

    it('uses default warn coefficient of 0.5 when not provided', () => {
      const result = getCheckProportion(makeResult('llms-txt-exists', 'warn'), makeWeight(10));
      expect(result).toEqual({ proportion: 0.5, tested: 1 });
    });
  });

  describe('missing details fallbacks', () => {
    it('llms-txt-valid: falls back to status when no details', () => {
      const result = getCheckProportion(makeResult('llms-txt-valid', 'warn'), makeWeight(4, 0.75));
      expect(result!.proportion).toBe(0.75);
    });

    it('llms-txt-valid: falls back to status when validations is empty', () => {
      const result = getCheckProportion(
        makeResult('llms-txt-valid', 'fail', { validations: [] }),
        makeWeight(4, 0.75),
      );
      expect(result!.proportion).toBe(0.0);
    });

    it('llms-txt-links-resolve: falls back when no resolveRate', () => {
      const result = getCheckProportion(
        makeResult('llms-txt-links-resolve', 'fail', {}),
        makeWeight(7, 0.75),
      );
      expect(result!.proportion).toBe(0.0);
    });

    it('llms-txt-coverage: falls back when no coverageRate', () => {
      const result = getCheckProportion(
        makeResult('llms-txt-coverage', 'warn', {}),
        makeWeight(4, 0.75),
      );
      expect(result!.proportion).toBe(0.75);
    });

    it('llms-txt-links-markdown: falls back when no markdownRate', () => {
      const result = getCheckProportion(
        makeResult('llms-txt-links-markdown', 'fail', {}),
        makeWeight(2),
      );
      expect(result!.proportion).toBe(0.0);
    });

    it('bucket check: falls back when no details', () => {
      const result = getCheckProportion(makeResult('page-size-html', 'warn'), makeWeight(7, 0.5));
      expect(result!.proportion).toBe(0.5);
    });
  });
});
