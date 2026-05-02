import { registerCheck } from '../registry.js';
import {
  getUrlsFromCachedLlmsTxtWithOmitted,
  getUrlsFromSitemap,
  parseSitemapUrls,
} from '../../helpers/get-page-urls.js';
import { isSameSite } from '../../helpers/host-equivalence.js';
import { isNonPageUrl } from '../../helpers/to-md-urls.js';
import { isLocaleSegment, hasStructuralDuplication } from '../../helpers/locale-codes.js';
import {
  DEFAULT_COVERAGE_PASS_THRESHOLD,
  DEFAULT_COVERAGE_WARN_THRESHOLD,
} from '../../constants.js';
import picomatch from 'picomatch';
import type { CheckContext, CheckResult } from '../../types.js';

/**
 * Normalize a URL to a canonical path for comparison.
 * Strips trailing slashes, .md/.mdx/.html extensions, and /index variants,
 * then lowercases the path.
 */
export function normalizeUrlPath(url: string): string {
  try {
    const parsed = new URL(url);
    let path = parsed.pathname;

    // Strip /index.md, /index.mdx, /index.html
    path = path.replace(/\/index\.(?:md|mdx|html?)$/i, '/');

    // Strip .md, .mdx, .html extensions
    path = path.replace(/\.(?:md|mdx|html?)$/i, '');

    // Strip trailing slash (but keep root /)
    if (path.length > 1 && path.endsWith('/')) {
      path = path.slice(0, -1);
    }

    return path.toLowerCase();
  } catch {
    return url.toLowerCase();
  }
}

/**
 * Path patterns that are unlikely to need llms.txt coverage.
 * These are non-doc pages that commonly appear in sitemaps.
 */
const EXCLUDED_PATH_PATTERNS = [
  /^\/blog(\/|$)/i,
  /^\/pricing(\/|$)/i,
  /^\/about(\/|$)/i,
  /^\/careers?(\/|$)/i,
  /^\/jobs?(\/|$)/i,
  /^\/contact(\/|$)/i,
  /^\/legal(\/|$)/i,
  /^\/privacy(\/|$)/i,
  /^\/terms(\/|$)/i,
  /^\/login(\/|$)/i,
  /^\/signup(\/|$)/i,
  /^\/sign-up(\/|$)/i,
  /^\/sign-in(\/|$)/i,
  /^\/register(\/|$)/i,
  /^\/404(\/|$)/i,
  /^\/500(\/|$)/i,
];

export function isExcludedPath(normalizedPath: string, baseUrlPath?: string): boolean {
  if (EXCLUDED_PATH_PATTERNS.some((pattern) => pattern.test(normalizedPath))) {
    return true;
  }
  // Also check relative to the base path prefix (e.g. /docs/changelog → /changelog)
  if (baseUrlPath && baseUrlPath !== '/' && normalizedPath.startsWith(baseUrlPath)) {
    const relative = normalizedPath.slice(baseUrlPath.length) || '/';
    if (EXCLUDED_PATH_PATTERNS.some((pattern) => pattern.test(relative))) {
      return true;
    }
  }
  return false;
}

/**
 * Compile an array of glob patterns into a single picomatch matcher.
 * Returns a function that tests a URL path against all patterns.
 */
export function compileExclusionMatcher(patterns: string[]): (path: string) => boolean {
  if (patterns.length === 0) return () => false;
  return picomatch(patterns, { nocase: true });
}

/**
 * Test whether a normalized path matches any of the user-supplied exclusion globs.
 * Patterns are tested against both the absolute path and the path relative to baseUrlPath.
 */
export function matchesUserExclusion(
  normalizedPath: string,
  matcher: (path: string) => boolean,
  baseUrlPath?: string,
): boolean {
  if (matcher(normalizedPath)) return true;
  if (baseUrlPath && baseUrlPath !== '/' && normalizedPath.startsWith(baseUrlPath)) {
    const relative = normalizedPath.slice(baseUrlPath.length) || '/';
    if (matcher(relative)) return true;
  }
  return false;
}

/**
 * Extract path prefixes from omitted .txt URLs.
 * e.g. /docs/chains/ethereum/llms.txt → /docs/chains/ethereum
 */
