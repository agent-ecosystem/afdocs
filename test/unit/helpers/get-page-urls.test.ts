import { describe, it, expect, beforeAll } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import {
  getPageUrls,
  getUrlsFromSitemap,
  discoverAndSamplePages,
  parseSitemapUrls,
  parseSitemapDirectives,
  filterByPathPrefix,
  getPathFilterBase,
  filterLocaleSitemaps,
  filterLocalizedUrls,
  deduplicateVersionedUrls,
  extractVersionFromUrl,
  extractLocaleFromUrl,
} from '../../../src/helpers/get-page-urls.js';
import { MAX_SITEMAP_URLS } from '../../../src/constants.js';
import { createContext } from '../../../src/runner.js';
import type { DiscoveredFile } from '../../../src/types.js';
import { mockSitemapNotFound } from '../../helpers/mock-sitemap-not-found.js';

const server = setupServer();

beforeAll(() => {
  server.listen({ onUnhandledRequest: 'bypass' });
  return () => server.close();
});

describe('parseSitemapUrls', () => {
  it('extracts <loc> URLs from a regular sitemap', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://example.com/page1</loc></url>
  <url><loc>https://example.com/page2</loc></url>
</urlset>`;

    const result = parseSitemapUrls(xml);
    expect(result.urls).toEqual(['https://example.com/page1', 'https://example.com/page2']);
    expect(result.sitemapIndexUrls).toEqual([]);
  });

  it('extracts sub-sitemap URLs from a sitemap index', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap><loc>https://example.com/sitemap-pages.xml</loc></sitemap>
  <sitemap><loc>https://example.com/sitemap-blog.xml</loc></sitemap>
</sitemapindex>`;

    const result = parseSitemapUrls(xml);
    expect(result.urls).toEqual([]);
    expect(result.sitemapIndexUrls).toEqual([
      'https://example.com/sitemap-pages.xml',
      'https://example.com/sitemap-blog.xml',
    ]);
  });

  it('handles malformed XML gracefully', () => {
    const result = parseSitemapUrls('this is not xml at all');
    expect(result.urls).toEqual([]);
    expect(result.sitemapIndexUrls).toEqual([]);
  });

  it('handles empty sitemap', () => {
    const xml = `<?xml version="1.0"?><urlset></urlset>`;
    const result = parseSitemapUrls(xml);
    expect(result.urls).toEqual([]);
    expect(result.sitemapIndexUrls).toEqual([]);
  });
});

describe('parseSitemapDirectives', () => {
  it('extracts Sitemap URLs from robots.txt', () => {
    const robotsTxt = `User-agent: *
Disallow: /admin

Sitemap: https://example.com/sitemap.xml
Sitemap: https://example.com/sitemap-blog.xml
`;
    expect(parseSitemapDirectives(robotsTxt)).toEqual([
      'https://example.com/sitemap.xml',
      'https://example.com/sitemap-blog.xml',
    ]);
  });

  it('handles case-insensitive directive', () => {
    expect(parseSitemapDirectives('sitemap: https://example.com/map.xml\n')).toEqual([
      'https://example.com/map.xml',
    ]);
  });

  it('returns empty array when no Sitemap directives', () => {
    expect(parseSitemapDirectives('User-agent: *\nDisallow: /\n')).toEqual([]);
  });

  it('handles empty input', () => {
    expect(parseSitemapDirectives('')).toEqual([]);
  });
});

describe('filterByPathPrefix', () => {
  it('filters URLs to those under the path prefix', () => {
    const urls = [
      'https://example.com/docs/intro',
      'https://example.com/docs/guide',
      'https://example.com/blog/post1',
      'https://example.com/careers',
    ];
    const result = filterByPathPrefix(urls, 'https://example.com/docs');
    expect(result).toEqual(['https://example.com/docs/intro', 'https://example.com/docs/guide']);
  });

  it('includes the exact baseUrl path itself', () => {
    const urls = ['https://example.com/docs', 'https://example.com/docs/page'];
    const result = filterByPathPrefix(urls, 'https://example.com/docs');
    expect(result).toEqual(['https://example.com/docs', 'https://example.com/docs/page']);
  });

  it('passes all URLs through when baseUrl is at the root', () => {
    const urls = [
      'https://example.com/docs/intro',
      'https://example.com/blog/post1',
      'https://example.com/careers',
    ];
    const result = filterByPathPrefix(urls, 'https://example.com');
    expect(result).toEqual(urls);
  });

  it('passes all URLs through when baseUrl has a trailing slash root', () => {
    const urls = ['https://example.com/a', 'https://example.com/b'];
    const result = filterByPathPrefix(urls, 'https://example.com/');
    expect(result).toEqual(urls);
  });

  it('does not match partial path segments', () => {
    // /docs-extra should NOT match /docs prefix
    const urls = ['https://example.com/docs/page', 'https://example.com/docs-extra/page'];
    const result = filterByPathPrefix(urls, 'https://example.com/docs');
    expect(result).toEqual(['https://example.com/docs/page']);
  });

  it('handles deeper path prefixes', () => {
    const urls = [
      'https://example.com/api/v2/docs/page',
      'https://example.com/api/v2/other',
      'https://example.com/api/v1/docs/page',
    ];
    const result = filterByPathPrefix(urls, 'https://example.com/api/v2/docs');
    expect(result).toEqual(['https://example.com/api/v2/docs/page']);
  });

  it('keeps malformed URLs rather than dropping them', () => {
    const urls = ['not-a-url', 'https://example.com/docs/page'];
    const result = filterByPathPrefix(urls, 'https://example.com/docs');
    expect(result).toEqual(['not-a-url', 'https://example.com/docs/page']);
  });
});

describe('getPathFilterBase', () => {
  it('returns baseUrl when no effectiveOrigin is set', () => {
    const ctx = createContext('https://example.com/docs', { requestDelay: 0 });
    expect(getPathFilterBase(ctx)).toBe('https://example.com/docs');
  });

  it('returns baseUrl when effectiveOrigin matches origin', () => {
    const ctx = createContext('https://example.com/docs', { requestDelay: 0 });
    ctx.effectiveOrigin = 'https://example.com';
    expect(getPathFilterBase(ctx)).toBe('https://example.com/docs');
  });

  it('preserves subpath for www-canonicalization redirects', () => {
    const ctx = createContext('https://alchemy.com/docs', { requestDelay: 0 });
    ctx.effectiveOrigin = 'https://www.alchemy.com';
    expect(getPathFilterBase(ctx)).toBe('https://www.alchemy.com/docs');
  });

  it('preserves subpath when www is on the original origin', () => {
    const ctx = createContext('https://www.example.com/docs', { requestDelay: 0 });
    ctx.effectiveOrigin = 'https://example.com';
    expect(getPathFilterBase(ctx)).toBe('https://example.com/docs');
  });

  it('returns root effectiveOrigin for true cross-host redirects', () => {
    const ctx = createContext('https://example.com/docs', { requestDelay: 0 });
    ctx.effectiveOrigin = 'https://docs.example.com';
    expect(getPathFilterBase(ctx)).toBe('https://docs.example.com');
  });

  it('returns root effectiveOrigin for www redirect with root baseUrl', () => {
    const ctx = createContext('https://alchemy.com', { requestDelay: 0 });
    ctx.effectiveOrigin = 'https://www.alchemy.com';
    expect(getPathFilterBase(ctx)).toBe('https://www.alchemy.com');
  });
});

describe('filterLocaleSitemaps', () => {
  it('filters to English sub-sitemaps when locale pattern detected in filenames', () => {
    const urls = [
      'https://example.com/sitemap-el.xml',
      'https://example.com/sitemap-en.xml',
      'https://example.com/sitemap-es.xml',
      'https://example.com/sitemap-fr.xml',
    ];
    const result = filterLocaleSitemaps(urls);
    expect(result).toEqual(['https://example.com/sitemap-en.xml']);
  });

  it('filters to English sub-sitemaps when locale pattern detected in paths', () => {
    const urls = [
      'https://example.com/el/sitemap.xml',
      'https://example.com/en/sitemap.xml',
      'https://example.com/fr/sitemap.xml',
    ];
    const result = filterLocaleSitemaps(urls);
    expect(result).toEqual(['https://example.com/en/sitemap.xml']);
  });

  it('preserves non-locale sitemaps alongside the default locale', () => {
    const urls = [
      'https://example.com/sitemap-pages.xml',
      'https://example.com/sitemap-en.xml',
      'https://example.com/sitemap-fr.xml',
      'https://example.com/sitemap-el.xml',
    ];
    const result = filterLocaleSitemaps(urls);
    expect(result).toEqual([
      'https://example.com/sitemap-en.xml',
      'https://example.com/sitemap-pages.xml',
    ]);
  });

  it('returns all URLs when no locale pattern is detected', () => {
    const urls = ['https://example.com/sitemap-docs.xml', 'https://example.com/sitemap-blog.xml'];
    const result = filterLocaleSitemaps(urls);
    expect(result).toEqual(urls);
  });

  it('returns all URLs when only one locale is present', () => {
    const urls = ['https://example.com/sitemap-en.xml', 'https://example.com/sitemap-pages.xml'];
    const result = filterLocaleSitemaps(urls);
    expect(result).toEqual(urls);
  });

  it('returns single URL unchanged', () => {
    const urls = ['https://example.com/sitemap.xml'];
    expect(filterLocaleSitemaps(urls)).toEqual(urls);
  });

  it('handles locale codes with region subtags', () => {
    const urls = [
      'https://example.com/sitemap-en-us.xml',
      'https://example.com/sitemap-fr-fr.xml',
      'https://example.com/sitemap-de-de.xml',
    ];
    // No plain 'en', so all region-tagged locales returned (no preferred match)
    // Actually, these are distinct locales with region tags; en is not present
    const result = filterLocaleSitemaps(urls);
    // No 'en' match, no non-locale sitemaps → falls back to all
    expect(result).toEqual(urls);
  });

  it('prefers the locale from the base URL when preferredLocale is set', () => {
    const urls = [
      'https://example.com/sitemap-el.xml',
      'https://example.com/sitemap-en.xml',
      'https://example.com/sitemap-fr.xml',
    ];
    const result = filterLocaleSitemaps(urls, 'fr');
    expect(result).toEqual(['https://example.com/sitemap-fr.xml']);
  });

  it('falls back to en when preferredLocale has no match', () => {
    const urls = [
      'https://example.com/sitemap-el.xml',
      'https://example.com/sitemap-en.xml',
      'https://example.com/sitemap-fr.xml',
    ];
    const result = filterLocaleSitemaps(urls, 'ja');
    expect(result).toEqual(['https://example.com/sitemap-en.xml']);
  });

  it('preserves non-locale sitemaps alongside the preferred locale', () => {
    const urls = [
      'https://example.com/sitemap-pages.xml',
      'https://example.com/sitemap-en.xml',
      'https://example.com/sitemap-fr.xml',
      'https://example.com/sitemap-de.xml',
    ];
    const result = filterLocaleSitemaps(urls, 'de');
    expect(result).toEqual([
      'https://example.com/sitemap-de.xml',
      'https://example.com/sitemap-pages.xml',
    ]);
  });
});

