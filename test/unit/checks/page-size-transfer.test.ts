import { describe, it, expect, beforeAll } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { createContext } from '../../../src/runner.js';
import { getCheck } from '../../../src/checks/registry.js';
import '../../../src/checks/index.js';
import type { CheckContext, DiscoveredFile } from '../../../src/types.js';
import { mockSitemapNotFound } from '../../helpers/mock-sitemap-not-found.js';
import { ARCHITECTURE_SIGNATURE_RATIO } from '../../../src/checks/page-size/page-size-transfer.js';

const server = setupServer();

beforeAll(() => {
  server.listen({ onUnhandledRequest: 'bypass' });
  return () => server.close();
});

const check = getCheck('page-size-transfer')!;

const LLMS_TXT = `# Docs\n> Summary\n## Links\n- [Page 1](http://pst.local/docs/page1): First\n`;

function makeCtx(opts?: Record<string, unknown>, content: string | null = LLMS_TXT): CheckContext {
  const ctx = createContext('http://pst.local', { requestDelay: 0, ...opts });
  if (content) {
    const discovered: DiscoveredFile[] = [
      { url: 'http://pst.local/llms.txt', content, status: 200, redirected: false },
    ];
    ctx.previousResults.set('llms-txt-exists', {
      id: 'llms-txt-exists',
      category: 'content-discoverability',
      status: 'pass',
      message: 'Found',
      details: { discoveredFiles: discovered },
    });
    mockSitemapNotFound(server, 'http://pst.local');
  }
  return ctx;
}

function html(body: string, headers: Record<string, string> = {}) {
  return () =>
    new HttpResponse(body, {
      status: 200,
      headers: { 'Content-Type': 'text/html', ...headers },
    });
}

/** A page whose bytes are mostly an inline serialized payload, like a hydration blob. */
function payloadPage(payloadBytes: number): string {
  return (
    '<html><head><script id="__DATA__" type="application/json">' +
    JSON.stringify({ tree: 'x'.repeat(payloadBytes) }) +
    '</script></head><body><h1>Title</h1><p>Two short paragraphs of docs.</p></body></html>'
  );
}

interface PageResult {
  url: string;
  servedBytes: number;
  wireBytes?: number;
  contentEncoding?: string;
  contentCharacters: number;
  ratio?: number;
  status: string;
  error?: string;
}

