import { registerCheck } from '../registry.js';
import { discoverAndSamplePages } from '../../helpers/get-page-urls.js';
import { htmlToMarkdown } from '../../helpers/html-to-markdown.js';
import { fetchPage } from '../../helpers/fetch-page.js';
import { detectBulkData, describeBulkElement } from '../../helpers/detect-bulk-data.js';
import {
  DEFAULT_BULK_BLOB_CHARS,
  DEFAULT_BULK_DOMINANT_SHARE,
  DEFAULT_BULK_TABLE_ROWS,
} from '../../constants.js';
import type { CheckContext, CheckResult, CheckStatus } from '../../types.js';
import type { BulkElement, BulkThresholds } from '../../helpers/detect-bulk-data.js';

/** Elements listed per page in the details; the rest are counted. */
const MAX_ELEMENTS_LISTED = 10;

export interface BulkPageResult {
  url: string;
  status: CheckStatus;
  /** Whether the content measured was converted HTML or a markdown response. */
  source: 'html' | 'markdown';
  /** `page-size-html`'s bucket for this page, which decides the verdict. */
  sizeBucket: CheckStatus;
  /** Where the bucket came from: the size check's own result, or the same thresholds re-applied. */
  sizeBucketSource: 'page-size-html' | 'recomputed';
  convertedCharacters: number;
  bulkCharacters: number;
  /** Bulk share of the converted content, percent. */
  bulkShare: number;
  /** True when the bulk share reaches the dominant-share threshold. */
  dominant: boolean;
  /** Percent of the non-bulk content that precedes the first bulk element. */
  proseBeforeBulkPercent: number;
  /** The largest bulk element, when any. */
  dominantElement?: BulkElement;
  /** Up to MAX_ELEMENTS_LISTED bulk elements, largest first. */
  elements: BulkElement[];
  elementCount: number;
  error?: string;
}

/** Tallies the resolution text reads so it can name what the data was. */
export interface BulkReasons {
  /** Warn/fail pages whose largest element is a table. */
  table: number;
  /** Warn/fail pages whose largest element is a JSON blob. */
  json: number;
  /** Warn/fail pages whose largest element is a base64 run. */
  base64: number;
  /** Warn/fail pages where most of the prose comes after the data. */
  proseAfterBulk: number;
}

function sizeStatus(chars: number, pass: number, fail: number): CheckStatus {
  if (chars <= pass) return 'pass';
  if (chars <= fail) return 'warn';
  return 'fail';
}

function worstStatus(statuses: CheckStatus[]): CheckStatus {
  if (statuses.includes('fail')) return 'fail';
  if (statuses.includes('warn')) return 'warn';
  return 'pass';
}

function formatSize(chars: number): string {
  if (chars >= 1000) return `${Math.round(chars / 1000)}K`;
  return String(chars);
}

export function bulkThresholds(ctx: CheckContext): BulkThresholds {
  return {
    tableRows: ctx.options.bulkTableRows ?? DEFAULT_BULK_TABLE_ROWS,
    blobChars: ctx.options.bulkBlobChars ?? DEFAULT_BULK_BLOB_CHARS,
    dominantShare: ctx.options.bulkDominantShare ?? DEFAULT_BULK_DOMINANT_SHARE,
  };
}

/**
 * The size bucket `page-size-html` assigned to this page, so the two checks
 * never disagree about the same content. Falls back to the same thresholds
 * when the size check did not run (a `--checks` subset) or did not measure
 * this URL.
 */
function sizeBucketFor(
  ctx: CheckContext,
  url: string,
  convertedChars: number,
): { bucket: CheckStatus; source: BulkPageResult['sizeBucketSource'] } {
  const pageResults = ctx.previousResults.get('page-size-html')?.details?.pageResults as
    | Array<{ url: string; status: CheckStatus; error?: string }>
    | undefined;
  const match = pageResults?.find((r) => r.url === url && !r.error);
  if (match) return { bucket: match.status, source: 'page-size-html' };
  const { pass, fail } = ctx.options.thresholds;
  return { bucket: sizeStatus(convertedChars, pass, fail), source: 'recomputed' };
}

/**
 * Verdict per the spec: pass when nothing bulky was found or the page is
 * under the size checks' pass threshold regardless; warn or fail only when
 * bulk is the dominant contributor to a page in the corresponding size band.
 * Bulk on an oversized page that is not the dominant contributor passes
 * here (the size check already carries that page) but is still attributed.
 */
function verdict(bucket: CheckStatus, hasBulk: boolean, dominant: boolean): CheckStatus {
  if (!hasBulk || bucket === 'pass') return 'pass';
  if (!dominant) return 'pass';
  return bucket;
}

async function analyzePage(
  ctx: CheckContext,
  url: string,
  thresholds: BulkThresholds,
): Promise<BulkPageResult> {
  const page = await fetchPage(ctx, url);
  const converted = page.isHtml ? htmlToMarkdown(page.body) : page.body;
  const detection = detectBulkData(converted, thresholds);
  const { bucket, source } = sizeBucketFor(ctx, url, converted.length);
  const bySize = [...detection.elements].sort((a, b) => b.chars - a.chars);

  return {
    url,
    status: verdict(bucket, detection.elements.length > 0, detection.dominant),
    source: page.isHtml ? 'html' : 'markdown',
    sizeBucket: bucket,
    sizeBucketSource: source,
    convertedCharacters: converted.length,
    bulkCharacters: detection.bulkChars,
    bulkShare: detection.bulkShare,
    dominant: detection.dominant,
    proseBeforeBulkPercent: detection.proseBeforeBulkPercent,
    ...(bySize.length > 0 && { dominantElement: bySize[0] }),
    elements: bySize.slice(0, MAX_ELEMENTS_LISTED),
    elementCount: detection.elements.length,
  };
}

