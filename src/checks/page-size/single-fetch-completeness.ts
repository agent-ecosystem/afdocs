import { registerCheck } from '../registry.js';
import {
  fetchLlmsTxtLinkedMarkdown,
  getMarkdownContent,
  type MarkdownPage,
} from '../../helpers/get-markdown-content.js';
import { detectPagination, type PaginationSignal } from '../../helpers/detect-pagination.js';
import { looksLikeHtml, looksLikeMarkdown } from '../../helpers/detect-markdown.js';
import { isSoft404Body } from '../../helpers/detect-soft-404.js';
import type { CheckContext, CheckResult, CheckStatus } from '../../types.js';
import { promisesMarkdownUrl } from '../../helpers/classify-markdown-links.js';

/**
 * How far into the content a continuation declaration may sit and still
 * count as "at the top": within the first 10% of the content, bounded to
 * between 1,000 and 5,000 characters. The floor keeps a one-line note after
 * the title of a short page at the top; the ceiling is the strictest
 * platform truncation limit the spec documents, past which "top" would no
 * longer mean "before anything truncation could remove".
 */
export const TOP_DECLARATION_PERCENT = 10;
export const TOP_DECLARATION_MIN_CHARS = 1_000;
export const TOP_DECLARATION_MAX_CHARS = 5_000;

export type ContinuationOutcome =
  | 'ok'
  | 'unresolvable'
  | 'http-error'
  | 'empty'
  | 'soft-404'
  | 'not-markdown'
  | 'same-content'
  | 'fetch-error';

export interface ContinuationResult {
  /** The continuation URL exactly as declared. */
  url: string;
  /** The absolute URL that was fetched, when the declaration resolved. */
  resolvedUrl?: string;
  /** True when the declaration was itself an absolute URL. */
  absolute: boolean;
  declaredIn: 'content' | 'header';
  /** Character offset of the in-content declaration. */
  offset?: number;
  /** Offset as a percentage of the content length, rounded. */
  positionPercent?: number;
  /** True when the declaration sits within the top region of the content. */
  atTop: boolean;
  outcome: ContinuationOutcome;
  /** HTTP status of the continuation response, when one arrived. */
  status?: number;
  error?: string;
}

export interface CompletenessPageResult {
  /** The page URL (what the site publishes). */
  url: string;
  /** The URL that served the markdown that was scanned. */
  mdUrl: string;
  source: string;
  status: CheckStatus;
  /** True when at least one pagination signal was found. */
  paginated: boolean;
  signals: PaginationSignal[];
  continuation?: ContinuationResult;
  /** Human-readable reasons behind a warn or fail; empty on pass. */
  issues: string[];
}

/** Tallies the resolution text reads so it can name the dominant reason. */
export interface CompletenessReasons {
  /** Continuation works but is declared only after the top region. */
  declaredLate: number;
  /** Continuation works but is linked with a relative URL. */
  relativeUrl: number;
  /** Continuation is discoverable only from the `Link` header. */
  headerOnly: number;
  /** Pagination signals with no continuation link at all. */
  missing: number;
  /** A continuation URL that could not be resolved to an absolute URL. */
  unresolvable: number;
  /** Continuation fetched but returned an error, nothing, a soft 404, HTML, or the same content. */
  broken: number;
}

function worstStatus(statuses: CheckStatus[]): CheckStatus {
  if (statuses.includes('fail')) return 'fail';
  if (statuses.includes('warn')) return 'warn';
  return 'pass';
}

function topLimit(contentLength: number): number {
  const proportional = Math.floor((contentLength * TOP_DECLARATION_PERCENT) / 100);
  return Math.min(TOP_DECLARATION_MAX_CHARS, Math.max(TOP_DECLARATION_MIN_CHARS, proportional));
}

interface Verification {
  outcome: ContinuationOutcome;
  status?: number;
  error?: string;
}

/**
 * Fetch the continuation the way an agent would and confirm it delivers
 * substantive content of the expected representation.
 *
 * `Accept: text/markdown` is sent only when the URL does not already name
 * the representation. A `.md` or `.mdx` path is itself the request for
 * markdown, and some servers treat the header as a filter rather than a
 * preference: MongoDB's docs answer a `.md` URL with 404 under the header
 * and 200 without it (found by `markdown-link-portability`'s field run), so
 * sending it would report a working continuation as broken.
 */
