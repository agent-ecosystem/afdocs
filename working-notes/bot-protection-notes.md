# bot-protection-interference: design notes

Implements spec v0.6.0 `bot-protection-interference` and the "Bot Protection
Degrading Scan Reliability" interaction effect. Issue #104. First of the five
v0.6.0 checks merging into `spec-v0.6.0`.

## Invariants

- **No fetch phase of its own.** The check reads `ctx.fetchLedger`, which the
  HTTP client fills for every request in the run, stamped with the check that
  made it (`FetchLedger.currentCheckId`, set by the runner). It is registered
  last so it sees every other selected check's traffic. Never add probing
  traffic to it.
- **Standalone fallback only.** When fewer than 5 requests were observed (the
  check ran alone via `--checks`), it does one ordinary `fetchPage` pass over
  the sampled pages. That is a baseline reading session, not an escalation.
  In standalone mode the cross-check span rule is waived (every request is
  this check's).
- **Stall = idle, not slow.** `readStreamedBody` in `src/http.ts` reads the
  body as a stream and re-arms an idle timer on every chunk; "no bytes for
  `requestTimeout`" is a stall. A total cap of `BODY_TOTAL_TIMEOUT_MULTIPLIER`
  (4) × `requestTimeout` catches a deliberate trickle. Response doubles with
  no `body` stream fall back to a total-time guard around `text()`.
- **Stalled URLs are negative-cached per run** (`stalledUrls` in
  `createHttpClient`). A second fetch of the same URL throws
  `BodyReadTimeoutError` immediately, makes no request, and is not recorded
  in the ledger, so one tarpitted page counts once and costs one timeout
  instead of one per page-level check. Enforcement decays over time, so a
  later run may succeed; that is by design (the run is degraded anyway).
- **Signatures are tiered.** Artifacts only an interstitial/block page carries
  are conclusive and never vetoed (so Cloudflare's block page, which has
  headings and prose, is still caught). Phrases are vetoed by
  `hasSubstantiveContent`. Vendor SDK/tag/widget markers (Cloudflare
  `/cdn-cgi/challenge-platform/` JS detections, Imperva `_Incapsula_Resource`,
  DataDome tag, PerimeterX client, AWS WAF integration, Turnstile/reCAPTCHA
  widgets) are injected into every ordinary page of a protected site and are
  never evidence on their own; a Next.js shell behind Cloudflare Bot
  Management would otherwise fail the check on every page. Markdown bodies
  and bodies over `MAX_CHALLENGE_PAGE_LENGTH` (100KB) are never inspected.
- **Denied responses are inspected eagerly.** A 403/503 (or unhonored 429)
  with an HTML body under 100KB is read by the client itself so the ledger
  can look for a challenge signature even when the caller only wanted the
  status. Larger bodies are left to the caller.
- **Guided 429s are not interference; unguided ones cap at warn.** The
  spec's recommended action prefers `429` + `Retry-After` over tarpits. A
  429 carrying any Retry-After (even one longer than the client will wait)
  is recorded as `ok` with `retryAfter` set. A 429 with no header, and plain
  403/503, are recorded as `blocked` and count only when the denial rate
  climbs during the run (`blockTrend`). When every counted failure is an
  explicit 429 (`visibleOnly`), the verdict is capped at warn: it is visible
  to agents, unlike a tarpit, so it must not grade like one. An auth-gated
  site is 403 from the first request and belongs to `auth-gate-detection`.
- **Partial-sample flags are attributed.** `details.affectedChecks` lists
  the checks with at least one request at or after onset. Scoring and the
  formatters flag only those (`getPartialSampleChecks`); the spec's literal
  "every multi-page check" is what happens when only the rate trigger fired
  and there is no onset to attribute to. Field data: val.town's two
  challenged requests at #202-203 affected one check, not sixteen.
- **Trends need a span.** Outside standalone mode, the late-third events
  must come from ≥ `MIN_CHECKS_SPANNED` (2) distinct checks, so one check's
  URL class (fabricated 404 probes, `.md` variants) cannot look like
  enforcement engaging. Order in the ledger is check order, not pure volume;
  the span rule is what makes the trend mean "across the scan".
- **Network context never carries an IP.** `detectNetworkContext` reads only
  environment variables and reports `developer-machine | ci | cloud` plus the
  indicator name, with `source: 'environment'`. `--network-context` /
  `options.networkContext` overrides it with `source: 'option'`.

## Thresholds (src/checks/authentication/bot-protection-interference.ts)

| Constant                        | Value | Rationale                                                     |
| ------------------------------- | ----- | ------------------------------------------------------------- |
| `MIN_REQUESTS_FOR_EVIDENCE`     | 5     | below this, run the standalone baseline pass                  |
| `LIMITED_EVIDENCE_REQUESTS`     | 20    | a pass on fewer requests says "limited evidence"              |
| `SUSTAINED_FAILURE_RATE`        | 0.5   | spec fail = "most requests" after enforcement triggers        |
| `MIN_POST_ONSET_REQUESTS`       | 10    | a tail cluster cannot show enforcement stayed engaged         |
| `MIN_POST_ONSET_FAILURES`       | 5     | and needs an absolute count, not just a rate                  |
| `VOLUME_LATE_FAILURE_RATE`      | 0.2   | last third must fail at ≥20% to call events volume-correlated |
| `VOLUME_RATE_MULTIPLIER`        | 3     | and at ≥3× the first third's rate                             |
| `MIN_LATE_FAILURES`             | 2     | one flaky request late in a short run does not trip it        |
| `MIN_REQUESTS_FOR_VOLUME_TREND` | 6     | need two records per third                                    |
| `MIN_CHECKS_SPANNED`            | 2     | late events must come from two checks (waived standalone)     |
| `PARTIAL_SAMPLE_FAILURE_RATE`   | 0.2   | diagnostic trigger (spec: "for example, above 20%")           |
| `MIN_REQUESTS_FOR_RATE_TRIGGER` | 20    | the rate trigger needs a sample worth a percentage            |
| `MAX_CHALLENGE_PAGE_LENGTH`     | 100KB | larger bodies skip challenge detection entirely               |
| `BODY_TOTAL_TIMEOUT_MULTIPLIER` | 4     | total body-read cap, in units of `requestTimeout`             |

Onset = first stalled/challenge record; for a purely trend-based pattern,
the first failure past the early third.

Verdict: pass when no stalls, no challenges, and no correlated trend (plain
fetch errors and steady 403s alone are flakiness and auth gating). Otherwise
fail when the post-onset window has ≥ 10 requests, ≥ 5 failures and a
failure rate ≥ 0.5, or the whole run has ≥ 5 failures at a rate ≥ 0.5; else
warn.

## Known limits (accepted, documented)

- Challenge pages on 2xx are only seen when a check reads the body; denied
  responses are read eagerly, so the "served as 200" count is biased toward
  what checks look at.
- A warn on two stalls in four hundred requests still flags every multi-page
  check as a partial sample. That is what the spec's inverted dependency
  says; the diagnostic message carries the percentage so readers can judge.
- Thresholds were reasoned first and then checked against one field run
  (below); they are not fitted to a large corpus. Revisit when parity runs
  produce more interference data.

## Field data (2026-09-26, one deterministic run per site, 20 pages, 200 ms)

33 sites: the 20-site parity corpus plus 13 large vendor docs sites behind
Akamai, Cloudflare, Imperva, or Fastly. Ledgers saved locally; re-scored
offline after each tuning change rather than re-running against the sites.

| Site                     | Requests | Outcome | What happened                                                                                                                                 |
| ------------------------ | -------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| 30 sites                 | 166–698  | pass    | zero stalls, challenges, or denials; no trend fired (includes developers.cloudflare.com, which carries Cloudflare's JSD script on every page) |
| apple, oracle, anthropic | 22–24    | pass    | discovery found ≤1 page; "limited evidence" (drove the floor from 20 to 50)                                                                   |
| docs.github.com          | 238      | warn    | after #182, 57/57 remaining requests 429 with no Retry-After, across 4 checks; was fail before the visible-only cap                           |
| docs.gitlab.com          | 288      | warn    | 44 Cloudflare challenge pages (403) on every `.md` URL and fabricated path from request #2; HTML pages fine; 13 checks affected               |
| docs.val.town            | 215      | warn    | 2 × 429 carrying a Cloudflare challenge body at #202–203, then recovery; 1 check affected; the page returned 200 minutes later                |
| learn.microsoft.com      | 651      | n/a     | run hit the 12-minute cap inside sitemap discovery (651 × 200); a discovery problem, not interference                                         |

Takeaways: no false positives on clean sites at these thresholds; the
vendor-marker tier was necessary (Cloudflare's own docs would otherwise
have failed); explicit rate limiting is common enough (GitHub) that it
needed its own grade; attribution turned val.town's warn from a scorecard
full of "(partial sample)" into one flagged check.

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
