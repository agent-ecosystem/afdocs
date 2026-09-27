import { registerCheck } from '../registry.js';
import { discoverAndSamplePages } from '../../helpers/get-page-urls.js';
import { htmlToMarkdown } from '../../helpers/html-to-markdown.js';
import { fetchPage } from '../../helpers/fetch-page.js';
import { describeTransfer, formatBytes } from '../../helpers/format-bytes.js';
import type { CheckContext, CheckResult, CheckStatus } from '../../types.js';

/**
 * Served-to-content ratio at or above which a warn/fail page is reported as
 * an architecture signature (hydration payloads, embedded duplicate content)
 * rather than a content problem. Ordinary boilerplate-heavy HTML converts at
 * roughly 5:1 to 15:1; the serialized-payload pages that motivated the spec
 * check measured 40:1 to 200:1.
 */
export const ARCHITECTURE_SIGNATURE_RATIO = 20;

export interface TransferPageResult {
  url: string;
  /** Decoded response body size in bytes: what the agent's HTTP client hands over. */
  servedBytes: number;
  /** Compressed size from Content-Length, when the response was encoded. */
  wireBytes?: number;
  contentEncoding?: string;
  /** Post-conversion content size in characters (the page-size-html measurement). */
  contentCharacters: number;
  /** servedBytes / contentCharacters, rounded; undefined when there is no content. */
  ratio?: number;
  status: CheckStatus;
  error?: string;
}

function sizeStatus(bytes: number, pass: number, fail: number): CheckStatus {
  // Strictly under: the documented pass band is "under" the threshold.
  if (bytes < pass) return 'pass';
  if (bytes <= fail) return 'warn';
  return 'fail';
}

function worstStatus(statuses: CheckStatus[]): CheckStatus {
  if (statuses.includes('fail')) return 'fail';
  if (statuses.includes('warn')) return 'warn';
  return 'pass';
}

function median(sorted: number[]): number {
  return sorted[Math.floor(sorted.length / 2)];
}

/**
 * Post-conversion sizes already computed by page-size-html for this run, so
 * the ratio is taken from the same response without converting twice.
 */
function priorContentSizes(ctx: CheckContext): Map<string, number> {
  const sizes = new Map<string, number>();
  const prior = ctx.previousResults.get('page-size-html');
  const pages = prior?.details?.pageResults as
    | Array<{ url: string; convertedCharacters?: number; error?: string }>
    | undefined;
  for (const p of pages ?? []) {
    if (!p.error && typeof p.convertedCharacters === 'number') {
      sizes.set(p.url, p.convertedCharacters);
    }
  }
  return sizes;
}