export function extractOmittedPrefixes(omittedTxtUrls: string[]): string[] {
  const prefixes: string[] = [];
  for (const url of omittedTxtUrls) {
    try {
      const parsed = new URL(url);
      const dir = parsed.pathname.replace(/\/[^/]+$/, '');
      if (dir) prefixes.push(dir.toLowerCase());
    } catch {
      continue;
    }
  }
  return prefixes;
}

/**
 * Detect whether a URL set uses locale-prefixed paths and, if so, return the
 * path segment position where locales appear.
 *
 * Detection is empirical: for each path segment position, count how many
 * distinct 2-letter (or xx-yy) codes appear. If a position has ≥2 distinct
 * codes and those codes cover >50% of URLs, it's a locale segment.
 *
 * Example: `/docs/en/intro` and `/docs/de/intro` → position 1 has codes
 * `en` and `de` → locale position detected at index 1.
 */
export function detectLocalePosition(urls: string[]): number | null {
  const positionCounts = new Map<number, Map<string, number>>();
  const positionTotals = new Map<number, number>();

  for (const url of urls) {
    try {
      const segments = new URL(url).pathname.split('/').filter(Boolean);
      for (let i = 0; i < segments.length; i++) {
        const seg = segments[i].toLowerCase();
        if (isLocaleSegment(seg)) {
          if (!positionCounts.has(i)) positionCounts.set(i, new Map());
          const counts = positionCounts.get(i)!;
          counts.set(seg, (counts.get(seg) ?? 0) + 1);
          positionTotals.set(i, (positionTotals.get(i) ?? 0) + 1);
        }
      }
    } catch {
      continue;
    }
  }

  // First pass: ≥2 distinct locale codes covering >50% of URLs (strong signal)
  for (const [pos, counts] of positionCounts) {
    if (counts.size < 2) continue;
    const total = positionTotals.get(pos) ?? 0;
    if (total > urls.length * 0.5) {
      return pos;
    }
  }

  // Second pass: single locale code confirmed by structural duplication.
  // With ISO 639-1 validation, a single code is meaningful when stripping it
  // produces paths that match unprefixed URLs in the same set.
  for (const [pos, counts] of positionCounts) {
    if (counts.size !== 1) continue;
    const [code] = counts.keys();
    if (hasStructuralDuplication(urls, pos, code)) {
      return pos;
    }
  }

  return null;
}

/**
 * Get the dominant value at a given path segment position across a URL set.
 * Returns null if no consistent value is found.
 */
export function getDominantSegment(urls: string[], position: number): string | null {
  const counts = new Map<string, number>();
  for (const url of urls) {
    try {
      const segments = new URL(url).pathname.split('/').filter(Boolean);
      if (segments.length > position) {
        const seg = segments[position].toLowerCase();
        counts.set(seg, (counts.get(seg) ?? 0) + 1);
      }
    } catch {
      continue;
    }
  }

  let dominant = '';
  let dominantCount = 0;
  for (const [seg, count] of counts) {
    if (count > dominantCount) {
      dominant = seg;
      dominantCount = count;
    }
  }

  // Only return if it covers >50% of the URLs
  return dominantCount > urls.length * 0.5 ? dominant : null;
}

/**
 * Filter URLs to only those whose path segment at `position` matches `locale`.
 */
function filterByLocale(urls: string[], locale: string, position: number): string[] {
  return urls.filter((url) => {
    try {
      const segments = new URL(url).pathname.split('/').filter(Boolean);
      return segments.length > position && segments[position].toLowerCase() === locale;
    } catch {
      return false;
    }
  });
}

/**
 * Test whether a URL has a locale code at the given path position.
 */
export function hasLocaleCodeAt(url: string, position: number): boolean {
  try {
    const segments = new URL(url).pathname.split('/').filter(Boolean);
    return segments.length > position && isLocaleSegment(segments[position]);
  } catch {
    return false;
  }
}

/**
 * Filter URLs to only those that do NOT have a locale code at `position`.
 * Used when llms.txt covers the unprefixed default locale and we need to
 * exclude locale-prefixed sitemap variants from coverage comparison.
 */
export function filterToUnprefixedLocale(urls: string[], position: number): string[] {
  return urls.filter((url) => !hasLocaleCodeAt(url, position));
}

/**
 * Maximum sitemap URLs to collect for coverage comparison.
 * Higher than the default MAX_SITEMAP_URLS (500) used for page sampling,
 * because coverage needs the full sitemap to produce meaningful coverage
 * percentages. Enterprise docs sites (Stripe, MongoDB) can have thousands
 * of pages.
 */
