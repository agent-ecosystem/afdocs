import { afterEach, describe, expect, it } from 'vitest';
import { getLang, setLang, t } from '../../../src/i18n/index.js';

describe('i18n t()', () => {
  afterEach(() => {
    setLang('en');
  });

  it('defaults to English', () => {
    expect(getLang()).toBe('en');
    expect(t('runner.skip_excluded')).toBe('Check skipped (excluded via --skip-checks)');
  });

  it('returns Chinese when lang is zh', () => {
    setLang('zh');
    expect(t('runner.skip_excluded')).toBe('检查已跳过（通过 --skip-checks 排除）');
  });

  it('falls back to English when zh key is missing', () => {
    setLang('zh');
    // Key present only in en catalog
    expect(t('runner.__test_en_only__')).toBe('english-only-fallback');
  });

  it('interpolates {placeholders}', () => {
    setLang('en');
    expect(t('runner.check_error', { error: 'boom' })).toBe('Check error: boom');
    setLang('zh');
    expect(t('runner.check_error', { error: 'boom' })).toBe('检查错误：boom');
  });

  it('returns the key when missing from all catalogs', () => {
    expect(t('does.not.exist')).toBe('does.not.exist');
  });
});
