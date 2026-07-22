# Design: Output language (`--lang zh`)

**Date:** 2026-07-22  
**Scope:** Full user-facing output i18n for check `message`, scoring `resolutions`, and `diagnostics` (message + resolution). Not related to `--doc-locale` (URL discovery).

## Goal

`afdocs check <url> --format json --score --lang zh` returns Chinese strings in:

- `results[].message`
- `scoring.resolutions.*`
- `scoring.diagnostics[].message` / `.resolution`

Missing translation keys fall back to English. Default language remains English.

## Approaches considered

1. **Key catalog + `t(key, params)` (chosen)** — Typed keys, `{var}` interpolation, `en`/`zh` catalogs, module lang set from CLI/`AFDOCS_LANG`. Clear fallback, testable, upstream-friendly.
2. **English-string map** — Fragile with interpolated messages; rejected.
3. **Post-process LLM/rules** — Out of scope; c456 already does this via TranslationJob.

## Architecture

```
CLI --lang / AFDOCS_LANG → setLang()
  → runChecks / computeScore / formatters
  → t('check.*' | 'resolution.*' | 'diagnostic.*' | 'runner.*')
  → locales/zh.ts ?? locales/en.ts ?? key
```

- `src/i18n/`: `setLang` / `getLang` / `t` / catalogs
- `RunnerOptions.lang?: 'en' | 'zh'`
- Checks, `resolutions.ts`, `diagnostics.ts`, runner skip/error strings call `t()`
- Existing English unit tests stay green (default `en`)

## Non-goals

- Translating CLI help, validation errors, or stderr progress lines (optional later)
- Changing `--doc-locale` behavior
- Publishing npm release (fork PR only after local verify)
