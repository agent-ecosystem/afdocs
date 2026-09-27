import type { CheckResult } from '../types.js';
import { AGENT_TRUNCATION_LIMIT } from './weights.js';

/**
 * Compute the cluster coefficient for a given check based on the full set
 * of check results. Returns 1.0 if no coefficient applies.
 *
 * Each check has at most one coefficient in the current design (the three
 * coefficient groups apply to disjoint sets of checks). If future coefficients
 * overlap, multiply them together.
 */
export function getCoefficient(checkId: string, results: Map<string, CheckResult>): number {
  if (DISCOVERY_CHECKS.has(checkId)) {
    return getDiscoveryCoefficient(results);
  }
  if (HTML_PATH_CHECKS.has(checkId)) {
    return getHtmlPathCoefficient(results);
  }
  if (INDEX_TRUNCATION_CHECKS.has(checkId)) {
    return getIndexTruncationCoefficient(results);
  }
  return 1.0;
}

// ---------------------------------------------------------------------------
// Discovery coefficient
// ---------------------------------------------------------------------------

const DISCOVERY_CHECKS = new Set([
  'page-size-markdown',
  'markdown-code-fence-validity',
  'markdown-content-parity',
  'single-fetch-completeness',
  'markdown-link-portability',
]);

/**
 * The markdown path's value depends on whether agents can discover it.
 * Returns the highest applicable coefficient.
 */
function getDiscoveryCoefficient(results: Map<string, CheckResult>): number {
  const cn = results.get('content-negotiation');
  if (cn?.status === 'pass') return 1.0;

  const directiveHtml = results.get('llms-txt-directive-html');
  const directiveMd = results.get('llms-txt-directive-md');
  if (directiveHtml?.status === 'pass' || directiveMd?.status === 'pass') return 0.8;

  const linksMd = results.get('llms-txt-links-markdown');
  if (linksMd?.status === 'pass') return 0.5;

  return 0.0;
}

// ---------------------------------------------------------------------------
// HTML path coefficient
// ---------------------------------------------------------------------------

const HTML_PATH_CHECKS = new Set([
  'page-size-html',
  'content-start-position',
  'tabbed-content-serialization',
  'section-header-quality',
  'embedded-data-serialization',
]);

/**
 * If pages are SPA shells, HTML path measurements are meaningless.
 * Uses the rendering-strategy proportion.
 */
function getHtmlPathCoefficient(results: Map<string, CheckResult>): number {
  const rs = results.get('rendering-strategy');
  if (!rs || rs.status === 'skip' || rs.status === 'error') return 1.0;

  const d = rs.details;
  if (!d) return 1.0;

  const serverRendered = (d.serverRendered as number) ?? 0;
  const sparseContent = (d.sparseContent as number) ?? 0;
  const spaShells = (d.spaShells as number) ?? 0;
  const total = serverRendered + sparseContent + spaShells;
  if (total === 0) return 1.0;

  // Same proportion formula as rendering-strategy's own score
  return (serverRendered + sparseContent * 0.5) / total;
}

// ---------------------------------------------------------------------------
// Index truncation coefficient
// ---------------------------------------------------------------------------

const INDEX_TRUNCATION_CHECKS = new Set([
  'llms-txt-links-resolve',
  'llms-txt-valid',
  'llms-txt-coverage',
  'llms-txt-links-markdown',
]);

/**
 * If llms-txt-size fails, agents only see a fraction of the index.
 * Quality of the invisible portion doesn't affect agent experience.
 */
function getIndexTruncationCoefficient(results: Map<string, CheckResult>): number {
  const sizeResult = results.get('llms-txt-size');
  if (!sizeResult) return 1.0;

  switch (sizeResult.status) {
    case 'pass':
      return 1.0;
    case 'warn':
      return 0.8;
    case 'fail': {
      const d = sizeResult.details;
      if (!d) return 0.5;

      // Use the largest file's size to compute visible fraction
      const sizes = d.sizes as Array<{ characters?: number }> | undefined;
      if (!sizes || sizes.length === 0) return 0.5;

      const maxSize = Math.max(...sizes.map((s) => s.characters ?? 0));
      if (maxSize <= 0) return 0.5;

      // visible_fraction = truncation_limit / file_size, clamped to [0, 1]
      return Math.min(1, AGENT_TRUNCATION_LIMIT / maxSize);
    }
    default:
      return 1.0;
  }
}
