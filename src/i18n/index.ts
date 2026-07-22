import type { Lang } from './types.js';
import { isLang } from './types.js';
import { en } from './locales/en.js';
import { zh } from './locales/zh.js';

const catalogs: Record<Lang, Record<string, string>> = { en, zh };

let currentLang: Lang = 'en';

export type { Lang } from './types.js';
export { SUPPORTED_LANGS, isLang } from './types.js';

export function getLang(): Lang {
  return currentLang;
}

export function setLang(lang: Lang): void {
  currentLang = lang;
}

/**
 * Resolve a language code from CLI/env/options.
 * Unknown or empty values fall back to English.
 */
export function resolveLang(value?: string | null): Lang {
  if (!value) return 'en';
  const normalized = value.trim().toLowerCase();
  // Accept zh-CN / zh_Hans style tags as zh
  if (normalized === 'zh' || normalized.startsWith('zh-') || normalized.startsWith('zh_')) {
    return 'zh';
  }
  if (isLang(normalized)) return normalized;
  return 'en';
}

export type TParams = Record<string, string | number | boolean | undefined | null>;

/**
 * Look up a message key in the active language catalog.
 * Missing keys fall back to English, then to the key itself.
 */
export function t(key: string, params?: TParams): string {
  const msg = catalogs[currentLang][key] ?? catalogs.en[key] ?? key;
  return params ? interpolate(msg, params) : msg;
}

export function pageLabel(sampled: boolean): string {
  return t(sampled ? 'common.sampled_pages' : 'common.pages');
}

export function linkLabel(sampled: boolean): string {
  return t(sampled ? 'common.sampled_links' : 'common.links');
}

/** Build common fetch/rate-limit suffixes used by many checks. */
export function resultSuffix(opts: { fetchErrors?: number; rateLimited?: number }): string {
  let suffix = '';
  if ((opts.fetchErrors ?? 0) > 0) {
    suffix += t('common.fetch_errors_suffix', { count: opts.fetchErrors });
  }
  if ((opts.rateLimited ?? 0) > 0) {
    suffix += t('common.rate_limited_suffix', { count: opts.rateLimited });
  }
  return suffix;
}

function interpolate(template: string, params: TParams): string {
  return template.replace(/\{(\w+)\}/g, (_, name: string) => {
    const value = params[name];
    if (value === undefined || value === null) return `{${name}}`;
    return String(value);
  });
}
