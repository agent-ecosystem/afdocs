# bot-protection-interference: design notes

Implements spec v0.6.0 `bot-protection-interference` and the "Bot Protection
Degrading Scan Reliability" interaction effect. Issue #104. First of the five
v0.6.0 checks merging into `spec-v0.6.0`.

## Invariants

- **No fetch phase of its own.** The check reads `ctx.fetchLedger`, which the
  HTTP client fills for every request in the run. It is registered last so it
  sees every other selected check's traffic. Never add probing traffic to it.
- **Standalone fallback only.** When fewer than 5 requests were observed (the
  check ran alone via `--checks`), it does one ordinary `fetchPage` pass over
  the sampled pages. That is a baseline reading session, not an escalation.
- **Honored 429s are not interference.** The spec's recommended action prefers
  `429` + `Retry-After` over tarpits. The client retries them; a 429 that
  reaches a check is still recorded as outcome `ok` with status 429. The
  existing `rate-limiting-severe` diagnostic covers 429-dominated runs.
- **Plain 401/403/503 are not interference.** Only a challenge signature in
  the body makes a blocked response count; a bare 403 belongs to
  `auth-gate-detection`.
- **Challenge detection is vetoed by content.** Any signature match on an
  HTML body is discarded when `hasSubstantiveContent(analyzeRendering(body))`
  is true, so docs pages about Turnstile/reCAPTCHA are never counted.
  Markdown bodies are never inspected.
- **Stalled URLs are negative-cached per run** in the HTTP client
  (`stalledUrls` in `createHttpClient`). A second fetch of the same URL
  throws `BodyReadTimeoutError` immediately, makes no request, and is not
  recorded in the ledger, so one tarpitted page counts once and costs one
  timeout instead of one per page-level check. Enforcement decays over time,
  so a later run may succeed; that is by design (the run is degraded anyway).
- **Bodies over 100KB are never challenge candidates**
  (`MAX_CHALLENGE_PAGE_LENGTH`). Real interstitials are a few KB; this skips
  the DOM-parse veto on large docs pages that mention a CAPTCHA product.
  Measured: 7 ms per 300KB candidate without the gate, 0.14 ms with it.
- **Network context never carries an IP.** `detectNetworkContext` reads only
  environment variables and reports `developer-machine | ci | cloud` plus the
  indicator name.

## Thresholds (src/checks/authentication/bot-protection-interference.ts)

| Constant                        | Value | Rationale                                                       |
| ------------------------------- | ----- | --------------------------------------------------------------- |
| `MIN_REQUESTS_FOR_EVIDENCE`     | 5     | below this, run the standalone baseline pass                    |
| `SUSTAINED_FAILURE_RATE`        | 0.5   | spec fail = "most requests" after enforcement triggers          |
| `MIN_POST_ONSET_REQUESTS`       | 5     | a tiny post-onset window cannot support "sustained"             |
| `VOLUME_LATE_FAILURE_RATE`      | 0.2   | last third must fail at ≥20% to call failures volume-correlated |
| `VOLUME_RATE_MULTIPLIER`        | 3     | and at ≥3× the first third's rate                               |
| `MIN_LATE_FAILURES`             | 2     | one flaky request late in a short run does not trip it          |
| `MIN_REQUESTS_FOR_VOLUME_TREND` | 6     | need two records per third                                      |
| `PARTIAL_SAMPLE_FAILURE_RATE`   | 0.2   | diagnostic trigger (spec: "for example, above 20%")             |
| `MAX_CHALLENGE_PAGE_LENGTH`     | 100KB | larger bodies skip challenge detection entirely                 |

Onset = first stalled/challenge record; for a purely volume-correlated
pattern, the first failure past the early third.

Verdict: pass when no stalls, no challenges, and not volume-correlated (plain
fetch errors alone are flakiness). Otherwise fail when post-onset failure rate
≥ 0.5 over ≥ 5 requests, or overall failure rate ≥ 0.5; else warn.

## Two triggers for the partial-sample flag

The spec has both: the check's warn/fail (its inverted dependency on every
multi-page check) and the run-level failure rate. `isScanDegradedByBotProtection`
in `src/scoring/diagnostics.ts` honors both and is the single source of truth
for the diagnostic, the `partialSample` flag on `CheckScore`, and the
formatters' notes. `report.requestSummary` exists so the rate trigger works
even when the check was skipped or filtered out.

## Not done in this PR

- `SPEC_VERSION` stays at v0.5.0 until all five v0.6.0 checks land on the
  integration branch.
- No score cap for a failing check. Spec weight is High, not Critical.
- No CLI flag to override the network-context classification.
