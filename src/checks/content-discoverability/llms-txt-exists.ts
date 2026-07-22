import { registerCheck } from '../registry.js';
import { selectCanonicalLlmsTxt } from '../../helpers/llms-txt.js';
import { isCrossHostRedirect } from '../../helpers/to-md-urls.js';
import { t } from '../../i18n/index.js';
import type { CheckContext, CheckResult, DiscoveredFile } from '../../types.js';

/**
 * Build candidate URLs for llms.txt discovery.
 * Per spec: {base_url}/llms.txt, {origin}/llms.txt, {origin}/docs/llms.txt
 * Deduplicates.
 */
function getCandidateUrls(baseUrl: string, origin: string): string[] {
  const candidates = new Set<string>();
  candidates.add(`${baseUrl}/llms.txt`);
  candidates.add(`${origin}/llms.txt`);
  candidates.add(`${origin}/docs/llms.txt`);
  return Array.from(candidates);
}

async function checkLlmsTxtExists(ctx: CheckContext): Promise<CheckResult> {
  const explicitUrl = ctx.options.llmsTxtUrl;
  const candidates = explicitUrl ? [explicitUrl] : getCandidateUrls(ctx.baseUrl, ctx.origin);
  const discovered: DiscoveredFile[] = [];
  const checkedUrls: Array<{
    url: string;
    status: number;
    redirected: boolean;
    finalUrl?: string;
    error?: string;
  }> = [];

  for (const url of candidates) {
    try {
      const response = await ctx.http.fetch(url);
      const contentType = response.headers.get('content-type') ?? '';
      const isText = contentType.includes('text/');

      checkedUrls.push({
        url,
        status: response.status,
        redirected: response.redirected,
        finalUrl: response.redirected ? response.url : undefined,
      });

      if (response.ok && isText) {
        const content = await response.text();
        // Check it's not an HTML error page
        const trimmed = content.trimStart().toLowerCase();
        const looksLikeHtml = trimmed.startsWith('<!') || trimmed.startsWith('<html');
        if (!looksLikeHtml && content.trim().length > 0) {
          const crossHost = response.redirected && isCrossHostRedirect(url, response.url);
          discovered.push({
            url,
            content,
            status: response.status,
            redirected: response.redirected,
            redirectUrl: response.redirected ? response.url : undefined,
            crossHostRedirect: crossHost,
          });
        }
      }
    } catch (err) {
      checkedUrls.push({
        url,
        status: 0,
        redirected: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // When no llms.txt found, check if any candidates redirected cross-host.
  // If so, try {redirected_origin}/llms.txt as a fallback.
  // Skip the fallback when the user explicitly specified an llmsTxtUrl —
  // they told us exactly where to look, so silently probing other origins
  // would defeat the purpose of the override.
  const redirectedOrigins: string[] = [];
  if (discovered.length === 0 && !explicitUrl) {
    const checkedSet = new Set(checkedUrls.map((u) => u.url));
    const seenOrigins = new Set<string>();
    for (const checked of checkedUrls) {
      if (checked.finalUrl && isCrossHostRedirect(checked.url, checked.finalUrl)) {
        try {
          const redirectedOrigin = new URL(checked.finalUrl).origin;
          const fallbackUrl = `${redirectedOrigin}/llms.txt`;
          if (!checkedSet.has(fallbackUrl) && !seenOrigins.has(redirectedOrigin)) {
            seenOrigins.add(redirectedOrigin);
            checkedSet.add(fallbackUrl);
            redirectedOrigins.push(redirectedOrigin);
          }
        } catch {
          /* malformed URL */
        }
      }
    }

    for (const redirectedOrigin of redirectedOrigins) {
      const fallbackUrl = `${redirectedOrigin}/llms.txt`;
      try {
        const response = await ctx.http.fetch(fallbackUrl);
        const contentType = response.headers.get('content-type') ?? '';
        const isText = contentType.includes('text/');

        checkedUrls.push({
          url: fallbackUrl,
          status: response.status,
          redirected: response.redirected,
          finalUrl: response.redirected ? response.url : undefined,
        });

        if (response.ok && isText) {
          const content = await response.text();
          const trimmed = content.trimStart().toLowerCase();
          const looksLikeHtml = trimmed.startsWith('<!') || trimmed.startsWith('<html');
          if (!looksLikeHtml && content.trim().length > 0) {
            discovered.push({
              url: fallbackUrl,
              content,
              status: response.status,
              redirected: false,
              crossHostRedirect: true,
            });
          }
        }
      } catch (err) {
        checkedUrls.push({
          url: fallbackUrl,
          status: 0,
          redirected: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  const fetchErrors = checkedUrls.filter((u) => u.error).length;
  const rateLimited = checkedUrls.filter((u) => u.status === 429).length;

  const suffix =
    (fetchErrors > 0 ? t('common.fetch_errors_suffix', { count: fetchErrors }) : '') +
    (rateLimited > 0 ? t('common.rate_limited_suffix', { count: rateLimited }) : '');

  // Pick the canonical llms.txt — the one downstream checks should use as the
  // single source of truth for sampling links, measuring size, validating
  // structure, etc. When multiple llms.txt files exist (apex + docs section),
  // the heuristic prefers the most-specific one relative to the baseUrl.
  const canonical = selectCanonicalLlmsTxt(discovered, ctx.baseUrl);

  // Store discovered files for downstream checks
  const details: Record<string, unknown> = {
    candidateUrls: checkedUrls,
    discoveredFiles: discovered,
    fetchErrors,
    rateLimited,
  };

  if (canonical) {
    details.canonicalLlmsTxt = canonical;
    details.canonicalUrl = canonical.url;
    if (explicitUrl) {
      details.canonicalSource = 'explicit';
    } else if (discovered.length > 1) {
      details.canonicalSource = 'heuristic';
    }
  }

  if (redirectedOrigins.length > 0) {
    details.redirectedOrigins = redirectedOrigins;
  }

  // Set effectiveOrigin for downstream checks when content lives at a different origin.
  // This covers both true cross-host redirects (e.g. example.com → docs.other.com)
  // and www canonicalization (e.g. mongodb.com → www.mongodb.com). Downstream checks
  // need to know the actual origin so sitemap scoping and link classification work.
  if (!ctx.effectiveOrigin) {
    // First try: a discovered file that redirected to a different origin
    const redirectedFile = discovered.find((f) => f.redirectUrl);
    if (redirectedFile?.redirectUrl) {
      try {
        const redirectedOrigin = new URL(redirectedFile.redirectUrl).origin;
        if (redirectedOrigin !== ctx.origin) {
          ctx.effectiveOrigin = redirectedOrigin;
        }
      } catch {
        /* ignore malformed */
      }
    }
    // Second try: origins discovered from cross-host redirect fallback probing
    if (!ctx.effectiveOrigin && redirectedOrigins.length > 0) {
      ctx.effectiveOrigin = redirectedOrigins[0];
    }
  }

  if (discovered.length === 0) {
    const redirectNote =
      redirectedOrigins.length > 0
        ? t('check.llms-txt-exists.redirect_note', { origins: redirectedOrigins.join(', ') })
        : '';
    const message = explicitUrl
      ? t('check.llms-txt-exists.fail_explicit', {
          url: explicitUrl,
          redirectNote,
          suffix,
        })
      : t('check.llms-txt-exists.fail_candidates', {
          candidates: candidates.join(', '),
          redirectNote,
          suffix,
        });
    return {
      id: 'llms-txt-exists',
      category: 'content-discoverability',
      status: 'fail',
      message,
      details,
    };
  }

  // Check if any discovered files were only reachable via cross-host redirect
  const allCrossHost = discovered.every((f) => f.crossHostRedirect);
  if (allCrossHost) {
    return {
      id: 'llms-txt-exists',
      category: 'content-discoverability',
      status: 'warn',
      message: t('check.llms-txt-exists.warn_cross_host', { suffix }),
      details,
    };
  }

  // Note if multiple locations serve different content
  if (discovered.length > 1) {
    const contents = discovered.map((f) => f.content);
    const allSame = contents.every((c) => c === contents[0]);
    details.multipleLocations = true;
    details.sameContent = allSame;
  }

  // Build a message that surfaces which file was picked as canonical, so users
  // can see at a glance which one drives the rest of the report.
  let message: string;
  if (explicitUrl && canonical) {
    message = t('check.llms-txt-exists.pass_explicit', { url: canonical.url });
  } else if (discovered.length === 1) {
    message = t('check.llms-txt-exists.pass_single', { url: discovered[0].url });
  } else if (canonical) {
    message = t('check.llms-txt-exists.pass_multi_canonical', {
      count: discovered.length,
      url: canonical.url,
    });
  } else {
    message = t('check.llms-txt-exists.pass_multi', { count: discovered.length });
  }

  return {
    id: 'llms-txt-exists',
    category: 'content-discoverability',
    status: 'pass',
    message: message + suffix,
    details,
  };
}

registerCheck({
  id: 'llms-txt-exists',
  category: 'content-discoverability',
  description: 'Whether llms.txt is discoverable at any of the candidate locations',
  dependsOn: [],
  run: checkLlmsTxtExists,
});
