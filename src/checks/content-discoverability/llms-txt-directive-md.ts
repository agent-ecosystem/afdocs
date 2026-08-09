import { registerCheck } from '../registry.js';
import { looksLikeMarkdown } from '../../helpers/detect-markdown.js';
import { discoverAndSamplePages } from '../../helpers/get-page-urls.js';
import { toMdUrls, toHtmlUrl } from '../../helpers/to-md-urls.js';
import type { CheckContext, CheckResult } from '../../types.js';

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
  const htmlUrl = toHtmlUrl(pageUrl, ctx.options.urlPathPattern);
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
      message: `Could not fetch markdown for any of ${results.length} pages${fetchErrors > 0 ? `; ${fetchErrors} had no markdown version` : ''}`,
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
  const pageLabel = sampled ? 'sampled pages' : 'pages';
  const suffix = fetchErrors > 0 ? `; ${fetchErrors} had no markdown version` : '';

  if (found.length === 0) {
    status = 'fail';
    message = `No llms.txt directive found in markdown of any of ${tested.length} ${pageLabel}${suffix}`;
  } else if (buried.length > 0 && nearTop.length === 0) {
    status = 'warn';
    message = `llms.txt directive found in markdown of ${found.length} of ${tested.length} ${pageLabel}, but buried deep in the page (past ${Math.round(DEEP_THRESHOLD * 100)}%)${suffix}`;
  } else if (notFound.length > 0) {
    status = 'warn';
    message = `llms.txt directive found in markdown of ${found.length} of ${tested.length} ${pageLabel} (${notFound.length} missing)${suffix}`;
  } else {
    status = 'pass';
    message = `llms.txt directive found in markdown of all ${tested.length} ${pageLabel}${nearTop.length > 0 ? ', near the top of content' : ''}${suffix}`;
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
