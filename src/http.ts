import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import type { HttpClient, HttpRequestOptions, HttpResponse } from './types.js';

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
}

const MAX_RETRIES = 2;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function createHttpClient(options: RateLimitedHttpClientOptions): HttpClient {
  let lastRequestTime = 0;
  let activeRequests = 0;
  // Match the canonical base only at a URL boundary: end-of-string or one of these
  // delimiters. `)` and `,` are included so URLs inside markdown links `[x](url)` and
  // prose `url, next` rewrite; the rare tradeoff is a path segment like `/docs,2024`
  // being treated as the `/docs` prefix.
  const originPattern =
    options.canonicalOrigin && options.targetOrigin
      ? new RegExp(escapeRegExp(options.canonicalOrigin) + '(?=[/?#\\s"\'\\]),>]|$)', 'g')
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
      let retries = 0;

      while (true) {
        await waitForSlot();
        activeRequests++;
        lastRequestTime = Date.now();

        try {
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), options.requestTimeout);

          const response = await globalThis.fetch(url, {
            method: reqOptions?.method ?? 'GET',
            headers: { 'User-Agent': USER_AGENT, ...reqOptions?.headers },
            redirect: reqOptions?.redirect ?? 'follow',
            signal: reqOptions?.signal ?? controller.signal,
          });

          clearTimeout(timeout);

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

          if (originPattern && options.targetOrigin) {
            const ct = response.headers.get('content-type') ?? '';
            if (/text|xml|json|markdown/.test(ct)) {
              const body = await response.text();
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

          return response as HttpResponse;
        } finally {
          activeRequests--;
        }
      }
    },
  };
}
