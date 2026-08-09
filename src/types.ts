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
  /** Canonical origin to rewrite in fetched content (for preview/staging testing). */
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

export interface RunnerOptions extends CheckOptions {
  /** Only run checks matching these IDs. If empty, run all. */
  checkIds?: string[];
  /** Skip checks matching these IDs, emitting a 'skip' result without running them. */
  skipCheckIds?: string[];
  /** Curated page list from config or --urls. Used when samplingStrategy is 'curated'. */
  curatedPages?: PageConfigEntry[];
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
