import type { CheckResult, ReportResult } from '../types.js';
import type { Diagnostic, DiagnosticSeverity } from './types.js';
import { MIN_PAGES_FOR_SCORING } from '../constants.js';

/**
 * Run-level fetch failure rate at which the scan is flagged as degraded even
 * when `bot-protection-interference` did not itself warn or fail (the spec's
 * "for example, above 20% of page fetches").
 */
export const PARTIAL_SAMPLE_FAILURE_RATE = 0.2;

/**
 * The failure-rate trigger needs a sample worth a percentage. Two failed
 * discovery probes in a ten-request subset run are not a degraded scan.
 */
export const MIN_REQUESTS_FOR_RATE_TRIGGER = 20;

/**
 * The spec's "Bot Protection Degrading Scan Reliability" effect has two
 * triggers, and both are honored: the check returning warn or fail (its
 * inverted dependency on every multi-page check), or the run-level fetch
 * failure rate crossing the threshold regardless of what the check said.
 */
export function isScanDegradedByBotProtection(
  results: Map<string, CheckResult>,
  report: ReportResult,
): boolean {
  const check = results.get('bot-protection-interference');
  if (check?.status === 'warn' || check?.status === 'fail') return true;

  const s = report.requestSummary;
  return (
    !!s &&
    s.requests >= MIN_REQUESTS_FOR_RATE_TRIGGER &&
    s.failed / s.requests >= PARTIAL_SAMPLE_FAILURE_RATE
  );
}

interface FailureCounts {
  requests: number;
  failed: number;
  stalledBodies: number;
  challengePages: number;
  fetchErrors: number;
  /** Denied responses the check counted as failures (only when the denial rate climbed). */
  denied: number;
}

/**
 * When the check warned or failed, its own counts are authoritative: they
 * include denied responses that a climbing block rate turned into failures,
 * which the run-level request summary does not know about. The summary is
 * the fallback for runs where the check did not run.
 */
function failureCounts(
  results: Map<string, CheckResult>,
  report: ReportResult,
): FailureCounts | undefined {
  const check = results.get('bot-protection-interference');
  const d = check?.details;
  if (d && (check?.status === 'warn' || check?.status === 'fail')) {
    return {
      requests: (d.requests as number) ?? 0,
      failed: (d.failedRequests as number) ?? 0,
      stalledBodies: (d.stalledBodies as number) ?? 0,
      challengePages: (d.challengePages as number) ?? 0,
      fetchErrors: (d.fetchErrors as number) ?? 0,
      denied: (d.deniedCounted as number) ?? 0,
    };
  }
  if (report.requestSummary) return { ...report.requestSummary, denied: 0 };
  return undefined;
}

// ---------------------------------------------------------------------------
// Dynamic Content Rendered Statically
// ---------------------------------------------------------------------------

/**
 * The spec's four failure directions for a dynamic page flattened into
 * static content, each owned by one check.
 */
export type FlatteningDirection = 'too much' | 'too little' | 'inconsistent' | 'unnavigable';

export interface FlatteningFinding {
  url: string;
  /** Evidence per direction, in the order the spec lists them. */
  symptoms: Array<{ direction: FlatteningDirection; evidence: string }>;
}

/**
 * Pages are keyed by their published URL in every check involved, but the
 * parity check keys by the cached URL (which may be the `.md` variant when
 * llms.txt links to markdown directly). Normalize so one page is one key.
 */
function pageKey(url: string): string {
  try {
    const u = new URL(url);
    u.hash = '';
    let path = u.pathname.replace(/\.(md|mdx)$/i, '');
    if (path.length > 1) path = path.replace(/\/$/, '');
    if (path === '') path = '/';
    return `${u.protocol}//${u.host.toLowerCase()}${path}${u.search}`;
  } catch {
    return url;
  }
}

const DIRECTION_ORDER: FlatteningDirection[] = [
  'too much',
  'too little',
  'inconsistent',
  'unnavigable',
];

/**
 * Collect, per page, which of the four flattening directions the checks
 * observed. Only warn/fail page results count as symptoms, with one
 * exception: a parity item-count divergence counts as "inconsistent" even
 * when the page passed, because a markdown variant that lists more than the
 * HTML shows is never "missing" anything by the containment measure.
 */
