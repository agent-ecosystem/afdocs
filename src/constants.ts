import type { CheckOptions, SamplingStrategy, SizeThresholds, UrlPathPattern } from './types.js';

export const VALID_SAMPLING_STRATEGIES: readonly SamplingStrategy[] = [
  'random',
  'deterministic',
  'curated',
  'none',
];

export const VALID_URL_PATH_PATTERNS: readonly UrlPathPattern[] = ['clean', 'html', 'md'];

export const DEFAULT_THRESHOLDS: SizeThresholds = {
  pass: 50_000,
  fail: 100_000,
};

export const DEFAULT_OPTIONS: CheckOptions = {
  maxConcurrency: 3,
  requestDelay: 200,
  requestTimeout: 15_000,
  maxLinksToTest: 50,
  samplingStrategy: 'random',
  thresholds: DEFAULT_THRESHOLDS,
};

export const CATEGORIES = [
  { id: 'content-discoverability', name: 'Content Discoverability', order: 1 },
  { id: 'markdown-availability', name: 'Markdown Availability', order: 2 },
  { id: 'page-size', name: 'Page Size and Truncation Risk', order: 3 },
  { id: 'content-structure', name: 'Content Structure', order: 4 },
  { id: 'url-stability', name: 'URL Stability and Redirects', order: 5 },
  { id: 'observability', name: 'Observability and Content Health', order: 6 },
  { id: 'authentication', name: 'Authentication and Access', order: 7 },
] as const;

export const CATEGORY_ORDER: Record<string, number> = Object.fromEntries(
  CATEGORIES.map((c) => [c.id, c.order]),
);

/** Link resolution threshold: warn if > 90% resolve, fail if <= 90%. */
export const LINK_RESOLVE_THRESHOLD = 0.9;

/** Maximum number of URLs to collect from sitemaps before stopping. */
export const MAX_SITEMAP_URLS = 500;

/** Default llms-txt-coverage pass threshold (percentage). */
export const DEFAULT_COVERAGE_PASS_THRESHOLD = 95;

/** Default llms-txt-coverage warn threshold (percentage). */
export const DEFAULT_COVERAGE_WARN_THRESHOLD = 80;

/** Default markdown-content-parity pass threshold (percentage of missing segments). */
export const DEFAULT_PARITY_PASS_THRESHOLD = 5;

/** Default markdown-content-parity warn threshold (percentage of missing segments). */
export const DEFAULT_PARITY_WARN_THRESHOLD = 20;

/** Minimum discovered pages before page-level scores are considered meaningful. */
export const MIN_PAGES_FOR_SCORING = 5;

/** Base URL for the Agent-Friendly Documentation Spec. */
export const SPEC_BASE_URL = 'https://agentdocsspec.com/spec/';

/** Version of the Agent-Friendly Documentation Spec implemented by this release. */
export const SPEC_VERSION = 'v0.5.0';
