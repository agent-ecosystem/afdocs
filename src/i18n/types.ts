export type Lang = 'en' | 'zh';

export const SUPPORTED_LANGS: readonly Lang[] = ['en', 'zh'] as const;

export function isLang(value: string): value is Lang {
  return (SUPPORTED_LANGS as readonly string[]).includes(value);
}
