import { describe, it, expect } from 'vitest';
import { getCoefficient } from '../../../src/scoring/coefficients.js';
import type { CheckResult } from '../../../src/types.js';

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

describe('coefficients', () => {
  describe('discovery coefficient', () => {
    const affectedChecks = [
      'page-size-markdown',
      'markdown-code-fence-validity',
      'markdown-content-parity',
      'single-fetch-completeness',
      'markdown-link-portability',
    ];

    it('returns 1.0 when content-negotiation passes', () => {
      const results = resultsMap(r('content-negotiation', 'pass'));
      for (const checkId of affectedChecks) {
        expect(getCoefficient(checkId, results)).toBe(1.0);
      }
    });

    it('returns 0.8 when llms-txt-directive-html passes (no content-negotiation)', () => {
      const results = resultsMap(
        r('content-negotiation', 'fail'),
        r('llms-txt-directive-html', 'pass'),
      );
      expect(getCoefficient('page-size-markdown', results)).toBe(0.8);
    });

    it('returns 0.8 when llms-txt-directive-md passes (no content-negotiation)', () => {
      const results = resultsMap(
        r('content-negotiation', 'fail'),
        r('llms-txt-directive-md', 'pass'),
      );
      expect(getCoefficient('page-size-markdown', results)).toBe(0.8);
    });

    it('returns 0.5 when only llms-txt-links-markdown passes', () => {
      const results = resultsMap(
        r('content-negotiation', 'fail'),
        r('llms-txt-directive-html', 'fail'),
        r('llms-txt-directive-md', 'fail'),
        r('llms-txt-links-markdown', 'pass'),
      );
      expect(getCoefficient('page-size-markdown', results)).toBe(0.5);
    });

    it('returns 0.0 when nothing passes', () => {
      const results = resultsMap(
        r('content-negotiation', 'fail'),
        r('llms-txt-directive-html', 'fail'),
        r('llms-txt-directive-md', 'fail'),
        r('llms-txt-links-markdown', 'fail'),
      );
      expect(getCoefficient('page-size-markdown', results)).toBe(0.0);
    });

    it('returns 0.0 when no relevant checks exist', () => {
      const results = resultsMap();
      expect(getCoefficient('page-size-markdown', results)).toBe(0.0);
    });

    it('uses highest coefficient when multiple pass', () => {
      const results = resultsMap(
        r('content-negotiation', 'pass'),
        r('llms-txt-directive-html', 'pass'),
        r('llms-txt-directive-md', 'pass'),
        r('llms-txt-links-markdown', 'pass'),
      );
      expect(getCoefficient('page-size-markdown', results)).toBe(1.0);
    });
  });

  describe('HTML path coefficient', () => {
    const affectedChecks = [
      'page-size-html',
      'content-start-position',
      'tabbed-content-serialization',
      'section-header-quality',
      'embedded-data-serialization',
    ];

    it('returns 1.0 when rendering-strategy is absent', () => {
      const results = resultsMap();
      for (const checkId of affectedChecks) {
        expect(getCoefficient(checkId, results)).toBe(1.0);
      }
    });

    it('returns 1.0 when all pages server-render', () => {
      const results = resultsMap(
        r('rendering-strategy', 'pass', {
          serverRendered: 50,
          sparseContent: 0,
          spaShells: 0,
        }),
      );
      expect(getCoefficient('page-size-html', results)).toBe(1.0);
    });

    it('returns proportional coefficient', () => {
      const results = resultsMap(
        r('rendering-strategy', 'warn', {
          serverRendered: 45,
          sparseContent: 3,
          spaShells: 2,
        }),
      );
      // (45 + 3*0.5) / 50 = 0.93
      expect(getCoefficient('page-size-html', results)).toBeCloseTo(0.93);
    });

    it('returns low coefficient when mostly SPA shells', () => {
      const results = resultsMap(
        r('rendering-strategy', 'fail', {
          serverRendered: 2,
          sparseContent: 3,
          spaShells: 45,
        }),
      );
      // (2 + 3*0.5) / 50 = 0.07
      expect(getCoefficient('page-size-html', results)).toBeCloseTo(0.07);
    });
  });

  describe('index truncation coefficient', () => {
    const affectedChecks = [
      'llms-txt-links-resolve',
      'llms-txt-valid',
      'llms-txt-coverage',
      'llms-txt-links-markdown',
    ];

    it('returns 1.0 when llms-txt-size passes', () => {
      const results = resultsMap(r('llms-txt-size', 'pass'));
      for (const checkId of affectedChecks) {
        expect(getCoefficient(checkId, results)).toBe(1.0);
      }
    });

    it('returns 0.8 when llms-txt-size warns', () => {
      const results = resultsMap(r('llms-txt-size', 'warn'));
      expect(getCoefficient('llms-txt-valid', results)).toBe(0.8);
    });

    it('returns visible fraction when llms-txt-size fails', () => {
      const results = resultsMap(
        r('llms-txt-size', 'fail', {
          sizes: [{ characters: 200_000 }],
        }),
      );
      // 100K / 200K = 0.5
      expect(getCoefficient('llms-txt-valid', results)).toBe(0.5);
    });

    it('handles very large files', () => {
      const results = resultsMap(
        r('llms-txt-size', 'fail', {
          sizes: [{ characters: 4_000_000 }],
        }),
      );
      // 100K / 4M = 0.025
      expect(getCoefficient('llms-txt-valid', results)).toBe(0.025);
    });

    it('returns 1.0 when llms-txt-size is absent', () => {
      const results = resultsMap();
      expect(getCoefficient('llms-txt-valid', results)).toBe(1.0);
    });

    it('falls back to 0.5 when llms-txt-size fails with no sizes array', () => {
      const results = resultsMap(r('llms-txt-size', 'fail', {}));
      expect(getCoefficient('llms-txt-valid', results)).toBe(0.5);
    });

    it('falls back to 0.5 when sizes array is empty', () => {
      const results = resultsMap(r('llms-txt-size', 'fail', { sizes: [] }));
      expect(getCoefficient('llms-txt-valid', results)).toBe(0.5);
    });
  });

  describe('HTML path coefficient edge cases', () => {
    it('returns 1.0 when rendering-strategy is skip', () => {
      const results = resultsMap(r('rendering-strategy', 'skip'));
      expect(getCoefficient('page-size-html', results)).toBe(1.0);
    });

    it('returns 1.0 when rendering-strategy is error', () => {
      const results = resultsMap(r('rendering-strategy', 'error'));
      expect(getCoefficient('page-size-html', results)).toBe(1.0);
    });

    it('returns 1.0 when rendering-strategy has no details', () => {
      const results = resultsMap(r('rendering-strategy', 'warn'));
      expect(getCoefficient('page-size-html', results)).toBe(1.0);
    });

    it('returns 1.0 when rendering-strategy total is zero', () => {
      const results = resultsMap(
        r('rendering-strategy', 'warn', {
          serverRendered: 0,
          sparseContent: 0,
          spaShells: 0,
        }),
      );
      expect(getCoefficient('page-size-html', results)).toBe(1.0);
    });
  });

  describe('index truncation coefficient edge cases', () => {
    it('falls back to 0.5 when sizes have zero characters', () => {
      const results = resultsMap(
        r('llms-txt-size', 'fail', {
          sizes: [{ characters: 0 }],
        }),
      );
      expect(getCoefficient('llms-txt-valid', results)).toBe(0.5);
    });

    it('falls back to 0.5 when fail has no details at all', () => {
      const results = resultsMap(r('llms-txt-size', 'fail'));
      expect(getCoefficient('llms-txt-valid', results)).toBe(0.5);
    });

    it('returns 1.0 for non-standard status (error)', () => {
      const results = resultsMap(r('llms-txt-size', 'error'));
      expect(getCoefficient('llms-txt-valid', results)).toBe(1.0);
    });

    it('returns 1.0 for skip status', () => {
      const results = resultsMap(r('llms-txt-size', 'skip'));
      expect(getCoefficient('llms-txt-valid', results)).toBe(1.0);
    });
  });

  describe('non-coefficient checks', () => {
    it('returns 1.0 for checks without coefficients', () => {
      const results = resultsMap();
      expect(getCoefficient('llms-txt-exists', results)).toBe(1.0);
      expect(getCoefficient('http-status-codes', results)).toBe(1.0);
      expect(getCoefficient('auth-gate-detection', results)).toBe(1.0);
    });
  });
});
