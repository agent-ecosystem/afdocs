# Scoring API

The scoring module is available as a pure function for programmatic consumers. It takes a `ReportResult` from `runChecks` and returns a standalone `ScoreResult` with the overall score, per-category breakdowns, interaction diagnostics, and fix suggestions.

## Compute a score

```ts
import { runChecks, computeScore } from 'afdocs';

const report = await runChecks('https://docs.example.com');
const score = computeScore(report);

console.log(score.overall); // 72
console.log(score.grade); // 'C'
console.log(score.categoryScores);
// { 'content-discoverability': { score: 80, grade: 'B' }, ... }
// Categories may have null score/grade when all checks lack sufficient data
console.log(score.diagnostics); // [{ id: 'markdown-undiscoverable', severity: 'warning', ... }]
console.log(score.resolutions); // { 'llms-txt-directive-html': 'Add a visually-hidden element...' }
```

`computeScore` is a pure function. It does not modify the report or make any network requests. Composition is the consumer's responsibility: the CLI formatters compose `runChecks` and `computeScore`; external consumers call them separately.

## Import from the subpath

You can also import from the dedicated scoring subpath:

```ts
import { computeScore } from 'afdocs/scoring';
```

This is the same function; the subpath is provided for consumers who want a narrower import.

## ScoreResult

`computeScore` returns a `ScoreResult` with these fields:

| Field            | Type                            | Description                                                                                                                           |
| ---------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `overall`        | `number`                        | The overall score (0-100)                                                                                                             |
| `grade`          | `Grade`                         | Letter grade (`A+`, `A`, `B`, `C`, `D`, `F`)                                                                                          |
| `categoryScores` | `Record<string, CategoryScore>` | Per-category score and grade. `score` and `grade` are `null` when all checks in the category are `notApplicable` (insufficient data). |
| `checkScores`    | `Record<string, CheckScore>`    | Per-check scoring details (weight, coefficient, proportion, earned score, scoreDisplayMode)                                           |
| `diagnostics`    | `Diagnostic[]`                  | Interaction diagnostics that fired                                                                                                    |
| `cap`            | `ScoreCap`                      | Score cap that was applied (present only when a cap reduced the score)                                                                |
| `resolutions`    | `Record<string, string>`        | Fix suggestions keyed by check ID                                                                                                     |
| `tagScores`      | `Record<string, TagScore>`      | Per-tag aggregate scores (present when curated pages have tags)                                                                       |

Each `CheckScore` includes a `scoreDisplayMode` field (`"numeric"` or `"notApplicable"`). When automatic page discovery finds fewer than 5 pages, page-level checks are marked `"notApplicable"` and excluded from overall and category score calculations. See [Insufficient data](/agent-score-calculation#insufficient-data) for details.

A `CheckScore` for a multi-page check may also carry `partialSample: true`, meaning bot protection degraded the scan and the check was computed from whatever sample of pages survived. The score still counts; the flag tells you what the number measures. See [Bot protection degrading scan reliability](/interaction-diagnostics#bot-protection-degrading-scan-reliability).

## TagScore

When curated pages have tags, each `TagScore` contains the aggregate score plus a per-check breakdown showing exactly which checks contributed and how each page fared:

| Field       | Type                  | Description                                                    |
| ----------- | --------------------- | -------------------------------------------------------------- |
| `score`     | `number`              | Aggregate score for this tag (0-100)                           |
| `grade`     | `Grade`               | Letter grade                                                   |
| `pageCount` | `number`              | Number of pages tagged with this tag                           |
| `checks`    | `TagCheckBreakdown[]` | Per-check breakdown with weight, proportion, and page statuses |

Each `TagCheckBreakdown` contains:

| Field        | Type                                     | Description                                        |
| ------------ | ---------------------------------------- | -------------------------------------------------- |
| `checkId`    | `string`                                 | The check ID                                       |
| `category`   | `string`                                 | The check's category                               |
| `weight`     | `number`                                 | The check's effective weight in the scoring system |
| `proportion` | `number`                                 | 0-1 proportion earned for this tag's pages         |
| `pages`      | `Array<{ url: string; status: string }>` | Per-page status within this check                  |

```ts
const score = computeScore(report);
if (score.tagScores) {
  for (const [tag, tagScore] of Object.entries(score.tagScores)) {
    console.log(`${tag}: ${tagScore.score}/100 (${tagScore.grade})`);
    for (const check of tagScore.checks) {
      if (check.proportion < 1) {
        const failing = check.pages.filter((p) => p.status === 'fail');
        console.log(`  ${check.checkId}: ${failing.length} failing pages`);
      }
    }
  }
}
```

## Grade conversion

If you need to convert a numeric score to a letter grade independently:

```ts
import { toGrade } from 'afdocs';

toGrade(92); // 'A'
toGrade(100); // 'A+'
toGrade(55); // 'F'
```

## Types

```ts
import type {
  ScoreResult,
  CheckScore,
  CategoryScore,
  TagScore,
  TagCheckBreakdown,
  ScoreCap,
  Diagnostic,
  DiagnosticSeverity, // 'info' | 'warning' | 'critical'
  Grade, // 'A+' | 'A' | 'B' | 'C' | 'D' | 'F'
  ScoreDisplayMode, // 'numeric' | 'notApplicable'
} from 'afdocs';
```

For how the score is calculated (weights, coefficients, caps, proportional scoring), see [Score Calculation](/agent-score-calculation).
