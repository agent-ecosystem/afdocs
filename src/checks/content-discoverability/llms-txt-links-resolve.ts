import { registerCheck } from '../registry.js';
import { LINK_RESOLVE_THRESHOLD } from '../../constants.js';
import { extractMarkdownLinks } from './llms-txt-valid.js';
import { filterByPathPrefix, getPathFilterBase } from '../../helpers/get-page-urls.js';
import { getLlmsTxtFilesForAnalysis } from '../../helpers/llms-txt.js';
import { linkLabel, resultSuffix, t } from '../../i18n/index.js';
import type { CheckContext, CheckResult } from '../../types.js';

interface LinkCheckResult {
  url: string;
  status: number;
  ok: boolean;
  error?: string;
}

async function checkLlmsTxtLinksResolve(ctx: CheckContext): Promise<CheckResult> {
  const existsResult = ctx.previousResults.get('llms-txt-exists');
  const discovered = getLlmsTxtFilesForAnalysis(existsResult);

  if (discovered.length === 0) {
    return {
      id: 'llms-txt-links-resolve',
      category: 'content-discoverability',
      status: 'skip',
      message: t('check.llms-txt-links-resolve.skip_none'),
      dependsOn: ['llms-txt-exists'],
    };
  }

  // Collect all unique links across all discovered files
  const allLinks = new Map<string, string>(); // url -> source file
  for (const file of discovered) {
    const links = extractMarkdownLinks(file.content);
    for (const link of links) {
      if (link.url.startsWith('http://') || link.url.startsWith('https://')) {
        allLinks.set(link.url, file.url);
      }
    }
  }

  // Scope links to the baseUrl path prefix so that docs at a subpath
  // (e.g. /docs) don't include unrelated site content from root llms.txt.
  const scopedUrls = filterByPathPrefix(Array.from(allLinks.keys()), getPathFilterBase(ctx));

  if (scopedUrls.length === 0) {
    const baseUrlPath = new URL(ctx.baseUrl).pathname.replace(/\/$/, '');
    const filteredOut = allLinks.size > 0 && baseUrlPath && baseUrlPath !== '/';
    return {
      id: 'llms-txt-links-resolve',
      category: 'content-discoverability',
      status: 'skip',
      message: filteredOut
        ? t('check.llms-txt-links-resolve.skip_filtered', {
            count: allLinks.size,
            plural: allLinks.size === 1 ? '' : 's',
            path: baseUrlPath,
          })
        : t('check.llms-txt-links-resolve.skip_no_http'),
    };
  }

  // Partition links into same-origin and cross-origin
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
      sameOriginLinks.push(url); // treat unparseable URLs as same-origin so they get checked
    }
  }

  // Sample same-origin links if there are too many
  let sameToTest = sameOriginLinks;
  const totalSameOrigin = sameOriginLinks.length;
  const wasSampled = totalSameOrigin > ctx.options.maxLinksToTest;
  if (wasSampled) {
    for (let i = sameToTest.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [sameToTest[i], sameToTest[j]] = [sameToTest[j], sameToTest[i]];
    }
    sameToTest = sameToTest.slice(0, ctx.options.maxLinksToTest);
  }

  // Sample cross-origin links separately
  let crossToTest = crossOriginLinks;
  const totalCrossOrigin = crossOriginLinks.length;
  if (totalCrossOrigin > ctx.options.maxLinksToTest) {
    for (let i = crossToTest.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [crossToTest[i], crossToTest[j]] = [crossToTest[j], crossToTest[i]];
    }
    crossToTest = crossToTest.slice(0, ctx.options.maxLinksToTest);
  }

  // Check links with bounded concurrency
  async function checkLinks(urls: string[]): Promise<LinkCheckResult[]> {
    const out: LinkCheckResult[] = [];
    const concurrency = ctx.options.maxConcurrency;
    for (let i = 0; i < urls.length; i += concurrency) {
      const batch = urls.slice(i, i + concurrency);
      const batchResults = await Promise.all(
        batch.map(async (url): Promise<LinkCheckResult> => {
          try {
            const response = await ctx.http.fetch(url, { method: 'HEAD' });
            // Some servers don't support HEAD; fall back to GET
            if (response.status === 405) {
              const getResponse = await ctx.http.fetch(url);
              return { url, status: getResponse.status, ok: getResponse.ok };
            }
            return { url, status: response.status, ok: response.ok };
          } catch (err) {
            return {
              url,
              status: 0,
              ok: false,
              error: err instanceof Error ? err.message : String(err),
            };
          }
        }),
      );
      out.push(...batchResults);
    }
    return out;
  }

  const sameResults = await checkLinks(sameToTest);
  const crossResults = await checkLinks(crossToTest);

  // Same-origin stats (drive pass/fail)
  const sameResolved = sameResults.filter((r) => r.ok).length;
  const sameBroken = sameResults.filter((r) => !r.ok);
  const sameResolveRate = sameResults.length > 0 ? sameResolved / sameResults.length : 1;
  const sameFetchErrors = sameResults.filter((r) => r.error).length;
  const sameRateLimited = sameResults.filter((r) => r.status === 429).length;

  // Cross-origin stats (reported but don't affect pass/fail)
  const crossResolved = crossResults.filter((r) => r.ok).length;
  const crossBroken = crossResults.filter((r) => !r.ok);
  const crossFetchErrors = crossResults.filter((r) => r.error).length;
  const crossRateLimited = crossResults.filter((r) => r.status === 429).length;

  const totalLinks = allLinks.size;
  const label = linkLabel(wasSampled);
  const sameSuffix = resultSuffix({
    fetchErrors: sameFetchErrors,
    rateLimited: sameRateLimited,
  });

  const crossNote =
    crossBroken.length > 0
      ? ` (${crossBroken.length} external link${crossBroken.length === 1 ? '' : 's'} also failed; may be bot-detection or rate-limiting)`
      : '';

  // Find the most common cross-origin domain for diagnostics
  let dominantCrossOrigin: string | null = null;
  if (crossOriginLinks.length > 0) {
    const originCounts = new Map<string, number>();
    for (const url of crossOriginLinks) {
      try {
        const o = new URL(url).origin;
        originCounts.set(o, (originCounts.get(o) ?? 0) + 1);
      } catch {
        // skip unparseable
      }
    }
    let maxCount = 0;
    for (const [origin, count] of originCounts) {
      if (count > maxCount) {
        maxCount = count;
        dominantCrossOrigin = origin;
      }
    }
  }

  const details: Record<string, unknown> = {
    totalLinks,
    sameOrigin: {
      total: totalSameOrigin,
      tested: sameResults.length,
      sampled: wasSampled,
      resolved: sameResolved,
      broken: sameBroken.map((b) => ({ url: b.url, status: b.status, error: b.error })),
      resolveRate: Math.round(sameResolveRate * 100),
      fetchErrors: sameFetchErrors,
      rateLimited: sameRateLimited,
    },
    crossOrigin: {
      total: totalCrossOrigin,
      tested: crossResults.length,
      resolved: crossResolved,
      broken: crossBroken.map((b) => ({ url: b.url, status: b.status, error: b.error })),
      fetchErrors: crossFetchErrors,
      rateLimited: crossRateLimited,
      dominantOrigin: dominantCrossOrigin,
    },
    // Flat fields kept for backward compatibility
    testedLinks: sameResults.length + crossResults.length,
    sampled: wasSampled,
    resolved: sameResolved + crossResolved,
    broken: [...sameBroken, ...crossBroken].map((b) => ({
      url: b.url,
      status: b.status,
      error: b.error,
    })),
    resolveRate: Math.round(sameResolveRate * 100),
    fetchErrors: sameFetchErrors + crossFetchErrors,
    rateLimited: sameRateLimited + crossRateLimited,
  };

  if (sameResults.length === 0) {
    // Only cross-origin links exist; report their status as a warning at most
    const allResolved = crossBroken.length === 0;
    return {
      id: 'llms-txt-links-resolve',
      category: 'content-discoverability',
      status: allResolved ? 'pass' : 'warn',
      message: allResolved
        ? t('check.llms-txt-links-resolve.pass_external', {
            count: crossResults.length,
            total: totalLinks,
          })
        : t('check.llms-txt-links-resolve.warn_external', {
            resolved: crossResolved,
            total: crossResults.length,
            broken: crossBroken.length,
          }),
      details,
    };
  }

  if (sameResolveRate === 1) {
    return {
      id: 'llms-txt-links-resolve',
      category: 'content-discoverability',
      status: crossBroken.length > 0 ? 'warn' : 'pass',
      message: t('check.llms-txt-links-resolve.pass', {
        sameCount: sameResults.length,
        linkLabel: label,
        total: totalLinks,
        suffix: sameSuffix,
        crossNote,
      }),
      details,
    };
  }

  if (sameResolveRate > LINK_RESOLVE_THRESHOLD) {
    return {
      id: 'llms-txt-links-resolve',
      category: 'content-discoverability',
      status: 'warn',
      message: t('check.llms-txt-links-resolve.warn', {
        resolved: sameResolved,
        sameCount: sameResults.length,
        linkLabel: label,
        rate: Math.round(sameResolveRate * 100),
        broken: sameBroken.length,
        suffix: sameSuffix,
        crossNote,
      }),
      details,
    };
  }

  return {
    id: 'llms-txt-links-resolve',
    category: 'content-discoverability',
    status: 'fail',
    message: t('check.llms-txt-links-resolve.fail', {
      resolved: sameResolved,
      sameCount: sameResults.length,
      linkLabel: label,
      rate: Math.round(sameResolveRate * 100),
      broken: sameBroken.length,
      suffix: sameSuffix,
      crossNote,
    }),
    details,
  };
}

registerCheck({
  id: 'llms-txt-links-resolve',
  category: 'content-discoverability',
  description: 'Whether the URLs listed in llms.txt actually resolve',
  dependsOn: ['llms-txt-exists'],
  run: checkLlmsTxtLinksResolve,
});
