# Score Calculation

The Agent Score is a weighted average of 23 check results, adjusted for interaction effects between checks. This page covers the mechanics: how checks are weighted, how multi-page results are scored proportionally, and how the system handles cases where checks influence each other.

Each check corresponds to a section of the [Agent-Friendly Documentation Spec](https://agentdocsspec.com), which documents what the check measures and the observed agent behaviors that motivated it. For what each check measures, see the [Checks Reference](/checks/).

## The formula

```
score = (sum of check scores) / (sum of weights for non-skipped checks) × 100
```

Each check earns a proportion of its weight based on its result:

- **Pass**: Full weight
- **Warn**: Partial weight (see [warn coefficients](#warn-coefficients) below)
- **Fail**: Zero
- **Skip**: Excluded from both the numerator and denominator
- **Not applicable**: Excluded (see [insufficient data](#insufficient-data) below)

The score is rounded to the nearest integer and mapped to a [letter grade](/what-is-agent-score#letter-grades).

## Check weights by category

Every check is assigned a weight tier based on its observed impact on agent workflows:

- **Critical (10 pts)**: Agents cannot function without this. Failure means zero content, zero navigation, or zero access.
- **High (7 pts)**: Directly limits agent effectiveness. Failure means truncation, dead ends, or agents stuck on a worse path.
- **Medium (4 pts)**: Significant but not blocking. Failure degrades quality or misses an opportunity.
- **Low (2 pts)**: Refinements. Failure is a missed best practice, not an agent-blocking issue.

### Content Discoverability

| Check                     | Weight        |
| ------------------------- | ------------- |
| `llms-txt-exists`         | Critical (10) |
| `llms-txt-valid`          | Medium (4)    |
| `llms-txt-size`           | High (7)      |
| `llms-txt-links-resolve`  | High (7)      |
| `llms-txt-links-markdown` | High (7)      |
| `llms-txt-directive-html` | High (7)      |
| `llms-txt-directive-md`   | Medium (4)    |

### Markdown Availability

| Check                  | Weight     |
| ---------------------- | ---------- |
| `markdown-url-support` | High (7)   |
| `content-negotiation`  | Medium (4) |

### Page Size and Truncation Risk

| Check                    | Weight        |
| ------------------------ | ------------- |
| `rendering-strategy`     | Critical (10) |
| `page-size-markdown`     | High (7)      |
| `page-size-html`         | High (7)      |
| `content-start-position` | Medium (4)    |

### Content Structure

| Check                          | Weight     |
| ------------------------------ | ---------- |
| `tabbed-content-serialization` | Medium (4) |
| `section-header-quality`       | Low (2)    |
| `markdown-code-fence-validity` | Medium (4) |

### URL Stability and Redirects

| Check               | Weight     |
| ------------------- | ---------- |
| `http-status-codes` | High (7)   |
| `redirect-behavior` | Medium (4) |

### Observability and Content Health

| Check                     | Weight     |
| ------------------------- | ---------- |
| `llms-txt-coverage`       | Medium (4) |
| `markdown-content-parity` | Medium (4) |
| `cache-header-hygiene`    | Low (2)    |

### Authentication and Access

| Check                     | Weight        |
| ------------------------- | ------------- |
| `auth-gate-detection`     | Critical (10) |
| `auth-alternative-access` | Medium (4)    |

## Proportional scoring

Checks that test multiple pages use proportional scoring. If `page-size-html` tests 50 pages and 3 exceed the threshold, the check scores ~94% of its weight rather than failing outright. This reflects reality: a site where a few pages are oversized is very different from one where nearly all are.

### Multi-page checks (proportional)

These checks sample pages from your site and score based on the pass rate across those pages:

| Check                          | What's measured per page                                                                     |
| ------------------------------ | -------------------------------------------------------------------------------------------- |
| `rendering-strategy`           | Whether the page is fully server-rendered, server-rendered but sparse, or an empty SPA shell |
| `page-size-html`               | Whether the HTML-to-text conversion fits within size limits                                  |
| `page-size-markdown`           | Whether the markdown version fits within size limits                                         |
| `content-start-position`       | How far into the response actual content begins                                              |
| `content-negotiation`          | Whether the server returns markdown for this page                                            |
| `markdown-url-support`         | Whether the `.md` URL variant returns markdown                                               |
| `http-status-codes`            | Whether a fabricated bad URL returns a proper 404                                            |
| `redirect-behavior`            | Whether redirects use standard HTTP methods                                                  |
| `auth-gate-detection`          | Whether the page is publicly accessible                                                      |
| `llms-txt-directive-html`      | Whether the HTML page includes a directive pointing to llms.txt                              |
| `llms-txt-directive-md`        | Whether the markdown page includes a directive pointing to llms.txt                          |
| `tabbed-content-serialization` | Whether tabbed content creates oversized output                                              |
| `section-header-quality`       | Whether tab section headers include variant context                                          |
| `markdown-code-fence-validity` | Whether code fences are properly closed                                                      |
| `markdown-content-parity`      | Whether markdown and HTML versions match                                                     |
| `cache-header-hygiene`         | Whether cache headers allow timely updates                                                   |
| `auth-alternative-access`      | Whether auth-gated pages have alternative access paths                                       |

### Single-resource checks (all-or-nothing)

These checks test a single site-wide resource and produce one pass, warn, or fail result:

| Check                     | What's tested                                          |
| ------------------------- | ------------------------------------------------------ |
| `llms-txt-exists`         | Whether an llms.txt file exists at candidate locations |
| `llms-txt-valid`          | Whether the llms.txt follows the standard structure    |
| `llms-txt-size`           | Whether the llms.txt fits within agent context limits  |
| `llms-txt-links-resolve`  | Whether links in the llms.txt return 200               |
| `llms-txt-links-markdown` | Whether llms.txt links point to markdown content       |
| `llms-txt-coverage`       | Whether the llms.txt reflects the current site state   |

Note that the llms.txt link checks (`llms-txt-links-resolve`, `llms-txt-links-markdown`) do test multiple URLs, but they test the links _within_ the llms.txt file rather than sampling pages from the site. Their result is a single pass/warn/fail based on the overall resolution or markdown rate.

## Warn coefficients

A warning is not a binary "half credit." Different warnings represent different degrees of degradation, and the score reflects this.

| Coefficient | Meaning                                  | Checks                                                                                                                                                                                                                                                                                 |
| ----------- | ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **0.75**    | Content substantively intact             | `llms-txt-valid`, `content-negotiation`, `llms-txt-links-resolve`, `llms-txt-coverage`, `markdown-content-parity`                                                                                                                                                                      |
| **0.60**    | Partial coverage or platform-dependent   | `llms-txt-directive-html`, `llms-txt-directive-md`, `redirect-behavior`                                                                                                                                                                                                                |
| **0.50**    | Genuine functional degradation           | `llms-txt-exists`, `llms-txt-size`, `rendering-strategy`, `markdown-url-support`, `page-size-markdown`, `page-size-html`, `content-start-position`, `tabbed-content-serialization`, `section-header-quality`, `cache-header-hygiene`, `auth-gate-detection`, `auth-alternative-access` |
| **0.25**    | Actively steering agents to a worse path | `llms-txt-links-markdown` (markdown exists but llms.txt links to HTML)                                                                                                                                                                                                                 |

`markdown-code-fence-validity` is strictly pass/fail. `http-status-codes` is normally pass/fail but emits a warn when every sampled response is indeterminate (HTTP 202 during CDN cache-miss/build, or 5xx) so we couldn't measure bad-URL handling.

## Score caps

Some problems are severe enough that no amount of other passing checks should compensate. When AFDocs detects a critical issue, we cap the score regardless of how well everything else performs.

| Condition                                                                             | Cap    | Why                                                         |
| ------------------------------------------------------------------------------------- | ------ | ----------------------------------------------------------- |
| `llms-txt-exists` fails                                                               | 59 (D) | Agents lose their primary navigation mechanism.             |
| `rendering-strategy`: proportion ≤ 0.25                                               | 39 (F) | Most content is invisible to agents.                        |
| `rendering-strategy`: proportion ≤ 0.50                                               | 59 (D) | Significant content is invisible.                           |
| `auth-gate-detection`: 75%+ pages gated                                               | 39 (F) | Most documentation is inaccessible.                         |
| `auth-gate-detection`: 50%+ pages gated                                               | 59 (D) | Significant documentation is inaccessible.                  |
| [No viable path](/interaction-diagnostics#no-viable-path-to-content) diagnostic fires | 39 (F) | Agents have no effective way to access content at all.      |
| [Single-page sample](/interaction-diagnostics#single-page-sample) diagnostic fires    | 59 (D) | Too few pages discovered to produce a representative score. |

When multiple caps apply, the lowest one wins.

The `rendering-strategy` proportion is `(serverRendered + sparseContent × 0.5) / total`: empty SPA shells count fully against the proportion, while server-rendered-but-sparse pages count at half weight. A site that's entirely SPA shells has proportion 0 (caps at F). A site that's half shells and half full content has proportion 0.5 (caps at D). A site that's entirely sparse-but-rendered has proportion 0.5 (also caps at D, on the assumption that sparse pages are half-broken on average); after the heuristic fix, legitimately short pages no longer count as sparse, so this scenario is much rarer.

The `rendering-strategy` and `auth-gate-detection` caps do not apply when the check is marked as not applicable due to [insufficient data](#insufficient-data). If there isn't enough data to include the check in the score, there isn't enough data to cap the score based on it either.

## Insufficient data

When automatic page discovery finds fewer than 5 pages (using `random` or `deterministic` sampling), page-level check scores are unreliable because they represent a handful of pages out of potentially thousands. In this case:

- **Page-level checks** (those that test sampled pages like `page-size-html`, `rendering-strategy`, `http-status-codes`, etc.) are marked as "not applicable" and excluded from the score.
- **Site-level checks** (llms.txt checks, coverage, auth-alternative-access) are scored normally.
- **Category scores** where all checks are not applicable display as a dash instead of a number.
- **The overall score is capped at 59 (D)**, since the remaining numerator covers only a narrow slice of site-wide signal and shouldn't drive a higher grade on its own.

This typically happens when a site has no llms.txt or its llms.txt links point to a different origin (common with preview deployments). A [`single-page-sample` diagnostic](/interaction-diagnostics#single-page-sample) fires to explain the situation.

This behavior does not apply when you explicitly choose pages with `--urls` or `--sampling curated`, or when you use `--sampling none`. If you intentionally select pages, the score reflects those pages regardless of count.

## Cluster coefficients

Some checks only matter if agents can actually reach the content they measure. If agents can't discover your markdown path, measuring markdown quality is pointless. The score handles this through cluster coefficients that scale both a check's score and its weight proportionally.

### Discovery coefficient

**Affects**: `page-size-markdown`, `markdown-code-fence-validity`, `markdown-content-parity`

These checks measure markdown path quality. But if agents can't discover that path, the quality is irrelevant.

| Condition                                                   | Coefficient | Why                                                             |
| ----------------------------------------------------------- | ----------- | --------------------------------------------------------------- |
| Content negotiation passes                                  | 1.0         | Agents that request it get markdown automatically.              |
| `llms-txt-directive-html` or `llms-txt-directive-md` passes | 0.8         | Effective, but agents sometimes ignore the directive.           |
| llms.txt links use .md URLs                                 | 0.5         | Agents must find llms.txt first, then follow .md links.         |
| None of the above                                           | 0.0         | Agents won't find the markdown path. Check excluded from score. |

If multiple conditions are met, the highest coefficient applies.

Note that `markdown-url-support` is intentionally excluded from this coefficient. It measures whether the capability exists, not the quality of an established path. A site should get credit for serving markdown; the discovery coefficient only applies to downstream quality checks.

### HTML path coefficient

**Affects**: `page-size-html`, `content-start-position`, `tabbed-content-serialization`, `section-header-quality`

If pages are SPA shells, measuring HTML quality is meaningless; if pages are sparse, HTML quality counts for less because agents have less content to work with. This coefficient equals the same proportion that drives the score caps above: `(serverRendered + sparseContent × 0.5) / total`. Fully server-rendered pages count for full weight, sparse pages count for half, and SPA shells count for nothing.

### Index truncation coefficient

**Affects**: `llms-txt-links-resolve`, `llms-txt-valid`, `llms-txt-coverage`, `llms-txt-links-markdown`

If your llms.txt is truncated, agents only see part of the index. Measuring the quality of the invisible portion doesn't reflect real agent experience.

| Condition                        | Coefficient                                                |
| -------------------------------- | ---------------------------------------------------------- |
| `llms-txt-size` passes           | 1.0                                                        |
| `llms-txt-size` warns (50K–100K) | 0.8                                                        |
| `llms-txt-size` fails (>100K)    | Proportional to visible fraction (e.g., a 200K file ≈ 0.5) |

### How coefficients combine

When a check is subject to multiple coefficients, they multiply. Both the check's score and its weight in the denominator are scaled by the same combined coefficient, so a discounted check contributes proportionally less to the overall score rather than dragging it down.

In the current scoring version, the three coefficient groups apply to disjoint sets of checks, so no check actually has more than one coefficient.
