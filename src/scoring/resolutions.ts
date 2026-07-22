import type { CheckResult, CheckStatus } from '../types.js';
import { t } from '../i18n/index.js';

interface ResolutionTemplate {
  warn?: (details: Record<string, unknown>) => string;
  fail?: (details: Record<string, unknown>) => string;
}

const RESOLUTION_TEMPLATES: Record<string, ResolutionTemplate> = {
  'llms-txt-exists': {
    warn: () => t('resolution.llms-txt-exists.warn'),
    fail: () => t('resolution.llms-txt-exists.fail'),
  },

  'llms-txt-valid': {
    warn: () => t('resolution.llms-txt-valid.warn'),
    fail: () => t('resolution.llms-txt-valid.fail'),
  },

  'llms-txt-size': {
    warn: (d) => t('resolution.llms-txt-size.warn', { size: formatSize(d) }),
    fail: (d) => t('resolution.llms-txt-size.fail', { size: formatSize(d) }),
  },

  'llms-txt-links-resolve': {
    warn: (d) => {
      const broken = (d.broken as Array<unknown>)?.length ?? 0;
      const total = (d.testedLinks as number) ?? 0;
      return t('resolution.llms-txt-links-resolve.warn', { broken, total });
    },
    fail: (d) => {
      const broken = (d.broken as Array<unknown>)?.length ?? 0;
      const total = (d.testedLinks as number) ?? 0;
      return t('resolution.llms-txt-links-resolve.fail', { broken, total });
    },
  },

  'llms-txt-links-markdown': {
    warn: () => t('resolution.llms-txt-links-markdown.warn'),
    fail: () => t('resolution.llms-txt-links-markdown.fail'),
  },

  'llms-txt-directive-html': {
    warn: () => t('resolution.llms-txt-directive-html.warn'),
    fail: () => t('resolution.llms-txt-directive-html.fail'),
  },

  'llms-txt-directive-md': {
    warn: () => t('resolution.llms-txt-directive-md.warn'),
    fail: () => t('resolution.llms-txt-directive-md.fail'),
  },

  'markdown-url-support': {
    warn: (d) => {
      const warnCount = countStatus(d, 'warn');
      const tested = (d.testedPages as number) ?? 0;
      return t('resolution.markdown-url-support.warn', { warnCount, tested });
    },
    fail: () => t('resolution.markdown-url-support.fail'),
  },

  'content-negotiation': {
    warn: () => t('resolution.content-negotiation.warn'),
    fail: () => t('resolution.content-negotiation.fail'),
  },

  'rendering-strategy': {
    warn: (d) => {
      const warnCount = (d.sparseContent as number) ?? 0;
      const tested = (d.testedPages as number) ?? 0;
      return t('resolution.rendering-strategy.warn', { warnCount, tested });
    },
    fail: (d) => {
      const failCount = (d.spaShells as number) ?? 0;
      const tested = (d.testedPages as number) ?? 0;
      return t('resolution.rendering-strategy.fail', { failCount, tested });
    },
  },

  'page-size-markdown': {
    warn: (d) => {
      const warnCount = (d.warnBucket as number) ?? 0;
      const tested = (d.testedPages as number) ?? 0;
      return t('resolution.page-size-markdown.warn', { warnCount, tested });
    },
    fail: (d) => {
      const failCount = (d.failBucket as number) ?? 0;
      const tested = (d.testedPages as number) ?? 0;
      return t('resolution.page-size-markdown.fail', { failCount, tested });
    },
  },

  'page-size-html': {
    warn: (d) => {
      const warnCount = (d.warnBucket as number) ?? 0;
      const tested = (d.testedPages as number) ?? 0;
      return t('resolution.page-size-html.warn', { warnCount, tested });
    },
    fail: (d) => {
      const failCount = (d.failBucket as number) ?? 0;
      const tested = (d.testedPages as number) ?? 0;
      return t('resolution.page-size-html.fail', { failCount, tested });
    },
  },

  'content-start-position': {
    warn: (d) => {
      const warnCount = (d.warnBucket as number) ?? 0;
      const tested = (d.testedPages as number) ?? 0;
      return t('resolution.content-start-position.warn', { warnCount, tested });
    },
    fail: (d) => {
      const failCount = (d.failBucket as number) ?? 0;
      const tested = (d.testedPages as number) ?? 0;
      return t('resolution.content-start-position.fail', { failCount, tested });
    },
  },

  'tabbed-content-serialization': {
    warn: (d) => {
      const pages = d.tabbedPages as Array<{ status?: string }> | undefined;
      const warnCount = pages?.filter((p) => p.status === 'warn').length ?? 0;
      return t('resolution.tabbed-content-serialization.warn', { warnCount });
    },
    fail: (d) => {
      const pages = d.tabbedPages as Array<{ status?: string }> | undefined;
      const failCount = pages?.filter((p) => p.status === 'fail').length ?? 0;
      return t('resolution.tabbed-content-serialization.fail', { failCount });
    },
  },

  'section-header-quality': {
    warn: () => t('resolution.section-header-quality.warn'),
    fail: () => t('resolution.section-header-quality.fail'),
  },

  'markdown-code-fence-validity': {
    fail: (d) => {
      const failCount = (d.unclosedCount as number) ?? 0;
      return t('resolution.markdown-code-fence-validity.fail', { failCount });
    },
  },

  'http-status-codes': {
    fail: () => t('resolution.http-status-codes.fail'),
  },

  'redirect-behavior': {
    warn: (d) => {
      const warnCount = (d.crossHostCount as number) ?? 0;
      return t('resolution.redirect-behavior.warn', { warnCount });
    },
    fail: (d) => {
      const failCount = (d.jsRedirectCount as number) ?? 0;
      return t('resolution.redirect-behavior.fail', { failCount });
    },
  },

  'llms-txt-coverage': {
    warn: (d) => {
      const missing = (d.missingCount as number) ?? 0;
      const coverage = (d.coverageRate as number) ?? 0;
      const warnThreshold = (d.coverageWarnThreshold as number) ?? 80;
      const passThreshold = (d.coveragePassThreshold as number) ?? 95;
      return t('resolution.llms-txt-coverage.warn', {
        coverage,
        warnThreshold,
        passThreshold,
        missing,
      });
    },
    fail: (d) => {
      const missing = (d.missingCount as number) ?? 0;
      const coverage = (d.coverageRate as number) ?? 0;
      const warnThreshold = (d.coverageWarnThreshold as number) ?? 80;
      return t('resolution.llms-txt-coverage.fail', {
        coverage,
        warnThreshold,
        missing,
      });
    },
  },

  'markdown-content-parity': {
    warn: (d) => {
      const warnCount = (d.warnBucket as number) ?? 0;
      return t('resolution.markdown-content-parity.warn', { warnCount });
    },
    fail: (d) => {
      const failCount = (d.failBucket as number) ?? 0;
      const avgMissing = (d.avgMissingPercent as number) ?? 0;
      return t('resolution.markdown-content-parity.fail', {
        failCount,
        avgMissing: Math.round(avgMissing),
      });
    },
  },

  'cache-header-hygiene': {
    warn: (d) => {
      const warnCount = (d.warnBucket as number) ?? 0;
      return t('resolution.cache-header-hygiene.warn', { warnCount });
    },
    fail: (d) => {
      const failCount = (d.failBucket as number) ?? 0;
      return t('resolution.cache-header-hygiene.fail', { failCount });
    },
  },

  'auth-gate-detection': {
    warn: () => t('resolution.auth-gate-detection.warn'),
    fail: () => t('resolution.auth-gate-detection.fail'),
  },

  'auth-alternative-access': {
    warn: () => t('resolution.auth-alternative-access.warn'),
    fail: () => t('resolution.auth-alternative-access.fail'),
  },
};

function formatSize(d: Record<string, unknown>): string {
  const sizes = d.sizes as Array<{ characters?: number }> | undefined;
  if (sizes && sizes.length > 0) {
    const maxSize = Math.max(...sizes.map((s) => s.characters ?? 0));
    return maxSize.toLocaleString();
  }
  return 'unknown';
}

function countStatus(d: Record<string, unknown>, status: CheckStatus): number {
  const pageResults = d.pageResults as Array<{ status?: string }> | undefined;
  if (!pageResults) return 0;
  return pageResults.filter((p) => p.status === status).length;
}

/**
 * Get resolution text for a check result, or undefined if none applies.
 */
export function getResolution(result: CheckResult): string | undefined {
  if (result.status !== 'warn' && result.status !== 'fail') return undefined;

  const template = RESOLUTION_TEMPLATES[result.id];
  if (!template) return undefined;

  const fn = result.status === 'warn' ? template.warn : template.fail;
  if (!fn) return undefined;

  return fn(result.details ?? {});
}
