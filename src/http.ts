import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { TextDecoder } from 'node:util';
import type {
  FetchObserver,
  FetchRecord,
  HttpBody,
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
 * Sent on every request unless the caller overrides them. Node's fetch sends
 * `Accept-Encoding: gzip, deflate` by default and the exact list has changed
 * between versions; pinning it keeps the transfer-size measurement
 * deterministic and matches what agent HTTP clients (curl, Python requests
 * with brotli, the browsers they wrap) typically negotiate. undici decodes
 * each of these transparently, so callers always read a decoded body.
 */
const DEFAULT_HEADERS: Record<string, string> = {
  'User-Agent': USER_AGENT,
  'Accept-Encoding': 'gzip, deflate, br',
};

/**
 * Header names are case-insensitive but object spread is not: a caller's
 * `accept-encoding` would sit next to the default `Accept-Encoding` and
 * fetch would send both, combined. Merging through `Headers` makes the
 * caller's value replace the default whatever its spelling.
 */
function buildHeaders(overrides?: Record<string, string>): Headers {
  const headers = new Headers(DEFAULT_HEADERS);
  for (const [name, value] of Object.entries(overrides ?? {})) headers.set(name, value);
  return headers;
}

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
 * the denial rate climbs during the scan. A 429 that carries any
 * Retry-After is the spec's preferred form of enforcement (the agent is told
 * how long to back off) and is never counted, even when the value is longer
 * than this client is willing to wait.
 */
function isBlockedStatus(status: number, retryAfter: string | null): boolean {
  if (status === 403 || status === 503) return true;
  return status === 429 && !retryAfter;
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
              headers: buildHeaders(reqOptions?.headers),
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
          if (response.status === 429 && retryAfter) record.retryAfter = retryAfter;
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
          const bodyError = (err: unknown): unknown => {
            // A stall recorded by an earlier read of this response (the eager
            // inspection branch) wins over the abort the caller then sees.
            if (record.outcome === 'stalled-body') {
              return new BodyReadTimeoutError(record.error ?? 'Body read stalled', { cause: err });
            }
            record.outcome = 'body-error';
            record.error = err instanceof Error ? err.message : String(err);
            return err;
          };

          interface StreamedBody {
            body: string;
            /** Decoded (post transfer-decoding) bytes read from the stream. */
            bytes: number;
            /** True when `maxBytes` was reached; the body is unusable and the reader was cancelled. */
            truncated: boolean;
          }

          const readStreamedBody = async (
            stream: ReadableStream<Uint8Array>,
            maxBytes = Infinity,
          ): Promise<StreamedBody> => {
            const reader = stream.getReader();
            const chunks: Uint8Array[] = [];
            let received = 0;
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
                if (value) {
                  chunks.push(value);
                  received += value.byteLength;
                  if (received > maxBytes) {
                    void reader.cancel().catch(() => undefined);
                    return { body: '', bytes: received, truncated: true };
                  }
                }
                armIdle();
              }
            } catch (err) {
              if (state.stalled) throw stallError(state.stalled, err);
              throw bodyError(err);
            } finally {
              clearTimeout(idleTimer);
              clearTimeout(totalTimer);
            }
            if (state.stalled) throw stallError(state.stalled);
            return { body: decodeBody(chunks, contentType), bytes: received, truncated: false };
          };

          // Fallback for responses without a readable stream (test doubles):
          // race the whole text() call against the idle timeout. The abort is
          // still signalled, but the race is what guarantees the guard when a
          // double ignores the controller.
          const readWholeBody = async (): Promise<HttpBody> => {
            let bodyTimeout: ReturnType<typeof setTimeout> | undefined;
            const timedOut = new Promise<never>((_resolve, reject) => {
              bodyTimeout = setTimeout(() => {
                controller.abort();
                reject(stallError('idle'));
              }, timeoutMs);
            });
            try {
              const text = await Promise.race([response.text(), timedOut]);
              // No stream to count from: the UTF-8 length of the decoded text
              // is the closest available stand-in for the served size.
              return { text, bytes: Buffer.byteLength(text, 'utf8') };
            } catch (err) {
              if (err instanceof BodyReadTimeoutError) throw err;
              if (record.outcome === 'stalled-body') throw stallError('idle', err);
              throw bodyError(err);
            } finally {
              clearTimeout(bodyTimeout);
            }
          };

          // The body may be re-pointed at one branch of a tee below, so the
          // eager inspection of a denied response and the caller's own read
          // never compete for the same stream.
          let bodyStream = response.body;
          let inspected = false;
          const inspect = (body: string) => {
            if (inspected) return;
            inspected = true;
            observer?.onBody(record, body, contentType);
          };

          let pendingBody: Promise<HttpBody> | undefined;
          const readBody = (): Promise<HttpBody> => {
            if (record.outcome === 'stalled-body') {
              return Promise.reject(new BodyReadTimeoutError(record.error ?? 'Body read stalled'));
            }
            // A body stream can be consumed once, so every reader (text(),
            // body(), the origin-rewrite branch) shares the same read.
            pendingBody ??= (async () => {
              let read: HttpBody;
              if (bodyStream) {
                const { body, bytes } = await readStreamedBody(bodyStream);
                read = { text: body, bytes };
              } else {
                read = await readWholeBody();
              }
              inspect(read.text);
              return read;
            })();
            return pendingBody;
          };

          // A denied HTML response is read eagerly so the ledger inspects it
          // for a challenge signature even when the caller only wanted the
          // status. The cap is enforced while streaming (not just from
          // Content-Length): the inspection branch of a tee stops at the
          // challenge-page size limit, and the caller keeps the other branch,
          // so an arbitrarily large denied page is never buffered here.
          let eagerBody: HttpBody | undefined;
          if (record.blocked && /text\/html/i.test(contentType)) {
            const length = Number(response.headers.get('content-length'));
            if (length > MAX_CHALLENGE_PAGE_LENGTH) {
              // Too large to be a challenge page; nothing to inspect.
            } else if (bodyStream) {
              const [inspectBranch, callerBranch] = bodyStream.tee();
              bodyStream = callerBranch;
              const { body, bytes, truncated } = await readStreamedBody(
                inspectBranch,
                MAX_CHALLENGE_PAGE_LENGTH,
              );
              if (!truncated) {
                inspect(body);
                eagerBody = { text: body, bytes };
              }
            } else {
              eagerBody = await readBody();
            }
          }
          const eager = eagerBody;

          if (originPattern && options.targetOrigin) {
            const ct = response.headers.get('content-type') ?? '';
            if (/text|xml|json|markdown/.test(ct)) {
              const { text, bytes } = eager ?? (await readBody());
              originPattern.lastIndex = 0;
              // Use a function replacer so `$` in the target (e.g. a preview path
              // containing `$'` or `$&`) is inserted literally, not interpreted as a
              // String.replace replacement pattern.
              const target = options.targetOrigin;
              const rewritten = text.replace(originPattern, () => target);
              // `bytes` stays the size the server actually served; the rewrite
              // is a testing convenience, not something an agent would receive.
              const rewrittenBody: HttpBody = { text: rewritten, bytes };
              return {
                ok: response.ok,
                status: response.status,
                statusText: response.statusText,
                headers: response.headers,
                url: response.url,
                redirected: response.redirected,
                text: async () => rewritten,
                body: async () => rewrittenBody,
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
            text:
              eager !== undefined ? async () => eager.text : () => readBody().then((b) => b.text),
            body: eager !== undefined ? async () => eager : readBody,
          } as HttpResponse;
        } finally {
          activeRequests--;
        }
      }
    },
  };
}
