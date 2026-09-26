import { describe, it, expect } from 'vitest';
import { formatScorecard } from '../../../src/cli/formatters/scorecard.js';
import type { ReportResult } from '../../../src/types.js';
import type { ScoreResult } from '../../../src/scoring/types.js';

function makeReport(overrides?: Partial<ReportResult>): ReportResult {
  return {
    url: 'http://example.com',
    timestamp: '2026-01-01T00:00:00.000Z',
    results: [
      {
        id: 'llms-txt-exists',
        category: 'content-discoverability',
        status: 'pass',
        message: 'Found at /llms.txt',
      },
      {
        id: 'llms-txt-valid',
        category: 'content-discoverability',
        status: 'warn',
        message: 'Non-standard structure',
      },
      {
        id: 'markdown-url-support',
        category: 'markdown-availability',
        status: 'fail',
        message: 'No .md URLs',
      },
    ],
    summary: { total: 3, pass: 1, warn: 1, fail: 1, skip: 0, error: 0 },
    ...overrides,
  };
}

function makeScoreResult(overrides?: Partial<ScoreResult>): ScoreResult {
  return {
    overall: 72,
    grade: 'C',
    categoryScores: {
      'content-discoverability': { score: 80, grade: 'B' },
      'markdown-availability': { score: 0, grade: 'F' },
    },
    checkScores: {
      'llms-txt-exists': {
        baseWeight: 10,
        coefficient: 1,
        effectiveWeight: 10,
        proportion: 1,
        earnedScore: 10,
        maxScore: 10,
        scoreDisplayMode: 'numeric',
      },
      'llms-txt-valid': {
        baseWeight: 4,
        coefficient: 1,
        effectiveWeight: 4,
        proportion: 0.75,
        earnedScore: 3,
        maxScore: 4,
        scoreDisplayMode: 'numeric',
      },
      'markdown-url-support': {
        baseWeight: 7,
        coefficient: 1,
        effectiveWeight: 7,
        proportion: 0,
        earnedScore: 0,
        maxScore: 7,
        scoreDisplayMode: 'numeric',
      },
    },
    diagnostics: [],
    resolutions: {
      'llms-txt-valid':
        "Your llms.txt contains parseable links but doesn't follow the standard structure.",
      'markdown-url-support': "Your pages don't return markdown when .md is appended to the URL.",
    },
    ...overrides,
  };
}

