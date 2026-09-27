# What Is the Agent Score?

The Agent Score is a 0–100 rating of how well AI coding agents can discover, navigate, and consume your documentation site. You can get your score with [AFDocs](https://www.npmjs.com/package/afdocs), which runs 23 automated checks based on the [Agent-Friendly Documentation Spec](https://agentdocsspec.com/spec/web/) and maps the results to a letter grade.

The AI coding agents that regularly consume your documentation while helping developers perform tasks include:

- Claude Code
- Codex
- Cursor
- Gemini CLI
- GitHub Copilot
- Windsurf

And more.

This is a distinct audience from LLM and AI answer engine crawlers, and they need different things from your documentation.

## Why agent-friendliness matters

When agents can't use your docs, they fall back on training data (which may be outdated) or look for content elsewhere. That means developers get bad answers, your support costs go up, and competitors with more agent-friendly docs gain an advantage.

A good Agent Score means agents can reach your content, read it in a useful format, and navigate it reliably. That creates better outcomes for developers using those agents.

For the full business case, including how agents fail on documentation, the concrete impact, and how to make the case internally, see [Why Agent-Friendliness Matters](/why-agent-friendliness-matters).

## What the score measures

The 28 checks cover seven categories:

| Category                                                   | What it tests                                                                                      |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| [Content Discoverability](/checks/content-discoverability) | Can agents find your docs? Do you have an `llms.txt`? Do pages tell agents where to look?          |
| [Markdown Availability](/checks/markdown-availability)     | Can agents get content in markdown (their preferred format) via `.md` URLs or content negotiation? |
| [Page Size](/checks/page-size)                             | Will agents hit truncation limits? Are pages server-rendered, or do agents get empty SPA shells?   |
| [Content Structure](/checks/content-structure)             | Do tabbed UI components blow up page size? Are code fences properly closed?                        |
| [URL Stability](/checks/url-stability)                     | Do error pages return real 404s? Do redirects use standard HTTP methods?                           |
| [Observability](/checks/observability)                     | Is your `llms.txt` fresh? Do markdown and HTML versions match? Are cache headers reasonable?       |
| [Authentication](/checks/authentication)                   | Can agents reach your docs at all, or is everything behind a login wall or bot protection?         |

Not all checks carry equal weight. Authentication failures and missing `llms.txt` are critical, while cache header issues are refinements. The scoring system accounts for this with [weight tiers](/agent-score-calculation#check-weights-by-category) and [score caps](/agent-score-calculation#score-caps) that prevent high scores when fundamental problems exist.

## Letter grades

| Grade  | Score | What it means                                                                |
| ------ | ----- | ---------------------------------------------------------------------------- |
| **A+** | 100   | Every check passes. Agents can fully navigate and consume your docs.         |
| **A**  | 90–99 | Excellent. Agents can use your documentation with minimal friction.          |
| **B**  | 80–89 | Good. Minor improvements possible; most content is accessible to agents.     |
| **C**  | 70–79 | Functional but with notable gaps. Some content is inaccessible or degraded.  |
| **D**  | 60–69 | Significant barriers. Agents struggle to use your documentation effectively. |
| **F**  | 0–59  | Agents likely cannot use your documentation in a meaningful way.             |

## What the scorecard looks like

The score is part of a larger scorecard that includes per-category breakdowns, system-level diagnostics that emerge from combinations of check results, and individual check results with fix suggestions:

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

The [Interaction Diagnostics](/interaction-diagnostics) section covers amplification effects between checks. When some check failures compound, the agent impact is more pronounced than individual check failures imply. This includes things like having markdown support that agents can't discover, page sizes that exceed limits with no alternate format available, or the tool discovering only a single page to test (which causes page-level categories to display as N/A rather than showing potentially misleading scores).

## What to do with your score

If you already have a score and want to improve it, the [Improve Your Score](/improve-your-score) guide walks you through the highest-impact fixes in priority order.

If you want to understand the math behind the number, [Score Calculation](/agent-score-calculation) covers the weights, proportional scoring, and interaction effects that produce the final score.

If you want to run it yourself, [Quick Start](/quick-start) has you up and running in one command.
