# Powered by AFDocs

AFDocs provides an agent-readiness score for your docs. Several hosted products and services, as well as open-source tools, use AFDocs under the hood to check docs for agent accessibility.

This page lists products, services, and tools that run AFDocs with public acknowledgement. Entries are listed alphabetically.

## Hosted products and services

| Product                                                                         | What it is                                                                                                                                            | How it runs AFDocs                                                                                                                                                                        |
| ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [CNCF CLOMonitor](https://clomonitor.io/docs/topics/checks/#agent-readiness)    | Project health monitor for CNCF and other open-source foundations. Its "Agent readiness" section reports one advisory check per AFDocs category.      | Runs the `afdocs` library against each project's docs site. Source: [`cncf/clomonitor`](https://github.com/cncf/clomonitor).                                                              |
| [Document360 Agent Score](https://document360.com/agent-score/)                 | Free grader from the Document360 knowledge-base platform. Submit a docs URL, get a 0 to 100 score and letter grade.                                   | Crawls a sample of pages and runs the AFDocs checks on them.                                                                                                                              |
| [Documentation.ai Agent Readiness Score](https://documentation.ai/agent-score)  | Free grader that combines AFDocs access checks with Documentation.ai's own freshness and answerability checks.                                        | Published as [`@documentation.ai/agent-score`](https://www.npmjs.com/package/@documentation.ai/agent-score), which depends on `afdocs`.                                                   |
| [Fern Agent Score](https://buildwithfern.com/agent-score)                       | Public directory of agent-readiness scores for developer documentation sites.                                                                         | The scoring engine depends on `afdocs`. Source: [`fern-api/agent-score`](https://github.com/fern-api/agent-score).                                                                        |
| [Mintlify Agent Score](https://www.mintlify.com/score)                          | Public score directory and the `mint score` CLI command.                                                                                              | Built on AFDocs, with additional checks based on Mintlify's own research.                                                                                                                 |
| [plym Agent Readiness Score](https://plym.io/tools/agent-readiness)             | Free grader from the plym blogging platform. Submit a docs root URL, get a 0 to 100 score and letter grade, and share the report by a permanent link. | Discovers pages from `llms.txt` and the sitemap, samples up to 50, and runs the `afdocs` checks on them, weighted by impact. Each report names the `afdocs` version it ran as its engine. |
| [Promptless Agent Score](https://promptless.ai/agent-score)                     | Free hosted grader from Promptless. Submit a docs site URL, get a 0 to 100 score with public reports, score history, and a leaderboard.               | Runs the `afdocs` checks against the submitted docs site.                                                                                                                                 |
| [Promptless Starport](https://promptless.ai/docs/for-docs/starport/agent-ready) | Documentation product with a built-in agent-readiness check.                                                                                          | Runs an `afdocs` check against your deployed docs site on a daily schedule.                                                                                                               |

## Open-source tools

| Tool                                                                  | What it is                                                                       | How it runs AFDocs                               |
| --------------------------------------------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------ |
| [`aeo-ready`](https://github.com/katrinalaszlo/aeo-ready)             | Benchmark aggregator that runs several agent-readiness scanners in one pass.     | npm dependency on `afdocs`.                      |
| [`llms-agent-score`](https://github.com/Chris-ganta/llms-agent-score) | Terminal UI for scoring and improving a documentation site.                      | npm dependency on `afdocs`.                      |
| [`siteready`](https://dkdev24.github.io/siteready/)                   | Scans a site with several agent-readiness scanners and reports a unified result. | Invokes the `afdocs` CLI as one of its scanners. |

## Get listed

If your product or tool runs AFDocs, feel free to add it here. I ask for three things:

1. **It runs AFDocs.** Your product depends on the `afdocs` package, invokes the CLI, or calls the [programmatic API](/reference/programmatic-api). A tool that reimplements the checks without running AFDocs is a spec implementation, not an AFDocs integration; see the [Agent-Friendly Documentation Spec](https://agentdocsspec.com/spec/web/) for that.
2. **It publicly credits AFDocs.** The page where users see the score names AFDocs and links to afdocs.dev. I've provided a badge below to make this easy.
3. **It's publicly available.** Free, paid, or open source all qualify. Internal tools or dashboards aren't publicly available, so they're not listed here.

If you'd like to be listed, open a pull request that adds one row to the appropriate table above, in alphabetical order, with the same three columns. Keep the "how it runs AFDocs" cell factual: dependency, CLI, or API, and a source link if the code is public.

If you would rather not open a pull request, [file a listing request](https://github.com/agent-ecosystem/afdocs/issues/new?template=powered-by-listing.md) and a maintainer will add the row.

We'll periodically re-check these products and services, and remove entries when a product stops running AFDocs or its page goes away. If you are just running AFDocs on your own documentation, you don't need a listing; see [CI Integration](/ci-integration) instead.

## Badge

For convenience, feel free to use this badge wherever your product shows an AFDocs-backed score and link it to afdocs.dev.

<p>
  <a href="https://afdocs.dev/powered-by"><img src="/badges/powered-by-afdocs.svg" alt="Powered by AFDocs" width="134" height="20"></a>
  &nbsp;&nbsp;
  <a href="https://afdocs.dev/powered-by"><img src="/badges/powered-by-afdocs-dark.svg" alt="Powered by AFDocs" width="134" height="20"></a>
</p>

Markdown:

```md
[![Powered by AFDocs](https://afdocs.dev/badges/powered-by-afdocs.svg)](https://afdocs.dev/powered-by)
```

HTML:

```html
<a href="https://afdocs.dev/powered-by">
  <img
    src="https://afdocs.dev/badges/powered-by-afdocs.svg"
    alt="Powered by AFDocs"
    width="134"
    height="20"
  />
</a>
```

Use `powered-by-afdocs-dark.svg` on dark backgrounds. The badge is for products that run AFDocs; please don't use it to mean "scores well on AFDocs."

## A note on versions

AFDocs is pre-1.0, and the check set grows between versions: spec v0.5.0 had 23 checks, spec v0.6.0 has 28. A product pinned to an older release reports the older check count, so two products can give the same site different scores and both be running AFDocs correctly. If a score matters to you, check which version the product runs, or run the [current release](/quick-start) yourself.
