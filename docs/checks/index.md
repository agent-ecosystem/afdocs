# Checks Reference

AFDocs runs 24 checks across 7 categories. Each check implements a section of the [Agent-Friendly Documentation Spec](https://agentdocsspec.com/spec/web/), which documents the observed agent behaviors and failure modes that motivated the check.

## Categories

| Category                                                   | Checks | What it covers                                                       |
| ---------------------------------------------------------- | ------ | -------------------------------------------------------------------- |
| [Content Discoverability](/checks/content-discoverability) | 7      | Whether agents can find and navigate your documentation via llms.txt |
| [Markdown Availability](/checks/markdown-availability)     | 2      | Whether agents can get documentation as markdown instead of HTML     |
| [Page Size and Truncation Risk](/checks/page-size)         | 4      | Whether agents can process your pages without losing content         |
| [Content Structure](/checks/content-structure)             | 3      | Whether page content is structured in ways agents can consume        |
| [URL Stability and Redirects](/checks/url-stability)       | 2      | Whether documentation URLs behave predictably for agents             |
| [Observability and Content Health](/checks/observability)  | 3      | Whether agent-facing resources stay accurate over time               |
| [Authentication and Access](/checks/authentication)        | 3      | Whether agents can reach your documentation at all                   |

## How to read check results

Each check produces one of four results:

- **Pass**: The check passed. Your site meets the spec recommendation.
- **Warn**: Partial success. Something works but could be better; the scorecard includes a specific suggestion.
- **Fail**: The check failed. Agents are affected. The scorecard includes a fix suggestion.
- **Skip**: A dependency didn't pass, so this check couldn't run. The dependency already carries the penalty.

For checks that test multiple pages (like `page-size-html` or `rendering-strategy`), results are proportional. If 3 out of 50 pages fail, the check scores ~94% of its weight rather than failing outright. See [Proportional scoring](/agent-score-calculation#proportional-scoring) for details.

## Check dependencies

Some checks depend on others. If a dependency doesn't pass, the dependent check is skipped.

- `llms-txt-valid`, `llms-txt-size`, `llms-txt-links-resolve`, `llms-txt-links-markdown` require `llms-txt-exists`
- `page-size-markdown` requires `markdown-url-support` or `content-negotiation`
- `section-header-quality` requires `tabbed-content-serialization`
- `markdown-code-fence-validity` requires `markdown-url-support` or `content-negotiation`
- `llms-txt-coverage` requires `llms-txt-exists`
- `markdown-content-parity` requires `markdown-url-support` or `content-negotiation`
- `auth-alternative-access` requires `auth-gate-detection` (warn or fail)

`bot-protection-interference` has no dependencies but inverts the usual direction: it runs last, evaluated from every request the other checks made, and when it warns or fails the multi-page checks are flagged as computed from a partial sample. See [Bot protection degrading scan reliability](/interaction-diagnostics#bot-protection-degrading-scan-reliability).

When running a subset of checks with `--checks`, include the dependencies in your list. AFDocs handles execution order automatically, but it can only run checks you've asked for. If you pass `--checks llms-txt-valid` without including `llms-txt-exists`, the dependency won't run, so `llms-txt-valid` gets skipped.

## Weight tiers

Every check is assigned a weight based on its observed impact on agent workflows. Weights determine how much each check contributes to the overall score.

- **Critical (10 pts)**: Agents cannot function without this.
- **High (7 pts)**: Directly limits agent effectiveness.
- **Medium (4 pts)**: Significant but not blocking.
- **Low (2 pts)**: Refinements and best practices.

See [Score Calculation](/agent-score-calculation) for the full scoring mechanics.