describe('formatScorecard', () => {
  it('includes the header and URL', () => {
    const output = formatScorecard(makeReport(), makeScoreResult());
    expect(output).toContain('Agent-Friendly Docs Scorecard');
    expect(output).toContain('http://example.com');
  });

  it('shows overall score and grade', () => {
    const output = formatScorecard(makeReport(), makeScoreResult());
    expect(output).toContain('72 / 100');
    expect(output).toContain('(C)');
  });

  it('shows category scores', () => {
    const output = formatScorecard(makeReport(), makeScoreResult());
    expect(output).toContain('Content Discoverability');
    expect(output).toContain('80 / 100');
    expect(output).toContain('(B)');
    expect(output).toContain('Markdown Availability');
    expect(output).toContain('0 / 100');
    expect(output).toContain('(F)');
  });

  it('shows cap information when present', () => {
    const score = makeScoreResult({
      cap: {
        cap: 59,
        checkId: 'llms-txt-exists',
        reason: 'agents lose primary navigation',
      },
    });
    const output = formatScorecard(makeReport(), score);
    expect(output).toContain('Capped');
    expect(output).toContain('llms-txt-exists');
    expect(output).toContain('agents lose primary navigation');
  });

  it('does not show cap section when no cap', () => {
    const output = formatScorecard(makeReport(), makeScoreResult());
    expect(output).not.toContain('Capped');
  });

  it('shows interaction diagnostics', () => {
    const score = makeScoreResult({
      diagnostics: [
        {
          id: 'markdown-undiscoverable',
          severity: 'warning',
          message:
            'Your site serves markdown at .md URLs, but agents have no way to discover this.',
          resolution: 'Add a blockquote directive near the top of each docs page.',
        },
      ],
    });
    const output = formatScorecard(makeReport(), score);
    expect(output).toContain('Interaction Diagnostics');
    expect(output).toContain('agents have no way to discover this');
    expect(output).toContain('Fix:');
    expect(output).toContain('blockquote directive');
  });

  it('omits diagnostics section when empty', () => {
    const output = formatScorecard(makeReport(), makeScoreResult());
    expect(output).not.toContain('Interaction Diagnostics');
  });

  it('shows check results with status labels', () => {
    const output = formatScorecard(makeReport(), makeScoreResult());
    expect(output).toContain('PASS');
    expect(output).toContain('llms-txt-exists');
    expect(output).toContain('Found at /llms.txt');
    expect(output).toContain('WARN');
    expect(output).toContain('llms-txt-valid');
    expect(output).toContain('FAIL');
    expect(output).toContain('markdown-url-support');
  });

  it('shows resolution text for warn/fail checks', () => {
    const output = formatScorecard(makeReport(), makeScoreResult());
    expect(output).toContain('Fix:');
    expect(output).toContain("doesn't follow the standard structure");
    expect(output).toContain("don't return markdown");
  });

  it('does not show resolution for passing checks', () => {
    const score = makeScoreResult({ resolutions: {} });
    const output = formatScorecard(makeReport(), score);
    // Only the check result lines, no Fix: lines
    const fixLines = output.split('\n').filter((l) => l.includes('Fix:'));
    expect(fixLines).toHaveLength(0);
  });

  it('shows spec URL in footer', () => {
    const output = formatScorecard(makeReport(), makeScoreResult());
    expect(output).toContain('agentdocsspec.com');
  });

  it('computes score from report when no scoreResult provided', () => {
    // This test verifies the auto-compute path works without throwing
    const report = makeReport({
      results: [
        {
          id: 'llms-txt-exists',
          category: 'content-discoverability',
          status: 'pass',
          message: 'Found',
        },
      ],
      summary: { total: 1, pass: 1, warn: 0, fail: 0, skip: 0, error: 0 },
    });
    const output = formatScorecard(report);
    expect(output).toContain('Overall Score');
    expect(output).toContain('/ 100');
  });

  it('renders critical diagnostics with [!] icon', () => {
    const score = makeScoreResult({
      diagnostics: [
        {
          id: 'no-viable-path',
          severity: 'critical',
          message: 'Agents have no effective way to access your documentation.',
          resolution: 'Create an llms.txt at your site root.',
        },
      ],
    });
    const output = formatScorecard(makeReport(), score);
    expect(output).toContain('Interaction Diagnostics');
    expect(output).toContain('no effective way to access');
    expect(output).toContain('Fix:');
  });

  it('renders info diagnostics with [i] icon', () => {
    const score = makeScoreResult({
      diagnostics: [
        {
          id: 'spa-shell-html-invalid',
          severity: 'info',
          message: '5 of 10 sampled pages use client-side rendering.',
          resolution: 'Enable server-side rendering.',
        },
      ],
    });
    const output = formatScorecard(makeReport(), score);
    expect(output).toContain('client-side rendering');
    expect(output).toContain('Fix:');
    expect(output).toContain('server-side rendering');
  });

  it('handles skip and error statuses in check results', () => {
    const report = makeReport({
      results: [
        {
          id: 'llms-txt-size',
          category: 'content-discoverability',
          status: 'skip',
          message: 'Skipped (dependency failed)',
        },
        {
          id: 'page-size-html',
          category: 'page-size',
          status: 'error',
          message: 'Timeout',
        },
      ],
      summary: { total: 2, pass: 0, warn: 0, fail: 0, skip: 1, error: 1 },
    });
    const score = makeScoreResult({
      categoryScores: {
        'content-discoverability': { score: 50, grade: 'D' },
        'page-size': { score: 0, grade: 'F' },
      },
      resolutions: {},
    });
    const output = formatScorecard(report, score);
    expect(output).toContain('SKIP');
    expect(output).toContain('Skipped (dependency failed)');
    expect(output).toContain('ERR');
    expect(output).toContain('Timeout');
  });

  it('skips categories with no check results', () => {
    // Report only has content-discoverability results, but score has multiple categories
    const report = makeReport({
      results: [
        {
          id: 'llms-txt-exists',
          category: 'content-discoverability',
          status: 'pass',
          message: 'Found',
        },
      ],
      summary: { total: 1, pass: 1, warn: 0, fail: 0, skip: 0, error: 0 },
    });
    const score = makeScoreResult({
      categoryScores: {
        'content-discoverability': { score: 100, grade: 'A' },
        'markdown-availability': { score: 0, grade: 'F' },
      },
      resolutions: {},
    });
    const output = formatScorecard(report, score);
    // Category score line should appear, but no check results under markdown-availability
    expect(output).toContain('Content Discoverability');
    expect(output).toContain('llms-txt-exists');
    expect(output).not.toContain('markdown-url-support');
  });

  it('handles unknown status gracefully', () => {
    const report = makeReport({
      results: [
        {
          id: 'llms-txt-exists',
          category: 'content-discoverability',
          status: 'something-unknown' as 'pass',
          message: 'Weird status',
        },
      ],
      summary: { total: 1, pass: 0, warn: 0, fail: 0, skip: 0, error: 0 },
    });
    const score = makeScoreResult({
      categoryScores: {
        'content-discoverability': { score: 50, grade: 'D' },
      },
      resolutions: {},
    });
    const output = formatScorecard(report, score);
    expect(output).toContain('Weird status');
  });

  it('does not split diagnostic heading on periods in file extensions', () => {
    const score = makeScoreResult({
      diagnostics: [
        {
          id: 'markdown-undiscoverable',
          severity: 'warning',
          message:
            'Your site serves markdown at .md URLs, but agents have no way to discover this. Without content negotiation, an llms.txt directive on your pages, most agents will default to the HTML path.',
          resolution: 'Add a blockquote directive.',
        },
        {
          id: 'llms-txt-oversized',
          severity: 'warning',
          message:
            'Your llms.txt is 4,561,591 characters. Agents see roughly the first 100,000 characters.',
          resolution: 'Split into section-level files.',
        },
      ],
    });
    const output = formatScorecard(makeReport(), score);
    // The heading should include the full first sentence, not split on ".md" or "llms.txt"
    expect(output).toContain(
      'Your site serves markdown at .md URLs, but agents have no way to discover this',
    );
    expect(output).toContain('Your llms.txt is 4,561,591 characters');
  });

  it('handles diagnostic with unknown severity gracefully', () => {
    const score = makeScoreResult({
      diagnostics: [
        {
          id: 'test-diag',
          severity: 'unknown-severity' as 'info',
          message: 'Something unusual happened.',
          resolution: 'Do something about it.',
        },
      ],
    });
    const output = formatScorecard(makeReport(), score);
    expect(output).toContain('Something unusual happened');
  });

  it('shows all grade levels correctly', () => {
    const score = makeScoreResult({
      overall: 35,
      grade: 'F',
      categoryScores: {
        'content-discoverability': { score: 95, grade: 'A' },
        'markdown-availability': { score: 80, grade: 'B' },
        'page-size': { score: 65, grade: 'C' },
        'content-structure': { score: 45, grade: 'D' },
        'url-stability': { score: 20, grade: 'F' },
      },
    });
    const output = formatScorecard(makeReport(), score);
    expect(output).toContain('(A)');
    expect(output).toContain('(B)');
    expect(output).toContain('(C)');
    expect(output).toContain('(D)');
    expect(output).toContain('(F)');
  });

  it('shows tag scores when present', () => {
    const score = makeScoreResult({
      tagScores: {
        'getting-started': { score: 90, grade: 'A', pageCount: 3, checks: [] },
        'api-reference': {
          score: 65,
          grade: 'D',
          pageCount: 5,
          checks: [
            {
              checkId: 'page-size-html',
              category: 'page-size',
              weight: 7,
              proportion: 0.6,
              pages: [
                { url: 'https://example.com/a', status: 'pass' },
                { url: 'https://example.com/b', status: 'fail' },
                { url: 'https://example.com/c', status: 'warn' },
              ],
            },
          ],
        },
      },
    });
    const output = formatScorecard(makeReport(), score);
    expect(output).toContain('Tag Scores:');
    expect(output).toContain('api-reference');
    expect(output).toContain('65 / 100');
    expect(output).toContain('getting-started');
    expect(output).toContain('90 / 100');
    // Shows page counts
    expect(output).toContain('3 pages');
    expect(output).toContain('5 pages');
    // Shows check breakdown for non-passing checks
    expect(output).toContain('page-size-html');
    expect(output).toContain('1 fail');
    expect(output).toContain('1 warn');
    expect(output).toContain('1 pass');
  });

  it('omits tag scores section when not present', () => {
    const output = formatScorecard(makeReport(), makeScoreResult());
    expect(output).not.toContain('Tag Scores:');
  });

  it('renders null category scores as N/A dash', () => {
    const score = makeScoreResult({
      categoryScores: {
        'content-discoverability': { score: 80, grade: 'B' },
        'markdown-availability': { score: null, grade: null },
        'page-size': { score: null, grade: null },
        'url-stability': { score: null, grade: null },
      },
    });
    const output = formatScorecard(makeReport(), score);
    expect(output).toContain('Content Discoverability');
    expect(output).toContain('80 / 100');
    expect(output).toContain('(N/A)');
    // Should not show a numeric score for null categories
    expect(output).not.toContain('null / 100');
  });

  it('shows tag scores with singular page count', () => {
    const score = makeScoreResult({
      tagScores: {
        quickstart: {
          score: 95,
          grade: 'A',
          pageCount: 1,
          checks: [],
        },
      },
    });
    const output = formatScorecard(makeReport(), score);
    expect(output).toContain('1 page');
    expect(output).not.toContain('1 pages');
  });

  it('shows tag score check breakdown with only warns (no fails)', () => {
    const score = makeScoreResult({
      tagScores: {
        tutorials: {
          score: 80,
          grade: 'B',
          pageCount: 3,
          checks: [
            {
              checkId: 'page-size-html',
              category: 'page-size',
              weight: 7,
              proportion: 0.8,
              pages: [
                { url: 'https://example.com/a', status: 'pass' },
                { url: 'https://example.com/b', status: 'warn' },
                { url: 'https://example.com/c', status: 'warn' },
              ],
            },
          ],
        },
      },
    });
    const output = formatScorecard(makeReport(), score);
    expect(output).toContain('2 warn');
    expect(output).toContain('1 pass');
    expect(output).not.toContain('fail');
    expect(output).toContain('WARN');
  });

  it('handles tag score page with skip status (not counted in pass/warn/fail)', () => {
    const score = makeScoreResult({
      tagScores: {
        api: {
          score: 50,
          grade: 'D',
          pageCount: 2,
          checks: [
            {
              checkId: 'content-start-position',
              category: 'page-size',
              weight: 4,
              proportion: 0.5,
              pages: [
                { url: 'https://example.com/a', status: 'fail' },
                { url: 'https://example.com/b', status: 'skip' },
              ],
            },
          ],
        },
      },
    });
    const output = formatScorecard(makeReport(), score);
    expect(output).toContain('1 fail');
    expect(output).not.toContain('skip');
  });

  it('shows A+ grade with correct color', () => {
    const score = makeScoreResult({
      overall: 100,
      grade: 'A+',
      categoryScores: {
        'content-discoverability': { score: 100, grade: 'A+' },
      },
    });
    const output = formatScorecard(makeReport(), score);
    expect(output).toContain('(A+)');
  });

  it('handles invalid timestamp gracefully', () => {
    const report = makeReport({ timestamp: 'not-a-date' });
    const output = formatScorecard(report, makeScoreResult());
    expect(output).toContain('not-a-date');
  });

  it('renders N/A scorecard end-to-end from single-page discovery report', () => {
    const report = makeReport({
      results: [
        {
          id: 'llms-txt-exists',
          category: 'content-discoverability',
          status: 'fail',
          message: 'No llms.txt found',
        },
        {
          id: 'page-size-html',
          category: 'page-size',
          status: 'pass',
          message: '1 page tested, all pass',
        },
        {
          id: 'http-status-codes',
          category: 'url-stability',
          status: 'pass',
          message: '1 page tested',
        },
      ],
      summary: { total: 3, pass: 2, warn: 0, fail: 1, skip: 0, error: 0 },
      testedPages: 1,
      samplingStrategy: 'random',
    });
    // Let computeScore handle it (no pre-built scoreResult)
    const output = formatScorecard(report);
    // Page-level categories should show as N/A
    expect(output).toContain('(N/A)');
    // Should fire the single-page-sample diagnostic
    expect(output).toContain('Interaction Diagnostics');
    expect(output).toContain('Only 1 page was discovered');
  });
  describe('bot protection', () => {
    it('marks partial-sample checks and shows the network context', () => {
      const report = makeReport({
        results: [
          {
            id: 'page-size-html',
            category: 'page-size',
            status: 'pass',
            message: 'All 6 pages within limits',
          },
        ],
        networkContext: { classification: 'ci', indicator: 'GITHUB_ACTIONS' },
      });
      const score = makeScoreResult({
        checkScores: {
          'page-size-html': {
            baseWeight: 7,
            coefficient: 1,
            effectiveWeight: 7,
            proportion: 1,
            earnedScore: 7,
            maxScore: 7,
            scoreDisplayMode: 'numeric',
            partialSample: true,
          },
        },
        resolutions: {},
      });
      const output = formatScorecard(report, score);
      expect(output).toContain('Scanned from CI infrastructure');
      expect(output).toMatch(/page-size-html\s+All 6 pages within limits \(partial sample\)/);
    });
  });
});
