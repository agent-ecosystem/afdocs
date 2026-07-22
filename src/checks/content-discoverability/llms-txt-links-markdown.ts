import { registerCheck } from '../registry.js';
import { extractMarkdownLinks } from './llms-txt-valid.js';
import { filterByPathPrefix, getPathFilterBase } from '../../helpers/get-page-urls.js';
import { getLlmsTxtFilesForAnalysis } from '../../helpers/llms-txt.js';
import { toMdUrls } from '../../helpers/to-md-urls.js';
import { looksLikeMarkdown } from '../../helpers/detect-markdown.js';
import { linkLabel, resultSuffix, t } from '../../i18n/index.js';
import type { CheckContext, CheckResult } from '../../types.js';

interface LinkMarkdownResult {
  url: string;
  hasMarkdownExtension: boolean;
  servesMarkdown: boolean;
  status?: number;
  mdVariantAvailable?: boolean;
  error?: string;
}

function hasMarkdownExtension(url: string): boolean {
  try {
    const pathname = new URL(url).pathname;
    return pathname.endsWith('.md') || pathname.endsWith('.mdx');
  } catch {
    return false;
  }
}

async function checkLlmsTxtLinksMarkdown(ctx: CheckContext): Promise<CheckResult> {
  const existsResult = ctx.previousResults.get('llms-txt-exists');
  const discovered = getLlmsTxtFilesForAnalysis(existsResult);

  if (discovered.length === 0) {
    return {
      id: 'llms-txt-links-markdown',
      category: 'content-discoverability',
      status: 'skip',
      message: t('check.llms-txt-links-markdown.skip_none'),
      dependsOn: ['llms-txt-exists'],
    };
  }

  // Collect unique links, scope to baseUrl path prefix, and partition by origin
  const allExtractedUrls = new Set<string>();
  for (const file of discovered) {
    const links = extractMarkdownLinks(file.content);
    for (const link of links) {
      if (link.url.startsWith('http://') || link.url.startsWith('https://')) {
        allExtractedUrls.add(link.url);
      }
    }
  }
  const scopedUrls = filterByPathPrefix(Array.from(allExtractedUrls), getPathFilterBase(ctx));

  const siteOrigin = ctx.effectiveOrigin ?? ctx.origin;
  const sameOriginLinks: string[] = [];
  const crossOriginLinks: string[] = [];
  for (const url of scopedUrls) {
    try {
      const linkOrigin = new URL(url).origin;
      if (linkOrigin === siteOrigin) {
        sameOriginLinks.push(url);
      } else {
        crossOriginLinks.push(url);
      }
    } catch {
      sameOriginLinks.push(url);
    }
  }

  const totalLinks = sameOriginLinks.length + crossOriginLinks.length;
  if (totalLinks === 0) {
    const baseUrlPath = new URL(ctx.baseUrl).pathname.replace(/\/$/, '');
    const filteredOut = allExtractedUrls.size > 0 && baseUrlPath && baseUrlPath !== '/';
    return {
      id: 'llms-txt-links-markdown',
      category: 'content-discoverability',
      status: 'skip',
      message: filteredOut
        ? t('check.llms-txt-links-resolve.skip_filtered', {
            count: allExtractedUrls.size,
            plural: allExtractedUrls.size === 1 ? '' : 's',
            path: baseUrlPath,
          })
        : t('check.llms-txt-links-resolve.skip_no_http'),
    };
  }

  // Sample same-origin links if too many
  let sameToTest = sameOriginLinks;
  const wasSampled = sameOriginLinks.length > ctx.options.maxLinksToTest;
  if (wasSampled) {
    for (let i = sameToTest.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [sameToTest[i], sameToTest[j]] = [sameToTest[j], sameToTest[i]];
    }
    sameToTest = sameToTest.slice(0, ctx.options.maxLinksToTest);
  }

  async function checkMarkdown(urls: string[]): Promise<LinkMarkdownResult[]> {
    const out: LinkMarkdownResult[] = [];
    const concurrency = ctx.options.maxConcurrency;
    for (let i = 0; i < urls.length; i += concurrency) {
      const batch = urls.slice(i, i + concurrency);
      const batchResults = await Promise.all(
        batch.map(async (url): Promise<LinkMarkdownResult> => {
          const hasMdExt = hasMarkdownExtension(url);

          if (hasMdExt) {
            return { url, hasMarkdownExtension: true, servesMarkdown: true };
          }

          // Check if the URL serves markdown via content-type
          try {
            const response = await ctx.http.fetch(url, {
              method: 'HEAD',
              headers: { Accept: 'text/markdown' },
            });
            const contentType = response.headers.get('content-type') ?? '';
            if (contentType.includes('text/markdown')) {
              return {
                url,
                hasMarkdownExtension: false,
                servesMarkdown: true,
                status: response.status,
              };
            }

            // For .txt URLs (e.g. llms-full.txt, llms-small.txt companion files),
            // content-sniff because they may contain markdown served as text/plain
            if (new URL(url).pathname.endsWith('.txt')) {
              try {
                const getResp = await ctx.http.fetch(url);
                if (getResp.ok) {
                  const body = await getResp.text();
                  if (looksLikeMarkdown(body)) {
                    return {
                      url,
                      hasMarkdownExtension: false,
                      servesMarkdown: true,
                      status: response.status,
                    };
                  }
                }
              } catch {
                // Fall through to .md variant check
              }
            }

            // Try .md variant candidates
            const candidates = toMdUrls(url);
            for (const mdUrl of candidates) {
              try {
                const mdResponse = await ctx.http.fetch(mdUrl, { method: 'HEAD' });
                if (mdResponse.ok) {
                  return {
                    url,
                    hasMarkdownExtension: false,
                    servesMarkdown: false,
                    status: response.status,
                    mdVariantAvailable: true,
                  };
                }
              } catch {
                // Try next candidate
              }
            }

            return {
              url,
              hasMarkdownExtension: false,
              servesMarkdown: false,
              status: response.status,
              mdVariantAvailable: false,
            };
          } catch (err) {
            return {
              url,
              hasMarkdownExtension: false,
              servesMarkdown: false,
              status: 0,
              error: err instanceof Error ? err.message : String(err),
            };
          }
        }),
      );
      out.push(...batchResults);
    }
    return out;
  }

  // Only check same-origin links for markdown support (cross-origin links
  // are outside the site owner's control and shouldn't affect the result)
  const results = await checkMarkdown(sameToTest);

  const markdownLinks = results.filter((r) => r.hasMarkdownExtension || r.servesMarkdown).length;
  const mdVariantsAvailable = results.filter((r) => r.mdVariantAvailable).length;
  const markdownRate = results.length > 0 ? markdownLinks / results.length : 0;
  const fetchErrors = results.filter((r) => r.error).length;
  const rateLimited = results.filter((r) => r.status === 429).length;

  const label = linkLabel(wasSampled);
  const suffix = resultSuffix({ fetchErrors, rateLimited });

  const crossNote =
    crossOriginLinks.length > 0
      ? ` (${crossOriginLinks.length} external link${crossOriginLinks.length === 1 ? '' : 's'} excluded)`
      : '';

  const details: Record<string, unknown> = {
    totalLinks,
    testedLinks: results.length,
    sampled: wasSampled,
    markdownLinks,
    htmlLinks: results.length - markdownLinks,
    mdVariantsAvailable,
    markdownRate: Math.round(markdownRate * 100),
    fetchErrors,
    rateLimited,
    crossOriginExcluded: crossOriginLinks.length,
  };

  if (results.length === 0) {
    // All links are cross-origin; can't assess markdown support
    return {
      id: 'llms-txt-links-markdown',
      category: 'content-discoverability',
      status: 'skip',
      message: t('check.llms-txt-links-markdown.skip_external', { total: totalLinks }),
      details,
    };
  }

  if (markdownRate >= 0.9) {
    return {
      id: 'llms-txt-links-markdown',
      category: 'content-discoverability',
      status: 'pass',
      message: t('check.llms-txt-links-markdown.pass', {
        markdown: markdownLinks,
        total: results.length,
        linkLabel: label,
        rate: Math.round(markdownRate * 100),
        suffix,
        crossNote,
      }),
      details,
    };
  }

  if (mdVariantsAvailable > 0) {
    return {
      id: 'llms-txt-links-markdown',
      category: 'content-discoverability',
      status: 'warn',
      message: t('check.llms-txt-links-markdown.warn_variants', {
        count: mdVariantsAvailable,
        suffix,
        crossNote,
      }),
      details,
    };
  }

  return {
    id: 'llms-txt-links-markdown',
    category: 'content-discoverability',
    status: 'fail',
    message: t('check.llms-txt-links-markdown.fail', { suffix, crossNote }),
    details,
  };
}

registerCheck({
  id: 'llms-txt-links-markdown',
  category: 'content-discoverability',
  description: 'Whether the URLs in llms.txt point to markdown content',
  dependsOn: ['llms-txt-exists'],
  run: checkLlmsTxtLinksMarkdown,
});
