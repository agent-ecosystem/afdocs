import type { DiscoverySource, SampledPages } from './helpers/get-page-urls.js';

export type CheckStatus = 'pass' | 'warn' | 'fail' | 'skip' | 'error';

export interface CheckResult {
  id: string;
  category: string;
  status: CheckStatus;
  message: string;
  details?: Record<string, unknown>;
  dependsOn?: string[];
}

export interface CachedPage {
  url: string;
  markdown?: {
    content: string;
    source: 'md-url' | 'content-negotiation';
  };
}

export interface FetchedPage {
  url: string;
  status: number;
  body: string;
  contentType: string;
  isHtml: boolean;
}

export interface CheckContext {
  /** The base URL being checked (as provided by the user). */
  baseUrl: string;
  /** The origin (scheme + host) derived from baseUrl. */
  origin: string;
  /**
   * The actual origin where content lives, when the baseUrl origin redirects
   * cross-host. Set by llms-txt-exists when it detects a cross-host redirect.
   * Checks that need ground-truth data (e.g. sitemap for coverage) should
   * use this over `origin`; checks that test agent experience should use `origin`.
   */
  effectiveOrigin?: string;
  /** Results from previously-run checks, keyed by check ID. */
  previousResults: Map<string, CheckResult>;
  /** HTTP client with rate limiting. */
  http: HttpClient;
  /** Runtime options. */
  options: CheckOptions;
  /** Cached page content, keyed by original page URL. */
  pageCache: Map<string, CachedPage>;
  /** Cached raw HTML fetches, keyed by URL. Shared across checks within a single run. */
  htmlCache: Map<string, FetchedPage>;
  /** Cached sampled pages result, shared across checks within a single run. */
  _sampledPages?: SampledPages;
  /** Curated page list from config or --urls, used by the curated sampling strategy. */
  _curatedPages?: PageConfigEntry[];
  /**
   * Ledger of every HTTP request the run has made so far, in completion order.
   * `bot-protection-interference` reads it as run-level evidence; it has no
   * fetch phase of its own.
   */
  fetchLedger?: FetchLedger;
  /** Coarse classification of where the scan is running from. */
  networkContext?: NetworkContext;
}

/**
 * How a single HTTP request ended, from the scanner's point of view.
 * - `ok`: headers arrived and, if the body was read, it completed.
 * - `stalled-body`: headers arrived but the body never finished within the
 *   request timeout (the tarpit signature).
 * - `fetch-error`: no response at all (connection failure, header-phase
 *   timeout, abort).
 */
export type FetchOutcome = 'ok' | 'stalled-body' | 'fetch-error';

export interface FetchRecord {
  /** 1-based completion order within the run. */
  seq: number;
  url: string;
  /** HTTP status, or null when no response arrived. */
  status: number | null;
  outcome: FetchOutcome;
  /** Label of the bot-challenge signature matched in the body, when one was found. */
  challenge?: string;
  /**
   * The response denied the request without a challenge body: 403, 503, or a
   * 429 with no usable Retry-After. Not a failure on its own (an auth-gated
   * site is 403 from the first request); it becomes interference evidence
   * only when the block rate climbs as the scan progresses.
   */
  blocked?: boolean;
  /** Error message for `stalled-body` and `fetch-error` outcomes. */
  error?: string;
  /** The check that made the request, when the runner attributed it. */
  checkId?: string;
}

/**
 * Hooks the HTTP client calls as requests complete. Implemented by
 * `FetchLedger`; the client itself stays free of detection logic.
 */
export interface FetchObserver {
  /** Called once per request when headers arrive or the request fails. The record is mutated in place if the body later stalls. */
  onRecord(record: FetchRecord): void;
  /** Called when a body read completes, so the observer can inspect content. */
  onBody(record: FetchRecord, body: string, contentType: string): void;
}

export interface FetchLedger extends FetchObserver {
  readonly records: readonly FetchRecord[];
  /** Set by the runner around each check so records carry the check that made them. */
  currentCheckId?: string;
}

export type NetworkContextClass = 'developer-machine' | 'ci' | 'cloud';

