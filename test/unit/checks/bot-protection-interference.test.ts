import { describe, it, expect, beforeAll } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { createContext, runChecks } from '../../../src/runner.js';
import { getCheck, getChecksSorted } from '../../../src/checks/registry.js';
import '../../../src/checks/index.js';
import type { CheckContext, DiscoveredFile, FetchRecord } from '../../../src/types.js';
import { mockSitemapNotFound } from '../../helpers/mock-sitemap-not-found.js';

const server = setupServer();

beforeAll(() => {
  server.listen({ onUnhandledRequest: 'bypass' });
  return () => server.close();
});

type Kind = 'ok' | 'stall' | 'challenge' | 'error' | '429';

/** Build a ledger from a compact list of request kinds, in order. */
function seed(ctx: CheckContext, kinds: Kind[]): void {
  kinds.forEach((kind, i) => {
    const rec: FetchRecord = {
      seq: i + 1,
      url: `http://test.local/p${i + 1}`,
      status: 200,
      outcome: 'ok',
    };
    if (kind === 'stall') {
      rec.outcome = 'stalled-body';
      rec.error = 'Body read timed out after 15000ms (response stalled; ...)';
    } else if (kind === 'challenge') {
      rec.challenge = 'Cloudflare challenge';
    } else if (kind === 'error') {
      rec.status = null;
      rec.outcome = 'fetch-error';
      rec.error = 'fetch failed';
    } else if (kind === '429') {
      rec.status = 429;
    }
    ctx.fetchLedger!.onRecord(rec);
  });
}

function fill(n: number, kind: Kind = 'ok'): Kind[] {
  return Array.from({ length: n }, () => kind);
}