async function verifyContinuation(
  ctx: CheckContext,
  resolvedUrl: string,
  firstSegment: string,
): Promise<Verification> {
  try {
    const response = promisesMarkdownUrl(resolvedUrl)
      ? await ctx.http.fetch(resolvedUrl)
      : await ctx.http.fetch(resolvedUrl, { headers: { Accept: 'text/markdown' } });
    const body = await response.text();
    const status = response.status;
    if (!response.ok) return { outcome: 'http-error', status };
    if (body.trim().length === 0) return { outcome: 'empty', status };

    const contentType = (response.headers.get('content-type') ?? '').toLowerCase();
    if (contentType.includes('text/html') || looksLikeHtml(body)) {
      return { outcome: 'not-markdown', status };
    }
    const textual =
      contentType === '' || contentType.startsWith('text/') || contentType.includes('markdown');
    if (!textual && !looksLikeMarkdown(body)) return { outcome: 'not-markdown', status };

    if (isSoft404Body(body)) return { outcome: 'soft-404', status };
    if (body.trim() === firstSegment.trim()) return { outcome: 'same-content', status };
    return { outcome: 'ok', status };
  } catch (err) {
    return { outcome: 'fetch-error', error: err instanceof Error ? err.message : String(err) };
  }
}

function describeOutcome(c: ContinuationResult): string {
  switch (c.outcome) {
    case 'unresolvable':
      return 'continuation URL could not be resolved';
    case 'http-error':
      return `continuation returned HTTP ${c.status}`;
    case 'empty':
      return 'continuation returned an empty body';
    case 'soft-404':
      return 'continuation is a soft 404';
    case 'not-markdown':
      return 'continuation returned HTML, not markdown';
    case 'same-content':
      return 'continuation returned the same content';
    case 'fetch-error':
      return `continuation fetch failed: ${c.error ?? 'unknown error'}`;
    default:
      return 'continuation works';
  }
}

async function evaluatePage(
  ctx: CheckContext,
  page: MarkdownPage,
  reasons: CompletenessReasons,
): Promise<CompletenessPageResult> {
  const mdUrl = page.mdUrl ?? page.url;
  const detection = detectPagination(page.content, {
    baseUrl: mdUrl,
    pageUrl: page.url,
    linkHeader: page.linkHeader,
  });
  const base = { url: page.url, mdUrl, source: page.source, signals: detection.signals };

  if (detection.signals.length === 0) {
    return { ...base, status: 'pass', paginated: false, issues: [] };
  }

  const candidate = detection.continuation;
  if (!candidate) {
    reasons.missing++;
    return { ...base, status: 'fail', paginated: true, issues: ['no continuation link found'] };
  }

  const offset = candidate.offset;
  const positionPercent =
    offset !== undefined && page.content.length > 0
      ? Math.round((offset / page.content.length) * 100)
      : undefined;
  const atTop =
    candidate.declaredIn === 'content' && (offset ?? 0) <= topLimit(page.content.length);

  const continuation: ContinuationResult = {
    url: candidate.url,
    ...(candidate.resolvedUrl && { resolvedUrl: candidate.resolvedUrl }),
    absolute: candidate.absolute,
    declaredIn: candidate.declaredIn,
    ...(offset !== undefined && { offset }),
    ...(positionPercent !== undefined && { positionPercent }),
    atTop,
    outcome: 'unresolvable',
  };

  if (!candidate.resolvedUrl) {
    reasons.unresolvable++;
    return {
      ...base,
      status: 'fail',
      paginated: true,
      continuation,
      issues: [describeOutcome(continuation)],
    };
  }

  const verification = await verifyContinuation(ctx, candidate.resolvedUrl, page.content);
  continuation.outcome = verification.outcome;
  if (verification.status !== undefined) continuation.status = verification.status;
  if (verification.error) continuation.error = verification.error;

  if (verification.outcome !== 'ok') {
    reasons.broken++;
    return {
      ...base,
      status: 'fail',
      paginated: true,
      continuation,
      issues: [describeOutcome(continuation)],
    };
  }

  const issues: string[] = [];
  if (candidate.declaredIn === 'header') {
    reasons.headerOnly++;
    issues.push('discoverable only from the Link header');
  } else {
    if (!candidate.absolute) {
      reasons.relativeUrl++;
      issues.push('relative URL');
    }
    if (!atTop) {
      reasons.declaredLate++;
      issues.push(`declared at ${positionPercent}% of content`);
    }
  }

  return {
    ...base,
    status: issues.length > 0 ? 'warn' : 'pass',
    paginated: true,
    continuation,
    issues,
  };
}

