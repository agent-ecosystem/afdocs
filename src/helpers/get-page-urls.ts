import { extractMarkdownLinks } from '../checks/content-discoverability/llms-txt-valid.js';
import { MAX_SITEMAP_URLS } from '../constants.js';
import { getLlmsTxtFilesForAnalysis, selectCanonicalLlmsTxt } from './llms-txt.js';
import { isMdUrl, toHtmlUrl } from './to-md-urls.js';
import type { CheckContext, DiscoveredFile } from '../types.js';

/**
 * Extract `<loc>` URLs from a sitemap XML string.
 * Also returns any `<sitemap><loc>` entries from sitemap index files.
 */
export function parseSitemapUrls(xml: string): { urls: string[]; sitemapIndexUrls: string[] } {
  const urls: string[] = [];
  const sitemapIndexUrls: string[] = [];

  // Detect sitemap index: contains <sitemap> elements
  const isSitemapIndex = /<sitemap[\s>]/i.test(xml);

  if (isSitemapIndex) {
    // Extract <loc> inside <sitemap> blocks
    const sitemapBlockRegex = /<sitemap[\s>][\s\S]*?<\/sitemap>/gi;
    let block;
    while ((block = sitemapBlockRegex.exec(xml)) !== null) {
      const locMatch = /<loc>\s*(.*?)\s*<\/loc>/i.exec(block[0]);
      if (locMatch) {
        sitemapIndexUrls.push(locMatch[1]);
      }
    }
  } else {
    // Regular sitemap: extract all <loc> entries
    const locRegex = /<loc>\s*(.*?)\s*<\/loc>/gi;
    let match;
    while ((match = locRegex.exec(xml)) !== null) {
      urls.push(match[1]);
    }
  }

  return { urls, sitemapIndexUrls };
}

export async function getUrlsFromCachedLlmsTxt(ctx: CheckContext): Promise<string[]> {
  const existsResult = ctx.previousResults.get('llms-txt-exists');
  const discovered = getLlmsTxtFilesForAnalysis(existsResult);

  const urls = extractLinksFromLlmsTxtFiles(discovered);
  return walkAggregateLinks(ctx, urls);
}

/**
 * Normalize a discovered page URL: convert .md/.mdx URLs to their HTML
 * equivalent so that llms.txt entries like `/docs/guide/index.md` deduplicate
 * against sitemap entries like `/docs/guide/`. Markdown-specific checks are
 * unaffected because they derive .md candidates from HTML URLs via toMdUrls().
 */
function normalizePageUrl(url: string): string {
  return isMdUrl(url) ? toHtmlUrl(url) : url;
}

function extractLinksFromLlmsTxtFiles(files: DiscoveredFile[]): string[] {
  const urls = new Set<string>();
  for (const file of files) {
    const links = extractMarkdownLinks(file.content);
    for (const link of links) {
      if (link.url.startsWith('http://') || link.url.startsWith('https://')) {
        urls.add(normalizePageUrl(link.url));
      } else if (link.url.startsWith('/')) {
        // Resolve root-relative URLs against the source file's origin
        try {
          const base = new URL(file.url);
          urls.add(normalizePageUrl(new URL(link.url, base.origin).toString()));
        } catch {
          // Skip malformed URLs
        }
      }
    }
  }
  return Array.from(urls);
}

/**
 * Maximum depth of nested aggregate (.txt) files to follow when expanding
 * an llms.txt index. Most sites use 1-2 levels (e.g. a top-level index that
 * points to per-section indexes). 5 covers deeper trees like Alchemy's
 * `/docs/llms.txt → /docs/chains/llms.txt → /docs/chains/{chain}/llms.txt`
 * while still terminating on pathological cycles.
 */
const MAX_AGGREGATE_DEPTH = 5;

/**
 * Hard cap on the number of aggregate .txt files we'll fetch in a single
 * walk, regardless of depth. Protects against very large sites
 * (Alchemy has ~80 per-chain files) ballooning into hundreds of HTTP
 * requests. 200 is enough headroom for the largest realistic case while
 * still being a clear safety net.
 */
const MAX_AGGREGATE_FILES = 200;

/**
 * Identify .txt links that are likely aggregate/index files (progressive
 * disclosure pattern) and recursively walk them to find page URLs.
 *
 * A link is considered walkable when it ends in .txt and is on the same
 * origin as the site being tested. This covers:
 *   - sub-product llms.txt files (Cloudflare)
 *   - aggregate content files (Supabase)
 *   - multi-level nested indexes (Alchemy: top → section → sub-section)
 *
 * Walking is bounded by `MAX_AGGREGATE_DEPTH` and `MAX_AGGREGATE_FILES`
 * so a malformed or extremely large index can't make us fetch unboundedly.
 * Each aggregate is fetched at most once even if referenced multiple times.
 */