export function collectFlatteningFindings(results: Map<string, CheckResult>): FlatteningFinding[] {
  const byPage = new Map<string, { url: string; symptoms: Map<FlatteningDirection, string> }>();
  const add = (url: string, direction: FlatteningDirection, evidence: string) => {
    const key = pageKey(url);
    let entry = byPage.get(key);
    if (!entry) {
      entry = { url, symptoms: new Map() };
      byPage.set(key, entry);
    }
    if (!entry.symptoms.has(direction)) entry.symptoms.set(direction, evidence);
  };
  const flagged = (status?: string) => status === 'warn' || status === 'fail';

  // Too much: embedded-data-serialization
  const bulk = results.get('embedded-data-serialization')?.details?.pageResults as
    | Array<{
        url: string;
        status: string;
        error?: string;
        bulkShare?: number;
        dominantElement?: { kind: string; rows?: number; chars: number; share: number };
      }>
    | undefined;
  for (const p of bulk ?? []) {
    if (p.error || !flagged(p.status)) continue;
    const el = p.dominantElement;
    const what =
      el?.kind === 'table'
        ? `a ${el.rows ?? 0}-row table`
        : el
          ? `a ${el.kind} blob`
          : 'generated data';
    add(p.url, 'too much', `${what} is ${el?.share ?? p.bulkShare ?? 0}% of the converted content`);
  }

  // Too little: single-fetch-completeness
  const completeness = results.get('single-fetch-completeness')?.details?.pageResults as
    | Array<{ url: string; status: string; paginated?: boolean; issues?: string[] }>
    | undefined;
  for (const p of completeness ?? []) {
    if (!flagged(p.status)) continue;
    const issue = p.issues?.[0];
    add(p.url, 'too little', issue ? `markdown is paginated: ${issue}` : 'markdown is paginated');
  }

  // Inconsistent: markdown-content-parity (status, or item counts)
  const parity = results.get('markdown-content-parity')?.details?.pageResults as
    | Array<{
        url: string;
        status: string;
        error?: string;
        missingPercent?: number;
        itemCounts?: {
          html: number;
          markdown: number;
          markdownUnique: number;
          duplicates: number;
          diverges: boolean;
          likelyCause?: string;
        };
      }>
    | undefined;
  for (const p of parity ?? []) {
    if (p.error) continue;
    const ic = p.itemCounts;
    if (ic?.diverges) {
      const cause = ic.likelyCause ? ` (likely ${ic.likelyCause.replace('-', ' ')})` : '';
      add(
        p.url,
        'inconsistent',
        `the HTML shows ${ic.html} items while the markdown lists ${ic.markdownUnique}${cause}`,
      );
    } else if (ic && ic.duplicates > 0) {
      add(
        p.url,
        'inconsistent',
        `the markdown lists ${ic.markdown} entries of which only ${ic.markdownUnique} are distinct`,
      );
    } else if (flagged(p.status)) {
      add(
        p.url,
        'inconsistent',
        `${p.missingPercent ?? 0}% of the HTML content is missing from the markdown`,
      );
    }
  }

  // Unnavigable: markdown-link-portability
  const portability = results.get('markdown-link-portability')?.details?.pageResults as
    | Array<{
        url: string;
        status: string;
        links?: {
          rootRelative: number;
          protocolRelative?: number;
          pathRelative: number;
          total: number;
        };
        samples?: Array<{ outcome: string }>;
      }>
    | undefined;
  for (const p of portability ?? []) {
    if (!flagged(p.status)) continue;
    const parts: string[] = [];
    const l = p.links;
    if (l) {
      const relative = l.rootRelative + (l.protocolRelative ?? 0) + l.pathRelative;
      if (relative > 0) parts.push(`${relative} of ${l.total} links are relative`);
    }
    const samples = p.samples ?? [];
    const broken = samples.filter((s) => s.outcome !== 'ok').length;
    if (broken > 0) parts.push(`${broken} of ${samples.length} sampled links do not resolve`);
    add(p.url, 'unnavigable', parts.join(' and ') || 'links depend on a browser context');
  }

  const findings: FlatteningFinding[] = [];
  for (const entry of byPage.values()) {
    if (entry.symptoms.size < 2) continue;
    findings.push({
      url: entry.url,
      symptoms: DIRECTION_ORDER.filter((d) => entry.symptoms.has(d)).map((direction) => ({
        direction,
        evidence: entry.symptoms.get(direction)!,
      })),
    });
  }
  return findings;
}

