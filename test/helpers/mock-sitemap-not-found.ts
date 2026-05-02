import { http, HttpResponse } from 'msw';
import type { SetupServerApi } from 'msw/node';

/**
 * Register MSW handlers that return 404 for robots.txt and sitemap.xml
 * at the given base URL's origin (and subpath if present).
 *
 * Call this after creating a test context with llms.txt content so that
 * the discovery fallback (thin llms.txt → try sitemap) fails fast
 * instead of timing out on unmocked test domains.
 */
export function mockSitemapNotFound(server: SetupServerApi, baseUrl: string): void {
  const parsed = new URL(baseUrl);
  const handlers = [
    http.get(`${parsed.origin}/robots.txt`, () => new HttpResponse('', { status: 404 })),
    http.get(`${parsed.origin}/sitemap.xml`, () => new HttpResponse('', { status: 404 })),
    http.get(`${parsed.origin}/sitemap-index.xml`, () => new HttpResponse('', { status: 404 })),
    http.get(`${parsed.origin}/sitemap_index.xml`, () => new HttpResponse('', { status: 404 })),
  ];
  const subpath = parsed.pathname.replace(/\/$/, '');
  if (subpath && subpath !== '') {
    handlers.push(
      http.get(
        `${parsed.origin}${subpath}/sitemap.xml`,
        () => new HttpResponse('', { status: 404 }),
      ),
      http.get(
        `${parsed.origin}${subpath}/sitemap-index.xml`,
        () => new HttpResponse('', { status: 404 }),
      ),
      http.get(
        `${parsed.origin}${subpath}/sitemap_index.xml`,
        () => new HttpResponse('', { status: 404 }),
      ),
    );
  }
  server.use(...handlers);
}