async function walkAggregateLinks(ctx: CheckContext, urls: string[]): Promise<string[]> {
  const pageUrls: string[] = [];
  const visitedAggregates = new Set<string>();
  const queue: Array<{ url: string; depth: number }> = [];

  const siteOrigin = ctx.effectiveOrigin ?? ctx.origin;

  function isSameOrigin(parsed: URL): boolean {
    return parsed.origin === ctx.origin || parsed.origin === siteOrigin;
  }

  /** Sort a discovered URL into the page bucket or the aggregate-walk queue. */
  function classify(url: string, parentDepth: number): void {
    try {
      const parsed = new URL(url);
      if (/\.txt$/i.test(parsed.pathname)) {
        // Aggregates: same-origin, not yet visited, within depth budget.
        // Cross-origin .txt links are external resources we don't control.
        if (
          isSameOrigin(parsed) &&
          !visitedAggregates.has(url) &&
          parentDepth + 1 <= MAX_AGGREGATE_DEPTH
        ) {
          visitedAggregates.add(url);
          queue.push({ url, depth: parentDepth + 1 });
        }
      } else if (isSameOrigin(parsed)) {
        pageUrls.push(normalizePageUrl(url));
      }
    } catch {
      // Unparseable URL: keep it so the caller's later filtering can decide.
      pageUrls.push(normalizePageUrl(url));
    }
  }

  // Seed from the canonical llms.txt's links (parent depth 0).
  for (const url of urls) classify(url, 0);

  while (queue.length > 0 && visitedAggregates.size <= MAX_AGGREGATE_FILES) {
    const { url: aggUrl, depth } = queue.shift()!;
    try {
      const response = await ctx.http.fetch(aggUrl);
      if (!response.ok) continue;
      const contentType = response.headers.get('content-type') ?? '';
      if (!contentType.includes('text/')) continue;
      const content = await response.text();
      const trimmed = content.trimStart().toLowerCase();
      if (trimmed.startsWith('<!') || trimmed.startsWith('<html')) continue;
      if (content.trim().length === 0) continue;

      const subFile: DiscoveredFile = {
        url: aggUrl,
        content,
        status: response.status,
        redirected: response.redirected,
      };
      const subUrls = extractLinksFromLlmsTxtFiles([subFile]);

      for (const subUrl of subUrls) classify(subUrl, depth);
    } catch {
      // Skip failed fetches
    }
  }

  return pageUrls;
}

/**
 * Directly fetch llms.txt candidate URLs and extract links.
 * Used when `llms-txt-exists` hasn't run (e.g. standalone check mode).
 *
 * Mirrors the canonical-selection logic in `llms-txt-exists` so that the same
 * single source of truth drives sampling whether or not `llms-txt-exists` ran.
 */
async function fetchLlmsTxtUrls(ctx: CheckContext): Promise<string[]> {
  const explicitUrl = ctx.options.llmsTxtUrl;
  const candidates = explicitUrl
    ? [explicitUrl]
    : Array.from(
        new Set([
          `${ctx.baseUrl}/llms.txt`,
          `${ctx.origin}/llms.txt`,
          `${ctx.origin}/docs/llms.txt`,
        ]),
      );

  const discovered: DiscoveredFile[] = [];
  for (const url of candidates) {
    try {
      const response = await ctx.http.fetch(url);
      if (!response.ok) continue;
      const contentType = response.headers.get('content-type') ?? '';
      if (!contentType.includes('text/')) continue;
      const content = await response.text();
      const trimmed = content.trimStart().toLowerCase();
      if (trimmed.startsWith('<!') || trimmed.startsWith('<html')) continue;
      if (content.trim().length === 0) continue;
      discovered.push({
        url,
        content,
        status: response.status,
        redirected: response.redirected,
      });
    } catch {
      // Skip failed fetches
    }
  }

  const canonical = selectCanonicalLlmsTxt(discovered, ctx.baseUrl);
  const filesForAnalysis = canonical ? [canonical] : [];
  const urls = extractLinksFromLlmsTxtFiles(filesForAnalysis);
  return walkAggregateLinks(ctx, urls);
}

/**
 * Parse `Sitemap:` directives from a robots.txt body.
 * Returns an array of sitemap URLs found.
 */
