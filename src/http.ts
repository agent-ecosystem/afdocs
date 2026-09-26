import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import type {
  FetchObserver,
  FetchRecord,
  HttpClient,
  HttpRequestOptions,
  HttpResponse,
} from './types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'));
const USER_AGENT = `afdocs/${pkg.version}`;

interface RateLimitedHttpClientOptions {
  requestDelay: number;
  requestTimeout: number;
  maxConcurrency: number;
  /** Canonical base URL to find in bodies (origin, or origin plus a path prefix). */
  canonicalOrigin?: string;
  /** Value to replace it with: the target origin, or the full target base for a path-prefix canonical. */
  targetOrigin?: string;
  /** Receives one record per completed request, plus body contents as they are read. */
  observer?: FetchObserver;
}

const MAX_RETRIES = 2;

/**
 * Thrown when a response's headers arrived but its body did not finish within
 * the request timeout: the tarpit signature. Callers can distinguish it from
 * ordinary fetch failures by class as well as by message.
 */
export class BodyReadTimeoutError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'BodyReadTimeoutError';
  }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function createHttpClient(options: RateLimitedHttpClientOptions): HttpClient {
  let lastRequestTime = 0;
  let activeRequests = 0;
  let seq = 0;
  const observer = options.observer;
  // URLs whose body stalled once this run. Every later fetch of the same URL
  // fails immediately with the same error instead of paying another full
  // request timeout: a stalled URL is fetched by several page-level checks,
  // and each would otherwise wait out the timeout again. The short-circuit is
  // not recorded in the ledger, so a single tarpitted page counts once.
  const stalledUrls = new Map<string, string>();
  // Match the canonical base only at a URL boundary: end-of-string or one of these
  // delimiters. `)` and `,` are included so URLs inside markdown links `[x](url)` and
  // prose `url, next` rewrite; the rare tradeoff is a path segment like `/docs,2024`
  // being treated as the `/docs` prefix. `<` is included so a URL ending exactly at
  // the canonical base rewrites when an XML closing tag follows (`<loc>url</loc>` in
  // sitemaps); a literal `<` can never appear in a valid URL, so it is unambiguous.
  const originPattern =
    options.canonicalOrigin && options.targetOrigin
      ? new RegExp(escapeRegExp(options.canonicalOrigin) + '(?=[/?#\\s"\'\\]),<>]|$)', 'g')
      : null;

  async function waitForSlot(): Promise<void> {
    // Wait for concurrency slot
    while (activeRequests >= options.maxConcurrency) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    // Enforce delay between requests
    const now = Date.now();
    const elapsed = now - lastRequestTime;
    if (elapsed < options.requestDelay) {
      await new Promise((resolve) => setTimeout(resolve, options.requestDelay - elapsed));
    }
  }

  return {
    async fetch(url: string, reqOptions?: HttpRequestOptions): Promise<HttpResponse> {
      const stalledMessage = stalledUrls.get(url);
      if (stalledMessage !== undefined) {
        throw new BodyReadTimeoutError(stalledMessage);
      }

      let retries = 0;

      while (true) {
        await waitForSlot();
        activeRequests++;
        lastRequestTime = Date.now();

        try {
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), options.requestTimeout);

          let response: Response;
          try {
            response = await globalThis.fetch(url, {
              method: reqOptions?.method ?? 'GET',
              headers: { 'User-Agent': USER_AGENT, ...reqOptions?.headers },
              redirect: reqOptions?.redirect ?? 'follow',
              signal: reqOptions?.signal ?? controller.signal,
            });
          } catch (err) {
            observer?.onRecord({
              seq: ++seq,
              url,
              status: null,
              outcome: 'fetch-error',
              error: err instanceof Error ? err.message : String(err),
            });
            throw err;
          } finally {
            clearTimeout(timeout);
          }

          // Retry on 429 with Retry-After, up to MAX_RETRIES times
          const retryAfter = response.headers.get('Retry-After');
          if (response.status === 429 && retryAfter && retries < MAX_RETRIES) {
            const delaySec = parseInt(retryAfter, 10);
            if (!isNaN(delaySec) && delaySec > 0 && delaySec <= 60) {
              retries++;
              await new Promise((resolve) => setTimeout(resolve, delaySec * 1000));
              continue;
            }
          }

          const record: FetchRecord = { seq: ++seq, url, status: response.status, outcome: 'ok' };
          observer?.onRecord(record);

          // The timeout above only covers the connection/header phase; fetch
          // resolves as soon as headers arrive. A server that then stalls the
          // body (e.g. a bot-management tarpit that holds the connection open
          // and never finishes the response) would hang an unguarded
          // response.text() forever. Re-arm the same controller around every
          // body read so a stalled body aborts instead of hanging the run.
          // Body reads annotate the request's ledger record in place.
          const readBody = async (): Promise<string> => {
            let bodyTimedOut = false;
            const bodyTimeout = setTimeout(() => {
              bodyTimedOut = true;
              controller.abort();
            }, options.requestTimeout);
            try {
              const body = await response.text();
              observer?.onBody(record, body, response.headers.get('content-type') ?? '');
              return body;
            } catch (err) {
              // Surface a stalled body distinctly from generic aborts so
              // scorecard "failed to fetch" details can distinguish tarpit
              // behavior from ordinary fetch flakiness.
              if (bodyTimedOut) {
                const message = `Body read timed out after ${options.requestTimeout}ms (response stalled; server may be rate-limiting or tarpitting automated clients)`;
                record.outcome = 'stalled-body';
                record.error = message;
                stalledUrls.set(url, message);
                throw new BodyReadTimeoutError(message, { cause: err });
              }
              throw err;
            } finally {
              clearTimeout(bodyTimeout);
            }
          };

          if (originPattern && options.targetOrigin) {
            const ct = response.headers.get('content-type') ?? '';
            if (/text|xml|json|markdown/.test(ct)) {
              const body = await readBody();
              originPattern.lastIndex = 0;
              // Use a function replacer so `$` in the target (e.g. a preview path
              // containing `$'` or `$&`) is inserted literally, not interpreted as a
              // String.replace replacement pattern.
              const target = options.targetOrigin;
              const rewritten = body.replace(originPattern, () => target);
              return {
                ok: response.ok,
                status: response.status,
                statusText: response.statusText,
                headers: response.headers,
                url: response.url,
                redirected: response.redirected,
                text: async () => rewritten,
              } as HttpResponse;
            }
          }

          return {
            ok: response.ok,
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
            url: response.url,
            redirected: response.redirected,
            text: readBody,
          } as HttpResponse;
        } finally {
          activeRequests--;
        }
      }
    },
  };
}
