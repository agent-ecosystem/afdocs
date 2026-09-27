import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { createContext } from '../../../src/runner.js';
import { getCheck } from '../../../src/checks/registry.js';
import '../../../src/checks/index.js';
import type { CheckContext, DiscoveredFile } from '../../../src/types.js';
import type { BulkPageResult } from '../../../src/checks/content-structure/embedded-data-serialization.js';
import { mockSitemapNotFound } from '../../helpers/mock-sitemap-not-found.js';

const server = setupServer();

beforeAll(() => {
  server.listen({ onUnhandledRequest: 'bypass' });
  return () => server.close();
});

afterEach(() => server.resetHandlers());

const check = getCheck('embedded-data-serialization')!;
const ORIGIN = 'http://eds.local';

function makeCtx(urls: string[], opts: Record<string, unknown> = {}): CheckContext {
  const ctx = createContext(ORIGIN, { requestDelay: 0, ...opts });
  const content =
    `# Docs\n> Summary\n## Links\n` + urls.map((u, i) => `- [Page ${i}](${u}): p${i}`).join('\n');
  const discovered: DiscoveredFile[] = [
    { url: `${ORIGIN}/llms.txt`, content, status: 200, redirected: false },
  ];
  ctx.previousResults.set('llms-txt-exists', {
    id: 'llms-txt-exists',
    category: 'content-discoverability',
    status: 'pass',
    message: 'Found',
    details: { discoveredFiles: discovered },
  });
  mockSitemapNotFound(server, ORIGIN);
  return ctx;
}

function html(body: string) {
  return () =>
    new HttpResponse(`<html><body><main>${body}</main></body></html>`, {
      status: 200,
      headers: { 'Content-Type': 'text/html' },
    });
}

function markdown(body: string) {
  return () =>
    new HttpResponse(body, { status: 200, headers: { 'Content-Type': 'text/markdown' } });
}

/** An HTML table with `rows` uniform data rows of `cellChars` characters per cell. */
function table(rows: number, cellChars = 40, cols = 3): string {
  const cell = 'c'.repeat(cellChars);
  const head = `<thead><tr>${Array.from({ length: cols }, (_, i) => `<th>H${i}</th>`).join('')}</tr></thead>`;
  const body = Array.from(
    { length: rows },
    (_, r) => `<tr>${Array.from({ length: cols }, () => `<td>${cell}-${r}</td>`).join('')}</tr>`,
  ).join('');
  return `<table>${head}<tbody>${body}</tbody></table>`;
}

function prose(chars: number): string {
  const sentence = 'Prose that explains the table below in ordinary words. ';
  return `<p>${sentence.repeat(Math.ceil(chars / sentence.length)).slice(0, chars)}</p>`;
}

function pages(result: Awaited<ReturnType<typeof check.run>>): BulkPageResult[] {
  return result.details?.pageResults as BulkPageResult[];
}

