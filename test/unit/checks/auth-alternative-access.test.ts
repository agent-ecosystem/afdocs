import { describe, it, expect } from 'vitest';
import { createContext } from '../../../src/runner.js';
import { getCheck } from '../../../src/checks/registry.js';
import '../../../src/checks/index.js';
import type { CheckResult } from '../../../src/types.js';

describe('auth-alternative-access', () => {
  const check = getCheck('auth-alternative-access')!;

  function makeCtx(authGateResult?: CheckResult, otherResults?: Record<string, CheckResult>) {
    const ctx = createContext('http://test.local', { requestDelay: 0 });

    if (authGateResult) {
      ctx.previousResults.set('auth-gate-detection', authGateResult);
    }

    if (otherResults) {
      for (const [id, result] of Object.entries(otherResults)) {
        ctx.previousResults.set(id, result);
      }
    }

    return ctx;
  }

  function authGateResult(
    status: 'pass' | 'warn' | 'fail',
    details: Record<string, unknown>,
  ): CheckResult {
    return {
      id: 'auth-gate-detection',
      category: 'authentication',
      status,
      message: 'test',
      details,
    };
  }

  it('skips when auth-gate-detection did not run', async () => {
    const result = await check.run(makeCtx());
    expect(result.status).toBe('skip');
    expect(result.message).toContain('did not run');
  });

  it('skips when auth-gate-detection passed (all public)', async () => {
    const result = await check.run(
      makeCtx(
        authGateResult('pass', {
          accessible: 5,
          authRequired: 0,
          softAuthGate: 0,
          authRedirect: 0,
          testedPages: 5,
        }),
      ),
    );
    expect(result.status).toBe('skip');
    expect(result.message).toContain('publicly accessible');
  });

  it('skips when auth-gate-detection errored', async () => {
    const result = await check.run(
      makeCtx({
        id: 'auth-gate-detection',
        category: 'authentication',
        status: 'error',
        message: 'Check error: something went wrong',
      }),
    );
    expect(result.status).toBe('skip');
    expect(result.message).toContain('errored');
  });

  it('skips when auth-gate-detection failed due to fetch errors only', async () => {
    // Simulates the early-return path in auth-gate-detection where every page
    // failed to fetch (e.g. DNS NXDOMAIN). Details include fetchErrors but no
    // gated/accessible counts. We should not emit auth-no-alternative here.
    const result = await check.run(
      makeCtx(
        authGateResult('fail', {
          totalPages: 1,
          testedPages: 1,
          fetchErrors: 1,
          pageResults: [
            {
              url: 'https://example-domain-not-resolving.com',
              classification: 'accessible',
              status: null,
              error: 'fetch failed',
            },
          ],
        }),
      ),
    );
    expect(result.status).toBe('skip');
    expect(result.message).toContain('fetch errors');
  });

  it('skips when auth-gate-detection was skipped', async () => {
    const result = await check.run(
      makeCtx({
        id: 'auth-gate-detection',
        category: 'authentication',
        status: 'skip',
        message: 'Skipped: dependency check did not pass',
      }),
    );
    expect(result.status).toBe('skip');
    expect(result.message).toContain('was skipped');
  });

  it('fails when all pages gated and no alternative paths found', async () => {
    const result = await check.run(
      makeCtx(
        authGateResult('fail', {
          accessible: 0,
          authRequired: 3,
          softAuthGate: 0,
          authRedirect: 0,
          testedPages: 3,
        }),
      ),
    );
    expect(result.status).toBe('fail');
    expect(result.message).toContain('No alternative access paths');
    expect(result.details?.gatedPages).toBe(3);
    expect(result.details?.manualVerificationNeeded).toBeInstanceOf(Array);
  });

  it('warns when only llms.txt is available (partial access)', async () => {
    const result = await check.run(
      makeCtx(
        authGateResult('fail', {
          accessible: 0,
          authRequired: 5,
          softAuthGate: 0,
          authRedirect: 0,
          testedPages: 5,
        }),
        {
          'llms-txt-exists': {
            id: 'llms-txt-exists',
            category: 'content-discoverability',
            status: 'pass',
            message: 'Found',
          },
        },
      ),
    );
    expect(result.status).toBe('warn');
    expect(result.message).toContain('public-llms-txt');
    expect(result.message).toContain('Partial alternative access');
    const paths = result.details?.detectedPaths as Array<{ type: string }>;
    expect(paths.some((p) => p.type === 'public-llms-txt')).toBe(true);
  });

  it('passes when public markdown is available', async () => {
    const result = await check.run(
      makeCtx(
        authGateResult('warn', {
          accessible: 1,
          authRequired: 4,
          softAuthGate: 0,
          authRedirect: 0,
          testedPages: 5,
        }),
        {
          'markdown-url-support': {
            id: 'markdown-url-support',
            category: 'markdown-availability',
            status: 'pass',
            message: 'Markdown URLs supported',
          },
        },
      ),
    );
    expect(result.status).toBe('pass');
    expect(result.message).toContain('public-markdown');
    const paths = result.details?.detectedPaths as Array<{ type: string }>;
    expect(paths.some((p) => p.type === 'public-markdown')).toBe(true);
  });

  it('passes when content negotiation provides markdown', async () => {
    const result = await check.run(
      makeCtx(
        authGateResult('fail', {
          accessible: 0,
          authRequired: 3,
          softAuthGate: 0,
          authRedirect: 0,
          testedPages: 3,
        }),
        {
          'content-negotiation': {
            id: 'content-negotiation',
            category: 'markdown-availability',
            status: 'pass',
            message: 'Content negotiation supported',
          },
        },
      ),
    );
    expect(result.status).toBe('pass');
    const paths = result.details?.detectedPaths as Array<{ type: string }>;
    expect(paths.some((p) => p.type === 'public-markdown')).toBe(true);
  });

  it('passes when most pages are publicly accessible', async () => {
    const result = await check.run(
      makeCtx(
        authGateResult('warn', {
          accessible: 8,
          authRequired: 2,
          softAuthGate: 0,
          authRedirect: 0,
          testedPages: 10,
        }),
      ),
    );
    expect(result.status).toBe('pass');
    expect(result.message).toContain('partial-public-access');
    const paths = result.details?.detectedPaths as Array<{ type: string }>;
    expect(paths.some((p) => p.type === 'partial-public-access')).toBe(true);
  });

  it('detects multiple alternative paths', async () => {
    const result = await check.run(
      makeCtx(
        authGateResult('warn', {
          accessible: 3,
          authRequired: 7,
          softAuthGate: 0,
          authRedirect: 0,
          testedPages: 10,
        }),
        {
          'llms-txt-exists': {
            id: 'llms-txt-exists',
            category: 'content-discoverability',
            status: 'pass',
            message: 'Found',
          },
          'markdown-url-support': {
            id: 'markdown-url-support',
            category: 'markdown-availability',
            status: 'pass',
            message: 'Markdown URLs supported',
          },
        },
      ),
    );
    expect(result.status).toBe('pass');
    const paths = result.details?.detectedPaths as Array<{ type: string }>;
    expect(paths).toHaveLength(3); // llms-txt, markdown, partial-public-access
    expect(paths.some((p) => p.type === 'public-llms-txt')).toBe(true);
    expect(paths.some((p) => p.type === 'public-markdown')).toBe(true);
    expect(paths.some((p) => p.type === 'partial-public-access')).toBe(true);
  });

  it('counts all auth gate types toward gated pages', async () => {
    const result = await check.run(
      makeCtx(
        authGateResult('fail', {
          accessible: 0,
          authRequired: 2,
          softAuthGate: 1,
          authRedirect: 1,
          testedPages: 4,
        }),
      ),
    );
    expect(result.status).toBe('fail');
    expect(result.details?.gatedPages).toBe(4);
  });

  it('warns for llms-txt with low public page ratio', async () => {
    // llms.txt exists but only 1 of 10 pages is accessible (10% < 50%)
    const result = await check.run(
      makeCtx(
        authGateResult('warn', {
          accessible: 1,
          authRequired: 9,
          softAuthGate: 0,
          authRedirect: 0,
          testedPages: 10,
        }),
        {
          'llms-txt-exists': {
            id: 'llms-txt-exists',
            category: 'content-discoverability',
            status: 'pass',
            message: 'Found',
          },
        },
      ),
    );
    // llms.txt alone is just an index, and <50% accessible: warn
    expect(result.status).toBe('warn');
    const paths = result.details?.detectedPaths as Array<{ type: string }>;
    expect(paths.some((p) => p.type === 'public-llms-txt')).toBe(true);
    expect(paths.some((p) => p.type === 'partial-public-access')).toBe(true);
  });
});
