import type { RunnerOptions, SamplingStrategy, UrlPathPattern } from './types.js';
import { VALID_SAMPLING_STRATEGIES, VALID_URL_PATH_PATTERNS } from './constants.js';
import { getAllChecks } from './checks/registry.js';

export interface ValidationIssue {
  field: string;
  message: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
}

export interface NumericConstraints {
  integer?: boolean;
  min?: number;
  max?: number;
}

export function validateNumber(
  value: unknown,
  field: string,
  constraints: NumericConstraints,
): ValidationIssue | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || Number.isNaN(value)) {
    return {
      field,
      message: `${field} must be a valid number, got ${typeof value === 'number' ? 'NaN' : `${typeof value} "${value}"`}`,
    };
  }
  if (constraints.integer && !Number.isInteger(value)) {
    return { field, message: `${field} must be an integer, got ${value}` };
  }
  if (constraints.min !== undefined && value < constraints.min) {
    const bound =
      constraints.max !== undefined
        ? `between ${constraints.min} and ${constraints.max}`
        : `at least ${constraints.min}`;
    return { field, message: `${field} must be ${bound}, got ${value}` };
  }
  if (constraints.max !== undefined && value > constraints.max) {
    const bound =
      constraints.min !== undefined
        ? `between ${constraints.min} and ${constraints.max}`
        : `at most ${constraints.max}`;
    return { field, message: `${field} must be ${bound}, got ${value}` };
  }
  return null;
}

function validateUrl(value: unknown, field: string): ValidationIssue | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') {
    return { field, message: `${field} must be a string` };
  }
  try {
    new URL(value);
    return null;
  } catch {
    return { field, message: `${field} is not a valid URL: "${value}"` };
  }
}

export function validateRunnerOptions(options: Partial<RunnerOptions>): ValidationResult {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];

  const pushError = (issue: ValidationIssue | null) => {
    if (issue) errors.push(issue);
  };

  // Numeric range validations
  pushError(
    validateNumber(options.maxConcurrency, 'maxConcurrency', { integer: true, min: 1, max: 100 }),
  );
  pushError(validateNumber(options.requestDelay, 'requestDelay', { integer: true, min: 0 }));
  pushError(validateNumber(options.requestTimeout, 'requestTimeout', { integer: true, min: 0 }));
  pushError(validateNumber(options.maxLinksToTest, 'maxLinksToTest', { integer: true, min: 1 }));

  if (options.thresholds) {
    pushError(
      validateNumber(options.thresholds.pass, 'thresholds.pass', { integer: true, min: 1 }),
    );
    pushError(
      validateNumber(options.thresholds.fail, 'thresholds.fail', { integer: true, min: 1 }),
    );
  }

  pushError(
    validateNumber(options.coveragePassThreshold, 'coveragePassThreshold', {
      integer: true,
      min: 0,
      max: 100,
    }),
  );
  pushError(
    validateNumber(options.coverageWarnThreshold, 'coverageWarnThreshold', {
      integer: true,
      min: 0,
      max: 100,
    }),
  );
  pushError(
    validateNumber(options.parityPassThreshold, 'parityPassThreshold', {
      integer: true,
      min: 0,
      max: 100,
    }),
  );
  pushError(
    validateNumber(options.parityWarnThreshold, 'parityWarnThreshold', {
      integer: true,
      min: 0,
      max: 100,
    }),
  );

  // Threshold ordering (only when both in a pair are provided and individually valid)
  if (
    options.thresholds &&
    typeof options.thresholds.pass === 'number' &&
    typeof options.thresholds.fail === 'number' &&
    !Number.isNaN(options.thresholds.pass) &&
    !Number.isNaN(options.thresholds.fail) &&
    options.thresholds.pass > options.thresholds.fail
  ) {
    errors.push({
      field: 'thresholds',
      message: `thresholds.pass (${options.thresholds.pass}) must be less than or equal to thresholds.fail (${options.thresholds.fail})`,
    });
  }

  if (
    options.coveragePassThreshold !== undefined &&
    options.coverageWarnThreshold !== undefined &&
    !Number.isNaN(options.coveragePassThreshold) &&
    !Number.isNaN(options.coverageWarnThreshold) &&
    options.coveragePassThreshold < options.coverageWarnThreshold
  ) {
    errors.push({
      field: 'coveragePassThreshold',
      message: `coveragePassThreshold (${options.coveragePassThreshold}) must be greater than or equal to coverageWarnThreshold (${options.coverageWarnThreshold})`,
    });
  }

  if (
    options.parityPassThreshold !== undefined &&
    options.parityWarnThreshold !== undefined &&
    !Number.isNaN(options.parityPassThreshold) &&
    !Number.isNaN(options.parityWarnThreshold) &&
    options.parityPassThreshold > options.parityWarnThreshold
  ) {
    errors.push({
      field: 'parityPassThreshold',
      message: `parityPassThreshold (${options.parityPassThreshold}) must be less than or equal to parityWarnThreshold (${options.parityWarnThreshold})`,
    });
  }

  // Sampling strategy enum
  if (
    options.samplingStrategy !== undefined &&
    !VALID_SAMPLING_STRATEGIES.includes(options.samplingStrategy as SamplingStrategy)
  ) {
    errors.push({
      field: 'samplingStrategy',
      message: `Invalid sampling strategy "${options.samplingStrategy}". Must be one of: ${VALID_SAMPLING_STRATEGIES.join(', ')}`,
    });
  }

  // URL path pattern enum
  if (
    options.urlPathPattern !== undefined &&
    !VALID_URL_PATH_PATTERNS.includes(options.urlPathPattern as UrlPathPattern)
  ) {
    errors.push({
      field: 'urlPathPattern',
      message: `Invalid URL path pattern "${options.urlPathPattern}". Must be one of: ${VALID_URL_PATH_PATTERNS.join(', ')}`,
    });
  }

  // Curated requires pages
  if (
    options.samplingStrategy === 'curated' &&
    (!options.curatedPages || options.curatedPages.length === 0)
  ) {
    errors.push({
      field: 'samplingStrategy',
      message: 'Curated sampling requires curatedPages to be non-empty',
    });
  }

  // URL validation
  pushError(validateUrl(options.canonicalOrigin, 'canonicalOrigin'));
  pushError(validateUrl(options.llmsTxtUrl, 'llmsTxtUrl'));

  // Check ID validation
  if (
    (options.checkIds && options.checkIds.length > 0) ||
    (options.skipCheckIds && options.skipCheckIds.length > 0)
  ) {
    const knownIds = getAllChecks().map((c) => c.id);
    const knownSet = new Set(knownIds);

    const validateCheckId = (id: string, field: string) => {
      if (knownSet.has(id)) return;
      const sortedIds = [...knownIds].sort();
      const hint = sortedIds.join(', ');
      errors.push({
        field,
        message: `Unknown check ID "${id}". Available checks: ${hint}`,
      });
    };

    if (options.checkIds) {
      for (const id of options.checkIds) validateCheckId(id, 'checkIds');
    }
    if (options.skipCheckIds) {
      for (const id of options.skipCheckIds) validateCheckId(id, 'skipCheckIds');
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}
