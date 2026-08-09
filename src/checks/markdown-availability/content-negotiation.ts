import { registerCheck } from '../registry.js';
import { looksLikeMarkdown, looksLikeHtml } from '../../helpers/detect-markdown.js';
import { isSoft404Body } from '../../helpers/detect-soft-404.js';
import { discoverAndSamplePages } from '../../helpers/get-page-urls.js';
import { isNonPageUrl, isMdUrl, toHtmlUrl } from '../../helpers/to-md-urls.js';
import type { CheckContext, CheckResult } from '../../types.js';

type Classification = 'markdown-with-correct-type' | 'markdown-with-wrong-type' | 'html';

interface PageResult {
  url: string;
  /** The URL actually fetched (may differ from url if .md was normalized). */
  testedUrl?: string;
  classification: Classification;
  skipped?: boolean;
  softError?: boolean;
  contentType: string;
  status: number;
  error?: string;
}

async function check(ctx: CheckContext): Promise<CheckResult> {
  const id = 'content-negotiation';
  const category = 'markdown-availability';

  const {
    urls: pageUrls,
    totalPages,
    sampled: wasSampled,
    warnings,
  } = await discoverAndSamplePages(ctx);

  const results: PageResult[] = [];
  const concurrency = ctx.options.maxConcurrency;

  for (let i = 0; i < pageUrls.length; i += concurrency) {
    const batch = pageUrls.slice(i, i + concurrency);
    const batchResults = await Promise.all(
      batch.map(async (url): Promise<PageResult> => {
        // Non-page file types (e.g. .json, .xml) are already in a machine-readable format
        if (isNonPageUrl(url)) {
          return { url, classification: 'html', skipped: true, contentType: '', status: 0 };
        }

        // Pre-request: normalize .md/.mdx URLs to their canonical HTML form (#33).
        // Testing content negotiation against a .md URL is meaningless because the
        // server already serves markdown at that path by definition.
        const fetchUrl = isMdUrl(url) ? toHtmlUrl(url, ctx.options.urlPathPattern) : url;
        const testedUrl = fetchUrl !== url ? fetchUrl : undefined;

        try {
          const response = await ctx.http.fetch(fetchUrl, {
            headers: { Accept: 'text/markdown' },
          });
          const body = await response.text();
          const contentType = response.headers.get('content-type') ?? '';

          // Post-response: reject soft-404 error pages (#29).
          // Some servers return 200 with text/markdown for error pages
          // (e.g. "# Page Not Found"), which would inflate scores.
          if (isSoft404Body(body)) {
            return {
              url,
              testedUrl,
              classification: 'html',
              softError: true,
              contentType,
              status: response.status,
            };
          }

          const isMarkdownType = contentType.includes('text/markdown');
          const isMarkdownBody = looksLikeMarkdown(body);

          let classification: Classification;
          if (isMarkdownType && (isMarkdownBody || !looksLikeHtml(body))) {
            classification = 'markdown-with-correct-type';
            // Cache the markdown content (only if not already cached by md-url check)
            if (!ctx.pageCache.has(url)) {
              ctx.pageCache.set(url, {
                url,
                markdown: { content: body, source: 'content-negotiation' },
              });
            }
          } else if (isMarkdownBody) {
            classification = 'markdown-with-wrong-type';
            if (!ctx.pageCache.has(url)) {
              ctx.pageCache.set(url, {
                url,
                markdown: { content: body, source: 'content-negotiation' },
              });
            }
          } else {
            classification = 'html';
          }

          return { url, testedUrl, classification, contentType, status: response.status };
        } catch (err) {
          return {
            url,
            testedUrl,
            classification: 'html',
            contentType: '',
            status: 0,
            error: err instanceof Error ? err.message : String(err),
          };
        }
      }),
    );
    results.push(...batchResults);
  }

  const testedResults = results.filter((r) => !r.skipped);
  const skippedCount = results.length - testedResults.length;
  const normalizedCount = testedResults.filter((r) => r.testedUrl).length;
  const softErrorCount = testedResults.filter((r) => r.softError).length;
  const markdownWithCorrectType = testedResults.filter(
    (r) => r.classification === 'markdown-with-correct-type',
  ).length;
  const markdownWithWrongType = testedResults.filter(
    (r) => r.classification === 'markdown-with-wrong-type',
  ).length;
  const htmlOnly = testedResults.filter((r) => r.classification === 'html').length;
  const negotiationRate =
    testedResults.length > 0
      ? Math.round((markdownWithCorrectType / testedResults.length) * 100)
      : 0;
  const fetchErrors = testedResults.filter((r) => r.error).length;
  const rateLimited = testedResults.filter((r) => r.status === 429).length;

  const pageLabel = wasSampled ? 'sampled pages' : 'pages';
  const suffix =
    (fetchErrors > 0 ? `; ${fetchErrors} failed to fetch` : '') +
    (rateLimited > 0 ? `; ${rateLimited} rate-limited (HTTP 429)` : '') +
    (softErrorCount > 0 ? `; ${softErrorCount} returned error pages` : '') +
    (normalizedCount > 0 ? `; ${normalizedCount} .md URLs normalized` : '');

  const details: Record<string, unknown> = {
    totalPages,
    testedPages: testedResults.length,
    skippedPages: skippedCount,
    normalizedMdUrls: normalizedCount,
    softErrorPages: softErrorCount,
    sampled: wasSampled,
    markdownWithCorrectType,
    markdownWithWrongType,
    htmlOnly,
    negotiationRate,
    fetchErrors,
    rateLimited,
    pageResults: results,
    discoveryWarnings: warnings,
  };

  if (negotiationRate >= 90) {
    return {
      id,
      category,
      status: 'pass',
      message: `${markdownWithCorrectType}/${testedResults.length} ${pageLabel} support content negotiation (${negotiationRate}%)${suffix}`,
      details,
    };
  }

  if (markdownWithCorrectType > 0 || markdownWithWrongType > 0) {
    return {
      id,
      category,
      status: 'warn',
      message: `Content negotiation partially supported: ${markdownWithCorrectType} correct type, ${markdownWithWrongType} wrong type, ${htmlOnly} HTML only${suffix}`,
      details,
    };
  }

  return {
    id,
    category,
    status: 'fail',
    message: `Server ignores Accept: text/markdown header (0/${testedResults.length} ${pageLabel} return markdown)${suffix}`,
    details,
  };
}

registerCheck({
  id: 'content-negotiation',
  category: 'markdown-availability',
  description: 'Whether the server responds to Accept: text/markdown',
  dependsOn: [],
  run: check,
});
