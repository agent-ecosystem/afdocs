import { describe, it, expect } from 'vitest';
import { computeTagScores } from '../../../src/scoring/tag-scores.js';
import type { CheckResult, ReportResult } from '../../../src/types.js';
import type { CheckScore } from '../../../src/scoring/types.js';

function makeResult(
  id: string,
  category: string,
  status: CheckResult['status'],
  details?: Record<string, unknown>,
): CheckResult {
  return { id, category, status, message: `${id}: ${status}`, details };
}

function makeReport(results: CheckResult[], urlTags?: Record<string, string>): ReportResult {
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
    urlTags,
  };
}

function makeCheckScore(effectiveWeight: number): CheckScore {
  return {
    baseWeight: effectiveWeight,
    coefficient: 1,
    effectiveWeight,
    proportion: 1,
    earnedScore: effectiveWeight,
    maxScore: effectiveWeight,
  };
}

describe('computeTagScores', () => {
  it('returns undefined when no urlTags', () => {
    const report = makeReport([]);
    const result = computeTagScores(report, {});
    expect(result).toBeUndefined();
  });

  it('returns undefined when urlTags is empty', () => {
    const report = makeReport([], {});
    const result = computeTagScores(report, {});
    expect(result).toBeUndefined();
  });

  it('computes tag scores from pageResults with status field', () => {
    const report = makeReport(
      [
        makeResult('page-size-html', 'page-size', 'warn', {
          passBucket: 2,
          warnBucket: 1,
          failBucket: 0,
          pageResults: [
            { url: 'https://example.com/a', status: 'pass' },
            { url: 'https://example.com/b', status: 'pass' },
            { url: 'https://example.com/c', status: 'warn' },
          ],
        }),
      ],
      {
        'https://example.com/a': 'getting-started',
        'https://example.com/b': 'api',
        'https://example.com/c': 'api',
      },
    );

    const checkScores: Record<string, CheckScore> = {
      'page-size-html': makeCheckScore(7),
    };

    const result = computeTagScores(report, checkScores);
    expect(result).toBeDefined();

    // getting-started: 1 page passing -> proportion 1.0 -> score 100
    expect(result!['getting-started'].score).toBe(100);
    expect(result!['getting-started'].grade).toBe('A+');
    expect(result!['getting-started'].pageCount).toBe(1);
    expect(result!['getting-started'].checks).toHaveLength(1);
    expect(result!['getting-started'].checks[0].checkId).toBe('page-size-html');
    expect(result!['getting-started'].checks[0].proportion).toBe(1);
    expect(result!['getting-started'].checks[0].pages).toEqual([
      { url: 'https://example.com/a', status: 'pass' },
    ]);

    // api: 1 pass + 1 warn -> proportion (1 + 0.5) / 2 = 0.75 -> score 75
    expect(result!['api'].score).toBe(75);
    expect(result!['api'].grade).toBe('C');
    expect(result!['api'].pageCount).toBe(2);
    expect(result!['api'].checks).toHaveLength(1);
    expect(result!['api'].checks[0].proportion).toBe(0.75);
    expect(result!['api'].checks[0].weight).toBe(7);
    expect(result!['api'].checks[0].pages).toEqual([
      { url: 'https://example.com/b', status: 'pass' },
      { url: 'https://example.com/c', status: 'warn' },
    ]);
  });

  it('computes tag scores from classification-based checks', () => {
    const report = makeReport(
      [
        makeResult('auth-gate-detection', 'authentication', 'fail', {
          pageResults: [
            { url: 'https://example.com/public', classification: 'accessible' },
            { url: 'https://example.com/private', classification: 'auth-required' },
          ],
        }),
      ],
      {
        'https://example.com/public': 'docs',
        'https://example.com/private': 'docs',
      },
    );

    const checkScores: Record<string, CheckScore> = {
      'auth-gate-detection': makeCheckScore(10),
    };

    const result = computeTagScores(report, checkScores);
    expect(result).toBeDefined();
    // 1 pass + 1 fail out of 2 -> proportion 0.5 -> score 50
    expect(result!['docs'].score).toBe(50);
  });

  it('handles tabbedPages field for tabbed-content-serialization', () => {
    const report = makeReport(
      [
        makeResult('tabbed-content-serialization', 'content-structure', 'pass', {
          tabbedPages: [
            { url: 'https://example.com/a', status: 'pass' },
            { url: 'https://example.com/b', status: 'fail' },
          ],
        }),
      ],
      {
        'https://example.com/a': 'tag-a',
        'https://example.com/b': 'tag-b',
      },
    );

    const checkScores: Record<string, CheckScore> = {
      'tabbed-content-serialization': makeCheckScore(4),
    };

    const result = computeTagScores(report, checkScores);
    expect(result).toBeDefined();
    expect(result!['tag-a'].score).toBe(100);
    expect(result!['tag-b'].score).toBe(0);
  });

  it('handles analyses field for section-header-quality', () => {
    const report = makeReport(
      [
        makeResult('section-header-quality', 'content-structure', 'warn', {
          analyses: [
            {
              url: 'https://example.com/good',
              hasGenericMajority: false,
              hasCrossGroupGeneric: false,
            },
            {
              url: 'https://example.com/bad',
              hasGenericMajority: true,
              hasCrossGroupGeneric: false,
            },
          ],
        }),
      ],
      {
        'https://example.com/good': 'quality',
        'https://example.com/bad': 'quality',
      },
    );

    const checkScores: Record<string, CheckScore> = {
      'section-header-quality': makeCheckScore(2),
    };

    const result = computeTagScores(report, checkScores);
    expect(result).toBeDefined();
    // 1 pass + 1 fail -> 50
    expect(result!['quality'].score).toBe(50);
  });

  it('skips single-resource checks like llms-txt-exists', () => {
    const report = makeReport(
      [
        makeResult('llms-txt-exists', 'content-discoverability', 'pass', {
          discoveredFiles: [{ url: 'https://example.com/llms.txt' }],
        }),
      ],
      { 'https://example.com/a': 'tag-a' },
    );

    const checkScores: Record<string, CheckScore> = {
      'llms-txt-exists': makeCheckScore(10),
    };

    // llms-txt-exists is a single-resource check. Since no per-page checks
    // contributed data, the tag is omitted entirely (no data ≠ score 0).
    const result = computeTagScores(report, checkScores);
    expect(result).toBeUndefined();
  });

  it('omits tags whose URLs appear in no check results', () => {
    const report = makeReport(
      [
        makeResult('page-size-html', 'page-size', 'pass', {
          pageResults: [{ url: 'https://example.com/a', status: 'pass' }],
        }),
      ],
      {
        'https://example.com/a': 'found',
        'https://example.com/missing': 'not-found',
      },
    );

    const checkScores: Record<string, CheckScore> = {
      'page-size-html': makeCheckScore(7),
    };

    const result = computeTagScores(report, checkScores);
    expect(result).toBeDefined();
    expect(result!['found'].score).toBe(100);
    // not-found tag's URL doesn't appear in any pageResults, so the tag
    // is omitted (no data ≠ score 0).
    expect(result!['not-found']).toBeUndefined();
  });

  it('aggregates across multiple checks', () => {
    const report = makeReport(
      [
        makeResult('page-size-html', 'page-size', 'pass', {
          pageResults: [{ url: 'https://example.com/a', status: 'pass' }],
        }),
        makeResult('rendering-strategy', 'authentication', 'fail', {
          pageResults: [{ url: 'https://example.com/a', status: 'fail' }],
        }),
      ],
      { 'https://example.com/a': 'mixed' },
    );

    const checkScores: Record<string, CheckScore> = {
      'page-size-html': makeCheckScore(7),
      'rendering-strategy': makeCheckScore(10),
    };

    const result = computeTagScores(report, checkScores);
    expect(result).toBeDefined();
    // page-size-html: proportion=1.0 * weight=7 = 7 earned, 7 max
    // rendering-strategy: proportion=0.0 * weight=10 = 0 earned, 10 max
    // total: 7/17 = 41.2% -> 41
    expect(result!['mixed'].score).toBe(41);
    expect(result!['mixed'].checks).toHaveLength(2);
    expect(result!['mixed'].checks[0]).toMatchObject({
      checkId: 'page-size-html',
      proportion: 1,
      weight: 7,
    });
    expect(result!['mixed'].checks[1]).toMatchObject({
      checkId: 'rendering-strategy',
      proportion: 0,
      weight: 10,
    });
  });

  it('uses per-check warn coefficients instead of hardcoded 0.5', () => {
    // redirect-behavior has warnCoefficient 0.6, content-negotiation has 0.75
    const report = makeReport(
      [
        makeResult('redirect-behavior', 'url-stability', 'warn', {
          pageResults: [{ url: 'https://example.com/a', classification: 'cross-host' }],
        }),
        makeResult('content-negotiation', 'markdown-availability', 'warn', {
          pageResults: [
            { url: 'https://example.com/a', classification: 'markdown-with-wrong-type' },
          ],
        }),
      ],
      { 'https://example.com/a': 'test-tag' },
    );

    const checkScores: Record<string, CheckScore> = {
      'redirect-behavior': makeCheckScore(4),
      'content-negotiation': makeCheckScore(4),
    };

    const result = computeTagScores(report, checkScores);
    expect(result).toBeDefined();

    // redirect-behavior: 1 warn with coeff 0.6 -> proportion 0.6
    // content-negotiation: 1 warn with coeff 0.75 -> proportion 0.75
    // If hardcoded to 0.5, both would be 0.5 and score would be 50.
    // With correct coefficients: (0.6*4 + 0.75*4) / (4+4) = 5.4/8 = 0.675 -> 68
    expect(result!['test-tag'].checks[0].proportion).toBe(0.6);
    expect(result!['test-tag'].checks[1].proportion).toBe(0.75);
    expect(result!['test-tag'].score).toBe(68);
  });

  it('maps status correctly for all custom status mappers', () => {
    const report = makeReport(
      [
        // markdown-url-support: supported -> pass, !supported -> fail, skipped -> skip
        makeResult('markdown-url-support', 'markdown-availability', 'pass', {
          pageResults: [
            { url: 'https://example.com/a', supported: true },
            { url: 'https://example.com/b', supported: false },
            { url: 'https://example.com/c', skipped: true },
          ],
        }),
        // http-status-codes: correct-error -> pass, soft-404 -> fail
        makeResult('http-status-codes', 'url-stability', 'fail', {
          pageResults: [
            { url: 'https://example.com/a', classification: 'correct-error' },
            { url: 'https://example.com/b', classification: 'soft-404' },
          ],
        }),
        // llms-txt-directive-html: found near top -> pass, found deep -> warn, not found -> fail
        makeResult('llms-txt-directive-html', 'content-discoverability', 'warn', {
          pageResults: [
            { url: 'https://example.com/a', found: true, positionPercent: 5 },
            { url: 'https://example.com/b', found: true, positionPercent: 80 },
            { url: 'https://example.com/c', found: false },
          ],
        }),
        // cache-header-hygiene: uses endpointResults field
        makeResult('cache-header-hygiene', 'observability', 'pass', {
          endpointResults: [
            { url: 'https://example.com/a', status: 'pass' },
            { url: 'https://example.com/b', status: 'fail' },
          ],
        }),
      ],
      {
        'https://example.com/a': 'all',
        'https://example.com/b': 'all',
        'https://example.com/c': 'all',
      },
    );

    const checkScores: Record<string, CheckScore> = {
      'markdown-url-support': makeCheckScore(7),
      'http-status-codes': makeCheckScore(7),
      'llms-txt-directive-html': makeCheckScore(7),
      'cache-header-hygiene': makeCheckScore(2),
    };

    const result = computeTagScores(report, checkScores);
    expect(result).toBeDefined();

    const checks = result!['all'].checks;
    // markdown-url-support: 1 pass, 1 fail (skipped excluded) -> 0.5
    const mdUrl = checks.find((c) => c.checkId === 'markdown-url-support')!;
    expect(mdUrl.proportion).toBe(0.5);
    expect(mdUrl.pages).toHaveLength(3);
    expect(mdUrl.pages[2].status).toBe('skip');

    // http-status-codes: 1 pass, 1 fail -> 0.5
    const httpStatus = checks.find((c) => c.checkId === 'http-status-codes')!;
    expect(httpStatus.proportion).toBe(0.5);

    // llms-txt-directive-html: 1 pass, 1 warn, 1 fail -> (1 + 0.6*1) / 3
    const directive = checks.find((c) => c.checkId === 'llms-txt-directive-html')!;
    expect(directive.pages[0].status).toBe('pass');
    expect(directive.pages[1].status).toBe('warn');
    expect(directive.pages[2].status).toBe('fail');

    // cache-header-hygiene: uses endpointResults, 1 pass + 1 fail -> 0.5
    const cache = checks.find((c) => c.checkId === 'cache-header-hygiene')!;
    expect(cache.proportion).toBe(0.5);
  });

  it('covers remaining status mapper branches', () => {
    const report = makeReport(
      [
        // content-negotiation: pass, fail, and default/skip branches
        makeResult('content-negotiation', 'markdown-availability', 'pass', {
          pageResults: [
            { url: 'https://example.com/a', classification: 'markdown-with-correct-type' },
            { url: 'https://example.com/b', classification: 'html' },
            { url: 'https://example.com/c', classification: 'unknown-value' },
          ],
        }),
        // redirect-behavior: pass (no-redirect), fail (js-redirect), and default
        makeResult('redirect-behavior', 'url-stability', 'warn', {
          pageResults: [
            { url: 'https://example.com/a', classification: 'no-redirect' },
            { url: 'https://example.com/b', classification: 'js-redirect' },
            { url: 'https://example.com/c', classification: 'unknown-value' },
          ],
        }),
        // auth-gate-detection: soft-auth-gate (warn) and default (skip)
        makeResult('auth-gate-detection', 'authentication', 'warn', {
          pageResults: [
            { url: 'https://example.com/a', classification: 'soft-auth-gate' },
            { url: 'https://example.com/b', classification: 'unknown-value' },
          ],
        }),
        // http-status-codes: default/skip branch
        makeResult('http-status-codes', 'url-stability', 'pass', {
          pageResults: [{ url: 'https://example.com/a', classification: 'unknown-value' }],
        }),
        // llms-txt-directive-html: error -> skip
        makeResult('llms-txt-directive-html', 'content-discoverability', 'pass', {
          pageResults: [{ url: 'https://example.com/a', error: 'fetch failed' }],
        }),
        // section-header-quality: hasCrossGroupGeneric -> warn
        makeResult('section-header-quality', 'content-structure', 'warn', {
          analyses: [
            { url: 'https://example.com/a', hasGenericMajority: false, hasCrossGroupGeneric: true },
          ],
        }),
      ],
      {
        'https://example.com/a': 'tag',
        'https://example.com/b': 'tag',
        'https://example.com/c': 'tag',
      },
    );

    const checkScores: Record<string, CheckScore> = {
      'content-negotiation': makeCheckScore(4),
      'redirect-behavior': makeCheckScore(4),
      'auth-gate-detection': makeCheckScore(10),
      'http-status-codes': makeCheckScore(7),
      'llms-txt-directive-html': makeCheckScore(7),
      'section-header-quality': makeCheckScore(2),
    };

    const result = computeTagScores(report, checkScores);
    expect(result).toBeDefined();
    const checks = result!['tag'].checks;

    // content-negotiation: pass + fail (skip excluded) -> 0.5
    const cn = checks.find((c) => c.checkId === 'content-negotiation')!;
    expect(cn.pages[0].status).toBe('pass');
    expect(cn.pages[1].status).toBe('fail');
    expect(cn.pages[2].status).toBe('skip');
    expect(cn.proportion).toBe(0.5);

    // redirect-behavior: pass + fail (skip excluded) -> 0.5
    const rb = checks.find((c) => c.checkId === 'redirect-behavior')!;
    expect(rb.pages[0].status).toBe('pass');
    expect(rb.pages[1].status).toBe('fail');
    expect(rb.pages[2].status).toBe('skip');

    // auth-gate-detection: 1 warn (skip excluded) -> warnCoeff 0.5
    const ag = checks.find((c) => c.checkId === 'auth-gate-detection')!;
    expect(ag.pages[0].status).toBe('warn');
    expect(ag.pages[1].status).toBe('skip');

    // section-header-quality: hasCrossGroupGeneric -> warn
    const shq = checks.find((c) => c.checkId === 'section-header-quality')!;
    expect(shq.pages[0].status).toBe('warn');
  });

  it('skips results with no details, no checkScore, empty pageResults, or all-skip items', () => {
    const report = makeReport(
      [
        // No details
        makeResult('rendering-strategy', 'page-size', 'pass'),
        // Has details but no matching checkScore
        makeResult('page-size-html', 'page-size', 'pass', {
          pageResults: [{ url: 'https://example.com/a', status: 'pass' }],
        }),
        // Has details but empty pageResults array
        makeResult('content-start-position', 'page-size', 'pass', {
          pageResults: [],
        }),
        // Has details but items have no string status (defaultStatusMapper -> skip)
        makeResult('markdown-content-parity', 'observability', 'pass', {
          pageResults: [{ url: 'https://example.com/a', result: { missing: 0 } }],
        }),
      ],
      { 'https://example.com/a': 'tag' },
    );

    // Only provide checkScore for some checks — page-size-html intentionally omitted
    const checkScores: Record<string, CheckScore> = {
      'rendering-strategy': makeCheckScore(10),
      'content-start-position': makeCheckScore(4),
      'markdown-content-parity': makeCheckScore(4),
    };

    // No checks produce scoreable data for the tag:
    // - rendering-strategy: no details
    // - page-size-html: no checkScore
    // - content-start-position: empty pageResults
    // - markdown-content-parity: all items map to 'skip', total=0
    const result = computeTagScores(report, checkScores);
    expect(result).toBeUndefined();
  });
});
