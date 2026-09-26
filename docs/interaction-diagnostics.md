# Interaction Diagnostics

Some problems only become visible when you look at multiple checks together. The scorecard surfaces these as **interaction diagnostics**: system-level findings that emerge from combinations of check results.

These diagnostics appear in the "Interaction Diagnostics" section of the `--format scorecard` output and as entries in the `diagnostics` array of the scoring API response.

## Markdown support is undiscoverable

**Triggers when** your site serves markdown at `.md` URLs, but there is no agent-facing directive on HTML pages pointing to llms.txt and the server does not support content negotiation.

**What it means**: You've done the work to support markdown, but agents have no way to find out. They'll default to the HTML path every time. In observed agent behavior, agents do not independently discover `.md` URL variants; they need to be told.

**What to do**: Add a [directive](/checks/content-discoverability#llms-txt-directive-html) on your docs pages pointing to llms.txt, and implement [content negotiation](/checks/markdown-availability#content-negotiation) for `Accept: text/markdown`. The directive is the primary discovery mechanism because it reaches all agents; content negotiation provides a fast path for agents that request markdown by default. Both are recommended.

**Score impact**: Markdown quality checks (`page-size-markdown`, `markdown-code-fence-validity`, `markdown-content-parity`) are excluded from the score entirely when this diagnostic fires, because their results don't reflect real agent experience.

## Markdown support is only partially discoverable

**Triggers when** your site serves markdown at `.md` URLs and supports content negotiation, but there is no agent-facing directive on HTML pages pointing to llms.txt.

**What it means**: Agents that send `Accept: text/markdown` (Claude Code, Cursor, OpenCode) get markdown automatically, but the majority of agents fetch HTML by default and have no signal that a markdown path exists. Your markdown support benefits a subset of agents but not most of them.

**What to do**: Add a [directive](/checks/content-discoverability#llms-txt-directive-html) near the top of each HTML page pointing to your llms.txt. If your site serves markdown, mention that in the directive too. The directive reaches all agents, not just the ones that request markdown by default.

**Score impact**: Same as the undiscoverable case: markdown quality checks are excluded from the score because most agents still can't find the markdown path.

## Truncated index

**Triggers when** your llms.txt exists but exceeds agent context limits (the `llms-txt-size` check warns or fails).

**What it means**: Agents see roughly the first 50K–100K characters of your llms.txt. Everything beyond that point (links, structure, descriptions) is invisible to agents. Quality checks on the truncated portion are discounted in the score.

**What to do**: Split into a root llms.txt that links to section-level llms.txt files, each under 50,000 characters. The [llms-txt-size check](/checks/content-discoverability#llms-txt-size) details the thresholds.

**Score impact**: The index truncation coefficient scales down `llms-txt-links-resolve`, `llms-txt-valid`, `llms-txt-coverage`, and `llms-txt-links-markdown` proportionally. A file that's twice the limit counts those checks at roughly half weight.

## SPA shells invalidate HTML path

**Triggers when** more than 25% of sampled pages are detected as actual SPA shells: pages where the HTML response contains a framework root element (such as `id="__next"` or `id="root"`) but no documentation content.

**What it means**: When humans visit the page in a browser, JavaScript loads the content. Agents don't visit a page in a browser, so they never see the content, only the shell. Page size and content structure scores for the HTML path are discounted because they're partially measuring shells, not actual content.

**What to do**: Enable server-side rendering or static generation for documentation pages. If only specific page templates use client-side content loading, target those templates. The [rendering-strategy check](/checks/page-size#rendering-strategy) explains how AFDocs detects SPA shells.

**Score impact**: The HTML path coefficient scales `page-size-html`, `content-start-position`, `tabbed-content-serialization`, and `section-header-quality` in proportion to the fraction of pages that render correctly. If 60% of pages are SPA shells, these checks count for 40% of their weight. At 50%+ SPA shells, the overall score is also [capped at D or F](/agent-score-calculation#score-caps).

## Sparse content on the HTML path

**Triggers when** more than 25% of sampled pages render server-side but have unusually short body content, AND the SPA-shells diagnostic is not also firing. (When both conditions hold, the SPA-shells diagnostic takes precedence to avoid double-reporting; its resolution covers both.)

**What it means**: The HTML response contains real content (headings and visible text) but less than the threshold for a typical documentation page. This is often legitimate (short reference pages, integration one-liners, glossary entries) and not actually a problem. It can also indicate a renderer that hydrates paragraphs, lists, or code blocks client-side rather than emitting them in the initial HTML, in which case agents would miss the hydrated content.

**What to do**: Spot-check a few of the affected pages by fetching them with `curl` (or any HTTP client that doesn't run JavaScript) and confirm the full content is present. If the pages are intentionally brief, no action is needed. If content is missing from the server response, investigate your renderer's server-side output for paragraphs, lists, and code blocks.

**Score impact**: The HTML path coefficient is discounted for sparse pages at half the rate of full SPA shells. Sparse pages do not contribute to the score cap.

## No viable path to content

**Triggers when** there's no working llms.txt (missing or nearly all links broken), no server-rendered HTML, and no discoverable markdown path.

**What it means**: Agents have no effective way to access your documentation. They will fall back on training data or secondary sources, both of which may be inaccurate or outdated.

**What to do**: If your site uses client-side rendering, enable server-side rendering. The second highest-impact action is creating an llms.txt at your site root with working links, ideally pointing to markdown pages. See [Improve Your Score](/improve-your-score) for a prioritized fix list.

**Score impact**: Caps the overall score at 39 (F).

## Auth-gated with no alternative

**Triggers when** all documentation requires authentication and no alternative access paths exist (the `auth-gate-detection` check fails and `auth-alternative-access` also fails).

**What it means**: Agents that encounter your docs will hit a login wall and fall back on training data or secondary sources.

**What to do**: Consider providing a public llms.txt with links to ungated content, removing auth gates from API references and integration guides, or shipping documentation with your SDK. The [auth-alternative-access check](/checks/authentication#auth-alternative-access) covers the options.

**Score impact**: Caps the overall score. If 75%+ of pages are gated with no alternatives, the cap is 39 (F). At 50%+, it's 59 (D).

## Pages exceed size limits with no markdown escape

**Triggers when** HTML pages exceed agent truncation limits and there's no discoverable markdown path that could offer smaller representations.

**What it means**: Agents will silently receive truncated content on oversized pages, with no alternative path to the full content.

**What to do**: Either reduce HTML page sizes (break large pages into smaller ones, reduce navigation boilerplate) or provide markdown versions and make them discoverable via content negotiation or llms.txt links. See [Page Size checks](/checks/page-size) for the specific thresholds.

**Score impact**: No direct score cap, but the combination of failing page-size checks with no markdown alternative typically results in low category scores for both Page Size and Markdown Availability.

## Bot protection degrading scan reliability

**Triggers when** the [`bot-protection-interference`](/checks/authentication#bot-protection-interference) check warns or fails, or when at least 20% of the HTTP requests made during the run failed or timed out (stalled bodies, challenge pages, or connection errors). The rate trigger needs at least 20 requests, so two failed discovery probes in a short subset run do not count as a degraded scan.

**What it means**: Behavioral bot enforcement engaged partway through the scan. Requests that would have succeeded in isolation began to stall, get challenged, or fail, and every check still running scored whatever sample survived. The site's scores can look reasonable while being computed from a fraction of the intended pages. Per-check "failed to fetch" counts are scattered and easy to miss, so this diagnostic aggregates them at run level.

This pattern has two victims. Agents doing multi-page reading sessions lose access mid-session, which is the site-side problem the check exists to surface. And the assessment itself degrades: a flagged run is still useful evidence; it just measures a smaller sample than it appears to.

**What to do**: Treat the scores as measuring a smaller sample. Behavioral enforcement is stateful and decays, so re-run after a cooldown or from a different network vantage point (the scorecard reports whether the scan ran from a developer machine, CI, or cloud infrastructure), and raise `--request-delay` if the cadence is yours to control. For the site-side fix, see the check: exempt public documentation routes from behavioral bot enforcement.

**Score impact**: No coefficient or cap. Multi-page checks keep their earned scores but are flagged as computed from a partial sample: `(partial sample)` after each affected check in the scorecard, a note under each in `--format text`, and `partialSample: true` on the check's entry in the scoring API's `checkScores`. When the check itself warned or failed, only the checks that made requests during the interference window are flagged (the ledger attributes every request to its check); a check that finished before enforcement engaged measured the full sample. When only the run-level failure rate triggered the diagnostic, every multi-page check is flagged.

## Single-page sample

**Triggers when** automatic page discovery (`random` or `deterministic` sampling) found fewer than 5 pages to test.

**What it means**: Page-level category scores (Page Size, Content Structure, URL Stability, etc.) are based on too few pages to be representative. These categories are marked as N/A in the score rather than showing potentially misleading numbers.

**What to do**: If your site has an llms.txt, ensure it contains working links so the tool can discover more pages. If testing a preview deployment, use `--canonical-origin` to rewrite cross-origin llms.txt links. You can also provide specific pages with `--urls` to test exactly the pages you care about.

This diagnostic does not fire when you explicitly choose pages with `--urls`, `--sampling curated`, or `--sampling none`.

**Score impact**: Page-level checks are excluded from the overall score and their categories show as N/A. Only site-level checks (llms.txt checks, coverage, auth-alternative-access) contribute to the score, and the overall score is capped at 59 (D) so a narrow signal can't produce a misleadingly high grade.

## All llms.txt links are cross-origin

**Triggers when** every link in your llms.txt points to a different origin than the one being tested.

**What it means**: This typically happens when testing a preview or staging deployment whose llms.txt still references the production domain. The tool filters cross-origin links during page discovery, so it falls back to testing a single page. You'll usually see this alongside the [single-page sample](#single-page-sample) diagnostic.

**What to do**: Use `--canonical-origin <production-origin>` to rewrite cross-origin links during testing. For example: `npx afdocs check https://preview.example.com --canonical-origin https://docs.example.com`.

**Score impact**: Indirect. By reducing discovered pages to one, it triggers the single-page sample behavior described above.

## Gzipped sitemap skipped

**Triggers when** a gzipped sitemap (e.g. `sitemap.xml.gz`) was encountered during URL discovery and skipped because gzipped sitemaps are not yet supported.

**What it means**: If the gzipped sitemap is the only sitemap source, URL discovery may have found fewer pages than expected. This can reduce the representativeness of page-level check results.

**What to do**: Provide an uncompressed `sitemap.xml` alongside the gzipped version, or supply specific pages via `--urls` for targeted testing.

**Score impact**: No direct score impact, but fewer discovered pages may reduce the representativeness of results.

## Severe rate limiting

**Triggers when** more than 20% of tested URLs returned HTTP 429 (Too Many Requests) across all checks that make HTTP requests.

**What it means**: The target site is rate-limiting requests from the tool. Check results may be unreliable because rate-limited requests are not retried indefinitely, so some pages may not have been fully tested.

**What to do**: Increase `--request-delay` to slow down requests (the default is 200ms), or contact the site operator to allowlist your IP or user-agent for testing.

**Score impact**: No direct score impact, but rate-limited requests may cause checks to report incomplete data, leading to scores that don't reflect the site's actual state.
