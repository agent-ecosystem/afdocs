/**
 * Typical agent context window truncation limit in characters.
 * Used for the index truncation coefficient and size-related scoring.
 */
export const AGENT_TRUNCATION_LIMIT = 100_000;

export type WeightTier = 'critical' | 'high' | 'medium' | 'low';

export interface CheckWeight {
  tier: WeightTier;
  weight: number;
  /** Coefficient applied when the check's status is 'warn'. Undefined = no warn state. */
  warnCoefficient?: number;
}

const TIER_WEIGHTS: Record<WeightTier, number> = {
  critical: 10,
  high: 7,
  medium: 4,
  low: 2,
};

function w(tier: WeightTier, warnCoefficient?: number): CheckWeight {
  return { tier, weight: TIER_WEIGHTS[tier], warnCoefficient };
}

export const CHECK_WEIGHTS: Record<string, CheckWeight> = {
  // Critical
  'llms-txt-exists': w('critical', 0.5),
  'rendering-strategy': w('critical', 0.5),
  'auth-gate-detection': w('critical', 0.5),

  // High
  'llms-txt-size': w('high', 0.5),
  'llms-txt-links-resolve': w('high', 0.75),
  'markdown-url-support': w('high', 0.5),
  'page-size-markdown': w('high', 0.5),
  'page-size-html': w('high', 0.5),
  'http-status-codes': w('high'),
  'llms-txt-directive-html': w('high', 0.6),
  'llms-txt-directive-md': w('medium', 0.6),
  'bot-protection-interference': w('high', 0.5),

  // Medium
  'llms-txt-valid': w('medium', 0.75),
  'content-negotiation': w('medium', 0.75),
  'page-size-transfer': w('medium', 0.5),
  'single-fetch-completeness': w('medium', 0.6),
  'content-start-position': w('medium', 0.5),
  'tabbed-content-serialization': w('medium', 0.5),
  'markdown-code-fence-validity': w('medium'),
  'markdown-link-portability': w('medium', 0.6),
  'llms-txt-coverage': w('medium', 0.75),
  'markdown-content-parity': w('medium', 0.75),
  'auth-alternative-access': w('medium', 0.5),
  'redirect-behavior': w('medium', 0.6),

  'llms-txt-links-markdown': w('high', 0.25),

  // Low
  'section-header-quality': w('low', 0.5),
  'cache-header-hygiene': w('low', 0.5),
};

/** Returns the weight definition for a check, or undefined if unknown. */
export function getCheckWeight(checkId: string): CheckWeight | undefined {
  return CHECK_WEIGHTS[checkId];
}