describe('bot-protection-interference', () => {
  const check = getCheck('bot-protection-interference')!;

  function makeCtx(): CheckContext {
    const ctx = createContext('http://test.local', { requestDelay: 0 });
    ctx.networkContext = { classification: 'developer-machine' };
    return ctx;
  }

  it("is registered last so it sees every other check's traffic", () => {
    const sorted = getChecksSorted();
    expect(sorted[sorted.length - 1].id).toBe('bot-protection-interference');
    expect(check.dependsOn).toEqual([]);
  });

  it('passes on a clean sustained scan', async () => {
    const ctx = makeCtx();
    seed(ctx, fill(20));
    const result = await check.run(ctx);
    expect(result.status).toBe('pass');
    expect(result.message).toBe('No bot-protection interference observed across 20 requests');
    expect(result.details?.requests).toBe(20);
    expect(result.details?.standaloneScan).toBe(false);
  });

  it('passes when scattered fetch errors are not volume-correlated', async () => {
    const ctx = makeCtx();
    const kinds = fill(20);
    kinds[2] = 'error';
    kinds[10] = 'error';
    seed(ctx, kinds);
    const result = await check.run(ctx);
    expect(result.status).toBe('pass');
    expect(result.message).toContain('2 failed to fetch (not volume-correlated)');
    expect(result.details?.fetchErrors).toBe(2);
    expect(result.details?.volumeCorrelated).toBe(false);
  });

  it('does not treat honored 429 responses as interference', async () => {
    const ctx = makeCtx();
    const kinds = fill(20);
    for (const i of [3, 7, 11, 12, 15, 16, 18, 19]) kinds[i] = '429';
    seed(ctx, kinds);
    const result = await check.run(ctx);
    expect(result.status).toBe('pass');
    expect(result.details?.failedRequests).toBe(0);
  });

  it('warns on intermittent stalls', async () => {
    const ctx = makeCtx();
    const kinds = fill(20);
    kinds[5] = 'stall';
    kinds[12] = 'stall';
    seed(ctx, kinds);
    const result = await check.run(ctx);
    expect(result.status).toBe('warn');
    expect(result.message).toContain('Intermittent interference: 2 of 20 requests');
    expect(result.message).toContain('2 stalled bodies');
    expect(result.message).toContain('scanned from a developer machine');
    expect(result.details?.stalledBodies).toBe(2);
    expect(result.details?.onsetRequest).toBe(6);
    expect(result.details?.samples).toMatchObject({
      stalled: ['http://test.local/p6', 'http://test.local/p13'],
    });
  });

  it('fails when most requests after onset are challenged or stalled', async () => {
    const ctx = makeCtx();
    const kinds: Kind[] = [
      ...fill(8),
      'stall',
      'challenge',
      'stall',
      'ok',
      'challenge',
      'stall',
      'stall',
      'ok',
      'challenge',
      'stall',
      'stall',
      'challenge',
    ];
    seed(ctx, kinds);
    const result = await check.run(ctx);
    expect(result.status).toBe('fail');
    expect(result.message).toContain('Sustained interference: after request #9');
    expect(result.message).toContain('10 of 12 requests (83%)');
    expect(result.details?.challengePages).toBe(4);
    expect(result.details?.challengePagesServedAs200).toBe(4);
    expect(result.details?.postOnsetFailureRate).toBe(83);
  });

  it('warns when failures climb late in the scan even without a definitive signature', async () => {
    const ctx = makeCtx();
    const kinds = fill(30);
    kinds[21] = 'error';
    kinds[25] = 'error';
    kinds[29] = 'error';
    seed(ctx, kinds);
    const result = await check.run(ctx);
    expect(result.status).toBe('warn');
    expect(result.message).toContain('Failures climbed as the scan progressed');
    expect(result.message).toContain('0 of 10 early requests failed vs 3 of 10 late requests');
    expect(result.details?.volumeCorrelated).toBe(true);
    expect(result.details?.onsetRequest).toBe(22);
  });

  it('fails on a silent block: connection errors dominate after onset', async () => {
    const ctx = makeCtx();
    const kinds: Kind[] = [
      ...fill(22),
      'error',
      'ok',
      'error',
      'error',
      'ok',
      'error',
      'error',
      'error',
    ];
    seed(ctx, kinds);
    const result = await check.run(ctx);
    expect(result.status).toBe('fail');
    expect(result.details?.stalledBodies).toBe(0);
    expect(result.details?.challengePages).toBe(0);
  });

  it('records the network context in details', async () => {
    const ctx = makeCtx();
    ctx.networkContext = { classification: 'ci', indicator: 'GITHUB_ACTIONS' };
    seed(ctx, [...fill(10), 'stall', 'ok', 'ok']);
    const result = await check.run(ctx);
    expect(result.details?.networkContext).toEqual({
      classification: 'ci',
      indicator: 'GITHUB_ACTIONS',
    });
    expect(result.message).toContain('scanned from CI infrastructure');
  });

  it('skips when the context has no fetch ledger', async () => {
    const ctx = makeCtx();
    delete ctx.fetchLedger;
    const result = await check.run(ctx);
    expect(result.status).toBe('skip');
  });

  describe('standalone mode', () => {
    function mockSite(pages: number) {
      const links = Array.from(
        { length: pages },
        (_, i) => `- [Page ${i + 1}](http://test.local/docs/page${i + 1}): Page ${i + 1}`,
      ).join('\n');
      const llmsTxt = `# Docs\n\n> Test docs\n\n## Pages\n${links}\n`;

      server.use(
        http.get('http://test.local/llms.txt', () => new HttpResponse(llmsTxt, { status: 200 })),
        http.get(
          'http://test.local/docs/*',
          () =>
            new HttpResponse(
              '<html><body><main><h1>Docs</h1><p>Content here.</p></main></body></html>',
              {
                status: 200,
                headers: { 'Content-Type': 'text/html' },
              },
            ),
        ),
      );
      mockSitemapNotFound(server, 'http://test.local');
      return llmsTxt;
    }

    it('performs one baseline pass when it runs alone', async () => {
      const llmsTxt = mockSite(6);
      const ctx = makeCtx();
      const discovered: DiscoveredFile[] = [
        { url: 'http://test.local/llms.txt', content: llmsTxt, status: 200, redirected: false },
      ];
      ctx.previousResults.set('llms-txt-exists', {
        id: 'llms-txt-exists',
        category: 'content-discoverability',
        status: 'pass',
        message: 'Found',
        details: { discoveredFiles: discovered },
      });

      const result = await check.run(ctx);
      expect(result.status).toBe('pass');
      expect(result.details?.standaloneScan).toBe(true);
      expect(result.details?.requests as number).toBeGreaterThanOrEqual(6);
    });

    it('produces a report with a request summary via runChecks --checks', async () => {
      mockSite(6);
      const report = await runChecks('http://test.local', {
        requestDelay: 0,
        checkIds: ['bot-protection-interference'],
      });
      expect(report.results).toHaveLength(1);
      expect(report.results[0].status).toBe('pass');
      expect(report.requestSummary).toBeDefined();
      expect(report.requestSummary!.requests).toBeGreaterThan(0);
      expect(report.requestSummary!.failed).toBe(0);
      expect(report.networkContext).toBeDefined();
    });
  });
});
