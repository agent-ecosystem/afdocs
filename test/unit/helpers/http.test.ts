import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHttpClient } from '../../../src/http.js';

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