describe('extractLocaleFromUrl', () => {
  it('detects 2-letter locale in URL path', () => {
    expect(extractLocaleFromUrl('https://example.com/fr/docs/intro')).toBe('fr');
  });

  it('detects locale with region subtag', () => {
    expect(extractLocaleFromUrl('https://example.com/pt-br/docs/intro')).toBe('pt-br');
  });

  it('detects locale after a non-locale segment', () => {
    expect(extractLocaleFromUrl('https://example.com/docs/en/intro')).toBe('en');
  });

  it('returns null when no locale segment is found', () => {
    expect(extractLocaleFromUrl('https://example.com/docs/intro')).toBeNull();
  });

  it('does not match segments beyond the first 3 path positions', () => {
    expect(extractLocaleFromUrl('https://example.com/a/b/c/fr/page')).toBeNull();
  });

  it('returns the first locale segment found', () => {
    expect(extractLocaleFromUrl('https://example.com/en/fr/intro')).toBe('en');
  });
});

describe('filterLocalizedUrls', () => {
  it('filters page URLs to English when multiple locales detected', () => {
    const urls = [
      'https://example.com/en/docs/intro',
      'https://example.com/en/docs/guide',
      'https://example.com/fr/docs/intro',
      'https://example.com/fr/docs/guide',
      'https://example.com/de/docs/intro',
      'https://example.com/de/docs/guide',
    ];
    const result = filterLocalizedUrls(urls);
    expect(result).toEqual([
      'https://example.com/en/docs/intro',
      'https://example.com/en/docs/guide',
    ]);
  });

  it('prefers the locale from the base URL', () => {
    const urls = [
      'https://example.com/en/docs/intro',
      'https://example.com/fr/docs/intro',
      'https://example.com/de/docs/intro',
      'https://example.com/en/docs/guide',
      'https://example.com/fr/docs/guide',
      'https://example.com/de/docs/guide',
    ];
    const result = filterLocalizedUrls(urls, 'fr');
    expect(result).toEqual([
      'https://example.com/fr/docs/intro',
      'https://example.com/fr/docs/guide',
    ]);
  });

  it('returns all URLs when no locale pattern is detected', () => {
    const urls = [
      'https://example.com/docs/intro',
      'https://example.com/docs/guide',
      'https://example.com/docs/api',
    ];
    const result = filterLocalizedUrls(urls);
    expect(result).toEqual(urls);
  });

  it('returns all URLs when only one locale is present', () => {
    const urls = ['https://example.com/en/docs/intro', 'https://example.com/en/docs/guide'];
    const result = filterLocalizedUrls(urls);
    expect(result).toEqual(urls);
  });

  it('falls back to all URLs when preferred locale is not present', () => {
    const urls = ['https://example.com/en/docs/intro', 'https://example.com/fr/docs/intro'];
    const result = filterLocalizedUrls(urls, 'ja');
    // ja not present → returns all
    expect(result).toEqual(urls);
  });

  it('filters to unprefixed default locale when target locale not found', () => {
    // Default language has no prefix; other languages do
    const urls = [
      'https://example.com/docs/intro',
      'https://example.com/docs/guide',
      'https://example.com/docs/api',
      'https://example.com/docs/de/intro',
      'https://example.com/docs/de/guide',
      'https://example.com/docs/de/api',
      'https://example.com/docs/ja/intro',
      'https://example.com/docs/ja/guide',
      'https://example.com/docs/ja/api',
    ];
    // Default preferred locale is 'en', which doesn't exist as a prefix
    const result = filterLocalizedUrls(urls);
    expect(result).toEqual([
      'https://example.com/docs/intro',
      'https://example.com/docs/guide',
      'https://example.com/docs/api',
    ]);
  });

  it('filters to unprefixed default locale with explicit preferred locale not found', () => {
    const urls = [
      'https://example.com/docs/intro',
      'https://example.com/docs/guide',
      'https://example.com/docs/de/intro',
      'https://example.com/docs/de/guide',
      'https://example.com/docs/fr/intro',
      'https://example.com/docs/fr/guide',
    ];
    // Requesting 'es' which doesn't exist, and 'en' doesn't exist either —
    // should fall back to unprefixed
    const result = filterLocalizedUrls(urls, 'es');
    expect(result).toEqual(['https://example.com/docs/intro', 'https://example.com/docs/guide']);
  });

  it('keeps URLs with fewer segments than the locale position', () => {
    // Locale at position 1 (docs/{locale}/...), so a URL with only 1 segment
    // doesn't reach the locale position and should be kept, not dropped.
    const urls = [
      'https://example.com/docs/en/intro',
      'https://example.com/docs/fr/intro',
      'https://example.com/docs/en/guide',
      'https://example.com/docs/fr/guide',
      'https://example.com/docs', // only 1 segment, can't have locale at position 1
    ];
    const result = filterLocalizedUrls(urls);
    expect(result).toContain('https://example.com/docs/en/intro');
    expect(result).toContain('https://example.com/docs/en/guide');
    expect(result).toContain('https://example.com/docs'); // kept, not dropped
    expect(result).not.toContain('https://example.com/docs/fr/intro');
  });

  it('detects single-locale site via structural duplication and filters to unprefixed', () => {
    const urls = [
      'https://example.com/docs/intro',
      'https://example.com/docs/guide',
      'https://example.com/docs/api',
      'https://example.com/docs/de/intro',
      'https://example.com/docs/de/guide',
      'https://example.com/docs/de/api',
    ];
    const result = filterLocalizedUrls(urls);
    // 'en' not found as prefix → falls back to unprefixed
    expect(result).toEqual([
      'https://example.com/docs/intro',
      'https://example.com/docs/guide',
      'https://example.com/docs/api',
    ]);
  });

  it('does not false-detect topic paths as single-locale', () => {
    // "hr" is a valid ISO 639-1 code (Croatian) but used here as a topic
    const urls = [
      'https://example.com/docs/hr/onboarding',
      'https://example.com/docs/hr/policies',
      'https://example.com/docs/hr/benefits',
      'https://example.com/docs/engineering/onboarding',
      'https://example.com/docs/engineering/policies',
      'https://example.com/docs/engineering/benefits',
    ];
    const result = filterLocalizedUrls(urls);
    // No structural duplication (stripped paths don't match) → no filtering
    expect(result).toEqual(urls);
  });
});

describe('deduplicateVersionedUrls', () => {
  it('deduplicates Docusaurus-style versioned URLs, keeping unversioned', () => {
    const urls = [
      'https://example.com/docs/2.x/intro',
      'https://example.com/docs/3.0.1/intro',
      'https://example.com/docs/3.1.1/intro',
      'https://example.com/docs/intro',
      'https://example.com/docs/2.x/guide',
      'https://example.com/docs/3.0.1/guide',
      'https://example.com/docs/guide',
    ];
    const result = deduplicateVersionedUrls(urls);
    expect(result).toEqual(['https://example.com/docs/intro', 'https://example.com/docs/guide']);
  });

  it('prefers latest/stable when no unversioned variant exists', () => {
    const urls = [
      'https://example.com/en/v1/intro',
      'https://example.com/en/v2/intro',
      'https://example.com/en/latest/intro',
      'https://example.com/en/v1/guide',
      'https://example.com/en/v2/guide',
      'https://example.com/en/latest/guide',
    ];
    const result = deduplicateVersionedUrls(urls);
    expect(result).toEqual([
      'https://example.com/en/latest/intro',
      'https://example.com/en/latest/guide',
    ]);
  });

  it('picks the highest version when no unversioned or latest exists', () => {
    const urls = [
      'https://example.com/docs/1.8/intro',
      'https://example.com/docs/3.0/intro',
      'https://example.com/docs/2.0/intro',
      'https://example.com/docs/1.8/guide',
      'https://example.com/docs/3.0/guide',
      'https://example.com/docs/2.0/guide',
    ];
    const result = deduplicateVersionedUrls(urls);
    expect(result).toEqual([
      'https://example.com/docs/3.0/intro',
      'https://example.com/docs/3.0/guide',
    ]);
  });

  it('returns urls unchanged when less than 20% are version-duplicated', () => {
    // 10 unique pages + 2 version duplicates = 12 total, 2/12 < 20%
    const urls = [
      ...Array.from({ length: 10 }, (_, i) => `https://example.com/docs/page-${i}`),
      'https://example.com/docs/v1/intro',
      'https://example.com/docs/v2/intro',
    ];
    const result = deduplicateVersionedUrls(urls);
    expect(result).toEqual(urls);
  });

  it('handles single URL', () => {
    const urls = ['https://example.com/docs/v1/intro'];
    expect(deduplicateVersionedUrls(urls)).toEqual(urls);
  });

  it('handles empty array', () => {
    expect(deduplicateVersionedUrls([])).toEqual([]);
  });

  it('handles Read the Docs style versioning', () => {
    const urls = [
      'https://example.com/en/stable/tutorial',
      'https://example.com/en/latest/tutorial',
      'https://example.com/en/v2/tutorial',
      'https://example.com/en/stable/api',
      'https://example.com/en/latest/api',
      'https://example.com/en/v2/api',
    ];
    const result = deduplicateVersionedUrls(urls);
    // stable is preferred over latest (both are special, but stable sorts after latest)
    expect(result).toEqual([
      'https://example.com/en/stable/tutorial',
      'https://example.com/en/stable/api',
    ]);
  });

  it('prefers current as equivalent to latest/stable', () => {
    const urls = [
      'https://example.com/docs/v1/intro',
      'https://example.com/docs/v2/intro',
      'https://example.com/docs/current/intro',
      'https://example.com/docs/v1/guide',
      'https://example.com/docs/v2/guide',
      'https://example.com/docs/current/guide',
    ];
    const result = deduplicateVersionedUrls(urls);
    expect(result).toEqual([
      'https://example.com/docs/current/intro',
      'https://example.com/docs/current/guide',
    ]);
  });

  it('prefers the version from the base URL when preferredVersion is set', () => {
    const urls = [
      'https://example.com/docs/v1/intro',
      'https://example.com/docs/v2/intro',
      'https://example.com/docs/v3/intro',
      'https://example.com/docs/v1/guide',
      'https://example.com/docs/v2/guide',
      'https://example.com/docs/v3/guide',
    ];
    // User passed a URL with v2 in it
    const result = deduplicateVersionedUrls(urls, 'v2');
    expect(result).toEqual([
      'https://example.com/docs/v2/intro',
      'https://example.com/docs/v2/guide',
    ]);
  });

  it('ranks pre-release channels (dev, next, nightly, canary) below stable versions', () => {
    const urls = [
      'https://example.com/en/dev/intro',
      'https://example.com/en/6.0/intro',
      'https://example.com/en/5.2/intro',
      'https://example.com/en/dev/guide',
      'https://example.com/en/6.0/guide',
      'https://example.com/en/5.2/guide',
    ];
    const result = deduplicateVersionedUrls(urls);
    expect(result).toEqual([
      'https://example.com/en/6.0/intro',
      'https://example.com/en/6.0/guide',
    ]);
  });

  it('uses pre-release when no stable versions exist', () => {
    const urls = [
      'https://example.com/en/dev/intro',
      'https://example.com/en/nightly/intro',
      'https://example.com/en/dev/guide',
      'https://example.com/en/nightly/guide',
    ];
    const result = deduplicateVersionedUrls(urls);
    expect(result).toEqual([
      'https://example.com/en/dev/intro',
      'https://example.com/en/dev/guide',
    ]);
  });

  it('passes through singleton groups alongside deduplicated groups', () => {
    const urls = [
      'https://example.com/docs/v1/intro',
      'https://example.com/docs/v2/intro',
      'https://example.com/docs/v3/intro',
      'https://example.com/docs/v1/guide',
      'https://example.com/docs/v2/guide',
      'https://example.com/docs/v3/guide',
      'https://example.com/docs/unique-page', // no version duplicates
    ];
    const result = deduplicateVersionedUrls(urls);
    expect(result).toContain('https://example.com/docs/v3/intro');
    expect(result).toContain('https://example.com/docs/v3/guide');
    expect(result).toContain('https://example.com/docs/unique-page');
    expect(result).toHaveLength(3);
  });

  it('falls back to default priority when preferredVersion has no match', () => {
    const urls = [
      'https://example.com/docs/v1/intro',
      'https://example.com/docs/v2/intro',
      'https://example.com/docs/v1/guide',
      'https://example.com/docs/v2/guide',
    ];
    // User passed a URL with v5 but no v5 exists in the sitemap
    const result = deduplicateVersionedUrls(urls, 'v5');
    expect(result).toEqual([
      'https://example.com/docs/v2/intro',
      'https://example.com/docs/v2/guide',
    ]);
  });
});

