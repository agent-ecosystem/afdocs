import type { CheckResult, ReportResult } from '../types.js';
import type { Diagnostic, DiagnosticSeverity } from './types.js';
import { MIN_PAGES_FOR_SCORING } from '../constants.js';
import { t } from '../i18n/index.js';

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
  resolution: () => string;
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
    message: () => t('diagnostic.markdown-undiscoverable.message'),
    resolution: () => t('diagnostic.markdown-undiscoverable.resolution'),
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
    message: () => t('diagnostic.markdown-partially-discoverable.message'),
    resolution: () => t('diagnostic.markdown-partially-discoverable.resolution'),
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

      return t('diagnostic.truncated-index.message', {
        size: maxSize.toLocaleString(),
        visiblePct,
      });
    },
    resolution: () => t('diagnostic.truncated-index.resolution'),
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
          ? t('diagnostic.spa-shell-html-invalid.md_note_ok')
          : t('diagnostic.spa-shell-html-invalid.md_note_bad');

      return t('diagnostic.spa-shell-html-invalid.message', { spaShells, total, mdNote });
    },
    resolution: () => t('diagnostic.spa-shell-html-invalid.resolution'),
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
          ? t('diagnostic.sparse-content-html.md_note_ok')
          : t('diagnostic.sparse-content-html.md_note_bad');

      return t('diagnostic.sparse-content-html.message', { sparseContent, total, mdNote });
    },
    resolution: () => t('diagnostic.sparse-content-html.resolution'),
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
          ? t('diagnostic.no-viable-path.llms_missing')
          : t('diagnostic.no-viable-path.llms_broken', { resolveRate: resolveRate ?? 0 });

      return t('diagnostic.no-viable-path.message', { llmsReason });
    },
    resolution: () => t('diagnostic.no-viable-path.resolution'),
  },

  {
    id: 'auth-no-alternative',
    severity: 'critical',
    triggers: (results) => {
      const authGate = results.get('auth-gate-detection');
      const authAlt = results.get('auth-alternative-access');
      return authGate?.status === 'fail' && authAlt?.status === 'fail';
    },
    message: () => t('diagnostic.auth-no-alternative.message'),
    resolution: () => t('diagnostic.auth-no-alternative.resolution'),
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

      return t('diagnostic.page-size-no-markdown-escape.message', { failBucket });
    },
    resolution: () => t('diagnostic.page-size-no-markdown-escape.resolution'),
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
      const pageWord =
        n === 1
          ? t('diagnostic.single-page-sample.page_was')
          : t('diagnostic.single-page-sample.pages_were');
      return t('diagnostic.single-page-sample.message', {
        n,
        pageWord,
        min: MIN_PAGES_FOR_SCORING,
      });
    },
    resolution: () => t('diagnostic.single-page-sample.resolution'),
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
      return t('diagnostic.cross-origin-llms-txt.message', { total, dominant });
    },
    resolution: () => t('diagnostic.cross-origin-llms-txt.resolution'),
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
      return t('diagnostic.gzipped-sitemap-skipped.message', { urlNote });
    },
    resolution: () => t('diagnostic.gzipped-sitemap-skipped.resolution'),
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
      return t('diagnostic.rate-limiting-severe.message', { pct });
    },
    resolution: () => t('diagnostic.rate-limiting-severe.resolution'),
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
        resolution: def.resolution(),
      });
    }
  }

  return diagnostics;
}
