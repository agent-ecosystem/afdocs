import { describe, test, expect } from 'vitest';
import {
  isLocaleSegment,
  hasStructuralDuplication,
  detectLocalePosition,
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