export function parseSitemapDirectives(robotsTxt: string): string[] {
  const urls: string[] = [];
  for (const line of robotsTxt.split('\n')) {
    const match = /^\s*Sitemap:\s*(\S+)/i.exec(line);
    if (match) {
      urls.push(match[1]);
    }
  }
  return urls;
}

/**
 * Discover sitemap URLs by checking robots.txt first, then falling back to /sitemap.xml.
 */
async function discoverSitemapUrls(ctx: CheckContext, originOverride?: string): Promise<string[]> {
  // Try robots.txt for Sitemap directives at the original origin first
  try {
    const robotsResponse = await ctx.http.fetch(`${ctx.origin}/robots.txt`);
    if (robotsResponse.ok) {
      const body = await robotsResponse.text();
      const directives = parseSitemapDirectives(body);
      if (directives.length > 0) return directives;
    }
  } catch {
    // robots.txt fetch failed; fall through
  }

  // If there's an effective origin (cross-host redirect), try its robots.txt too
  if (originOverride && originOverride !== ctx.origin) {
    try {
      const robotsResponse = await ctx.http.fetch(`${originOverride}/robots.txt`);
      if (robotsResponse.ok) {
        const body = await robotsResponse.text();
        const directives = parseSitemapDirectives(body);
        if (directives.length > 0) return directives;
      }
    } catch {
      // fall through
    }
  }

  // Build fallback candidates: origin-level sitemap first, then subpath sitemaps
  // when the base URL has a non-root path (e.g. swagger.io/docs/).
  const fallbackOrigin = originOverride ?? ctx.origin;
  const candidates = [`${fallbackOrigin}/sitemap.xml`];

  const baseUrlPath = new URL(ctx.baseUrl).pathname.replace(/\/$/, '');
  if (baseUrlPath && baseUrlPath !== '') {
    const subpathBase = `${fallbackOrigin}${baseUrlPath}`;
    candidates.push(`${subpathBase}/sitemap.xml`);
    candidates.push(`${subpathBase}/sitemap-index.xml`);
  }

  return candidates;
}

export type DiscoverySource = 'llms-txt' | 'sitemap' | 'fallback';

export interface PageUrlResult {
  urls: string[];
  warnings: string[];
  /** Which discovery methods contributed to the final URL set. */
  sources: DiscoverySource[];
}

function isGzipped(url: string): boolean {
  return /\.gz($|\?)/i.test(url);
}

/**
 * Extract a locale-like segment from a URL path, if present.
 * Matches 2-letter codes and xx-yy region subtags (e.g. `en`, `fr`, `pt-br`).
 * Returns the locale string or null.
 *
 * Only returns a match when the segment is clearly positional (early in the path,
 * before content segments), to avoid false positives on short path segments.
 */
export function extractLocaleFromUrl(url: string): string | null {
  try {
    const segments = new URL(url).pathname.split('/').filter(Boolean);
    // Only check the first 3 segments to avoid matching content paths
    for (let i = 0; i < Math.min(segments.length, 3); i++) {
      if (/^[a-z]{2}(-[a-z]{2})?$/i.test(segments[i])) {
        return segments[i].toLowerCase();
      }
    }
  } catch {
    // ignore
  }
  return null;
}

/**
 * Detect whether sub-sitemap URLs follow a locale naming convention and, if so,
 * filter to the preferred locale. Defaults to 'en' when no preference is given.
 *
 * Common patterns:
 * - `sitemap-en.xml`, `sitemap-fr.xml`, `sitemap-el.xml`
 * - `/en/sitemap.xml`, `/fr/sitemap.xml`
 *
 * Returns the original array unchanged if no locale pattern is detected.
 */
export function filterLocaleSitemaps(
  subSitemapUrls: string[],
  preferredLocale?: string | null,
): string[] {
  if (subSitemapUrls.length < 2) return subSitemapUrls;

  // Pattern 1: locale code in filename (sitemap-{locale}.xml)
  const filenameLocalePattern = /\/sitemap-([a-z]{2}(?:-[a-z]{2})?)\.xml$/i;
  // Pattern 2: locale code in path segment (/{locale}/sitemap.xml)
  const pathLocalePattern = /\/([a-z]{2}(?:-[a-z]{2})?)\/sitemap[^/]*\.xml$/i;

  const locales = new Map<string, string[]>();
  const nonLocale: string[] = [];

  for (const url of subSitemapUrls) {
    const filenameMatch = filenameLocalePattern.exec(url);
    const pathMatch = pathLocalePattern.exec(url);
    const match = filenameMatch ?? pathMatch;

    if (match) {
      const locale = match[1].toLowerCase();
      if (!locales.has(locale)) locales.set(locale, []);
      locales.get(locale)!.push(url);
    } else {
      nonLocale.push(url);
    }
  }

  // Need at least 2 distinct locale codes to consider this a locale-organized index
  if (locales.size < 2) return subSitemapUrls;

  // Prefer the user's locale, then 'en', then any non-locale sitemaps
  const locale = preferredLocale?.toLowerCase();
  const preferred = (locale && locales.get(locale)) ?? locales.get('en') ?? [];
  return [...preferred, ...nonLocale].length > 0 ? [...preferred, ...nonLocale] : subSitemapUrls;
}

