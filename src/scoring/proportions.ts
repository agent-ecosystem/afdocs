import type { CheckResult, CheckStatus } from '../types.js';
import type { CheckWeight } from './weights.js';

export interface ProportionResult {
  /** 0–1 proportion of the check that is passing/healthy. */
  proportion: number;
  /** Total items scored (for multi-page checks). */
  tested: number;
}

/**
 * Compute the 0–1 proportion for a check result.
 *
 * For single-resource checks, this maps status to 1.0 / warnCoeff / 0.0.
 * For multi-page checks, it reads the detail fields to compute a weighted
 * proportion across all tested pages.
 *
 * Returns undefined for skipped/error checks (excluded from scoring).
 */
export function getCheckProportion(
  result: CheckResult,
  weight: CheckWeight,
): ProportionResult | undefined {
  if (result.status === 'skip' || result.status === 'error') {
    return undefined;
  }

  const extractor = PROPORTION_EXTRACTORS[result.id];
  if (extractor) {
    const extracted = extractor(result, weight);
    if (extracted !== undefined) return extracted;
  }

  // Fallback: use top-level status
  return {
    proportion: statusToProportion(result.status, weight.warnCoefficient),
    tested: 1,
  };
}

function statusToProportion(status: CheckStatus, warnCoefficient: number | undefined): number {
  switch (status) {
    case 'pass':
      return 1.0;
    case 'warn':
      return warnCoefficient ?? 0.5;
    case 'fail':
      return 0.0;
    default:
      return 0.0;
  }
}

// ---------------------------------------------------------------------------
// Per-check proportion extractors
// ---------------------------------------------------------------------------

type ProportionExtractor = (
  result: CheckResult,
  weight: CheckWeight,
) => ProportionResult | undefined;

const PROPORTION_EXTRACTORS: Record<string, ProportionExtractor> = {
  // --- Bucket-based checks (passBucket / warnBucket / failBucket) ---
  'page-size-markdown': bucketExtractor,
  'page-size-html': bucketExtractor,
  'content-start-position': bucketExtractor,
  'cache-header-hygiene': bucketExtractor,
  'markdown-content-parity': bucketExtractor,

  // --- pageResults array with CheckStatus-compatible status field ---
  'markdown-code-fence-validity': pageResultsStatusExtractor,

  // --- Custom extractors for checks whose pageResults use different shapes ---
  'markdown-url-support': markdownUrlSupportExtractor,
  'content-negotiation': contentNegotiationExtractor,
  'http-status-codes': httpStatusCodesExtractor,
  'llms-txt-directive-html': llmsTxtDirectiveExtractor,
  'llms-txt-directive-md': llmsTxtDirectiveExtractor,

  // --- Custom extractors for checks with non-standard detail shapes ---
  'rendering-strategy': renderingStrategyExtractor,
  'tabbed-content-serialization': tabbedContentExtractor,
  'section-header-quality': sectionHeaderExtractor,
  'redirect-behavior': redirectBehaviorExtractor,
  'auth-gate-detection': authGateExtractor,

  // --- Per-file averaging for llms.txt checks ---
  'llms-txt-valid': llmsTxtValidExtractor,
  'llms-txt-size': llmsTxtSizeExtractor,
  'llms-txt-links-resolve': llmsTxtLinksResolveExtractor,
  'llms-txt-links-markdown': llmsTxtLinksMarkdownExtractor,

  // --- Percentage-based single-value checks ---
  'llms-txt-coverage': llmsTxtCoverageExtractor,
};

// ---------------------------------------------------------------------------
// Generic extractors
// ---------------------------------------------------------------------------

function bucketExtractor(result: CheckResult, weight: CheckWeight): ProportionResult | undefined {
  const d = result.details;
  if (!d) return undefined;

  const pass = (d.passBucket as number) ?? 0;
  const warn = (d.warnBucket as number) ?? 0;
  const fail = (d.failBucket as number) ?? 0;
  const total = pass + warn + fail;
  if (total === 0) return undefined;

  const warnCoeff = weight.warnCoefficient ?? 0.5;
  return {
    proportion: (pass + warn * warnCoeff) / total,
    tested: total,
  };
}

function pageResultsStatusExtractor(
  result: CheckResult,
  weight: CheckWeight,
): ProportionResult | undefined {
  const d = result.details;
  if (!d) return undefined;

  const pageResults = d.pageResults as Array<{ status?: string }> | undefined;
  if (!pageResults || pageResults.length === 0) return undefined;

  return countByStatus(pageResults, weight.warnCoefficient);
}

