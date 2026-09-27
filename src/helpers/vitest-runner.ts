import { describe, it, expect, beforeAll } from 'vitest';
import { runChecks } from '../runner.js';
import { loadConfig } from './config.js';
import { getChecksSorted } from '../checks/registry.js';
import type { AgentDocsConfig, CheckResult, ReportResult } from '../types.js';

// Ensure all checks are registered
import '../checks/index.js';

const DEFAULT_TEST_TIMEOUT = 120_000;

const STATUS_ICON: Record<string, string> = {
  pass: '\u2713',
  warn: '\u26A0',
  fail: '\u2717',
  skip: '\u2192',
  error: '!',
};

function resolveConfig(
  configOrDir: AgentDocsConfig | string | undefined,
): Promise<AgentDocsConfig> {
  if (typeof configOrDir === 'object') return Promise.resolve(configOrDir);
  return loadConfig(typeof configOrDir === 'string' ? configOrDir : undefined);
}

/**
 * Auto-generates vitest tests from an agent-docs config file.
 * Produces a single pass/fail test with a summary of all check results.
 *
 * Usage:
 * ```ts
 * import { describeAgentDocs } from 'afdocs/helpers';
 * describeAgentDocs();
 * ```
 */
export function describeAgentDocs(
  configOrDir?: AgentDocsConfig | string,
  testTimeout?: number,
): void {
  const timeout = testTimeout ?? DEFAULT_TEST_TIMEOUT;

  describe('Agent-Friendly Documentation', () => {
    let results: CheckResult[];

    it(
      'should run checks',
      async () => {
        const config = await resolveConfig(configOrDir);

        const inferredStrategy =
          config.pages && config.pages.length > 0 && !config.options?.samplingStrategy
            ? 'curated'
            : undefined;
        const report = await runChecks(config.url, {
          checkIds: config.checks,
          skipCheckIds: config.skipChecks,
          ...config.options,
          ...(inferredStrategy && { samplingStrategy: inferredStrategy as 'curated' }),
          curatedPages: config.pages,
        });
        results = report.results;
      },
      timeout,
    );

    it('should have no failing checks', () => {
      expect(results).toBeDefined();
      const failures = results.filter((r) => r.status === 'fail');
      if (failures.length > 0) {
        const messages = failures.map((f) => `${f.id}: ${f.message}`).join('\n');
        expect.fail(`${failures.length} check(s) failed:\n${messages}`);
      }
    });
  });
}

/**
 * Auto-generates individual vitest tests per check from an agent-docs config.
 * Each check appears as its own test line in CI output, giving clear visibility
 * into which checks passed, warned, failed, or were skipped.
 *
 * Usage:
 * ```ts
 * import { describeAgentDocsPerCheck } from 'afdocs/helpers';
 * describeAgentDocsPerCheck();
 * ```
 */
export function describeAgentDocsPerCheck(
  configOrDir?: AgentDocsConfig | string,
  testTimeout?: number,
): void {
  const timeout = testTimeout ?? DEFAULT_TEST_TIMEOUT;

  describe('Agent-Friendly Documentation', () => {
    let report: ReportResult;
    let resultsByCheck: Map<string, CheckResult>;

    // Run all checks once upfront
    beforeAll(async () => {
      const config = await resolveConfig(configOrDir);
      const inferredStrategy =
        config.pages && config.pages.length > 0 && !config.options?.samplingStrategy
          ? 'curated'
          : undefined;
      report = await runChecks(config.url, {
        checkIds: config.checks,
        skipCheckIds: config.skipChecks,
        ...config.options,
        ...(inferredStrategy && { samplingStrategy: inferredStrategy as 'curated' }),
        curatedPages: config.pages,
      });
      resultsByCheck = new Map(report.results.map((r) => [r.id, r]));
    }, timeout);

    // Register a test per known check. Checks not included in the run
    // (filtered via config.checks) are reported as skipped rather than
    // silently passing, so CI output accurately reflects what was tested.
    const allChecks = getChecksSorted();

    for (const check of allChecks) {
      it(check.id, (ctx) => {
        const result = resultsByCheck?.get(check.id);
        if (!result) {
          // Check was filtered out by config
          ctx.skip();
          return;
        }

        const icon = STATUS_ICON[result.status] ?? '?';
        console.log(`${icon} [${result.status}] ${result.message}`);

        if (result.status === 'fail') {
          expect.fail(`${result.message}`);
        }
        if (result.status === 'error') {
          expect.fail(`Check error: ${result.message}`);
        }
      });
    }
  });
}