/**
 * Coarse classification of the scan's network vantage point. Bot enforcement
 * is commonly keyed to client reputation, so a datacenter-origin scan can
 * trigger enforcement that residential traffic would not. Reports carry this
 * classification rather than the scanner's IP address, since reports are
 * often shared.
 */
export interface NetworkContext {
  classification: NetworkContextClass;
  /** Whether the classification came from environment detection or an explicit option. */
  source: 'environment' | 'option';
  /** The environment variable that drove the classification, when one did. */
  indicator?: string;
}

/** Run-level aggregate of the fetch ledger, attached to every report. */
export interface RequestSummary {
  /** Total requests made during the run (honored 429 retries are not counted separately). */
  requests: number;
  /** Requests whose body never finished within the timeout. */
  stalledBodies: number;
  /** Responses whose body matched a bot-challenge signature. */
  challengePages: number;
  /** Requests that produced no response at all. */
  fetchErrors: number;
  /** stalledBodies + challengePages + fetchErrors. */
  failed: number;
  /** failed / requests, as a 0-100 percentage (rounded). */
  failureRate: number;
}

export type SamplingStrategy = 'random' | 'deterministic' | 'curated' | 'none';

/**
 * How llms.txt `.md`/`.mdx` links map to the site's page URLs:
 * - 'clean': strip the extension (`/guide.md` → `/guide`). Default.
 * - 'html': replace the extension (`/guide.md` → `/guide.html`) for sites
 *   that serve real filenames.
 * - 'md': keep the `.md` URL as the canonical page URL for sites that serve
 *   markdown files directly.
 */
export type UrlPathPattern = 'clean' | 'html' | 'md';

export interface CuratedPageEntry {
  url: string;
  tag?: string;
}

/** A page in the config `pages` array: either a bare URL string or an object with url + tag. */
export type PageConfigEntry = string | CuratedPageEntry;

export interface CheckOptions {
  /** Maximum concurrent HTTP requests within a single check. */
  maxConcurrency: number;
  /** Delay in ms between HTTP requests. */
  requestDelay: number;
  /** Timeout in ms for individual HTTP requests. */
  requestTimeout: number;
  /** Maximum number of links to test in link-resolution checks. */
  maxLinksToTest: number;
  /** URL sampling strategy: random (default), deterministic, or none. */
  samplingStrategy: SamplingStrategy;
  /** Size thresholds. */
  thresholds: SizeThresholds;
  /** How llms.txt .md links map to page URLs. Default 'clean' (strip the extension). */
  urlPathPattern?: UrlPathPattern;
  /** Preferred locale for URL discovery (e.g. 'en', 'fr', 'ja'). Overrides auto-detection from baseUrl. */
  preferredLocale?: string;
  /** Preferred version for URL discovery (e.g. 'v3', '2.x', 'latest'). Overrides auto-detection from baseUrl. */
  preferredVersion?: string;
  /**
   * Canonical base URL to rewrite in fetched content (for preview/staging testing).
   * Accepts an origin (`https://prod.example.com`) or an origin plus a path prefix
   * (`https://prod.example.com/docs`); when a path prefix is given, matching URLs are
   * rewritten to the full target base.
   */
  canonicalOrigin?: string;
  /** Pass threshold for llms-txt-coverage (0–100). Default 95. */
  coveragePassThreshold?: number;
  /** Warn threshold for llms-txt-coverage (0–100). Default 80. */
  coverageWarnThreshold?: number;
  /** Glob patterns to exclude from the sitemap before calculating coverage. */
  coverageExclusions?: string[];
  /** Pass threshold for markdown-content-parity (0–100). Default 5. */
  parityPassThreshold?: number;
  /** Warn threshold for markdown-content-parity (0–100). Default 20. */
  parityWarnThreshold?: number;
  /** CSS selectors to strip from HTML before parity comparison (e.g. '[data-markdown-ignore]'). */
  parityExclusions?: string[];
  /**
   * Explicit network vantage point for the scan, overriding environment
   * detection. Reported alongside bot-protection findings so a reader can
   * tell a datacenter-origin scan from a residential one.
   */
  networkContext?: NetworkContextClass;
  /**
   * Explicit URL to use as the canonical llms.txt for downstream sampling and
   * analysis. When set, the standard candidate-discovery heuristic is bypassed
   * and only this URL is probed.
   *
   * Useful when a site has both an apex llms.txt (e.g. for marketing) and a
   * docs-section llms.txt, and the heuristic would otherwise pick the wrong
   * one.
   */
  llmsTxtUrl?: string;
}