interface DiagnosticDefinition {
  id: string;
  severity: DiagnosticSeverity;
  /** Evaluated in dependency order. Can reference prior diagnostic results. */
  triggers: (
    results: Map<string, CheckResult>,
    triggered: Set<string>,
    report: ReportResult,
  ) => boolean;
  message: (
    results: Map<string, CheckResult>,
    triggered: Set<string>,
    report: ReportResult,
  ) => string;
  resolution: string;
}

// Evaluated in this order (dependency order matters)
const DIAGNOSTIC_DEFINITIONS: DiagnosticDefinition[] = [
  // --- markdown discovery diagnostics must be first (others reference them) ---
  {
    id: 'markdown-undiscoverable',
    severity: 'warning',
    triggers: (results) => {
      const mdSupport = results.get('markdown-url-support');
      if (mdSupport?.status !== 'pass') return false;

      const cn = results.get('content-negotiation');
      const directiveHtml = results.get('llms-txt-directive-html');

      return cn?.status !== 'pass' && directiveHtml?.status !== 'pass';
    },
    message: () =>
      'Your site serves markdown at .md URLs, but agents have no way to ' +
      'discover this. No agent-facing directive points to your llms.txt, ' +
      'and the server does not support content negotiation. Most agents ' +
      'will default to the HTML path and never benefit from your markdown ' +
      'support.',
    resolution:
      'Add a directive near the top of each docs page pointing to your ' +
      'llms.txt, and implement content negotiation for Accept: text/markdown. ' +
      'The directive is the primary discovery mechanism (it reaches all ' +
      'agents); content negotiation provides a fast path for agents that ' +
      'request markdown by default.',
  },

  {
    id: 'markdown-partially-discoverable',
    severity: 'warning',
    triggers: (results) => {
      const mdSupport = results.get('markdown-url-support');
      if (mdSupport?.status !== 'pass') return false;

      const cn = results.get('content-negotiation');
      const directiveHtml = results.get('llms-txt-directive-html');

      return cn?.status === 'pass' && directiveHtml?.status !== 'pass';
    },
    message: () =>
      'Your site serves markdown and supports content negotiation, but ' +
      'has no agent-facing directive on HTML pages pointing to llms.txt. ' +
      'Agents that send Accept: text/markdown (Claude Code, Cursor, ' +
      'OpenCode) get markdown automatically, but the majority of agents ' +
      'fetch HTML by default and have no signal to try the markdown path.',
    resolution:
      'Add a directive near the top of each docs page pointing to your ' +
      'llms.txt. If your site serves markdown, mention that in the ' +
      'directive too. The directive reaches all agents, not just the ones ' +
      'that request markdown by default.',
  },

  {
    id: 'truncated-index',
    severity: 'warning',
    triggers: (results) => {
      const exists = results.get('llms-txt-exists');
      const size = results.get('llms-txt-size');
      return (exists?.status === 'pass' || exists?.status === 'warn') && size?.status === 'fail';
    },
    message: (results) => {
      const sizeResult = results.get('llms-txt-size');
      const d = sizeResult?.details;
      const sizes = (d?.sizes as Array<{ characters?: number }>) ?? [];
      const maxSize = Math.max(...sizes.map((s) => s.characters ?? 0), 0);
      const visiblePct = maxSize > 0 ? Math.round((100_000 / maxSize) * 100) : 0;

      return (
        `Your llms.txt is ${maxSize.toLocaleString()} characters. Agents ` +
        `see roughly the first 100,000 characters (${visiblePct}% of the ` +
        "file). Links, structure, and freshness beyond that point don't " +
        'affect agent experience. Quality checks on the invisible portion ' +
        'are discounted in the score.'
      );
    },
    resolution:
      'Split into a root index linking to section-level llms.txt files, ' +
      "each under 50,000 characters. See the spec's progressive disclosure " +
      'recommendation.',
  },

  {
    id: 'spa-shell-html-invalid',
    severity: 'info',
    triggers: (results) => {
      const rs = results.get('rendering-strategy');
      if (!rs || rs.status === 'pass' || rs.status === 'skip') return false;

      const d = rs.details;
      if (!d) return false;

      const spaShells = (d.spaShells as number) ?? 0;
      const sparseContent = (d.sparseContent as number) ?? 0;
      const total = ((d.serverRendered as number) ?? 0) + sparseContent + spaShells;
      // Trigger when >25% of pages are actual SPA shells (empty body post-fetch).
      // Sparse-but-rendered pages are handled by `sparse-content-html` instead;
      // conflating the two produced false-positive "client-side rendering"
      // accusations on sites whose pages are server-rendered but legitimately short.
      return total > 0 && spaShells / total > 0.25;
    },
    message: (results) => {
      const rs = results.get('rendering-strategy');
      const d = rs?.details;
      const spaShells = (d?.spaShells as number) ?? 0;
      const sparseContent = (d?.sparseContent as number) ?? 0;
      const total = ((d?.serverRendered as number) ?? 0) + sparseContent + spaShells;

      const mdSupport = results.get('markdown-url-support');
      const mdNote =
        mdSupport?.status === 'pass'
          ? ' Your markdown path still works for agents that can discover it.'
          : ' Agents currently have no alternative path to content on affected pages.';

      return (
        `${spaShells} of ${total} sampled pages are client-side-rendered ` +
        'shells: the HTML response contains a framework root element but no ' +
        'documentation content. Agents using HTTP fetches receive empty pages. ' +
        'Page size and content structure scores for the HTML path are ' +
        `discounted because they are partially measuring shells rather than content.${mdNote}`
      );
    },
    resolution:
      'Enable server-side rendering or static generation for affected page ' +
      'types. If only specific page templates use client-side content ' +
      'loading, target those templates rather than rebuilding the entire site.',
  },

  {
    id: 'sparse-content-html',
    severity: 'info',
    triggers: (results, triggered) => {
      const rs = results.get('rendering-strategy');
      if (!rs || rs.status === 'pass' || rs.status === 'skip') return false;

      const d = rs.details;
      if (!d) return false;

      const spaShells = (d.spaShells as number) ?? 0;
      const sparseContent = (d.sparseContent as number) ?? 0;
      const total = ((d.serverRendered as number) ?? 0) + sparseContent + spaShells;
      if (total === 0) return false;

      // Fire when sparse pages are common AND shells aren't the dominant story.
      // If `spa-shell-html-invalid` already fired, suppress this one to avoid
      // double-reporting on mixed sites — the shell diagnostic is the bigger
      // problem and the resolution covers both.
      if (triggered.has('spa-shell-html-invalid')) return false;
      return sparseContent / total > 0.25;
    },
    message: (results) => {
      const rs = results.get('rendering-strategy');
      const d = rs?.details;
      const spaShells = (d?.spaShells as number) ?? 0;
      const sparseContent = (d?.sparseContent as number) ?? 0;
      const total = ((d?.serverRendered as number) ?? 0) + sparseContent + spaShells;

      const mdSupport = results.get('markdown-url-support');
      const mdNote =
        mdSupport?.status === 'pass'
          ? ' Your markdown path still works for agents that can discover it.'
          : ' Agents have no alternative path on affected pages, so any missing content is invisible.';

      return (
        `${sparseContent} of ${total} sampled pages render server-side but ` +
        'have unusually short body content. The HTML response contains real ' +
        'content (headings and visible text), just less than the threshold ' +
        'for a full documentation page. This is often legitimate (short ' +
        'reference pages, integration one-liners, glossary entries), but ' +
        'can also indicate a renderer that is not emitting full content. ' +
        'Page size scoring on the HTML path is discounted for these ' +
        `pages.${mdNote}`
      );
    },
    resolution:
      'Verify the affected pages render their full content server-side. If ' +
      'the pages are intentionally brief, no action is needed; this is ' +
      'informational. If content is missing, check whether your renderer ' +
      'is emitting paragraphs, lists, and code blocks server-side rather ' +
      'than hydrating them client-side.',
  },

  {
    id: 'no-viable-path',
    severity: 'critical',
    triggers: (results, triggered) => {
      const exists = results.get('llms-txt-exists');

      // llms.txt either missing or effectively broken (<10% of links resolve)
      const llmsUsable = (() => {
        if (exists?.status === 'fail') return false;
        if (exists?.status !== 'pass' && exists?.status !== 'warn') return false;
        const linksResolve = results.get('llms-txt-links-resolve');
        if (!linksResolve) return true; // not tested, assume usable
        const resolveRate = linksResolve.details?.resolveRate as number | undefined;
        if (resolveRate !== undefined && resolveRate < 10) return false;
        return true;
      })();

      if (llmsUsable) return false;

      const rs = results.get('rendering-strategy');
      if (rs && rs.status !== 'fail' && rs.status !== 'skip') return false;

      const mdSupport = results.get('markdown-url-support');
      if (mdSupport?.status === 'fail') return true;
      if (
        triggered.has('markdown-undiscoverable') ||
        triggered.has('markdown-partially-discoverable')
      )
        return true;

      return false;
    },
    message: (results) => {
      const exists = results.get('llms-txt-exists');
      const linksResolve = results.get('llms-txt-links-resolve');
      const resolveRate = linksResolve?.details?.resolveRate as number | undefined;

      const llmsReason =
        exists?.status === 'fail'
          ? 'There is no llms.txt for navigation'
          : `The llms.txt exists but only ${resolveRate ?? 0}% of links resolve, making it effectively unusable`;

      return (
        `Agents have no effective way to access your documentation. ${llmsReason}, ` +
        'there is no discoverable markdown path, and the HTML responses either ' +
        "don't contain content or weren't tested. This is the lowest-possible " +
        'agent accessibility state.'
      );
    },
    resolution:
      'The single highest-impact action is creating an llms.txt at your ' +
      'site root with working links. If your site uses client-side rendering, ' +
      'enabling server-side rendering is the second priority.',
  },

  {
    id: 'auth-no-alternative',
    severity: 'critical',
    triggers: (results) => {
      const authGate = results.get('auth-gate-detection');
      const authAlt = results.get('auth-alternative-access');
      return authGate?.status === 'fail' && authAlt?.status === 'fail';
    },
    message: () =>
      'Your documentation requires authentication, and no alternative ' +
      'access paths were detected. Agents that encounter your docs will ' +
      'fall back on training data or seek secondary sources that may be ' +
      'inaccurate.',
    resolution:
      'Consider providing a public llms.txt as a navigational index, ' +
      'ungating API references and integration guides, or shipping docs ' +
      'with your SDK/package. See the spec\'s "Making Private Docs ' +
      'Agent-Accessible" section for options ordered by implementation effort.',
  },

  {
    id: 'page-size-no-markdown-escape',
    severity: 'warning',
    triggers: (results, triggered) => {
      const pageSize = results.get('page-size-html');
      if (pageSize?.status !== 'fail') return false;

      const mdSupport = results.get('markdown-url-support');
      if (mdSupport?.status === 'fail') return true;
      if (
        triggered.has('markdown-undiscoverable') ||
        triggered.has('markdown-partially-discoverable')
      )
        return true;

      return false;
    },
    message: (results) => {
      const d = results.get('page-size-html')?.details;
      const failBucket = (d?.failBucket as number) ?? 0;

      return (
        `${failBucket} pages exceed agent truncation limits on the HTML ` +
        'path, and there is no discoverable markdown path for agents to ' +
        'get smaller representations. Agents will silently receive ' +
        'truncated content on these pages.'
      );
    },
    resolution:
      'Either reduce HTML page sizes (break large pages, reduce inline ' +
      'CSS/JS), or provide markdown versions and ensure agents can discover ' +
      'them via content negotiation or an llms.txt directive.',
  },

  {
    id: 'dynamic-content-rendered-statically',
    severity: 'warning',
    triggers: (results) => collectFlatteningFindings(results).length > 0,
    message: (results) => {
      const findings = collectFlatteningFindings(results);
      const shown = findings.slice(0, 3);
      const pages = shown
        .map(
          (f) => `${f.url}: ${f.symptoms.map((s) => `${s.direction} (${s.evidence})`).join('; ')}`,
        )
        .join('. ');
      const more =
        findings.length > shown.length ? ` And ${findings.length - shown.length} more.` : '';
      const noun = findings.length === 1 ? 'page shows' : 'pages show';
      return (
        `${findings.length} generated ${noun} several symptoms of the same ` +
        `flattening problem. ${pages}.${more} Each check flags one symptom, ` +
        'but the cause is shared: the markdown variant is a second rendering ' +
        'pipeline, and it needs the same QA the HTML pipeline gets.'
      );
    },
    resolution:
      'Treat these as one pipeline problem rather than separate findings. ' +
      'Review the generator that produces the agent-facing representation of ' +
      'the affected pages for how it dumps widget data, whether it inherits UI ' +
      'pagination or a default filter, and how it writes links, then re-run ' +
      'embedded-data-serialization, single-fetch-completeness, ' +
      'markdown-content-parity, and markdown-link-portability together on ' +
      'those pages.',
  },

  {
    id: 'bot-protection-scan-reliability',
    severity: 'warning',
    triggers: (results, _triggered, report) => isScanDegradedByBotProtection(results, report),
    message: (results, _triggered, report) => {
      const counts = failureCounts(results, report);
      const check = results.get('bot-protection-interference');
      const verdict =
        check?.status === 'fail'
          ? ' The bot-protection-interference check found sustained interference.'
          : check?.status === 'warn'
            ? ' The bot-protection-interference check found intermittent interference.'
            : '';

      if (!counts || counts.requests === 0) {
        return (
          'Bot protection interfered with this scan, so multi-page checks ' +
          'were computed from whatever sample of pages survived.' +
          verdict
        );
      }

      const pct = Math.round((counts.failed / counts.requests) * 100);
      const responded = counts.requests - counts.failed;
      const kinds: string[] = [];
      if (counts.stalledBodies > 0) kinds.push(`${counts.stalledBodies} stalled bodies`);
      if (counts.challengePages > 0) kinds.push(`${counts.challengePages} challenge pages`);
      if (counts.fetchErrors > 0) kinds.push(`${counts.fetchErrors} connection errors`);
      if (counts.denied > 0) kinds.push(`${counts.denied} denied responses`);
      const breakdown = kinds.length > 0 ? ` (${kinds.join(', ')})` : '';

      const affected = check?.details?.affectedChecks;
      const affectedNote =
        Array.isArray(affected) && affected.length > 0
          ? ` Checks that ran during the interference window: ${(affected as string[]).join(', ')}.`
          : '';

      return (
        `${pct}% of HTTP requests during this scan failed, timed out, or were denied${breakdown}. ` +
        'The site may be rate-limiting or tarpitting automated clients; ' +
        `multi-page check scores reflect only the ${responded} requests that completed, ` +
        'not the full site.' +
        verdict +
        affectedNote
      );
    },
    resolution:
      'Treat the scores as measuring a smaller sample than they appear to. ' +
      'Behavioral enforcement is stateful and decays, so re-run after a ' +
      'cooldown or from a different network vantage point, and raise ' +
      '--request-delay if the cadence is yours to control. For the site-side ' +
      'fix, see the bot-protection-interference check: exempt public ' +
      'documentation routes from behavioral bot enforcement.',
  },

  // --- run-level diagnostics (don't depend on other diagnostics) ---

  {
    id: 'single-page-sample',
    severity: 'warning',
    triggers: (_results, _triggered, report) => {
      const isDiscoveryBased =
        report.samplingStrategy === 'random' || report.samplingStrategy === 'deterministic';
      return (
        isDiscoveryBased &&
        report.testedPages !== undefined &&
        report.testedPages < MIN_PAGES_FOR_SCORING
      );
    },
    message: (_results, _triggered, report) => {
      const n = report.testedPages ?? 0;
      const pageWord = n === 1 ? 'page was' : 'pages were';
      return (
        `Only ${n} ${pageWord} discovered and tested (minimum ${MIN_PAGES_FOR_SCORING} ` +
        'needed for reliable scoring). Page-level category scores (page size, ' +
        'content structure, URL stability, etc.) may not represent the site. ' +
        'These categories are marked as N/A in the score.'
      );
    },
    resolution:
      'If your site has an llms.txt, ensure it contains working links so ' +
      'the tool can discover more pages. If testing a preview deployment, ' +
      'use --canonical-origin to rewrite cross-origin llms.txt links. You ' +
      'can also provide specific pages with --urls.',
  },

  {
    id: 'cross-origin-llms-txt',
    severity: 'warning',
    triggers: (results) => {
      const linkResolve = results.get('llms-txt-links-resolve');
      if (!linkResolve || linkResolve.status === 'skip') return false;
      const d = linkResolve.details;
      if (!d) return false;
      const sameOrigin = d.sameOrigin as { total?: number } | undefined;
      const crossOrigin = d.crossOrigin as { total?: number } | undefined;
      return (sameOrigin?.total ?? 0) === 0 && (crossOrigin?.total ?? 0) > 0;
    },
    message: (results) => {
      const d = results.get('llms-txt-links-resolve')?.details;
      const crossOrigin = d?.crossOrigin as { total?: number; dominantOrigin?: string } | undefined;
      const total = crossOrigin?.total ?? 0;
      const dominant = crossOrigin?.dominantOrigin ?? 'an external origin';
      return (
        `All ${total} links in your llms.txt point to ${dominant}, not ` +
        'the origin being tested. This typically happens when testing a ' +
        'preview or staging deployment whose llms.txt still references the ' +
        'production domain. Page discovery falls back to a single page.'
      );
    },
    resolution:
      'Use --canonical-origin <production-origin> to rewrite cross-origin ' +
      'links during testing. For example: --canonical-origin https://docs.example.com',
  },

  {
    id: 'gzipped-sitemap-skipped',
    severity: 'info',
    triggers: (results) => {
      for (const result of results.values()) {
        const warnings = result.details?.discoveryWarnings as string[] | undefined;
        if (warnings?.some((w) => w.includes('gzipped sitemap'))) return true;
      }
      return false;
    },
    message: (results) => {
      const urls: string[] = [];
      for (const result of results.values()) {
        const warnings = result.details?.discoveryWarnings as string[] | undefined;
        if (!warnings) continue;
        for (const w of warnings) {
          if (w.includes('gzipped sitemap')) {
            const match = w.match(/:\s*(.+)$/);
            if (match) urls.push(match[1]);
          }
        }
      }
      const urlNote = urls.length > 0 ? ` (${urls.join(', ')})` : '';
      return (
        `A gzipped sitemap was skipped during URL discovery${urlNote}. ` +
        'If this is the only sitemap source, it may have reduced the number ' +
        'of pages discovered for testing.'
      );
    },
    resolution:
      'Provide an uncompressed sitemap.xml alongside the gzipped version, ' +
      'or supply specific pages via --urls for targeted testing.',
  },

  {
    id: 'rate-limiting-severe',
    severity: 'warning',
    triggers: (results) => {
      let totalTested = 0;
      let totalRateLimited = 0;
      for (const result of results.values()) {
        const d = result.details;
        if (!d) continue;
        const rl = d.rateLimited as number | undefined;
        if (rl === undefined) continue;

        const pageResults = d.pageResults as unknown[] | undefined;
        const testedLinks = d.testedLinks as number | undefined;
        const tested = testedLinks ?? pageResults?.length ?? 0;

        totalTested += tested;
        totalRateLimited += rl;
      }
      return totalTested > 0 && totalRateLimited / totalTested > 0.2;
    },
    message: (results) => {
      let totalTested = 0;
      let totalRateLimited = 0;
      for (const result of results.values()) {
        const d = result.details;
        if (!d) continue;
        const rl = d.rateLimited as number | undefined;
        if (rl === undefined) continue;
        const pageResults = d.pageResults as unknown[] | undefined;
        const testedLinks = d.testedLinks as number | undefined;
        totalTested += testedLinks ?? pageResults?.length ?? 0;
        totalRateLimited += rl;
      }
      const pct = totalTested > 0 ? Math.round((totalRateLimited / totalTested) * 100) : 0;
      return (
        `${pct}% of tested URLs returned HTTP 429 (rate limited). Check ` +
        'results may be unreliable because rate-limited requests are not ' +
        'retried indefinitely.'
      );
    },
    resolution:
      'Increase --request-delay to slow down requests, or contact the site ' +
      'operator to allowlist your IP or user-agent for testing.',
  },
];

/**
 * Evaluate all interaction diagnostics against a set of check results.
 * Returns triggered diagnostics in evaluation order.
 */
export function evaluateDiagnostics(
  results: Map<string, CheckResult>,
  report: ReportResult,
): Diagnostic[] {
  const triggered = new Set<string>();
  const diagnostics: Diagnostic[] = [];

  for (const def of DIAGNOSTIC_DEFINITIONS) {
    if (def.triggers(results, triggered, report)) {
      triggered.add(def.id);
      diagnostics.push({
        id: def.id,
        severity: def.severity,
        message: def.message(results, triggered, report),
        resolution: def.resolution,
      });
    }
  }

  return diagnostics;
}
