import { registerCheck } from '../registry.js';
import { discoverAndSamplePages } from '../../helpers/get-page-urls.js';
import { htmlToMarkdown } from '../../helpers/html-to-markdown.js';
import { fetchPage } from '../../helpers/fetch-page.js';
import type { CheckContext, CheckResult, CheckStatus } from '../../types.js';
import { t } from '../../i18n/index.js';

interface PageSizeResult {
  url: string;
  htmlCharacters: number;
  convertedCharacters: number;
  conversionRatio: number;
  status: CheckStatus;
  error?: string;
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

async function check(ctx: CheckContext): Promise<CheckResult> {
  const id = 'page-size-html';
  const category = 'page-size';
  const { pass: passThreshold, fail: failThreshold } = ctx.options.thresholds;

  const {
    urls: pageUrls,
    totalPages,
    sampled: wasSampled,
    warnings,
  } = await discoverAndSamplePages(ctx);

  const results: PageSizeResult[] = [];
  const concurrency = ctx.options.maxConcurrency;

  for (let i = 0; i < pageUrls.length; i += concurrency) {
    const batch = pageUrls.slice(i, i + concurrency);
    const batchResults = await Promise.all(
      batch.map(async (url): Promise<PageSizeResult> => {
        try {
          const page = await fetchPage(ctx, url);

          // Skip conversion if the response is already markdown
          const html = page.isHtml ? page.body : '';
          const htmlChars = html.length;
          const converted = page.isHtml ? htmlToMarkdown(page.body) : page.body;
          const convertedChars = converted.length;
          const ratio = htmlChars > 0 ? Math.round((1 - convertedChars / htmlChars) * 100) : 0;

          return {
            url,
            htmlCharacters: htmlChars,
            convertedCharacters: convertedChars,
            conversionRatio: ratio,
            status: sizeStatus(convertedChars, passThreshold, failThreshold),
          };
        } catch (err) {
          return {
            url,
            htmlCharacters: 0,
            convertedCharacters: 0,
            conversionRatio: 0,
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
    const suffix = fetchErrors > 0 ? t('common.fetch_errors_suffix', { count: fetchErrors }) : '';
    return {
      id,
      category,
      status: 'fail',
      message: t('check.page-size-html.error_none', { suffix }),
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

  const convertedSizes = successful.map((r) => r.convertedCharacters).sort((a, b) => a - b);
  const median = convertedSizes[Math.floor(convertedSizes.length / 2)];
  const max = convertedSizes[convertedSizes.length - 1];
  const htmlSizes = successful.map((r) => r.htmlCharacters).sort((a, b) => a - b);
  const medianHtml = htmlSizes[Math.floor(htmlSizes.length / 2)];
  const maxHtml = htmlSizes[htmlSizes.length - 1];
  const avgRatio = Math.round(
    successful.reduce((sum, r) => sum + r.conversionRatio, 0) / successful.length,
  );

  const overallStatus = worstStatus(successful.map((r) => r.status));
  const pageLabel = wasSampled ? t('common.sampled_pages') : t('common.pages');

  const passBucket = successful.filter((r) => r.status === 'pass').length;
  const warnBucket = successful.filter((r) => r.status === 'warn').length;
  const failBucket = successful.filter((r) => r.status === 'fail').length;

  const suffix =
    (fetchErrors > 0 ? t('common.fetch_errors_suffix', { count: fetchErrors }) : '') +
    (rateLimited > 0 ? t('common.rate_limited_suffix', { count: rateLimited }) : '');

  let message: string;
  if (overallStatus === 'pass') {
    message = t('check.page-size-html.pass', {
      total: successful.length,
      pageLabel,
      pass: formatSize(passThreshold),
      medianHtml: formatSize(medianHtml),
      medianMd: formatSize(median),
      avgRatio,
      suffix,
    });
  } else if (overallStatus === 'warn') {
    message = t('check.page-size-html.warn', {
      warn: warnBucket,
      total: successful.length,
      pageLabel,
      pass: formatSize(passThreshold),
      fail: formatSize(failThreshold),
      maxHtml: formatSize(maxHtml),
      maxMd: formatSize(max),
      avgRatio,
      suffix,
    });
  } else {
    message = t('check.page-size-html.fail', {
      failCount: failBucket,
      total: successful.length,
      pageLabel,
      fail: formatSize(failThreshold),
      maxHtml: formatSize(maxHtml),
      maxMd: formatSize(max),
      avgRatio,
      suffix,
    });
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
      median,
      max,
      avgBoilerplatePercent: avgRatio,
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
  id: 'page-size-html',
  category: 'page-size',
  description: 'Character count of HTML response and post-conversion size',
  dependsOn: [],
  run: check,
});
