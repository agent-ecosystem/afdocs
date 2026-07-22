# Output `--lang zh` Implementation Plan

> **For agentic workers:** Execute task-by-task with TDD. Steps use checkbox syntax.

**Goal:** Full Chinese user-facing output via `--lang zh` / `AFDOCS_LANG` for check messages, resolutions, and diagnostics.

**Architecture:** Key catalog + `t(key, params)` with `{var}` interpolation; `setLang` from CLI/env; missing zh keys fall back to en.

**Tech Stack:** TypeScript, Vitest, Commander CLI.

## Global Constraints

- Do not change `--doc-locale` behavior.
- Default lang remains `en`; existing English tests must stay green.
- Do not open a GitHub PR without explicit confirmation.

---

### Task 1: i18n core + failing tests

**Files:**

- Create: `src/i18n/index.ts`, `src/i18n/locales/en.ts`, `src/i18n/locales/zh.ts`
- Test: `test/unit/i18n/t.test.ts`

- [ ] Write failing tests for `t()`, fallback, interpolation, `setLang`
- [ ] Implement minimal `t` / catalogs
- [ ] Commit

### Task 2: CLI + runner wiring

**Files:**

- Modify: `src/types.ts`, `src/runner.ts`, `src/cli/commands/check.ts`
- Test: `test/unit/i18n/lang-wiring.test.ts`, extend `test/integration/cli.test.ts`

- [ ] Add `RunnerOptions.lang`, `--lang`, `AFDOCS_LANG`
- [ ] `runChecks` calls `setLang` for the run
- [ ] Integration: `--lang zh` JSON contains Chinese

### Task 3: Localize resolutions + diagnostics

**Files:**

- Modify: `src/scoring/resolutions.ts`, `src/scoring/diagnostics.ts`
- Extend catalogs; keep existing resolution/diagnostic tests green under `en`

### Task 4: Localize all check + runner messages

**Files:**

- Modify: all `src/checks/**/*.ts`, `src/runner.ts`
- Catalogs cover every `message:` template

### Task 5: Verify + commit

- [ ] `npm test` / `npm run lint`
- [ ] Local commit on `feat/output-lang-zh`
