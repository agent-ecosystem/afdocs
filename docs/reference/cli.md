# CLI Reference

## Install

```bash
# Run without installing (recommended for getting started)
npx afdocs check https://docs.example.com

# Install globally
npm install -g afdocs

# Install as a project dev dependency
npm install -D afdocs
```

Requires Node.js 22 or later.

## Commands

### `afdocs check <url>`

Run agent-friendly documentation checks against a URL.

```bash
afdocs check https://docs.example.com
```

The URL can be a site root or a specific page. When pointing to a site root, `afdocs` discovers pages via `llms.txt` and sitemap, then samples a subset to check. When pointing to a specific page with `--sampling none`, it skips discovery and checks just that page.

## Options

### Output

| Flag                    | Default | Description                                                                                                                                      |
| ----------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `-f, --format <format>` | `text`  | Output format: `text`, `json`, or `scorecard`                                                                                                    |
| `-v, --verbose`         |         | Show per-page details for checks with issues                                                                                                     |
| `--fixes`               |         | Show per-check fix suggestions for warn/fail checks (only needed for `text` format; the other two formats include fix suggestions automatically) |
| `--score`               |         | Include scoring data in JSON output (only usable with `json` output format)                                                                      |

**Which format to use:**

- **`text`** is the default. Shows per-check pass/warn/fail/skip results. Add `--verbose` for per-page details and `--fixes` for fix suggestions. Useful when iterating on individual check fixes.
- **`scorecard`** includes the overall score, per-category scores, interaction diagnostics, and fix suggestions for every failing check. This is the best starting point for understanding your site's agent-friendliness.
- **`json`** produces machine-readable output for scripting and automation. Add `--score` to include scoring data and fix suggestions.

### Config file

| Flag              | Default | Description                                  |
| ----------------- | ------- | -------------------------------------------- |
| `--config <path>` |         | Path to a config file (skips auto-discovery) |

Without `--config`, the CLI looks for `agent-docs.config.yml` (or `.yaml`) starting from the current directory and walking up the tree. Config values serve as defaults; any CLI flags you pass override them.

```bash
# Auto-discover config (typical usage)
afdocs check --format scorecard

# Use an explicit config file
afdocs check --config agent-docs.local.yml --format scorecard
```

See [Config File](/reference/config-file) for the full config format.

### Check selection

| Flag                  | Default | Description                               |
| --------------------- | ------- | ----------------------------------------- |
| `-c, --checks <ids>`  | all     | Comma-separated list of check IDs to run  |
| `--skip-checks <ids>` |         | Comma-separated list of check IDs to skip |

```bash
# Run only llms.txt checks
afdocs check https://docs.example.com --checks llms-txt-exists,llms-txt-valid,llms-txt-size

# Run all checks except one
afdocs check https://docs.example.com --skip-checks markdown-content-parity
```

`--checks` is an include-list (only run these). `--skip-checks` is an exclude-list (run everything except these). Skipped checks appear in the report with `status: "skip"` and are excluded from scoring.

