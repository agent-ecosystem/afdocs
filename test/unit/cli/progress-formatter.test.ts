import { describe, it, expect } from 'vitest';
import { formatProgressEvent } from '../../../src/cli/formatters/progress.js';
import type { CheckResult } from '../../../src/types.js';

function result(overrides: Partial<CheckResult> = {}): CheckResult {
  return {
    id: 'llms-txt-directive-html',
    category: 'content-discoverability',
    status: 'pass',
    message: 'ok',
    ...overrides,
  };
}

describe('formatProgressEvent', () => {
  it('formats a start event as a numbered partial line', () => {
    const line = formatProgressEvent({
      phase: 'start',
      checkId: 'llms-txt-directive-html',
      index: 7,
      total: 24,
    });
    expect(line).toBe('[7/24] llms-txt-directive-html... ');
  });

  it('formats a completion with tested pages, fetch errors, and duration', () => {
    const line = formatProgressEvent({
      phase: 'complete',
      checkId: 'llms-txt-directive-html',
      index: 7,
      total: 24,
      result: result({ details: { testedPages: 47, fetchErrors: 3 } }),
      durationMs: 12000,
    });
    expect(line).toBe('done (47 tested, 3 fetch errors, 12s)\n');
  });

  it('omits tested and fetch-error parts when the check reports neither', () => {
    const line = formatProgressEvent({
      phase: 'complete',
      checkId: 'llms-txt-exists',
      index: 1,
      total: 24,
      result: result(),
      durationMs: 200,
    });
    expect(line).toBe('done (200ms)\n');
  });

  it('omits the fetch-error part when the count is zero', () => {
    const line = formatProgressEvent({
      phase: 'complete',
      checkId: 'http-status-codes',
      index: 2,
      total: 24,
      result: result({ details: { testedPages: 10, fetchErrors: 0 } }),
      durationMs: 3000,
    });
    expect(line).toBe('done (10 tested, 3s)\n');
  });

  it('uses the singular form for one fetch error', () => {
    const line = formatProgressEvent({
      phase: 'complete',
      checkId: 'http-status-codes',
      index: 2,
      total: 24,
      result: result({ details: { fetchErrors: 1 } }),
      durationMs: 3000,
    });
    expect(line).toBe('done (1 fetch error, 3s)\n');
  });

  it('formats a skipped check as skipped without timing detail', () => {
    const line = formatProgressEvent({
      phase: 'complete',
      checkId: 'llms-txt-valid',
      index: 3,
      total: 24,
      result: result({ status: 'skip' }),
      durationMs: 0,
    });
    expect(line).toBe('skipped\n');
  });

  it('formats durations of a minute or more as minutes and seconds', () => {
    const line = formatProgressEvent({
      phase: 'complete',
      checkId: 'markdown-url-support',
      index: 9,
      total: 24,
      result: result(),
      durationMs: 90_000,
    });
    expect(line).toBe('done (1m 30s)\n');
  });
});