describe('embedded-data-serialization', () => {
  it('passes with no bulk elements', async () => {
    server.use(http.get(`${ORIGIN}/docs/a`, html(`<h1>A</h1>${prose(2000)}`)));
    const result = await check.run(makeCtx([`${ORIGIN}/docs/a`]));
    expect(result.status).toBe('pass');
    expect(result.message).toContain('No bulk data elements');
    expect(result.details?.pagesWithBulk).toBe(0);
    expect(pages(result)[0].elementCount).toBe(0);
    expect(pages(result)[0].proseBeforeBulkPercent).toBe(100);
  });

  it('passes when bulk is present but the page is under the size pass threshold', async () => {
    server.use(http.get(`${ORIGIN}/docs/a`, html(`<h1>A</h1>${prose(500)}${table(60)}`)));
    const result = await check.run(makeCtx([`${ORIGIN}/docs/a`]));
    expect(result.status).toBe('pass');
    expect(result.message).toContain('no page is oversized because of it');
    const p = pages(result)[0];
    expect(p.sizeBucket).toBe('pass');
    expect(p.elementCount).toBe(1);
    expect(p.dominant).toBe(true);
    expect(p.dominantElement?.kind).toBe('table');
    expect(p.dominantElement?.rows).toBe(60);
  });

  it('warns when bulk dominates a page in the size warn band', async () => {
    // 5K of prose before a ~75K table: warn band, table is the dominant contributor.
    server.use(http.get(`${ORIGIN}/docs/a`, html(`<h1>A</h1>${prose(5000)}${table(500, 45)}`)));
    const result = await check.run(makeCtx([`${ORIGIN}/docs/a`]));
    expect(result.status).toBe('warn');
    expect(result.message).toMatch(
      /1 of 1 pages convert to 50K–100K chars mainly because of embedded data \(worst: 500-row table at \d+% of \d+K chars\)/,
    );
    const p = pages(result)[0];
    expect(p.sizeBucket).toBe('warn');
    expect(p.sizeBucketSource).toBe('recomputed');
    expect(p.bulkShare).toBeGreaterThan(80);
    expect(p.proseBeforeBulkPercent).toBe(100);
    expect(result.details?.warnBucket).toBe(1);
    expect(result.details?.reasons).toEqual({ table: 1, json: 0, base64: 0, proseAfterBulk: 0 });
  });

  it('fails when bulk dominates a page over the size fail threshold', async () => {
    server.use(http.get(`${ORIGIN}/docs/a`, html(`<h1>A</h1>${table(900, 45)}${prose(5000)}`)));
    const result = await check.run(makeCtx([`${ORIGIN}/docs/a`]));
    expect(result.status).toBe('fail');
    expect(result.message).toContain('convert to over 100K chars mainly because of embedded data');
    const p = pages(result)[0];
    expect(p.sizeBucket).toBe('fail');
    // The prose sits after the table, which the spec's fix text asks authors to invert.
    expect(p.proseBeforeBulkPercent).toBeLessThan(5);
    expect(result.details?.reasons).toMatchObject({ table: 1, proseAfterBulk: 1 });
  });

  it('passes an oversized page whose bulk is not the dominant contributor', async () => {
    // 70K of prose and a ~5K table: warn band, but the table explains little of it.
    server.use(http.get(`${ORIGIN}/docs/a`, html(`<h1>A</h1>${prose(70_000)}${table(30, 45)}`)));
    const result = await check.run(makeCtx([`${ORIGIN}/docs/a`]));
    expect(result.status).toBe('pass');
    const p = pages(result)[0];
    expect(p.sizeBucket).toBe('warn');
    expect(p.dominant).toBe(false);
    expect(p.elementCount).toBe(1);
    expect(result.message).toContain('Bulk data on 1 of 1 pages');
  });

  it('reads the size bucket from page-size-html when it ran', async () => {
    server.use(http.get(`${ORIGIN}/docs/a`, html(`<h1>A</h1>${table(60)}`)));
    const ctx = makeCtx([`${ORIGIN}/docs/a`]);
    // Under different thresholds the size check put this small page in the fail band.
    ctx.previousResults.set('page-size-html', {
      id: 'page-size-html',
      category: 'page-size',
      status: 'fail',
      message: '',
      details: {
        pageResults: [{ url: `${ORIGIN}/docs/a`, status: 'fail', convertedCharacters: 9000 }],
      },
    });
    const result = await check.run(ctx);
    expect(result.status).toBe('fail');
    const p = pages(result)[0];
    expect(p.sizeBucket).toBe('fail');
    expect(p.sizeBucketSource).toBe('page-size-html');
    expect(result.details?.sizeBucketSource).toBe('page-size-html');
  });

  it('recomputes with the configured size thresholds when page-size-html did not run', async () => {
    server.use(http.get(`${ORIGIN}/docs/a`, html(`<h1>A</h1>${table(60)}`)));
    const result = await check.run(
      makeCtx([`${ORIGIN}/docs/a`], { thresholds: { pass: 1000, fail: 5000 } }),
    );
    expect(result.status).toBe('fail');
    expect(pages(result)[0].sizeBucketSource).toBe('recomputed');
    expect(result.details?.thresholds).toMatchObject({ size: { pass: 1000, fail: 5000 } });
  });

  it('honours the bulk thresholds from options', async () => {
    server.use(http.get(`${ORIGIN}/docs/a`, html(`<h1>A</h1>${prose(5000)}${table(15, 45)}`)));
    const strict = await check.run(
      makeCtx([`${ORIGIN}/docs/a`], {
        thresholds: { pass: 1000, fail: 100_000 },
        bulkTableRows: 10,
        bulkDominantShare: 20,
      }),
    );
    expect(strict.status).toBe('warn');
    expect(strict.details?.thresholds).toMatchObject({
      tableRows: 10,
      blobChars: 2000,
      dominantShare: 20,
    });

    const lax = await check.run(
      makeCtx([`${ORIGIN}/docs/a`], {
        thresholds: { pass: 1000, fail: 100_000 },
        bulkTableRows: 16,
      }),
    );
    expect(lax.status).toBe('pass');
    expect(pages(lax)[0].elementCount).toBe(0);
  });

  it('attributes JSON blobs and reports the largest element first', async () => {
    const blob = JSON.stringify(
      Array.from({ length: 450 }, (_, i) => ({ id: i, name: `model-${i}`, tags: ['a', 'b'] })),
      null,
      2,
    );
    server.use(
      http.get(
        `${ORIGIN}/docs/a`,
        html(`<h1>A</h1>${prose(3000)}${table(25)}<pre><code>${blob}</code></pre>`),
      ),
    );
    const result = await check.run(makeCtx([`${ORIGIN}/docs/a`]));
    expect(result.status).toBe('warn');
    const p = pages(result)[0];
    expect(p.elementCount).toBe(2);
    expect(p.elements[0].kind).toBe('json');
    expect(p.elements[0].form).toBe('indented');
    expect(p.elements[1].kind).toBe('table');
    expect(p.dominantElement?.kind).toBe('json');
    expect(result.details?.reasons).toMatchObject({ json: 1, table: 0 });
    expect(result.message).toMatch(/worst: \d+K-char JSON blob/);
  });

  it('measures markdown responses without conversion', async () => {
    const rows = Array.from({ length: 1200 }, (_, i) => `| row-${i} | ${'v'.repeat(50)} | x |`);
    const md = `# Catalog\n\nShort intro.\n\n| A | B | C |\n| --- | --- | --- |\n${rows.join('\n')}\n`;
    server.use(http.get(`${ORIGIN}/docs/a`, markdown(md)));
    const result = await check.run(makeCtx([`${ORIGIN}/docs/a`]));
    expect(result.status).toBe('warn');
    const p = pages(result)[0];
    expect(p.source).toBe('markdown');
    expect(p.convertedCharacters).toBe(md.length);
    expect(p.dominantElement?.rows).toBe(1200);
  });

  it('scores pages proportionally and reports the worst page', async () => {
    server.use(
      http.get(`${ORIGIN}/docs/a`, html(`<h1>A</h1>${prose(2000)}`)),
      http.get(`${ORIGIN}/docs/b`, html(`<h1>B</h1>${prose(5000)}${table(500, 45)}`)),
      http.get(`${ORIGIN}/docs/c`, html(`<h1>C</h1>${prose(5000)}${table(900, 45)}`)),
    );
    const result = await check.run(
      makeCtx([`${ORIGIN}/docs/a`, `${ORIGIN}/docs/b`, `${ORIGIN}/docs/c`]),
    );
    expect(result.status).toBe('fail');
    expect(result.details?.passBucket).toBe(1);
    expect(result.details?.warnBucket).toBe(1);
    expect(result.details?.failBucket).toBe(1);
    expect(result.details?.pagesWithBulk).toBe(2);
    expect(result.message).toContain('1 of 3 pages convert to over 100K chars');
    expect(result.message).toContain('900-row table');
  });

  it('handles fetch errors gracefully', async () => {
    server.use(
      http.get(`${ORIGIN}/docs/a`, () => HttpResponse.error()),
      http.get(`${ORIGIN}/docs/b`, html(`<h1>B</h1>${prose(500)}`)),
    );
    const result = await check.run(makeCtx([`${ORIGIN}/docs/a`, `${ORIGIN}/docs/b`]));
    expect(result.status).toBe('pass');
    expect(result.details?.fetchErrors).toBe(1);
    expect(result.message).toContain('1 failed to fetch');
  });

  it('fails when no page could be fetched', async () => {
    server.use(http.get(`${ORIGIN}/docs/a`, () => HttpResponse.error()));
    const result = await check.run(makeCtx([`${ORIGIN}/docs/a`]));
    expect(result.status).toBe('fail');
    expect(result.message).toContain('Could not fetch any pages');
  });

  it('caps the elements listed per page but counts them all', async () => {
    const tables = Array.from({ length: 12 }, () => table(25, 30)).join('<p>between</p>');
    server.use(http.get(`${ORIGIN}/docs/a`, html(`<h1>A</h1>${tables}`)));
    const result = await check.run(makeCtx([`${ORIGIN}/docs/a`]));
    const p = pages(result)[0];
    expect(p.elementCount).toBe(12);
    expect(p.elements).toHaveLength(10);
  });
});