Some checks depend on others. If you include a check without its dependency, the dependent check will be skipped. See [Check dependencies](/checks/#check-dependencies) for the full list.

### Sampling

| Flag                    | Default  | Description                                                                  |
| ----------------------- | -------- | ---------------------------------------------------------------------------- |
| `--sampling <strategy>` | `random` | URL sampling strategy: `random`, `deterministic`, `curated`, or `none`       |
| `--max-links <n>`       | `50`     | Maximum number of pages to sample                                            |
| `--urls <urls>`         |          | Comma-separated page URLs for curated scoring (implies `--sampling curated`) |

**Sampling strategies:**

- **`random`**: Shuffle discovered URLs and take the first N. Fast and broad, but results vary between runs. Useful for spot-checking pages across a large corpus.
- **`deterministic`**: Sort discovered URLs alphabetically and pick an even spread. Produces the same sample on repeated runs as long as the URL set is stable. Useful for CI or when verifying a fix.
- **`curated`**: Test a specific set of pages listed in the config file's `pages` field or passed via `--urls`. Skips discovery entirely. Useful for ongoing monitoring of representative pages or focused evaluation of specific sections.
- **`none`**: Skip discovery entirely. Only check the URL you pass on the command line.

```bash
# Reproducible results
afdocs check https://docs.example.com --sampling deterministic

# Check a single page
afdocs check https://docs.example.com/api/auth --sampling none

# Test specific pages without a config file
afdocs check https://docs.example.com --urls https://docs.example.com/quickstart,https://docs.example.com/api/auth

# Sample fewer pages for a quicker run
afdocs check https://docs.example.com --max-links 10

# Sample more pages for better representation across a large corpus
afdocs check https://docs.example.com --max-links 100
```

### URL discovery

| Flag                      | Default     | Description                                                                                         |
| ------------------------- | ----------- | --------------------------------------------------------------------------------------------------- |
| `--doc-locale <code>`     | auto-detect | Preferred locale for URL discovery (e.g. `en`, `fr`, `ja`)                                          |
| `--lang <code>`           | `en`        | Output language for check messages, resolutions, and diagnostics (`en` or `zh`; also `AFDOCS_LANG`) |
| `--doc-version <version>` | auto-detect | Preferred version for URL discovery (e.g. `v3`, `2.x`, `latest`)                                    |

When `afdocs` discovers pages from a sitemap or `llms.txt`, it automatically filters out duplicate locale and version variants so you get a representative sample of unique content.

The resolution order for both flags is:

1. **Explicit flag** (`--doc-locale`, `--doc-version`) if provided
2. **Auto-detect** from the base URL path (e.g. `https://docs.example.com/fr/v3` detects `fr` and `v3`)
3. **Built-in fallback** when neither of the above yields a value: locale falls back to `en`; version prefers unversioned URLs, then `latest`/`stable`/`current`, then the highest semver. Pre-release channels (`dev`, `next`, `nightly`, `canary`) are ranked below stable versions

Use the flags when the base URL doesn't contain locale or version segments but the site organizes content by locale or version.

```bash
# Prefer French locale during discovery
afdocs check https://docs.example.com --doc-locale fr

# Chinese output for messages / resolutions / diagnostics (JSON-friendly for localized UIs)
afdocs check https://docs.example.com --format json --score --lang zh

# Prefer a specific version
afdocs check https://docs.example.com --doc-version v3

# Both together
afdocs check https://docs.example.com --doc-locale ja --doc-version 2.x
```

### Request behavior

| Flag                       | Default | Description                                 |
| -------------------------- | ------- | ------------------------------------------- |
| `--max-concurrency <n>`    | `3`     | Maximum concurrent HTTP requests            |
| `--request-delay <ms>`     | `200`   | Delay between requests in milliseconds      |
| `--canonical-origin <url>` |         | The production domain your content links to |

AFDocs enforces delays between requests and caps concurrent connections to avoid overloading your server. Adjust these if you need gentler or faster runs:

```bash
# Slower, gentler (for rate-limited servers)
afdocs check https://docs.example.com --request-delay 500 --max-concurrency 1

# Faster (for your own infrastructure)
afdocs check https://docs.example.com --request-delay 50 --max-concurrency 10
```

Use `--canonical-origin` when your site's URLs in `sitemap.xml` and `llms.txt` don't match the domain you're testing, such as preview deployments or localhost.

```bash
# Test a preview deployment
afdocs check https://preview-xyz-example.app/docs --canonical-origin https://example.com
```

### llms.txt selection

| Flag                   | Default | Description                                                              |
| ---------------------- | ------- | ------------------------------------------------------------------------ |
| `--llms-txt-url <url>` |         | Explicit llms.txt URL to use as canonical (bypasses discovery heuristic) |

By default, `afdocs` discovers llms.txt at three candidate locations: `{baseUrl}/llms.txt`, `{origin}/llms.txt`, and `{origin}/docs/llms.txt`. When more than one of these returns a file, the most-specific one — the one whose directory is the longest prefix of the URL you passed — is used as canonical. Downstream checks (size, validity, link sampling) all operate on the canonical file.

For most sites this heuristic does the right thing. Use `--llms-txt-url` to override it when:

- The canonical llms.txt lives at a non-standard path (e.g. `/docs/v3/llms.txt`)
- A monorepo serves multiple docs surfaces at one origin and you want to score one specifically
- You want to verify a specific file before publishing

```bash
# Score a docs section explicitly, ignoring an apex /llms.txt
afdocs check https://example.com/docs --llms-txt-url https://example.com/docs/llms.txt
```

When the override is set, `llms-txt-exists` probes only that URL and reports failure if it isn't reachable. The cross-host redirect fallback is skipped.

### Size thresholds

| Flag                   | Default  | Description                            |
| ---------------------- | -------- | -------------------------------------- |
| `--pass-threshold <n>` | `50000`  | Page size pass threshold in characters |
| `--fail-threshold <n>` | `100000` | Page size fail threshold in characters |

These thresholds apply to `page-size-html`, `page-size-markdown`, and `tabbed-content-serialization`. Pages under the pass threshold pass; pages between the two thresholds warn; pages over the fail threshold fail.

The defaults (50K pass, 100K fail) reflect observed agent truncation limits. You generally don't need to change these unless you have specific knowledge of your users' agent platforms.

### Coverage thresholds

| Flag                               | Default | Description                                                   |
| ---------------------------------- | ------- | ------------------------------------------------------------- |
| `--coverage-pass-threshold <n>`    | `95`    | Minimum coverage % to pass (higher = stricter)                |
| `--coverage-warn-threshold <n>`    | `80`    | Minimum coverage % to avoid failure (higher = stricter)       |
| `--coverage-exclusions <patterns>` |         | Comma-separated glob patterns to exclude from the denominator |

These control the `llms-txt-coverage` check, which compares `llms.txt` page URLs against the sitemap. Set both thresholds to `0` to make the check informational: it still reports coverage percentage and missing pages, but doesn't warn or fail.

Use exclusion patterns with glob syntax (`**` matches across path segments, `*` matches within one) to remove matching sitemap URLs from the denominator before calculating coverage. Exclude content like API reference pages or changelog archives that you omit intentionally from llms.txt:

```bash
afdocs check https://example.com --coverage-exclusions "/docs/reference/**,/docs/changelog/**"
```

### Parity thresholds

| Flag                              | Default | Description                                                               |
| --------------------------------- | ------- | ------------------------------------------------------------------------- |
| `--parity-pass-threshold <n>`     | `5`     | Maximum missing % to pass (lower = stricter)                              |
| `--parity-warn-threshold <n>`     | `20`    | Maximum missing % to avoid failure (lower = stricter)                     |
| `--parity-exclusions <selectors>` |         | Comma-separated CSS selectors to strip from HTML before parity comparison |

These control the `markdown-content-parity` check, which compares HTML content against markdown to detect drift. Set both thresholds to `0` to make the check informational: it still reports the missing percentage, but doesn't warn or fail. This is useful for sites that intentionally serve different content to different audiences.

The check also has built-in support for the `data-markdown-ignore` HTML attribute. Elements with this attribute are stripped from the HTML before comparison, so human-only content doesn't count as "missing" from markdown.

Use `--parity-exclusions` for platform-specific conventions beyond `data-markdown-ignore`:

```bash
# Strip elements with a custom class or data attribute
afdocs check https://example.com --parity-exclusions ".human-only-content,[data-audience='humans']"
```

## Exit codes

| Code | Meaning                     |
| ---- | --------------------------- |
| `0`  | All checks passed or warned |
| `1`  | One or more checks failed   |

This makes AFDocs usable in CI pipelines and shell scripts. A warning does not cause a non-zero exit. See [CI Integration](/ci-integration) for full setup.

## Global flags

| Flag        | Description              |
| ----------- | ------------------------ |
| `--version` | Print the version number |
| `--help`    | Print help information   |
