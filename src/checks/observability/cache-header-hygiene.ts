import { registerCheck } from '../registry.js';
import { discoverAndSamplePages } from '../../helpers/get-page-urls.js';
import type { CheckContext, CheckResult, CheckStatus, DiscoveredFile } from '../../types.js';
import { t } from '../../i18n/index.js';

interface CacheResult {
  url: string;
  cacheControl: string | null;
  maxAge: number | null;
  sMaxAge: number | null;
  mustRevalidate: boolean;
  noCache: boolean;
  noStore: boolean;
  etag: string | null;
  lastModified: string | null;
  expires: string | null;
  effectiveMaxAge: number | null;
  status: CheckStatus;
  error?: string;
}

function parseCacheControl(header: string | null): {
  maxAge: number | null;
  sMaxAge: number | null;
  mustRevalidate: boolean;
  noCache: boolean;
  noStore: boolean;
} {
  if (!header)
    return { maxAge: null, sMaxAge: null, mustRevalidate: false, noCache: false, noStore: false };

  const directives = header
    .toLowerCase()
    .split(',')
    .map((d) => d.trim());
  let maxAge: number | null = null;
  let sMaxAge: number | null = null;
  let mustRevalidate = false;
  let noCache = false;
  let noStore = false;

  for (const d of directives) {
    if (d.startsWith('max-age=')) {
      maxAge = parseInt(d.split('=')[1], 10);
      if (isNaN(maxAge)) maxAge = null;
    } else if (d.startsWith('s-maxage=')) {
      sMaxAge = parseInt(d.split('=')[1], 10);
      if (isNaN(sMaxAge)) sMaxAge = null;
    } else if (d === 'must-revalidate') {
      mustRevalidate = true;
    } else if (d === 'no-cache') {
      noCache = true;
    } else if (d === 'no-store') {
      noStore = true;
    }
  }

  return { maxAge, sMaxAge, mustRevalidate, noCache, noStore };
}

function classifyCache(result: Omit<CacheResult, 'status' | 'error'>): CheckStatus {
  // no-cache or no-store = always fresh
  if (result.noCache || result.noStore) return 'pass';

  // must-revalidate with a revalidation mechanism is good
  if (result.mustRevalidate && (result.etag || result.lastModified)) return 'pass';

  const effective = result.effectiveMaxAge;

  if (effective === null) {
    // No cache-related headers at all
    if (!result.cacheControl && !result.expires && !result.etag && !result.lastModified) {
      return 'fail';
    }
    // Has ETag/Last-Modified but no max-age — still ok (browser will revalidate)
    if (result.etag || result.lastModified) return 'pass';
    return 'fail';
  }

  if (effective <= 3600) return 'pass';
  if (effective <= 86400) return 'warn';
  return 'fail';
}

function getEffectiveMaxAge(
  parsed: { maxAge: number | null; sMaxAge: number | null },
  expires: string | null,
): number | null {
  // s-maxage takes precedence over max-age
  if (parsed.sMaxAge !== null) return parsed.sMaxAge;
  if (parsed.maxAge !== null) return parsed.maxAge;

  // Fall back to Expires header
  if (expires) {
    try {
      const expiresMs = new Date(expires).getTime();
      const nowMs = Date.now();
      if (!isNaN(expiresMs)) {
        return Math.max(0, Math.round((expiresMs - nowMs) / 1000));
      }
    } catch {
      // invalid date
    }
  }

  return null;
}

function worstStatus(statuses: CheckStatus[]): CheckStatus {
  if (statuses.includes('fail')) return 'fail';
  if (statuses.includes('warn')) return 'warn';
  return 'pass';
}

