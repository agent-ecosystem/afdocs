# Programmatic API

AFDocs exports its check runner and utilities as a TypeScript API, so you can integrate agent-friendliness checks into your own tools and workflows.

## Run all checks

```ts
import { runChecks } from 'afdocs';

const report = await runChecks('https://docs.example.com');

console.log(report.summary);
// { total: 23, pass: 15, warn: 4, fail: 2, skip: 2, error: 0 }

for (const result of report.results) {
  console.log(`${result.id}: ${result.status} — ${result.message}`);
}
```

`runChecks` throws an `Error` if the options are invalid (see [Validate options](#validate-options) below). On success, it returns a `ReportResult` containing:

- `url` — the URL that was checked
- `timestamp` — when the check ran
- `results` — array of `CheckResult` objects (one per check)
- `summary` — counts by status (pass, warn, fail, skip, error)
- `testedPages` — number of pages tested by page-level checks (present when page discovery ran)
- `samplingStrategy` — the sampling strategy used (`random`, `deterministic`, `curated`, or `none`)

## Run with options

Pass a second argument to configure sampling, concurrency, and thresholds:

```ts
import { runChecks } from 'afdocs';

// Run specific checks (include-list)
const report = await runChecks('https://docs.example.com', {
  checkIds: ['llms-txt-exists', 'llms-txt-valid', 'llms-txt-size'],
  samplingStrategy: 'deterministic',
  maxLinksToTest: 20,
  maxConcurrency: 5,
  requestDelay: 100,
  thresholds: {
    pass: 50000,
    fail: 100000,
  },
});

// Or run all checks except a few (exclude-list)
const skipReport = await runChecks('https://docs.example.com', {
  skipCheckIds: ['markdown-content-parity'],
});

// Or test specific pages with curated sampling
const curatedReport = await runChecks('https://docs.example.com', {
  samplingStrategy: 'curated',
  curatedPages: [
    'https://docs.example.com/quickstart',
    { url: 'https://docs.example.com/api/auth', tag: 'api-reference' },
  ],
});
```

All options are optional. The defaults match the CLI defaults.

### Progress events

Pass an `onProgress` callback to observe each check as it starts and completes. The runner calls it with a `start` event before a check runs and a `complete` event after, carrying the check's 1-based position and the total number of selected checks. The `complete` event also includes the `CheckResult` and the wall-clock duration in milliseconds. The CLI's stderr progress output is built on this callback.

```ts
import { runChecks } from 'afdocs';
import type { CheckProgressEvent } from 'afdocs';

const report = await runChecks('https://docs.example.com', {
  onProgress: (event: CheckProgressEvent) => {
    if (event.phase === 'start') {
      console.error(`[${event.index}/${event.total}] ${event.checkId}...`);
    } else {
      console.error(`  ${event.result.status} in ${event.durationMs}ms`);
    }
  },
});
```

Skipped checks (excluded via `skipCheckIds` or gated by an unmet dependency) still emit both events, with a `skip` result on completion.

## Run a single check

For more control, create a context and run individual checks:

```ts
import { createContext, getCheck } from 'afdocs';

const ctx = createContext('https://docs.example.com');
const check = getCheck('llms-txt-exists')!;
const result = await check.run(ctx);

console.log(result.status); // 'pass', 'warn', 'fail', or 'skip'
console.log(result.message);
```

`createContext` validates the options and throws an `Error` if any are invalid, then sets up the shared state (HTTP client, page cache, previous results) that checks use. If you run multiple checks against the same context, later checks can access the results of earlier ones through `ctx.previousResults`, which is how check dependencies work.

## List available checks

```ts
import { getAllChecks, getChecksSorted } from 'afdocs';

// All checks as a Map<string, CheckDefinition>
const all = getAllChecks();

// Checks in dependency-safe execution order
const sorted = getChecksSorted();
for (const check of sorted) {
  console.log(`${check.id} (${check.category}): ${check.description}`);
}
```

## Validate options

Both `runChecks` and `createContext` validate options and throw on invalid input. If you want to check options before calling either function (for example, to show validation errors in a UI or dry-run mode), use `validateRunnerOptions`:

```ts
import { validateRunnerOptions } from 'afdocs';

const validation = validateRunnerOptions({
  maxConcurrency: -1,
  samplingStrategy: 'curated',
});

if (!validation.valid) {
  for (const error of validation.errors) {
    console.error(`${error.field}: ${error.message}`);
    // maxConcurrency: maxConcurrency must be between 1 and 100, got -1
    // samplingStrategy: Curated sampling requires curatedPages to be non-empty
  }
}
```

`validateRunnerOptions` returns a `ValidationResult` with `errors` and `warnings` arrays. Each entry has a `field` (the option name) and a `message` (human-readable description). The `valid` boolean is `true` when there are no errors.

Validations performed include numeric range checking, threshold ordering (e.g. size pass threshold must be less than or equal to fail threshold), sampling strategy enum validation, and check ID existence.

## Sampling strategies

The valid sampling strategies are available as a constant:

```ts
import { VALID_SAMPLING_STRATEGIES } from 'afdocs';

console.log(VALID_SAMPLING_STRATEGIES);
// ['random', 'deterministic', 'curated', 'none']
```

## Types

The main types you'll work with:

```ts
import type {
  CheckResult,
  CheckStatus, // 'pass' | 'warn' | 'fail' | 'skip' | 'error'
  ReportResult,
  RunnerOptions,
  CheckOptions,
  CheckProgressEvent, // CheckProgressStartEvent | CheckProgressCompleteEvent
  CheckProgressStartEvent,
  CheckProgressCompleteEvent,
  SamplingStrategy, // 'random' | 'deterministic' | 'curated' | 'none'
  AgentDocsConfig,
  CuratedPageEntry,
  PageConfigEntry,
  ValidationResult,
  ValidationIssue,
} from 'afdocs';
```

See the [Scoring API](/reference/scoring-api) for scoring-related types.
