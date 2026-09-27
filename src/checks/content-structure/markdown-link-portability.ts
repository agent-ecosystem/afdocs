import { registerCheck } from '../registry.js';
import {
  fetchLlmsTxtLinkedMarkdown,
  getMarkdownContent,
  type MarkdownPage,
} from '../../helpers/get-markdown-content.js';
import {
  countByClass,
  promisesMarkdownUrl,
  scanMarkdownLinks,
  type LinkClassCounts,
  type MarkdownLink,
} from '../../helpers/classify-markdown-links.js';
import { looksLikeHtml, looksLikeMarkdown } from '../../helpers/detect-markdown.js';
import { isSoft404Body } from '../../helpers/detect-soft-404.js';
import type { CheckContext, CheckResult, CheckStatus } from '../../types.js';

/**
 * How a sampled link resolved. The vocabulary follows
 * `single-fetch-completeness`; `html-redirect` is this check's one addition,
 * for the spec's minor mismatch (a `.md` link that redirects to an HTML page
 * carrying the right content).
 */
export type LinkOutcome =
  | 'ok'
  | 'http-error'
  | 'empty'
  | 'soft-404'
  | 'not-markdown'
  | 'html-redirect'
  | 'fetch-error';

/** Outcomes that make a page fail: the link is broken or contradicts itself. */
const BROKEN_OUTCOMES: ReadonlySet<LinkOutcome> = new Set([
  'http-error',
  'empty',
  'soft-404',
  'not-markdown',
  'fetch-error',
]);

export interface LinkSample {
  /** The URL as written in the markdown. */
  url: string;
  /** The absolute URL that was fetched, fragment removed. */
  resolvedUrl: string;
  /** True when the link's path promised markdown (`.md` / `.mdx`). */
  promisesMarkdown: boolean;
  outcome: LinkOutcome;
  /** HTTP status of the response, when one arrived. */
  status?: number;
  /** Final URL, when the request was redirected somewhere else. */
  redirectedTo?: string;
  error?: string;
}

export interface PortabilityPageResult {
  /** The page URL (what the site publishes). */
  url: string;
  /** The URL that served the markdown that was scanned, and the link base. */
  mdUrl: string;
  source: string;
  status: CheckStatus;
  links: LinkClassCounts;
  /** Image references, classified but not scored. */
  images: LinkClassCounts;
  /** The links that were fetched and verified for this page. */
  samples: LinkSample[];
  /** Human-readable reasons behind a warn or fail; empty on pass. */
  issues: string[];
}

/** Tallies the resolution text reads so it can name the dominant reason. */
export interface PortabilityReasons {
  /** Pages carrying at least one path-relative link. */
  pathRelative: number;
  /** Pages carrying at least one root-relative or protocol-relative link. */
  rootRelative: number;
  /** Pages carrying at least one destination that never parsed as a URL. */
  unresolvable: number;
  /** Pages with at least one sampled link that was broken. */
  broken: number;
  /** Pages with at least one `.md` link that redirected to HTML. */
  mismatched: number;
}

function worstStatus(statuses: CheckStatus[]): CheckStatus {
  if (statuses.includes('fail')) return 'fail';
  if (statuses.includes('warn')) return 'warn';
  return 'pass';
}

function describeOutcome(sample: LinkSample): string {
  switch (sample.outcome) {
    case 'http-error':
      return `HTTP ${sample.status}`;
    case 'empty':
      return 'empty body';
    case 'soft-404':
      return 'soft 404';
    case 'not-markdown':
      return 'returned HTML, not markdown';
    case 'html-redirect':
      return 'redirects to HTML';
    case 'fetch-error':
      return `fetch failed: ${sample.error ?? 'unknown error'}`;
    default:
      return 'resolves';
  }
}

interface Verification {
  outcome: LinkOutcome;
  status?: number;
  redirectedTo?: string;
  error?: string;
}

/**
 * Fetch one sampled link and decide whether it delivers the representation it
 * promised. Status codes alone are not enough: the spec's grounding case is a
 * set of `.md` links that all returned 200 with an HTML shell.
 *
 * The request carries no `Accept` override. A `.md` path is already a request
 * for a representation, so negotiating on top of it would fold
 * `content-negotiation`'s subject into this check's verdict. It is not
 * hypothetical: MongoDB's docs answer a `.md` URL with 404 when the request
 * asks for `text/markdown`, and with 200 and `text/markdown` when it doesn't,
 * which would have been reported here as four broken generated links on a
 * site whose links are fine.
 */
