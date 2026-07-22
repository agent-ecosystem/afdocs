import { registerCheck } from '../registry.js';
import { discoverAndSamplePages } from '../../helpers/get-page-urls.js';
import type { CheckContext, CheckResult } from '../../types.js';
import { t } from '../../i18n/index.js';

type PageClassification = 'accessible' | 'auth-required' | 'soft-auth-gate' | 'auth-redirect';

interface AuthResult {
  url: string;
  classification: PageClassification;
  status: number | null;
  redirectUrl?: string;
  ssoDomain?: string;
  hint?: string;
  error?: string;
}

const SSO_DOMAINS = [
  'okta.com',
  'auth0.com',
  'login.microsoftonline.com',
  'accounts.google.com',
  'login.salesforce.com',
  'sso.',
  'idp.',
  'auth.',
  'login.',
];

function isSsoDomain(url: string): string | undefined {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    return SSO_DOMAINS.find(
      (domain) =>
        hostname === domain || hostname.endsWith('.' + domain) || hostname.startsWith(domain),
    );
  } catch {
    return undefined;
  }
}

function detectLoginForm(body: string): string | undefined {
  const sample = body.slice(0, 50000).toLowerCase();

  if (sample.includes('<input') && sample.includes('type="password"')) {
    return 'Contains password input field';
  }

  // Check page title for login indicators.
  // Only match titles that suggest the page IS a login form, not pages that
  // mention login as a topic (e.g. "unable to login" in a knowledge base article).
  // We require the login keyword to appear at the start or after a separator.
  const titleMatch = /<title[^>]*>(.*?)<\/title>/i.exec(sample);
  if (titleMatch) {
    const title = titleMatch[1].toLowerCase().trim();
    if (
      /^(sign\s*in|log\s*in)\b/.test(title) ||
      /[|\-–—:]\s*(sign\s*in|log\s*in)\s*$/i.test(title) ||
      /^authenticate\b/.test(title)
    ) {
      return `Page title suggests login: "${titleMatch[1].trim()}"`;
    }
  }

  // Check for SSO form actions
  if (/<form[^>]*action\s*=\s*["'][^"']*(?:saml|oauth|openid|sso|auth)[^"']*["']/i.test(sample)) {
    return 'Contains SSO-related form action';
  }

  return undefined;
}

async function check(ctx: CheckContext): Promise<CheckResult> {
  const id = 'auth-gate-detection';
  const category = 'authentication';

  const { urls: pageUrls, totalPages, sampled, warnings } = await discoverAndSamplePages(ctx);

  const results: AuthResult[] = [];
  const concurrency = ctx.options.maxConcurrency;

  for (let i = 0; i < pageUrls.length; i += concurrency) {
    const batch = pageUrls.slice(i, i + concurrency);
    const batchResults = await Promise.all(
      batch.map(async (url): Promise<AuthResult> => {
        try {
          const response = await ctx.http.fetch(url, { redirect: 'manual' });
          const status = response.status;

          // Auth-required status codes
          if (status === 401 || status === 403) {
            return { url, classification: 'auth-required', status };
          }

          // Redirect — check if it's to an SSO domain
          if (status >= 300 && status < 400) {
            const location = response.headers.get('location');
            if (location) {
              const resolvedLocation = location.startsWith('http')
                ? location
                : new URL(location, url).toString();
              const ssoDomain = isSsoDomain(resolvedLocation);
              if (ssoDomain) {
                return {
                  url,
                  classification: 'auth-redirect',
                  status,
                  redirectUrl: resolvedLocation,
                  ssoDomain,
                };
              }
            }
            // Non-SSO redirect — treat as accessible (normal redirect)
            return { url, classification: 'accessible', status };
          }

          // 200 — check for soft auth gate (login form)
          if (status === 200) {
            let body: string;
            try {
              body = await response.text();
            } catch {
              return { url, classification: 'accessible', status };
            }

            const loginHint = detectLoginForm(body);
            if (loginHint) {
              return { url, classification: 'soft-auth-gate', status, hint: loginHint };
            }

            return { url, classification: 'accessible', status };
          }

          // Other status codes — treat as accessible
          return { url, classification: 'accessible', status };
        } catch (err) {
          return {
            url,
            classification: 'accessible',
            status: null,
            error: err instanceof Error ? err.message : String(err),
          };
        }
      }),
    );
    results.push(...batchResults);
  }

  const fetchErrors = results.filter((r) => r.error).length;
  const tested = results.filter((r) => !r.error);

  if (tested.length === 0) {
    return {
      id,
      category,
      status: 'fail',
      message: t('check.auth-gate-detection.error_none', {
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

  const accessible = tested.filter((r) => r.classification === 'accessible');
  const authRequired = tested.filter((r) => r.classification === 'auth-required');
  const softAuthGate = tested.filter((r) => r.classification === 'soft-auth-gate');
  const authRedirect = tested.filter((r) => r.classification === 'auth-redirect');
  const gatedCount = authRequired.length + softAuthGate.length + authRedirect.length;

  const ssoDomains = [...new Set(authRedirect.map((r) => r.ssoDomain).filter(Boolean) as string[])];

  let status: 'pass' | 'warn' | 'fail';
  let message: string;
  const suffix = fetchErrors > 0 ? t('common.fetch_errors_suffix', { count: fetchErrors }) : '';
  const pageLabel = sampled ? t('common.sampled_pages') : t('common.pages');

  if (gatedCount === 0) {
    status = 'pass';
    message = t('check.auth-gate-detection.pass', { count: accessible.length, pageLabel, suffix });
  } else if (accessible.length > 0 && gatedCount > 0) {
    status = 'warn';
    message = t('check.auth-gate-detection.warn', {
      gated: gatedCount,
      total: tested.length,
      pageLabel,
      accessible: accessible.length,
      suffix,
    });
  } else {
    status = 'fail';
    message = t('check.auth-gate-detection.fail', { total: tested.length, pageLabel, suffix });
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
      accessible: accessible.length,
      authRequired: authRequired.length,
      softAuthGate: softAuthGate.length,
      authRedirect: authRedirect.length,
      ssoDomains,
      fetchErrors,
      pageResults: results,
      discoveryWarnings: warnings,
    },
  };
}

registerCheck({
  id: 'auth-gate-detection',
  category: 'authentication',
  description: 'Whether documentation pages require authentication to access content',
  dependsOn: [],
  run: check,
});
