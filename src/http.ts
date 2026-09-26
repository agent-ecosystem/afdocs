import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { TextDecoder } from 'node:util';
import type {
  FetchObserver,
  FetchRecord,
  HttpClient,
  HttpRequestOptions,
  HttpResponse,
} from './types.js';
import { MAX_CHALLENGE_PAGE_LENGTH } from './helpers/fetch-ledger.js';

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
 * A body that keeps trickling bytes is still a tarpit from the agent's point
 * of view. The idle timeout (no bytes for `requestTimeout`) catches a held
 * connection; this multiple of `requestTimeout` caps the total body read so
 * a slow trickle cannot hold a request open indefinitely either.
 */
export const BODY_TOTAL_TIMEOUT_MULTIPLIER = 4;

/** Parse a Retry-After header the client is willing to honor (1..60 seconds). */
function usableRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;
  const delaySec = parseInt(header, 10);
  return !isNaN(delaySec) && delaySec > 0 && delaySec <= 60 ? delaySec : undefined;
}

/**
 * A response that denied the request without necessarily carrying a
 * challenge body. Plain 403 and 503 are ambiguous (an auth gate is 403 from
 * the first request), so the ledger only treats them as interference when
 * the block rate climbs during the scan. A 429 with a usable Retry-After is
 * the spec's preferred form of enforcement and is never counted.
 */
function isBlockedStatus(status: number, retryAfter: string | null): boolean {
  if (status === 403 || status === 503) return true;
  return status === 429 && usableRetryAfter(retryAfter) === undefined;
}

function decodeBody(chunks: Uint8Array[], contentType: string): string {
  const charset = /charset=["']?([^;"'\s]+)/i.exec(contentType)?.[1];
  let decoder: TextDecoder;
  try {
    decoder = new TextDecoder(charset ?? 'utf-8');
  } catch {
    decoder = new TextDecoder();
  }
  let out = '';
  for (const chunk of chunks) out += decoder.decode(chunk, { stream: true });
  return out + decoder.decode();
}

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
          if (response.status === 429 && retries < MAX_RETRIES) {
            const delaySec = usableRetryAfter(response.headers.get('Retry-After'));
            if (delaySec !== undefined) {
              retries++;
              await new Promise((resolve) => setTimeout(resolve, delaySec * 1000));
              continue;
            }
          }

          const retryAfter = response.headers.get('Retry-After');
          const record: FetchRecord = { seq: ++seq, url, status: response.status, outcome: 'ok' };
          if (isBlockedStatus(response.status, retryAfter)) record.blocked = true;
          observer?.onRecord(record);

          const contentType = response.headers.get('content-type') ?? '';
          const timeoutMs = options.requestTimeout;
          const totalMs = timeoutMs * BODY_TOTAL_TIMEOUT_MULTIPLIER;
          const stallError = (kind: 'idle' | 'total', cause?: unknown): BodyReadTimeoutError => {
            const message =
              kind === 'idle'
                ? `Body read timed out after ${timeoutMs}ms (response stalled; server may be rate-limiting or tarpitting automated clients)`
                : `Body read exceeded ${totalMs}ms (response still trickling; server may be rate-limiting or tarpitting automated clients)`;
            record.outcome = 'stalled-body';
            record.error = message;
            stalledUrls.set(url, message);
            return cause === undefined
              ? new BodyReadTimeoutError(message)
              : new BodyReadTimeoutError(message, { cause });
          };

          // The header timeout above only covers the connection/header phase;
          // fetch resolves as soon as headers arrive. A server that then
          // holds the body open (a bot-management tarpit) would hang an
          // unguarded response.text() forever. Read the body as a stream and
          // re-arm an idle timer on every chunk: a stall is "no bytes for
          // requestTimeout", so a large page on a slow link that keeps
          // making progress is not mistaken for a tarpit. A total cap
          // catches a deliberate trickle.
          const readStreamedBody = async (stream: ReadableStream<Uint8Array>): Promise<string> => {
            const reader = stream.getReader();
            const chunks: Uint8Array[] = [];
            const state: { stalled: 'idle' | 'total' | null } = { stalled: null };
            let idleTimer: ReturnType<typeof setTimeout> | undefined;
            const giveUp = (kind: 'idle' | 'total') => {
              state.stalled = kind;
              void reader.cancel().catch(() => undefined);
              controller.abort();
            };
            const armIdle = () => {
              clearTimeout(idleTimer);
              idleTimer = setTimeout(() => giveUp('idle'), timeoutMs);
            };
            const totalTimer = setTimeout(() => giveUp('total'), totalMs);
            try {
              armIdle();
              while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                if (value) chunks.push(value);
                armIdle();
              }
            } catch (err) {
              if (state.stalled) throw stallError(state.stalled, err);
              throw err;
            } finally {
              clearTimeout(idleTimer);
              clearTimeout(totalTimer);
            }
            if (state.stalled) throw stallError(state.stalled);
            return decodeBody(chunks, contentType);
          };

          // Fallback for responses without a readable stream (test doubles):
          // guard the whole text() call with the idle timeout instead.
          const readWholeBody = async (): Promise<string> => {
            const state: { stalled: boolean } = { stalled: false };
            const bodyTimeout = setTimeout(() => {
              state.stalled = true;
              controller.abort();
            }, timeoutMs);
            try {
              return await response.text();
            } catch (err) {
              if (state.stalled) throw stallError('idle', err);
              throw err;
            } finally {
              clearTimeout(bodyTimeout);
            }
          };

          const readBody = async (): Promise<string> => {
            const body = response.body
              ? await readStreamedBody(response.body)
              : await readWholeBody();
            observer?.onBody(record, body, contentType);
            return body;
          };

          // A denied HTML response is read eagerly so the ledger inspects it
          // for a challenge signature even when the caller only wanted the
          // status. Block pages are tiny; anything larger than a challenge
          // page could be is left to the caller.
          let eagerBody: string | undefined;
          if (record.blocked && /text\/html/i.test(contentType)) {
            const length = Number(response.headers.get('content-length'));
            if (!(length > MAX_CHALLENGE_PAGE_LENGTH)) eagerBody = await readBody();
          }
          const eager = eagerBody;

          if (originPattern && options.targetOrigin) {
            const ct = response.headers.get('content-type') ?? '';
            if (/text|xml|json|markdown/.test(ct)) {
              const body = eager ?? (await readBody());
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
            text: eager !== undefined ? async () => eager : readBody,
          } as HttpResponse;
        } finally {
          activeRequests--;
        }
      }
    },
  };
}
