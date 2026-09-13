# Content Discoverability

How agents find and navigate your documentation. This category covers `llms.txt`: whether it exists, whether agents can parse it, whether the links work, and whether agents visiting individual pages know it's there.

These seven checks carry the most combined weight of any category. Without discoverability, everything else is less useful.

## llms-txt-exists

Whether your site has an `llms.txt` file at a discoverable location.

|            |                                                                                                |
| ---------- | ---------------------------------------------------------------------------------------------- |
| **Weight** | Critical (10)                                                                                  |
| **Spec**   | [llms-txt-exists](https://agentdocsspec.com/spec/web/content-discoverability/#llms-txt-exists) |

### Why it matters

`llms.txt` is the most effective navigation mechanism observed for agents. When agents find one, or are intentionally pointed to it, this gives agents the ability to navigate a documentation site. Without it, agents resort to guessing URLs from training data. They do _not_ read your navigation structure, and in cases where agent platforms automatically convert HTML to markdown before providing it to agents, they literally can't _see_ your navigation structure.

### Results

| Result | Condition                                                                 |
| ------ | ------------------------------------------------------------------------- |
| Pass   | `llms.txt` found at one or more candidate locations, returning 200        |
| Warn   | Reachable only via a cross-host redirect (some agents don't follow these) |
| Fail   | Not found at any candidate location                                       |

### Candidate locations

AFDocs checks up to three URLs, depending on the URL you pass:

| Candidate                | Example                                                                      |
| ------------------------ | ---------------------------------------------------------------------------- |
| `{baseUrl}/llms.txt`     | `https://example.com/docs/llms.txt` (if you pass `https://example.com/docs`) |
| `{origin}/llms.txt`      | `https://example.com/llms.txt`                                               |
| `{origin}/docs/llms.txt` | `https://example.com/docs/llms.txt`                                          |

Duplicates are removed, so in practice fewer URLs may be checked (e.g., if your `baseUrl` is `https://example.com/docs`, the first and third rows produce the same URL).

If any of these redirect cross-host (e.g., `example.com` redirects to `docs.example.com`), AFDocs also probes `{redirected_origin}/llms.txt` as a fallback.

If your `llms.txt` lives at a location not covered by these candidates, AFDocs won't find it. You can either move it to one of the candidate locations or [open an issue](https://github.com/agent-ecosystem/afdocs/issues) to suggest expanding the candidate list.

### Canonical selection

When more than one candidate returns a file (e.g. an apex `llms.txt` for the marketing site _and_ a `/docs/llms.txt` for the docs section), AFDocs picks one as **canonical**. The canonical file is the single source of truth for downstream checks: link sampling, size, validation, coverage, and link-resolution all operate on it alone. Other discovered files still appear in `details.discoveredFiles` for visibility, and `cache-header-hygiene` still verifies headers on every llms.txt found.

The selection rule is _most-specific-to-the-baseUrl wins_. AFDocs picks the file whose directory is the longest prefix of the URL you passed. For example:

| You passed            | Files found                                 | Canonical                       |
| --------------------- | ------------------------------------------- | ------------------------------- |
| `example.com/docs`    | `/llms.txt` and `/docs/llms.txt`            | `/docs/llms.txt`                |
| `example.com`         | `/llms.txt` and `/docs/llms.txt`            | `/llms.txt`                     |
| `example.com/docs/v1` | `/llms.txt`, `/docs/llms.txt`, `/docs/v1/…` | `/docs/v1/llms.txt`             |
| `example.com/docs/v1` | `/llms.txt` and `/docs/llms.txt`            | `/docs/llms.txt` (longer match) |

Use `--llms-txt-url` (or the `llmsTxtUrl` config option) to override the heuristic when the canonical lives at a non-standard path. See the [CLI reference](/reference/cli#llms-txt-selection) for details.

### How to fix

**If this check fails**, create an `llms.txt` at one of the candidate locations above. The file should contain an H1 title, a blockquote summary, and markdown links to your key documentation pages. See the [llms.txt specification](https://llmstxt.org/) for the format.

This is the single highest-impact improvement for agent access to your docs. It also unblocks five dependent checks that are currently skipped.

**If this check warns**, your `llms.txt` is only reachable via a cross-host redirect. Serve it directly from the same host as your documentation, or add a same-host redirect.

### Score impact

If this check fails, the score is [capped at D (59)](/agent-score-calculation#score-caps) regardless of everything else.

---

## llms-txt-valid

Whether your `llms.txt` follows the [llmstxt.org](https://llmstxt.org/) structure so agents can parse it reliably.

|                |                                                                                              |
| -------------- | -------------------------------------------------------------------------------------------- |
| **Weight**     | Medium (4)                                                                                   |
| **Depends on** | `llms-txt-exists`                                                                            |
| **Spec**       | [llms-txt-valid](https://agentdocsspec.com/spec/web/content-discoverability/#llms-txt-valid) |

### Why it matters

A well-structured `llms.txt` gives agents a reliable map of the documentation. Inconsistent implementations reduce its value, though even a non-standard file with useful links is better than nothing.

### Results

| Result | Condition                                                                                                    |
| ------ | ------------------------------------------------------------------------------------------------------------ |
| Pass   | Follows the proposed structure: H1 title, blockquote summary, heading-delimited sections with markdown links |
| Warn   | Contains parseable markdown links but doesn't follow the proposed structure                                  |
| Fail   | Exists but contains no parseable links or is empty                                                           |

### How to fix

**If this check warns**, add an H1 title as the first line and a blockquote summary (lines starting with `>`) to improve agent parsing.

**If this check fails**, add links in `[name](url): description` format under heading-delimited sections.

---

## llms-txt-size

Whether your `llms.txt` fits within agent context windows.

|                |                                                                                            |
| -------------- | ------------------------------------------------------------------------------------------ |
| **Weight**     | High (7)                                                                                   |
| **Depends on** | `llms-txt-exists`                                                                          |
| **Spec**       | [llms-txt-size](https://agentdocsspec.com/spec/web/content-discoverability/#llms-txt-size) |

### Why it matters

An `llms.txt` that exceeds truncation limits defeats its purpose. Some agent platforms see only the first 50K-100K characters; links, structure, and content beyond that point are invisible. This is arguably worse than the truncation problem affecting documentation pages, because `llms.txt` is supposed to be the solution to navigation.

### Results

| Result | Condition                                                                |
| ------ | ------------------------------------------------------------------------ |
| Pass   | Under 50,000 characters                                                  |
| Warn   | 50,000-100,000 characters (fits within some agent platforms but not all) |
| Fail   | Over 100,000 characters (likely truncated by major agent platforms)      |

### How to fix

**If this check warns**, keep an eye on it. If your `llms.txt` grows further, split it before it crosses the 100K threshold.

**If this check fails**, split into a root `llms.txt` that links to section-level files, each under 50,000 characters. For example, a root index might link to `/api/llms.txt`, `/guides/llms.txt`, and `/reference/llms.txt`.

### Score impact

When `llms.txt` is oversized, the [index truncation coefficient](/agent-score-calculation#index-truncation-coefficient) discounts the value of downstream checks that measure the quality of content agents can't see.

---

## llms-txt-links-resolve

Whether the URLs listed in your `llms.txt` actually work.

|                |                                                                                                              |
| -------------- | ------------------------------------------------------------------------------------------------------------ |
| **Weight**     | High (7)                                                                                                     |
| **Depends on** | `llms-txt-exists`                                                                                            |
| **Spec**       | [llms-txt-links-resolve](https://agentdocsspec.com/spec/web/content-discoverability/#llms-txt-links-resolve) |

### Why it matters

A stale `llms.txt` with broken links is worse than no `llms.txt` at all. It sends agents down dead ends with high confidence, because agents treat `llms.txt` as an authoritative source. Broken links are often pages that were renamed or removed without updating `llms.txt`.

### Results

| Result | Condition                      |
| ------ | ------------------------------ |
| Pass   | All links resolve (return 200) |
| Warn   | Over 90% of links resolve      |
| Fail   | Under 90% of links resolve     |

### How to fix

Run with `--verbose` to see which specific links are broken. These are usually pages that were renamed or removed. Either update the links in `llms.txt` or remove entries for pages that no longer exist.

The best long-term fix is generating `llms.txt` at build time so it stays in sync automatically.

---

## llms-txt-links-markdown

Whether the URLs in your `llms.txt` point to markdown content rather than HTML.

|                |                                                                                                                |
| -------------- | -------------------------------------------------------------------------------------------------------------- |
| **Weight**     | High (7)                                                                                                       |
| **Depends on** | `llms-txt-exists`                                                                                              |
| **Spec**       | [llms-txt-links-markdown](https://agentdocsspec.com/spec/web/content-discoverability/#llms-txt-links-markdown) |

### Why it matters

Markdown is more useful for agents than HTML. It omits the unnecessary tokens introduced by HTML in the page, and gives the agents clear content in an easy-to-parse format. An `llms.txt` pointing to HTML misses the opportunity to deliver content in the most agent-friendly format. Agents don't discover `.md` URL variants on their own; they follow whatever link `llms.txt` gives them.

### Results

| Result | Condition                                                                                     |
| ------ | --------------------------------------------------------------------------------------------- |
| Pass   | All or most links point to markdown content                                                   |
| Warn   | Links point to HTML, but markdown versions are available (detected by testing `.md` variants) |
| Fail   | Links point to HTML and no markdown alternatives detected                                     |

### How to fix

**If this check warns**, your site serves markdown but your `llms.txt` links to the HTML versions. Update the links to use `.md` URLs. This is usually a find-and-replace.

**If this check fails**, your `llms.txt` links to HTML and no markdown is available. See [Markdown Availability](/checks/markdown-availability) for how to serve markdown.

### Score impact

A warning on this check carries a bigger penalty in scoring because it means markdown exists but agents are being actively steered away from it.

---

## llms-txt-directive-html

Whether the HTML version of your documentation pages tells agents where to find `llms.txt`.

|            |                                                                                                                |
| ---------- | -------------------------------------------------------------------------------------------------------------- |
| **Weight** | High (7)                                                                                                       |
| **Spec**   | [llms-txt-directive-html](https://agentdocsspec.com/spec/web/content-discoverability/#llms-txt-directive-html) |

### Why it matters

Agents that fetch the HTML version of your pages have no built-in way to discover that a documentation index exists at `/llms.txt`. An in-page directive serves as an agent "You Are Here" marker that points them to the index. The directive can be visually hidden (e.g., using a CSS clip-rect technique or `sr-only` class) as long as it remains in the DOM and survives HTML-to-markdown conversion.

This check searches within the HTML `<body>` but excludes `<nav>`, `<script>`, and `<style>` elements. Navigation sidebar links to pages _about_ llms.txt (e.g., a docs page describing the llms.txt feature) are not counted as directives.

### Results

| Result | Condition                                                                      |
| ------ | ------------------------------------------------------------------------------ |
| Pass   | Directive found in HTML of all or nearly all documentation pages, near the top |
| Warn   | Found on some pages but missing from others, or buried past 50% of content     |
| Fail   | Not detected in the HTML of any tested page                                    |

### How to fix

Add a visually-hidden element near the top of each page (e.g., a `<div>` with CSS clip-rect) containing a link to your `llms.txt`. If your site serves markdown versions of pages, mention that in the directive too so agents know to request it. This can be added through your docs platform's page template or layout component. Use server-rendered HTML, not client-side JavaScript injection.

---

## llms-txt-directive-md

Whether the markdown version of your documentation pages tells agents where to find `llms.txt`.

|                |                                                                                                            |
| -------------- | ---------------------------------------------------------------------------------------------------------- |
| **Weight**     | Medium (4)                                                                                                 |
| **Depends on** | `markdown-url-support` or `content-negotiation`                                                            |
| **Spec**       | [llms-txt-directive-md](https://agentdocsspec.com/spec/web/content-discoverability/#llms-txt-directive-md) |

### Why it matters

Agents that fetch markdown versions of pages (via `.md` URLs or content negotiation) benefit from a directive pointing them to the documentation index. Anthropic's Claude Code documentation includes a blockquote at the top of every markdown page telling agents to fetch the documentation index at `llms.txt`. In practice, agents that encounter this directive may follow it to discover the full documentation index.

This check is skipped if the site doesn't serve markdown (neither `markdown-url-support` nor `content-negotiation` passes).

### Results

| Result | Condition                                                                          |
| ------ | ---------------------------------------------------------------------------------- |
| Pass   | Directive found in markdown of all or nearly all documentation pages, near the top |
| Warn   | Found on some pages but missing from others, or buried past 50% of content         |
| Fail   | Not detected in the markdown of any tested page                                    |

### How to fix

Add a blockquote near the top of each markdown page pointing to your `llms.txt`. For example:

```markdown
> For the complete documentation index, see [llms.txt](/llms.txt)
```

The URL in the directive should match wherever you placed your `llms.txt`. If it's at `/docs/llms.txt`, use that path instead.

### Score impact

These checks are signals used by the [discovery coefficient](/agent-score-calculation#discovery-coefficient). If neither directive check nor content negotiation passes, downstream markdown quality checks are discounted because agents can't find the markdown path.
