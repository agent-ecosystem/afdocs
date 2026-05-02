import { registerCheck } from '../registry.js';
import { looksLikeMarkdown } from '../../helpers/detect-markdown.js';
import { discoverAndSamplePages } from '../../helpers/get-page-urls.js';
import { toMdUrls } from '../../helpers/to-md-urls.js';
import type { CheckContext, CheckResult } from '../../types.js';

interface PageResult {
  url: string;
  mdUrl: string;
  supported: boolean;
  skipped?: boolean;
  alreadyMd?: boolean;
  status: number;
  error?: string;
  /** True when the original llms.txt-published URL served the content. */
  originalUrlServed?: boolean;
}

/**
 * Detect whether the site prefers `page.md` (direct) or `page/index.md` (index)
 * based on which candidate succeeded in previous results.
 * Returns 'index' if `page/index.md` wins, 'direct' if `page.md` wins, or null if
 * there's no clear winner yet.
 *
 * Wins served via the `originalMdUrl` from llms.txt are NOT counted: those
 * URLs reflect the site's published form, not a `toMdUrls()` candidate, and
 * counting them would skew the heuristic for unrelated pages.
 */
function detectPreferredMdForm(results: PageResult[]): 'direct' | 'index' | null {
  let directWins = 0;
  let indexWins = 0;
  for (const r of results) {
    if (!r.supported || !r.mdUrl || r.originalUrlServed) continue;
    if (r.mdUrl.endsWith('/index.md') || r.mdUrl.endsWith('/index.mdx')) {
      indexWins++;
    } else {
      directWins++;
    }
  }
  const total = directWins + indexWins;
  if (total < 2) return null;
  if (indexWins / total >= 0.8) return 'index';
  if (directWins / total >= 0.8) return 'direct';
  return null;
}

/**
 * Issue #77: when llms.txt published a `/foo/index.html.md` URL but it 404s
 * (and the regenerated `/foo/index.md` and `/foo/index.html/index.md` also
 * 404), some sites still serve the markdown at the parent-clean path
 * `/foo.md` (Plaid's pattern). This is gated to URLs whose llms.txt original
 * matched `/index.html?\.md$` — strong evidence the site uses this convention.
 *
 * Do NOT move this into `toMdUrls()`. Other checks (`llms-txt-directive-md`,
 * `llms-txt-links-markdown`, etc.) call `toMdUrls()` directly and would
 * regress to the old false-positive class where unrelated sibling .md files
 * pass validation. See issue #77 discussion.
 */
function deriveParentCleanMd(pageUrl: string, originalMdUrl: string): string | null {
  if (!/\/index\.html?\.md$/i.test(new URL(originalMdUrl).pathname)) return null;
  try {
    const u = new URL(pageUrl);
    const pathname = u.pathname.replace(/\/$/, '');
    // Strip /index.html or /index.htm from the page URL and append .md
    const stripped = pathname.replace(/\/index\.html?$/i, '');
    if (!stripped || stripped === pathname) return null;
    u.pathname = `${stripped}.md`;
    return u.toString();
  } catch {
    return null;
  }
}

/**
 * Reorder toMdUrls() candidates based on the detected site preference.
 * 'index' puts `page/index.md` first; 'direct' keeps the default order (`page.md` first).
 */
function orderCandidates(candidates: string[], preference: 'direct' | 'index' | null): string[] {
  if (preference === 'index') {
    return [...candidates].reverse();
  }
  return candidates;
}

