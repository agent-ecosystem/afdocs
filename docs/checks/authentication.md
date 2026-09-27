# Authentication and Access

Whether agents can reach your documentation at all. Documentation that returns login pages, 401/403 responses, or SSO redirects is completely invisible to agents, and bot-protection systems can produce the same invisibility through a different mechanism. These checks identify the problem and look for alternative access paths.

## auth-gate-detection

Whether documentation pages require authentication to access content.

|            |                                                                                               |
| ---------- | --------------------------------------------------------------------------------------------- |
| **Weight** | Critical (10)                                                                                 |
| **Spec**   | [auth-gate-detection](https://agentdocsspec.com/spec/web/authentication/#auth-gate-detection) |

### Why it matters

Auth-gated documentation is the most absolute barrier for agents. When agents encounter a login page or 401 response, they fall back on potentially outdated training data or seek secondary sources that may not reflect your official documentation or best practices. Competitors with ungated docs provide a better agent experience for their users.

### Results

| Result | Condition                                                                      |
| ------ | ------------------------------------------------------------------------------ |
| Pass   | Documentation pages return content without authentication                      |
| Warn   | Some pages are accessible while others require authentication (partial gating) |
| Fail   | All or most documentation pages require authentication                         |

AFDocs detects several forms of auth gating:

- **HTTP status codes**: 401 (Unauthorized) and 403 (Forbidden) responses.
- **SSO redirects**: Redirects to known SSO providers including Okta, Auth0, Microsoft login, Google Accounts, and Salesforce, plus common SSO subdomain patterns (`sso.`, `idp.`, `auth.`, `login.`).
- **Soft auth gates**: Pages returning 200 but containing login form indicators: password input fields, forms with SAML/OAuth/OpenID action URLs, or page titles starting or ending with "sign in" or "log in". A title alone only counts when the page body has no substantive documentation content (headings, prose, code blocks), so public docs about authentication, such as an API reference for a sign-in endpoint, are not mistaken for a login wall.

### How to fix

**If this check warns**, some of your docs are gated while others are public. This is common for products with tiered documentation. Consider ungating reference docs and API guides, which are the pages agents need most.

**If this check fails**, all or most docs require authentication. Consider:

- Ungating public API references and integration guides
- Providing a public `llms.txt` with links to whatever content can be public
- Shipping documentation with your SDK
- Providing an MCP server for authenticated access

The [Agent-Friendly Documentation Spec](https://agentdocsspec.com/spec/web/) covers options for making private docs agent-accessible, ordered by implementation effort.

### Score impact

This is a Critical check with two score caps:

- At 50%+ pages gated, the score is [capped at D (59)](/agent-score-calculation#score-caps).
- At 75%+ pages gated, the score is [capped at F (39)](/agent-score-calculation#score-caps).

---

## auth-alternative-access

Whether auth-gated sites provide alternative access paths agents can use.

|                |                                                                                                       |
| -------------- | ----------------------------------------------------------------------------------------------------- |
| **Weight**     | Medium (4)                                                                                            |
| **Depends on** | `auth-gate-detection` (warn or fail)                                                                  |
| **Spec**       | [auth-alternative-access](https://agentdocsspec.com/spec/web/authentication/#auth-alternative-access) |

### Why it matters

Sites that must gate their primary documentation can still serve agents through secondary channels. This check gives credit for agent access even when the main docs require login. It only runs when `auth-gate-detection` returns warn or fail; if your docs are public, this check is skipped.

### Results

| Result | Condition                                                                                  |
| ------ | ------------------------------------------------------------------------------------------ |
| Pass   | At least one alternative access path detected                                              |
| Warn   | Partial alternative access (e.g., public `llms.txt` covers only a subset of gated content) |
| Fail   | No alternative access paths detected                                                       |

### What the check detects

AFDocs automatically detects three forms of alternative access:

- **Public `llms.txt`**: Even if underlying docs are gated, a public `llms.txt` gives agents a navigational index.
- **Public markdown**: Pages that serve markdown via `.md` URLs or content negotiation without requiring authentication.
- **Partially accessible pages**: Some documentation pages are publicly accessible while others are gated.

Some alternative access paths can't be detected automatically: bundled SDK documentation, CLI-based doc commands, and MCP servers. These are noted in the check output as requiring manual verification.

### Other alternative access options

If the check fails, these are additional approaches worth considering (even though AFDocs can't detect them):

- **Bundled documentation**: Ship docs in your package/SDK so agents can access them locally.
- **CLI-based doc access**: Provide a CLI command that works with the developer's existing authentication (e.g., `yourproduct docs search "topic"`).
- **MCP server**: Expose documentation through tool calls with server-side authentication.

If you provide any of these, document them on a public page (a setup guide, README, or your `llms.txt` itself) so agents have a chance of discovering the alternative path. An undiscoverable alternative isn't much better than no alternative.

Because AFDocs can't detect these manual paths, you won't get score credit for them even if they're in place. If that's your situation, consider [defining a custom config](/improve-your-score#step-3-work-through-fixes-iteratively) that excludes `auth-alternative-access` so your score reflects the checks you can actually act on.

### How to fix

**If this check fails**, no alternative access paths were detected for your auth-gated content. The lowest-effort option is usually providing a public `llms.txt` that lists whatever documentation can be made available without authentication. See the [Agent-Friendly Documentation Spec](https://agentdocsspec.com/spec/web/) for the full range of options.

**If this check warns**, you have partial alternative access. Expand coverage to include more of the gated documentation, or add additional access paths.

---

## bot-protection-interference

Whether bot-protection systems (CDN bot management, WAF rules, behavioral rate enforcement) interfere with automated fetching of documentation content.

|            |                                                                                                               |
| ---------- | ------------------------------------------------------------------------------------------------------------- |
| **Weight** | High (7)                                                                                                      |
| **Spec**   | [bot-protection-interference](https://agentdocsspec.com/spec/web/authentication/#bot-protection-interference) |

A warn earns credit in proportion to the run's failure rate rather than a flat half: two challenged requests in two hundred cost a fraction of a point, and the credit reaches the 0.5 coefficient only at the failure rate where the verdict would have been fail. See [Score Calculation](/agent-score-calculation#warn-coefficients).

### Why it matters

Coding agents are automated clients. Bot management tuned for scraper and attack traffic frequently cannot distinguish an agent fetching docs on a developer's behalf from abuse, and its enforcement modes are worse for agents than a clean block because the failures are invisible:

- **Challenge interstitials served as 200.** A "verifying your browser" page returned with a success status is a soft 404 from the agent's perspective. The agent extracts challenge boilerplate instead of documentation and may present it as an answer.
- **Tarpits.** The server accepts the connection and returns headers, then holds the response body open indefinitely. The agent's fetch stalls until its own timeout with no error to reason about, and a multi-page reading session dies partway through.
- **Volume-triggered throttling or blocking.** Enforcement engages only after several requests, so the first pages of a session succeed and later ones fail. Because enforcement is typically stateful and decays over time, single-page spot checks look healthy while sustained agent sessions fail.

This is grounded in an observed production case where a CDN's bot management responded to a sustained documentation scan by holding response bodies open. Single-request probes of the same pages looked healthy throughout, and enforcement decayed after a cooldown.

### Results

| Result | Condition                                                                                                                                                               |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pass   | No challenge pages, no stalled response bodies, and no volume-correlated failures were observed during this run                                                         |
| Warn   | Intermittent interference: some requests were challenged, stalled, or blocked while others succeeded, or failures climbed as the scan progressed                        |
| Fail   | Sustained interference: once enforcement triggered, at least half of the remaining requests were challenged, stalled, or failed (or at least half of all requests were) |

### How the check works

Unlike other checks, this one has no fetch phase of its own. AFDocs keeps a ledger of every HTTP request the run makes, attributed to the check that made it, and this check runs last and evaluates that ledger. A full run already resembles a realistic multi-page agent reading session at a respectful cadence, which is the workload the check predicts; AFDocs never escalates traffic to provoke enforcement.

Four signals feed the verdict:

- **Stalled bodies.** The HTTP client reads every body as a stream and treats _no bytes for the request timeout_ as a stall, so a large page on a slow link that keeps making progress is not mistaken for a tarpit. A body that keeps trickling is capped at four times the request timeout. Stalls surface as `Body read timed out after <n>ms (response stalled; server may be rate-limiting or tarpitting automated clients)`. A URL that stalls once is not fetched again during the run: later requests for it fail immediately with the same error, so a tarpitted page costs one timeout rather than one per check that touches it, and counts once in the evidence.
- **Challenge pages.** Fetched HTML bodies under 100KB (real interstitials are a few KB) are matched against signatures in two tiers. Responses with an explicit non-HTML content type (markdown, plain text, JSON, XML) are never inspected, even when they contain raw HTML; only responses with no content type are sniffed. _Artifacts_ only a challenge or block page carries (Cloudflare's challenge element ids and "Just a moment..." or "Attention Required!" titles, Imperva incident strings, PerimeterX and DataDome challenge elements, Akamai reference numbers) are conclusive on their own. _Phrases_ an interstitial says to a human ("verify you are human", "checking your browser", "enable JavaScript and cookies to continue") count only when the page has no substantive documentation content, so a troubleshooting page that quotes them is not mistaken for an interstitial. Vendor SDKs and widgets that protected sites inject into every ordinary page (Cloudflare's JS-detections script, DataDome's tag, Turnstile and reCAPTCHA widgets) are never evidence on their own; they only name the vendor behind a phrase match. Denied responses (403, 503) with an HTML body are inspected even when the check that made the request only wanted the status; the inspection reads at most 100KB, enforced while streaming, and leaves the full body readable for the caller.
- **Denials that climb.** Plain 403 and 503 responses, and 429s with no `Retry-After` header, are recorded as denied. On their own they are not interference: an auth-gated site is 403 from its first request, and that belongs to `auth-gate-detection`. They become evidence only when the denial rate climbs as the scan progresses. When every counted failure is an explicit 429, the verdict is capped at **warn** and the message asks for `Retry-After`: an explicit 429 is an error agents can see and react to, so it does not earn the same grade as a tarpit or a challenge served as 200.
- **Failures that climb.** The ledger is split into thirds. Events are volume-correlated when the last third's rate is at least 20%, at least three times the first third's rate, backed by at least two events, and spread across at least two different checks. The span rule keeps one check's URL class (fabricated 404 probes, `.md` variants) from looking like enforcement engaging. This catches silent blocks (connection resets after N requests) that carry no signature.

Explicit `429` responses that carry any `Retry-After` are never counted, even when the value is longer than the client will wait. The spec prefers them over tarpits and silent blocks because the agent is told how long to back off; the HTTP client already honors `Retry-After` up to 60 seconds, and the [severe rate limiting](/interaction-diagnostics#severe-rate-limiting) diagnostic covers the case where 429s dominate.

The verdict is **fail** when, from the first interference event onward, at least half of the remaining requests were challenged, stalled, denied, or failed, over a window of at least ten requests with at least five failures; or when at least half of all requests (and at least five) were. A short cluster of stalls at the very tail of a run is the onset signature, but the run ended before it could show whether enforcement stayed engaged, so that is a **warn**. Any other interference is **warn**.

A **pass** on fewer than 50 requests says so ("limited evidence"), because it is weak evidence of absence: discovery probes alone account for about 20 requests, so a run that found one page still makes about 22. When the check runs alone (`--checks bot-protection-interference`), there is no traffic to evaluate, so it performs one ordinary pass over the sampled pages first; the details report `standaloneScan: true`.

### Network context

Bot enforcement is commonly keyed to client reputation (IP range, ASN, TLS fingerprint), so a scan run from CI or cloud infrastructure may trigger enforcement that residential traffic would not. That mirrors real agent traffic: some harnesses fetch from the developer's own connection, while others route fetches through vendor servers or cloud-hosted sessions. A datacenter-origin scan is representative of the second class, not a false positive.

AFDocs classifies the scan's vantage point from environment variables as a developer machine, CI infrastructure, or cloud infrastructure, and reports the classification with the results (`networkContext` on the report and in the check details, "Scanned from ..." in the scorecard). Pass `--network-context <developer-machine|ci|cloud>` (or `networkContext` in the config file) when the detection is wrong for your setup, for example a container on a developer laptop that sets `CI=true`. It never records the scanner's IP address, since reports are often shared.

### Caveats

Detection is heuristic and enforcement is stateful. A pass means no interference was observed during this run, not that bot protection will never engage, and results legitimately vary across runs and vantage points. When the check warns or fails, every multi-page check is flagged as computed from a partial sample, as the spec requires; the details list the checks that actually made requests during the interference window as `affectedChecks` so a reader can tell which results the enforcement touched. See [Bot protection degrading scan reliability](/interaction-diagnostics#bot-protection-degrading-scan-reliability).

This check is distinct from `robots.txt` and AI user-agent blocking, which the spec intentionally excludes. Declared crawling policy is invisible to most coding agents because they don't identify themselves; behavioral enforcement affects them precisely because their traffic is indistinguishable from the automated traffic it targets.

### How to fix

**If this check warns**, identify which bot-management layer is challenging or stalling some requests and exempt public documentation routes from behavioral enforcement. Intermittent interference means enforcement thresholds sit close to normal agent reading cadence, so small configuration changes (or ordinary traffic growth) can tip it into sustained blocking.

**If this check fails**, treat public documentation paths as automation-friendly in your bot-management configuration. Exempt docs routes from behavioral enforcement, or scope enforcement to interactive product surfaces. Where limits are genuinely needed, prefer an explicit `429` with `Retry-After` over tarpits or silent blocks: a `429` is an error the agent can see, report, and react to, while a tarpit or challenge page fails invisibly. Never serve challenge interstitials with a 200 status.

This check identifies the condition; it does not prescribe that sites disable bot protection. Like auth gating, this is a tradeoff to make deliberately, with awareness that coding agents are among the clients being blocked.
