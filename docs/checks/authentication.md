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

Whether the systems that protect a site from unwanted automated traffic (CDN bot management, web application firewalls, rate limiting) got in the way of fetching documentation during the run.

|            |                                                                                                               |
| ---------- | ------------------------------------------------------------------------------------------------------------- |
| **Weight** | High (7)                                                                                                      |
| **Spec**   | [bot-protection-interference](https://agentdocsspec.com/spec/web/authentication/#bot-protection-interference) |

### Why it matters

Coding agents are automated clients. Protection tuned for scrapers and attacks often cannot tell an agent fetching docs on a developer's behalf from abuse, and the ways it pushes back are worse for agents than a plain block, because the failures are invisible:

- **Challenge pages served as success.** A "verifying your browser" page returned with a 200 status is a [soft 404](/glossary#soft-404) from the agent's point of view. The agent reads the challenge text instead of documentation and may present it as an answer.
- **[Tarpits](/glossary#tarpit).** The server accepts the request and then holds the response open without sending the page. The agent waits until its own timeout with no error to reason about, and a multi-page reading session dies partway through.
- **Blocking that starts after a few requests.** Enforcement engages only once a client has made several requests, so the first pages of a session succeed and later ones fail. Because it is usually stateful and wears off over time, a one-page spot check looks healthy while a sustained agent session fails.

This is grounded in an observed production case where a CDN's bot management responded to a sustained documentation scan by holding response bodies open. Single-request probes of the same pages looked healthy throughout, and enforcement decayed after a cooldown.

### Results

| Result | Condition                                                                                                                                                               |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pass   | No challenge pages, no stalled responses, and no failures that grew as the run went on                                                                                  |
| Warn   | Intermittent interference: some requests were challenged, stalled, or blocked while others succeeded, or failures climbed as the scan progressed                        |
| Fail   | Sustained interference: once enforcement triggered, at least half of the remaining requests were challenged, stalled, or failed (or at least half of all requests were) |

A warn earns credit in proportion to the run's failure rate rather than a flat half: two challenged requests in two hundred cost a fraction of a point, and the credit only drops to the 0.5 coefficient at the failure rate where the verdict would have been fail. See [Score Calculation](/agent-score-calculation#warn-coefficients).

### How the check works

This check makes no requests of its own. AFDocs records every request the other checks make, and this check runs last and reads that record. A full run already looks like a realistic multi-page agent reading session at a polite pace, which is exactly the traffic pattern the check is predicting; AFDocs never sends extra traffic to provoke enforcement.

Four kinds of evidence feed the verdict:

- **Stalled responses.** A response that stops sending data for longer than the request timeout counts as a stall. A large page on a slow connection that keeps arriving does not. A page that stalls once is not requested again during the run, so it counts once.
- **Challenge pages.** HTML responses are matched against the known fingerprints of challenge and block pages from the major bot-protection vendors, and against the phrases those pages show to people ("verify you are human", "checking your browser"). Phrases only count when the page has no real documentation on it, so a troubleshooting page that quotes them is not mistaken for a challenge.
- **Denials that climb.** Plain 403 and 503 responses, and 429 responses with no `Retry-After` header, are recorded as denials. On their own they are not interference: a site that requires login is 403 from its first request, and `auth-gate-detection` covers that. They count only when the denial rate rises as the scan progresses. When every counted failure is an explicit 429, the verdict is capped at **warn** and the message asks for `Retry-After`: an explicit rate limit is an error agents can see and react to, so it does not grade like a tarpit or a challenge served as success.
- **Failures that climb.** Failures of any kind that are rare early in the run and common late in it, across more than one check, indicate enforcement engaging. This catches silent blocks (connections dropped after some number of requests) that carry no fingerprint.

A 429 that carries a `Retry-After` header is never counted, even when the wait is longer than AFDocs will honor. The spec prefers explicit rate limiting over tarpits and silent blocks because the agent is told how long to back off; the [severe rate limiting](/interaction-diagnostics#severe-rate-limiting) diagnostic covers the case where 429s dominate a run.

The verdict is **fail** when, from the first sign of interference onward, at least half of the remaining requests were challenged, stalled, denied, or failed (over at least ten requests), or when at least half of all requests were. A short cluster of stalls at the very end of a run is a **warn**: it looks like enforcement starting, but the run ended before it could show whether enforcement stayed on. Any other interference is a **warn**.

A **pass** on fewer than 50 requests says so ("limited evidence"), because a short run is weak evidence of absence. When the check runs alone (`--checks bot-protection-interference`), there is no other traffic to evaluate, so it performs one ordinary pass over the sampled pages first.

The exact thresholds and fingerprints are documented in [the check's source](https://github.com/agent-ecosystem/afdocs/blob/main/src/checks/authentication/bot-protection-interference.ts).

### Network context

Bot protection often decides based on where traffic comes from and what kind of client it looks like, so a scan run from CI or a cloud server may trigger enforcement that a developer's laptop would not. That mirrors real agent traffic: some agent tools fetch from the developer's own connection, while others fetch from the vendor's servers or from cloud-hosted sessions. A scan from a datacenter represents the second kind of agent, not a false alarm.

AFDocs works out where it is running from (a developer machine, CI, or cloud infrastructure) using environment variables, and reports that with the results ("Scanned from ..." in the scorecard, `networkContext` in the report). Pass `--network-context <developer-machine|ci|cloud>` (or `networkContext` in the config file) when the detection is wrong for your setup, for example a container on a laptop that sets `CI=true`. AFDocs never records the scanner's IP address, since reports are often shared.

### Caveats

Detection is heuristic and enforcement is stateful. A pass means no interference was observed during this run, not that bot protection will never engage, and results legitimately vary between runs and vantage points. When the check warns or fails, every multi-page check is flagged as computed from a partial sample, as the spec requires; the check details list which checks were making requests during the interference window (`affectedChecks`), so a reader can tell which results were touched. See [Bot protection degrading scan reliability](/interaction-diagnostics#bot-protection-degrading-scan-reliability).

This check is distinct from `robots.txt` and AI user-agent blocking, which the spec intentionally excludes. A declared crawling policy is invisible to most coding agents because they don't identify themselves; behavioral enforcement affects them precisely because their traffic is indistinguishable from the automated traffic it targets.

### How to fix

**Who owns this.** Bot protection is configured by whoever runs your CDN, web application firewall, or hosting platform, usually a platform, infrastructure, or security team rather than the documentation team. Hand them this check's output: the verdict, the kinds of interference seen, and the "Scanned from" line, which tells them what kind of client was affected.

**If this check warns**, ask that team to find which layer is challenging or stalling some requests and to exempt public documentation routes from behavioral enforcement. Intermittent interference means the enforcement threshold sits close to a normal agent reading pace, so a small configuration change, or ordinary growth in traffic, can tip it into sustained blocking.

**If this check fails**, ask for public documentation paths to be treated as automation-friendly: exempt docs routes from behavioral enforcement, or limit enforcement to interactive product surfaces such as sign-in and checkout. Where limits are genuinely needed, an explicit `429` with a `Retry-After` header is better than a tarpit or a silent block, because it is an error the agent can see, report, and react to. Challenge pages should never be served with a 200 status.

This check identifies the condition; it does not prescribe that sites disable bot protection. Like requiring login, this is a tradeoff to make deliberately, knowing that coding agents are among the clients being blocked.