function countByStatus(
  items: Array<{ status?: string }>,
  warnCoefficient: number | undefined,
): ProportionResult {
  let pass = 0;
  let warn = 0;
  let total = 0;

  for (const item of items) {
    const s = item.status;
    if (s === 'pass') {
      pass++;
      total++;
    } else if (s === 'warn') {
      warn++;
      total++;
    } else if (s === 'fail') {
      total++;
    }
    // skip/error items excluded from proportion
  }

  if (total === 0) return { proportion: 0, tested: 0 };

  const warnCoeff = warnCoefficient ?? 0.5;
  return {
    proportion: (pass + warn * warnCoeff) / total,
    tested: total,
  };
}

// ---------------------------------------------------------------------------
// Custom extractors
// ---------------------------------------------------------------------------

function renderingStrategyExtractor(
  result: CheckResult,
  weight: CheckWeight,
): ProportionResult | undefined {
  const d = result.details;
  if (!d) return undefined;

  const serverRendered = (d.serverRendered as number) ?? 0;
  const sparseContent = (d.sparseContent as number) ?? 0;
  const spaShells = (d.spaShells as number) ?? 0;
  const total = serverRendered + sparseContent + spaShells;
  if (total === 0) return undefined;

  // serverRendered = pass, sparseContent = warn, spaShells = fail
  const warnCoeff = weight.warnCoefficient ?? 0.5;
  return {
    proportion: (serverRendered + sparseContent * warnCoeff) / total,
    tested: total,
  };
}

function tabbedContentExtractor(
  result: CheckResult,
  weight: CheckWeight,
): ProportionResult | undefined {
  const d = result.details;
  if (!d) return undefined;

  // Uses tabbedPages array instead of pageResults
  const pages = d.tabbedPages as Array<{ status?: string }> | undefined;
  if (!pages || pages.length === 0) return undefined;

  return countByStatus(pages, weight.warnCoefficient);
}

function sectionHeaderExtractor(
  result: CheckResult,
  weight: CheckWeight,
): ProportionResult | undefined {
  const d = result.details;
  if (!d) return undefined;

  // Derive status from analysis fields
  const analyses = d.analyses as
    | Array<{ hasGenericMajority?: boolean; hasCrossGroupGeneric?: boolean }>
    | undefined;
  if (!analyses || analyses.length === 0) return undefined;

  const items = analyses.map((a) => ({
    status: a.hasGenericMajority ? 'fail' : a.hasCrossGroupGeneric ? 'warn' : 'pass',
  }));

  return countByStatus(items, weight.warnCoefficient);
}

function markdownUrlSupportExtractor(
  result: CheckResult,
  weight: CheckWeight,
): ProportionResult | undefined {
  const d = result.details;
  if (!d) return undefined;

  const pageResults = d.pageResults as
    | Array<{ supported?: boolean; skipped?: boolean }>
    | undefined;
  if (!pageResults || pageResults.length === 0) return undefined;

  // Map supported boolean to pass/fail (no warn state for individual pages)
  const items = pageResults
    .filter((p) => !p.skipped)
    .map((p) => ({
      status: p.supported ? 'pass' : 'fail',
    }));

  return countByStatus(items, weight.warnCoefficient);
}

function contentNegotiationExtractor(
  result: CheckResult,
  weight: CheckWeight,
): ProportionResult | undefined {
  const d = result.details;
  if (!d) return undefined;

  const pageResults = d.pageResults as
    | Array<{ classification?: string; skipped?: boolean }>
    | undefined;
  if (!pageResults || pageResults.length === 0) return undefined;

  const items = pageResults
    .filter((p) => !p.skipped)
    .map((p) => {
      switch (p.classification) {
        case 'markdown-with-correct-type':
          return { status: 'pass' };
        case 'markdown-with-wrong-type':
          return { status: 'warn' };
        case 'html':
          return { status: 'fail' };
        default:
          return { status: 'skip' };
      }
    });

  return countByStatus(items, weight.warnCoefficient);
}

function httpStatusCodesExtractor(
  result: CheckResult,
  weight: CheckWeight,
): ProportionResult | undefined {
  const d = result.details;
  if (!d) return undefined;

  const pageResults = d.pageResults as Array<{ classification?: string }> | undefined;
  if (!pageResults || pageResults.length === 0) return undefined;

  const items = pageResults.map((p) => {
    switch (p.classification) {
      case 'correct-error':
        return { status: 'pass' };
      case 'soft-404':
        return { status: 'fail' };
      default:
        return { status: 'skip' };
    }
  });

  // All responses indeterminate (or fetch errors): exclude from scoring.
  // We can't say whether the site handles bad URLs correctly.
  if (items.every((i) => i.status === 'skip')) return undefined;

  return countByStatus(items, weight.warnCoefficient);
}

