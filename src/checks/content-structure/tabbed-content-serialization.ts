import { registerCheck } from '../registry.js';
import { discoverAndSamplePages } from '../../helpers/get-page-urls.js';
import { htmlToMarkdown } from '../../helpers/html-to-markdown.js';
import { fetchPage } from '../../helpers/fetch-page.js';
import { detectTabGroups } from '../../helpers/detect-tabs.js';
import { toMdUrls } from '../../helpers/to-md-urls.js';
import type { CheckContext, CheckResult, CheckStatus } from '../../types.js';
import type { DetectedTabGroup } from '../../helpers/detect-tabs.js';
import { t } from '../../i18n/index.js';

interface TabbedPageResult {
  url: string;
  tabGroups: DetectedTabGroup[];
  totalTabbedChars: number;
  status: CheckStatus;
  source?: 'html' | 'md-fallback' | 'markdown';
  error?: string;
}

function sizeStatus(chars: number): CheckStatus {
  if (chars <= 50_000) return 'pass';
  if (chars <= 100_000) return 'warn';
  return 'fail';
}

function worstStatus(statuses: CheckStatus[]): CheckStatus {
  if (statuses.includes('fail')) return 'fail';
  if (statuses.includes('warn')) return 'warn';
  return 'pass';
}

function formatSize(chars: number): string {
  return `${Math.round(chars / 1000)}K`;
}

/**
 * Try to fetch a .md fallback URL for a page. Returns the body if successful, null otherwise.
 */
async function tryMdFallback(ctx: CheckContext, pageUrl: string): Promise<string | null> {
  const candidates = toMdUrls(pageUrl);
  for (const mdUrl of candidates) {
    try {
      const response = await ctx.http.fetch(mdUrl);
      if (!response.ok) continue;
      const contentType = response.headers.get('content-type') ?? '';
      if (!contentType.includes('text/markdown') && !contentType.includes('text/plain')) continue;
      const body = await response.text();
      // Sanity check: must have some content and not be HTML
      if (body.length > 0 && !body.trimStart().startsWith('<!')) return body;
    } catch {
      // Skip failed fetches
    }
  }
  return null;
}

/**
 * Check whether the rendering-strategy check flagged a specific URL as an SPA shell.
 * Returns true if the URL was analyzed and found to lack server-rendered content.
 */
function isSpaShell(ctx: CheckContext, url: string): boolean {
  const renderResult = ctx.previousResults.get('rendering-strategy');
  if (!renderResult?.details?.pageResults) return false;
  const pageResults = renderResult.details.pageResults as Array<{ url: string; status: string }>;
  const match = pageResults.find((r) => r.url === url);
  return match?.status === 'fail';
}

async function analyzePage(ctx: CheckContext, url: string): Promise<TabbedPageResult> {
  const page = await fetchPage(ctx, url);

  // For markdown responses, run MDX detection directly
  if (!page.isHtml) {
    const tabGroups = detectTabGroups(page.body);
    if (tabGroups.length === 0) {
      return { url, tabGroups: [], totalTabbedChars: 0, status: 'pass', source: 'markdown' };
    }
    // For markdown content, the serialized size is the raw content of the tab groups
    let totalTabbedChars = 0;
    for (const group of tabGroups) {
      totalTabbedChars += group.htmlSlice.length;
    }
    return {
      url,
      tabGroups,
      totalTabbedChars,
      status: sizeStatus(totalTabbedChars),
      source: 'markdown',
    };
  }

  // HTML response: try HTML-based detection first
  const tabGroups = detectTabGroups(page.body);
  if (tabGroups.length > 0) {
    let totalTabbedChars = 0;
    for (const group of tabGroups) {
      const md = htmlToMarkdown(group.htmlSlice);
      totalTabbedChars += md.length;
    }
    return {
      url,
      tabGroups,
      totalTabbedChars,
      status: sizeStatus(totalTabbedChars),
      source: 'html',
    };
  }

  // No tabs found in HTML. If rendering-strategy flagged this as an SPA shell,
  // try the markdown path as a fallback so we can still analyze tab content
  // for agents that support content negotiation.
  if (isSpaShell(ctx, url)) {
    const mdBody = await tryMdFallback(ctx, url);
    if (mdBody) {
      const mdTabGroups = detectTabGroups(mdBody);
      if (mdTabGroups.length > 0) {
        let totalTabbedChars = 0;
        for (const group of mdTabGroups) {
          totalTabbedChars += group.htmlSlice.length;
        }
        return {
          url,
          tabGroups: mdTabGroups,
          totalTabbedChars,
          status: sizeStatus(totalTabbedChars),
          source: 'md-fallback',
        };
      }
    }
  }

  return { url, tabGroups: [], totalTabbedChars: 0, status: 'pass', source: 'html' };
}