async function check(ctx: CheckContext): Promise<CheckResult> {
  const id = 'page-size-transfer';
  const category = 'page-size';
  const { pass: passThreshold, fail: failThreshold } = ctx.options.transferThresholds;

  const {
    urls: pageUrls,
    totalPages,
    sampled: wasSampled,
    warnings,
  } = await discoverAndSamplePages(ctx);

  const knownContentSizes = priorContentSizes(ctx);
  const results: TransferPageResult[] = [];
  const concurrency = ctx.options.maxConcurrency;

  for (let i = 0; i < pageUrls.length; i += concurrency) {
    const batch = pageUrls.slice(i, i + concurrency);
    const batchResults = await Promise.all(
      batch.map(async (url): Promise<TransferPageResult> => {
        try {
          // Shared with page-size-html through ctx.htmlCache: one response
          // feeds both the served-bytes and the post-conversion measurement.
          const page = await fetchPage(ctx, url);
          const contentCharacters =
            knownContentSizes.get(url) ??
            (page.isHtml ? htmlToMarkdown(page.body) : page.body).length;
          const ratio =
            contentCharacters > 0 ? Math.round(page.bytes / contentCharacters) : undefined;

          return {
            url,
            servedBytes: page.bytes,
            ...(page.wireBytes !== undefined && { wireBytes: page.wireBytes }),
            ...(page.contentEncoding && { contentEncoding: page.contentEncoding }),
            contentCharacters,
            ...(ratio !== undefined && { ratio }),
            status: sizeStatus(page.bytes, passThreshold, failThreshold),
          };
        } catch (err) {
          return {
            url,
            servedBytes: 0,
            contentCharacters: 0,
            status: 'fail',
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

  if (successful.length === 0) {
    const suffix = fetchErrors > 0 ? `; ${fetchErrors} failed to fetch` : '';
    return {
      id,
      category,
      status: 'fail',
      message: `Could not fetch any pages to measure${suffix}`,
      details: {
        totalPages,
        testedPages: results.length,
        sampled: wasSampled,
        fetchErrors,
        rateLimited,
        pageResults: results,
        discoveryWarnings: warnings,
      },
    };
  }

  const servedSizes = successful.map((r) => r.servedBytes).sort((a, b) => a - b);
  const medianServed = median(servedSizes);
  const maxServed = servedSizes[servedSizes.length - 1];
  const largest = successful.reduce((a, b) => (b.servedBytes > a.servedBytes ? b : a));
  const medianPage = successful.slice().sort((a, b) => a.servedBytes - b.servedBytes)[
    Math.floor(successful.length / 2)
  ];
  const ratios = successful.map((r) => r.ratio).filter((r): r is number => r !== undefined);
  const maxRatio = ratios.length > 0 ? Math.max(...ratios) : undefined;

  const overallStatus = worstStatus(successful.map((r) => r.status));
  const pageLabel = wasSampled ? 'sampled pages' : 'pages';

  const passBucket = successful.filter((r) => r.status === 'pass').length;
  const warnBucket = successful.filter((r) => r.status === 'warn').length;
  const failBucket = successful.filter((r) => r.status === 'fail').length;

  // Oversized pages whose bytes are mostly non-content. The fix for these
  // lives in framework configuration (hydration payloads, duplicate embedded
  // source), not in the documentation itself. Their own maximum ratio is
  // reported separately from `maxRatio`: a small passing page can carry the
  // highest ratio on the site, and the fix text must not attribute it to
  // the oversized pages.
  const architectureSignatures = successful.filter(
    (r) => r.status !== 'pass' && (r.ratio ?? 0) >= ARCHITECTURE_SIGNATURE_RATIO,
  );
  const architectureSignaturePages = architectureSignatures.length;
  const architectureSignatureMaxRatio =
    architectureSignatures.length > 0
      ? Math.max(...architectureSignatures.map((r) => r.ratio ?? 0))
      : undefined;

  const suffix =
    (fetchErrors > 0 ? `; ${fetchErrors} failed to fetch` : '') +
    (rateLimited > 0 ? `; ${rateLimited} rate-limited (HTTP 429)` : '');

  let message: string;
  if (overallStatus === 'pass') {
    const typical = describeTransfer(
      medianPage.servedBytes,
      medianPage.contentCharacters,
      medianPage.ratio,
    );
    message = `All ${successful.length} ${pageLabel} serve under ${formatBytes(passThreshold)} (median ${typical})${suffix}`;
  } else if (overallStatus === 'warn') {
    const worst = describeTransfer(largest.servedBytes, largest.contentCharacters, largest.ratio);
    message = `${warnBucket} of ${successful.length} ${pageLabel} serve ${formatBytes(passThreshold)}–${formatBytes(failThreshold)} (max ${worst})${suffix}`;
  } else {
    const worst = describeTransfer(largest.servedBytes, largest.contentCharacters, largest.ratio);
    message = `${failBucket} of ${successful.length} ${pageLabel} serve over ${formatBytes(failThreshold)} (max ${worst})${suffix}`;
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
      median: medianServed,
      max: maxServed,
      ...(maxRatio !== undefined && { maxRatio }),
      architectureSignaturePages,
      ...(architectureSignatureMaxRatio !== undefined && { architectureSignatureMaxRatio }),
      passBucket,
      warnBucket,
      failBucket,
      fetchErrors,
      rateLimited,
      thresholds: { pass: passThreshold, fail: failThreshold },
      pageResults: results,
      discoveryWarnings: warnings,
    },
  };
}

registerCheck({
  id: 'page-size-transfer',
  category: 'page-size',
  description: 'Served byte size of the HTML document after transfer decoding',
  dependsOn: [],
  run: check,
});