async function check(ctx: CheckContext): Promise<CheckResult> {
  const id = 'cache-header-hygiene';
  const category = 'observability';

  // Collect URLs to check: llms.txt files + sampled page URLs
  const urlsToCheck: string[] = [];

  // llms.txt URLs — intentionally checks ALL discovered files (not just the
  // canonical) so that multiple llms.txt locations (apex + docs) are each
  // expected to have appropriate cache headers.
  const existsResult = ctx.previousResults.get('llms-txt-exists');
  const discovered = (existsResult?.details?.discoveredFiles ?? []) as DiscoveredFile[];
  for (const file of discovered) {
    urlsToCheck.push(file.url);
  }

  // Page URLs
  const { urls: pageUrls, totalPages, sampled, warnings } = await discoverAndSamplePages(ctx);
  for (const url of pageUrls) {
    if (!urlsToCheck.includes(url)) {
      urlsToCheck.push(url);
    }
  }

  const results: CacheResult[] = [];
  const concurrency = ctx.options.maxConcurrency;

  for (let i = 0; i < urlsToCheck.length; i += concurrency) {
    const batch = urlsToCheck.slice(i, i + concurrency);
    const batchResults = await Promise.all(
      batch.map(async (url): Promise<CacheResult> => {
        try {
          const response = await ctx.http.fetch(url);
          const ccHeader = response.headers.get('cache-control');
          const parsed = parseCacheControl(ccHeader);
          const etag = response.headers.get('etag');
          const lastModified = response.headers.get('last-modified');
          const expires = response.headers.get('expires');
          const effectiveMaxAge = getEffectiveMaxAge(parsed, expires);

          const partial: Omit<CacheResult, 'status' | 'error'> = {
            url,
            cacheControl: ccHeader,
            maxAge: parsed.maxAge,
            sMaxAge: parsed.sMaxAge,
            mustRevalidate: parsed.mustRevalidate,
            noCache: parsed.noCache,
            noStore: parsed.noStore,
            etag,
            lastModified,
            expires,
            effectiveMaxAge,
          };

          return { ...partial, status: classifyCache(partial) };
        } catch (err) {
          return {
            url,
            cacheControl: null,
            maxAge: null,
            sMaxAge: null,
            mustRevalidate: false,
            noCache: false,
            noStore: false,
            etag: null,
            lastModified: null,
            expires: null,
            effectiveMaxAge: null,
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
    return {
      id,
      category,
      status: 'fail',
      message: t('check.cache-header-hygiene.error_none', {
        suffix: fetchErrors > 0 ? t('common.fetch_errors_suffix', { count: fetchErrors }) : '',
      }),
      details: {
        testedEndpoints: results.length,
        fetchErrors,
        endpointResults: results,
        discoveryWarnings: warnings,
      },
    };
  }

  const overallStatus = worstStatus(successful.map((r) => r.status));
  const passBucket = successful.filter((r) => r.status === 'pass').length;
  const warnBucket = successful.filter((r) => r.status === 'warn').length;
  const failBucket = successful.filter((r) => r.status === 'fail').length;
  const suffix = fetchErrors > 0 ? t('common.fetch_errors_suffix', { count: fetchErrors }) : '';

  let message: string;
  if (overallStatus === 'pass') {
    message = t('check.cache-header-hygiene.pass', { total: successful.length, suffix });
  } else if (overallStatus === 'warn') {
    message = t('check.cache-header-hygiene.warn', {
      warn: warnBucket,
      total: successful.length,
      suffix,
    });
  } else {
    message = t('check.cache-header-hygiene.fail', {
      failCount: failBucket,
      total: successful.length,
      suffix,
    });
  }

  return {
    id,
    category,
    status: overallStatus,
    message,
    details: {
      totalPages,
      testedEndpoints: results.length,
      sampled,
      passBucket,
      warnBucket,
      failBucket,
      fetchErrors,
      endpointResults: results,
      discoveryWarnings: warnings,
    },
  };
}

registerCheck({
  id: 'cache-header-hygiene',
  category: 'observability',
  description: 'Whether cache headers allow timely updates',
  dependsOn: [],
  run: check,
});