function describeWorst(page: BulkPageResult): string {
  const el = page.dominantElement;
  if (!el) return `${page.bulkShare}% bulk data`;
  return `${describeBulkElement(el)} at ${el.share}% of ${formatSize(page.convertedCharacters)} chars`;
}

async function check(ctx: CheckContext): Promise<CheckResult> {
  const id = 'embedded-data-serialization';
  const category = 'content-structure';
  const thresholds = bulkThresholds(ctx);
  const { pass: passThreshold, fail: failThreshold } = ctx.options.thresholds;

  const {
    urls: pageUrls,
    totalPages,
    sampled: wasSampled,
    warnings,
  } = await discoverAndSamplePages(ctx);

  const results: BulkPageResult[] = [];
  const concurrency = ctx.options.maxConcurrency;

  for (let i = 0; i < pageUrls.length; i += concurrency) {
    const batch = pageUrls.slice(i, i + concurrency);
    const batchResults = await Promise.all(
      batch.map(async (url): Promise<BulkPageResult> => {
        try {
          return await analyzePage(ctx, url, thresholds);
        } catch (err) {
          return {
            url,
            status: 'fail',
            source: 'html',
            sizeBucket: 'fail',
            sizeBucketSource: 'recomputed',
            convertedCharacters: 0,
            bulkCharacters: 0,
            bulkShare: 0,
            dominant: false,
            proseBeforeBulkPercent: 0,
            elements: [],
            elementCount: 0,
            error: err instanceof Error ? err.message : String(err),
          };
        }
      }),
    );
    results.push(...batchResults);
  }

  const successful = results.filter((r) => !r.error);
  const fetchErrors = results.filter((r) => r.error).length;
  const rateLimited = results.filter((r) => r.error && r.error.includes('429')).length;
  const detailThresholds = { ...thresholds, size: { pass: passThreshold, fail: failThreshold } };

  if (successful.length === 0) {
    const suffix = fetchErrors > 0 ? `; ${fetchErrors} failed to fetch` : '';
    return {
      id,
      category,
      status: 'fail',
      message: `Could not fetch any pages to analyze${suffix}`,
      details: {
        totalPages,
        testedPages: results.length,
        sampled: wasSampled,
        fetchErrors,
        rateLimited,
        thresholds: detailThresholds,
        pageResults: results,
        discoveryWarnings: warnings,
      },
    };
  }

  const pagesWithBulk = successful.filter((r) => r.elementCount > 0);
  const passBucket = successful.filter((r) => r.status === 'pass').length;
  const warnBucket = successful.filter((r) => r.status === 'warn').length;
  const failBucket = successful.filter((r) => r.status === 'fail').length;
  const overallStatus = worstStatus(successful.map((r) => r.status));
  const pageLabel = wasSampled ? 'sampled pages' : 'pages';

  const flagged = successful.filter((r) => r.status !== 'pass');
  const reasons: BulkReasons = { table: 0, json: 0, base64: 0, proseAfterBulk: 0 };
  for (const page of flagged) {
    if (page.dominantElement) reasons[page.dominantElement.kind]++;
    if (page.proseBeforeBulkPercent < 50) reasons.proseAfterBulk++;
  }
  const sizeBucketSource = successful.every((r) => r.sizeBucketSource === 'page-size-html')
    ? 'page-size-html'
    : 'recomputed';

  const suffix =
    (fetchErrors > 0 ? `; ${fetchErrors} failed to fetch` : '') +
    (rateLimited > 0 ? `; ${rateLimited} rate-limited (HTTP 429)` : '');

  let message: string;
  if (pagesWithBulk.length === 0) {
    message = `No bulk data elements detected across ${successful.length} ${pageLabel}${suffix}`;
  } else if (overallStatus === 'pass') {
    message = `Bulk data on ${pagesWithBulk.length} of ${successful.length} ${pageLabel}, but no page is oversized because of it${suffix}`;
  } else {
    const worst = flagged.reduce((a, b) => (b.convertedCharacters > a.convertedCharacters ? b : a));
    const band =
      overallStatus === 'warn'
        ? `convert to ${formatSize(passThreshold)}–${formatSize(failThreshold)} chars`
        : `convert to over ${formatSize(failThreshold)} chars`;
    const count = overallStatus === 'warn' ? warnBucket : failBucket;
    message = `${count} of ${successful.length} ${pageLabel} ${band} mainly because of embedded data (worst: ${describeWorst(worst)})${suffix}`;
  }

  return {
    id,
    category,
    status: overallStatus,
    message,
    details: {
      totalPages,
      testedPages: results.length,
      sampled: wasSampled,
      pagesWithBulk: pagesWithBulk.length,
      passBucket,
      warnBucket,
      failBucket,
      fetchErrors,
      rateLimited,
      reasons,
      sizeBucketSource,
      thresholds: detailThresholds,
      pageResults: results,
      discoveryWarnings: warnings,
    },
  };
}

registerCheck({
  id: 'embedded-data-serialization',
  category: 'content-structure',
  description:
    'Whether machine-generated bulk data (large tables, data blobs) dominates oversized pages',
  dependsOn: [],
  run: check,
});
