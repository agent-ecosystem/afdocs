# Config File

The `agent-docs.config.yml` file lets you define a reusable configuration for running `afdocs` checks. It works with both the CLI and the [vitest test helpers](/ci-integration).

## Format

```yaml
# Required: the URL to check
url: https://docs.example.com

# Optional: run only specific checks
checks:
  - llms-txt-exists
  - llms-txt-valid
  - llms-txt-size
  - llms-txt-links-resolve
  - rendering-strategy
  - page-size-html
  - http-status-codes
  - auth-gate-detection

# Optional: skip specific checks (run everything else)
# skipChecks:
#   - markdown-content-parity

# Optional: override default options
options:
  maxLinksToTest: 20
  samplingStrategy: deterministic
  maxConcurrency: 5
  requestDelay: 100
  preferredLocale: en
  preferredVersion: v3
  canonicalOrigin: https://example.com
  llmsTxtUrl: https://example.com/docs/llms.txt
  thresholds:
    pass: 50000
    fail: 100000
  # Coverage check: thresholds and exclusions
  # coveragePassThreshold: 95
  # coverageWarnThreshold: 80
  # coverageExclusions:
  #   - /docs/reference/**
  #   - /docs/changelog/**
  #   - "**/release-notes/**"  # quote patterns starting with *
  # Parity check: thresholds and exclusions
  # parityPassThreshold: 5
  # parityWarnThreshold: 20
  # parityExclusions:
  #   - .human-only-content
  #   - '[data-audience="humans"]'  # quote selectors starting with [ (YAML treats unquoted [] as arrays)

# Optional: test specific pages instead of discovering via llms.txt/sitemap
# pages:
#   - https://docs.example.com/quickstart
#   - url: https://docs.example.com/api/auth
#     tag: api-reference
```

## Fields

### `url` (required)

The documentation site URL to check. This is the only required field.

### `checks` (optional)

A list of check IDs to run. If omitted, all 23 checks run. Use this to focus on checks that are actionable for your platform. See the [Checks Reference](/checks/) for the full list of check IDs.

This is particularly useful when your docs platform doesn't support certain capabilities. For example, if you can't serve markdown, exclude the markdown-related checks so your score reflects what you can control. See [Improve Your Score](/improve-your-score#step-3-work-through-fixes-iteratively) for more on this approach.

### `skipChecks` (optional)

A list of check IDs to skip. Unlike `checks` (which is an include-list), `skipChecks` is an exclude-list — all checks run except the ones listed here. Skipped checks appear in the report with `status: "skip"` and are excluded from scoring.

Use this when you want to disable a specific check without having to list all the others:

```yaml
skipChecks:
  - markdown-content-parity
```

### `options` (optional)

Override default runner options. All fields are optional:

| Field                   | Default     | Description                                                                                              |
| ----------------------- | ----------- | -------------------------------------------------------------------------------------------------------- |
| `maxLinksToTest`        | `50`        | Maximum number of pages to sample                                                                        |
| `samplingStrategy`      | `random`    | `random`, `deterministic`, `curated`, or `none`                                                          |
| `maxConcurrency`        | `3`         | Maximum concurrent HTTP requests                                                                         |
| `requestDelay`          | `200`       | Delay between requests in milliseconds                                                                   |
| `requestTimeout`        | `30000`     | Timeout for individual HTTP requests in milliseconds                                                     |
| `preferredLocale`       | auto-detect | Preferred locale for URL discovery (e.g. `en`, `fr`, `ja`)                                               |
| `preferredVersion`      | auto-detect | Preferred version for URL discovery (e.g. `v3`, `2.x`)                                                   |
| `canonicalOrigin`       |             | The production base URL (origin, or origin plus a path prefix) your content links to                     |
| `llmsTxtUrl`            |             | Explicit llms.txt URL to use as canonical (overrides the discovery heuristic; see CLI docs)              |
| `thresholds.pass`       | `50000`     | Page size pass threshold in characters                                                                   |
| `thresholds.fail`       | `100000`    | Page size fail threshold in characters                                                                   |
| `coveragePassThreshold` | `95`        | `llms-txt-coverage` pass threshold: minimum coverage % to pass (higher = stricter)                       |
| `coverageWarnThreshold` | `80`        | `llms-txt-coverage` warn threshold: minimum coverage % to avoid failure (higher = stricter)              |
| `coverageExclusions`    |             | Glob patterns to exclude from the sitemap before calculating coverage (quote patterns starting with `*`) |
| `parityPassThreshold`   | `5`         | `markdown-content-parity` pass threshold: maximum missing % to pass (lower = stricter)                   |
| `parityWarnThreshold`   | `20`        | `markdown-content-parity` warn threshold: maximum missing % to avoid failure (lower = stricter)          |
| `parityExclusions`      |             | CSS selectors to strip from HTML before parity comparison                                                |

### `pages` (optional)

A list of specific page URLs to test. When `pages` is present and no `samplingStrategy` is explicitly set, the strategy defaults to `curated`, which skips discovery and tests exactly the listed pages.

Each entry can be a plain URL string or an object with `url` and an optional `tag` for grouped scoring:

```yaml
url: https://docs.example.com

pages:
  # Plain URL strings
  - https://docs.example.com/quickstart
  - https://docs.example.com/install

  # Objects with tags for grouped scoring
  - url: https://docs.example.com/api/auth
    tag: api-reference
  - url: https://docs.example.com/api/users
    tag: api-reference
```

When pages have tags, the scorecard and JSON output include per-tag aggregate scores, making it easy to compare agent-friendliness across sections of your documentation.

Tags are optional and can be mixed with plain URL strings. Pages without tags are included in the overall score but don't appear in any tag group.

Note that `maxLinksToTest` does not apply to curated pages; all listed pages are tested.

## Config resolution

The config loader searches for `agent-docs.config.yml` (or `.yaml`) starting from the current working directory and walking up the directory tree, similar to how ESLint and Prettier find their config files. This means the config works whether you're running the CLI from your project root or running a test file from a subdirectory.

For the vitest helpers, you can also pass an explicit directory:

```ts
import { describeAgentDocsPerCheck } from 'afdocs/helpers';

describeAgentDocsPerCheck(__dirname);
```

## Multiple configs

You might maintain separate configs for different contexts (local development, staging, production). Use `--config` to select one at runtime:

```bash
afdocs check --config agent-docs.local.yml
afdocs check --config agent-docs.staging.yml
```

A common pattern: point `agent-docs.config.yml` at your production URL (CI auto-discovers this), and override just the URL on the command line when running locally:

```bash
# Production config is auto-discovered; URL is overridden for local dev
afdocs check http://localhost:3000
```

CLI flags always take precedence over config values.
