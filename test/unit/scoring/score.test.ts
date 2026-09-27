import { describe, it, expect } from 'vitest';
import { computeScore, toGrade } from '../../../src/scoring/score.js';
import type { CheckResult, ReportResult, SamplingStrategy } from '../../../src/types.js';

function makeResult(
  id: string,
  category: string,
  status: CheckResult['status'],
  details?: Record<string, unknown>,
): CheckResult {
  return { id, category, status, message: `${id}: ${status}`, details };
}

function makeReport(
  results: CheckResult[],
  overrides?: { testedPages?: number; samplingStrategy?: SamplingStrategy },
): ReportResult {
  const summary = { total: results.length, pass: 0, warn: 0, fail: 0, skip: 0, error: 0 };
  for (const r of results) {
    summary[r.status]++;
  }
  return {
    url: 'https://example.com',
    timestamp: new Date().toISOString(),
    specUrl: 'https://agentdocsspec.com/spec/web/',
    results,
    summary,
    ...overrides,
  };
}

describe('toGrade', () => {
  it('assigns correct grades', () => {
    expect(toGrade(100)).toBe('A+');
    expect(toGrade(99)).toBe('A');
    expect(toGrade(90)).toBe('A');
    expect(toGrade(89)).toBe('B');
    expect(toGrade(80)).toBe('B');
    expect(toGrade(79)).toBe('C');
    expect(toGrade(70)).toBe('C');
    expect(toGrade(69)).toBe('D');
    expect(toGrade(60)).toBe('D');
    expect(toGrade(59)).toBe('F');
    expect(toGrade(0)).toBe('F');
  });
});

