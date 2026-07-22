import { registerCheck } from '../registry.js';
import { looksLikeMarkdown } from '../../helpers/detect-markdown.js';
import { discoverAndSamplePages } from '../../helpers/get-page-urls.js';
import { toMdUrls, toHtmlUrl } from '../../helpers/to-md-urls.js';
import type { CheckContext, CheckResult } from '../../types.js';
import { pageLabel, t } from '../../i18n/index.js';

interface DirectiveResult {
  url: string;
  found: boolean;
  /** The URL that provided the markdown content (may be a .md candidate). */
  mdUrl?: string;
  position?: number;
  positionPercent?: number;
  matchText?: string;
  error?: string;
}

/**
 * Path-like references to an llms.txt file. Requires a leading slash to
 * distinguish actual directives from documentation prose about the concept.
 */
const DIRECTIVE_PATTERN = /\/llms\.txt/gi;

const TOP_THRESHOLD = 0.1;
const DEEP_THRESHOLD = 0.5;

function searchContent(
  content: string,
  pattern: RegExp,
): { position: number; matchText: string } | null {
  pattern.lastIndex = 0;
  const match = pattern.exec(content);
  if (!match) return null;
  return { position: match.index, matchText: match[0].slice(0, 200) };
}

function evaluateMarkdown(pageUrl: string, content: string, mdUrl: string): DirectiveResult {
  const hit = searchContent(content, DIRECTIVE_PATTERN);
  if (hit) {
    const positionPercent = content.length > 0 ? hit.position / content.length : 0;
    return {
      url: pageUrl,
      found: true,
      mdUrl,
      position: hit.position,
      positionPercent,
      matchText: hit.matchText,
    };
  }
  return { url: pageUrl, found: false, mdUrl };
}

/**
 * Try to fetch markdown content for a page URL via .md URL candidates
 * and content negotiation.
 */
async function fetchMarkdown(
  ctx: CheckContext,
  pageUrl: string,
): Promise<{ text: string; url: string } | null> {
  const htmlUrl = toHtmlUrl(pageUrl);
  const mdCandidates = toMdUrls(htmlUrl);

  for (const mdUrl of mdCandidates) {
    try {
      const response = await ctx.http.fetch(mdUrl);
      if (!response.ok) continue;
      const text = await response.text();
      if (looksLikeMarkdown(text)) {
        return { text, url: mdUrl };
      }
    } catch {
      continue;
    }
  }

  try {
    const response = await ctx.http.fetch(htmlUrl, {
      headers: { Accept: 'text/markdown' },
    });
    if (response.ok) {
      const contentType = response.headers.get('content-type') ?? '';
      if (contentType.includes('text/markdown')) {
        const text = await response.text();
        if (text.trim().length > 0) {
          return { text, url: htmlUrl };
        }
      }
    }
  } catch {
    // Content negotiation failed
  }

  return null;
}

async function check(ctx: CheckContext): Promise<CheckResult> {
  const id = 'llms-txt-directive-md';
  const category = 'content-discoverability';

  const { urls: pageUrls, totalPages, sampled, warnings } = await discoverAndSamplePages(ctx);

  const results: DirectiveResult[] = [];
  const concurrency = ctx.options.maxConcurrency;

  for (let i = 0; i < pageUrls.length; i += concurrency) {
    const batch = pageUrls.slice(i, i + concurrency);
    const batchResults = await Promise.all(
      batch.map(async (url): Promise<DirectiveResult> => {
        try {
          // Read from cache if dependency checks already fetched markdown
          const cached = ctx.pageCache.get(url);
          if (cached?.markdown?.content) {
            return evaluateMarkdown(url, cached.markdown.content, url);
          }

          // Not cached; fetch markdown ourselves
          const md = await fetchMarkdown(ctx, url);
          if (!md) {
            return { url, found: false, error: 'No markdown version available' };
          }

          return evaluateMarkdown(url, md.text, md.url);
        } catch (err) {
          return {
            url,
            found: false,
            error: err instanceof Error ? err.message : String(err),
          };
        }
      }),
    );
    results.push(...batchResults);
  }

  const tested = results.filter((r) => !r.error);
  const fetchErrors = results.filter((r) => r.error).length;
  const found = results.filter((r) => r.found);
  const notFound = tested.filter((r) => !r.found);

  if (tested.length === 0) {
    return {
      id,
      category,
      status: 'fail',
      message: t('check.llms-txt-directive-md.error_none', {
        count: results.length,
        suffix: fetchErrors > 0 ? t('common.fetch_errors_suffix', { count: fetchErrors }) : '',
      }),
      details: {
        totalPages,
        testedPages: results.length,
        sampled,
        fetchErrors,
        pageResults: results,
        discoveryWarnings: warnings,
      },
    };
  }

  const nearTop = found.filter((r) => (r.positionPercent ?? 1) <= TOP_THRESHOLD);
  const buried = found.filter((r) => (r.positionPercent ?? 0) > DEEP_THRESHOLD);

  let status: 'pass' | 'warn' | 'fail';
  let message: string;
  const label = pageLabel(sampled);
  const suffix =
    fetchErrors > 0 ? t('check.llms-txt-directive-md.no_md_suffix', { count: fetchErrors }) : '';

  if (found.length === 0) {
    status = 'fail';
    message = t('check.llms-txt-directive-md.fail_none', {
      count: tested.length,
      pageLabel: label,
      suffix,
    });
  } else if (buried.length > 0 && nearTop.length === 0) {
    status = 'warn';
    message = t('check.llms-txt-directive-md.warn_buried', {
      found: found.length,
      total: tested.length,
      pageLabel: label,
      suffix,
    });
  } else if (notFound.length > 0) {
    status = 'warn';
    message = t('check.llms-txt-directive-md.warn_partial', {
      found: found.length,
      total: tested.length,
      pageLabel: label,
      missing: notFound.length,
      suffix,
    });
  } else {
    status = 'pass';
    message = t('check.llms-txt-directive-md.pass', {
      total: tested.length,
      pageLabel: label,
      nearTop: nearTop.length > 0 ? t('check.llms-txt-directive-md.near_top') : '',
      suffix,
    });
  }

  return {
    id,
    category,
    status,
    message,
    details: {
      totalPages,
      testedPages: tested.length,
      sampled,
      foundCount: found.length,
      notFoundCount: notFound.length,
      nearTopCount: nearTop.length,
      buriedCount: buried.length,
      fetchErrors,
      pageResults: results,
      discoveryWarnings: warnings,
    },
  };
}

registerCheck({
  id: 'llms-txt-directive-md',
  category: 'content-discoverability',
  description: 'Whether markdown pages include a directive pointing to llms.txt',
  dependsOn: [['markdown-url-support', 'content-negotiation']],
  run: check,
});
