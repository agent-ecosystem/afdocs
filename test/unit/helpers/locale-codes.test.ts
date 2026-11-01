import { describe, test, expect } from 'vitest';
import {
  isLocaleSegment,
  hasStructuralDuplication,
  detectLocalePosition,
  countLocaleCodesAt,
  resolveLocaleVariant,
  sameLanguageVariants,
} from '../../../src/helpers/locale-codes.js';

describe('isLocaleSegment', () => {
  test('accepts common ISO 639-1 language codes', () => {
    for (const code of ['en', 'es', 'fr', 'de', 'ja', 'ko', 'zh', 'pt', 'ru', 'ar', 'nl', 'it']) {
      expect(isLocaleSegment(code), code).toBe(true);
    }
  });

  test('accepts BCP 47 language-region subtags', () => {
    for (const code of ['pt-br', 'en-us', 'zh-cn', 'fr-fr', 'de-de']) {
      expect(isLocaleSegment(code), code).toBe(true);
    }
  });

  test('is case-insensitive', () => {
    expect(isLocaleSegment('EN')).toBe(true);
    expect(isLocaleSegment('Pt-BR')).toBe(true);
    expect(isLocaleSegment('zh-CN')).toBe(true);
  });

  test('rejects 2-letter path segments that are not ISO 639-1 codes', () => {
    for (const seg of ['go', 'ai', 'up', 'do', 'us', 'ds', 'db', 'vm', 'qa', 'v2', 'wp']) {
      expect(isLocaleSegment(seg), seg).toBe(false);
    }
  });

  test('accepts 2-letter segments that happen to be valid language codes', () => {
    // These look like common path segments but are real ISO 639-1 codes
    expect(isLocaleSegment('my'), 'my = Burmese').toBe(true);
    expect(isLocaleSegment('io'), 'io = Ido').toBe(true);
    expect(isLocaleSegment('no'), 'no = Norwegian').toBe(true);
    expect(isLocaleSegment('hr'), 'hr = Croatian').toBe(true);
    expect(isLocaleSegment('am'), 'am = Amharic').toBe(true);
  });

  test('rejects longer path segments', () => {
    expect(isLocaleSegment('docs')).toBe(false);
    expect(isLocaleSegment('api')).toBe(false);
    expect(isLocaleSegment('intro')).toBe(false);
    expect(isLocaleSegment('getting-started')).toBe(false);
  });

  test('rejects single characters', () => {
    expect(isLocaleSegment('a')).toBe(false);
    expect(isLocaleSegment('v')).toBe(false);
  });

  test('accepts BCP 47 script subtags (issue #161)', () => {
    for (const code of ['zh-Hans', 'zh-hant', 'sr-Latn', 'uz-Cyrl', 'ZH-HANS']) {
      expect(isLocaleSegment(code), code).toBe(true);
    }
  });

  test('accepts language-script-region forms', () => {
    expect(isLocaleSegment('zh-Hans-CN')).toBe(true);
    expect(isLocaleSegment('sr-Latn-RS')).toBe(true);
  });

  test('rejects hyphenated words whose tail is not a known script', () => {
    for (const seg of ['en-vivo', 'es-tudo', 'go-live', 'en-docs', 'de-dupe', 'is-this']) {
      expect(isLocaleSegment(seg), seg).toBe(false);
    }
  });

  test('rejects script subtags with an invalid language part or wrong order', () => {
    expect(isLocaleSegment('xx-Hans')).toBe(false);
    expect(isLocaleSegment('zh-CN-Hans')).toBe(false);
    expect(isLocaleSegment('zh-Hans-Hant')).toBe(false);
    expect(isLocaleSegment('zh-Hans-CN-x')).toBe(false);
  });

  test('rejects region-only subtags with invalid language part', () => {
    expect(isLocaleSegment('xx-us')).toBe(false);
    expect(isLocaleSegment('zz-cn')).toBe(false);
  });
});

describe('hasStructuralDuplication', () => {
  test('confirms locale when stripped paths match unprefixed URLs', () => {
    const urls = [
      'https://x.com/docs/intro',
      'https://x.com/docs/guide',
      'https://x.com/docs/de/intro',
      'https://x.com/docs/de/guide',
    ];
    expect(hasStructuralDuplication(urls, 1, 'de')).toBe(true);
  });

  test('confirms locale with partial translation overlap', () => {
    const urls = [
      'https://x.com/docs/intro',
      'https://x.com/docs/guide',
      'https://x.com/docs/api',
      'https://x.com/docs/de/intro', // only one translated page
    ];
    expect(hasStructuralDuplication(urls, 1, 'de')).toBe(true);
  });

  test('rejects when stripped paths do not match unprefixed URLs', () => {
    // "hr" used as topic (Human Resources), not locale
    const urls = [
      'https://x.com/docs/hr/onboarding',
      'https://x.com/docs/hr/policies',
      'https://x.com/docs/engineering/onboarding',
      'https://x.com/docs/engineering/policies',
    ];
    expect(hasStructuralDuplication(urls, 1, 'hr')).toBe(false);
  });

  test('rejects when there are no unprefixed URLs', () => {
    const urls = ['https://x.com/docs/de/intro', 'https://x.com/docs/de/guide'];
    expect(hasStructuralDuplication(urls, 1, 'de')).toBe(false);
  });

  test('rejects when overlap is below 50%', () => {
    const urls = [
      'https://x.com/docs/intro',
      'https://x.com/docs/de/intro',
      'https://x.com/docs/de/guide',
      'https://x.com/docs/de/api',
    ];
    // 1 out of 3 stripped paths matches → 33% < 50%
    expect(hasStructuralDuplication(urls, 1, 'de')).toBe(false);
  });
});

