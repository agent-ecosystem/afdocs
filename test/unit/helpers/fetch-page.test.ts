import { describe, it, expect, beforeAll } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { createContext } from '../../../src/runner.js';
import { fetchPage } from '../../../src/helpers/fetch-page.js';

const server = setupServer();

beforeAll(() => {
  server.listen({ onUnhandledRequest: 'bypass' });
  return () => server.close();
});

describe('fetchPage', () => {
  it('returns body and detects HTML content', async () => {
    server.use(
      http.get(
        'http://fp-basic.local/page',
        () =>
          new HttpResponse('<html><body><h1>Hello</h1></body></html>', {
            status: 200,
            headers: { 'Content-Type': 'text/html' },
          }),
      ),
    );

    const ctx = createContext('http://fp-basic.local', { requestDelay: 0 });
    const page = await fetchPage(ctx, 'http://fp-basic.local/page');

    expect(page.isHtml).toBe(true);
    expect(page.body).toContain('<h1>Hello</h1>');
    expect(page.contentType).toContain('text/html');
  });

  it('detects markdown content as non-HTML', async () => {
    server.use(
      http.get(
        'http://fp-md.local/page',
        () =>
          new HttpResponse('# Hello\n\nMarkdown content.', {
            status: 200,
            headers: { 'Content-Type': 'text/markdown' },
          }),
      ),
    );

    const ctx = createContext('http://fp-md.local', { requestDelay: 0 });
    const page = await fetchPage(ctx, 'http://fp-md.local/page');

    expect(page.isHtml).toBe(false);
    expect(page.body).toContain('# Hello');
  });

  it('returns cached result on second call without re-fetching', async () => {
    let fetchCount = 0;
    server.use(
      http.get('http://fp-cache.local/page', () => {
        fetchCount++;
        return new HttpResponse('<html><body><p>Content</p></body></html>', {
          status: 200,
          headers: { 'Content-Type': 'text/html' },
        });
      }),
    );

    const ctx = createContext('http://fp-cache.local', { requestDelay: 0 });
    const first = await fetchPage(ctx, 'http://fp-cache.local/page');
    const second = await fetchPage(ctx, 'http://fp-cache.local/page');

    expect(fetchCount).toBe(1);
    expect(first).toBe(second);
  });

  it('caches different URLs independently', async () => {
    server.use(
      http.get(
        'http://fp-multi.local/page1',
        () =>
          new HttpResponse('<html><body>Page 1</body></html>', {
            status: 200,
            headers: { 'Content-Type': 'text/html' },
          }),
      ),
      http.get(
        'http://fp-multi.local/page2',
        () =>
          new HttpResponse('# Page 2', {
            status: 200,
            headers: { 'Content-Type': 'text/markdown' },
          }),
      ),
    );

    const ctx = createContext('http://fp-multi.local', { requestDelay: 0 });
    const page1 = await fetchPage(ctx, 'http://fp-multi.local/page1');
    const page2 = await fetchPage(ctx, 'http://fp-multi.local/page2');

    expect(page1.isHtml).toBe(true);
    expect(page2.isHtml).toBe(false);
    expect(ctx.htmlCache.size).toBe(2);
  });
});

describe('fetchPage served size', () => {
  it('records decoded bytes, which differ from characters for multi-byte text', async () => {
    const body = `<html><body><p>${'€'.repeat(100)}</p></body></html>`;
    server.use(
      http.get(
        'http://fp-bytes.local/page',
        () =>
          new HttpResponse(body, {
            status: 200,
            headers: { 'Content-Type': 'text/html; charset=utf-8' },
          }),
      ),
    );

    const ctx = createContext('http://fp-bytes.local', { requestDelay: 0 });
    const page = await fetchPage(ctx, 'http://fp-bytes.local/page');

    expect(page.bytes).toBe(Buffer.byteLength(body, 'utf8'));
    expect(page.bytes).toBeGreaterThan(page.body.length);
    expect(page.wireBytes).toBeUndefined();
    expect(page.contentEncoding).toBeUndefined();
  });

  it('records the wire size and encoding of a compressed response', async () => {
    const ctx = createContext('http://fp-wire.local', { requestDelay: 0 });
    ctx.http = {
      fetch: async () => ({
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: new Headers({
          'content-type': 'text/html',
          'content-encoding': 'br',
          'content-length': '65',
        }),
        url: 'http://fp-wire.local/page',
        redirected: false,
        text: async () => '<html>decoded</html>',
        body: async () => ({ text: '<html>decoded</html>', bytes: 5_026 }),
      }),
    };

    const page = await fetchPage(ctx, 'http://fp-wire.local/page');
    expect(page.bytes).toBe(5_026);
    expect(page.wireBytes).toBe(65);
    expect(page.contentEncoding).toBe('br');
  });

  it('ignores identity encoding and a missing length', async () => {
    const ctx = createContext('http://fp-identity.local', { requestDelay: 0 });
    ctx.http = {
      fetch: async () => ({
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: new Headers({ 'content-type': 'text/html', 'content-encoding': 'identity' }),
        url: 'http://fp-identity.local/page',
        redirected: false,
        text: async () => '<html>x</html>',
        body: async () => ({ text: '<html>x</html>', bytes: 14 }),
      }),
    };

    const page = await fetchPage(ctx, 'http://fp-identity.local/page');
    expect(page.bytes).toBe(14);
    expect(page.wireBytes).toBeUndefined();
    expect(page.contentEncoding).toBeUndefined();
  });

  it('falls back to the UTF-8 length when the client only implements text()', async () => {
    const ctx = createContext('http://fp-textonly.local', { requestDelay: 0 });
    ctx.http = {
      fetch: async () => ({
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: new Headers({ 'content-type': 'text/html' }),
        url: 'http://fp-textonly.local/page',
        redirected: false,
        text: async () => '<html>héllo</html>',
      }),
    };

    const page = await fetchPage(ctx, 'http://fp-textonly.local/page');
    expect(page.bytes).toBe(Buffer.byteLength('<html>héllo</html>', 'utf8'));
  });
});