const MAX_COVERAGE_SITEMAP_URLS = 50_000;

/**
 * Try to fetch a docs-specific sitemap at {baseUrl}/sitemap.xml.
 * Many docs sites host their own sitemap that isn't referenced from robots.txt
 * (e.g., Loops /docs/sitemap.xml, Supabase /docs/sitemap.xml).
 */
async function fetchDocsSitemap(ctx: CheckContext): Promise<string[]> {
  const baseUrlPath = new URL(ctx.baseUrl).pathname.replace(/\/$/, '');
  if (!baseUrlPath || baseUrlPath === '/') return [];

  const docsSitemapUrl = `${ctx.origin}${baseUrlPath}/sitemap.xml`;
  try {
    const response = await ctx.http.fetch(docsSitemapUrl);
    if (!response.ok) return [];
    const xml = await response.text();
    const parsed = parseSitemapUrls(xml);

    // If it's a sitemap index, follow one level
    if (parsed.sitemapIndexUrls.length > 0) {
      const urls: string[] = [];
      for (const subUrl of parsed.sitemapIndexUrls) {
        try {
          const subResp = await ctx.http.fetch(subUrl);
          if (!subResp.ok) continue;
          const subXml = await subResp.text();
          const subParsed = parseSitemapUrls(subXml);
          urls.push(...subParsed.urls);
        } catch {
          // Skip failed fetches
        }
      }
      return urls;
    }

    return parsed.urls;
  } catch {
    return [];
  }
}

/**
 * Scope URLs to the baseUrl path prefix and same origin.
 */
function scopeUrls(urls: string[], origin: string, baseUrlPath: string): string[] {
  return urls.filter((url) => {
    try {
      const parsed = new URL(url);
      if (!isSameSite(url, origin)) return false;
      if (baseUrlPath && baseUrlPath !== '/') {
        if (!parsed.pathname.startsWith(baseUrlPath + '/') && parsed.pathname !== baseUrlPath) {
          return false;
        }
      }
      if (isNonPageUrl(url)) return false;
      return true;
    } catch {
      return false;
    }
  });
}