async function check(ctx: CheckContext): Promise<CheckResult> {
  const id = 'tabbed-content-serialization';
  const category = 'content-structure';

  const {
    urls: pageUrls,
    totalPages,
    sampled: wasSampled,
    warnings,
  } = await discoverAndSamplePages(ctx);

  const results: TabbedPageResult[] = [];
  const concurrency = ctx.options.maxConcurrency;

  for (let i = 0; i < pageUrls.length; i += concurrency) {
    const batch = pageUrls.slice(i, i + concurrency);
    const batchResults = await Promise.all(
      batch.map(async (url): Promise<TabbedPageResult> => {
        try {
          return await analyzePage(ctx, url);
        } catch (err) {
          return {
            url,
            tabGroups: [],
            totalTabbedChars: 0,
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

  if (successful.length === 0) {
    const suffix = fetchErrors > 0 ? t('common.fetch_errors_suffix', { count: fetchErrors }) : '';
    return {
      id,
      category,
      status: 'fail',
      message: t('check.tabbed-content-serialization.error_none', { suffix }),
      details: {
        totalPages,
        testedPages: results.length,
        sampled: wasSampled,
        fetchErrors,
        tabbedPages: results,
        discoveryWarnings: warnings,
      },
    };
  }

  const pagesWithTabs = successful.filter((r) => r.tabGroups.length > 0);
  const totalGroupsFound = successful.reduce((sum, r) => sum + r.tabGroups.length, 0);
  const overallStatus = worstStatus(successful.map((r) => r.status));
  const pageLabel = wasSampled ? t('common.sampled_pages') : t('common.pages');

  let message: string;
  if (totalGroupsFound === 0) {
    message = t('check.tabbed-content-serialization.pass_none', {
      total: successful.length,
      pageLabel,
    });
  } else if (overallStatus === 'pass') {
    message = t('check.tabbed-content-serialization.pass', {
      groups: totalGroupsFound,
      pages: pagesWithTabs.length,
      total: successful.length,
      pageLabel,
    });
  } else if (overallStatus === 'warn') {
    const worst = Math.max(...successful.map((r) => r.totalTabbedChars));
    message = t('check.tabbed-content-serialization.warn', {
      groups: totalGroupsFound,
      size: formatSize(worst),
    });
  } else {
    const worst = Math.max(...successful.map((r) => r.totalTabbedChars));
    message = t('check.tabbed-content-serialization.fail', {
      groups: totalGroupsFound,
      size: formatSize(worst),
    });
  }

  if (fetchErrors > 0) {
    message += t('common.fetch_errors_suffix', { count: fetchErrors });
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
      pagesWithTabs: pagesWithTabs.length,
      totalGroupsFound,
      fetchErrors,
      tabbedPages: results,
      discoveryWarnings: warnings,
    },
  };
}

registerCheck({
  id: 'tabbed-content-serialization',
  category: 'content-structure',
  description: 'Whether tabbed/accordion content serializes into oversized output',
  dependsOn: [],
  run: check,
});
