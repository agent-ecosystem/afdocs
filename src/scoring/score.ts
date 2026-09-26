import type { CheckResult, ReportResult } from '../types.js';
import { CATEGORIES, MIN_PAGES_FOR_SCORING } from '../constants.js';
import type { CategoryScore, CheckScore, Grade, ScoreCap, ScoreResult } from './types.js';
import { getCheckWeight } from './weights.js';
import { getCheckProportion } from './proportions.js';
import { getCoefficient } from './coefficients.js';
import { evaluateDiagnostics, isScanDegradedByBotProtection } from './diagnostics.js';
import { getResolution } from './resolutions.js';
import { computeTagScores } from './tag-scores.js';

/** Multi-page checks: scored from a sample of pages rather than one site-wide resource. */
export const PAGE_LEVEL_CHECKS: ReadonlySet<string> = new Set([
  'llms-txt-directive-html',
  'llms-txt-directive-md',
  'markdown-url-support',
  'content-negotiation',
  'markdown-code-fence-validity',
  'page-size-markdown',
  'page-size-html',
  'markdown-content-parity',
  'content-start-position',
  'tabbed-content-serialization',
  'section-header-quality',
  'http-status-codes',
  'redirect-behavior',
  'rendering-strategy',
  'auth-gate-detection',
  'cache-header-hygiene',
]);

/**
 * Compute a score from a report result.
 *
 * This is the main entry point for the scoring module. It is a pure function
 * that reads a ReportResult and returns a standalone ScoreResult.
 */
export function computeScore(report: ReportResult): ScoreResult {
  const resultMap = new Map<string, CheckResult>();
  for (const r of report.results) {
    resultMap.set(r.id, r);
  }

  // Determine if page-level scores lack meaningful data
  const isDiscoveryBased =
    report.samplingStrategy === 'random' || report.samplingStrategy === 'deterministic';
  const insufficientData =
    isDiscoveryBased &&
    report.testedPages !== undefined &&
    report.testedPages < MIN_PAGES_FOR_SCORING;

  // Bot protection degraded the scan: multi-page checks are flagged as
  // computed from a partial sample. Their scores still count (the spec keeps
  // a flagged run as useful evidence); the flag tells the reader what the
  // number measures.
  const partialSample = isScanDegradedByBotProtection(resultMap, report);

  // Compute per-check scores
  const checkScores: Record<string, CheckScore> = {};

  for (const result of report.results) {
    const weight = getCheckWeight(result.id);
    if (!weight) continue;

    const proportionResult = getCheckProportion(result, weight);
    if (!proportionResult) {
      // Skipped or error: excluded from scoring entirely
      continue;
    }

    const coefficient = getCoefficient(result.id, resultMap);
    const effectiveWeight = weight.weight * coefficient;
    const earnedScore = proportionResult.proportion * effectiveWeight;
    const isNotApplicable = insufficientData && PAGE_LEVEL_CHECKS.has(result.id);

    checkScores[result.id] = {
      baseWeight: weight.weight,
      coefficient,
      effectiveWeight,
      proportion: proportionResult.proportion,
      earnedScore,
      maxScore: effectiveWeight,
      scoreDisplayMode: isNotApplicable ? 'notApplicable' : 'numeric',
      ...(partialSample && PAGE_LEVEL_CHECKS.has(result.id) && { partialSample: true }),
    };
  }

  // Overall score (exclude notApplicable checks)
  let totalEarned = 0;
  let totalMax = 0;

  for (const cs of Object.values(checkScores)) {
    if (cs.scoreDisplayMode === 'notApplicable') continue;
    totalEarned += cs.earnedScore;
    totalMax += cs.maxScore;
  }

  const rawScore = totalMax > 0 ? (totalEarned / totalMax) * 100 : 0;

  // Diagnostics (evaluated before caps so no-viable-path can trigger a cap)
  const diagnostics = evaluateDiagnostics(resultMap, report);
  const triggeredDiagnostics = new Set(diagnostics.map((d) => d.id));

  // Apply critical check caps
  const cap = computeCap(checkScores, resultMap, triggeredDiagnostics);
  const overall = Math.round(cap ? Math.min(rawScore, cap.cap) : rawScore);

  // Category scores
  const categoryScores: Record<string, CategoryScore> = {};

  for (const cat of CATEGORIES) {
    let catEarned = 0;
    let catMax = 0;
    let hasNumericCheck = false;
    let hasScoredCheck = false;

    for (const result of report.results) {
      if (result.category !== cat.id) continue;
      const cs = checkScores[result.id];
      if (!cs) continue;
      hasScoredCheck = true;
      if (cs.scoreDisplayMode === 'notApplicable') continue;
      hasNumericCheck = true;
      catEarned += cs.earnedScore;
      catMax += cs.maxScore;
    }

    if (hasScoredCheck && !hasNumericCheck) {
      categoryScores[cat.id] = { score: null, grade: null };
    } else {
      categoryScores[cat.id] = {
        score: catMax > 0 ? Math.round((catEarned / catMax) * 100) : 0,
        grade: toGrade(catMax > 0 ? Math.round((catEarned / catMax) * 100) : 0),
      };
    }
  }

  // Resolutions
  const resolutions: Record<string, string> = {};
  for (const result of report.results) {
    const resolution = getResolution(result);
    if (resolution) {
      resolutions[result.id] = resolution;
    }
  }

  const scoreResult: ScoreResult = {
    overall,
    grade: toGrade(overall),
    categoryScores,
    checkScores,
    diagnostics,
    resolutions,
  };

  if (cap && cap.cap < rawScore) {
    scoreResult.cap = cap;
  }

  const tagScores = computeTagScores(report, checkScores);
  if (tagScores) {
    scoreResult.tagScores = tagScores;
  }

  return scoreResult;
}

