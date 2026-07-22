import { registerCheck } from '../registry.js';
import { discoverAndSamplePages } from '../../helpers/get-page-urls.js';
import { isCrossHostRedirect } from '../../helpers/to-md-urls.js';
import type { CheckContext, CheckResult } from '../../types.js';
import { t } from '../../i18n/index.js';

interface RedirectResult {
  url: string;
  status: number | null;
  classification: 'no-redirect' | 'same-host' | 'cross-host' | 'js-redirect' | 'fetch-error';
  redirectTarget?: string;
  error?: string;
}

const JS_REDIRECT_PATTERNS =
  /(?:window|document)\.location\s*=(?!=)|location\.href\s*=(?!=)|location\.(?:replace|assign)\s*\(|<meta[^>]+http-equiv\s*=\s*["']?refresh["']?/i;

/** Strip <pre> and <code> block contents so code examples don't trigger false positives. */
const CODE_BLOCK_RE = /<(pre|code)\b[^>]*>[\s\S]*?<\/\1>/gi;

async function check(ctx: CheckContext): Promise<CheckResult> {
  const id = 'redirect-behavior';
  const category = 'url-stability';

  const { urls: pageUrls, totalPages, sampled, warnings } = await discoverAndSamplePages(ctx);

  const results: RedirectResult[] = [];
  const concurrency = ctx.options.maxConcurrency;

  for (let i = 0; i < pageUrls.length; i += concurrency) {
    const batch = pageUrls.slice(i, i + concurrency);
    const batchResults = await Promise.all(
      batch.map(async (url): Promise<RedirectResult> => {
        try {
          // Use manual redirect to inspect the first response
          const response = await ctx.http.fetch(url, { redirect: 'manual' });
          const status = response.status;

          // Not a redirect
          if (status < 300 || status >= 400) {
            // Check for JS-based redirects in the body
            try {
              const body = await response.text();
              const sample = body.slice(0, 10_000).replace(CODE_BLOCK_RE, '');
              if (JS_REDIRECT_PATTERNS.test(sample)) {
                return { url, status, classification: 'js-redirect' };
              }
            } catch {
              // ignore body read errors
            }
            return { url, status, classification: 'no-redirect' };
          }

          // HTTP redirect — classify as same-host or cross-host
          const location = response.headers.get('location');
          if (!location) {
            return { url, status, classification: 'no-redirect' };
          }

          const resolvedTarget = new URL(location, url).toString();

          if (isCrossHostRedirect(url, resolvedTarget)) {
            return { url, status, classification: 'cross-host', redirectTarget: resolvedTarget };
          }
          return { url, status, classification: 'same-host', redirectTarget: resolvedTarget };
        } catch (err) {
          return {
            url,
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
  const noRedirects = results.filter((r) => r.classification === 'no-redirect');
  const sameHost = results.filter((r) => r.classification === 'same-host');
  const crossHost = results.filter((r) => r.classification === 'cross-host');
  const jsRedirects = results.filter((r) => r.classification === 'js-redirect');

  if (tested.length === 0) {
    return {
      id,
      category,
      status: 'fail',
      message: t('check.redirect-behavior.error_none', {
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

  // Determine status: js-redirect → fail, cross-host → warn, otherwise pass
  let status: 'pass' | 'warn' | 'fail';
  if (jsRedirects.length > 0) {
    status = 'fail';
  } else if (crossHost.length > 0) {
    status = 'warn';
  } else {
    status = 'pass';
  }

  const pageLabel = sampled ? t('common.sampled_pages') : t('common.pages');
  const suffix = fetchErrors > 0 ? t('common.fetch_errors_suffix', { count: fetchErrors }) : '';

  let message: string;
  if (status === 'pass') {
    const redirectCount = sameHost.length;
    if (redirectCount === 0) {
      message = t('check.redirect-behavior.pass_none', { total: tested.length, pageLabel, suffix });
    } else {
      message = t('check.redirect-behavior.pass_same_host', {
        redirects: redirectCount,
        total: tested.length,
        pageLabel,
        suffix,
      });
    }
  } else if (status === 'warn') {
    message = t('check.redirect-behavior.warn_cross_host', {
      crossHost: crossHost.length,
      total: tested.length,
      pageLabel,
      suffix,
    });
  } else {
    const parts: string[] = [];
    if (jsRedirects.length > 0) {
      parts.push(t('check.redirect-behavior.part_js', { count: jsRedirects.length }));
    }
    if (crossHost.length > 0) {
      parts.push(t('check.redirect-behavior.part_cross_host', { count: crossHost.length }));
    }
    message = t('check.redirect-behavior.fail_mixed', {
      parts: parts.join(t('check.redirect-behavior.and')),
      total: tested.length,
      pageLabel,
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
      noRedirectCount: noRedirects.length,
      sameHostCount: sameHost.length,
      crossHostCount: crossHost.length,
      jsRedirectCount: jsRedirects.length,
      fetchErrors,
      pageResults: results,
      discoveryWarnings: warnings,
    },
  };
}

registerCheck({
  id: 'redirect-behavior',
  category: 'url-stability',
  description: 'Whether redirects are same-host HTTP redirects',
  dependsOn: [],
  run: check,
});