describe('computeScore', () => {
  it('scores a perfect report as 100 (A+)', () => {
    const results: CheckResult[] = [
      makeResult('llms-txt-exists', 'content-discoverability', 'pass'),
      makeResult('llms-txt-valid', 'content-discoverability', 'pass'),
      makeResult('llms-txt-size', 'content-discoverability', 'pass'),
      makeResult('llms-txt-links-resolve', 'content-discoverability', 'pass'),
      makeResult('llms-txt-links-markdown', 'content-discoverability', 'pass'),
      makeResult('llms-txt-directive-html', 'content-discoverability', 'pass'),
      makeResult('llms-txt-directive-md', 'content-discoverability', 'pass'),
      makeResult('markdown-url-support', 'markdown-availability', 'pass'),
      makeResult('content-negotiation', 'markdown-availability', 'pass'),
      makeResult('rendering-strategy', 'page-size', 'pass', {
        serverRendered: 50,
        sparseContent: 0,
        spaShells: 0,
      }),
      makeResult('page-size-markdown', 'page-size', 'pass'),
      makeResult('page-size-html', 'page-size', 'pass'),
      makeResult('content-start-position', 'page-size', 'pass'),
      makeResult('tabbed-content-serialization', 'content-structure', 'pass'),
      makeResult('section-header-quality', 'content-structure', 'pass'),
      makeResult('markdown-code-fence-validity', 'content-structure', 'pass'),
      makeResult('http-status-codes', 'url-stability', 'pass'),
      makeResult('redirect-behavior', 'url-stability', 'pass'),
      makeResult('llms-txt-coverage', 'observability', 'pass'),
      makeResult('markdown-content-parity', 'observability', 'pass'),
      makeResult('cache-header-hygiene', 'observability', 'pass'),
      makeResult('auth-gate-detection', 'authentication', 'pass'),
      makeResult('auth-alternative-access', 'authentication', 'pass'),
    ];
    const score = computeScore(makeReport(results));
    expect(score.overall).toBe(100);
    expect(score.grade).toBe('A+');
    expect(score.cap).toBeUndefined();
    expect(score.diagnostics).toHaveLength(0);
  });

  it('scores an all-fail report as 0 (F)', () => {
    const results: CheckResult[] = [
      makeResult('llms-txt-exists', 'content-discoverability', 'fail'),
      makeResult('rendering-strategy', 'page-size', 'fail', {
        serverRendered: 0,
        sparseContent: 0,
        spaShells: 50,
      }),
      makeResult('auth-gate-detection', 'authentication', 'fail', {
        pageResults: Array.from({ length: 50 }, (_, i) => ({
          url: `/page-${i}`,
          classification: 'auth-required',
        })),
      }),
      makeResult('page-size-html', 'page-size', 'fail', {
        passBucket: 0,
        warnBucket: 0,
        failBucket: 50,
      }),
      makeResult('markdown-url-support', 'markdown-availability', 'fail'),
      makeResult('http-status-codes', 'url-stability', 'fail'),
    ];
    const score = computeScore(makeReport(results));
    expect(score.overall).toBe(0);
    expect(score.grade).toBe('F');
  });

  it('excludes skipped checks from scoring', () => {
    const results: CheckResult[] = [
      makeResult('llms-txt-exists', 'content-discoverability', 'pass'),
      makeResult('llms-txt-valid', 'content-discoverability', 'skip'),
      makeResult('llms-txt-size', 'content-discoverability', 'skip'),
    ];
    const score = computeScore(makeReport(results));
    // Only llms-txt-exists counted: 10/10 = 100
    expect(score.overall).toBe(100);
    expect(score.checkScores['llms-txt-valid']).toBeUndefined();
  });

  it('applies critical check cap for llms-txt-exists fail', () => {
    // Even with everything else perfect, missing llms.txt caps at 59
    const results: CheckResult[] = [
      makeResult('llms-txt-exists', 'content-discoverability', 'fail'),
      makeResult('rendering-strategy', 'page-size', 'pass', {
        serverRendered: 50,
        sparseContent: 0,
        spaShells: 0,
      }),
      makeResult('markdown-url-support', 'markdown-availability', 'pass'),
      makeResult('content-negotiation', 'markdown-availability', 'pass'),
      makeResult('page-size-html', 'page-size', 'pass'),
      makeResult('page-size-markdown', 'page-size', 'pass'),
      makeResult('http-status-codes', 'url-stability', 'pass'),
      makeResult('auth-gate-detection', 'authentication', 'pass'),
    ];
    const score = computeScore(makeReport(results));
    expect(score.overall).toBeLessThanOrEqual(59);
    expect(score.cap).toBeDefined();
    expect(score.cap!.checkId).toBe('llms-txt-exists');
  });

  it('applies rendering-strategy cap when 75%+ pages are SPA shells', () => {
    const results: CheckResult[] = [
      makeResult('llms-txt-exists', 'content-discoverability', 'pass'),
      makeResult('rendering-strategy', 'page-size', 'fail', {
        serverRendered: 5,
        sparseContent: 0,
        spaShells: 45,
      }),
      makeResult('page-size-html', 'page-size', 'pass'),
    ];
    const score = computeScore(makeReport(results));
    // rendering-strategy proportion: 5/50 = 0.1, which is <=0.25 -> cap at 39
    expect(score.overall).toBeLessThanOrEqual(39);
    expect(score.cap).toBeDefined();
    expect(score.cap!.cap).toBe(39);
  });

  it('applies lowest cap when multiple apply', () => {
    // Include enough passing checks so the raw score is above the cap
    const results: CheckResult[] = [
      makeResult('llms-txt-exists', 'content-discoverability', 'fail'),
      makeResult('rendering-strategy', 'page-size', 'fail', {
        serverRendered: 2,
        sparseContent: 0,
        spaShells: 48,
      }),
      makeResult('markdown-url-support', 'markdown-availability', 'pass'),
      makeResult('content-negotiation', 'markdown-availability', 'pass'),
      makeResult('page-size-html', 'page-size', 'pass'),
      makeResult('page-size-markdown', 'page-size', 'pass'),
      makeResult('http-status-codes', 'url-stability', 'pass'),
      makeResult('redirect-behavior', 'url-stability', 'pass'),
      makeResult('auth-gate-detection', 'authentication', 'pass'),
      makeResult('auth-alternative-access', 'authentication', 'pass'),
      makeResult('cache-header-hygiene', 'observability', 'pass'),
    ];
    const score = computeScore(makeReport(results));
    // llms-txt-exists fail -> cap 59
    // rendering-strategy 2/50 = 0.04 -> cap 39
    // Lowest wins: 39
    expect(score.cap).toBeDefined();
    expect(score.cap!.cap).toBe(39);
    expect(score.overall).toBeLessThanOrEqual(39);
  });

  it('applies no-viable-path cap at 39', () => {
    // No llms.txt, rendering not run, no markdown -> no-viable-path fires
    // Use skip for rendering-strategy so only no-viable-path and llms-txt-exists caps apply
    const results: CheckResult[] = [
      makeResult('llms-txt-exists', 'content-discoverability', 'fail'),
      makeResult('rendering-strategy', 'page-size', 'skip'),
      makeResult('markdown-url-support', 'markdown-availability', 'fail'),
      // Pass some checks so raw score would be above 39
      makeResult('http-status-codes', 'url-stability', 'pass'),
      makeResult('redirect-behavior', 'url-stability', 'pass'),
      makeResult('auth-gate-detection', 'authentication', 'pass'),
      makeResult('auth-alternative-access', 'authentication', 'pass'),
      makeResult('cache-header-hygiene', 'observability', 'pass'),
    ];
    const score = computeScore(makeReport(results));
    expect(score.diagnostics.find((d) => d.id === 'no-viable-path')).toBeDefined();
    expect(score.cap).toBeDefined();
    // no-viable-path cap (39) beats llms-txt-exists cap (59)
    expect(score.cap!.cap).toBe(39);
    expect(score.cap!.checkId).toBe('no-viable-path');
    expect(score.overall).toBeLessThanOrEqual(39);
  });

  it('applies single-page-sample cap at 59', () => {
    // Reproduces the issue #73 scenario: llms.txt exists and is the right size,
    // but is structurally invalid. With only 1 page discovered, page-level
    // checks are excluded as notApplicable, leaving the raw score driven by a
    // tiny subset of site-wide signal (the issue reported 81/B without a cap).
    const results: CheckResult[] = [
      makeResult('llms-txt-exists', 'content-discoverability', 'pass'),
      makeResult('llms-txt-valid', 'content-discoverability', 'fail'),
      makeResult('llms-txt-size', 'content-discoverability', 'pass'),
    ];
    const score = computeScore(
      makeReport(results, { samplingStrategy: 'deterministic', testedPages: 1 }),
    );
    expect(score.diagnostics.find((d) => d.id === 'single-page-sample')).toBeDefined();
    expect(score.cap).toBeDefined();
    expect(score.cap!.cap).toBe(59);
    expect(score.cap!.checkId).toBe('single-page-sample');
    expect(score.overall).toBeLessThanOrEqual(59);
  });

  it('single-page-sample cap loses to no-viable-path cap', () => {
    // Both diagnostics fire; lowest cap (no-viable-path at 39) should win.
    // Pass enough site-level checks to push raw score above 39 so the cap is
    // observable in scoreResult.cap.
    const results: CheckResult[] = [
      makeResult('llms-txt-exists', 'content-discoverability', 'fail'),
      makeResult('rendering-strategy', 'page-size', 'skip'),
      makeResult('markdown-url-support', 'markdown-availability', 'fail'),
      makeResult('llms-txt-size', 'content-discoverability', 'pass'),
      makeResult('auth-gate-detection', 'authentication', 'pass'),
      makeResult('auth-alternative-access', 'authentication', 'pass'),
    ];
    const score = computeScore(
      makeReport(results, { samplingStrategy: 'deterministic', testedPages: 1 }),
    );
    expect(score.diagnostics.find((d) => d.id === 'no-viable-path')).toBeDefined();
    expect(score.diagnostics.find((d) => d.id === 'single-page-sample')).toBeDefined();
    expect(score.cap).toBeDefined();
    expect(score.cap!.cap).toBe(39);
    expect(score.cap!.checkId).toBe('no-viable-path');
  });

  it('does not apply cap when score is already below cap', () => {
    // All-fail scenario: raw score is 0, cap at 59 wouldn't reduce it
    const results: CheckResult[] = [
      makeResult('llms-txt-exists', 'content-discoverability', 'fail'),
      makeResult('rendering-strategy', 'page-size', 'fail', {
        serverRendered: 0,
        sparseContent: 0,
        spaShells: 50,
      }),
    ];
    const score = computeScore(makeReport(results));
    expect(score.overall).toBe(0);
    // Cap computed but not applied since score is already below
    expect(score.cap).toBeUndefined();
  });

  it('applies discovery coefficient correctly', () => {
    // page-size-markdown should get coefficient 0.0 when markdown
    // is not discoverable
    const results: CheckResult[] = [
      makeResult('content-negotiation', 'markdown-availability', 'fail'),
      makeResult('llms-txt-directive-html', 'content-discoverability', 'fail'),
      makeResult('llms-txt-directive-md', 'content-discoverability', 'fail'),
      makeResult('llms-txt-links-markdown', 'content-discoverability', 'fail'),
      makeResult('page-size-markdown', 'page-size', 'pass'),
    ];
    const score = computeScore(makeReport(results));
    // page-size-markdown should have coefficient 0, so its earned and max are both 0
    expect(score.checkScores['page-size-markdown'].coefficient).toBe(0);
    expect(score.checkScores['page-size-markdown'].effectiveWeight).toBe(0);
    expect(score.checkScores['page-size-markdown'].earnedScore).toBe(0);
  });

  it('computes proportional scores for multi-page checks', () => {
    const results: CheckResult[] = [
      makeResult('page-size-html', 'page-size', 'warn', {
        passBucket: 47,
        warnBucket: 3,
        failBucket: 0,
      }),
    ];
    const score = computeScore(makeReport(results));
    const cs = score.checkScores['page-size-html'];
    // proportion: (47 + 3*0.5) / 50 = 0.97
    expect(cs.proportion).toBeCloseTo(0.97);
    expect(cs.baseWeight).toBe(7);
  });

  it('includes category scores', () => {
    const results: CheckResult[] = [
      makeResult('llms-txt-exists', 'content-discoverability', 'pass'),
      makeResult('llms-txt-valid', 'content-discoverability', 'pass'),
      makeResult('http-status-codes', 'url-stability', 'fail'),
    ];
    const score = computeScore(makeReport(results));
    expect(score.categoryScores['content-discoverability'].score).toBe(100);
    expect(score.categoryScores['url-stability'].score).toBe(0);
  });

  it('includes resolutions for warn/fail checks', () => {
    const results: CheckResult[] = [
      makeResult('llms-txt-exists', 'content-discoverability', 'fail'),
      makeResult('http-status-codes', 'url-stability', 'pass'),
    ];
    const score = computeScore(makeReport(results));
    expect(score.resolutions['llms-txt-exists']).toContain('Create an llms.txt');
    expect(score.resolutions['http-status-codes']).toBeUndefined();
  });

  it('includes diagnostics when conditions are met', () => {
    const results: CheckResult[] = [
      makeResult('markdown-url-support', 'markdown-availability', 'pass'),
      makeResult('content-negotiation', 'markdown-availability', 'fail'),
      makeResult('llms-txt-directive-html', 'content-discoverability', 'fail'),
      makeResult('llms-txt-directive-md', 'content-discoverability', 'fail'),
      makeResult('llms-txt-links-markdown', 'content-discoverability', 'fail'),
    ];
    const score = computeScore(makeReport(results));
    expect(score.diagnostics.find((d) => d.id === 'markdown-undiscoverable')).toBeDefined();
  });

  it('produces 0 category score when all checks in a category are skipped', () => {
    const results: CheckResult[] = [
      makeResult('llms-txt-exists', 'content-discoverability', 'pass'),
      makeResult('markdown-url-support', 'markdown-availability', 'skip'),
      makeResult('content-negotiation', 'markdown-availability', 'skip'),
    ];
    const score = computeScore(makeReport(results));
    expect(score.categoryScores['markdown-availability'].score).toBe(0);
  });

  it('handles empty report', () => {
    const score = computeScore(makeReport([]));
    expect(score.overall).toBe(0);
    expect(score.grade).toBe('F');
    expect(Object.keys(score.checkScores)).toHaveLength(0);
  });

  it('handles unknown check IDs gracefully', () => {
    const results: CheckResult[] = [
      makeResult('unknown-check', 'unknown', 'pass'),
      makeResult('llms-txt-exists', 'content-discoverability', 'pass'),
    ];
    const score = computeScore(makeReport(results));
    expect(score.checkScores['unknown-check']).toBeUndefined();
    expect(score.checkScores['llms-txt-exists']).toBeDefined();
  });

  describe('index truncation coefficient', () => {
    it('reduces llms-txt-valid weight when llms-txt-size fails', () => {
      const results: CheckResult[] = [
        makeResult('llms-txt-size', 'content-discoverability', 'fail', {
          sizes: [{ characters: 200_000 }],
        }),
        makeResult('llms-txt-valid', 'content-discoverability', 'pass'),
      ];
      const score = computeScore(makeReport(results));
      // Coefficient should be 100K/200K = 0.5
      expect(score.checkScores['llms-txt-valid'].coefficient).toBe(0.5);
      expect(score.checkScores['llms-txt-valid'].effectiveWeight).toBe(2); // 4 * 0.5
    });
  });

  describe('HTML path coefficient', () => {
    it('reduces page-size-html weight when many pages are SPA shells', () => {
      const results: CheckResult[] = [
        makeResult('rendering-strategy', 'page-size', 'fail', {
          serverRendered: 10,
          sparseContent: 0,
          spaShells: 40,
        }),
        makeResult('page-size-html', 'page-size', 'pass'),
      ];
      const score = computeScore(makeReport(results));
      // Coefficient: 10/50 = 0.2
      expect(score.checkScores['page-size-html'].coefficient).toBeCloseTo(0.2);
    });
  });

  describe('realistic scenario', () => {
    it('scores a typical docs site with some issues', () => {
      const results: CheckResult[] = [
        // Good discoverability
        makeResult('llms-txt-exists', 'content-discoverability', 'pass'),
        makeResult('llms-txt-valid', 'content-discoverability', 'pass'),
        makeResult('llms-txt-size', 'content-discoverability', 'pass'),
        makeResult('llms-txt-links-resolve', 'content-discoverability', 'pass'),
        makeResult('llms-txt-links-markdown', 'content-discoverability', 'fail', {
          markdownRate: 0,
          testedLinks: 20,
        }),
        makeResult('llms-txt-directive-html', 'content-discoverability', 'fail'),
        makeResult('llms-txt-directive-md', 'content-discoverability', 'fail'),

        // No markdown
        makeResult('markdown-url-support', 'markdown-availability', 'fail'),
        makeResult('content-negotiation', 'markdown-availability', 'fail'),

        // Good rendering, some large pages
        makeResult('rendering-strategy', 'page-size', 'pass', {
          serverRendered: 50,
          sparseContent: 0,
          spaShells: 0,
        }),
        makeResult('page-size-html', 'page-size', 'warn', {
          passBucket: 45,
          warnBucket: 5,
          failBucket: 0,
        }),
        makeResult('content-start-position', 'page-size', 'pass'),

        // Clean content
        makeResult('tabbed-content-serialization', 'content-structure', 'pass'),
        makeResult('section-header-quality', 'content-structure', 'pass'),
        makeResult('markdown-code-fence-validity', 'content-structure', 'pass'),

        // Good URL stability
        makeResult('http-status-codes', 'url-stability', 'pass'),
        makeResult('redirect-behavior', 'url-stability', 'pass'),

        // Observability
        makeResult('llms-txt-coverage', 'observability', 'pass'),
        makeResult('cache-header-hygiene', 'observability', 'pass'),

        // No auth issues
        makeResult('auth-gate-detection', 'authentication', 'pass'),
        makeResult('auth-alternative-access', 'authentication', 'pass'),
      ];

      const score = computeScore(makeReport(results));

      // Good score despite no markdown: discovery coefficient zeroes out
      // markdown quality checks (reducing denominator), and most other
      // checks pass. Loses points for no markdown support, no directive,
      // HTML-only links, some large pages.
      expect(score.overall).toBeGreaterThan(60);
      expect(score.overall).toBeLessThan(95);
      expect(score.cap).toBeUndefined();

      // Should have resolutions for failing checks
      expect(score.resolutions['llms-txt-links-markdown']).toBeDefined();
      expect(score.resolutions['llms-txt-directive-html']).toBeDefined();
      expect(score.resolutions['markdown-url-support']).toBeDefined();
    });
  });

  describe('tag scores integration', () => {
    it('includes tagScores when report has urlTags', () => {
      const results: CheckResult[] = [
        makeResult('page-size-html', 'page-size', 'warn', {
          passBucket: 1,
          warnBucket: 1,
          failBucket: 0,
          pageResults: [
            { url: 'https://example.com/a', status: 'pass' },
            { url: 'https://example.com/b', status: 'warn' },
          ],
        }),
      ];
      const report = makeReport(results);
      report.urlTags = {
        'https://example.com/a': 'docs',
        'https://example.com/b': 'api',
      };

      const score = computeScore(report);
      expect(score.tagScores).toBeDefined();
      expect(score.tagScores!['docs'].score).toBe(100);
      expect(score.tagScores!['api'].score).toBe(50); // warn maps to 0.5
    });

    it('omits tagScores when report has no urlTags', () => {
      const results: CheckResult[] = [
        makeResult('page-size-html', 'page-size', 'pass', {
          passBucket: 1,
          warnBucket: 0,
          failBucket: 0,
          pageResults: [{ url: 'https://example.com/a', status: 'pass' }],
        }),
      ];
      const score = computeScore(makeReport(results));
      expect(score.tagScores).toBeUndefined();
    });
  });

  describe('single-page scoring (scoreDisplayMode)', () => {
    it('marks page-level checks as notApplicable when testedPages=1 and discovery-based', () => {
      const results: CheckResult[] = [
        makeResult('llms-txt-exists', 'content-discoverability', 'pass'),
        makeResult('page-size-html', 'page-size', 'pass'),
        makeResult('rendering-strategy', 'page-size', 'pass', {
          serverRendered: 1,
          sparseContent: 0,
          spaShells: 0,
        }),
      ];
      const score = computeScore(
        makeReport(results, { testedPages: 1, samplingStrategy: 'random' }),
      );
      expect(score.checkScores['llms-txt-exists'].scoreDisplayMode).toBe('numeric');
      expect(score.checkScores['page-size-html'].scoreDisplayMode).toBe('notApplicable');
      expect(score.checkScores['rendering-strategy'].scoreDisplayMode).toBe('notApplicable');
    });

    it('does not mark checks as notApplicable with curated sampling', () => {
      const results: CheckResult[] = [makeResult('page-size-html', 'page-size', 'pass')];
      const score = computeScore(
        makeReport(results, { testedPages: 1, samplingStrategy: 'curated' }),
      );
      expect(score.checkScores['page-size-html'].scoreDisplayMode).toBe('numeric');
    });

    it('does not mark checks as notApplicable when testedPages > 1', () => {
      const results: CheckResult[] = [makeResult('page-size-html', 'page-size', 'pass')];
      const score = computeScore(
        makeReport(results, { testedPages: 10, samplingStrategy: 'random' }),
      );
      expect(score.checkScores['page-size-html'].scoreDisplayMode).toBe('numeric');
    });

    it('nulls category scores when all checks in category are notApplicable', () => {
      const results: CheckResult[] = [
        makeResult('llms-txt-exists', 'content-discoverability', 'pass'),
        makeResult('http-status-codes', 'url-stability', 'pass'),
        makeResult('redirect-behavior', 'url-stability', 'pass'),
      ];
      const score = computeScore(
        makeReport(results, { testedPages: 1, samplingStrategy: 'random' }),
      );
      // url-stability has only page-level checks -> null
      expect(score.categoryScores['url-stability'].score).toBeNull();
      expect(score.categoryScores['url-stability'].grade).toBeNull();
      // content-discoverability has site-level check -> numeric
      expect(score.categoryScores['content-discoverability'].score).toBe(100);
    });

    it('computes mixed category scores from numeric checks only', () => {
      const results: CheckResult[] = [
        makeResult('llms-txt-coverage', 'observability', 'pass'),
        makeResult('cache-header-hygiene', 'observability', 'pass'),
      ];
      const score = computeScore(
        makeReport(results, { testedPages: 1, samplingStrategy: 'random' }),
      );
      // observability: llms-txt-coverage is site-level (numeric), cache-header-hygiene is page-level (N/A)
      // score computed from only llms-txt-coverage
      expect(score.categoryScores['observability'].score).toBe(100);
    });

    it('excludes notApplicable checks from overall score', () => {
      const results: CheckResult[] = [
        makeResult('llms-txt-exists', 'content-discoverability', 'pass'),
        makeResult('page-size-html', 'page-size', 'fail', {
          passBucket: 0,
          warnBucket: 0,
          failBucket: 1,
        }),
      ];
      // With N/A: only llms-txt-exists counts (pass) — raw score 100, but
      // single-page-sample cap pulls it to 59. Verify exclusion via checkScores.
      const scoreNA = computeScore(
        makeReport(results, { testedPages: 1, samplingStrategy: 'random' }),
      );
      // Without N/A: both count, page-size-html fails -> less than 100
      const scoreNormal = computeScore(
        makeReport(results, { testedPages: 10, samplingStrategy: 'random' }),
      );
      expect(scoreNA.checkScores['page-size-html'].scoreDisplayMode).toBe('notApplicable');
      expect(scoreNA.checkScores['llms-txt-exists'].scoreDisplayMode).toBe('numeric');
      expect(scoreNormal.overall).toBeLessThan(100);
    });

    it('fires single-page-sample diagnostic when N/A condition met', () => {
      const results: CheckResult[] = [
        makeResult('llms-txt-exists', 'content-discoverability', 'fail'),
        makeResult('page-size-html', 'page-size', 'pass'),
      ];
      const score = computeScore(
        makeReport(results, { testedPages: 1, samplingStrategy: 'random' }),
      );
      expect(score.diagnostics.find((d) => d.id === 'single-page-sample')).toBeDefined();
    });

    it('all checks get numeric scoreDisplayMode by default (no sampling info)', () => {
      const results: CheckResult[] = [makeResult('page-size-html', 'page-size', 'pass')];
      const score = computeScore(makeReport(results));
      expect(score.checkScores['page-size-html'].scoreDisplayMode).toBe('numeric');
    });

    it('does not apply rendering-strategy cap when check is notApplicable', () => {
      const results: CheckResult[] = [
        makeResult('llms-txt-exists', 'content-discoverability', 'pass'),
        makeResult('rendering-strategy', 'page-size', 'fail', {
          serverRendered: 0,
          sparseContent: 0,
          spaShells: 1,
        }),
      ];
      // With N/A: rendering-strategy is notApplicable, so its cap should NOT
      // fire. (single-page-sample's own 59 cap may still apply, but we're
      // asserting that the rendering-strategy cap specifically doesn't.)
      const scoreNA = computeScore(
        makeReport(results, { testedPages: 1, samplingStrategy: 'random' }),
      );
      expect(scoreNA.checkScores['rendering-strategy'].scoreDisplayMode).toBe('notApplicable');
      expect(scoreNA.cap?.checkId).not.toBe('rendering-strategy');

      // Without N/A: same data, cap SHOULD fire
      const scoreNormal = computeScore(
        makeReport(results, { testedPages: 10, samplingStrategy: 'random' }),
      );
      expect(scoreNormal.cap).toBeDefined();
      expect(scoreNormal.cap!.cap).toBe(39);
    });
  });
  describe('partial sample flag', () => {
    it('flags page-level checks when bot protection degraded the scan', () => {
      const report = makeReport(
        [
          makeResult('llms-txt-exists', 'content-discoverability', 'pass'),
          makeResult('page-size-html', 'page-size', 'pass', {
            passBucket: 8,
            warnBucket: 0,
            failBucket: 0,
          }),
          makeResult('bot-protection-interference', 'authentication', 'warn'),
        ],
        { testedPages: 8, samplingStrategy: 'random' },
      );
      const score = computeScore(report);
      expect(score.checkScores['page-size-html'].partialSample).toBe(true);
      expect(score.checkScores['llms-txt-exists'].partialSample).toBeUndefined();
      expect(score.checkScores['bot-protection-interference'].partialSample).toBeUndefined();
      expect(score.diagnostics.map((d) => d.id)).toContain('bot-protection-scan-reliability');
      // Flagged runs still score: the check keeps its earned weight.
      expect(score.checkScores['page-size-html'].earnedScore).toBe(7);
    });

    it('flags every multi-page check on warn, even those that finished before onset', () => {
      const report = makeReport(
        [
          makeResult('page-size-html', 'page-size', 'pass', {
            passBucket: 8,
            warnBucket: 0,
            failBucket: 0,
          }),
          makeResult('auth-gate-detection', 'authentication', 'pass', {
            pageResults: [{ classification: 'accessible' }],
          }),
          makeResult('bot-protection-interference', 'authentication', 'warn', {
            affectedChecks: ['auth-gate-detection'],
          }),
        ],
        { testedPages: 8, samplingStrategy: 'random' },
      );
      const score = computeScore(report);
      expect(score.checkScores['auth-gate-detection'].partialSample).toBe(true);
      expect(score.checkScores['page-size-html'].partialSample).toBe(true);
    });

    it('does not flag anything on a clean run', () => {
      const report = makeReport(
        [
          makeResult('page-size-html', 'page-size', 'pass', {
            passBucket: 8,
            warnBucket: 0,
            failBucket: 0,
          }),
          makeResult('bot-protection-interference', 'authentication', 'pass'),
        ],
        { testedPages: 8, samplingStrategy: 'random' },
      );
      const score = computeScore(report);
      expect(score.checkScores['page-size-html'].partialSample).toBeUndefined();
    });

    it('scores the check itself by status', () => {
      const warn = computeScore(
        makeReport([makeResult('bot-protection-interference', 'authentication', 'warn')]),
      );
      expect(warn.checkScores['bot-protection-interference'].earnedScore).toBe(3.5);
      const fail = computeScore(
        makeReport([makeResult('bot-protection-interference', 'authentication', 'fail')]),
      );
      expect(fail.checkScores['bot-protection-interference'].earnedScore).toBe(0);
    });
  });
});
