import { registerCheck } from '../registry.js';
import { discoverAndSamplePages } from '../../helpers/get-page-urls.js';
import { toHtmlUrl } from '../../helpers/to-md-urls.js';
import type { CheckContext, CheckResult } from '../../types.js';
import { pageLabel, t } from '../../i18n/index.js';

interface DirectiveResult {
  url: string;
  found: boolean;
  position?: number;
  positionPercent?: number;
  matchText?: string;
  error?: string;
}

/**
 * Links whose href points to an actual llms.txt file (path ends with /llms.txt).
 * Excludes links to pages *about* llms.txt (e.g. /docs/ai/llmstxt).
 */
const LINK_PATTERN =
  /<a\s[^>]*href\s*=\s*["']([^"']*\/llms\.txt(?:[?#][^"']*)?)["'][^>]*>[\s\S]*?<\/a>/gi;

/**
 * Path-like references to an llms.txt file in body content (after
 * nav/script/style are stripped). Requires a leading slash to distinguish
 * actual directives (e.g. "See /llms.txt") from documentation prose that
 * merely discusses the llms.txt concept (e.g. "Create an llms.txt file").
 */
const TEXT_PATTERN = /\/llms\.txt/gi;

const TOP_THRESHOLD = 0.1;
const DEEP_THRESHOLD = 0.5;

/**
 * Extract the HTML body, then strip elements that should not be searched:
 * <nav>, <script>, <style> (which also covers JSON-LD blocks).
 */
function extractSearchableBody(html: string): string {
  const openMatch = /<body[\s>]/i.exec(html);
  let body: string;
  if (openMatch) {
    const bodyStart = html.indexOf('>', openMatch.index + openMatch[0].length - 1) + 1;
    const closeMatch = /<\/body\s*>/i.exec(html.slice(bodyStart));
    const bodyEnd = closeMatch ? bodyStart + closeMatch.index : html.length;
    body = html.slice(bodyStart, bodyEnd);
  } else {
    body = html;
  }

  return body
    .replace(/<nav\b[\s\S]*?<\/nav>/gi, '')
    .replace(/<script\b[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[\s\S]*?<\/style>/gi, '');
}

function searchHtmlContent(content: string): { position: number; matchText: string } | null {
  LINK_PATTERN.lastIndex = 0;
  const linkMatch = LINK_PATTERN.exec(content);
  if (linkMatch) {
    return { position: linkMatch.index, matchText: linkMatch[0].slice(0, 200) };
  }

  TEXT_PATTERN.lastIndex = 0;
  const textMatch = TEXT_PATTERN.exec(content);
  if (textMatch) {
    return { position: textMatch.index, matchText: textMatch[0] };
  }

  return null;
}

async function check(ctx: CheckContext): Promise<CheckResult> {
  const id = 'llms-txt-directive-html';
  const category = 'content-discoverability';

  const { urls: pageUrls, totalPages, sampled, warnings } = await discoverAndSamplePages(ctx);

  const results: DirectiveResult[] = [];
  const concurrency = ctx.options.maxConcurrency;

  for (let i = 0; i < pageUrls.length; i += concurrency) {
    const batch = pageUrls.slice(i, i + concurrency);
    const batchResults = await Promise.all(
      batch.map(async (url): Promise<DirectiveResult> => {
        try {
          const htmlUrl = toHtmlUrl(url);
          const response = await ctx.http.fetch(htmlUrl);
          if (!response.ok) {
            return { url: htmlUrl, found: false, error: `HTTP ${response.status}` };
          }

          const contentType = response.headers.get('content-type') ?? '';
          const text = await response.text();
          const isHtml = contentType.includes('text/html') || text.trimStart().startsWith('<');

          if (!isHtml) {
            return { url: htmlUrl, found: false };
          }

          const searchable = extractSearchableBody(text);
          const hit = searchHtmlContent(searchable);
          if (hit) {
            const positionPercent = searchable.length > 0 ? hit.position / searchable.length : 0;
            return {
              url: htmlUrl,
              found: true,
              position: hit.position,
              positionPercent,
              matchText: hit.matchText,
            };
          }

          return { url: htmlUrl, found: false };
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
      message: t('check.llms-txt-directive-html.error_none', {
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
  const suffix = fetchErrors > 0 ? t('common.fetch_errors_suffix', { count: fetchErrors }) : '';

  if (found.length === 0) {
    status = 'fail';
    message = t('check.llms-txt-directive-html.fail_none', {
      count: tested.length,
      pageLabel: label,
      suffix,
    });
  } else if (buried.length > 0 && nearTop.length === 0) {
    status = 'warn';
    message = t('check.llms-txt-directive-html.warn_buried', {
      found: found.length,
      total: tested.length,
      pageLabel: label,
      suffix,
    });
  } else if (notFound.length > 0) {
    status = 'warn';
    message = t('check.llms-txt-directive-html.warn_partial', {
      found: found.length,
      total: tested.length,
      pageLabel: label,
      missing: notFound.length,
      suffix,
    });
  } else {
    status = 'pass';
    message = t('check.llms-txt-directive-html.pass', {
      total: tested.length,
      pageLabel: label,
      nearTop: nearTop.length > 0 ? t('check.llms-txt-directive-html.near_top') : '',
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
  id: 'llms-txt-directive-html',
  category: 'content-discoverability',
  description: 'Whether HTML pages include a directive pointing to llms.txt',
  dependsOn: [],
  run: check,
});