async function check(ctx: CheckContext): Promise<CheckResult> {
  const id = 'llms-txt-coverage';
  const category = 'observability';

  const passThreshold =
    (ctx.options.coveragePassThreshold ?? DEFAULT_COVERAGE_PASS_THRESHOLD) / 100;
  const warnThreshold =
    (ctx.options.coverageWarnThreshold ?? DEFAULT_COVERAGE_WARN_THRESHOLD) / 100;

  // Compile user-supplied exclusion patterns
  const userExclusionMatcher = compileExclusionMatcher(ctx.options.coverageExclusions ?? []);

  // 1. Get llms.txt page URLs + omitted subtrees (progressive disclosure)
  const walkResult = await getUrlsFromCachedLlmsTxtWithOmitted(ctx);
  const llmsTxtUrls = walkResult.pageUrls;
  const omittedPrefixes = extractOmittedPrefixes(walkResult.omittedTxtUrls);

  if (llmsTxtUrls.length === 0) {
    return {
      id,
      category,
      status: 'skip',
      message: 'No page URLs found in llms.txt',
    };
  }

  // 2. Get sitemap URLs, with docs-specific sitemap fallback
  //    Use effectiveOrigin when a cross-host redirect was detected, so that
  //    sitemap URLs at the redirected host are accepted rather than filtered out.
  const effectiveOrigin = ctx.effectiveOrigin ?? ctx.origin;
  const sitemapWarnings: string[] = [];
  let sitemapUrls = await getUrlsFromSitemap(ctx, sitemapWarnings, {
    maxUrls: MAX_COVERAGE_SITEMAP_URLS,
    originOverride: effectiveOrigin,
    skipRefinement: true,
  });
  let sitemapSource = 'robots.txt/sitemap.xml';
  const baseUrlPath = new URL(ctx.baseUrl).pathname.replace(/\/$/, '');

  // Check if main sitemap has any docs URLs
  let scopedSitemapUrls = scopeUrls(sitemapUrls, effectiveOrigin, baseUrlPath);

  // If the main sitemap has no docs URLs, try a docs-specific sitemap
  if (scopedSitemapUrls.length === 0 && baseUrlPath && baseUrlPath !== '/') {
    const docsSitemapUrls = await fetchDocsSitemap(ctx);
    if (docsSitemapUrls.length > 0) {
      sitemapUrls = docsSitemapUrls;
      scopedSitemapUrls = scopeUrls(docsSitemapUrls, effectiveOrigin, baseUrlPath);
      sitemapSource = `${baseUrlPath}/sitemap.xml`;
    }
  }

  if (sitemapUrls.length === 0) {
    return {
      id,
      category,
      status: 'skip',
      message:
        'No sitemap found; cannot assess llms.txt coverage without a sitemap as ground truth',
      details: { sitemapWarnings },
    };
  }

  if (scopedSitemapUrls.length === 0) {
    return {
      id,
      category,
      status: 'skip',
      message: `Sitemap has ${sitemapUrls.length} URLs but none are under the docs path prefix (${baseUrlPath || '/'})`,
      details: {
        totalSitemapUrls: sitemapUrls.length,
        baseUrlPath: baseUrlPath || '/',
        sitemapWarnings,
      },
    };
  }

  // 2b. Locale filtering: if the sitemap uses locale-prefixed paths (e.g. /docs/en/,
  //     /docs/de/), filter to the same locale as the llms.txt URLs. This avoids
  //     penalizing sites for not listing every localized variant in llms.txt.
  let localeFiltered = false;
  let detectedLocale: string | null = null;
  const localePosition = detectLocalePosition(scopedSitemapUrls);

  if (localePosition !== null) {
    const llmsLocale = getDominantSegment(llmsTxtUrls, localePosition);
    if (llmsLocale) {
      detectedLocale = llmsLocale;
      const before = scopedSitemapUrls.length;
      scopedSitemapUrls = filterByLocale(scopedSitemapUrls, llmsLocale, localePosition);
      localeFiltered = scopedSitemapUrls.length < before;
    } else {
      // llms.txt may cover the unprefixed default locale (no /en/, /de/, etc.).
      // If most llms.txt URLs lack locale codes at the detected position,
      // filter the sitemap to only unprefixed URLs.
      const withLocale = llmsTxtUrls.filter((u) => hasLocaleCodeAt(u, localePosition!)).length;
      if (withLocale < llmsTxtUrls.length * 0.5) {
        const before = scopedSitemapUrls.length;
        scopedSitemapUrls = filterToUnprefixedLocale(scopedSitemapUrls, localePosition);
        localeFiltered = scopedSitemapUrls.length < before;
        if (localeFiltered) detectedLocale = 'default';
      }
    }
  }

  // 3. Normalize both sets for comparison, applying exclusions:
  //    - Built-in non-doc path patterns (blog, changelog, etc.)
  //    - User-supplied exclusion globs (--coverage-exclusions)
  //    - Omitted subtree prefixes (nested llms.txt indexes not walked)
  const llmsNormalized = new Set(llmsTxtUrls.map(normalizeUrlPath));
  const sitemapNormalized = new Map<string, string>(); // normalized -> original URL
  let omittedSubtreeCount = 0;
  let userExcludedCount = 0;
  for (const url of scopedSitemapUrls) {
    const norm = normalizeUrlPath(url);
    if (isExcludedPath(norm, baseUrlPath)) continue;
    if (matchesUserExclusion(norm, userExclusionMatcher, baseUrlPath)) {
      userExcludedCount++;
      continue;
    }
    if (omittedPrefixes.length > 0 && omittedPrefixes.some((p) => norm.startsWith(p))) {
      omittedSubtreeCount++;
      continue;
    }
    sitemapNormalized.set(norm, url);
  }

  const excludedCount =
    scopedSitemapUrls.length - sitemapNormalized.size - omittedSubtreeCount - userExcludedCount;

  // 4. Missing coverage: in sitemap but not in llms.txt
  const missingFromLlmsTxt: string[] = [];
  for (const [norm, originalUrl] of sitemapNormalized) {
    if (!llmsNormalized.has(norm)) {
      missingFromLlmsTxt.push(originalUrl);
    }
  }

  // 5. Unmatched llms.txt links: in llms.txt but not in sitemap
  //    This could mean either (a) the page was removed (truly stale) or
  //    (b) the sitemap is incomplete. We report it but don't use it to
  //    determine the overall status since we can't distinguish the two
  //    without fetching every URL (which llms-txt-links-resolve handles).
  const sitemapNormalizedSet = new Set(sitemapNormalized.keys());
  const unmatchedLlmsTxtUrls: string[] = [];
  for (const url of llmsTxtUrls) {
    const norm = normalizeUrlPath(url);
    // Only check URLs under the same origin and path prefix
    try {
      const parsed = new URL(url);
      if (parsed.origin !== effectiveOrigin) continue;
      if (
        baseUrlPath &&
        baseUrlPath !== '/' &&
        !parsed.pathname.startsWith(baseUrlPath + '/') &&
        parsed.pathname !== baseUrlPath
      ) {
        continue;
      }
    } catch {
      continue;
    }
    if (isExcludedPath(norm, baseUrlPath)) continue;
    if (!sitemapNormalizedSet.has(norm)) {
      unmatchedLlmsTxtUrls.push(url);
    }
  }

  // 6. Compute metrics
  const sitemapDocPages = sitemapNormalized.size;
  const coveredCount = sitemapDocPages - missingFromLlmsTxt.length;
  const coverageRate = sitemapDocPages > 0 ? coveredCount / sitemapDocPages : 1;
  const unmatchedRate =
    llmsTxtUrls.length > 0 ? unmatchedLlmsTxtUrls.length / llmsTxtUrls.length : 0;

  const coveragePct = Math.round(coverageRate * 100);
  const unmatchedPct = Math.round(unmatchedRate * 100);

  // 7. Determine status based on coverage and configurable thresholds
  //    Unmatched links are informational (see note in step 5)
  let overallStatus: 'pass' | 'warn' | 'fail';
  if (coverageRate >= passThreshold) {
    overallStatus = 'pass';
  } else if (coverageRate >= warnThreshold) {
    overallStatus = 'warn';
  } else {
    overallStatus = 'fail';
  }

  // 8. Build message
  const parts: string[] = [];
  if (overallStatus === 'pass') {
    parts.push(`llms.txt covers ${coveragePct}% of ${sitemapDocPages} sitemap doc pages`);
  } else {
    parts.push(
      `llms.txt covers ${coveredCount}/${sitemapDocPages} sitemap doc pages (${coveragePct}%); ${missingFromLlmsTxt.length} missing`,
    );
  }
  if (omittedSubtreeCount > 0) {
    parts.push(
      `${walkResult.omittedTxtUrls.length} nested indexes omitted (${omittedSubtreeCount} sitemap pages excluded)`,
    );
  }
  if (unmatchedLlmsTxtUrls.length > 0) {
    parts.push(
      `${unmatchedLlmsTxtUrls.length} llms.txt links not in sitemap (may indicate stale links or incomplete sitemap)`,
    );
  }

  const message = parts.join('; ');

  return {
    id,
    category,
    status: overallStatus,
    message,
    details: {
      llmsTxtPageCount: llmsTxtUrls.length,
      sitemapTotal: sitemapUrls.length,
      sitemapScoped: scopedSitemapUrls.length,
      sitemapDocPages,
      sitemapSource,
      excludedNonDocPages: excludedCount,
      ...(userExcludedCount > 0 ? { userExcludedPages: userExcludedCount } : {}),
      ...(omittedSubtreeCount > 0
        ? {
            omittedSubtrees: walkResult.omittedTxtUrls.length,
            omittedSubtreePages: omittedSubtreeCount,
          }
        : {}),
      ...(localeFiltered ? { localeFiltered: true, detectedLocale } : {}),
      baseUrlPath: baseUrlPath || '/',
      coverageRate: coveragePct,
      coveragePassThreshold: Math.round(passThreshold * 100),
      coverageWarnThreshold: Math.round(warnThreshold * 100),
      missingFromLlmsTxt: missingFromLlmsTxt.slice(0, 50),
      missingCount: missingFromLlmsTxt.length,
      unmatchedLlmsTxtUrls: unmatchedLlmsTxtUrls.slice(0, 50),
      unmatchedCount: unmatchedLlmsTxtUrls.length,
      unmatchedPct,
      sitemapWarnings,
    },
  };
}

registerCheck({
  id: 'llms-txt-coverage',
  category: 'observability',
  description: 'How much of the site is represented in llms.txt',
  dependsOn: ['llms-txt-exists'],
  run: check,
});
