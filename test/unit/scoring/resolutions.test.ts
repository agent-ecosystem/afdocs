import { describe, it, expect } from 'vitest';
import { getResolution } from '../../../src/scoring/resolutions.js';
import type { CheckResult } from '../../../src/types.js';

function r(
  id: string,
  status: CheckResult['status'],
  details?: Record<string, unknown>,
): CheckResult {
  return { id, category: 'test', status, message: '', details };
}

describe('resolutions', () => {
  it('returns undefined for pass status', () => {
    expect(getResolution(r('llms-txt-exists', 'pass'))).toBeUndefined();
  });

  it('returns undefined for skip status', () => {
    expect(getResolution(r('llms-txt-exists', 'skip'))).toBeUndefined();
  });

  it('returns undefined for unknown check ID', () => {
    expect(getResolution(r('unknown-check', 'fail'))).toBeUndefined();
  });

  it('returns warn text for llms-txt-exists warn', () => {
    const text = getResolution(r('llms-txt-exists', 'warn'));
    expect(text).toContain('cross-host redirect');
  });

  it('returns fail text for llms-txt-exists fail', () => {
    const text = getResolution(r('llms-txt-exists', 'fail'));
    expect(text).toContain('Create an llms.txt');
  });

  it('interpolates size details for llms-txt-size', () => {
    const text = getResolution(
      r('llms-txt-size', 'fail', {
        sizes: [{ characters: 200_000 }],
      }),
    );
    expect(text).toContain('200,000');
    expect(text).toContain('truncated');
  });

  it('interpolates broken link counts', () => {
    const text = getResolution(
      r('llms-txt-links-resolve', 'warn', {
        testedLinks: 20,
        broken: [{ url: '/a' }, { url: '/b' }],
      }),
    );
    expect(text).toContain('2 of 20');
  });

  it('interpolates page counts for page-size-html', () => {
    const text = getResolution(
      r('page-size-html', 'fail', {
        failBucket: 8,
        testedPages: 50,
      }),
    );
    expect(text).toContain('8 of 50');
  });

  describe('single-fetch-completeness', () => {
    it('names the fragile-declaration reasons for warn', () => {
      const text = getResolution(
        r('single-fetch-completeness', 'warn', {
          warnBucket: 2,
          testedPages: 8,
          reasons: { declaredLate: 2, relativeUrl: 1, headerOnly: 0 },
        }),
      );
      expect(text).toContain('2 of 8 markdown pages paginate');
      expect(text).toContain(
        'declared only late in the content on 2; linked with a relative URL on 1',
      );
      expect(text).not.toContain('Link header');
      expect(text).toContain('top of the content');
      expect(text).toContain('absolute');
    });

    it('asks whether pagination is needed at all for fail, quoting the size threshold', () => {
      const text = getResolution(
        r('single-fetch-completeness', 'fail', {
          failBucket: 1,
          testedPages: 8,
          reasons: { missing: 0, broken: 1, unresolvable: 0 },
          thresholds: { pass: 50_000 },
        }),
      );
      expect(text).toContain('1 of 8 markdown pages are partial');
      expect(text).toContain('a continuation that returns nothing usable on 1');
      expect(text).toContain('needs pagination at all');
      expect(text).toContain('50,000 characters');
      expect(text).toContain('even when the HTML UI paginates');
    });

    it('falls back to the default threshold and omits reasons when details are sparse', () => {
      const text = getResolution(r('single-fetch-completeness', 'fail', {}));
      expect(text).toContain('0 of 0 markdown pages');
      expect(text).toContain('50,000 characters');
      expect(text).not.toContain('(');
    });
  });

  describe('markdown-link-portability', () => {
    it('names the root-relative reason for warn and says where absolute URLs come from', () => {
      const text = getResolution(
        r('markdown-link-portability', 'warn', {
          warnBucket: 3,
          testedPages: 8,
          reasons: { rootRelative: 3, mismatched: 0 },
        }),
      );
      expect(text).toContain('3 of 8 markdown pages');
      expect(text).toContain('root-relative links on 3');
      expect(text).not.toContain('redirects to HTML');
      expect(text).toContain('known at build time');
    });

    it('tells fail to fix generation first and verify links in CI', () => {
      const text = getResolution(
        r('markdown-link-portability', 'fail', {
          failBucket: 2,
          testedPages: 8,
          reasons: { pathRelative: 1, broken: 2 },
        }),
      );
      expect(text).toContain('2 of 8 markdown pages');
      expect(text).toContain('path-relative links on 1');
      expect(text).toContain('a sampled link that does not resolve on 2');
      expect(text).toContain('Fix the link generation first');
      expect(text).toContain('200 with an HTML shell');
    });

    it('omits the reason clause when details carry no tallies', () => {
      const text = getResolution(r('markdown-link-portability', 'warn', {}));
      expect(text).toContain('0 of 0 markdown pages');
      expect(text).not.toContain('(');
    });
  });

  describe('page-size-transfer', () => {
    it('interpolates counts and thresholds for warn', () => {
      const text = getResolution(
        r('page-size-transfer', 'warn', {
          warnBucket: 3,
          testedPages: 20,
          thresholds: { pass: 1_000_000, fail: 10_000_000 },
          architectureSignaturePages: 0,
        }),
      );
      expect(text).toContain('3 of 20 pages serve 1MB-10MB');
      expect(text).toContain('markdown variants');
      expect(text).not.toContain('architecture signature');
    });

    it('names the transfer cap for fail', () => {
      const text = getResolution(
        r('page-size-transfer', 'fail', {
          failBucket: 1,
          testedPages: 20,
          thresholds: { pass: 1_000_000, fail: 10_000_000 },
        }),
      );
      expect(text).toContain('1 of 20 pages serve over 10MB');
      expect(text).toContain("Claude Code's fetch buffer");
    });

    it('points at framework configuration when the ratio is an architecture signature', () => {
      const text = getResolution(
        r('page-size-transfer', 'warn', {
          warnBucket: 2,
          testedPages: 20,
          architectureSignaturePages: 2,
          architectureSignatureMaxRatio: 120,
          maxRatio: 141,
        }),
      );
      expect(text).toContain('2 of the oversized pages ship');
      expect(text).toContain('~120:1');
      expect(text).not.toContain('141');
      expect(text).toContain('framework configuration');
    });

    it('omits the architecture note when only passing pages have a high ratio', () => {
      const text = getResolution(
        r('page-size-transfer', 'warn', {
          warnBucket: 1,
          testedPages: 20,
          architectureSignaturePages: 0,
          maxRatio: 141,
        }),
      );
      expect(text).not.toContain('architecture signature');
    });

    it('reflects configured thresholds', () => {
      const text = getResolution(
        r('page-size-transfer', 'warn', {
          warnBucket: 1,
          testedPages: 5,
          thresholds: { pass: 500_000, fail: 2_000_000 },
        }),
      );
      expect(text).toContain('serve 500KB-2MB');
    });
  });

  it('returns "unknown" when sizes array is empty', () => {
    const text = getResolution(r('llms-txt-size', 'warn', { sizes: [] }));
    expect(text).toContain('unknown');
  });

  it('returns "unknown" when sizes field is missing', () => {
    const text = getResolution(r('llms-txt-size', 'fail', {}));
    expect(text).toContain('unknown');
  });

  it('returns 0 broken links when broken array is missing', () => {
    const text = getResolution(r('llms-txt-links-resolve', 'fail', { testedLinks: 10 }));
    expect(text).toContain('0 of 10');
  });

  it('returns 0 count when pageResults missing for markdown-url-support', () => {
    const text = getResolution(r('markdown-url-support', 'warn', {}));
    expect(text).toContain('0 of 0');
  });

  it('returns undefined for check with only a fail template when status is warn', () => {
    const text = getResolution(r('markdown-code-fence-validity', 'warn'));
    expect(text).toBeUndefined();
  });

  it('returns undefined for check with only a fail template (http-status-codes)', () => {
    const text = getResolution(r('http-status-codes', 'warn'));
    expect(text).toBeUndefined();
  });

  it('interpolates tabbed page counts', () => {
    const text = getResolution(
      r('tabbed-content-serialization', 'warn', {
        tabbedPages: [{ status: 'warn' }, { status: 'warn' }, { status: 'pass' }],
      }),
    );
    expect(text).toContain('2 pages');
  });

  it('handles empty tabbedPages array', () => {
    const text = getResolution(
      r('tabbed-content-serialization', 'fail', {
        tabbedPages: [],
      }),
    );
    expect(text).toContain('0 pages');
  });

  it('interpolates coverage details', () => {
    const text = getResolution(
      r('llms-txt-coverage', 'warn', {
        missingCount: 12,
        coverageRate: 85,
        coverageWarnThreshold: 80,
        coveragePassThreshold: 95,
      }),
    );
    expect(text).toContain('85%');
    expect(text).toContain('12 live');
    expect(text).toContain('80-95%');
  });

  it('interpolates coverage fail details', () => {
    const text = getResolution(
      r('llms-txt-coverage', 'fail', {
        missingCount: 50,
        coverageRate: 60,
        coverageWarnThreshold: 80,
      }),
    );
    expect(text).toContain('60%');
    expect(text).toContain('below 80%');
    expect(text).toContain('50 live');
  });

  it('interpolates parity fail details with rounding', () => {
    const text = getResolution(
      r('markdown-content-parity', 'fail', {
        failBucket: 3,
        avgMissingPercent: 27.8,
      }),
    );
    expect(text).toContain('3 pages');
    expect(text).toContain('avg 28% missing');
  });

  it('uses default thresholds when details are empty for llms-txt-coverage warn', () => {
    const text = getResolution(r('llms-txt-coverage', 'warn', {}));
    expect(text).toContain('0%');
    expect(text).toContain('80-95%');
  });

  it('uses default threshold for llms-txt-coverage fail', () => {
    const text = getResolution(r('llms-txt-coverage', 'fail', {}));
    expect(text).toContain('below 80%');
  });

  it('returns 0 for markdown-content-parity warn with empty details', () => {
    const text = getResolution(r('markdown-content-parity', 'warn', {}));
    expect(text).toContain('0 pages');
  });

  it('returns 0 for cache-header-hygiene warn with empty details', () => {
    const text = getResolution(r('cache-header-hygiene', 'warn', {}));
    expect(text).toContain('0 endpoints');
  });

  it('returns 0 for cache-header-hygiene fail with empty details', () => {
    const text = getResolution(r('cache-header-hygiene', 'fail', {}));
    expect(text).toContain('0 endpoints');
  });

  it('returns 0 for rendering-strategy warn with empty details', () => {
    const text = getResolution(r('rendering-strategy', 'warn', {}));
    expect(text).toContain('0 of 0');
  });

  it('returns 0 for rendering-strategy fail with empty details', () => {
    const text = getResolution(r('rendering-strategy', 'fail', {}));
    expect(text).toContain('0 of 0');
  });

  it('returns 0 for page-size-markdown warn with empty details', () => {
    const text = getResolution(r('page-size-markdown', 'warn', {}));
    expect(text).toContain('0 of 0');
  });

  it('returns 0 for page-size-markdown fail with empty details', () => {
    const text = getResolution(r('page-size-markdown', 'fail', {}));
    expect(text).toContain('0 of 0');
  });

  it('returns 0 for content-start-position warn with empty details', () => {
    const text = getResolution(r('content-start-position', 'warn', {}));
    expect(text).toContain('0 of 0');
  });

  it('returns 0 for content-start-position fail with empty details', () => {
    const text = getResolution(r('content-start-position', 'fail', {}));
    expect(text).toContain('0 of 0');
  });

  it('returns 0 for redirect-behavior warn with empty details', () => {
    const text = getResolution(r('redirect-behavior', 'warn', {}));
    expect(text).toContain('0 pages');
  });

  it('returns 0 for redirect-behavior fail with empty details', () => {
    const text = getResolution(r('redirect-behavior', 'fail', {}));
    expect(text).toContain('0 pages');
  });

  it('returns 0 for markdown-url-support warn with empty details', () => {
    const text = getResolution(r('markdown-url-support', 'warn', {}));
    expect(text).toContain('0 of 0');
  });

  it('returns 0 for llms-txt-links-resolve fail with empty details', () => {
    const text = getResolution(r('llms-txt-links-resolve', 'fail', {}));
    expect(text).toContain('0 of 0');
  });

  it('provides resolution for every check with warn/fail', () => {
    const checkIds = [
      'llms-txt-exists',
      'llms-txt-valid',
      'llms-txt-size',
      'llms-txt-links-resolve',
      'llms-txt-links-markdown',
      'llms-txt-directive-html',
      'llms-txt-directive-md',
      'markdown-url-support',
      'content-negotiation',
      'rendering-strategy',
      'page-size-markdown',
      'page-size-html',
      'page-size-transfer',
      'single-fetch-completeness',
      'content-start-position',
      'tabbed-content-serialization',
      'section-header-quality',
      'markdown-code-fence-validity',
      'markdown-link-portability',
      'http-status-codes',
      'redirect-behavior',
      'llms-txt-coverage',
      'markdown-content-parity',
      'cache-header-hygiene',
      'auth-gate-detection',
      'auth-alternative-access',
    ];

    for (const id of checkIds) {
      // At least one of warn or fail should produce text
      const warnText = getResolution(
        r(id, 'warn', {
          failBucket: 1,
          warnBucket: 1,
          testedPages: 10,
          sizes: [{ characters: 80_000 }],
          tabbedPages: [{ status: 'warn' }],
          broken: [{ url: '/x' }],
          testedLinks: 5,
          crossHostCount: 3,
          jsRedirectCount: 2,
          missingCount: 5,
          unclosedCount: 2,
          avgMissingPercent: 15,
          pageResults: [{ status: 'warn' }],
        }),
      );
      const failText = getResolution(
        r(id, 'fail', {
          failBucket: 1,
          warnBucket: 0,
          testedPages: 10,
          spaShells: 5,
          sparseContent: 2,
          sizes: [{ characters: 200_000 }],
          tabbedPages: [{ status: 'fail' }],
          broken: [{ url: '/x' }],
          testedLinks: 5,
          crossHostCount: 3,
          jsRedirectCount: 2,
          missingCount: 5,
          unclosedCount: 2,
          avgMissingPercent: 30,
          pageResults: [{ status: 'fail' }],
        }),
      );
      expect(warnText || failText, `Missing resolution for ${id}`).toBeTruthy();
    }
  });
});