export interface SizeThresholds {
  /** Characters below which content passes (default 50,000). */
  pass: number;
  /** Characters above which content fails (default 100,000). */
  fail: number;
}

export type CheckFunction = (ctx: CheckContext) => Promise<CheckResult>;

export interface CheckDefinition {
  id: string;
  category: string;
  description: string;
  /** Check IDs that must pass or warn before this check runs. Array of arrays for OR-groups. */
  dependsOn: string[][] | string[];
  run: CheckFunction;
}

export interface HttpClient {
  fetch(url: string, options?: HttpRequestOptions): Promise<HttpResponse>;
}

export interface HttpRequestOptions {
  method?: string;
  headers?: Record<string, string>;
  redirect?: 'follow' | 'manual';
  signal?: AbortSignal;
}

export interface HttpResponse {
  ok: boolean;
  status: number;
  statusText: string;
  headers: Headers;
  url: string;
  redirected: boolean;
  text(): Promise<string>;
}

export interface DiscoveredFile {
  url: string;
  content: string;
  status: number;
  redirected: boolean;
  redirectUrl?: string;
  crossHostRedirect?: boolean;
}

export interface CheckProgressStartEvent {
  phase: 'start';
  checkId: string;
  /** 1-based position among the checks selected for this run. */
  index: number;
  /** Number of checks selected for this run. */
  total: number;
}

export interface CheckProgressCompleteEvent {
  phase: 'complete';
  checkId: string;
  /** 1-based position among the checks selected for this run. */
  index: number;
  /** Number of checks selected for this run. */
  total: number;
  result: CheckResult;
  /** Wall-clock time the check took, in ms (0 for skipped checks). */
  durationMs: number;
}

export type CheckProgressEvent = CheckProgressStartEvent | CheckProgressCompleteEvent;

export interface RunnerOptions extends CheckOptions {
  /** Only run checks matching these IDs. If empty, run all. */
  checkIds?: string[];
  /** Skip checks matching these IDs, emitting a 'skip' result without running them. */
  skipCheckIds?: string[];
  /** Curated page list from config or --urls. Used when samplingStrategy is 'curated'. */
  curatedPages?: PageConfigEntry[];
  /** Called as each selected check starts and completes. The CLI uses this for stderr progress. */
  onProgress?: (event: CheckProgressEvent) => void;
}

export interface ReportResult {
  url: string;
  timestamp: string;
  specUrl: string;
  results: CheckResult[];
  summary: {
    total: number;
    pass: number;
    warn: number;
    fail: number;
    skip: number;
    error: number;
  };
  /** When curated pages have tags, maps page URL to tag label. */
  urlTags?: Record<string, string>;
  /** Which discovery methods contributed to the page URL set. */
  discoverySources?: DiscoverySource[];
  /** Number of pages tested by page-level checks. */
  testedPages?: number;
  /** The sampling strategy used for this run. */
  samplingStrategy?: SamplingStrategy;
  /** Aggregate of every HTTP request the run made. Feeds the bot-protection scan-reliability diagnostic. */
  requestSummary?: RequestSummary;
  /** Where the scan ran from, coarsely classified. */
  networkContext?: NetworkContext;
}

export interface AgentDocsConfig {
  url: string;
  checks?: string[];
  /** Check IDs to skip, emitting a 'skip' result without running them. */
  skipChecks?: string[];
  options?: Partial<CheckOptions>;
  /** Curated page URLs to test. Implies `samplingStrategy: 'curated'` when no strategy is set. */
  pages?: PageConfigEntry[];
}