// ---------------------------------------------------------------------------
// Caps
// ---------------------------------------------------------------------------

function computeCap(
  checkScores: Record<string, CheckScore>,
  results: Map<string, CheckResult>,
  triggeredDiagnostics: Set<string>,
): ScoreCap | undefined {
  const caps: ScoreCap[] = [];

  // llms-txt-exists: single-resource critical, caps at 59 on fail
  const llmsExists = results.get('llms-txt-exists');
  if (llmsExists?.status === 'fail') {
    caps.push({
      cap: 59,
      checkId: 'llms-txt-exists',
      reason: 'No llms.txt found. Agents lose primary navigation.',
    });
  }

  // Multi-page critical checks: rendering-strategy, auth-gate-detection
  // Skip N/A checks — insufficient data to justify a cap.
  for (const checkId of ['rendering-strategy', 'auth-gate-detection']) {
    const cs = checkScores[checkId];
    if (!cs || cs.scoreDisplayMode === 'notApplicable') continue;

    if (cs.proportion <= 0.25) {
      caps.push({
        cap: 39,
        checkId,
        reason: `${checkId}: 75%+ of pages affected`,
      });
    } else if (cs.proportion <= 0.5) {
      caps.push({
        cap: 59,
        checkId,
        reason: `${checkId}: 50%+ of pages affected`,
      });
    }
  }

  // No viable content path: no llms.txt, no discoverable markdown, HTML path
  // broken or untested. Agents have no effective way to get content.
  if (triggeredDiagnostics.has('no-viable-path')) {
    caps.push({
      cap: 39,
      checkId: 'no-viable-path',
      reason: 'Agents have no effective way to access documentation content.',
    });
  }

  // Single-page sample: page-level checks were marked notApplicable, so the
  // remaining score reflects only a tiny subset of site-wide signal.
  if (triggeredDiagnostics.has('single-page-sample')) {
    caps.push({
      cap: 59,
      checkId: 'single-page-sample',
      reason: 'Too few pages discovered to produce a representative score.',
    });
  }

  if (caps.length === 0) return undefined;

  // Lowest cap wins
  caps.sort((a, b) => a.cap - b.cap);
  return caps[0];
}

// ---------------------------------------------------------------------------
// Grade
// ---------------------------------------------------------------------------

export function toGrade(score: number): Grade {
  if (score >= 100) return 'A+';
  if (score >= 90) return 'A';
  if (score >= 80) return 'B';
  if (score >= 70) return 'C';
  if (score >= 60) return 'D';
  return 'F';
}
