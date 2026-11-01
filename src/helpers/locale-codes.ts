// ISO 639-1 language codes.
// Stable standard (~184 codes, last major revision 2002). Used to validate
// locale-like path segments instead of a broad regex that would match
// non-locale 2-letter segments like "go", "ai", "my", "io", "up", "do".
const ISO_639_1 = new Set([
  'aa',
  'ab',
  'ae',
  'af',
  'ak',
  'am',
  'an',
  'ar',
  'as',
  'av',
  'ay',
  'az',
  'ba',
  'be',
  'bg',
  'bh',
  'bi',
  'bm',
  'bn',
  'bo',
  'br',
  'bs',
  'ca',
  'ce',
  'ch',
  'co',
  'cr',
  'cs',
  'cu',
  'cv',
  'cy',
  'da',
  'de',
  'dv',
  'dz',
  'ee',
  'el',
  'en',
  'eo',
  'es',
  'et',
  'eu',
  'fa',
  'ff',
  'fi',
  'fj',
  'fo',
  'fr',
  'fy',
  'ga',
  'gd',
  'gl',
  'gn',
  'gu',
  'gv',
  'ha',
  'he',
  'hi',
  'ho',
  'hr',
  'ht',
  'hu',
  'hy',
  'hz',
  'ia',
  'id',
  'ie',
  'ig',
  'ii',
  'ik',
  'io',
  'is',
  'it',
  'iu',
  'ja',
  'jv',
  'ka',
  'kg',
  'ki',
  'kj',
  'kk',
  'kl',
  'km',
  'kn',
  'ko',
  'kr',
  'ks',
  'ku',
  'kv',
  'kw',
  'ky',
  'la',
  'lb',
  'lg',
  'li',
  'ln',
  'lo',
  'lt',
  'lu',
  'lv',
  'mg',
  'mh',
  'mi',
  'mk',
  'ml',
  'mn',
  'mr',
  'ms',
  'mt',
  'my',
  'na',
  'nb',
  'nd',
  'ne',
  'ng',
  'nl',
  'nn',
  'no',
  'nr',
  'nv',
  'ny',
  'oc',
  'oj',
  'om',
  'or',
  'os',
  'pa',
  'pi',
  'pl',
  'ps',
  'pt',
  'qu',
  'rm',
  'rn',
  'ro',
  'ru',
  'rw',
  'sa',
  'sc',
  'sd',
  'se',
  'sg',
  'si',
  'sk',
  'sl',
  'sm',
  'sn',
  'so',
  'sq',
  'sr',
  'ss',
  'st',
  'su',
  'sv',
  'sw',
  'ta',
  'te',
  'tg',
  'th',
  'ti',
  'tk',
  'tl',
  'tn',
  'to',
  'tr',
  'ts',
  'tt',
  'tw',
  'ty',
  'ug',
  'uk',
  'ur',
  'uz',
  've',
  'vi',
  'vo',
  'wa',
  'wo',
  'xh',
  'yi',
  'yo',
  'za',
  'zh',
  'zu',
]);

// ISO 15924 script subtags seen as locale path segments on documentation
// sites (`zh-Hans`, `zh-Hant`, `sr-Latn`, `uz-Cyrl`). Curated rather than the
// full registry so that lowercased segments such as `en-vivo` or `es-tudo`
// keep failing validation (issue #161).
const ISO_15924 = new Set([
  'arab',
  'armn',
  'beng',
  'cyrl',
  'deva',
  'ethi',
  'geor',
  'grek',
  'gujr',
  'guru',
  'hang',
  'hani',
  'hans',
  'hant',
  'hebr',
  'hira',
  'jpan',
  'kana',
  'khmr',
  'knda',
  'kore',
  'laoo',
  'latn',
  'mlym',
  'mong',
  'mymr',
  'sinh',
  'taml',
  'telu',
  'thai',
  'tibt',
]);

/** Two-character region subtag (`br`, `us`, `cn`). */
function isRegionSubtag(part: string): boolean {
  return part.length === 2;
}

/**
 * Test whether a path segment is a valid locale code.
 * Accepts ISO 639-1 language codes ("en", "de") and BCP 47 forms whose
 * language part is a valid ISO 639-1 code:
 * - language-region ("pt-br", "zh-cn")
 * - language-script ("zh-hans", "sr-latn")
 * - language-script-region ("zh-hans-cn")
 */
