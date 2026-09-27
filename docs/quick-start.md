# Quick Start

## Requirements

Node.js 22 or later.

## Run your first check

No install needed. Point AFDocs at your documentation site:

```bash
npx afdocs check https://docs.example.com --format scorecard
```

This discovers pages from your site (via llms.txt, sitemap, or both), samples up to 50, runs all 25 checks, and produces a scorecard with your overall score, per-category breakdowns, and fix suggestions:

```
Agent-Friendly Docs Scorecard
==============================

  Overall Score: 72 / 100 (C)

  Category Scores:
    Content Discoverability           72 / 100 (C)
    Markdown Availability             60 / 100 (C)
    Page Size and Truncation Risk     45 / 100 (D)
    ...

  Interaction Diagnostics:
    [!] Markdown support is undiscoverable
        Your site serves markdown at .md URLs, but agents have no way to
        discover this. ...

  Check Results:
    Content Discoverability
      PASS  llms-txt-exists        llms.txt found at /llms.txt
      WARN  llms-txt-size          llms.txt is 65,000 characters
      FAIL  llms-txt-directive-html No directive detected in HTML of any tested page
            Fix: Add a blockquote near the top of each page ...
```

To understand what the score means and how it's calculated, see [What Is the Agent Score?](/what-is-agent-score).

## See what's wrong and how to fix it

### Get your score

The scorecard shown above is the best starting point. It gives you the overall score, per-category breakdowns, [interaction diagnostics](/interaction-diagnostics), and fix suggestions for every failing check, all in one view:

```bash
npx afdocs check https://docs.example.com --format scorecard
```

### Dig into per-page details

When you're ready to fix specific issues, switch to the text format with `--verbose` and `--fixes`. This tells you exactly which pages have problems and what to do about them:

```bash
npx afdocs check https://docs.example.com --verbose --fixes
```

The scorecard tells you _what's wrong_. The verbose text output tells you _where_.

### Get machine-readable output

For scripting and automation, use JSON output. Add `--score` to include scoring data and fix suggestions:

```bash
npx afdocs check https://docs.example.com --format json --score
```

## Run specific checks

If you're working on a particular issue, you don't need to run all 25 checks every time. Pass a comma-separated list of check IDs:

```bash
npx afdocs check https://docs.example.com --checks llms-txt-exists,llms-txt-valid,llms-txt-size
```

Some checks depend on others. For example, `llms-txt-valid` requires `llms-txt-exists` to pass first; if you run `llms-txt-valid` alone, it will skip. When running a subset, include the dependencies too.

See the [Checks Reference](/checks/) for the full list of check IDs and dependencies.

## Check a specific page

Skip page discovery entirely and check just one URL with `--sampling none`:

```bash
npx afdocs check https://docs.example.com/api/auth --sampling none
```

You can combine this with `--checks` to run a single check against a single page:

```bash
npx afdocs check https://docs.example.com/api/auth --sampling none --checks rendering-strategy
```

## Check a specific set of pages

If you want to check a handful of pages without running full discovery, pass them directly with `--urls`:

```bash
npx afdocs check https://docs.example.com --urls https://docs.example.com/quickstart,https://docs.example.com/api/auth
```

This skips page discovery and runs all checks against exactly those URLs. You can tag pages for grouped scoring by defining them in a config file:

```yaml
# agent-docs.config.yml
url: https://docs.example.com
pages:
  - url: https://docs.example.com/quickstart
    tag: getting-started
  - url: https://docs.example.com/tutorials/first-app
    tag: getting-started
  - url: https://docs.example.com/api/auth
    tag: api-reference
  - url: https://docs.example.com/api/webhooks
    tag: api-reference
```

```bash
npx afdocs check --format scorecard
```

The scorecard will include a Tag Scores section showing how each group of pages scores, with a per-check breakdown of what's passing and failing within each tag. The JSON output (`--format json --score`) includes full per-page detail for each tag. See [Config File Reference](/reference/config-file) for the full `pages` schema.

## Get consistent results between runs

By default, AFDocs randomly samples pages, so results can vary between runs. For reproducible results (useful when verifying a fix), use deterministic sampling:

```bash
npx afdocs check https://docs.example.com --sampling deterministic
```

This sorts discovered URLs alphabetically and picks an even spread, producing the same sample every time as long as your site's URL set is stable.

## Tune request behavior

AFDocs is designed to be a good citizen. It enforces delays between requests and caps concurrent connections. If you need to adjust these:

```bash
# Slower, gentler requests (for rate-limited servers)
npx afdocs check https://docs.example.com --request-delay 500 --max-concurrency 1

# Faster runs (for your own infrastructure)
npx afdocs check https://docs.example.com --request-delay 50 --max-concurrency 10

# Sample fewer pages for a quicker check
npx afdocs check https://docs.example.com --max-links 10
```

For the full list of flags, see the [CLI Reference](/reference/cli).

## Exit codes

AFDocs exits with `0` if all checks pass or warn, and `1` if any check fails. This makes it usable in CI pipelines and shell scripts. See [CI Integration](/ci-integration) for full setup.

## Installing

`npx` downloads and runs AFDocs on demand, which is fine for getting started and one-off checks. If you run it regularly, you can install it for faster startup:

```bash
# Global install — puts `afdocs` on your PATH
npm install -g afdocs
afdocs check https://docs.example.com

# Project dev dependency — for CI and test suites
npm install -D afdocs
```

For CI integration with vitest helpers, see [CI Integration](/ci-integration).

## Next steps

- [Improve Your Score](/improve-your-score) — a prioritized workflow for fixing what the checks found
- [Run Locally](/run-locally) — iterate against a local dev server
- [CI Integration](/ci-integration) — add checks to your CI pipeline
- [Checks Reference](/checks/) — what each check measures and why
