import { registerCheck } from '../registry.js';
import { discoverAndSamplePages } from '../../helpers/get-page-urls.js';
import { analyzeRendering, hasSubstantiveContent } from '../../helpers/detect-rendering.js';
import type { CheckContext, CheckResult } from '../../types.js';

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
  //
  // The title is the weakest signal here, so it is hedged twice:
  //
  // 1. Only login-intent phrases count ("sign in", "log in", "login"), and only
  //    at the start of the title or after a separator. Pages that mention
  //    login as a topic ("unable to login" in a knowledge base article) do not
  //    match. Bare "authenticate"/"authentication" is deliberately not a
  //    pattern: real login walls title themselves "Sign in"/"Log in", while
  //    "Authenticate ..." is a common title for public API reference pages
  //    about auth endpoints (issue #107).
  // 2. A matching title alone does not classify the page. If the body carries
  //    substantive documentation content (headings, prose, code blocks, as
  //    measured by the rendering analysis), it is a docs page about signing
  //    in, not a login form. A real login page has a near-empty body, and one
  //    that does not almost always has a password input or SSO form action,
  //    which are matched on their own above and below.
  const titleMatch = /<title[^>]*>(.*?)<\/title>/i.exec(sample);
  if (titleMatch) {
    const title = titleMatch[1].toLowerCase().trim();
    if (
      (/^(sign\s*in|log\s*in)\b/.test(title) ||
        /[|\-–—:]\s*(sign\s*in|log\s*in)\s*$/i.test(title)) &&
      !hasSubstantiveContent(analyzeRendering(body))
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
      message: `Could not fetch any pages to check authentication${fetchErrors > 0 ? `; ${fetchErrors} failed to fetch` : ''}`,
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
  const suffix = fetchErrors > 0 ? `; ${fetchErrors} failed to fetch` : '';
  const pageLabel = sampled ? 'sampled pages' : 'pages';

  if (gatedCount === 0) {
    status = 'pass';
    message = `All ${accessible.length} ${pageLabel} are publicly accessible${suffix}`;
  } else if (accessible.length > 0 && gatedCount > 0) {
    status = 'warn';
    message = `${gatedCount} of ${tested.length} ${pageLabel} require authentication (${accessible.length} accessible)${suffix}`;
  } else {
    status = 'fail';
    message = `All ${tested.length} ${pageLabel} require authentication${suffix}`;
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
