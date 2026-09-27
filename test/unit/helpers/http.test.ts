import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHttpClient, BodyReadTimeoutError } from '../../../src/http.js';
import type { FetchRecord } from '../../../src/types.js';

describe('createHttpClient', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.useRealTimers();
  });

  function makeResponse(status: number, headers?: Record<string, string>): Response {
    return {
      status,
      ok: status >= 200 && status < 300,
      headers: new Headers(headers),
      text: async () => '',
    } as unknown as Response;
  }

  it('retries on 429 with Retry-After header', async () => {
    const calls: number[] = [];
    globalThis.fetch = vi.fn(async () => {
      calls.push(Date.now());
      if (calls.length === 1) {
        return makeResponse(429, { 'Retry-After': '1' });
      }
      return makeResponse(200);
    });

    const client = createHttpClient({ requestDelay: 0, requestTimeout: 5000, maxConcurrency: 10 });
    const promise = client.fetch('http://example.com/test');

    // Advance past the 1-second retry delay
    await vi.advanceTimersByTimeAsync(1500);

    const response = await promise;
    expect(response.status).toBe(200);
    expect(calls).toHaveLength(2);
  });

  it('stops retrying after MAX_RETRIES (2) attempts', async () => {
    let callCount = 0;
    globalThis.fetch = vi.fn(async () => {
      callCount++;
      return makeResponse(429, { 'Retry-After': '1' });
    });

    const client = createHttpClient({ requestDelay: 0, requestTimeout: 5000, maxConcurrency: 10 });
    const promise = client.fetch('http://example.com/test');

    // Advance through all retries
    await vi.advanceTimersByTimeAsync(5000);

    const response = await promise;
    // 1 initial + 2 retries = 3 calls, then returns the 429
    expect(response.status).toBe(429);
    expect(callCount).toBe(3);
  });

  it('does not retry 429 without Retry-After header', async () => {
    let callCount = 0;
    globalThis.fetch = vi.fn(async () => {
      callCount++;
      return makeResponse(429);
    });

    const client = createHttpClient({ requestDelay: 0, requestTimeout: 5000, maxConcurrency: 10 });
    const response = await client.fetch('http://example.com/test');

    expect(response.status).toBe(429);
    expect(callCount).toBe(1);
  });

  it('does not retry 429 when Retry-After exceeds 60 seconds', async () => {
    let callCount = 0;
    globalThis.fetch = vi.fn(async () => {
      callCount++;
      return makeResponse(429, { 'Retry-After': '120' });
    });

    const client = createHttpClient({ requestDelay: 0, requestTimeout: 5000, maxConcurrency: 10 });
    const response = await client.fetch('http://example.com/test');

    expect(response.status).toBe(429);
    expect(callCount).toBe(1);
  });

  describe('origin rewriting', () => {
    function makeTextResponse(
      body: string,
      opts: { status?: number; contentType?: string; url?: string; redirected?: boolean } = {},
    ): Response {
      const status = opts.status ?? 200;
      return {
        ok: status >= 200 && status < 300,
        status,
        statusText: 'OK',
        headers: new Headers(opts.contentType ? { 'content-type': opts.contentType } : undefined),
        url: opts.url ?? 'http://preview.local/docs/llms.txt',
        redirected: opts.redirected ?? false,
        text: async () => body,
      } as unknown as Response;
    }

    it('rewrites all occurrences of canonicalOrigin in text responses', async () => {
      const body = [
        '- [Guide](https://prod.example.com/docs/guide)',
        '- [API](https://prod.example.com/docs/api)',
        'All pages: https://prod.example.com/docs/llms.txt',
      ].join('\n');
      globalThis.fetch = vi.fn(async () => makeTextResponse(body, { contentType: 'text/plain' }));

      const client = createHttpClient({
        requestDelay: 0,
        requestTimeout: 5000,
        maxConcurrency: 10,
        canonicalOrigin: 'https://prod.example.com',
        targetOrigin: 'https://preview.local',
      });
      const response = await client.fetch('http://preview.local/docs/llms.txt');
      const text = await response.text();

      expect(text).not.toContain('prod.example.com');
      expect(text).toContain('https://preview.local/docs/guide');
      expect(text).toContain('https://preview.local/docs/api');
      expect(text).toContain('https://preview.local/docs/llms.txt');
    });

    it('preserves url and redirected from original response', async () => {
      globalThis.fetch = vi.fn(async () =>
        makeTextResponse('https://prod.example.com/page', {
          contentType: 'text/plain',
          url: 'http://preview.local/docs/llms.txt',
          redirected: true,
        }),
      );

      const client = createHttpClient({
        requestDelay: 0,
        requestTimeout: 5000,
        maxConcurrency: 10,
        canonicalOrigin: 'https://prod.example.com',
        targetOrigin: 'https://preview.local',
      });
      const response = await client.fetch('http://preview.local/docs/llms.txt');

      expect(response.url).toBe('http://preview.local/docs/llms.txt');
      expect(response.redirected).toBe(true);
    });

    it('rewrites origins that include a port', async () => {
      const body = 'See https://prod.example.com:8080/docs/guide for details.';
      globalThis.fetch = vi.fn(async () => makeTextResponse(body, { contentType: 'text/plain' }));

      const client = createHttpClient({
        requestDelay: 0,
        requestTimeout: 5000,
        maxConcurrency: 10,
        canonicalOrigin: 'https://prod.example.com:8080',
        targetOrigin: 'http://localhost:3000',
      });
      const response = await client.fetch('http://localhost:3000/docs/guide');
      const text = await response.text();

      expect(text).toBe('See http://localhost:3000/docs/guide for details.');
    });

    it('does not match a longer domain that starts with the canonical origin', async () => {
      const body = [
        'https://prod.example.com/docs/guide',
        'https://prod.example.com.evil.com/phishing',
      ].join('\n');
      globalThis.fetch = vi.fn(async () => makeTextResponse(body, { contentType: 'text/plain' }));

      const client = createHttpClient({
        requestDelay: 0,
        requestTimeout: 5000,
        maxConcurrency: 10,
        canonicalOrigin: 'https://prod.example.com',
        targetOrigin: 'https://preview.local',
      });
      const response = await client.fetch('http://preview.local/docs');
      const text = await response.text();

      expect(text).toContain('https://preview.local/docs/guide');
      expect(text).toContain('https://prod.example.com.evil.com/phishing');
    });

    it('does not match a longer sub-path that starts with the canonical base', async () => {
      const body = [
        'https://prod.example.com/docs/guide',
        'https://prod.example.com/docsearch/index',
      ].join('\n');
      globalThis.fetch = vi.fn(async () => makeTextResponse(body, { contentType: 'text/plain' }));

      const client = createHttpClient({
        requestDelay: 0,
        requestTimeout: 5000,
        maxConcurrency: 10,
        canonicalOrigin: 'https://prod.example.com/docs',
        targetOrigin: 'https://preview.local/preview',
      });
      const response = await client.fetch('http://preview.local/preview');
      const text = await response.text();

      expect(text).toContain('https://preview.local/preview/guide');
      // /docsearch must NOT be rewritten by a /docs canonical.
      expect(text).toContain('https://prod.example.com/docsearch/index');
    });

    it('inserts a target containing $ literally (no replacement-pattern interpretation)', async () => {
      const body = 'link https://prod.example.com/docs/guide tail';
      globalThis.fetch = vi.fn(async () => makeTextResponse(body, { contentType: 'text/plain' }));

      const client = createHttpClient({
        requestDelay: 0,
        requestTimeout: 5000,
        maxConcurrency: 10,
        canonicalOrigin: 'https://prod.example.com/docs',
        targetOrigin: "http://preview.local/a$'b$&c$`d",
      });
      const text = await (await client.fetch('http://preview.local/x')).text();

      expect(text).toBe("link http://preview.local/a$'b$&c$`d/guide tail");
    });

    it('rewrites base URLs terminated by ) , ? or # (markdown links, prose)', async () => {
      const body = [
        '[docs](https://prod.example.com)',
        'see https://prod.example.com, then',
        'query https://prod.example.com?a=1',
        'frag https://prod.example.com#top',
      ].join('\n');
      globalThis.fetch = vi.fn(async () =>
        makeTextResponse(body, { contentType: 'text/markdown' }),
      );

      const client = createHttpClient({
        requestDelay: 0,
        requestTimeout: 5000,
        maxConcurrency: 10,
        canonicalOrigin: 'https://prod.example.com',
        targetOrigin: 'https://preview.local',
      });
      const text = await (await client.fetch('http://preview.local/x')).text();

      expect(text).not.toContain('prod.example.com');
      expect(text).toContain('[docs](https://preview.local)');
      expect(text).toContain('see https://preview.local, then');
      expect(text).toContain('query https://preview.local?a=1');
      expect(text).toContain('frag https://preview.local#top');
    });

    it('rewrites a sitemap <loc> entry ending exactly at the canonical base', async () => {
      const body = [
        '<urlset>',
        '<url><loc>https://prod.example.com/docs</loc></url>',
        '<url><loc>https://prod.example.com/docs/guide</loc></url>',
        '</urlset>',
      ].join('\n');
      globalThis.fetch = vi.fn(async () => makeTextResponse(body, { contentType: 'text/xml' }));

      const client = createHttpClient({
        requestDelay: 0,
        requestTimeout: 5000,
        maxConcurrency: 10,
        canonicalOrigin: 'https://prod.example.com/docs',
        targetOrigin: 'https://preview.local/preview',
      });
      const text = await (await client.fetch('http://preview.local/sitemap.xml')).text();

      // The landing-page entry ends at the prefix with `<` next; it must rewrite too.
      expect(text).toContain('<loc>https://preview.local/preview</loc>');
      expect(text).toContain('<loc>https://preview.local/preview/guide</loc>');
      expect(text).not.toContain('prod.example.com');
    });

    it('returns the same rewritten body on multiple text() calls', async () => {
      const body = 'Link: https://prod.example.com/page';
      globalThis.fetch = vi.fn(async () => makeTextResponse(body, { contentType: 'text/plain' }));

      const client = createHttpClient({
        requestDelay: 0,
        requestTimeout: 5000,
        maxConcurrency: 10,
        canonicalOrigin: 'https://prod.example.com',
        targetOrigin: 'https://preview.local',
      });
      const response = await client.fetch('http://preview.local/page');
      const first = await response.text();
      const second = await response.text();

      expect(first).toBe('Link: https://preview.local/page');
      expect(second).toBe(first);
    });

    it('skips rewrite for non-text content types', async () => {
      const original = 'https://prod.example.com/binary-data';
      globalThis.fetch = vi.fn(async () =>
        makeTextResponse(original, { contentType: 'application/octet-stream' }),
      );

      const client = createHttpClient({
        requestDelay: 0,
        requestTimeout: 5000,
        maxConcurrency: 10,
        canonicalOrigin: 'https://prod.example.com',
        targetOrigin: 'https://preview.local',
      });
      const response = await client.fetch('http://preview.local/file.bin');
      const text = await response.text();

      expect(text).toBe(original);
    });
  });

  describe('body read timeout', () => {
    /**
     * A tarpitting server (e.g. bot management on a CDN edge) sends headers
     * promptly, then holds the connection open and never finishes the body.
     * fetch() resolves at the header phase, so the header timeout never
     * fires; the guard has to cover the body read itself. Real undici
     * rejects an in-flight text() when the request signal aborts, so the
     * mock reproduces that contract.
     */
    function makeTarpitFetch(contentType: string) {
      return vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        const signal = init?.signal;
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          headers: new Headers({ 'content-type': contentType }),
          url: 'http://example.com/page',
          redirected: false,
          text: () =>
            new Promise<string>((_resolve, reject) => {
              signal?.addEventListener('abort', () =>
                reject(new DOMException('This operation was aborted', 'AbortError')),
              );
            }),
        } as unknown as Response;
      }) as unknown as typeof fetch;
    }

    it('aborts a stalled body read after requestTimeout', async () => {
      globalThis.fetch = makeTarpitFetch('text/html');

      const client = createHttpClient({
        requestDelay: 0,
        requestTimeout: 5000,
        maxConcurrency: 10,
      });
      const response = await client.fetch('http://example.com/page');

      const textPromise = response.text();
      const assertion = expect(textPromise).rejects.toThrow(/Body read timed out after 5000ms/);
      await vi.advanceTimersByTimeAsync(5100);
      await assertion;
    });

    it('aborts a stalled body read on the origin-rewrite path', async () => {
      globalThis.fetch = makeTarpitFetch('text/plain');

      const client = createHttpClient({
        requestDelay: 0,
        requestTimeout: 5000,
        maxConcurrency: 10,
        canonicalOrigin: 'https://prod.example.com',
        targetOrigin: 'https://preview.local',
      });

      const fetchPromise = client.fetch('http://preview.local/page');
      const assertion = expect(fetchPromise).rejects.toThrow(/Body read timed out after 5000ms/);
      await vi.advanceTimersByTimeAsync(5100);
      await assertion;
    });

    it('short-circuits later fetches of a URL whose body already stalled', async () => {
      const fetchMock = makeTarpitFetch('text/html');
      globalThis.fetch = fetchMock;

      const client = createHttpClient({
        requestDelay: 0,
        requestTimeout: 5000,
        maxConcurrency: 10,
      });
      const first = await client.fetch('http://example.com/page');
      const assertion = expect(first.text()).rejects.toThrow(/Body read timed out/);
      await vi.advanceTimersByTimeAsync(5100);
      await assertion;
      expect(fetchMock).toHaveBeenCalledTimes(1);

      // Same URL: rejected immediately, no network request, no timer needed.
      await expect(client.fetch('http://example.com/page')).rejects.toThrow(
        /Body read timed out after 5000ms/,
      );
      await expect(client.fetch('http://example.com/page')).rejects.toBeInstanceOf(
        BodyReadTimeoutError,
      );
      expect(fetchMock).toHaveBeenCalledTimes(1);

      // A different URL is still fetched.
      await client.fetch('http://example.com/other');
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('passes through non-timeout body read errors unchanged', async () => {
      globalThis.fetch = vi.fn(
        async () =>
          ({
            ok: true,
            status: 200,
            statusText: 'OK',
            headers: new Headers({ 'content-type': 'text/html' }),
            url: 'http://example.com/page',
            redirected: false,
            text: async () => {
              throw new TypeError('terminated');
            },
          }) as unknown as Response,
      ) as unknown as typeof fetch;

      const client = createHttpClient({
        requestDelay: 0,
        requestTimeout: 5000,
        maxConcurrency: 10,
      });
      const response = await client.fetch('http://example.com/page');

      await expect(response.text()).rejects.toThrow('terminated');
    });

    it('reads a normal body through the wrapped response', async () => {
      globalThis.fetch = vi.fn(
        async () =>
          ({
            ok: true,
            status: 200,
            statusText: 'OK',
            headers: new Headers({ 'content-type': 'text/html' }),
            url: 'http://example.com/page',
            redirected: false,
            text: async () => '<html>content</html>',
          }) as unknown as Response,
      ) as unknown as typeof fetch;

      const client = createHttpClient({
        requestDelay: 0,
        requestTimeout: 5000,
        maxConcurrency: 10,
      });
      const response = await client.fetch('http://example.com/page');

      expect(response.status).toBe(200);
      expect(await response.text()).toBe('<html>content</html>');
    });
  });

  describe('observer', () => {
    function makeObserver() {
      const records: FetchRecord[] = [];
      const bodies: Array<{ url: string; contentType: string; body: string }> = [];
      return {
        records,
        bodies,
        onRecord: (r: FetchRecord) => {
          records.push(r);
        },
        onBody: (r: FetchRecord, body: string, ct: string) => {
          bodies.push({ url: r.url, contentType: ct, body });
        },
      };
    }

    it('records a successful response and its body', async () => {
      globalThis.fetch = vi.fn(
        async () =>
          ({
            ok: true,
            status: 200,
            statusText: 'OK',
            headers: new Headers({ 'content-type': 'text/html' }),
            url: 'http://example.com/page',
            redirected: false,
            text: async () => '<html>hi</html>',
          }) as unknown as Response,
      ) as unknown as typeof fetch;

      const observer = makeObserver();
      const client = createHttpClient({
        requestDelay: 0,
        requestTimeout: 5000,
        maxConcurrency: 10,
        observer,
      });
      const response = await client.fetch('http://example.com/page');
      await response.text();

      expect(observer.records).toEqual([
        { seq: 1, url: 'http://example.com/page', status: 200, outcome: 'ok' },
      ]);
      expect(observer.bodies).toEqual([
        { url: 'http://example.com/page', contentType: 'text/html', body: '<html>hi</html>' },
      ]);
    });

    it('records a fetch error when no response arrives', async () => {
      globalThis.fetch = vi.fn(async () => {
        throw new TypeError('fetch failed');
      }) as unknown as typeof fetch;

      const observer = makeObserver();
      const client = createHttpClient({
        requestDelay: 0,
        requestTimeout: 5000,
        maxConcurrency: 10,
        observer,
      });
      await expect(client.fetch('http://example.com/down')).rejects.toThrow('fetch failed');

      expect(observer.records).toEqual([
        {
          seq: 1,
          url: 'http://example.com/down',
          status: null,
          outcome: 'fetch-error',
          error: 'fetch failed',
        },
      ]);
    });

    it('marks the record as stalled when the body read times out', async () => {
      globalThis.fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        const signal = init?.signal;
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          headers: new Headers({ 'content-type': 'text/html' }),
          url: 'http://example.com/tarpit',
          redirected: false,
          text: () =>
            new Promise<string>((_resolve, reject) => {
              signal?.addEventListener('abort', () =>
                reject(new DOMException('This operation was aborted', 'AbortError')),
              );
            }),
        } as unknown as Response;
      }) as unknown as typeof fetch;

      const observer = makeObserver();
      const client = createHttpClient({
        requestDelay: 0,
        requestTimeout: 5000,
        maxConcurrency: 10,
        observer,
      });
      const response = await client.fetch('http://example.com/tarpit');
      expect(observer.records[0].outcome).toBe('ok');

      const assertion = expect(response.text()).rejects.toThrow(/Body read timed out/);
      await vi.advanceTimersByTimeAsync(5100);
      await assertion;

      expect(observer.records).toHaveLength(1);
      expect(observer.records[0].outcome).toBe('stalled-body');
      expect(observer.records[0].error).toMatch(/tarpitting/);
      expect(observer.bodies).toHaveLength(0);
    });

    it('does not record a short-circuited fetch of a stalled URL', async () => {
      globalThis.fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        const signal = init?.signal;
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          headers: new Headers({ 'content-type': 'text/html' }),
          url: 'http://example.com/tarpit',
          redirected: false,
          text: () =>
            new Promise<string>((_resolve, reject) => {
              signal?.addEventListener('abort', () =>
                reject(new DOMException('This operation was aborted', 'AbortError')),
              );
            }),
        } as unknown as Response;
      }) as unknown as typeof fetch;

      const observer = makeObserver();
      const client = createHttpClient({
        requestDelay: 0,
        requestTimeout: 5000,
        maxConcurrency: 10,
        observer,
      });
      const response = await client.fetch('http://example.com/tarpit');
      const assertion = expect(response.text()).rejects.toThrow(/Body read timed out/);
      await vi.advanceTimersByTimeAsync(5100);
      await assertion;

      await expect(client.fetch('http://example.com/tarpit')).rejects.toThrow(
        /Body read timed out/,
      );
      expect(observer.records).toHaveLength(1);
      expect(observer.records[0].outcome).toBe('stalled-body');
    });

    it('records one entry for a 429 that was retried and then succeeded', async () => {
      let calls = 0;
      globalThis.fetch = vi.fn(async () => {
        calls++;
        return makeResponse(calls === 1 ? 429 : 200, calls === 1 ? { 'Retry-After': '1' } : {});
      });

      const observer = makeObserver();
      const client = createHttpClient({
        requestDelay: 0,
        requestTimeout: 5000,
        maxConcurrency: 10,
        observer,
      });
      const promise = client.fetch('http://example.com/limited');
      await vi.advanceTimersByTimeAsync(1500);
      const response = await promise;

      expect(response.status).toBe(200);
      expect(calls).toBe(2);
      expect(observer.records).toHaveLength(1);
      expect(observer.records[0].status).toBe(200);
    });
  });

  describe('streamed body reads', () => {
    const enc = new TextEncoder();

    function streamResponse(
      stream: ReadableStream<Uint8Array>,
      init?: { status?: number; headers?: Record<string, string> },
    ): Response {
      const status = init?.status ?? 200;
      return {
        ok: status >= 200 && status < 300,
        status,
        statusText: 'OK',
        headers: new Headers({ 'content-type': 'text/html', ...init?.headers }),
        url: 'http://example.com/page',
        redirected: false,
        body: stream,
        text: async () => {
          throw new Error('text() should not be used when a body stream exists');
        },
      } as unknown as Response;
    }

    function observerFor() {
      const records: FetchRecord[] = [];
      return {
        records,
        onRecord: (r: FetchRecord) => {
          records.push(r);
        },
        onBody: () => undefined,
      };
    }

    it('decodes a body that arrives in chunks', async () => {
      globalThis.fetch = vi.fn(async () =>
        streamResponse(
          new ReadableStream({
            start(c) {
              c.enqueue(enc.encode('<html>'));
              c.enqueue(enc.encode('héllo'));
              c.enqueue(enc.encode('</html>'));
              c.close();
            },
          }),
        ),
      ) as unknown as typeof fetch;
      const client = createHttpClient({
        requestDelay: 0,
        requestTimeout: 5000,
        maxConcurrency: 10,
      });
      const response = await client.fetch('http://example.com/page');
      expect(await response.text()).toBe('<html>héllo</html>');
    });

    it('treats no bytes for requestTimeout as a stalled body', async () => {
      globalThis.fetch = vi.fn(async () =>
        streamResponse(
          new ReadableStream({
            start(c) {
              c.enqueue(enc.encode('<html><body>'));
              // never closes
            },
          }),
        ),
      ) as unknown as typeof fetch;
      const observer = observerFor();
      const client = createHttpClient({
        requestDelay: 0,
        requestTimeout: 5000,
        maxConcurrency: 10,
        observer,
      });
      const response = await client.fetch('http://example.com/page');
      const assertion = expect(response.text()).rejects.toThrow(/Body read timed out after 5000ms/);
      await vi.advanceTimersByTimeAsync(5100);
      await assertion;
      expect(observer.records[0].outcome).toBe('stalled-body');
    });

    it('does not treat a slow but progressing body as a stall', async () => {
      // One chunk per second for 12 seconds: longer than requestTimeout in
      // total, but never idle for more than a second.
      let sent = 0;
      globalThis.fetch = vi.fn(async () =>
        streamResponse(
          new ReadableStream({
            pull(c) {
              return new Promise<void>((resolve) => {
                setTimeout(() => {
                  c.enqueue(enc.encode('x'));
                  if (++sent === 12) c.close();
                  resolve();
                }, 1000);
              });
            },
          }),
        ),
      ) as unknown as typeof fetch;
      const observer = observerFor();
      const client = createHttpClient({
        requestDelay: 0,
        requestTimeout: 5000,
        maxConcurrency: 10,
        observer,
      });
      const response = await client.fetch('http://example.com/page');
      const textPromise = response.text();
      await vi.advanceTimersByTimeAsync(13_000);
      expect(await textPromise).toBe('x'.repeat(12));
      expect(observer.records[0].outcome).toBe('ok');
    });

    it('caps a body that keeps trickling forever', async () => {
      globalThis.fetch = vi.fn(async () =>
        streamResponse(
          new ReadableStream({
            pull(c) {
              return new Promise<void>((resolve) => {
                setTimeout(() => {
                  try {
                    c.enqueue(enc.encode('x'));
                  } catch {
                    // stream was cancelled by the client; the mock just stops
                  }
                  resolve();
                }, 1000);
              });
            },
          }),
        ),
      ) as unknown as typeof fetch;
      const observer = observerFor();
      const client = createHttpClient({
        requestDelay: 0,
        requestTimeout: 5000,
        maxConcurrency: 10,
        observer,
      });
      const response = await client.fetch('http://example.com/page');
      const assertion = expect(response.text()).rejects.toThrow(/Body read exceeded 20000ms/);
      await vi.advanceTimersByTimeAsync(21_000);
      await assertion;
      expect(observer.records[0].outcome).toBe('stalled-body');
      expect(observer.records[0].error).toMatch(/trickling/);
    });

    it('flags denied responses and inspects their HTML eagerly', async () => {
      const challenge =
        '<html><head><title>Just a moment...</title></head><body><div id="cf-browser-verification"></div></body></html>';
      globalThis.fetch = vi.fn(async () =>
        streamResponse(
          new ReadableStream({
            start(c) {
              c.enqueue(enc.encode(challenge));
              c.close();
            },
          }),
          { status: 403 },
        ),
      ) as unknown as typeof fetch;
      const { createFetchLedger } = await import('../../../src/helpers/fetch-ledger.js');
      const ledger = createFetchLedger();
      const client = createHttpClient({
        requestDelay: 0,
        requestTimeout: 5000,
        maxConcurrency: 10,
        observer: ledger,
      });
      const response = await client.fetch('http://example.com/page');
      // The caller never reads the body; the ledger already inspected it.
      expect(ledger.records[0].blocked).toBe(true);
      expect(ledger.records[0].challenge).toBe('Cloudflare challenge');
      expect(response.status).toBe(403);
      expect(await response.text()).toBe(challenge);
    });

    it('classifies 503 and unguided 429 as blocked, guided 429 as not', async () => {
      const observer = observerFor();
      let call = 0;
      globalThis.fetch = vi.fn(async () => {
        call++;
        if (call === 1) return makeResponse(503);
        if (call === 2) return makeResponse(429);
        if (call === 3) return makeResponse(429, { 'Retry-After': '1' });
        if (call === 4) return makeResponse(200);
        // A Retry-After longer than the client will wait is still guidance.
        return makeResponse(429, { 'Retry-After': '120' });
      });
      const client = createHttpClient({
        requestDelay: 0,
        requestTimeout: 5000,
        maxConcurrency: 10,
        observer,
      });
      await client.fetch('http://example.com/a');
      await client.fetch('http://example.com/b');
      const p = client.fetch('http://example.com/c');
      await vi.advanceTimersByTimeAsync(1500);
      await p;
      await client.fetch('http://example.com/d');
      expect(
        observer.records.map((r) => [r.status, r.blocked ?? false, r.retryAfter ?? null]),
      ).toEqual([
        [503, true, null],
        [429, true, null],
        [200, false, null],
        [429, false, '120'],
      ]);
    });

    it('leaves oversized denied bodies to the caller', async () => {
      const big = '<html><body>' + 'x'.repeat(200_000) + '</body></html>';
      const textSpy = vi.fn(async () => big);
      globalThis.fetch = vi.fn(
        async () =>
          ({
            ok: false,
            status: 403,
            statusText: 'Forbidden',
            headers: new Headers({
              'content-type': 'text/html',
              'content-length': String(big.length),
            }),
            url: 'http://example.com/page',
            redirected: false,
            text: textSpy,
          }) as unknown as Response,
      ) as unknown as typeof fetch;
      const observer = observerFor();
      const client = createHttpClient({
        requestDelay: 0,
        requestTimeout: 5000,
        maxConcurrency: 10,
        observer,
      });
      await client.fetch('http://example.com/page');
      expect(textSpy).not.toHaveBeenCalled();
      expect(observer.records[0].blocked).toBe(true);
    });
  });

  describe('served size', () => {
    const enc = new TextEncoder();

    function streamResponse(
      stream: ReadableStream<Uint8Array>,
      headers: Record<string, string> = {},
    ): Response {
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: new Headers({ 'content-type': 'text/html', ...headers }),
        url: 'http://example.com/page',
        redirected: false,
        body: stream,
        text: async () => {
          throw new Error('text() should not be used when a body stream exists');
        },
      } as unknown as Response;
    }

    function chunked(...parts: string[]): ReadableStream<Uint8Array> {
      return new ReadableStream({
        start(c) {
          for (const part of parts) c.enqueue(enc.encode(part));
          c.close();
        },
      });
    }

    function sentHeaders(fetchMock: ReturnType<typeof vi.fn>): Headers {
      const init = fetchMock.mock.calls[0][1] as RequestInit;
      return new Headers(init.headers);
    }

    function clientWithMock(fetchMock: ReturnType<typeof vi.fn>) {
      globalThis.fetch = fetchMock as unknown as typeof fetch;
      return createHttpClient({ requestDelay: 0, requestTimeout: 5000, maxConcurrency: 10 });
    }

    it('sends an explicit Accept-Encoding typical of agent HTTP clients', async () => {
      const fetchMock = vi.fn(async () => streamResponse(chunked('<html></html>')));
      await clientWithMock(fetchMock).fetch('http://example.com/page');
      const headers = sentHeaders(fetchMock);
      expect(headers.get('accept-encoding')).toBe('gzip, deflate, br');
      expect(headers.get('user-agent')).toMatch(/^afdocs\//);
    });

    it('lets a caller override Accept-Encoding', async () => {
      const fetchMock = vi.fn(async () => streamResponse(chunked('<html></html>')));
      await clientWithMock(fetchMock).fetch('http://example.com/page', {
        headers: { 'Accept-Encoding': 'identity' },
      });
      expect(sentHeaders(fetchMock).get('accept-encoding')).toBe('identity');
    });

    it('replaces a default header on a lowercase override instead of sending both', async () => {
      const fetchMock = vi.fn(async () => streamResponse(chunked('<html></html>')));
      await clientWithMock(fetchMock).fetch('http://example.com/page', {
        headers: { 'accept-encoding': 'identity', 'user-agent': 'custom-agent/1.0' },
      });
      const headers = sentHeaders(fetchMock);
      expect(headers.get('accept-encoding')).toBe('identity');
      expect(headers.get('user-agent')).toBe('custom-agent/1.0');
    });

    it("keeps the caller's extra headers alongside the defaults", async () => {
      const fetchMock = vi.fn(async () => streamResponse(chunked('<html></html>')));
      await clientWithMock(fetchMock).fetch('http://example.com/page', {
        headers: { Accept: 'text/markdown' },
      });
      const headers = sentHeaders(fetchMock);
      expect(headers.get('accept')).toBe('text/markdown');
      expect(headers.get('accept-encoding')).toBe('gzip, deflate, br');
      expect(headers.get('user-agent')).toMatch(/^afdocs\//);
    });

    it('counts decoded bytes across chunks, distinct from character count', async () => {
      globalThis.fetch = vi.fn(async () =>
        streamResponse(chunked('<html>', 'héllo €', '</html>')),
      ) as unknown as typeof fetch;
      const client = createHttpClient({
        requestDelay: 0,
        requestTimeout: 5000,
        maxConcurrency: 10,
      });
      const response = await client.fetch('http://example.com/page');
      const body = await response.body!();
      expect(body.text).toBe('<html>héllo €</html>');
      expect(body.bytes).toBe(Buffer.byteLength('<html>héllo €</html>', 'utf8'));
      expect(body.bytes).toBeGreaterThan(body.text.length);
    });

    it('shares one read between text() and body()', async () => {
      globalThis.fetch = vi.fn(async () =>
        streamResponse(chunked('<html>once</html>')),
      ) as unknown as typeof fetch;
      const client = createHttpClient({
        requestDelay: 0,
        requestTimeout: 5000,
        maxConcurrency: 10,
      });
      const response = await client.fetch('http://example.com/page');
      expect(await response.text()).toBe('<html>once</html>');
      const body = await response.body!();
      expect(body.text).toBe('<html>once</html>');
      expect(body.bytes).toBe(17);
      expect(await response.text()).toBe('<html>once</html>');
    });

    it('approximates bytes from the text when the response has no stream', async () => {
      globalThis.fetch = vi.fn(
        async () =>
          ({
            ok: true,
            status: 200,
            statusText: 'OK',
            headers: new Headers({ 'content-type': 'text/html' }),
            url: 'http://example.com/page',
            redirected: false,
            text: async () => '<html>héllo</html>',
          }) as unknown as Response,
      ) as unknown as typeof fetch;
      const client = createHttpClient({
        requestDelay: 0,
        requestTimeout: 5000,
        maxConcurrency: 10,
      });
      const response = await client.fetch('http://example.com/page');
      const body = await response.body!();
      expect(body.bytes).toBe(Buffer.byteLength('<html>héllo</html>', 'utf8'));
    });

    it('keeps the served byte count on the origin-rewrite path', async () => {
      globalThis.fetch = vi.fn(async () =>
        streamResponse(chunked('<a href="https://prod.example.com/x">'), {
          'content-type': 'text/html',
        }),
      ) as unknown as typeof fetch;
      const client = createHttpClient({
        requestDelay: 0,
        requestTimeout: 5000,
        maxConcurrency: 10,
        canonicalOrigin: 'https://prod.example.com',
        targetOrigin: 'http://preview.example.com:3000',
      });
      const response = await client.fetch('http://preview.example.com:3000/page');
      const body = await response.body!();
      expect(body.text).toBe('<a href="http://preview.example.com:3000/x">');
      // The rewrite is a testing convenience; bytes stay what the server served.
      expect(body.bytes).toBe(Buffer.byteLength('<a href="https://prod.example.com/x">'));
      expect(await response.text()).toBe(body.text);
    });

    it('reports the bytes of a denied response read eagerly', async () => {
      const page = '<html><body>Access denied</body></html>';
      globalThis.fetch = vi.fn(async () => {
        const r = streamResponse(chunked(page));
        return { ...r, ok: false, status: 403, headers: r.headers, body: r.body } as Response;
      }) as unknown as typeof fetch;
      const client = createHttpClient({
        requestDelay: 0,
        requestTimeout: 5000,
        maxConcurrency: 10,
      });
      const response = await client.fetch('http://example.com/page');
      const body = await response.body!();
      expect(body.text).toBe(page);
      expect(body.bytes).toBe(page.length);
    });
  });

  describe('review follow-ups', () => {
    const enc = new TextEncoder();

    it('guards the fallback text() read even when the double ignores abort', async () => {
      globalThis.fetch = vi.fn(
        async () =>
          ({
            ok: true,
            status: 200,
            statusText: 'OK',
            headers: new Headers({ 'content-type': 'text/html' }),
            url: 'http://example.com/page',
            redirected: false,
            // Never settles and never looks at the signal.
            text: () => new Promise<string>(() => undefined),
          }) as unknown as Response,
      ) as unknown as typeof fetch;
      const records: FetchRecord[] = [];
      const client = createHttpClient({
        requestDelay: 0,
        requestTimeout: 5000,
        maxConcurrency: 10,
        observer: { onRecord: (r) => records.push(r), onBody: () => undefined },
      });
      const response = await client.fetch('http://example.com/page');
      const assertion = expect(response.text()).rejects.toThrow(/Body read timed out after 5000ms/);
      await vi.advanceTimersByTimeAsync(5100);
      await assertion;
      expect(records[0].outcome).toBe('stalled-body');
    });

    it('records a non-timeout body failure as body-error', async () => {
      globalThis.fetch = vi.fn(
        async () =>
          ({
            ok: true,
            status: 200,
            statusText: 'OK',
            headers: new Headers({ 'content-type': 'text/html' }),
            url: 'http://example.com/page',
            redirected: false,
            body: new ReadableStream<Uint8Array>({
              start(c) {
                c.enqueue(enc.encode('<html>'));
                c.error(new TypeError('terminated'));
              },
            }),
            text: async () => '',
          }) as unknown as Response,
      ) as unknown as typeof fetch;
      const records: FetchRecord[] = [];
      const client = createHttpClient({
        requestDelay: 0,
        requestTimeout: 5000,
        maxConcurrency: 10,
        observer: { onRecord: (r) => records.push(r), onBody: () => undefined },
      });
      const response = await client.fetch('http://example.com/page');
      await expect(response.text()).rejects.toThrow('terminated');
      expect(records[0].outcome).toBe('body-error');
      expect(records[0].error).toBe('terminated');
    });

    it('caps the eager read of a chunked denied body and leaves the caller a readable body', async () => {
      // No Content-Length: the cap must be enforced while streaming.
      const chunk = enc.encode('<p>' + 'x'.repeat(30_000) + '</p>');
      let sent = 0;
      globalThis.fetch = vi.fn(
        async () =>
          ({
            ok: false,
            status: 403,
            statusText: 'Forbidden',
            headers: new Headers({ 'content-type': 'text/html' }),
            url: 'http://example.com/page',
            redirected: false,
            body: new ReadableStream<Uint8Array>({
              pull(c) {
                if (sent === 5) {
                  c.close();
                  return;
                }
                sent++;
                c.enqueue(sent === 1 ? enc.encode('<html><body>') : chunk);
              },
            }),
            text: async () => '',
          }) as unknown as Response,
      ) as unknown as typeof fetch;
      const { createFetchLedger } = await import('../../../src/helpers/fetch-ledger.js');
      const ledger = createFetchLedger();
      const client = createHttpClient({
        requestDelay: 0,
        requestTimeout: 5000,
        maxConcurrency: 10,
        observer: ledger,
      });
      const response = await client.fetch('http://example.com/page');
      expect(ledger.records[0].blocked).toBe(true);
      expect(ledger.records[0].challenge).toBeUndefined();
      // The caller still gets the whole body from its own tee branch.
      const body = await response.text();
      expect(body.length).toBeGreaterThan(100_000);
      expect(body.startsWith('<html><body>')).toBe(true);
      expect(ledger.records[0].outcome).toBe('ok');
    });
  });

  describe('concurrency and rate limiting', () => {
    it('enforces requestDelay between requests', async () => {
      const timestamps: number[] = [];
      globalThis.fetch = vi.fn(async () => {
        timestamps.push(Date.now());
        return makeResponse(200);
      });

      const client = createHttpClient({
        requestDelay: 200,
        requestTimeout: 5000,
        maxConcurrency: 10,
      });

      const p1 = client.fetch('http://example.com/a');
      await vi.advanceTimersByTimeAsync(0);
      await p1;

      const p2 = client.fetch('http://example.com/b');
      await vi.advanceTimersByTimeAsync(250);
      await p2;

      expect(timestamps).toHaveLength(2);
      expect(timestamps[1] - timestamps[0]).toBeGreaterThanOrEqual(200);
    });

    it('waits for a concurrency slot when at max', async () => {
      let resolveFetch: (() => void) | null = null;
      let callCount = 0;

      globalThis.fetch = vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            callCount++;
            if (callCount === 1) {
              resolveFetch = () =>
                resolve({
                  ok: true,
                  status: 200,
                  headers: new Headers(),
                  text: async () => '',
                } as unknown as Response);
            } else {
              resolve({
                ok: true,
                status: 200,
                headers: new Headers(),
                text: async () => '',
              } as unknown as Response);
            }
          }),
      );

      const client = createHttpClient({
        requestDelay: 0,
        requestTimeout: 5000,
        maxConcurrency: 1,
      });

      const p1 = client.fetch('http://example.com/a');
      await vi.advanceTimersByTimeAsync(0);

      const p2 = client.fetch('http://example.com/b');
      // Second request should be waiting for the slot
      await vi.advanceTimersByTimeAsync(50);
      expect(callCount).toBe(1);

      // Release the first request
      resolveFetch!();
      await p1;

      // Now the second request can proceed
      await vi.advanceTimersByTimeAsync(100);
      await p2;
      expect(callCount).toBe(2);
    });
  });
});