describe('extractVersionFromUrl', () => {
  it('detects semver-style versions', () => {
    expect(extractVersionFromUrl('https://example.com/docs/3.0.1/intro')).toBe('3.0.1');
  });

  it('detects v-prefixed versions', () => {
    expect(extractVersionFromUrl('https://example.com/en/v2/guide')).toBe('v2');
  });

  it('detects wildcard versions', () => {
    expect(extractVersionFromUrl('https://example.com/docs/2.x/intro')).toBe('2.x');
  });

  it('detects keyword versions', () => {
    expect(extractVersionFromUrl('https://example.com/en/latest/intro')).toBe('latest');
    expect(extractVersionFromUrl('https://example.com/en/stable/intro')).toBe('stable');
    expect(extractVersionFromUrl('https://example.com/en/current/intro')).toBe('current');
  });

  it('returns null when no version segment is found', () => {
    expect(extractVersionFromUrl('https://example.com/docs/intro')).toBeNull();
  });

  it('returns null for bare integers', () => {
    expect(extractVersionFromUrl('https://example.com/page/42')).toBeNull();
  });

  it('returns the first version segment found', () => {
    expect(extractVersionFromUrl('https://example.com/v2/docs/3.0/intro')).toBe('v2');
  });
});

describe('getPageUrls', () => {
  function makeCtx(baseUrl = 'http://test.local', llmsTxtContent?: string) {
    const ctx = createContext(baseUrl, { requestDelay: 0 });

    if (llmsTxtContent) {
      const discovered: DiscoveredFile[] = [
        { url: `${baseUrl}/llms.txt`, content: llmsTxtContent, status: 200, redirected: false },
      ];
      ctx.previousResults.set('llms-txt-exists', {
        id: 'llms-txt-exists',
        category: 'content-discoverability',
        status: 'pass',
        message: 'Found',
        details: { discoveredFiles: discovered },
      });

      mockSitemapNotFound(server, baseUrl);
    } else {
      // Mark llms-txt-exists as having run (but failed) so getPageUrls
      // skips the direct llms.txt fetch and falls through to sitemap.
      ctx.previousResults.set('llms-txt-exists', {
        id: 'llms-txt-exists',
        category: 'content-discoverability',
        status: 'fail',
        message: 'No llms.txt found',
        details: { discoveredFiles: [] },
      });
    }

    return ctx;
  }

  it('returns llms.txt links when available', async () => {
    const content = `# Docs\n> Summary\n## Links\n- [Page](http://test.local/docs/page): A page\n`;
    const ctx = makeCtx('http://test.local', content);

    const result = await getPageUrls(ctx);
    expect(result.urls).toEqual(['http://test.local/docs/page']);
    expect(result.warnings).toEqual([]);
    expect(result.sources).toContain('llms-txt');
  });

  it('fetches and parses sitemap.xml when no llms.txt links', async () => {
    server.use(
      http.get(
        'http://sitemap-test.local/robots.txt',
        () => new HttpResponse('User-agent: *\nDisallow:\n', { status: 200 }),
      ),
      http.get(
        'http://sitemap-test.local/sitemap.xml',
        () =>
          new HttpResponse(
            `<?xml version="1.0"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>http://sitemap-test.local/docs/intro</loc></url>
  <url><loc>http://sitemap-test.local/docs/guide</loc></url>
</urlset>`,
            { status: 200, headers: { 'Content-Type': 'application/xml' } },
          ),
      ),
    );

    const ctx = makeCtx('http://sitemap-test.local');
    const result = await getPageUrls(ctx);
    expect(result.urls).toEqual([
      'http://sitemap-test.local/docs/intro',
      'http://sitemap-test.local/docs/guide',
    ]);
    expect(result.sources).toEqual(['sitemap']);
  });

  it('handles sitemap index files (follows sub-sitemaps)', async () => {
    server.use(
      http.get('http://index-test.local/robots.txt', () => new HttpResponse('', { status: 404 })),
      http.get(
        'http://index-test.local/sitemap.xml',
        () =>
          new HttpResponse(
            `<?xml version="1.0"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap><loc>http://index-test.local/sitemap-docs.xml</loc></sitemap>
</sitemapindex>`,
            { status: 200, headers: { 'Content-Type': 'application/xml' } },
          ),
      ),
      http.get(
        'http://index-test.local/sitemap-docs.xml',
        () =>
          new HttpResponse(
            `<?xml version="1.0"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>http://index-test.local/docs/a</loc></url>
  <url><loc>http://index-test.local/docs/b</loc></url>
</urlset>`,
            { status: 200, headers: { 'Content-Type': 'application/xml' } },
          ),
      ),
    );

    const ctx = makeCtx('http://index-test.local');
    const result = await getPageUrls(ctx);
    expect(result.urls).toEqual([
      'http://index-test.local/docs/a',
      'http://index-test.local/docs/b',
    ]);
  });

  it('filters sitemap URLs to same-origin only', async () => {
    server.use(
      http.get('http://origin-test.local/robots.txt', () => new HttpResponse('', { status: 404 })),
      http.get(
        'http://origin-test.local/sitemap.xml',
        () =>
          new HttpResponse(
            `<?xml version="1.0"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>http://origin-test.local/docs/page</loc></url>
  <url><loc>http://other-domain.com/page</loc></url>
  <url><loc>http://origin-test.local/docs/another</loc></url>
</urlset>`,
            { status: 200, headers: { 'Content-Type': 'application/xml' } },
          ),
      ),
    );

    const ctx = makeCtx('http://origin-test.local');
    const result = await getPageUrls(ctx);
    expect(result.urls).toEqual([
      'http://origin-test.local/docs/page',
      'http://origin-test.local/docs/another',
    ]);
  });

  it('falls back to baseUrl when both llms.txt and sitemap are empty', async () => {
    server.use(
      http.get('http://empty-test.local/robots.txt', () => new HttpResponse('', { status: 404 })),
      http.get(
        'http://empty-test.local/sitemap.xml',
        () => new HttpResponse('Not Found', { status: 404 }),
      ),
    );

    const ctx = makeCtx('http://empty-test.local');
    const result = await getPageUrls(ctx);
    expect(result.urls).toEqual(['http://empty-test.local']);
    expect(result.sources).toEqual(['fallback']);
  });

  it('handles malformed sitemap XML gracefully', async () => {
    server.use(
      http.get('http://bad-xml.local/robots.txt', () => new HttpResponse('', { status: 404 })),
      http.get(
        'http://bad-xml.local/sitemap.xml',
        () =>
          new HttpResponse('this is garbage, not xml', {
            status: 200,
            headers: { 'Content-Type': 'application/xml' },
          }),
      ),
    );

    const ctx = makeCtx('http://bad-xml.local');
    const result = await getPageUrls(ctx);
    expect(result.urls).toEqual(['http://bad-xml.local']);
  });

  it('respects MAX_SITEMAP_URLS cap', async () => {
    const locs = Array.from(
      { length: MAX_SITEMAP_URLS + 100 },
      (_, i) => `  <url><loc>http://big-sitemap.local/page/${i}</loc></url>`,
    ).join('\n');

    server.use(
      http.get('http://big-sitemap.local/robots.txt', () => new HttpResponse('', { status: 404 })),
      http.get(
        'http://big-sitemap.local/sitemap.xml',
        () =>
          new HttpResponse(
            `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${locs}\n</urlset>`,
            { status: 200, headers: { 'Content-Type': 'application/xml' } },
          ),
      ),
    );

    const ctx = makeCtx('http://big-sitemap.local');
    const result = await getPageUrls(ctx);
    expect(result.urls).toHaveLength(MAX_SITEMAP_URLS);
  });

  it('applies path-prefix filter before the sitemap URL cap (#31)', async () => {
    // Simulate Django-like sitemap index: Greek sitemap comes first alphabetically,
    // filling the cap before the English sitemap is reached. Without the fix,
    // path-prefix filtering after the cap would discard all Greek URLs and return 0 matches.
    const greekLocs = Array.from(
      { length: MAX_SITEMAP_URLS },
      (_, i) => `  <url><loc>http://cap-prefix.local/el/page/${i}</loc></url>`,
    ).join('\n');
    const englishLocs = Array.from(
      { length: 50 },
      (_, i) => `  <url><loc>http://cap-prefix.local/en/6.0/page/${i}</loc></url>`,
    ).join('\n');

    server.use(
      http.get('http://cap-prefix.local/robots.txt', () => new HttpResponse('', { status: 404 })),
      http.get(
        'http://cap-prefix.local/sitemap.xml',
        () =>
          new HttpResponse(
            `<?xml version="1.0"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap><loc>http://cap-prefix.local/sitemap-el.xml</loc></sitemap>
  <sitemap><loc>http://cap-prefix.local/sitemap-en.xml</loc></sitemap>
</sitemapindex>`,
            { status: 200, headers: { 'Content-Type': 'application/xml' } },
          ),
      ),
      http.get(
        'http://cap-prefix.local/sitemap-el.xml',
        () =>
          new HttpResponse(
            `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${greekLocs}\n</urlset>`,
            { status: 200, headers: { 'Content-Type': 'application/xml' } },
          ),
      ),
      http.get(
        'http://cap-prefix.local/sitemap-en.xml',
        () =>
          new HttpResponse(
            `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${englishLocs}\n</urlset>`,
            { status: 200, headers: { 'Content-Type': 'application/xml' } },
          ),
      ),
      http.get(
        'http://cap-prefix.local/en/6.0/sitemap.xml',
        () => new HttpResponse('', { status: 404 }),
      ),
      http.get(
        'http://cap-prefix.local/en/6.0/sitemap-index.xml',
        () => new HttpResponse('', { status: 404 }),
      ),
    );

    // User wants to test /en/6.0/ docs specifically
    const ctx = makeCtx('http://cap-prefix.local/en/6.0');
    const result = await getPageUrls(ctx);

    // With the fix: path filter is applied before the cap, so Greek URLs
    // don't consume cap slots. All 50 English URLs should be found.
    expect(result.urls.length).toBe(50);
    expect(result.urls.every((u) => u.includes('/en/6.0/'))).toBe(true);
  });

  it('deduplicates versioned URLs from sitemap to current version (#22)', async () => {
    // Docusaurus-style: same pages under multiple version prefixes
    const versionedLocs = [
      'http://ver-dedup.local/docs/2.x/intro',
      'http://ver-dedup.local/docs/2.x/guide',
      'http://ver-dedup.local/docs/3.0.1/intro',
      'http://ver-dedup.local/docs/3.0.1/guide',
      'http://ver-dedup.local/docs/3.1.1/intro',
      'http://ver-dedup.local/docs/3.1.1/guide',
      'http://ver-dedup.local/docs/intro',
      'http://ver-dedup.local/docs/guide',
    ]
      .map((u) => `  <url><loc>${u}</loc></url>`)
      .join('\n');

    server.use(
      http.get('http://ver-dedup.local/robots.txt', () => new HttpResponse('', { status: 404 })),
      http.get(
        'http://ver-dedup.local/sitemap.xml',
        () =>
          new HttpResponse(
            `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${versionedLocs}\n</urlset>`,
            { status: 200, headers: { 'Content-Type': 'application/xml' } },
          ),
      ),
    );

    const ctx = makeCtx('http://ver-dedup.local');
    const result = await getPageUrls(ctx);
    // Should keep only the unversioned (current) variants
    expect(result.urls).toEqual([
      'http://ver-dedup.local/docs/intro',
      'http://ver-dedup.local/docs/guide',
    ]);
  });

  it('filters sitemap index to default locale, skipping non-English sub-sitemaps (#30)', async () => {
    // Django-like sitemap index: 12 locale sitemaps, only en should be fetched
    server.use(
      http.get('http://locale-idx.local/robots.txt', () => new HttpResponse('', { status: 404 })),
      http.get(
        'http://locale-idx.local/sitemap.xml',
        () =>
          new HttpResponse(
            `<?xml version="1.0"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap><loc>http://locale-idx.local/sitemap-el.xml</loc></sitemap>
  <sitemap><loc>http://locale-idx.local/sitemap-en.xml</loc></sitemap>
  <sitemap><loc>http://locale-idx.local/sitemap-es.xml</loc></sitemap>
  <sitemap><loc>http://locale-idx.local/sitemap-fr.xml</loc></sitemap>
</sitemapindex>`,
            { status: 200, headers: { 'Content-Type': 'application/xml' } },
          ),
      ),
      http.get(
        'http://locale-idx.local/sitemap-en.xml',
        () =>
          new HttpResponse(
            `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>http://locale-idx.local/en/docs/intro</loc></url>
  <url><loc>http://locale-idx.local/en/docs/guide</loc></url>
</urlset>`,
            { status: 200, headers: { 'Content-Type': 'application/xml' } },
          ),
      ),
      // el, es, fr sitemaps should NOT be fetched — no mocks needed
      // (if they were fetched, the test would timeout)
    );

    const ctx = makeCtx('http://locale-idx.local');
    const result = await getPageUrls(ctx);
    expect(result.urls).toEqual([
      'http://locale-idx.local/en/docs/intro',
      'http://locale-idx.local/en/docs/guide',
    ]);
  });

  it('handles sitemap fetch network errors gracefully', async () => {
    server.use(
      http.get('http://net-err.local/robots.txt', () => new HttpResponse('', { status: 404 })),
      http.get('http://net-err.local/sitemap.xml', () => HttpResponse.error()),
    );

    const ctx = makeCtx('http://net-err.local');
    const result = await getPageUrls(ctx);
    expect(result.urls).toEqual(['http://net-err.local']);
  });

  it('uses sitemap URL from robots.txt Sitemap directive', async () => {
    server.use(
      http.get(
        'http://robots-sm.local/robots.txt',
        () =>
          new HttpResponse(
            'User-agent: *\nDisallow:\n\nSitemap: http://robots-sm.local/my-sitemap.xml\n',
            { status: 200 },
          ),
      ),
      http.get(
        'http://robots-sm.local/my-sitemap.xml',
        () =>
          new HttpResponse(
            `<?xml version="1.0"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>http://robots-sm.local/from-robots</loc></url>
</urlset>`,
            { status: 200, headers: { 'Content-Type': 'application/xml' } },
          ),
      ),
    );

    const ctx = makeCtx('http://robots-sm.local');
    const result = await getPageUrls(ctx);
    expect(result.urls).toEqual(['http://robots-sm.local/from-robots']);
  });

  it('follows multiple Sitemap directives from robots.txt', async () => {
    server.use(
      http.get(
        'http://multi-sm.local/robots.txt',
        () =>
          new HttpResponse(
            'Sitemap: http://multi-sm.local/sitemap-docs.xml\nSitemap: http://multi-sm.local/sitemap-blog.xml\n',
            { status: 200 },
          ),
      ),
      http.get(
        'http://multi-sm.local/sitemap-docs.xml',
        () =>
          new HttpResponse(
            `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>http://multi-sm.local/docs/a</loc></url>
</urlset>`,
            { status: 200, headers: { 'Content-Type': 'application/xml' } },
          ),
      ),
      http.get(
        'http://multi-sm.local/sitemap-blog.xml',
        () =>
          new HttpResponse(
            `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>http://multi-sm.local/blog/post1</loc></url>
</urlset>`,
            { status: 200, headers: { 'Content-Type': 'application/xml' } },
          ),
      ),
    );

    const ctx = makeCtx('http://multi-sm.local');
    const result = await getPageUrls(ctx);
    expect(result.urls).toEqual([
      'http://multi-sm.local/docs/a',
      'http://multi-sm.local/blog/post1',
    ]);
  });

  it('falls back to /sitemap.xml when robots.txt has no Sitemap directive', async () => {
    server.use(
      http.get(
        'http://no-directive.local/robots.txt',
        () => new HttpResponse('User-agent: *\nDisallow: /admin\n', { status: 200 }),
      ),
      http.get(
        'http://no-directive.local/sitemap.xml',
        () =>
          new HttpResponse(
            `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>http://no-directive.local/page</loc></url>
</urlset>`,
            { status: 200, headers: { 'Content-Type': 'application/xml' } },
          ),
      ),
    );

    const ctx = makeCtx('http://no-directive.local');
    const result = await getPageUrls(ctx);
    expect(result.urls).toEqual(['http://no-directive.local/page']);
  });

  it('warns and skips gzipped sitemap from robots.txt', async () => {
    server.use(
      http.get(
        'http://gz-robots.local/robots.txt',
        () => new HttpResponse('Sitemap: http://gz-robots.local/sitemap.xml.gz\n', { status: 200 }),
      ),
    );

    const ctx = makeCtx('http://gz-robots.local');
    const result = await getPageUrls(ctx);
    expect(result.urls).toEqual(['http://gz-robots.local']);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('gzipped sitemap');
    expect(result.warnings[0]).toContain('sitemap.xml.gz');
  });

  it('warns and skips gzipped sub-sitemap from sitemap index', async () => {
    server.use(
      http.get('http://gz-index.local/robots.txt', () => new HttpResponse('', { status: 404 })),
      http.get(
        'http://gz-index.local/sitemap.xml',
        () =>
          new HttpResponse(
            `<?xml version="1.0"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap><loc>http://gz-index.local/sitemap-docs.xml.gz</loc></sitemap>
</sitemapindex>`,
            { status: 200, headers: { 'Content-Type': 'application/xml' } },
          ),
      ),
    );

    const ctx = makeCtx('http://gz-index.local');
    const result = await getPageUrls(ctx);
    expect(result.urls).toEqual(['http://gz-index.local']);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('sitemap-docs.xml.gz');
  });

  // ── Discovery source fallback: merge llms.txt + sitemap (#27) ──

  it('falls back to sitemap when llms.txt has fewer URLs than maxLinksToTest', async () => {
    const content = `# Docs\n## Links\n- [A](http://merge-test.local/docs/a): Page A\n- [B](http://merge-test.local/docs/b): Page B\n`;
    const ctx = makeCtx('http://merge-test.local', content);
    ctx.options.maxLinksToTest = 10;

    // Register sitemap AFTER makeCtx so it takes precedence over the default 404 handlers
    server.use(
      http.get(
        'http://merge-test.local/sitemap.xml',
        () =>
          new HttpResponse(
            `<?xml version="1.0"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>http://merge-test.local/docs/c</loc></url>
  <url><loc>http://merge-test.local/docs/d</loc></url>
  <url><loc>http://merge-test.local/docs/e</loc></url>
</urlset>`,
            { status: 200, headers: { 'Content-Type': 'application/xml' } },
          ),
      ),
    );

    const result = await getPageUrls(ctx);
    // llms.txt URLs come first, then sitemap fills the gap
    expect(result.urls).toEqual([
      'http://merge-test.local/docs/a',
      'http://merge-test.local/docs/b',
      'http://merge-test.local/docs/c',
      'http://merge-test.local/docs/d',
      'http://merge-test.local/docs/e',
    ]);
    expect(result.sources).toEqual(['llms-txt', 'sitemap']);
  });

  it('does not fall back to sitemap when llms.txt meets maxLinksToTest', async () => {
    const content = `# Docs\n## Links\n- [A](http://no-merge.local/docs/a): A\n- [B](http://no-merge.local/docs/b): B\n- [C](http://no-merge.local/docs/c): C\n`;
    const ctx = makeCtx('http://no-merge.local', content);
    ctx.options.maxLinksToTest = 3;

    const result = await getPageUrls(ctx);
    expect(result.urls).toEqual([
      'http://no-merge.local/docs/a',
      'http://no-merge.local/docs/b',
      'http://no-merge.local/docs/c',
    ]);
    expect(result.sources).toEqual(['llms-txt']);
  });

  it('deduplicates URLs when merging llms.txt and sitemap', async () => {
    const content = `# Docs\n## Links\n- [A](http://dedup-merge.local/docs/a): A\n- [B](http://dedup-merge.local/docs/b): B\n`;
    const ctx = makeCtx('http://dedup-merge.local', content);
    ctx.options.maxLinksToTest = 10;

    server.use(
      http.get(
        'http://dedup-merge.local/sitemap.xml',
        () =>
          new HttpResponse(
            `<?xml version="1.0"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>http://dedup-merge.local/docs/a</loc></url>
  <url><loc>http://dedup-merge.local/docs/b</loc></url>
  <url><loc>http://dedup-merge.local/docs/c</loc></url>
</urlset>`,
            { status: 200, headers: { 'Content-Type': 'application/xml' } },
          ),
      ),
    );

    const result = await getPageUrls(ctx);
    // Overlapping URLs should not be duplicated
    expect(result.urls).toEqual([
      'http://dedup-merge.local/docs/a',
      'http://dedup-merge.local/docs/b',
      'http://dedup-merge.local/docs/c',
    ]);
    expect(result.sources).toEqual(['llms-txt', 'sitemap']);
  });

  it('applies path-prefix filtering when merging llms.txt and sitemap', async () => {
    const content = `# Docs\n## Links\n- [A](http://merge-scope.local/docs/a): A\n- [Blog](http://merge-scope.local/blog/post): Blog\n`;
    const ctx = makeCtx('http://merge-scope.local/docs', content);
    ctx.options.maxLinksToTest = 10;

    // Register sitemap AFTER makeCtx so it takes precedence over the default 404 handlers
    server.use(
      http.get(
        'http://merge-scope.local/sitemap.xml',
        () =>
          new HttpResponse(
            `<?xml version="1.0"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>http://merge-scope.local/docs/b</loc></url>
  <url><loc>http://merge-scope.local/docs/c</loc></url>
  <url><loc>http://merge-scope.local/blog/other</loc></url>
</urlset>`,
            { status: 200, headers: { 'Content-Type': 'application/xml' } },
          ),
      ),
    );

    const result = await getPageUrls(ctx);
    // llms.txt /blog/post filtered out by path prefix, sitemap /blog/other filtered too
    expect(result.urls).toEqual([
      'http://merge-scope.local/docs/a',
      'http://merge-scope.local/docs/b',
      'http://merge-scope.local/docs/c',
    ]);
    expect(result.sources).toEqual(['llms-txt', 'sitemap']);
  });

  it('reports only llms-txt source when sitemap is empty during merge attempt', async () => {
    const content = `# Docs\n## Links\n- [A](http://thin-empty.local/docs/a): A\n`;
    const ctx = makeCtx('http://thin-empty.local', content);
    ctx.options.maxLinksToTest = 10;
    // makeCtx already mocks sitemap as 404 — no sitemap URLs to merge

    const result = await getPageUrls(ctx);
    expect(result.urls).toEqual(['http://thin-empty.local/docs/a']);
    expect(result.sources).toEqual(['llms-txt']);
  });

  // ── Progressive disclosure: walking aggregate .txt files ──

  it('walks aggregate .txt files linked from llms.txt (Cloudflare pattern)', async () => {
    // Root llms.txt links to per-product llms.txt files
    const rootContent = `# Docs\n- [Workers](http://walk-test.local/workers/llms.txt)\n- [Cache](http://walk-test.local/cache/llms.txt)\n`;
    const workersContent = `# Workers\n- [Guide](http://walk-test.local/workers/guide/index.md): Get started\n- [API](http://walk-test.local/workers/api/index.md): API ref\n`;
    const cacheContent = `# Cache\n- [Overview](http://walk-test.local/cache/overview/index.md): Overview\n`;

    server.use(
      http.get(
        'http://walk-test.local/workers/llms.txt',
        () =>
          new HttpResponse(workersContent, {
            status: 200,
            headers: { 'Content-Type': 'text/plain' },
          }),
      ),
      http.get(
        'http://walk-test.local/cache/llms.txt',
        () =>
          new HttpResponse(cacheContent, {
            status: 200,
            headers: { 'Content-Type': 'text/plain' },
          }),
      ),
    );

    const ctx = makeCtx('http://walk-test.local', rootContent);
    const result = await getPageUrls(ctx);
    // .md URLs from llms.txt are normalized to their HTML equivalents
    expect(result.urls).toContain('http://walk-test.local/workers/guide/');
    expect(result.urls).toContain('http://walk-test.local/workers/api/');
    expect(result.urls).toContain('http://walk-test.local/cache/overview/');
    expect(result.urls).toHaveLength(3);
  });

  it('walks aggregate .txt files with relative URLs (Supabase pattern)', async () => {
    // Root llms.txt links to aggregate content files
    const rootContent = `# Docs\n- [Guides](http://walk-rel.local/llms/guides.txt)\n`;
    const guidesContent = `# Guides\n\nLearn about [auth](/docs/guides/auth) and [storage](/docs/guides/storage).\n`;

    server.use(
      http.get(
        'http://walk-rel.local/llms/guides.txt',
        () =>
          new HttpResponse(guidesContent, {
            status: 200,
            headers: { 'Content-Type': 'text/plain' },
          }),
      ),
    );

    const ctx = makeCtx('http://walk-rel.local', rootContent);
    const result = await getPageUrls(ctx);
    expect(result.urls).toContain('http://walk-rel.local/docs/guides/auth');
    expect(result.urls).toContain('http://walk-rel.local/docs/guides/storage');
  });

  it('resolves relative URLs in root llms.txt against origin', async () => {
    const content = `# Docs\n- [Guide](/docs/guide): A guide\n- [Ref](/docs/ref): A ref\n`;
    const ctx = makeCtx('http://rel-root.local', content);
    const result = await getPageUrls(ctx);
    expect(result.urls).toEqual([
      'http://rel-root.local/docs/guide',
      'http://rel-root.local/docs/ref',
    ]);
  });

  it('does not walk .txt files from a different origin', async () => {
    const content = `# Docs\n- [External](http://other-site.com/llms.txt)\n- [Local](http://no-walk.local/docs/page): Page\n`;
    const ctx = makeCtx('http://no-walk.local', content);
    const result = await getPageUrls(ctx);
    // Should only have the local page URL, not try to fetch the external .txt
    expect(result.urls).toEqual(['http://no-walk.local/docs/page']);
  });

  it('falls through to baseUrl when all aggregate files fail', async () => {
    const rootContent = `# Docs\n- [Bad](http://walk-err.local/bad.txt)\n- [Html](http://walk-err.local/html.txt)\n`;

    server.use(
      http.get('http://walk-err.local/bad.txt', () => new HttpResponse('', { status: 404 })),
      http.get(
        'http://walk-err.local/html.txt',
        () =>
          new HttpResponse('<!DOCTYPE html><html></html>', {
            status: 200,
            headers: { 'Content-Type': 'text/html' },
          }),
      ),
      http.get('http://walk-err.local/robots.txt', () => new HttpResponse('', { status: 404 })),
      http.get('http://walk-err.local/sitemap.xml', () => new HttpResponse('', { status: 404 })),
    );

    const ctx = makeCtx('http://walk-err.local', rootContent);
    const result = await getPageUrls(ctx);
    // All aggregate files failed → no page URLs → falls through to baseUrl
    expect(result.urls).toEqual(['http://walk-err.local']);
  });

  it('skips aggregate .txt files with non-text content-type', async () => {
    const rootContent = `# Docs\n- [Data](http://walk-ct.local/data.txt)\n- [Page](http://walk-ct.local/docs/page): Page\n`;
    server.use(
      http.get(
        'http://walk-ct.local/data.txt',
        () =>
          new HttpResponse('{"key": "value"}', {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
      ),
    );

    const ctx = makeCtx('http://walk-ct.local', rootContent);
    const result = await getPageUrls(ctx);
    expect(result.urls).toEqual(['http://walk-ct.local/docs/page']);
  });

  it('skips aggregate .txt files with empty content', async () => {
    const rootContent = `# Docs\n- [Empty](http://walk-empty.local/empty.txt)\n- [Page](http://walk-empty.local/docs/page): Page\n`;
    server.use(
      http.get(
        'http://walk-empty.local/empty.txt',
        () =>
          new HttpResponse('   ', {
            status: 200,
            headers: { 'Content-Type': 'text/plain' },
          }),
      ),
    );

    const ctx = makeCtx('http://walk-empty.local', rootContent);
    const result = await getPageUrls(ctx);
    expect(result.urls).toEqual(['http://walk-empty.local/docs/page']);
  });

  // ── .md URL normalization ──

  it('normalizes .md URLs from llms.txt to HTML equivalents', async () => {
    const content = `# Docs\n- [Guide](http://md-norm.local/docs/guide/index.md): Guide\n- [API](http://md-norm.local/docs/api.md): API\n`;
    const ctx = makeCtx('http://md-norm.local', content);
    const result = await getPageUrls(ctx);
    expect(result.urls).toContain('http://md-norm.local/docs/guide/');
    expect(result.urls).toContain('http://md-norm.local/docs/api');
    expect(result.urls).not.toContain('http://md-norm.local/docs/guide/index.md');
    expect(result.urls).not.toContain('http://md-norm.local/docs/api.md');
  });

  it('deduplicates .md and HTML URLs for the same page', async () => {
    // llms.txt has .md URL, sitemap has HTML URL for the same page
    const content = `# Docs\n- [Guide](http://md-dedup.local/docs/guide/index.md): Guide\n`;
    const ctx = makeCtx('http://md-dedup.local', content);

    server.use(
      http.get('http://md-dedup.local/robots.txt', () => new HttpResponse('', { status: 404 })),
      http.get(
        'http://md-dedup.local/sitemap.xml',
        () =>
          new HttpResponse(
            `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>http://md-dedup.local/docs/guide/</loc></url><url><loc>http://md-dedup.local/docs/other/</loc></url></urlset>`,
            { status: 200, headers: { 'Content-Type': 'application/xml' } },
          ),
      ),
    );

    const result = await getPageUrls(ctx);
    // /docs/guide/ should appear only once (not twice for .md + HTML)
    const guideCount = result.urls.filter((u) => u === 'http://md-dedup.local/docs/guide/').length;
    expect(guideCount).toBe(1);
    // /docs/other/ from sitemap should still be present
    expect(result.urls).toContain('http://md-dedup.local/docs/other/');
  });

  // ── Direct llms.txt fetch (standalone mode) ──

  it('fetches llms.txt directly when llms-txt-exists has not run', async () => {
    const llmsTxt = `# Docs\n> Summary\n## Links\n- [Intro](http://direct-llms.local/docs/intro): Intro\n- [Guide](http://direct-llms.local/docs/guide): Guide\n`;
    server.use(
      http.get(
        'http://direct-llms.local/llms.txt',
        () => new HttpResponse(llmsTxt, { status: 200, headers: { 'Content-Type': 'text/plain' } }),
      ),
      http.get(
        'http://direct-llms.local/docs/llms.txt',
        () => new HttpResponse('Not found', { status: 404 }),
      ),
      http.get('http://direct-llms.local/robots.txt', () => new HttpResponse('', { status: 404 })),
      http.get('http://direct-llms.local/sitemap.xml', () => new HttpResponse('', { status: 404 })),
    );

    // No llms-txt-exists in previousResults → standalone mode
    const ctx = createContext('http://direct-llms.local', { requestDelay: 0 });
    const result = await getPageUrls(ctx);
    expect(result.urls).toEqual([
      'http://direct-llms.local/docs/intro',
      'http://direct-llms.local/docs/guide',
    ]);
    expect(result.sources).toContain('llms-txt');
  });

  it('skips llms.txt with non-text content-type in standalone mode', async () => {
    server.use(
      http.get(
        'http://nontext-llms.local/llms.txt',
        () =>
          new HttpResponse('# Docs', {
            status: 200,
            headers: { 'Content-Type': 'application/octet-stream' },
          }),
      ),
      http.get(
        'http://nontext-llms.local/docs/llms.txt',
        () => new HttpResponse('Not found', { status: 404 }),
      ),
      http.get('http://nontext-llms.local/robots.txt', () => new HttpResponse('', { status: 404 })),
      http.get(
        'http://nontext-llms.local/sitemap.xml',
        () => new HttpResponse('', { status: 404 }),
      ),
    );

    const ctx = createContext('http://nontext-llms.local', { requestDelay: 0 });
    const result = await getPageUrls(ctx);
    // Falls through to baseUrl since llms.txt had wrong content-type
    expect(result.urls).toEqual(['http://nontext-llms.local']);
  });

  it('skips llms.txt that returns HTML in standalone mode', async () => {
    server.use(
      http.get(
        'http://html-llms.local/llms.txt',
        () =>
          new HttpResponse('<!DOCTYPE html><html><body>Not found</body></html>', {
            status: 200,
            headers: { 'Content-Type': 'text/html' },
          }),
      ),
      http.get(
        'http://html-llms.local/docs/llms.txt',
        () => new HttpResponse('Not found', { status: 404 }),
      ),
      http.get('http://html-llms.local/robots.txt', () => new HttpResponse('', { status: 404 })),
      http.get('http://html-llms.local/sitemap.xml', () => new HttpResponse('', { status: 404 })),
    );

    const ctx = createContext('http://html-llms.local', { requestDelay: 0 });
    const result = await getPageUrls(ctx);
    expect(result.urls).toEqual(['http://html-llms.local']);
  });

  it('skips empty llms.txt in standalone mode', async () => {
    server.use(
      http.get(
        'http://empty-llms.local/llms.txt',
        () =>
          new HttpResponse('   \n  ', { status: 200, headers: { 'Content-Type': 'text/plain' } }),
      ),
      http.get(
        'http://empty-llms.local/docs/llms.txt',
        () => new HttpResponse('Not found', { status: 404 }),
      ),
      http.get('http://empty-llms.local/robots.txt', () => new HttpResponse('', { status: 404 })),
      http.get('http://empty-llms.local/sitemap.xml', () => new HttpResponse('', { status: 404 })),
    );

    const ctx = createContext('http://empty-llms.local', { requestDelay: 0 });
    const result = await getPageUrls(ctx);
    expect(result.urls).toEqual(['http://empty-llms.local']);
  });

  it('handles llms.txt fetch errors gracefully in standalone mode', async () => {
    server.use(
      http.get('http://err-llms.local/llms.txt', () => HttpResponse.error()),
      http.get('http://err-llms.local/docs/llms.txt', () => HttpResponse.error()),
      http.get('http://err-llms.local/robots.txt', () => new HttpResponse('', { status: 404 })),
      http.get('http://err-llms.local/sitemap.xml', () => new HttpResponse('', { status: 404 })),
    );

    const ctx = createContext('http://err-llms.local', { requestDelay: 0 });
    const result = await getPageUrls(ctx);
    expect(result.urls).toEqual(['http://err-llms.local']);
  });

  // ── Existing sitemap tests ──

  // ── Path-prefix scoping ──

  it('scopes llms.txt URLs to the baseUrl path prefix', async () => {
    const content = `# Docs\n> Summary\n## Links\n- [Intro](http://scope-test.local/docs/intro): Intro\n- [Guide](http://scope-test.local/docs/guide): Guide\n- [Blog](http://scope-test.local/blog/post1): A blog post\n- [Careers](http://scope-test.local/careers): Careers page\n`;
    const ctx = makeCtx('http://scope-test.local/docs', content);

    const result = await getPageUrls(ctx);
    expect(result.urls).toEqual([
      'http://scope-test.local/docs/intro',
      'http://scope-test.local/docs/guide',
    ]);
  });

  it('filters llms.txt URLs by locale when multiple locales present', async () => {
    const content = `# Docs\n## Links\n- [EN Intro](http://locale-llms.local/en/docs/intro): Intro\n- [EN Guide](http://locale-llms.local/en/docs/guide): Guide\n- [FR Intro](http://locale-llms.local/fr/docs/intro): Intro\n- [FR Guide](http://locale-llms.local/fr/docs/guide): Guide\n- [DE Intro](http://locale-llms.local/de/docs/intro): Intro\n- [DE Guide](http://locale-llms.local/de/docs/guide): Guide\n`;
    // No locale in base URL → defaults to 'en'
    const ctx = makeCtx('http://locale-llms.local', content);

    const result = await getPageUrls(ctx);
    expect(result.urls).toEqual([
      'http://locale-llms.local/en/docs/intro',
      'http://locale-llms.local/en/docs/guide',
    ]);
  });

  it('filters llms.txt URLs to preferred locale from base URL', async () => {
    const content = `# Docs\n## Links\n- [EN](http://locale-pref.local/en/docs/intro): Intro\n- [FR](http://locale-pref.local/fr/docs/intro): Intro\n- [DE](http://locale-pref.local/de/docs/intro): Intro\n`;
    // User passed /fr/ in base URL
    const ctx = makeCtx('http://locale-pref.local/fr', content);

    const result = await getPageUrls(ctx);
    expect(result.urls).toEqual(['http://locale-pref.local/fr/docs/intro']);
  });

  it('deduplicates versioned URLs from llms.txt', async () => {
    const content = `# Docs\n## Links\n- [v1](http://ver-llms.local/docs/v1/intro): Intro v1\n- [v2](http://ver-llms.local/docs/v2/intro): Intro v2\n- [v3](http://ver-llms.local/docs/v3/intro): Intro v3\n- [v1 Guide](http://ver-llms.local/docs/v1/guide): Guide v1\n- [v2 Guide](http://ver-llms.local/docs/v2/guide): Guide v2\n- [v3 Guide](http://ver-llms.local/docs/v3/guide): Guide v3\n`;
    const ctx = makeCtx('http://ver-llms.local', content);

    const result = await getPageUrls(ctx);
    // No version in base URL → defaults to highest (v3)
    expect(result.urls).toEqual([
      'http://ver-llms.local/docs/v3/intro',
      'http://ver-llms.local/docs/v3/guide',
    ]);
  });

  it('does not filter when baseUrl is at the root', async () => {
    const content = `# Docs\n- [A](http://root-scope.local/docs/a): A\n- [B](http://root-scope.local/blog/b): B\n`;
    const ctx = makeCtx('http://root-scope.local', content);

    const result = await getPageUrls(ctx);
    expect(result.urls).toEqual([
      'http://root-scope.local/docs/a',
      'http://root-scope.local/blog/b',
    ]);
  });

  it('scopes sitemap URLs to the baseUrl path prefix', async () => {
    server.use(
      http.get(
        'http://sitemap-scope.local/robots.txt',
        () => new HttpResponse('', { status: 404 }),
      ),
      http.get(
        'http://sitemap-scope.local/sitemap.xml',
        () =>
          new HttpResponse(
            `<?xml version="1.0"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>http://sitemap-scope.local/docs/intro</loc></url>
  <url><loc>http://sitemap-scope.local/docs/guide</loc></url>
  <url><loc>http://sitemap-scope.local/blog/post1</loc></url>
  <url><loc>http://sitemap-scope.local/careers</loc></url>
</urlset>`,
            { status: 200, headers: { 'Content-Type': 'application/xml' } },
          ),
      ),
      http.get(
        'http://sitemap-scope.local/docs/sitemap.xml',
        () => new HttpResponse('', { status: 404 }),
      ),
      http.get(
        'http://sitemap-scope.local/docs/sitemap-index.xml',
        () => new HttpResponse('', { status: 404 }),
      ),
    );

    const ctx = makeCtx('http://sitemap-scope.local/docs');
    const result = await getPageUrls(ctx);
    expect(result.urls).toEqual([
      'http://sitemap-scope.local/docs/intro',
      'http://sitemap-scope.local/docs/guide',
    ]);
  });

  it('discovers sitemap at docs subpath when origin-level sitemap is empty (#32)', async () => {
    // Simulate Swagger UI: robots.txt 404, /sitemap.xml 404, but /docs/sitemap-index.xml exists
    server.use(
      http.get('http://subpath-sm.local/robots.txt', () => new HttpResponse('', { status: 404 })),
      http.get(
        'http://subpath-sm.local/sitemap.xml',
        () => new HttpResponse('Not Found', { status: 404 }),
      ),
      http.get(
        'http://subpath-sm.local/docs/sitemap.xml',
        () => new HttpResponse('Not Found', { status: 404 }),
      ),
      http.get(
        'http://subpath-sm.local/docs/sitemap-index.xml',
        () =>
          new HttpResponse(
            `<?xml version="1.0"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap><loc>http://subpath-sm.local/docs/sitemap-0.xml</loc></sitemap>
</sitemapindex>`,
            { status: 200, headers: { 'Content-Type': 'application/xml' } },
          ),
      ),
      http.get(
        'http://subpath-sm.local/docs/sitemap-0.xml',
        () =>
          new HttpResponse(
            `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>http://subpath-sm.local/docs/getting-started</loc></url>
  <url><loc>http://subpath-sm.local/docs/configuration</loc></url>
</urlset>`,
            { status: 200, headers: { 'Content-Type': 'application/xml' } },
          ),
      ),
    );

    const ctx = makeCtx('http://subpath-sm.local/docs');
    const result = await getPageUrls(ctx);
    expect(result.urls).toEqual([
      'http://subpath-sm.local/docs/getting-started',
      'http://subpath-sm.local/docs/configuration',
    ]);
  });

  it('skips path filtering when effectiveOrigin differs from origin (cross-host redirect)', async () => {
    // Simulate: user provides example.com/docs, which redirects to docs.example.com
    // llms.txt on docs.example.com has links at root paths, not under /docs
    const content = `# Docs\n- [Intro](http://xhost.local/intro): Intro\n- [Guide](http://xhost.local/guide): Guide\n`;
    const ctx = makeCtx('http://original.local/docs', content);
    // Simulate cross-host redirect detection
    ctx.effectiveOrigin = 'http://xhost.local';

    const result = await getPageUrls(ctx);
    // Without the cross-host bypass, these would be filtered out (not under /docs)
    expect(result.urls).toContain('http://xhost.local/intro');
    expect(result.urls).toContain('http://xhost.local/guide');
    expect(result.urls).toHaveLength(2);
  });

  it('falls back to baseUrl when path scoping filters out all discovered URLs', async () => {
    // llms.txt has only non-docs URLs
    const content = `# Site\n- [Blog](http://filter-all.local/blog/post): Post\n- [About](http://filter-all.local/about): About\n`;

    server.use(
      http.get('http://filter-all.local/robots.txt', () => new HttpResponse('', { status: 404 })),
      http.get('http://filter-all.local/sitemap.xml', () => new HttpResponse('', { status: 404 })),
      http.get(
        'http://filter-all.local/docs/sitemap.xml',
        () => new HttpResponse('', { status: 404 }),
      ),
      http.get(
        'http://filter-all.local/docs/sitemap-index.xml',
        () => new HttpResponse('', { status: 404 }),
      ),
    );

    const ctx = makeCtx('http://filter-all.local/docs', content);
    const result = await getPageUrls(ctx);
    // Path filtering removed all llms.txt URLs, no sitemap available → fallback
    expect(result.urls).toEqual(['http://filter-all.local/docs']);
  });

  it('processes non-gzipped sitemaps alongside gzipped ones from robots.txt', async () => {
    server.use(
      http.get(
        'http://gz-mixed.local/robots.txt',
        () =>
          new HttpResponse(
            'Sitemap: http://gz-mixed.local/sitemap.xml.gz\nSitemap: http://gz-mixed.local/sitemap.xml\n',
            { status: 200 },
          ),
      ),
      http.get(
        'http://gz-mixed.local/sitemap.xml',
        () =>
          new HttpResponse(
            `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>http://gz-mixed.local/page</loc></url>
</urlset>`,
            { status: 200, headers: { 'Content-Type': 'application/xml' } },
          ),
      ),
    );

    const ctx = makeCtx('http://gz-mixed.local');
    const result = await getPageUrls(ctx);
    expect(result.urls).toEqual(['http://gz-mixed.local/page']);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('sitemap.xml.gz');
  });

  it('explicit preferredLocale overrides locale detected from base URL', async () => {
    const content = `# Docs\n## Links\n- [EN](http://opt-locale.local/en/docs/intro): Intro\n- [FR](http://opt-locale.local/fr/docs/intro): Intro\n- [DE](http://opt-locale.local/de/docs/intro): Intro\n`;
    // Base URL has /en/ but explicit option says 'de' — path prefix
    // should be rewritten from /en to /de so the right URLs pass through
    const ctx = makeCtx('http://opt-locale.local/en', content);
    ctx.options.preferredLocale = 'de';

    const result = await getPageUrls(ctx);
    expect(result.urls).toEqual(['http://opt-locale.local/de/docs/intro']);
  });

  it('explicit preferredVersion overrides version detected from base URL', async () => {
    const content = `# Docs\n## Links\n- [v1](http://opt-ver.local/docs/v1/intro): v1\n- [v2](http://opt-ver.local/docs/v2/intro): v2\n- [v3](http://opt-ver.local/docs/v3/intro): v3\n- [v1 Guide](http://opt-ver.local/docs/v1/guide): v1\n- [v2 Guide](http://opt-ver.local/docs/v2/guide): v2\n- [v3 Guide](http://opt-ver.local/docs/v3/guide): v3\n`;
    // Base URL has /v3/ but explicit option says 'v1' — path prefix
    // should be rewritten from /docs/v3 to /docs/v1
    const ctx = makeCtx('http://opt-ver.local/docs/v3', content);
    ctx.options.preferredVersion = 'v1';

    const result = await getPageUrls(ctx);
    expect(result.urls).toEqual([
      'http://opt-ver.local/docs/v1/intro',
      'http://opt-ver.local/docs/v1/guide',
    ]);
  });

  it('explicit preferredLocale applies to sitemap index filtering', async () => {
    server.use(
      http.get(
        'http://opt-sitemap-locale.local/robots.txt',
        () => new HttpResponse('', { status: 404 }),
      ),
      http.get(
        'http://opt-sitemap-locale.local/sitemap.xml',
        () =>
          new HttpResponse(
            `<?xml version="1.0"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap><loc>http://opt-sitemap-locale.local/sitemap-en.xml</loc></sitemap>
  <sitemap><loc>http://opt-sitemap-locale.local/sitemap-ja.xml</loc></sitemap>
  <sitemap><loc>http://opt-sitemap-locale.local/sitemap-fr.xml</loc></sitemap>
</sitemapindex>`,
            { status: 200, headers: { 'Content-Type': 'application/xml' } },
          ),
      ),
      http.get(
        'http://opt-sitemap-locale.local/sitemap-ja.xml',
        () =>
          new HttpResponse(
            `<?xml version="1.0"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>http://opt-sitemap-locale.local/ja/intro</loc></url>
  <url><loc>http://opt-sitemap-locale.local/ja/guide</loc></url>
</urlset>`,
            { status: 200, headers: { 'Content-Type': 'application/xml' } },
          ),
      ),
    );

    const ctx = makeCtx('http://opt-sitemap-locale.local');
    ctx.options.preferredLocale = 'ja';

    const result = await getPageUrls(ctx);
    expect(result.urls).toEqual([
      'http://opt-sitemap-locale.local/ja/intro',
      'http://opt-sitemap-locale.local/ja/guide',
    ]);
  });

  it('skipRefinement returns unfiltered sitemap URLs', async () => {
    server.use(
      http.get('http://skip-refine.local/robots.txt', () => new HttpResponse('', { status: 404 })),
      http.get(
        'http://skip-refine.local/sitemap.xml',
        () =>
          new HttpResponse(
            `<?xml version="1.0"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>http://skip-refine.local/en/intro</loc></url>
  <url><loc>http://skip-refine.local/fr/intro</loc></url>
  <url><loc>http://skip-refine.local/de/intro</loc></url>
  <url><loc>http://skip-refine.local/en/guide</loc></url>
  <url><loc>http://skip-refine.local/fr/guide</loc></url>
  <url><loc>http://skip-refine.local/de/guide</loc></url>
</urlset>`,
            { status: 200, headers: { 'Content-Type': 'application/xml' } },
          ),
      ),
    );

    const ctx = createContext('http://skip-refine.local', { requestDelay: 0 });
    const warnings: string[] = [];

    // Without skipRefinement: should filter to 'en' (2 URLs)
    const refined = await getUrlsFromSitemap(ctx, warnings);
    expect(refined).toHaveLength(2);
    expect(refined.every((u) => u.includes('/en/'))).toBe(true);

    // With skipRefinement: should return all 6 URLs
    const raw = await getUrlsFromSitemap(ctx, warnings, { skipRefinement: true });
    expect(raw).toHaveLength(6);
  });

  it('preferredLocale works when base URL has no locale segment', async () => {
    const content = `# Docs\n## Links\n- [EN](http://no-locale-base.local/en/intro): EN\n- [FR](http://no-locale-base.local/fr/intro): FR\n- [DE](http://no-locale-base.local/de/intro): DE\n`;
    // Base URL has no locale — without the flag, would default to 'en'
    const ctx = makeCtx('http://no-locale-base.local', content);
    ctx.options.preferredLocale = 'fr';

    const result = await getPageUrls(ctx);
    expect(result.urls).toEqual(['http://no-locale-base.local/fr/intro']);
  });

  it('preferredVersion is a no-op when it matches version in base URL', async () => {
    const content = `# Docs\n## Links\n- [v1](http://ver-match.local/docs/v1/intro): v1\n- [v2](http://ver-match.local/docs/v2/intro): v2\n- [v3](http://ver-match.local/docs/v3/intro): v3\n- [v1 Guide](http://ver-match.local/docs/v1/guide): v1\n- [v2 Guide](http://ver-match.local/docs/v2/guide): v2\n- [v3 Guide](http://ver-match.local/docs/v3/guide): v3\n`;
    // preferredVersion matches what's in the base URL — same result either way
    const ctx = makeCtx('http://ver-match.local/docs/v2', content);
    ctx.options.preferredVersion = 'v2';

    const result = await getPageUrls(ctx);
    expect(result.urls).toEqual([
      'http://ver-match.local/docs/v2/intro',
      'http://ver-match.local/docs/v2/guide',
    ]);
  });

  it('respects maxUrls cap when following sitemap index sub-sitemaps', async () => {
    server.use(
      http.get('http://cap-index.local/robots.txt', () => new HttpResponse('', { status: 404 })),
      http.get(
        'http://cap-index.local/sitemap.xml',
        () =>
          new HttpResponse(
            `<?xml version="1.0"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap><loc>http://cap-index.local/sitemap-1.xml</loc></sitemap>
  <sitemap><loc>http://cap-index.local/sitemap-2.xml</loc></sitemap>
</sitemapindex>`,
            { status: 200, headers: { 'Content-Type': 'application/xml' } },
          ),
      ),
      http.get(
        'http://cap-index.local/sitemap-1.xml',
        () =>
          new HttpResponse(
            `<?xml version="1.0"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>http://cap-index.local/page-1</loc></url>
  <url><loc>http://cap-index.local/page-2</loc></url>
  <url><loc>http://cap-index.local/page-3</loc></url>
</urlset>`,
            { status: 200, headers: { 'Content-Type': 'application/xml' } },
          ),
      ),
      http.get(
        'http://cap-index.local/sitemap-2.xml',
        () =>
          new HttpResponse(
            `<?xml version="1.0"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>http://cap-index.local/page-4</loc></url>
  <url><loc>http://cap-index.local/page-5</loc></url>
</urlset>`,
            { status: 200, headers: { 'Content-Type': 'application/xml' } },
          ),
      ),
    );

    const ctx = createContext('http://cap-index.local', { requestDelay: 0 });
    const warnings: string[] = [];
    const result = await getUrlsFromSitemap(ctx, warnings, { maxUrls: 4 });
    expect(result).toHaveLength(4);
    // First 3 from sitemap-1, then 1 from sitemap-2 before cap
    expect(result).toEqual([
      'http://cap-index.local/page-1',
      'http://cap-index.local/page-2',
      'http://cap-index.local/page-3',
      'http://cap-index.local/page-4',
    ]);
  });
});

describe('discoverAndSamplePages', () => {
  function makeCtx(baseUrl: string, llmsTxtContent: string, opts?: Record<string, unknown>) {
    const ctx = createContext(baseUrl, { requestDelay: 0, ...opts });
    const discovered: DiscoveredFile[] = [
      { url: `${baseUrl}/llms.txt`, content: llmsTxtContent, status: 200, redirected: false },
    ];
    ctx.previousResults.set('llms-txt-exists', {
      id: 'llms-txt-exists',
      category: 'content-discoverability',
      status: 'pass',
      message: 'Found',
      details: { discoveredFiles: discovered },
    });

    mockSitemapNotFound(server, baseUrl);

    return ctx;
  }

  it('returns all URLs without sampling when under maxLinksToTest', async () => {
    const content = `# Docs\n> Summary\n## Links\n- [A](http://sample.local/a): A\n- [B](http://sample.local/b): B\n`;
    const ctx = makeCtx('http://sample.local', content, { maxLinksToTest: 10 });

    const result = await discoverAndSamplePages(ctx);
    expect(result.urls).toEqual(['http://sample.local/a', 'http://sample.local/b']);
    expect(result.totalPages).toBe(2);
    expect(result.sampled).toBe(false);
    expect(result.warnings).toEqual([]);
    expect(result.sources).toContain('llms-txt');
  });

  it('samples down to maxLinksToTest when over limit', async () => {
    const links = Array.from(
      { length: 10 },
      (_, i) => `- [Page ${i}](http://sample-big.local/page${i}): Page ${i}`,
    ).join('\n');
    const content = `# Docs\n> Summary\n## Links\n${links}\n`;
    const ctx = makeCtx('http://sample-big.local', content, { maxLinksToTest: 3 });

    const result = await discoverAndSamplePages(ctx);
    expect(result.urls).toHaveLength(3);
    expect(result.totalPages).toBe(10);
    expect(result.sampled).toBe(true);
    // All returned URLs should be from the original set
    for (const url of result.urls) {
      expect(url).toMatch(/^http:\/\/sample-big\.local\/page\d$/);
    }
  });

  it('deterministic strategy produces stable evenly-spaced results', async () => {
    const links = Array.from(
      { length: 10 },
      (_, i) => `- [Page ${i}](http://det.local/page-${String(i).padStart(2, '0')}): Page ${i}`,
    ).join('\n');
    const content = `# Docs\n> Summary\n## Links\n${links}\n`;
    const ctx = makeCtx('http://det.local', content, {
      maxLinksToTest: 3,
      samplingStrategy: 'deterministic',
    });

    const result = await discoverAndSamplePages(ctx);
    expect(result.urls).toHaveLength(3);
    expect(result.totalPages).toBe(10);
    expect(result.sampled).toBe(true);

    // Run again with a fresh context — should produce the same URLs
    const ctx2 = makeCtx('http://det.local', content, {
      maxLinksToTest: 3,
      samplingStrategy: 'deterministic',
    });
    const result2 = await discoverAndSamplePages(ctx2);
    expect(result2.urls).toEqual(result.urls);

    // URLs should be evenly spaced from the sorted list
    // Sorted: page-00 through page-09, stride = 10/3 ≈ 3.33
    // Indices: floor(0*3.33)=0, floor(1*3.33)=3, floor(2*3.33)=6
    expect(result.urls).toEqual([
      'http://det.local/page-00',
      'http://det.local/page-03',
      'http://det.local/page-06',
    ]);
  });

  it('none strategy returns only the baseUrl without discovery', async () => {
    const content = `# Docs\n> Summary\n## Links\n- [A](http://none-test.local/a): A\n- [B](http://none-test.local/b): B\n`;
    const ctx = makeCtx('http://none-test.local', content, {
      samplingStrategy: 'none',
    });

    const result = await discoverAndSamplePages(ctx);
    expect(result.urls).toEqual(['http://none-test.local']);
    expect(result.totalPages).toBe(1);
    expect(result.sampled).toBe(false);
  });

  it('curated strategy returns configured URLs without discovery', async () => {
    const curatedPages = ['http://curated.local/page-a', 'http://curated.local/page-b'];
    const ctx = createContext('http://curated.local', {
      requestDelay: 0,
      samplingStrategy: 'curated',
      curatedPages,
    });

    const result = await discoverAndSamplePages(ctx);
    expect(result.urls).toEqual(['http://curated.local/page-a', 'http://curated.local/page-b']);
    expect(result.totalPages).toBe(2);
    expect(result.sampled).toBe(false);
    expect(result.urlTags).toBeUndefined();
  });

  it('curated strategy with tagged objects populates urlTags', async () => {
    const curatedPages = [
      'http://curated-tags.local/page-a',
      { url: 'http://curated-tags.local/page-b', tag: 'api' },
      { url: 'http://curated-tags.local/page-c', tag: 'guides' },
    ];
    const ctx = createContext('http://curated-tags.local', {
      requestDelay: 0,
      samplingStrategy: 'curated',
      curatedPages,
    });

    const result = await discoverAndSamplePages(ctx);
    expect(result.urls).toHaveLength(3);
    expect(result.urlTags).toEqual({
      'http://curated-tags.local/page-b': 'api',
      'http://curated-tags.local/page-c': 'guides',
    });
  });

  it('curated strategy with empty pages throws validation error', () => {
    expect(() =>
      createContext('http://curated-empty.local', {
        requestDelay: 0,
        samplingStrategy: 'curated',
        curatedPages: [],
      }),
    ).toThrow('Curated sampling requires curatedPages to be non-empty');
  });

  it('curated strategy does not apply maxLinksToTest', async () => {
    const urls = Array.from({ length: 100 }, (_, i) => `http://curated-many.local/page-${i}`);
    const ctx = createContext('http://curated-many.local', {
      requestDelay: 0,
      samplingStrategy: 'curated',
      maxLinksToTest: 5,
      curatedPages: urls,
    });

    const result = await discoverAndSamplePages(ctx);
    expect(result.urls).toHaveLength(100);
    expect(result.sampled).toBe(false);
  });

  it('passes through warnings from discovery', async () => {
    server.use(
      http.get(
        'http://sample-warn.local/robots.txt',
        () =>
          new HttpResponse('Sitemap: http://sample-warn.local/sitemap.xml.gz\n', { status: 200 }),
      ),
    );

    // No llms.txt content, so discovery falls through to sitemap (which is gzipped → warning → fallback)
    const ctx = createContext('http://sample-warn.local', { requestDelay: 0 });
    ctx.previousResults.set('llms-txt-exists', {
      id: 'llms-txt-exists',
      category: 'content-discoverability',
      status: 'fail',
      message: 'No llms.txt found',
      details: { discoveredFiles: [] },
    });

    const result = await discoverAndSamplePages(ctx);
    expect(result.urls).toEqual(['http://sample-warn.local']);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('gzipped sitemap');
  });
});

// Issue #77: when llms.txt links use a .md/.mdx (or .html.md) suffix,
// normalizePageUrl rewrites them to their HTML form for dedup against sitemap
// entries. The original .md URL must still be carried alongside so that
// markdown-availability checks can test the URL the site explicitly published.
describe('originalMdUrls (issue #77)', () => {
  it('preserves originalMdUrl for .html.md links from llms.txt', async () => {
    const ctx = createContext('http://test77a.local', { requestDelay: 0 });
    const content = `# Docs
> Summary
## Links
- [Auth](http://test77a.local/docs/auth/index.html.md): Auth guide
`;
    const discovered: DiscoveredFile[] = [
      { url: 'http://test77a.local/llms.txt', content, status: 200, redirected: false },
    ];
    ctx.previousResults.set('llms-txt-exists', {
      id: 'llms-txt-exists',
      category: 'content-discoverability',
      status: 'pass',
      message: 'Found',
      details: { discoveredFiles: discovered },
    });
    mockSitemapNotFound(server, 'http://test77a.local');

    const result = await discoverAndSamplePages(ctx);
    expect(result.urls).toContain('http://test77a.local/docs/auth/index.html');
    expect(result.originalMdUrls).toBeDefined();
    expect(result.originalMdUrls!['http://test77a.local/docs/auth/index.html']).toBe(
      'http://test77a.local/docs/auth/index.html.md',
    );
  });

  it('preserves originalMdUrl for .mdx links from llms.txt', async () => {
    const ctx = createContext('http://test77b.local', { requestDelay: 0 });
    const content = `# Docs
> Summary
## Links
- [Guide](http://test77b.local/docs/guide.mdx): Guide
`;
    const discovered: DiscoveredFile[] = [
      { url: 'http://test77b.local/llms.txt', content, status: 200, redirected: false },
    ];
    ctx.previousResults.set('llms-txt-exists', {
      id: 'llms-txt-exists',
      category: 'content-discoverability',
      status: 'pass',
      message: 'Found',
      details: { discoveredFiles: discovered },
    });
    mockSitemapNotFound(server, 'http://test77b.local');

    const result = await discoverAndSamplePages(ctx);
    expect(result.urls).toContain('http://test77b.local/docs/guide');
    expect(result.originalMdUrls!['http://test77b.local/docs/guide']).toBe(
      'http://test77b.local/docs/guide.mdx',
    );
  });

  it('preserves originalMdUrl for plain .md links from llms.txt', async () => {
    const ctx = createContext('http://test77c.local', { requestDelay: 0 });
    const content = `# Docs
> Summary
## Links
- [Auth](http://test77c.local/docs/auth.md): Auth
`;
    const discovered: DiscoveredFile[] = [
      { url: 'http://test77c.local/llms.txt', content, status: 200, redirected: false },
    ];
    ctx.previousResults.set('llms-txt-exists', {
      id: 'llms-txt-exists',
      category: 'content-discoverability',
      status: 'pass',
      message: 'Found',
      details: { discoveredFiles: discovered },
    });
    mockSitemapNotFound(server, 'http://test77c.local');

    const result = await discoverAndSamplePages(ctx);
    expect(result.urls).toContain('http://test77c.local/docs/auth');
    expect(result.originalMdUrls!['http://test77c.local/docs/auth']).toBe(
      'http://test77c.local/docs/auth.md',
    );
  });

  it('does not populate originalMdUrls for sitemap-only discovery', async () => {
    const ctx = createContext('http://test77d.local', { requestDelay: 0 });
    ctx.previousResults.set('llms-txt-exists', {
      id: 'llms-txt-exists',
      category: 'content-discoverability',
      status: 'fail',
      message: 'No llms.txt',
      details: { discoveredFiles: [] },
    });
    server.use(
      http.get('http://test77d.local/robots.txt', () => new HttpResponse('', { status: 404 })),
      http.get(
        'http://test77d.local/sitemap.xml',
        () =>
          new HttpResponse(
            `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
              <url><loc>http://test77d.local/docs/auth</loc></url>
              <url><loc>http://test77d.local/docs/guide</loc></url>
            </urlset>`,
            { status: 200, headers: { 'Content-Type': 'application/xml' } },
          ),
      ),
    );

    const result = await discoverAndSamplePages(ctx);
    expect(result.urls).toContain('http://test77d.local/docs/auth');
    // Sitemap URLs are HTML; nothing to preserve.
    expect(
      result.originalMdUrls === undefined || Object.keys(result.originalMdUrls).length === 0,
    ).toBe(true);
  });

  it('keeps the .md form when llms.txt has both .md and HTML for the same page', async () => {
    const ctx = createContext('http://test77e.local', { requestDelay: 0 });
    const content = `# Docs
> Summary
## Links
- [Auth](http://test77e.local/docs/auth.md): Auth markdown
- [Auth HTML](http://test77e.local/docs/auth): Auth html
`;
    const discovered: DiscoveredFile[] = [
      { url: 'http://test77e.local/llms.txt', content, status: 200, redirected: false },
    ];
    ctx.previousResults.set('llms-txt-exists', {
      id: 'llms-txt-exists',
      category: 'content-discoverability',
      status: 'pass',
      message: 'Found',
      details: { discoveredFiles: discovered },
    });
    mockSitemapNotFound(server, 'http://test77e.local');

    const result = await discoverAndSamplePages(ctx);
    // Both entries collapse to the HTML URL after normalization.
    const matching = result.urls.filter((u) => u === 'http://test77e.local/docs/auth');
    expect(matching).toHaveLength(1);
    expect(result.originalMdUrls!['http://test77e.local/docs/auth']).toBe(
      'http://test77e.local/docs/auth.md',
    );
  });

  it('filters originalMdUrls to the sampled subset', async () => {
    const links = Array.from(
      { length: 5 },
      (_, i) => `- [P${i}](http://test77f.local/docs/p${i}/index.html.md): Page ${i}`,
    ).join('\n');
    const content = `# Docs\n> Summary\n## Links\n${links}\n`;
    const ctx = createContext('http://test77f.local', { requestDelay: 0, maxLinksToTest: 2 });
    const discovered: DiscoveredFile[] = [
      { url: 'http://test77f.local/llms.txt', content, status: 200, redirected: false },
    ];
    ctx.previousResults.set('llms-txt-exists', {
      id: 'llms-txt-exists',
      category: 'content-discoverability',
      status: 'pass',
      message: 'Found',
      details: { discoveredFiles: discovered },
    });
    mockSitemapNotFound(server, 'http://test77f.local');

    const result = await discoverAndSamplePages(ctx);
    expect(result.urls).toHaveLength(2);
    expect(result.sampled).toBe(true);
    // Only the sampled URLs should have entries in originalMdUrls
    expect(Object.keys(result.originalMdUrls ?? {})).toHaveLength(2);
    for (const sampledUrl of result.urls) {
      expect(result.originalMdUrls![sampledUrl]).toMatch(/\.html\.md$/);
    }
  });

  it('propagates originalMdUrl through aggregate (.txt) walking', async () => {
    const ctx = createContext('http://test77g.local', { requestDelay: 0 });
    const llmsContent = `# Docs
> Summary
## Links
- [Aggregate](http://test77g.local/docs/all.txt): All pages
`;
    const aggregateContent = `# All
- [Auth](http://test77g.local/docs/auth/index.html.md): Auth guide
`;
    server.use(
      http.get(
        'http://test77g.local/docs/all.txt',
        () =>
          new HttpResponse(aggregateContent, {
            status: 200,
            headers: { 'Content-Type': 'text/plain' },
          }),
      ),
    );
    const discovered: DiscoveredFile[] = [
      {
        url: 'http://test77g.local/llms.txt',
        content: llmsContent,
        status: 200,
        redirected: false,
      },
    ];
    ctx.previousResults.set('llms-txt-exists', {
      id: 'llms-txt-exists',
      category: 'content-discoverability',
      status: 'pass',
      message: 'Found',
      details: { discoveredFiles: discovered },
    });
    mockSitemapNotFound(server, 'http://test77g.local');

    const result = await discoverAndSamplePages(ctx);
    expect(result.urls).toContain('http://test77g.local/docs/auth/index.html');
    expect(result.originalMdUrls!['http://test77g.local/docs/auth/index.html']).toBe(
      'http://test77g.local/docs/auth/index.html.md',
    );
  });
});
