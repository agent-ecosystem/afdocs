export type Grade = 'A+' | 'A' | 'B' | 'C' | 'D' | 'F';

export type DiagnosticSeverity = 'critical' | 'warning' | 'info';

export type ScoreDisplayMode = 'numeric' | 'notApplicable';

export interface CheckScore {
  /** Base weight from the tier assignment. */
  baseWeight: number;
  /** Product of all applicable cluster coefficients (1.0 if none). */
  coefficient: number;
  /** baseWeight * coefficient */
  effectiveWeight: number;
  /** 0–1 proportion from page-level detail (1.0 for single-resource pass). */
  proportion: number;
  /** proportion * effectiveWeight */
  earnedScore: number;
  /** effectiveWeight (the maximum this check could earn). */
  maxScore: number;
  /** Whether this score is meaningful. 'notApplicable' when insufficient data. */
  scoreDisplayMode: ScoreDisplayMode;
  /**
   * True when bot protection degraded the scan and this multi-page check was
   * computed from whatever sample of pages survived. The score still counts;
   * it just measures a smaller sample than it appears to.
   */
  partialSample?: boolean;
}

export interface CategoryScore {
  score: number | null;
  grade: Grade | null;
}

export interface TagCheckBreakdown {
  checkId: string;
  category: string;
  weight: number;
  proportion: number;
  pages: Array<{ url: string; status: string }>;
}

export interface TagScore {
  score: number;
  grade: Grade;
  pageCount: number;
  checks: TagCheckBreakdown[];
}

export interface ScoreCap {
  /** The cap value applied. */
  cap: number;
  /** The check that triggered the cap. */
  checkId: string;
  /** Why this cap was applied. */
  reason: string;
}

export interface Diagnostic {
  id: string;
  severity: DiagnosticSeverity;
  message: string;
  resolution: string;
}

export interface ScoreResult {
  overall: number;
  grade: Grade;
  /** Present when a critical check cap reduced the score. */
  cap?: ScoreCap;
  categoryScores: Record<string, CategoryScore>;
  checkScores: Record<string, CheckScore>;
  diagnostics: Diagnostic[];
  /** Per-check resolution text for warn/fail checks, keyed by check ID. */
  resolutions: Record<string, string>;
  /** Per-tag aggregate scores when curated pages have tags. */
  tagScores?: Record<string, TagScore>;
}