export function isLocaleSegment(segment: string): boolean {
  const lower = segment.toLowerCase();
  if (ISO_639_1.has(lower)) return true;
  const parts = lower.split('-');
  if (parts.length < 2 || parts.length > 3 || !ISO_639_1.has(parts[0])) return false;
  if (parts.length === 2) {
    return isRegionSubtag(parts[1]) || ISO_15924.has(parts[1]);
  }
  return ISO_15924.has(parts[1]) && isRegionSubtag(parts[2]);
}

/**
 * Check whether a single locale code at `position` represents a real locale
 * prefix by testing for structural duplication: if stripping the code from
 * prefixed URLs produces paths that overlap with unprefixed URLs in the set,
 * the code is a locale variant, not a topic segment.
 *
 * Example: `/docs/de/intro` stripped → `/docs/intro` matches the unprefixed
 * URL `/docs/intro` → structural duplication confirmed.
 */
export function hasStructuralDuplication(
  urls: string[],
  position: number,
  localeCode: string,
): boolean {
  const strippedPaths = new Set<string>();
  const unprefixedPaths = new Set<string>();

  for (const url of urls) {
    try {
      const segments = new URL(url).pathname.split('/').filter(Boolean);
      if (segments.length > position && segments[position].toLowerCase() === localeCode) {
        const stripped = [...segments.slice(0, position), ...segments.slice(position + 1)].join(
          '/',
        );
        strippedPaths.add(stripped);
      } else if (segments.length > position && !isLocaleSegment(segments[position])) {
        unprefixedPaths.add(segments.join('/'));
      }
    } catch {
      continue;
    }
  }

  if (strippedPaths.size === 0 || unprefixedPaths.size === 0) return false;

  let overlap = 0;
  for (const path of strippedPaths) {
    if (unprefixedPaths.has(path)) overlap++;
  }

  return overlap > strippedPaths.size * 0.5;
}

/**
 * Detect whether a URL set uses locale-prefixed paths and, if so, return the
 * path segment position where locales appear.
 *
 * Shared by page discovery (`filterLocalizedUrls`) and the llms-txt-coverage
 * check so both agree about which sites are localized (issue #159).
 *
 * Detection is empirical, in two passes over each path segment position:
 *
 * 1. Two or more distinct locale codes at the position that together cover
 *    more than half of the URLs (e.g. `/docs/en/intro`, `/docs/de/intro`).
 * 2. Otherwise, any locale code at the position confirmed by structural
 *    duplication: stripping the code yields paths that match unprefixed URLs
 *    in the same set. This catches a single-locale site and a site whose
 *    default language is unprefixed with translations in the minority
 *    (e.g. `/fr/`, `/ja/`, `/ko/`, `/es/` at 40% of URLs).
 */
export function detectLocalePosition(urls: string[]): number | null {
  const positionCounts = new Map<number, Map<string, number>>();
  const positionTotals = new Map<number, number>();

  for (const url of urls) {
    try {
      const segments = new URL(url).pathname.split('/').filter(Boolean);
      for (let i = 0; i < segments.length; i++) {
        const seg = segments[i].toLowerCase();
        if (isLocaleSegment(seg)) {
          if (!positionCounts.has(i)) positionCounts.set(i, new Map());
          const counts = positionCounts.get(i)!;
          counts.set(seg, (counts.get(seg) ?? 0) + 1);
          positionTotals.set(i, (positionTotals.get(i) ?? 0) + 1);
        }
      }
    } catch {
      continue;
    }
  }

  // First pass: ≥2 distinct locale codes covering >50% of URLs (strong signal)
  for (const [pos, counts] of positionCounts) {
    if (counts.size < 2) continue;
    const total = positionTotals.get(pos) ?? 0;
    if (total > urls.length * 0.5) {
      return pos;
    }
  }

  // Second pass: locale codes below the coverage threshold, confirmed by
  // structural duplication: stripping a code must produce paths that match
  // unprefixed URLs in the same set. This catches multi-locale sites whose
  // default locale is unprefixed and whose translations are a minority of
  // the sitemap (e.g. /fr/, /ja/, /ko/, /es/ at 40% of URLs), as well as
  // the single-locale case.
  for (const [pos, counts] of positionCounts) {
    const codes = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([code]) => code);
    if (codes.some((code) => hasStructuralDuplication(urls, pos, code))) {
      return pos;
    }
  }

  return null;
}