async function verifyLink(
  ctx: CheckContext,
  link: MarkdownLink,
  resolvedUrl: string,
): Promise<Verification> {
  try {
    const response = await ctx.http.fetch(resolvedUrl);
    const body = await response.text();
    const status = response.status;
    const finalUrl = response.url || resolvedUrl;
    const redirected = response.redirected === true || finalUrl !== resolvedUrl;
    const redirect = redirected && finalUrl !== resolvedUrl ? { redirectedTo: finalUrl } : {};

    if (!response.ok) return { outcome: 'http-error', status, ...redirect };
    if (body.trim().length === 0) return { outcome: 'empty', status, ...redirect };
    if (isSoft404Body(body)) return { outcome: 'soft-404', status, ...redirect };

    if (link.promisesMarkdown) {
      const declared = (response.headers.get('content-type') ?? '')
        .toLowerCase()
        .split(';')[0]
        .trim();
      // A declared type decides what the response is. Body sniffing only
      // fills in for a response that declares nothing, or declares the
      // "unknown bytes" type some static hosts serve `.md` with; it must not
      // overrule an explicit contradictory type, or a `.md` URL answering
      // `application/json` passes on the strength of one bracket in a string.
      // Sniffing still condemns: a body shaped like HTML is HTML whatever the
      // header claims, which is what catches a shell served as text/markdown.
      const unspecified = declared === '' || declared === 'application/octet-stream';
      const declaresHtml = declared === 'text/html' || declared === 'application/xhtml+xml';

      if (declaresHtml || looksLikeHtml(body)) {
        // A redirect that lands on an HTML *page* is the spec's minor
        // mismatch: the content is there, the representation is not what was
        // promised. A `.md` URL answering with HTML in place is the SPA-shell
        // failure, and so is a redirect from one `.md` URL to another that
        // serves HTML: the final URL still promises markdown and does not
        // deliver it.
        const minorMismatch = redirected && !promisesMarkdownUrl(finalUrl);
        return { outcome: minorMismatch ? 'html-redirect' : 'not-markdown', status, ...redirect };
      }

      const declaresText = declared.startsWith('text/') || declared.includes('markdown');
      if (!declaresText && !(unspecified && looksLikeMarkdown(body))) {
        return { outcome: 'not-markdown', status, ...redirect };
      }
    }

    return { outcome: 'ok', status, ...redirect };
  } catch (err) {
    return { outcome: 'fetch-error', error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Links this check will spend a request on: same-origin, resolvable, and
 * pointing at something fetchable. Cross-origin links are classified (they
 * are absolute by definition, so they never cost a site anything) but never
 * verified: the `llms-txt-links-resolve` precedent keeps third-party
 * availability out of a site's own result, and fetching other people's hosts
 * to grade this one invites bot-protection noise.
 *
 * Links whose path promises markdown are tried first: the representation
 * mismatch the spec is built around can only show up on those.
 */
function sampleCandidates(links: MarkdownLink[]): MarkdownLink[] {
  const eligible = links.filter((link) => {
    if (!link.fetchUrl || link.crossOrigin) return false;
    return link.class !== 'fragment' && link.class !== 'other-scheme';
  });
  return [
    ...eligible.filter((link) => link.promisesMarkdown),
    ...eligible.filter((link) => !link.promisesMarkdown),
  ];
}

interface PageScan {
  page: MarkdownPage;
  mdUrl: string;
  links: MarkdownLink[];
  counts: LinkClassCounts;
  images: LinkClassCounts;
  candidates: MarkdownLink[];
}

function buildPageResult(scan: PageScan, samples: LinkSample[]): PortabilityPageResult {
  const issues: string[] = [];
  const { counts } = scan;

  if (counts.pathRelative > 0) {
    issues.push(`${counts.pathRelative} path-relative link${counts.pathRelative === 1 ? '' : 's'}`);
  }
  const rootish = counts.rootRelative + counts.protocolRelative;
  if (rootish > 0) {
    issues.push(`${rootish} root-relative link${rootish === 1 ? '' : 's'}`);
  }
  if (counts.unresolvable > 0) {
    const n = counts.unresolvable;
    issues.push(`${n} malformed link${n === 1 ? '' : 's'} that never parsed as a URL`);
  }
  for (const sample of samples) {
    if (sample.outcome !== 'ok') issues.push(`${sample.url} ${describeOutcome(sample)}`);
  }

  const broken = samples.some((s) => BROKEN_OUTCOMES.has(s.outcome));
  const mismatched = samples.some((s) => s.outcome === 'html-redirect');
  const status: CheckStatus =
    counts.pathRelative > 0 || counts.unresolvable > 0 || broken
      ? 'fail'
      : rootish > 0 || mismatched
        ? 'warn'
        : 'pass';

  return {
    url: scan.page.url,
    mdUrl: scan.mdUrl,
    source: scan.page.source,
    status,
    links: counts,
    images: scan.images,
    samples,
    issues,
  };
}

function summarizeReasons(reasons: PortabilityReasons, kind: 'warn' | 'fail'): string {
  const parts: string[] = [];
  if (kind === 'warn') {
    if (reasons.rootRelative > 0) parts.push(`root-relative links (${reasons.rootRelative})`);
    if (reasons.mismatched > 0) parts.push(`.md links redirecting to HTML (${reasons.mismatched})`);
  } else {
    if (reasons.pathRelative > 0) parts.push(`path-relative links (${reasons.pathRelative})`);
    if (reasons.unresolvable > 0) parts.push(`malformed links (${reasons.unresolvable})`);
    if (reasons.broken > 0) parts.push(`broken sampled links (${reasons.broken})`);
  }
  return parts.join(', ');
}

async function check(ctx: CheckContext): Promise<CheckResult> {
  const id = 'markdown-link-portability';
  const category = 'content-structure';

  const mdResult = await getMarkdownContent(ctx);
  // Links inside llms.txt are `llms-txt-links-resolve`'s job, and the file is
  // an index rather than a document this check evaluates.
  let pages = mdResult.pages.filter((p) => p.source !== 'llms-txt');

  // A site can serve agent-facing markdown through llms.txt links alone.
  let viaLlmsTxtLinks = false;
  if (pages.length === 0) {
    pages = await fetchLlmsTxtLinkedMarkdown(ctx);
    viaLlmsTxtLinks = pages.length > 0;
  }

  if (pages.length === 0) {
    const message =
      mdResult.mode === 'cached' && !mdResult.depPassed
        ? 'Site does not serve markdown by any detected path; skipping link portability check'
        : 'No markdown pages available to check for link portability';
    return { id, category, status: 'skip', message };
  }

  const scans: PageScan[] = pages.map((page) => {
    // Relative links resolve against the URL that served the markdown, never
    // against the page URL: `guide.md` next to `/md/api.md` is a different
    // target than `guide.md` next to `/docs/api`.
    const mdUrl = page.mdUrl ?? page.url;
    const { links, images } = scanMarkdownLinks(page.content, mdUrl);
    return {
      page,
      mdUrl,
      links,
      counts: countByClass(links),
      images: countByClass(images),
      candidates: sampleCandidates(links),
    };
  });

  // Spend the link budget across pages rather than per page: every page gets
  // the same quota, and a URL already planned for one page is reused by the
  // next without another request (documentation pages share navigation links).
  const budget = ctx.options.maxLinksToTest;
  const perPageQuota = Math.max(1, Math.floor(budget / scans.length));
  const plannedByPage: MarkdownLink[][] = [];
  const toFetch: MarkdownLink[] = [];
  const plannedUrls = new Set<string>();
  for (const scan of scans) {
    const picked: MarkdownLink[] = [];
    const seen = new Set<string>();
    for (const link of scan.candidates) {
      if (picked.length >= perPageQuota) break;
      // Two links to the same document with different fragments are one fetch.
      const fetchUrl = link.fetchUrl!;
      if (seen.has(fetchUrl)) continue;
      if (!plannedUrls.has(fetchUrl)) {
        // Budget spent: no new requests, but a URL already planned for an
        // earlier page still verifies this one at no cost, so keep scanning.
        if (toFetch.length >= budget) continue;
        plannedUrls.add(fetchUrl);
        toFetch.push(link);
      }
      seen.add(fetchUrl);
      picked.push(link);
    }
    plannedByPage.push(picked);
  }

  const verified = new Map<string, Verification>();
  const concurrency = ctx.options.maxConcurrency;
  for (let i = 0; i < toFetch.length; i += concurrency) {
    const batch = toFetch.slice(i, i + concurrency);
    const results = await Promise.all(
      batch.map(
        async (link) => [link.fetchUrl!, await verifyLink(ctx, link, link.fetchUrl!)] as const,
      ),
    );
    for (const [url, verification] of results) verified.set(url, verification);
  }

  const pageResults = scans.map((scan, i) =>
    buildPageResult(
      scan,
      plannedByPage[i].map((link) => {
        const resolvedUrl = link.fetchUrl!;
        const verification = verified.get(resolvedUrl)!;
        return {
          url: link.url,
          resolvedUrl,
          promisesMarkdown: link.promisesMarkdown,
          outcome: verification.outcome,
          ...(verification.status !== undefined && { status: verification.status }),
          ...(verification.redirectedTo && { redirectedTo: verification.redirectedTo }),
          ...(verification.error && { error: verification.error }),
        };
      }),
    ),
  );

  const reasons: PortabilityReasons = {
    pathRelative: 0,
    rootRelative: 0,
    unresolvable: 0,
    broken: 0,
    mismatched: 0,
  };
  for (const page of pageResults) {
    if (page.links.pathRelative > 0) reasons.pathRelative++;
    if (page.links.rootRelative + page.links.protocolRelative > 0) reasons.rootRelative++;
    if (page.links.unresolvable > 0) reasons.unresolvable++;
    if (page.samples.some((s) => BROKEN_OUTCOMES.has(s.outcome))) reasons.broken++;
    if (page.samples.some((s) => s.outcome === 'html-redirect')) reasons.mismatched++;
  }

  const passBucket = pageResults.filter((r) => r.status === 'pass').length;
  const warnBucket = pageResults.filter((r) => r.status === 'warn').length;
  const failBucket = pageResults.filter((r) => r.status === 'fail').length;
  const overallStatus = worstStatus(pageResults.map((r) => r.status));

  const totalLinks = pageResults.reduce((sum, r) => sum + r.links.total, 0);
  const sampledLinks = pageResults.reduce((sum, r) => sum + r.samples.length, 0);
  const linksVerified = verified.size;
  const brokenSamples = [...verified.values()].filter((v) => BROKEN_OUTCOMES.has(v.outcome)).length;

  const sampled = ctx._sampledPages?.sampled ?? mdResult.mode === 'standalone';
  const pageLabel = sampled ? 'sampled markdown pages' : 'markdown pages';
  const total = pageResults.length;

  let message: string;
  if (totalLinks === 0) {
    message = `No links found in ${total} ${pageLabel}`;
  } else if (overallStatus === 'pass') {
    const verifiedNote =
      sampledLinks > 0
        ? `; ${sampledLinks} sampled link${sampledLinks === 1 ? '' : 's'} resolve to the expected representation`
        : '';
    message = `All ${totalLinks} links across ${total} ${pageLabel} are absolute${verifiedNote}`;
  } else if (overallStatus === 'warn') {
    message = `${warnBucket} of ${total} ${pageLabel} carry links that lose their target once the base URL is gone (${summarizeReasons(reasons, 'warn')})`;
  } else {
    const fragile = warnBucket > 0 ? `; ${warnBucket} more fragile` : '';
    message = `${failBucket} of ${total} ${pageLabel} carry links that are unresolvable without the base URL or that do not resolve (${summarizeReasons(reasons, 'fail')})${fragile}`;
  }

  return {
    id,
    category,
    status: overallStatus,
    message,
    details: {
      totalPages: total,
      testedPages: total,
      sampled,
      viaLlmsTxtLinks,
      passBucket,
      warnBucket,
      failBucket,
      totalLinks,
      sampledLinks,
      linksVerified,
      brokenSamples,
      perPageQuota,
      reasons,
      pageResults,
    },
  };
}

registerCheck({
  id: 'markdown-link-portability',
  category: 'content-structure',
  description: 'Whether links in served markdown are absolute and resolve to what they promise',
  dependsOn: [['markdown-url-support', 'content-negotiation', 'llms-txt-links-markdown']],
  run: check,
});