/**
 * Filter page URLs to a single locale when the URL set contains locale-organized paths.
 *
 * Detection: for each path segment position, count how many distinct 2-letter
 * (or xx-yy) codes appear. If a position has ≥2 distinct codes covering >50%
 * of URLs, it's a locale segment.
 *
 * When detected, keeps only URLs matching the preferred locale (from the base
 * URL), or 'en' as default. Returns the original array if no locale pattern
 * is detected.
 */
export function filterLocalizedUrls(urls: string[], preferredLocale?: string | null): string[] {
  if (urls.length < 2) return urls;

  // For each path segment position, collect locale-like codes
  const positionCounts = new Map<number, Map<string, number>>();
  const positionTotals = new Map<number, number>();

  for (const url of urls) {
    try {
      const segments = new URL(url).pathname.split('/').filter(Boolean);
      for (let i = 0; i < segments.length; i++) {
        const seg = segments[i].toLowerCase();
        if (/^[a-z]{2}(-[a-z]{2})?$/.test(seg)) {
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

  // Find the position that looks like a locale segment
  let localePosition: number | null = null;
  for (const [pos, counts] of positionCounts) {
    if (counts.size < 2) continue;
    const total = positionTotals.get(pos) ?? 0;
    if (total > urls.length * 0.5) {
      localePosition = pos;
      break;
    }
  }

  if (localePosition === null) return urls;

  const targetLocale = preferredLocale?.toLowerCase() ?? 'en';

  const filtered = urls.filter((url) => {
    try {
      const segments = new URL(url).pathname.split('/').filter(Boolean);
      if (segments.length <= localePosition!) return true; // keep URLs without enough segments
      return segments[localePosition!].toLowerCase() === targetLocale;
    } catch {
      return true;
    }
  });

  // If filtering removed everything (target locale not present), return original
  return filtered.length > 0 ? filtered : urls;
}

/**
 * Version segment pattern: matches common versioning conventions in URL paths.
 *
 * Matches segments like: v2, v3.1, 2.x, 3.0.1, 1.8, latest, stable, current, dev, next.
 * Pre-release channels (dev, next, nightly, canary) are recognized for grouping but
 * ranked below stable versions during deduplication.
 * Does NOT match bare integers (e.g. `42`) since those are often page numbers or IDs.
 * Bare integers require a `v` prefix (e.g. `v2`) to be recognized as versions.
 */
const VERSION_SEGMENT =
  /^(v\d+(\.\d+)*(\.[x*])?|\d+\.\d+(\.\d+)*(\.[x*])?|\d+\.[x*]|latest|stable|current|dev|next|nightly|canary)$/i;

/**
 * Extract a version-like segment from a URL path, if present.
 * Returns the version string (e.g. `6.0`, `v2`, `latest`) or null.
 */
export function extractVersionFromUrl(url: string): string | null {
  try {
    const segments = new URL(url).pathname.split('/').filter(Boolean);
    for (const seg of segments) {
      if (VERSION_SEGMENT.test(seg)) return seg;
    }
  } catch {
    // ignore
  }
  return null;
}

/**
 * Detect versioned URL duplicates and deduplicate to the "current" version.
 *
 * When a sitemap contains the same page under multiple version prefixes
 * (e.g., `/docs/2.x/foo`, `/docs/3.1.1/foo`, `/docs/foo`), this function
 * groups them by their non-version path and keeps only one variant per page.
 *
 * Priority when `preferredVersion` is set: that version wins.
 * Default priority: unversioned > `latest`/`stable`/`current` > highest semver.
 *
 * Returns the original array if no version duplication is detected (i.e.,
 * fewer than 20% of URLs share a path suffix with another URL under a
 * different version prefix).
 */
export function deduplicateVersionedUrls(
  urls: string[],
  preferredVersion?: string | null,
): string[] {
  if (urls.length < 2) return urls;

  // For each URL, try to split it into (prefix, version, suffix).
  // If no version segment is found, it's unversioned.
  interface ParsedUrl {
    url: string;
    prefix: string; // path segments before the version
    version: string | null; // the version segment, or null if unversioned
    suffix: string; // path segments after the version
    key: string; // prefix + suffix, used for grouping
  }

  const parsed: ParsedUrl[] = [];
  for (const url of urls) {
    try {
      const u = new URL(url);
      const segments = u.pathname.split('/').filter(Boolean);
      let versionIdx = -1;
      for (let i = 0; i < segments.length; i++) {
        if (VERSION_SEGMENT.test(segments[i])) {
          versionIdx = i;
          break;
        }
      }

      if (versionIdx >= 0) {
        const prefix = segments.slice(0, versionIdx).join('/');
        const suffix = segments.slice(versionIdx + 1).join('/');
        parsed.push({
          url,
          prefix,
          version: segments[versionIdx],
          suffix,
          key: [prefix, suffix].filter(Boolean).join('/'),
        });
      } else {
        // Unversioned: key is the full path so it can group with versioned
        // variants that have the same prefix + suffix.
        parsed.push({
          url,
          prefix: segments.join('/'),
          version: null,
          suffix: '',
          key: segments.join('/'),
        });
      }
    } catch {
      parsed.push({ url, prefix: '', version: null, suffix: '', key: url });
    }
  }

  // Group by key to find duplicates
  const groups = new Map<string, ParsedUrl[]>();
  for (const p of parsed) {
    if (!groups.has(p.key)) groups.set(p.key, []);
    groups.get(p.key)!.push(p);
  }

  // Count how many URLs are in groups with multiple versions
  const duplicatedCount = Array.from(groups.values())
    .filter((g) => g.length > 1)
    .reduce((sum, g) => sum + g.length, 0);

  // Only deduplicate if a significant portion (>=20%) of URLs have version duplicates
  if (duplicatedCount < urls.length * 0.2) return urls;

  // For each group, pick the best variant
  const result: string[] = [];
  const seen = new Set<string>();

  for (const p of parsed) {
    if (seen.has(p.key)) continue;
    seen.add(p.key);

    const group = groups.get(p.key)!;
    if (group.length === 1) {
      result.push(group[0].url);
      continue;
    }

    // If the user's base URL contains a specific version, prefer that
    if (preferredVersion) {
      const match = group.find((g) => g.version?.toLowerCase() === preferredVersion.toLowerCase());
      if (match) {
        result.push(match.url);
        continue;
      }
    }

    // Default priority: unversioned > latest/stable/current > highest version
    const unversioned = group.find((g) => g.version === null);
    if (unversioned) {
      result.push(unversioned.url);
      continue;
    }

    const latestStable = group.find((g) => /^(latest|stable|current)$/i.test(g.version ?? ''));
    if (latestStable) {
      result.push(latestStable.url);
      continue;
    }

    // Pick the highest version by string sort, excluding pre-release channels
    // (dev, next, nightly, canary) which should only win as a last resort.
    const isPreRelease = (v: string | null) => /^(dev|next|nightly|canary)$/i.test(v ?? '');
    const stable = group.filter((g) => !isPreRelease(g.version));

    if (stable.length > 0) {
      const sorted = [...stable].sort((a, b) =>
        (b.version ?? '').localeCompare(a.version ?? '', undefined, { numeric: true }),
      );
      result.push(sorted[0].url);
    } else {
      // All variants are pre-release — pick the first one
      result.push(group[0].url);
    }
  }

  return result;
}

async function fetchSitemap(
  ctx: CheckContext,
  sitemapUrl: string,
  warnings: string[],
): Promise<{ urls: string[]; sitemapIndexUrls: string[] }> {
  if (isGzipped(sitemapUrl)) {
    warnings.push(`Skipped gzipped sitemap (not supported): ${sitemapUrl}`);
    return { urls: [], sitemapIndexUrls: [] };
  }

  try {
    const response = await ctx.http.fetch(sitemapUrl);
    if (!response.ok) return { urls: [], sitemapIndexUrls: [] };
    const xml = await response.text();
    return parseSitemapUrls(xml);
  } catch {
    return { urls: [], sitemapIndexUrls: [] };
  }
}

export interface SitemapOptions {
  maxUrls?: number;
  originOverride?: string;
  pathFilterBase?: string;
  /** Skip URL-level locale/version refinement. Use when the caller needs raw URLs (e.g. freshness coverage). */
  skipRefinement?: boolean;
}

export async function getUrlsFromSitemap(
  ctx: CheckContext,
  warnings: string[],
  opts: SitemapOptions = {},
): Promise<string[]> {
  const { maxUrls = MAX_SITEMAP_URLS, originOverride, pathFilterBase, skipRefinement } = opts;
  const sitemapUrls = await discoverSitemapUrls(ctx, originOverride);
  const urls: string[] = [];
  const matchOrigin = originOverride ?? ctx.origin;

  // Pre-compute the path prefix so we can filter before counting against the cap.
  // When pathFilterBase is provided, only URLs under that prefix consume cap slots.
  const prefixPath = pathFilterBase ? new URL(pathFilterBase).pathname.replace(/\/$/, '') : '';

  function shouldInclude(url: string): boolean {
    try {
      const u = new URL(url);
      if (u.origin !== matchOrigin) return false;
      if (prefixPath) return matchesPathPrefix(url, prefixPath);
      return true;
    } catch {
      return false;
    }
  }

  // Collect up to collectLimit URLs before refinement. The cap is applied
  // *after* locale/version filtering so that deduplication can see the full
  // version spectrum rather than an arbitrary prefix of the sitemap.
  const collectLimit = skipRefinement ? maxUrls : maxUrls * 20;

  for (const sitemapUrl of sitemapUrls) {
    if (urls.length >= collectLimit) break;

    const parsed = await fetchSitemap(ctx, sitemapUrl, warnings);

    // Add direct URLs (filtered to same origin and path prefix)
    for (const url of parsed.urls) {
      if (urls.length >= collectLimit) break;
      if (shouldInclude(url)) {
        urls.push(url);
      }
    }

    // Follow one level of sitemap index, filtering to default locale if detected
    if (parsed.sitemapIndexUrls.length > 0 && urls.length < collectLimit) {
      const filteredSubSitemaps = filterLocaleSitemaps(
        parsed.sitemapIndexUrls,
        ctx.options.preferredLocale ?? extractLocaleFromUrl(ctx.baseUrl),
      );
      for (const subSitemapUrl of filteredSubSitemaps) {
        if (urls.length >= collectLimit) break;

        const subParsed = await fetchSitemap(ctx, subSitemapUrl, warnings);

        for (const url of subParsed.urls) {
          if (urls.length >= collectLimit) break;
          if (shouldInclude(url)) {
            urls.push(url);
          }
        }
      }
    }
  }

  if (skipRefinement) return urls;

  const localeFiltered = filterLocalizedUrls(
    urls,
    ctx.options.preferredLocale ?? extractLocaleFromUrl(ctx.baseUrl),
  );
  const deduplicated = deduplicateVersionedUrls(
    localeFiltered,
    ctx.options.preferredVersion ?? extractVersionFromUrl(ctx.baseUrl),
  );
  return deduplicated.slice(0, maxUrls);
}

/**
 * Get the base URL for path-prefix filtering, accounting for cross-host redirects.
 *
 * When a cross-host redirect is in play (e.g. example.com/docs → docs.example.com),
 * the original baseUrl path doesn't apply to the redirected host, so we return the
 * effectiveOrigin (a root URL) which makes path filtering a no-op.
 */
export function getPathFilterBase(ctx: CheckContext): string {
  return ctx.effectiveOrigin && ctx.effectiveOrigin !== ctx.origin
    ? ctx.effectiveOrigin
    : ctx.baseUrl;
}

/**
 * Rewrite the filter base URL when explicit locale/version preferences
 * override values detected in the base URL path.
 *
 * For example, base URL `example.com/en/docs` with `--locale de` rewrites
 * to `example.com/de/docs` so that path prefix filtering matches the
 * preferred locale's URL space.
 */
function rewriteFilterBase(
  filterBase: string,
  preferredLocale?: string,
  preferredVersion?: string,
): string {
  if (!preferredLocale && !preferredVersion) return filterBase;

  try {
    const url = new URL(filterBase);
    const segments = url.pathname.split('/').filter(Boolean);

    if (preferredLocale) {
      const detected = extractLocaleFromUrl(filterBase);
      if (detected && detected !== preferredLocale.toLowerCase()) {
        const idx = segments.findIndex((s) => s.toLowerCase() === detected);
        if (idx >= 0) segments[idx] = preferredLocale.toLowerCase();
      }
    }

    if (preferredVersion) {
      const detected = extractVersionFromUrl(filterBase);
      if (detected && detected.toLowerCase() !== preferredVersion.toLowerCase()) {
        const idx = segments.findIndex((s) => s === detected);
        if (idx >= 0) segments[idx] = preferredVersion;
      }
    }

    url.pathname = '/' + segments.join('/');
    return url.toString().replace(/\/$/, '');
  } catch {
    return filterBase;
  }
}

/**
 * Check whether a single URL falls under the given path prefix.
 *
 * Returns true when the baseUrl is at the root (no filtering needed),
 * when the URL matches the prefix, or when the URL is malformed
 * (kept rather than silently dropped).
 */
export function matchesPathPrefix(url: string, baseUrlPath: string): boolean {
  if (!baseUrlPath || baseUrlPath === '') return true;
  try {
    const parsed = new URL(url);
    return parsed.pathname === baseUrlPath || parsed.pathname.startsWith(baseUrlPath + '/');
  } catch {
    return true; // keep malformed URLs rather than silently dropping them
  }
}

/**
 * Filter URLs to those under the baseUrl's path prefix.
 *
 * When the input URL has a non-root path (e.g. `https://plaid.com/docs`),
 * only URLs whose pathname starts with that prefix are kept. This prevents
 * blog posts, marketing pages, and other non-docs content from polluting
 * the URL pool when llms.txt or sitemaps cover the entire domain.
 *
 * Root URLs (path is `/`) pass all same-origin URLs through unfiltered.
 */
export function filterByPathPrefix(urls: string[], baseUrl: string): string[] {
  const baseUrlPath = new URL(baseUrl).pathname.replace(/\/$/, '');
  return urls.filter((url) => matchesPathPrefix(url, baseUrlPath));
}

/**
 * Merge two URL arrays, preserving order. Primary URLs come first;
 * secondary URLs are appended only if not already present.
 */
function mergeUrlSets(primary: string[], secondary: string[]): string[] {
  const seen = new Set(primary);
  const merged = [...primary];
  for (const url of secondary) {
    if (!seen.has(url)) {
      merged.push(url);
      seen.add(url);
    }
  }
  return merged;
}

/**
 * Discover page URLs from llms.txt links, sitemap, or fall back to baseUrl.
 *
 * Priority:
 * 1. llms.txt links (from previous check results or direct fetch)
 * 2. Sitemap URLs (robots.txt Sitemap directives, then /sitemap.xml fallback)
 * 3. baseUrl fallback
 *
 * When llms.txt produces URLs but fewer than `maxLinksToTest`, sitemap
 * URLs are merged in (deduped) so the sample covers a broader surface.
 * The `sources` field records which discovery methods contributed.
 *
 * All discovered URLs are filtered to the baseUrl's path prefix so that
 * docs at a subpath (e.g. `/docs`) don't include unrelated site content.
 */
export async function getPageUrls(ctx: CheckContext): Promise<PageUrlResult> {
  const warnings: string[] = [];
  const sources: DiscoverySource[] = [];

  const locale = ctx.options.preferredLocale ?? extractLocaleFromUrl(ctx.baseUrl);
  const version = ctx.options.preferredVersion ?? extractVersionFromUrl(ctx.baseUrl);
  const filterBase = rewriteFilterBase(
    getPathFilterBase(ctx),
    ctx.options.preferredLocale,
    ctx.options.preferredVersion,
  );

  /** Apply locale and version filtering to a discovered URL set. */
  function refineUrls(urls: string[]): string[] {
    const localeFiltered = filterLocalizedUrls(urls, locale);
    return deduplicateVersionedUrls(localeFiltered, version);
  }

  // 1. Try llms.txt links from cached results (if llms-txt-exists ran)
  const cachedUrls = await getUrlsFromCachedLlmsTxt(ctx);
  let llmsTxtUrls = refineUrls(filterByPathPrefix(cachedUrls, filterBase));

  // 2. Try fetching llms.txt directly (standalone mode, llms-txt-exists didn't run)
  if (llmsTxtUrls.length === 0 && !ctx.previousResults.has('llms-txt-exists')) {
    const fetchedUrls = await fetchLlmsTxtUrls(ctx);
    llmsTxtUrls = refineUrls(filterByPathPrefix(fetchedUrls, filterBase));
  }

  if (llmsTxtUrls.length > 0) {
    sources.push('llms-txt');

    // If llms.txt meets the requested sample size, no need for sitemap
    if (llmsTxtUrls.length >= ctx.options.maxLinksToTest) {
      return { urls: llmsTxtUrls, warnings, sources };
    }

    // llms.txt is thin — try sitemap to fill the gap
    const sitemapUrls = await getUrlsFromSitemap(ctx, warnings, { pathFilterBase: filterBase });
    if (sitemapUrls.length > 0) {
      sources.push('sitemap');
      return { urls: mergeUrlSets(llmsTxtUrls, sitemapUrls), warnings, sources };
    }

    // Sitemap had nothing; return llms.txt URLs alone
    return { urls: llmsTxtUrls, warnings, sources };
  }

  // 3. Try sitemap (path, locale, and version filtering applied inside)
  const sitemapUrls = await getUrlsFromSitemap(ctx, warnings, { pathFilterBase: filterBase });
  if (sitemapUrls.length > 0) {
    sources.push('sitemap');
    return { urls: sitemapUrls, warnings, sources };
  }

  // 4. Fallback
  sources.push('fallback');
  return { urls: [ctx.baseUrl], warnings, sources };
}

export interface SampledPages {
  urls: string[];
  totalPages: number;
  sampled: boolean;
  warnings: string[];
  /** When curated pages have tags, maps page URL to tag label. */
  urlTags?: Record<string, string>;
  /** Which discovery methods contributed to the page URL set. */
  sources?: DiscoverySource[];
}

/**
 * Discover page URLs and sample down to maxLinksToTest if needed.
 * Consolidates the discover+shuffle+sample pattern used by multiple checks.
 *
 * The result is cached on ctx so that all checks within a single run
 * share the same sampled page list, avoiding inconsistent results.
 *
 * Sampling strategies:
 * - `random`: Fisher-Yates shuffle, then take the first maxLinksToTest. (Default.)
 * - `deterministic`: Sort URLs lexicographically, then pick every Nth URL
 *   so that the result is reproducible across runs (as long as the discovered
 *   URL set is stable).
 * - `none`: Skip discovery entirely; return only the baseUrl.
 */
export async function discoverAndSamplePages(ctx: CheckContext): Promise<SampledPages> {
  if (ctx._sampledPages) return ctx._sampledPages;

  const strategy = ctx.options.samplingStrategy;

  // "curated" uses explicitly listed pages from config or --urls.
  if (strategy === 'curated') {
    const entries = ctx._curatedPages;
    if (!entries || entries.length === 0) {
      ctx._sampledPages = {
        urls: [ctx.baseUrl],
        totalPages: 1,
        sampled: false,
        warnings: ['Curated strategy selected but no pages defined; falling back to base URL'],
      };
      return ctx._sampledPages;
    }

    const urls: string[] = [];
    const urlTags: Record<string, string> = {};
    for (const entry of entries) {
      if (typeof entry === 'string') {
        urls.push(entry);
      } else {
        urls.push(entry.url);
        if (entry.tag) {
          urlTags[entry.url] = entry.tag;
        }
      }
    }

    ctx._sampledPages = {
      urls,
      totalPages: urls.length,
      sampled: false,
      warnings: [],
      urlTags: Object.keys(urlTags).length > 0 ? urlTags : undefined,
    };
    return ctx._sampledPages;
  }

  // "none" skips discovery and uses only the URL the user provided.
  if (strategy === 'none') {
    ctx._sampledPages = {
      urls: [ctx.baseUrl],
      totalPages: 1,
      sampled: false,
      warnings: [],
    };
    return ctx._sampledPages;
  }

  const discovery = await getPageUrls(ctx);
  let urls = discovery.urls;
  const totalPages = urls.length;

  const sampled = totalPages > ctx.options.maxLinksToTest;
  if (sampled) {
    if (strategy === 'deterministic') {
      // Sort lexicographically for a stable ordering, then pick evenly-spaced URLs.
      urls.sort();
      const stride = urls.length / ctx.options.maxLinksToTest;
      const picked: string[] = [];
      for (let i = 0; i < ctx.options.maxLinksToTest; i++) {
        picked.push(urls[Math.floor(i * stride)]);
      }
      urls = picked;
    } else {
      // "random" — Fisher-Yates shuffle
      for (let i = urls.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [urls[i], urls[j]] = [urls[j], urls[i]];
      }
      urls = urls.slice(0, ctx.options.maxLinksToTest);
    }
  }

  ctx._sampledPages = {
    urls,
    totalPages,
    sampled,
    warnings: discovery.warnings,
    sources: discovery.sources,
  };
  return ctx._sampledPages;
}