async function check(ctx: CheckContext): Promise<CheckResult> {
  const id = 'markdown-url-support';
  const category = 'markdown-availability';

  const {
    urls: pageUrls,
    totalPages,
    sampled: wasSampled,
    warnings,
    originalMdUrls,
  } = await discoverAndSamplePages(ctx);

  const results: PageResult[] = [];
  const concurrency = ctx.options.maxConcurrency;
  let mdFormPreference: 'direct' | 'index' | null = null;

  for (let i = 0; i < pageUrls.length; i += concurrency) {
    const batch = pageUrls.slice(i, i + concurrency);
    const batchResults = await Promise.all(
      batch.map(async (url): Promise<PageResult> => {
        const baseCandidates = toMdUrls(url);
        // Non-markdown file types (e.g. .json, .xml) have no .md equivalent — skip them
        if (baseCandidates.length === 0) {
          return { url, mdUrl: url, supported: false, skipped: true, status: 0 };
        }
        const alreadyMd = /\.mdx?$/i.test(new URL(url).pathname);
        const original = originalMdUrls?.[url];
        const parentClean = original ? deriveParentCleanMd(url, original) : null;

        // Build candidate list:
        //   1. originalMdUrl (the URL llms.txt published) — first, when present.
        //   2. toMdUrls() candidates, reordered by detected site preference.
        //   3. parent-clean fallback (issue #77) — last, only when llms.txt
        //      published a /foo/index.html.md form. Tried only if 1+2 fail.
        const ordered = orderCandidates(baseCandidates, mdFormPreference);
        const candidateList: string[] = [];
        const seen = new Set<string>();
        const addCandidate = (c: string | null | undefined) => {
          if (c && !seen.has(c)) {
            seen.add(c);
            candidateList.push(c);
          }
        };
        addCandidate(original);
        for (const c of ordered) addCandidate(c);
        addCandidate(parentClean);

        let lastError: string | undefined;
        for (const mdUrl of candidateList) {
          try {
            const response = await ctx.http.fetch(mdUrl);
            const body = await response.text();
            const contentType = response.headers.get('content-type') ?? '';
            const isMarkdownType = contentType.includes('text/markdown');
            const isMarkdownBody = looksLikeMarkdown(body);
            const supported = response.ok && (isMarkdownType || isMarkdownBody);

            if (supported) {
              ctx.pageCache.set(url, {
                url,
                markdown: { content: body, source: 'md-url' },
              });
              return {
                url,
                mdUrl,
                supported: true,
                alreadyMd,
                status: response.status,
                originalUrlServed: mdUrl === original,
              };
            }
            lastError = undefined; // Got a response, not a fetch error
          } catch (err) {
            lastError = err instanceof Error ? err.message : String(err);
          }
        }
        return {
          url,
          mdUrl: candidateList[0],
          supported: false,
          alreadyMd,
          status: 0,
          error: lastError,
        };
      }),
    );
    results.push(...batchResults);

    // After each batch, re-evaluate the preferred .md URL form.
    // Once a clear pattern emerges (80%+ one form), subsequent batches
    // try the preferred form first, saving one request per page.
    if (mdFormPreference === null) {
      mdFormPreference = detectPreferredMdForm(results);
    }
  }

  const testedResults = results.filter((r) => !r.skipped);
  const skippedCount = results.length - testedResults.length;
  const mdSupported = testedResults.filter((r) => r.supported).length;
  const mdUnsupported = testedResults.length - mdSupported;
  const supportRate =
    testedResults.length > 0 ? Math.round((mdSupported / testedResults.length) * 100) : 0;
  const fetchErrors = testedResults.filter((r) => r.error).length;
  const rateLimited = testedResults.filter((r) => r.status === 429).length;

  const pageLabel = wasSampled ? 'sampled pages' : 'pages';
  const suffix =
    (fetchErrors > 0 ? `; ${fetchErrors} failed to fetch` : '') +
    (rateLimited > 0 ? `; ${rateLimited} rate-limited (HTTP 429)` : '');

  const details: Record<string, unknown> = {
    totalPages,
    testedPages: testedResults.length,
    skippedPages: skippedCount,
    sampled: wasSampled,
    mdSupported,
    mdUnsupported,
    supportRate,
    fetchErrors,
    rateLimited,
    pageResults: results,
    discoveryWarnings: warnings,
  };

  if (supportRate >= 90) {
    return {
      id,
      category,
      status: 'pass',
      message: `${mdSupported}/${testedResults.length} ${pageLabel} support .md URLs (${supportRate}%)${suffix}`,
      details,
    };
  }

  if (mdSupported > 0) {
    return {
      id,
      category,
      status: 'warn',
      message: `${mdSupported}/${testedResults.length} ${pageLabel} support .md URLs (${supportRate}%); inconsistent support${suffix}`,
      details,
    };
  }

  return {
    id,
    category,
    status: 'fail',
    message: `No ${pageLabel} support .md URLs (0/${testedResults.length} tested)${suffix}`,
    details,
  };
}

registerCheck({
  id: 'markdown-url-support',
  category: 'markdown-availability',
  description: 'Whether appending .md to page URLs returns valid markdown',
  dependsOn: [],
  run: check,
});
