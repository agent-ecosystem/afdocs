// Public API
export type {
  CheckResult,
  CheckStatus,
  CheckContext,
  CheckOptions,
  CheckFunction,
  CheckDefinition,
  CheckProgressEvent,
  CheckProgressStartEvent,
  CheckProgressCompleteEvent,
  RunnerOptions,
  ReportResult,
  AgentDocsConfig,
  DiscoveredFile,
  SizeThresholds,
  SamplingStrategy,
  CuratedPageEntry,
  PageConfigEntry,
} from './types.js';

export {
  DEFAULT_OPTIONS,
  DEFAULT_THRESHOLDS,
  CATEGORIES,
  VALID_SAMPLING_STRATEGIES,
  SPEC_VERSION,
} from './constants.js';
export { validateRunnerOptions } from './validation.js';
export type { ValidationResult, ValidationIssue } from './validation.js';
export { createContext, normalizeUrl, runChecks } from './runner.js';
export { createHttpClient } from './http.js';
export { getAllChecks, getCheck, getChecksSorted, extractMarkdownLinks } from './checks/index.js';

// Scoring
export { computeScore, toGrade } from './scoring/index.js';
export type {
  ScoreResult,
  CheckScore,
  CategoryScore,
  TagScore,
  TagCheckBreakdown,
  ScoreCap,
  Diagnostic,
  DiagnosticSeverity,
  Grade,
  ScoreDisplayMode,
} from './scoring/types.js';
