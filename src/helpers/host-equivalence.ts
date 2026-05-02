/**
 * Host equivalence: treat `www.host` and `host` as the same site.
 *
 * Documentation sites mix the two forms in several ways that all need the
 * same treatment: redirect classification, sitemap URL filtering, path-filter
 * base derivation, and aggregate-link walking. Keeping the rule in one place
 * means future tweaks (e.g. recognizing additional canonical prefixes)
 * propagate to every site automatically.
 */

/**
 * Strip a leading `www.` from a hostname, if present.
 */
export function canonicalHost(host: string): string {
  return host.startsWith('www.') ? host.slice(4) : host;
}

/**
 * True when two URLs (or origins) represent the same site: same hostname after
 * stripping `www.`, and same port. Schemes are deliberately ignored so that
 * the canonical http→https upgrade on the same host is not classified as a
 * different site.
 */
export function isSameSite(url1: string, url2: string): boolean {
  try {
    const a = new URL(url1);
    const b = new URL(url2);
    return a.port === b.port && canonicalHost(a.hostname) === canonicalHost(b.hostname);
  } catch {
    return false;
  }
}