describe('page-size-transfer', () => {
  it('registers as a Category 3 check with no dependencies', () => {
    expect(check.category).toBe('page-size');
    expect(check.dependsOn).toEqual([]);
  });

  it('passes a small page and reports served bytes against content size', async () => {
    server.use(http.get('http://pst.local/docs/page1', html(payloadPage(2_000))));

    const result = await check.run(makeCtx());
    expect(result.status).toBe('pass');
    expect(result.details?.passBucket).toBe(1);
    const [page] = result.details?.pageResults as PageResult[];
    expect(page.servedBytes).toBe(Buffer.byteLength(payloadPage(2_000)));
    expect(page.contentCharacters).toBeGreaterThan(0);
    expect(page.contentCharacters).toBeLessThan(page.servedBytes);
    expect(page.ratio).toBe(Math.round(page.servedBytes / page.contentCharacters));
    expect(result.message).toMatch(/All 1 pages serve under 1MB \(median .* served → .* content/);
  });

  it('measures bytes, not characters', async () => {
    // 1,000 copies of a 3-byte character: 1,000 chars but 3,000 bytes of body.
    const body = `<html><body><p>${'€'.repeat(1_000)}</p></body></html>`;
    server.use(http.get('http://pst.local/docs/page1', html(body)));

    const result = await check.run(makeCtx({ transferThresholds: { pass: 2_000, fail: 5_000 } }));
    const [page] = result.details?.pageResults as PageResult[];
    expect(page.servedBytes).toBe(Buffer.byteLength(body, 'utf8'));
    expect(page.servedBytes).toBeGreaterThan(body.length);
    expect(result.status).toBe('warn');
  });

  it('warns between the thresholds and names the largest page in the message', async () => {
    server.use(http.get('http://pst.local/docs/page1', html(payloadPage(20_000))));

    const result = await check.run(
      makeCtx({ transferThresholds: { pass: 10_000, fail: 100_000 } }),
    );
    expect(result.status).toBe('warn');
    expect(result.details?.warnBucket).toBe(1);
    expect(result.message).toContain('1 of 1 pages serve 10KB–100KB');
    expect(result.message).toMatch(/max 20KB served → \d+B content \(~\d+:1\)/);
  });

  it('fails above the fail threshold', async () => {
    server.use(http.get('http://pst.local/docs/page1', html(payloadPage(60_000))));

    const result = await check.run(makeCtx({ transferThresholds: { pass: 10_000, fail: 50_000 } }));
    expect(result.status).toBe('fail');
    expect(result.details?.failBucket).toBe(1);
    expect(result.message).toContain('1 of 1 pages serve over 50KB');
  });

  it('flags an oversized page with a high served-to-content ratio as an architecture signature', async () => {
    server.use(http.get('http://pst.local/docs/page1', html(payloadPage(20_000))));

    const result = await check.run(
      makeCtx({ transferThresholds: { pass: 10_000, fail: 100_000 } }),
    );
    const [page] = result.details?.pageResults as PageResult[];
    expect(page.ratio).toBeGreaterThanOrEqual(ARCHITECTURE_SIGNATURE_RATIO);
    expect(result.details?.architectureSignaturePages).toBe(1);
    expect(result.details?.maxRatio).toBe(page.ratio);
  });

  it('does not count a passing page toward the architecture signature', async () => {
    server.use(http.get('http://pst.local/docs/page1', html(payloadPage(20_000))));

    const result = await check.run(makeCtx());
    expect(result.status).toBe('pass');
    expect(result.details?.architectureSignaturePages).toBe(0);
  });

  it('counts a mostly-content page at a low ratio', async () => {
    const prose = '<p>' + 'Real documentation prose. '.repeat(400) + '</p>';
    server.use(http.get('http://pst.local/docs/page1', html(`<html><body>${prose}</body></html>`)));

    const result = await check.run(makeCtx({ transferThresholds: { pass: 1_000, fail: 100_000 } }));
    const [page] = result.details?.pageResults as PageResult[];
    expect(result.status).toBe('warn');
    expect(page.ratio).toBe(1);
    expect(result.details?.architectureSignaturePages).toBe(0);
  });

  it('reuses page-size-html conversion results for the same URL', async () => {
    server.use(http.get('http://pst.local/docs/page1', html(payloadPage(2_000))));

    const ctx = makeCtx();
    ctx.previousResults.set('page-size-html', {
      id: 'page-size-html',
      category: 'page-size',
      status: 'pass',
      message: '',
      details: {
        pageResults: [{ url: 'http://pst.local/docs/page1', convertedCharacters: 123 }],
      },
    });

    const result = await check.run(ctx);
    const [page] = result.details?.pageResults as PageResult[];
    expect(page.contentCharacters).toBe(123);
  });

  it('ignores page-size-html results that failed to fetch', async () => {
    server.use(http.get('http://pst.local/docs/page1', html(payloadPage(2_000))));

    const ctx = makeCtx();
    ctx.previousResults.set('page-size-html', {
      id: 'page-size-html',
      category: 'page-size',
      status: 'fail',
      message: '',
      details: {
        pageResults: [
          { url: 'http://pst.local/docs/page1', convertedCharacters: 0, error: 'boom' },
        ],
      },
    });

    const result = await check.run(ctx);
    const [page] = result.details?.pageResults as PageResult[];
    expect(page.contentCharacters).toBeGreaterThan(0);
  });

  it('shares the fetch with page-size-html through the page cache', async () => {
    let fetches = 0;
    server.use(
      http.get('http://pst.local/docs/page1', () => {
        fetches++;
        return html(payloadPage(2_000))();
      }),
    );

    const ctx = makeCtx();
    await getCheck('page-size-html')!.run(ctx);
    await check.run(ctx);
    expect(fetches).toBe(1);
  });

  it('measures a markdown response at roughly 1:1', async () => {
    const md = '# Guide\n\n' + 'Plain markdown body. '.repeat(50);
    server.use(
      http.get(
        'http://pst.local/docs/page1',
        () =>
          new HttpResponse(md, {
            status: 200,
            headers: { 'Content-Type': 'text/markdown; charset=utf-8' },
          }),
      ),
    );

    const result = await check.run(makeCtx());
    const [page] = result.details?.pageResults as PageResult[];
    expect(page.servedBytes).toBe(Buffer.byteLength(md));
    expect(page.contentCharacters).toBe(md.length);
    expect(page.ratio).toBe(1);
  });

  it('records the ratio as undefined when the page converts to nothing', async () => {
    server.use(http.get('http://pst.local/docs/page1', html('<html><body></body></html>')));

    const result = await check.run(makeCtx());
    const [page] = result.details?.pageResults as PageResult[];
    expect(page.contentCharacters).toBe(0);
    expect(page.ratio).toBeUndefined();
    expect(result.details?.maxRatio).toBeUndefined();
    expect(result.message).not.toContain(':1');
  });

  it('scores proportionally across pages with bucket counts', async () => {
    const links = [1, 2, 3]
      .map((i) => `- [Page ${i}](http://pst.local/docs/page${i}): P${i}`)
      .join('\n');
    server.use(
      http.get('http://pst.local/docs/page1', html(payloadPage(500))),
      http.get('http://pst.local/docs/page2', html(payloadPage(20_000))),
      http.get('http://pst.local/docs/page3', html(payloadPage(200_000))),
    );

    const result = await check.run(
      makeCtx(
        { transferThresholds: { pass: 10_000, fail: 100_000 } },
        `# Docs\n> Summary\n## Links\n${links}\n`,
      ),
    );
    expect(result.status).toBe('fail');
    expect(result.details?.passBucket).toBe(1);
    expect(result.details?.warnBucket).toBe(1);
    expect(result.details?.failBucket).toBe(1);
    expect(result.details?.max).toBe(Buffer.byteLength(payloadPage(200_000)));
    expect(result.message).toContain('1 of 3 pages serve over 100KB');
  });

  it('excludes fetch errors from the buckets and reports them in the message', async () => {
    server.use(
      http.get('http://pst.local/docs/page1', html(payloadPage(500))),
      http.get('http://pst.local/docs/page2', () => HttpResponse.error()),
    );
    const content = `# Docs\n> Summary\n## Links\n- [A](http://pst.local/docs/page1): A\n- [B](http://pst.local/docs/page2): B\n`;

    const result = await check.run(makeCtx(undefined, content));
    expect(result.status).toBe('pass');
    expect(result.details?.fetchErrors).toBe(1);
    expect(result.details?.passBucket).toBe(1);
    expect(result.message).toContain('1 failed to fetch');
  });

  it('fails when no page could be fetched', async () => {
    server.use(http.get('http://pst.local/docs/page1', () => HttpResponse.error()));

    const result = await check.run(makeCtx());
    expect(result.status).toBe('fail');
    expect(result.message).toContain('Could not fetch any pages');
  });

  it('uses the default 1MB/10MB thresholds', async () => {
    server.use(http.get('http://pst.local/docs/page1', html(payloadPage(500))));

    const result = await check.run(makeCtx());
    expect(result.details?.thresholds).toEqual({ pass: 1_000_000, fail: 10_000_000 });
  });
});