function summarizeReasons(reasons: CompletenessReasons, kind: 'warn' | 'fail'): string {
  const parts: string[] = [];
  if (kind === 'warn') {
    if (reasons.declaredLate > 0)
      parts.push(`declared only late in the content (${reasons.declaredLate})`);
    if (reasons.relativeUrl > 0) parts.push(`relative URL (${reasons.relativeUrl})`);
    if (reasons.headerOnly > 0) parts.push(`Link header only (${reasons.headerOnly})`);
  } else {
    if (reasons.missing > 0) parts.push(`no continuation link (${reasons.missing})`);
    if (reasons.broken > 0) parts.push(`broken continuation (${reasons.broken})`);
    if (reasons.unresolvable > 0) parts.push(`unresolvable URL (${reasons.unresolvable})`);
  }
  return parts.join(', ');
}

async function check(ctx: CheckContext): Promise<CheckResult> {
  const id = 'single-fetch-completeness';
  const category = 'page-size';

  const mdResult = await getMarkdownContent(ctx);
  // llms.txt files are indexes, not the documents this check evaluates.
  let pages = mdResult.pages.filter((p) => p.source !== 'llms-txt');

  // A site can serve agent-facing markdown through llms.txt links alone.
  // When the page cache has nothing (the markdown-availability checks failed
  // or found nothing), fall back to the markdown those links reach.
  let viaLlmsTxtLinks = false;
  if (pages.length === 0) {
    pages = await fetchLlmsTxtLinkedMarkdown(ctx);
    viaLlmsTxtLinks = pages.length > 0;
  }

  if (pages.length === 0) {
    const message =
      mdResult.mode === 'cached' && !mdResult.depPassed
        ? 'Site does not serve markdown by any detected path; skipping completeness check'
        : 'No markdown pages available to check for pagination';
    return { id, category, status: 'skip', message };
  }

  const reasons: CompletenessReasons = {
    declaredLate: 0,
    relativeUrl: 0,
    headerOnly: 0,
    missing: 0,
    unresolvable: 0,
    broken: 0,
  };

  const pageResults: CompletenessPageResult[] = [];
  const concurrency = ctx.options.maxConcurrency;
  for (let i = 0; i < pages.length; i += concurrency) {
    const batch = pages.slice(i, i + concurrency);
    pageResults.push(...(await Promise.all(batch.map((p) => evaluatePage(ctx, p, reasons)))));
  }

  const paginatedPages = pageResults.filter((r) => r.paginated).length;
  const passBucket = pageResults.filter((r) => r.status === 'pass').length;
  const warnBucket = pageResults.filter((r) => r.status === 'warn').length;
  const failBucket = pageResults.filter((r) => r.status === 'fail').length;
  const overallStatus = worstStatus(pageResults.map((r) => r.status));

  const sampled = ctx._sampledPages?.sampled ?? mdResult.mode === 'standalone';
  const pageLabel = sampled ? 'sampled markdown pages' : 'markdown pages';
  const total = pageResults.length;

  let message: string;
  if (paginatedPages === 0) {
    message = `All ${total} ${pageLabel} deliver complete content in one fetch (no pagination detected)`;
  } else if (overallStatus === 'pass') {
    message = `${paginatedPages} of ${total} ${pageLabel} paginate; every continuation works and is declared at the top with an absolute URL`;
  } else if (overallStatus === 'warn') {
    message = `${warnBucket} of ${total} ${pageLabel} paginate with a working but fragile continuation (${summarizeReasons(reasons, 'warn')})`;
  } else {
    const fragile = warnBucket > 0 ? `; ${warnBucket} more fragile` : '';
    message = `${failBucket} of ${total} ${pageLabel} are partial with a missing or broken continuation (${summarizeReasons(reasons, 'fail')})${fragile}`;
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
      paginatedPages,
      passBucket,
      warnBucket,
      failBucket,
      reasons,
      thresholds: { pass: ctx.options.thresholds.pass },
      pageResults,
    },
  };
}

registerCheck({
  id: 'single-fetch-completeness',
  category: 'page-size',
  description:
    'Whether markdown responses are complete in one fetch or declare a working continuation',
  dependsOn: [['markdown-url-support', 'content-negotiation', 'llms-txt-links-markdown']],
  run: check,
});
