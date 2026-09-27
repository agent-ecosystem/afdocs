<p align="center">
  <img src="docs/logos/afdoc_logo_light.svg" width="200" alt="AFDocs logo">
</p>

<h1 align="center">AFDocs</h1>

<p align="center">
  <a href="https://github.com/agent-ecosystem/afdocs/actions/workflows/ci.yml"><img src="https://github.com/agent-ecosystem/afdocs/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://www.npmjs.com/package/afdocs"><img src="https://img.shields.io/npm/v/afdocs" alt="npm"></a>
</p>

Test your documentation site against the [Agent-Friendly Documentation Spec](https://agentdocsspec.com). AFDocs runs checks across 7 categories to measure how well AI coding agents can discover, navigate, and consume your docs.

Powering [Agent Score](https://buildwithfern.com/agent-score) by Fern.

> **Status: Early development (0.x)**
> Check IDs, CLI flags, and output formats may change between minor versions.
> Implements [spec v0.6.0](https://agentdocsspec.com/spec/web/) (2026-08-24). The `bot-protection-interference` check is not yet scored; stalled responses currently surface as body-timeout fetch errors, with the run-level diagnostic tracked in [#104](https://github.com/agent-ecosystem/afdocs/issues/104).

## Quick start

```bash
npx afdocs check https://docs.example.com --format scorecard
```

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
            Fix: If it grows further, split into nested llms.txt files ...
      FAIL  llms-txt-directive-html No directive detected in HTML of any tested page
            Fix: Add a visually-hidden element near the top of each page ...
```

## Install

```bash
npm install -g afdocs
```

Or as a dev dependency for CI:

```bash
npm install -D afdocs
```

Requires Node.js 22 or later.

## Documentation

Full documentation is available at **[afdocs.dev](https://afdocs.dev)**:

- [Understand Your Score](https://afdocs.dev/what-is-agent-score) — what the score means and how it's calculated
- [Improve Your Score](https://afdocs.dev/improve-your-score) — prioritized fix guide
- [Checks Reference](https://afdocs.dev/checks/) — all 28 checks with fix suggestions
- [CLI Reference](https://afdocs.dev/reference/cli) — flags, output formats, sampling strategies
- [CI Integration](https://afdocs.dev/ci-integration) — vitest helpers for your pipeline
- [Programmatic API](https://afdocs.dev/reference/programmatic-api) — TypeScript API for custom tooling

## Responsible use

AFDocs makes HTTP requests to the sites it checks. It enforces delays between requests (200ms default), caps concurrent connections, and honors `Retry-After` headers.

## License

MIT
