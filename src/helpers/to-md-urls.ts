import { isSameSite } from './host-equivalence.js';

/**
 * Returns true if the two URLs have different hosts (i.e. a cross-host redirect).
 * A www ↔ bare-domain redirect (e.g. mongodb.com → www.mongodb.com) is NOT
 * considered cross-host because every HTTP client and agent follows it.
 *
 * Returns false for malformed URLs — when we can't classify, default to
 * "not cross-host" so we don't penalize on bad inputs.
 */
export function isCrossHostRedirect(originalUrl: string, finalUrl: string): boolean {
  try {
    new URL(originalUrl);
    new URL(finalUrl);
  } catch {
    return false;
  }
  return !isSameSite(originalUrl, finalUrl);
}

/**
 * Returns true if the URL points to a non-page file type (e.g. .json, .xml, .txt)
 * where we would not expect a markdown equivalent.
 */
export function isNonPageUrl(url: string): boolean {
  const parsed = new URL(url);
  const lastSegment = parsed.pathname.split('/').pop() ?? '';
  // Has a file extension that isn't .html/.htm/.md/.mdx
  return (
    /\.[a-z0-9]+$/i.test(lastSegment) &&
    !/\.html?$/i.test(lastSegment) &&
    !lastSegment.endsWith('.md') &&
    !lastSegment.endsWith('.mdx')
  );
}

/**
 * Convert a .md or .mdx URL back to its canonical HTML equivalent.
 * Inverts the transforms from toMdUrls():
 *   /docs/guide.md       -> /docs/guide
 *   /docs/guide/index.md -> /docs/guide/
 *   /docs/guide.mdx      -> /docs/guide
 * If the URL doesn't end in .md/.mdx, return it unchanged.
 */
export function toHtmlUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.pathname.endsWith('/index.md') || parsed.pathname.endsWith('/index.mdx')) {
      parsed.pathname = parsed.pathname.replace(/\/index\.mdx?$/, '/');
      return parsed.toString();
    }
    if (/\.mdx?$/i.test(parsed.pathname)) {
      parsed.pathname = parsed.pathname.replace(/\.mdx?$/i, '');
      return parsed.toString();
    }
  } catch {
    // Fall through to return original
  }
  return url;
}

/**
 * Returns true if the URL points to a .md or .mdx file.
 */
export function isMdUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return /\.mdx?$/i.test(parsed.pathname);
  } catch {
    return false;
  }
}

/**
 * Generate candidate .md URLs for a page URL.
 * If the URL already ends in .md, return it as-is.
 * Otherwise try both `/docs/guide.md` and `/docs/guide/index.md`.
 */
export function toMdUrls(url: string): string[] {
  const parsed = new URL(url);

  // URL already points to a .md or .mdx file — use it directly
  if (parsed.pathname.endsWith('.md') || parsed.pathname.endsWith('.mdx')) {
    return [url];
  }

  // Non-page file extension (e.g. .txt, .json, .xml) — no .md equivalent
  if (isNonPageUrl(url)) {
    return [];
  }

  const pathname = parsed.pathname.replace(/\/$/, '') || '';
  const candidates: string[] = [];

  // /docs/guide.md (strip .html extension if present)
  const directMd = new URL(parsed.toString());
  directMd.pathname = pathname.replace(/\.html?$/, '') + '.md';
  candidates.push(directMd.toString());

  // /docs/guide/index.md
  const indexMd = new URL(parsed.toString());
  indexMd.pathname = pathname + '/index.md';
  candidates.push(indexMd.toString());

  return candidates;
}
