import { describe, it, expect } from 'vitest';
import { validateRunnerOptions } from '../../src/validation.js';
import type { RunnerOptions } from '../../src/types.js';

// Ensure all checks are registered for check ID validation
import '../../src/checks/index.js';

describe('validateRunnerOptions', () => {
  it('returns valid for empty options', () => {
    const result = validateRunnerOptions({});
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
  });

  it('returns valid for well-formed options', () => {
    const result = validateRunnerOptions({
      maxConcurrency: 5,
      requestDelay: 100,
      maxLinksToTest: 25,
      samplingStrategy: 'random',
      thresholds: { pass: 50_000, fail: 100_000 },
      coveragePassThreshold: 95,
      coverageWarnThreshold: 80,
      parityPassThreshold: 5,
      parityWarnThreshold: 20,
    });
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('collects multiple errors in a single call', () => {
    const result = validateRunnerOptions({
      maxConcurrency: -1,
      requestDelay: -1,
      samplingStrategy: 'invalid' as RunnerOptions['samplingStrategy'],
    });
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThanOrEqual(3);
  });

  describe('NaN checking', () => {
    const nanFields: [string, Partial<RunnerOptions>][] = [
      ['maxConcurrency', { maxConcurrency: NaN }],
      ['requestDelay', { requestDelay: NaN }],
      ['requestTimeout', { requestTimeout: NaN }],
      ['maxLinksToTest', { maxLinksToTest: NaN }],
      ['coveragePassThreshold', { coveragePassThreshold: NaN }],
      ['coverageWarnThreshold', { coverageWarnThreshold: NaN }],
      ['parityPassThreshold', { parityPassThreshold: NaN }],
      ['parityWarnThreshold', { parityWarnThreshold: NaN }],
    ];

    for (const [field, opts] of nanFields) {
      it(`rejects NaN ${field}`, () => {
        const result = validateRunnerOptions(opts);
        expect(result.valid).toBe(false);
        expect(result.errors.some((e) => e.field === field)).toBe(true);
      });
    }

    it('rejects NaN thresholds.pass', () => {
      const result = validateRunnerOptions({ thresholds: { pass: NaN, fail: 100_000 } });
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.field === 'thresholds.pass')).toBe(true);
    });

    it('rejects NaN thresholds.fail', () => {
      const result = validateRunnerOptions({ thresholds: { pass: 50_000, fail: NaN } });
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.field === 'thresholds.fail')).toBe(true);
    });
  });

  describe('numeric range: maxConcurrency', () => {
    it('rejects 0', () => {
      const result = validateRunnerOptions({ maxConcurrency: 0 });
      expect(result.valid).toBe(false);
      expect(result.errors[0].field).toBe('maxConcurrency');
    });

    it('rejects negative values', () => {
      const result = validateRunnerOptions({ maxConcurrency: -5 });
      expect(result.valid).toBe(false);
    });

    it('accepts 1', () => {
      expect(validateRunnerOptions({ maxConcurrency: 1 }).valid).toBe(true);
    });

    it('accepts 100', () => {
      expect(validateRunnerOptions({ maxConcurrency: 100 }).valid).toBe(true);
    });

    it('rejects 101', () => {
      const result = validateRunnerOptions({ maxConcurrency: 101 });
      expect(result.valid).toBe(false);
      expect(result.errors[0].message).toContain('between 1 and 100');
    });

    it('rejects non-integer', () => {
      const result = validateRunnerOptions({ maxConcurrency: 3.5 });
      expect(result.valid).toBe(false);
      expect(result.errors[0].message).toContain('integer');
    });
  });

  describe('numeric range: requestDelay', () => {
    it('accepts 0', () => {
      expect(validateRunnerOptions({ requestDelay: 0 }).valid).toBe(true);
    });

    it('rejects negative values', () => {
      const result = validateRunnerOptions({ requestDelay: -1 });
      expect(result.valid).toBe(false);
      expect(result.errors[0].field).toBe('requestDelay');
    });
  });

  describe('numeric range: maxLinksToTest', () => {
    it('rejects 0', () => {
      const result = validateRunnerOptions({ maxLinksToTest: 0 });
      expect(result.valid).toBe(false);
    });

    it('accepts 1', () => {
      expect(validateRunnerOptions({ maxLinksToTest: 1 }).valid).toBe(true);
    });
  });

  describe('numeric range: size thresholds', () => {
    it('rejects thresholds.pass < 1', () => {
      const result = validateRunnerOptions({ thresholds: { pass: 0, fail: 100_000 } });
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.field === 'thresholds.pass')).toBe(true);
    });

    it('rejects thresholds.fail < 1', () => {
      const result = validateRunnerOptions({ thresholds: { pass: 50_000, fail: 0 } });
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.field === 'thresholds.fail')).toBe(true);
    });
  });

  describe('numeric range: coverage thresholds', () => {
    it('rejects coveragePassThreshold > 100', () => {
      const result = validateRunnerOptions({ coveragePassThreshold: 101 });
      expect(result.valid).toBe(false);
    });

    it('rejects coveragePassThreshold < 0', () => {
      const result = validateRunnerOptions({ coveragePassThreshold: -1 });
      expect(result.valid).toBe(false);
    });

    it('accepts boundary values 0 and 100', () => {
      expect(validateRunnerOptions({ coveragePassThreshold: 0 }).valid).toBe(true);
      expect(validateRunnerOptions({ coveragePassThreshold: 100 }).valid).toBe(true);
    });
  });

  describe('numeric range: parity thresholds', () => {
    it('rejects parityPassThreshold > 100', () => {
      const result = validateRunnerOptions({ parityPassThreshold: 101 });
      expect(result.valid).toBe(false);
    });

    it('rejects parityWarnThreshold < 0', () => {
      const result = validateRunnerOptions({ parityWarnThreshold: -1 });
      expect(result.valid).toBe(false);
    });
  });

  describe('threshold ordering: size', () => {
    it('errors when pass > fail', () => {
      const result = validateRunnerOptions({ thresholds: { pass: 200_000, fail: 100_000 } });
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.field === 'thresholds')).toBe(true);
    });

    it('accepts pass === fail', () => {
      expect(validateRunnerOptions({ thresholds: { pass: 50_000, fail: 50_000 } }).valid).toBe(
        true,
      );
    });

    it('accepts pass < fail', () => {
      expect(validateRunnerOptions({ thresholds: { pass: 50_000, fail: 100_000 } }).valid).toBe(
        true,
      );
    });
  });

  describe('threshold ordering: coverage', () => {
    it('errors when pass < warn', () => {
      const result = validateRunnerOptions({
        coveragePassThreshold: 50,
        coverageWarnThreshold: 80,
      });
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.field === 'coveragePassThreshold')).toBe(true);
      expect(result.errors[0].message).toContain('greater than or equal to');
    });

    it('accepts pass > warn', () => {
      expect(
        validateRunnerOptions({ coveragePassThreshold: 95, coverageWarnThreshold: 80 }).valid,
      ).toBe(true);
    });

    it('accepts pass === warn', () => {
      expect(
        validateRunnerOptions({ coveragePassThreshold: 80, coverageWarnThreshold: 80 }).valid,
      ).toBe(true);
    });

    it('skips ordering check when only pass provided', () => {
      expect(validateRunnerOptions({ coveragePassThreshold: 50 }).valid).toBe(true);
    });

    it('skips ordering check when only warn provided', () => {
      expect(validateRunnerOptions({ coverageWarnThreshold: 80 }).valid).toBe(true);
    });
  });

  describe('threshold ordering: parity', () => {
    it('errors when pass > warn', () => {
      const result = validateRunnerOptions({
        parityPassThreshold: 30,
        parityWarnThreshold: 10,
      });
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.field === 'parityPassThreshold')).toBe(true);
      expect(result.errors[0].message).toContain('less than or equal to');
    });

    it('accepts pass < warn', () => {
      expect(validateRunnerOptions({ parityPassThreshold: 5, parityWarnThreshold: 20 }).valid).toBe(
        true,
      );
    });

    it('accepts pass === warn', () => {
      expect(
        validateRunnerOptions({ parityPassThreshold: 10, parityWarnThreshold: 10 }).valid,
      ).toBe(true);
    });

    it('skips ordering check when only pass provided', () => {
      expect(validateRunnerOptions({ parityPassThreshold: 30 }).valid).toBe(true);
    });
  });

  describe('enum: samplingStrategy', () => {
    it('rejects invalid strategy', () => {
      const result = validateRunnerOptions({
        samplingStrategy: 'invalid' as RunnerOptions['samplingStrategy'],
      });
      expect(result.valid).toBe(false);
      expect(result.errors[0].field).toBe('samplingStrategy');
      expect(result.errors[0].message).toContain('random');
    });

    for (const strategy of ['random', 'deterministic', 'curated', 'none'] as const) {
      it(`accepts "${strategy}"`, () => {
        const opts: Partial<RunnerOptions> =
          strategy === 'curated'
            ? { samplingStrategy: strategy, curatedPages: ['https://example.com/a'] }
            : { samplingStrategy: strategy };
        expect(validateRunnerOptions(opts).valid).toBe(true);
      });
    }
  });

  describe('enum: urlPathPattern', () => {
    it('rejects invalid pattern', () => {
      const result = validateRunnerOptions({
        urlPathPattern: 'dotphp' as RunnerOptions['urlPathPattern'],
      });
      expect(result.valid).toBe(false);
      expect(result.errors[0].field).toBe('urlPathPattern');
      expect(result.errors[0].message).toContain('clean');
    });

    for (const pattern of ['clean', 'html', 'md'] as const) {
      it(`accepts "${pattern}"`, () => {
        expect(validateRunnerOptions({ urlPathPattern: pattern }).valid).toBe(true);
      });
    }
  });

  describe('constraint: curated requires pages', () => {
    it('errors for curated with no curatedPages', () => {
      const result = validateRunnerOptions({ samplingStrategy: 'curated' });
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.message.includes('curatedPages'))).toBe(true);
    });

    it('errors for curated with empty curatedPages', () => {
      const result = validateRunnerOptions({ samplingStrategy: 'curated', curatedPages: [] });
      expect(result.valid).toBe(false);
    });

    it('accepts curated with curatedPages', () => {
      const result = validateRunnerOptions({
        samplingStrategy: 'curated',
        curatedPages: ['https://example.com/a'],
      });
      expect(result.valid).toBe(true);
    });
  });

  describe('URL validation', () => {
    it('errors for invalid canonicalOrigin', () => {
      const result = validateRunnerOptions({ canonicalOrigin: 'not a url' });
      expect(result.valid).toBe(false);
      expect(result.errors[0].field).toBe('canonicalOrigin');
    });

    it('accepts valid canonicalOrigin', () => {
      expect(validateRunnerOptions({ canonicalOrigin: 'https://example.com' }).valid).toBe(true);
    });

    it('errors for invalid llmsTxtUrl', () => {
      const result = validateRunnerOptions({ llmsTxtUrl: 'not a url' });
      expect(result.valid).toBe(false);
      expect(result.errors[0].field).toBe('llmsTxtUrl');
    });

    it('accepts valid llmsTxtUrl', () => {
      expect(validateRunnerOptions({ llmsTxtUrl: 'https://example.com/llms.txt' }).valid).toBe(
        true,
      );
    });

    it('skips validation when undefined', () => {
      expect(validateRunnerOptions({ canonicalOrigin: undefined }).valid).toBe(true);
    });
  });

  describe('check IDs', () => {
    it('errors for unknown checkIds', () => {
      const result = validateRunnerOptions({ checkIds: ['llms-txt-exists', 'nonexistent-check'] });
      expect(result.valid).toBe(false);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].field).toBe('checkIds');
      expect(result.errors[0].message).toContain('nonexistent-check');
    });

    it('errors for unknown skipCheckIds', () => {
      const result = validateRunnerOptions({ skipCheckIds: ['nonexistent-check'] });
      expect(result.valid).toBe(false);
      expect(result.errors[0].field).toBe('skipCheckIds');
    });

    it('accepts valid checkIds', () => {
      const result = validateRunnerOptions({ checkIds: ['llms-txt-exists'] });
      expect(result.valid).toBe(true);
    });

    it('accepts empty checkIds', () => {
      const result = validateRunnerOptions({ checkIds: [] });
      expect(result.valid).toBe(true);
    });
  });
});
