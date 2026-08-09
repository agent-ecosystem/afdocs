# Observability and Content Health

Whether agent-facing resources stay accurate over time. Getting `llms.txt` and markdown support working is the hard part; keeping them working is a different problem. These checks catch the silent failures: a stale index, drifting content between formats, and cache headers that delay updates.

## llms-txt-coverage

How much of your site's documentation is represented in `llms.txt`.

|                |                                                                        |
| -------------- | ---------------------------------------------------------------------- |
| **Weight**     | Medium (4)                                                             |
| **Depends on** | `llms-txt-exists`                                                      |
| **Spec**       | [llms-txt-coverage](https://agentdocsspec.com/spec/#llms-txt-coverage) |

### Why it matters

Pages missing from `llms.txt` are effectively invisible to agents that rely on it for discovery. Unlike `llms-txt-links-resolve` (which catches broken links to pages that are listed), this check catches the opposite problem: pages that exist on your site but aren't listed at all. Not every gap is a problem; many sites intentionally curate their `llms.txt`. The check makes coverage visible so you can confirm it reflects your intent.

### Results

Based on coverage of your site's documentation pages, after excluding non-doc pages (see [built-in exclusions](#built-in-exclusions) below). Thresholds are configurable.

| Result | Condition                                                                |
| ------ | ------------------------------------------------------------------------ |
| Pass   | `llms.txt` covers >= pass threshold (default 95%) of documentation pages |
| Warn   | Coverage between warn and pass thresholds (default 80-95%)               |
| Fail   | Coverage below warn threshold (default < 80%)                            |

### Configuring coverage

The check supports three use cases through configurable thresholds and exclusion patterns:

- **Full parity** (default): The site intends `llms.txt` to mirror the sitemap. Default thresholds (95/80) apply.
- **Curated**: The site intentionally includes only a subset. Set thresholds to 0 (`--coverage-pass-threshold 0 --coverage-warn-threshold 0`) to make the check informational. It still reports coverage percentage and missing pages, but does not warn or fail.
- **Hybrid**: Strict coverage with known exclusions. Use `--coverage-exclusions` to remove intentional gaps from the denominator; the check holds remaining pages to default or custom thresholds.

**CLI flags:**

- `--coverage-pass-threshold <n>` — Minimum coverage % to pass (0-100, default 95; higher = stricter)
- `--coverage-warn-threshold <n>` — Minimum coverage % to avoid failure (0-100, default 80; higher = stricter)
- `--coverage-exclusions <patterns>` — Comma-separated glob patterns to exclude from the sitemap before calculating coverage (e.g. `"/docs/reference/**,/docs/changelog/**"`)

These can also be set in `agent-docs.config.yml` under `options`:

```yaml
options:
  coveragePassThreshold: 80
  coverageWarnThreshold: 50
  coverageExclusions:
    - /docs/reference/**
    - /docs/changelog/**
    - '**/release-notes/**' # quote patterns starting with *
```

### Locale handling

Multi-locale sites usually list only one language in `llms.txt`, so localized sitemap URLs would otherwise read as missing coverage. The check detects locale-prefixed paths (like `/fr/` or `/docs/ja/`) and compares `llms.txt` against a single locale:

- When locale prefixes cover most of the sitemap, the prefix position is detected directly.
- When translations are a minority of the sitemap (an unprefixed default language plus a few translated locales), the check confirms the prefixes by structural duplication: stripping a locale code must produce paths that match unprefixed URLs.
- `--doc-locale <code>` (or `preferredLocale` in config) overrides detection. If the sitemap has no URLs prefixed with that locale, it is treated as the unprefixed default and the localized variants are excluded.

### How to fix

**If this check warns or fails**, regenerate `llms.txt` from your sitemap or build pipeline. The best long-term fix is generating `llms.txt` at build time, so every deployment automatically includes an up-to-date index. Run with `--verbose` to see which pages are missing. If the missing pages are intentionally excluded, use `--coverage-exclusions` or adjust thresholds.

### Built-in exclusions

Before calculating coverage, the check removes sitemap URLs whose paths match common non-documentation patterns. These pages appear in sitemaps but aren't meaningful to include in an `llms.txt` index. The excluded count is reported as `excludedNonDocPages` in the check details.

The tool provides these built-in exclusions (matched at both root and relative to the base URL path):

`/blog`, `/pricing`, `/about`, `/career`, `/careers`, `/job`, `/jobs`, `/contact`, `/legal`, `/privacy`, `/terms`, `/login`, `/signup`, `/sign-up`, `/sign-in`, `/register`, `/404`, `/500`

For example, if your base URL is `https://example.com/docs`, both `/blog/post-1` and `/docs/blog/post-1` would be excluded.

These are not configurable. If a built-in exclusion is removing pages you want counted, the page is likely at a path that conventionally indicates non-doc content. If you believe a pattern is wrong, please [open an issue](https://github.com/agent-ecosystem/afdocs/issues).

Paths like `/changelog`, `/releases`, and `/security` are **not** excluded because many documentation sites intentionally include this content in their `llms.txt`. If you want to exclude them, use `--coverage-exclusions`.

### Omitted subtrees

When your `llms.txt` uses [progressive disclosure](https://agentdocsspec.com/spec/#progressive-disclosure-for-large-documentation-sets) (nested `llms.txt` files), the walker descends one level into linked `.txt` files. Any `.txt` files found at that depth (which the walker does not descend into) are treated as "omitted subtrees." Sitemap pages under those subtree prefixes are excluded from the coverage denominator rather than counted as missing.

This means deeply nested `llms.txt` structures aren't penalized. The output distinguishes directly-verified pages from omitted subtrees.

**Why not walk recursively?** A recursive walk would fetch every nested `.txt` file before any checks run. For a site like Alchemy, that's ~86 aggregate files across three levels. For a multi-product site like Microsoft Learn, it could be hundreds. A safety cap (e.g. 200 files) would silently truncate results, producing incomplete coverage numbers with no indication they're partial. Keeping the walker at depth 1 makes the HTTP footprint predictable, makes the runs more performant, and makes the results reproducible.

**Run per-product for deeper visibility.** Organizations with large multi-product sites typically run `afdocs` at the per-product level, which gives full coverage visibility into each section without the cost of walking the entire tree:

```bash
# Instead of walking the entire site's progressive disclosure tree:
afdocs check https://example.com/docs

# Run per-product for deeper coverage:
afdocs check https://example.com/docs/chains/ethereum
afdocs check https://example.com/docs/chains/solana
afdocs check https://example.com/docs/sdk
```

Each per-product run picks up that section's `llms.txt` as canonical. For the sitemap, the tool scopes the root sitemap's URLs to the base path prefix. If no URLs match (common when the root sitemap doesn't cover the section), it falls back to looking for a section-level sitemap at `{basePath}/sitemap.xml`. This keeps runs fast and results meaningful.

---

## markdown-content-parity

Whether markdown and HTML versions of pages contain the same content.

|                |                                                                                    |
| -------------- | ---------------------------------------------------------------------------------- |
| **Weight**     | Medium (4)                                                                         |
| **Depends on** | `markdown-url-support` or `content-negotiation`                                    |
| **Spec**       | [markdown-content-parity](https://agentdocsspec.com/spec/#markdown-content-parity) |

### Why it matters

When markdown is generated separately from HTML (not served directly from source), the two can drift. A site updates its HTML but forgets to regenerate the markdown, leaving agents with outdated instructions or code examples. Or a build pipeline that generates markdown misses some of the content. This is particularly insidious because agents receiving the markdown version have no signal that content is missing or outdated, and humans typically don't look at both page formats to spot discrepancies.

However, content divergence is sometimes intentional. Some sites serve different content to different audiences: agent-optimized markdown alongside human-optimized HTML. In those cases, divergence is a feature, not a bug. The check supports this through audience-segmentation markers and configurable thresholds.

### Results

Based on the percentage of HTML content segments missing from the markdown version, after normalization. Thresholds are configurable.

| Result | Condition                                                     |
| ------ | ------------------------------------------------------------- |
| Pass   | Under pass threshold (default 5%) of content segments missing |
| Warn   | Between pass and warn thresholds (default 5-20% missing)      |
| Fail   | Above warn threshold (default 20% or more missing)            |

### Audience segmentation

Some documentation platforms let site owners serve different content to different audiences. For example, a page might show UI-oriented instructions ("Click the gear icon...") in HTML but API-oriented instructions ("Call `POST /v1/settings`...") in markdown. The check accounts for this in two ways:

**`data-markdown-ignore` attribute.** Add this attribute to HTML elements that contain human-only content (content intentionally excluded from markdown). The check strips these elements before comparing, so they don't count as "missing."

```html
<div data-markdown-ignore>
  <p>Click the gear icon in the top-right corner to open settings.</p>
</div>
```

This is the recommended convention for platforms that render HTML server-side. If your documentation platform controls the HTML output, adding `data-markdown-ignore` to human-only wrapper elements lets the parity check handle segmentation automatically with no user configuration.

**Configurable thresholds.** For platforms that process segmentation tags server-side (like Fern and Mintlify, where the tags never appear in the rendered HTML), adjust thresholds to match your expected divergence level.

### Configuring parity

The check supports three use cases, matching the same mirrored-to-curated spectrum as `llms-txt-coverage`:

- **Mirrored** (default): Markdown should match HTML. Default thresholds (5/20) apply.
- **Segmented**: The site uses `data-markdown-ignore` to mark human-only HTML content. The check strips tagged content before comparing; remaining shared content is held to default thresholds.
- **Curated**: The site intentionally serves different content with no tag-level signal. Set thresholds to 0 (`--parity-pass-threshold 0 --parity-warn-threshold 0`) to make the check informational. It still reports the missing percentage, but does not warn or fail.

**CLI flags:**

- `--parity-pass-threshold <n>` — Maximum missing % to pass (0-100, default 5; lower = stricter). Set to 0 to disable warnings.
- `--parity-warn-threshold <n>` — Maximum missing % to avoid failure (0-100, default 20; lower = stricter). Set to 0 to disable failures.
- `--parity-exclusions <selectors>` — Comma-separated CSS selectors to strip from HTML before comparison, for platform-specific conventions beyond `data-markdown-ignore` (e.g. `".human-only,[data-audience='humans']"`)

These can also be set in `agent-docs.config.yml` under `options`:

```yaml
options:
  parityPassThreshold: 10
  parityWarnThreshold: 30
  parityExclusions:
    - .human-only-content
    - '[data-audience="humans"]' # quote selectors starting with [ (YAML treats unquoted [] as arrays)
```

Note: `data-markdown-ignore` is built in and does not need to be listed in `parityExclusions`. The exclusions option is only for additional platform-specific conventions.

### How to fix

**If this check warns**, review the differences. If they reflect intentional audience segmentation, either add `data-markdown-ignore` to the human-only HTML elements or adjust thresholds. If they reflect formatting variations, minor parity issues (navigation elements present in one format but not the other) may be acceptable.

**If this check fails**, your markdown and HTML versions have substantive content differences. If unintentional, regenerate markdown from source or fix the build pipeline. The most reliable approach is serving markdown directly from the same source files used to generate HTML. If intentional (audience segmentation), add `data-markdown-ignore` to human-only HTML elements, use `--parity-exclusions` for custom conventions, or set thresholds to 0 for informational mode.

---

## cache-header-hygiene

Whether cache headers on `llms.txt` and markdown endpoints allow timely updates.

|            |                                                                              |
| ---------- | ---------------------------------------------------------------------------- |
| **Weight** | Low (2)                                                                      |
| **Spec**   | [cache-header-hygiene](https://agentdocsspec.com/spec/#cache-header-hygiene) |

### Why it matters

Aggressive caching means that after you update `llms.txt` or markdown content, agents and CDNs continue serving the stale version for hours or days. Conversely, missing cache headers lead to ambiguous behavior where CDN providers apply their own defaults.

This isn't only a CDN concern. Some agents appear to cache fetched content locally or through a server proxy, using cache headers to decide whether to re-fetch a page or serve a stored copy. In testing, agents have been observed returning stale content for pages they previously fetched, even after the source was updated. The exact mechanism varies by agent platform, but the practical effect is the same: long cache lifetimes delay how quickly agents see your changes.

For small, infrequently fetched resources like `llms.txt`, short cache lifetimes with revalidation headers are appropriate.

### Results

| Result | Condition                                                                                   |
| ------ | ------------------------------------------------------------------------------------------- |
| Pass   | `max-age` under 3600, or uses `must-revalidate` with `ETag`/`Last-Modified`                 |
| Warn   | Moderate caching (1-24 hours) that could delay updates                                      |
| Fail   | Aggressive caching (over 24 hours) with no revalidation, or no cache-related headers at all |

Responses that lack `Cache-Control`/`Expires` but include `ETag` or `Last-Modified` pass, because they enable conditional revalidation.

### How to fix

Set reasonable cache lifetimes on `.md` and `.txt` files. A `max-age` of 300-3600 seconds (5 minutes to 1 hour) with `must-revalidate` is a good default. Include `ETag` or `Last-Modified` headers so clients can conditionally revalidate without re-downloading unchanged content.
