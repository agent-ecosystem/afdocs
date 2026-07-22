import { registerCheck } from '../registry.js';
import { discoverAndSamplePages } from '../../helpers/get-page-urls.js';
import { SOFT_404_PATTERNS } from '../../helpers/detect-soft-404.js';
import type { CheckContext, CheckResult } from '../../types.js';
import { pageLabel, t } from '../../i18n/index.js';

interface StatusCodeResult {
  url: string;
  testUrl: string;
  status: number | null;
  classification: 'correct-error' | 'soft-404' | 'indeterminate' | 'fetch-error';
  redirected?: boolean;
  finalUrl?: string;
  bodyHint?: string;
  indeterminateReason?: string;
  error?: string;
}

/** Generate a sibling URL that almost certainly doesn't exist. */
function makeBadUrl(pageUrl: string): string {
  const u = new URL(pageUrl);
  u.hash = ''; // strip fragment — servers don't see it anyway
  u.pathname = u.pathname.replace(/\/?$/, '-afdocs-nonexistent-8f3a');
  return u.toString();
}

async function check(ctx: CheckContext): Promise<CheckResult> {
  const id = 'http-status-codes';
  const category = 'url-stability';

  const { urls: pageUrls, totalPages, sampled, warnings } = await discoverAndSamplePages(ctx);

  const results: StatusCodeResult[] = [];
  const concurrency = ctx.options.maxConcurrency;

  for (let i = 0; i < pageUrls.length; i += concurrency) {
    const batch = pageUrls.slice(i, i + concurrency);
    const batchResults = await Promise.all(
      batch.map(async (url): Promise<StatusCodeResult> => {
        const testUrl = makeBadUrl(url);
        try {
          // Follow redirects so we classify based on the final response.
          // A redirect chain ending in 404 is correct; one ending in 200 is a soft 404.
          const response = await ctx.http.fetch(testUrl);
          const status = response.status;
          const redirected = response.redirected || response.url !== testUrl;
          const finalUrl = redirected ? response.url : undefined;

          if (status >= 400 && status < 500) {
            return { url, testUrl, status, classification: 'correct-error', redirected, finalUrl };
          }

          // 202 Accepted: per RFC 7231, the request is being processed but not
          // complete. Vercel/Next.js ISR returns this during cache-miss/build
          // for fresh URLs — it's a CDN behavior, not site-level error handling.
          // 5xx: server failure tells us nothing about how the site handles
          // bad URLs. Both are excluded from the soft-404 tally.
          if (status === 202 || status >= 500) {
            const reason =
              status === 202
                ? 'HTTP 202 (CDN still processing — not a site response)'
                : `HTTP ${status} (server error — bad-URL handling unknown)`;
            return {
              url,
              testUrl,
              status,
              classification: 'indeterminate',
              redirected,
              finalUrl,
              indeterminateReason: reason,
            };
          }

          // Status 200 (or other 2xx/3xx) — possible soft 404
          let bodyHint: string | undefined;
          try {
            const body = await response.text();
            if (SOFT_404_PATTERNS.test(body.slice(0, 5000))) {
              bodyHint = 'Body contains "not found" / "404" text';
            }
          } catch {
            // ignore body read errors
          }

          return {
            url,
            testUrl,
            status,
            classification: 'soft-404',
            redirected,
            finalUrl,
            bodyHint,
          };
        } catch (err) {
          return {
            url,
            testUrl,
            status: null,
            classification: 'fetch-error',
            error: err instanceof Error ? err.message : String(err),
          };
        }
      }),
    );
    results.push(...batchResults);
  }

  const tested = results.filter((r) => r.classification !== 'fetch-error');
  const fetchErrors = results.filter((r) => r.classification === 'fetch-error').length;
  const soft404s = results.filter((r) => r.classification === 'soft-404');
  const correctErrors = results.filter((r) => r.classification === 'correct-error');
  const indeterminate = results.filter((r) => r.classification === 'indeterminate');
  const determinate = correctErrors.length + soft404s.length;

  if (tested.length === 0) {
    return {
      id,
      category,
      status: 'fail',
      message: t('check.http-status-codes.error_none', {
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

  const label = pageLabel(sampled);
  const fetchSuffix =
    fetchErrors > 0 ? t('common.fetch_errors_suffix', { count: fetchErrors }) : '';
  const indetSuffix =
    indeterminate.length > 0 ? `; ${indeterminate.length} indeterminate (HTTP 202/5xx)` : '';
  const suffix = `${fetchSuffix}${indetSuffix}`;

  let status: 'pass' | 'warn' | 'fail';
  let message: string;
  if (determinate === 0) {
    // Every response was indeterminate (e.g. all 202 or 5xx). We can't say
    // whether the site handles bad URLs correctly.
    status = 'warn';
    message = t('check.http-status-codes.warn_indeterminate', {
      count: indeterminate.length,
      pageLabel: label,
      suffix: fetchSuffix,
    });
  } else if (soft404s.length > 0) {
    status = 'fail';
    message = t('check.http-status-codes.fail_soft404', {
      soft404s: soft404s.length,
      determinate,
      pageLabel: label,
      suffix,
    });
  } else {
    status = 'pass';
    message = t('check.http-status-codes.pass', { determinate, pageLabel: label, suffix });
  }

  return {
    id,
    category,
    status,
    message,
    details: {
      totalPages,
      testedPages: results.length,
      sampled,
      soft404Count: soft404s.length,
      correctErrorCount: correctErrors.length,
      indeterminateCount: indeterminate.length,
      fetchErrors,
      pageResults: results,
      discoveryWarnings: warnings,
    },
  };
}

registerCheck({
  id: 'http-status-codes',
  category: 'url-stability',
  description: 'Whether error pages return correct HTTP status codes',
  dependsOn: [],
  run: check,
});
