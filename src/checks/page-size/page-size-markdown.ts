import { registerCheck } from '../registry.js';
import { getMarkdownContent } from '../../helpers/get-markdown-content.js';
import type { CheckContext, CheckResult, CheckStatus } from '../../types.js';
import { t } from '../../i18n/index.js';

interface PageSizeResult {
  url: string;
  mdUrl: string;
  characters: number;
  status: CheckStatus;
  source: string;
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
  const id = 'page-size-markdown';
  const category = 'page-size';
  const { pass: passThreshold, fail: failThreshold } = ctx.options.thresholds;

  const mdResult = await getMarkdownContent(ctx);

  if (mdResult.mode === 'cached' && !mdResult.depPassed) {
    return {
      id,
      category,
      status: 'skip',
      message: t('check.page-size-markdown.skip_no_md'),
    };
  }

  if (mdResult.pages.length === 0) {
    const hint =
      mdResult.mode === 'standalone'
        ? 'No markdown content found; skipping size check'
        : 'No cached markdown pages available to measure';
    return { id, category, status: 'skip', message: hint };
  }

  // Build mdUrl map from markdown-url-support results for richer reporting
  const mdUrlMap = new Map<string, string>();
  const mdUrlResult = ctx.previousResults.get('markdown-url-support');
  const mdUrlPages = (mdUrlResult?.details as Record<string, unknown>)?.pageResults as
    | Array<{ url: string; mdUrl: string; supported: boolean }>
    | undefined;
  if (mdUrlPages) {
    for (const p of mdUrlPages) {
      if (p.supported) mdUrlMap.set(p.url, p.mdUrl);
    }
  }

  const pageResults: PageSizeResult[] = mdResult.pages
    .filter((p) => p.source !== 'llms-txt') // llms.txt files aren't doc pages to size-check
    .map((page) => {
      const chars = page.content.length;
      const mdUrl = mdUrlMap.get(page.url) ?? page.url;
      return {
        url: page.url,
        mdUrl,
        characters: chars,
        status: sizeStatus(chars, passThreshold, failThreshold),
        source: page.source,
      };
    });

  if (pageResults.length === 0) {
    return { id, category, status: 'skip', message: t('check.page-size-markdown.skip_none') };
  }

  const sizes = pageResults.map((r) => r.characters).sort((a, b) => a - b);
  const median = sizes[Math.floor(sizes.length / 2)];
  const max = sizes[sizes.length - 1];

  const passBucket = pageResults.filter((r) => r.status === 'pass').length;
  const warnBucket = pageResults.filter((r) => r.status === 'warn').length;
  const failBucket = pageResults.filter((r) => r.status === 'fail').length;

  const overallStatus = worstStatus(pageResults.map((r) => r.status));
  const sampled = mdResult.mode === 'standalone'; // standalone always samples via discoverAndSamplePages
  const pageLabel = sampled ? t('common.sampled_pages') : t('common.pages');

  let message: string;
  if (overallStatus === 'pass') {
    message = t('check.page-size-markdown.pass', {
      total: pageResults.length,
      pageLabel,
      pass: formatSize(passThreshold),
      median: formatSize(median),
      max: formatSize(max),
    });
  } else if (overallStatus === 'warn') {
    message = t('check.page-size-markdown.warn', {
      warn: warnBucket,
      total: pageResults.length,
      pageLabel,
      pass: formatSize(passThreshold),
      fail: formatSize(failThreshold),
      max: formatSize(max),
    });
  } else {
    message = t('check.page-size-markdown.fail', {
      failCount: failBucket,
      total: pageResults.length,
      pageLabel,
      fail: formatSize(failThreshold),
      max: formatSize(max),
    });
  }

  return {
    id,
    category,
    status: overallStatus,
    message,
    details: {
      totalPages: pageResults.length,
      testedPages: pageResults.length,
      sampled,
      median,
      max,
      passBucket,
      warnBucket,
      failBucket,
      thresholds: { pass: passThreshold, fail: failThreshold },
      pageResults,
    },
  };
}

registerCheck({
  id: 'page-size-markdown',
  category: 'page-size',
  description: 'Character count of page when served as markdown',
  dependsOn: [['markdown-url-support', 'content-negotiation']],
  run: check,
});