describe('detectLocalePosition', () => {
  test('detects locale position when locale URLs are the majority', () => {
    const urls = [
      'http://x.com/docs/en/intro',
      'http://x.com/docs/en/api',
      'http://x.com/docs/de/intro',
      'http://x.com/docs/de/api',
      'http://x.com/docs/changelog',
    ];
    expect(detectLocalePosition(urls)).toBe(1);
  });

  test('detects minority multi-locale prefixes via structural duplication', () => {
    // 6 unprefixed + 4 localized (40%): below the majority threshold, but
    // stripping each locale code produces paths matching unprefixed URLs.
    const urls = [
      'http://x.com/docs/intro',
      'http://x.com/docs/api',
      'http://x.com/docs/guides',
      'http://x.com/docs/integrations',
      'http://x.com/docs/dashboards',
      'http://x.com/docs/alerts',
      'http://x.com/docs/fr/intro',
      'http://x.com/docs/ja/api',
      'http://x.com/docs/ko/guides',
      'http://x.com/docs/es/integrations',
    ];
    expect(detectLocalePosition(urls)).toBe(1);
  });

  test('detects a single minority locale via structural duplication', () => {
    const urls = [
      'http://x.com/docs/intro',
      'http://x.com/docs/api',
      'http://x.com/docs/guide',
      'http://x.com/docs/de/intro',
      'http://x.com/docs/de/api',
    ];
    expect(detectLocalePosition(urls)).toBe(1);
  });

  test('returns null for minority locale-like codes without structural duplication', () => {
    // "it" is a valid ISO 639-1 code but has no unprefixed twins here.
    const urls = [
      'http://x.com/docs/intro',
      'http://x.com/docs/api',
      'http://x.com/docs/it/service-management',
      'http://x.com/docs/it/asset-tracking',
    ];
    expect(detectLocalePosition(urls)).toBeNull();
  });

  test('returns null when no locale codes appear', () => {
    const urls = ['http://x.com/docs/intro', 'http://x.com/docs/api'];
    expect(detectLocalePosition(urls)).toBeNull();
  });
});

describe('countLocaleCodesAt', () => {
  test('counts lowercased locale codes at a position and ignores other segments', () => {
    const urls = [
      'http://x.com/docs/en-US/intro',
      'http://x.com/docs/en-us/api',
      'http://x.com/docs/fr-fr/intro',
      'http://x.com/docs/intro',
      'http://x.com/docs',
      'not a url',
    ];
    expect(countLocaleCodesAt(urls, 1)).toEqual(
      new Map([
        ['en-us', 2],
        ['fr-fr', 1],
      ]),
    );
  });
});

describe('sameLanguageVariants', () => {
  test('returns only the exact code when present', () => {
    expect(
      sameLanguageVariants(
        'en',
        new Map([
          ['en', 1],
          ['en-us', 9],
        ]),
      ),
    ).toEqual(['en']);
  });

  test('returns every compatible variant ranked by count, then alphabetically', () => {
    const available = new Map([
      ['en-gb', 2],
      ['en-us', 7],
      ['en-au', 2],
      ['fr-fr', 9],
    ]);
    expect(sameLanguageVariants('en', available)).toEqual(['en-us', 'en-au', 'en-gb']);
    expect(sameLanguageVariants('de', available)).toEqual([]);
  });

  test('excludes variants whose script conflicts', () => {
    const available = new Map([
      ['zh-hant', 5],
      ['zh-hans-cn', 1],
      ['zh', 1],
    ]);
    expect(sameLanguageVariants('zh-Hans', available)).toEqual(['zh', 'zh-hans-cn']);
  });
});

describe('resolveLocaleVariant', () => {
  const counts = (entries: [string, number][]) => new Map(entries);

  test('returns the exact code when present, case-insensitively', () => {
    expect(
      resolveLocaleVariant(
        'EN',
        counts([
          ['en', 1],
          ['en-us', 5],
        ]),
      ),
    ).toBe('en');
  });

  test('resolves a bare language to its regional variant (issue #164)', () => {
    expect(
      resolveLocaleVariant(
        'en',
        counts([
          ['en-us', 3],
          ['fr-fr', 3],
        ]),
      ),
    ).toBe('en-us');
  });

  test('resolves a regional preference to the bare language', () => {
    expect(
      resolveLocaleVariant(
        'en-US',
        counts([
          ['en', 3],
          ['fr', 3],
        ]),
      ),
    ).toBe('en');
  });

  test('picks the best-represented variant, then alphabetical on ties', () => {
    expect(
      resolveLocaleVariant(
        'en',
        counts([
          ['en-gb', 2],
          ['en-us', 7],
        ]),
      ),
    ).toBe('en-us');
    expect(
      resolveLocaleVariant(
        'en',
        counts([
          ['en-us', 2],
          ['en-gb', 2],
        ]),
      ),
    ).toBe('en-gb');
  });

  test('requires matching scripts when both sides specify one', () => {
    expect(
      resolveLocaleVariant(
        'zh-Hans',
        counts([
          ['zh-hans-cn', 1],
          ['zh-hant', 9],
        ]),
      ),
    ).toBe('zh-hans-cn');
    expect(resolveLocaleVariant('zh-Hans', counts([['zh-hant', 9]]))).toBeNull();
    expect(
      resolveLocaleVariant(
        'zh',
        counts([
          ['zh-hant', 1],
          ['zh-hans', 1],
        ]),
      ),
    ).toBe('zh-hans');
  });

  test('returns null when no code shares the language', () => {
    expect(
      resolveLocaleVariant(
        'en',
        counts([
          ['es', 1],
          ['fr', 1],
          ['zh', 1],
        ]),
      ),
    ).toBeNull();
    expect(resolveLocaleVariant('en', new Map())).toBeNull();
  });
});