function llmsTxtDirectiveExtractor(
  result: CheckResult,
  weight: CheckWeight,
): ProportionResult | undefined {
  const d = result.details;
  if (!d) return undefined;

  const pageResults = d.pageResults as
    | Array<{ found?: boolean; positionPercent?: number; error?: string }>
    | undefined;
  if (!pageResults || pageResults.length === 0) return undefined;

  const items = pageResults
    .filter((p) => !p.error)
    .map((p) => {
      if (!p.found) return { status: 'fail' };
      // Found but buried deep (>50% into page) = warn
      if ((p.positionPercent ?? 0) > 50) return { status: 'warn' };
      return { status: 'pass' };
    });

  return countByStatus(items, weight.warnCoefficient);
}

function redirectBehaviorExtractor(
  result: CheckResult,
  weight: CheckWeight,
): ProportionResult | undefined {
  const d = result.details;
  if (!d) return undefined;

  const pageResults = d.pageResults as Array<{ classification?: string }> | undefined;
  if (!pageResults || pageResults.length === 0) return undefined;

  // Map classifications to statuses
  const items = pageResults.map((p) => {
    switch (p.classification) {
      case 'no-redirect':
      case 'same-host':
        return { status: 'pass' };
      case 'cross-host':
        return { status: 'warn' };
      case 'js-redirect':
        return { status: 'fail' };
      default:
        return { status: 'skip' };
    }
  });

  return countByStatus(items, weight.warnCoefficient);
}

function authGateExtractor(result: CheckResult, weight: CheckWeight): ProportionResult | undefined {
  const d = result.details;
  if (!d) return undefined;

  const pageResults = d.pageResults as Array<{ classification?: string }> | undefined;
  if (!pageResults || pageResults.length === 0) return undefined;

  const items = pageResults.map((p) => {
    switch (p.classification) {
      case 'accessible':
        return { status: 'pass' };
      case 'soft-auth-gate':
        return { status: 'warn' };
      case 'auth-required':
      case 'auth-redirect':
        return { status: 'fail' };
      default:
        return { status: 'skip' };
    }
  });

  return countByStatus(items, weight.warnCoefficient);
}

// ---------------------------------------------------------------------------
// Per-file llms.txt extractors
// ---------------------------------------------------------------------------

function llmsTxtValidExtractor(
  result: CheckResult,
  weight: CheckWeight,
): ProportionResult | undefined {
  const d = result.details;
  if (!d) return undefined;

  const validations = d.validations as
    | Array<{ hasH1?: boolean; hasBlockquote?: boolean; linkCount?: number; issues?: string[] }>
    | undefined;
  if (!validations || validations.length === 0) return undefined;

  // Derive per-file status: pass if well-structured, warn if has links but
  // missing structure, fail if no links at all
  const items = validations.map((v) => {
    if ((v.linkCount ?? 0) === 0) return { status: 'fail' };
    if (v.hasH1 && v.hasBlockquote) return { status: 'pass' };
    return { status: 'warn' };
  });

  return countByStatus(items, weight.warnCoefficient);
}

function llmsTxtSizeExtractor(
  result: CheckResult,
  weight: CheckWeight,
): ProportionResult | undefined {
  const d = result.details;
  if (!d) return undefined;

  const sizes = d.sizes as Array<{ characters?: number }> | undefined;
  const thresholds = d.thresholds as { pass?: number; fail?: number } | undefined;
  if (!sizes || sizes.length === 0) return undefined;

  const passThreshold = thresholds?.pass ?? 50_000;
  const failThreshold = thresholds?.fail ?? 100_000;

  const items = sizes.map((s) => {
    const chars = s.characters ?? 0;
    if (chars <= passThreshold) return { status: 'pass' };
    if (chars <= failThreshold) return { status: 'warn' };
    return { status: 'fail' };
  });

  return countByStatus(items, weight.warnCoefficient);
}

function llmsTxtLinksResolveExtractor(result: CheckResult): ProportionResult | undefined {
  const d = result.details;
  if (!d) return undefined;

  // Use the resolveRate field directly as proportion (it's a percentage 0-100)
  const resolveRate = d.resolveRate as number | undefined;
  if (resolveRate === undefined) return undefined;

  const testedLinks = (d.testedLinks as number) ?? 1;
  return {
    proportion: resolveRate / 100,
    tested: testedLinks,
  };
}

function llmsTxtLinksMarkdownExtractor(result: CheckResult): ProportionResult | undefined {
  const d = result.details;
  if (!d) return undefined;

  const markdownRate = d.markdownRate as number | undefined;
  if (markdownRate === undefined) return undefined;

  const testedLinks = (d.testedLinks as number) ?? 1;
  return {
    proportion: markdownRate / 100,
    tested: testedLinks,
  };
}

function llmsTxtCoverageExtractor(result: CheckResult): ProportionResult | undefined {
  const d = result.details;
  if (!d) return undefined;

  const coverageRate = d.coverageRate as number | undefined;
  if (coverageRate === undefined) return undefined;

  return {
    proportion: coverageRate / 100,
    tested: 1,
  };
}
