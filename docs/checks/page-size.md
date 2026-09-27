# Page Size and Truncation Risk

Whether agents can process your pages without losing content. Agent platforms have diverse truncation limits, from 5K characters on some platforms to over 100K on others. Pages that exceed these limits are silently truncated: the agent sees the beginning of the page and loses the rest.

This category also covers the related problem of pages that technically fit within limits but waste most of that budget on boilerplate (navigation chrome, breadcrumbs, sidebars) instead of documentation content, the transfer-layer problem of pages that ship many times their content's weight in serialized framework payload, and pagination in markdown responses, which truncates at the application layer while looking complete.

## rendering-strategy

Whether pages contain server-rendered content or are empty client-side application shells.

|            |                                                                                        |
| ---------- | -------------------------------------------------------------------------------------- |
| **Weight** | Critical (10)                                                                          |
| **Spec**   | [rendering-strategy](https://agentdocsspec.com/spec/web/page-size/#rendering-strategy) |

### Why it matters

Many agents fetch pages using HTTP libraries that don't execute JavaScript. When a site relies on client-side rendering, agents receive an empty shell with framework boilerplate but none of the documentation content. This isn't a truncation problem; it's a zero-content problem.

The rendering strategy is a property of the framework and its configuration, not the content. Sites using Next.js, for example, can be fully agent-accessible (like react.dev) or deliver empty shells, depending on whether server-side rendering is enabled.

### Results

| Result | Condition                                                                                                                      |
| ------ | ------------------------------------------------------------------------------------------------------------------------------ |
| Pass   | Pages contain substantive server-rendered content (headings, prose, code blocks)                                               |
| Warn   | Pages render server-side but have unusually short body content (legitimately short pages, or partial hydration / lazy loading) |
| Fail   | SPA shell detected (framework markers like `id="__next"`, minimal visible text, no page-specific content)                      |

When the check warns, the [`sparse-content-html` diagnostic](/interaction-diagnostics#sparse-content-on-the-html-path) fires if more than 25% of sampled pages are sparse. When the check fails, the [`spa-shell-html-invalid` diagnostic](/interaction-diagnostics#spa-shells-invalidate-html-path) fires if more than 25% of sampled pages are actual shells.

### How to fix

**If this check warns**, spot-check the affected pages by fetching them with `curl` or another HTTP client that doesn't run JavaScript. If the pages contain their full intended content, no action is needed; some pages are legitimately brief. If content is missing from the server response, the page may use component-level client rendering or lazy loading for specific sections.

**If this check fails**, enable server-side rendering or static site generation in your docs platform. This is typically a configuration change, not a code rewrite.

### Score impact

This is a Critical check with two score caps based on a weighted proportion: `(serverRendered + sparseContent × 0.5) / total`. Empty SPA shells count fully against the proportion; sparse pages count at half weight.

- When the proportion is at most 0.50, the score is [capped at D (59)](/agent-score-calculation#score-caps).
- When the proportion is at most 0.25, the score is [capped at F (39)](/agent-score-calculation#score-caps).

The same proportion drives the [HTML path coefficient](/agent-score-calculation#html-path-coefficient). If 90% of pages render correctly with no sparse pages, HTML quality checks (`page-size-html`, `content-start-position`, `tabbed-content-serialization`, `section-header-quality`) count for 90% of their weight.

---

## page-size-markdown

Character count when documentation is served as markdown.

|                |                                                                                        |
| -------------- | -------------------------------------------------------------------------------------- |
| **Weight**     | High (7)                                                                               |
| **Depends on** | `markdown-url-support` or `content-negotiation`                                        |
| **Spec**       | [page-size-markdown](https://agentdocsspec.com/spec/web/page-size/#page-size-markdown) |

### Why it matters

This is the best-case scenario for agent consumption. Markdown size directly corresponds to what the model sees, with no conversion overhead. If the markdown version fits within limits, agents that can request it get full, untruncated content.

### Results

| Result | Condition                                                                    |
| ------ | ---------------------------------------------------------------------------- |
| Pass   | Under 50,000 characters                                                      |
| Warn   | 50,000-100,000 characters (fits within some platforms but may exceed others) |
| Fail   | Over 100,000 characters (truncated by all major agent platforms)             |

### How to fix

**If pages are too large**, break them into smaller pages or restructure serialized tabbed content. See [tabbed-content-serialization](/checks/content-structure#tabbed-content-serialization) for guidance on the most common source of oversized pages.

---

## page-size-html

Character count of the HTML response and the post-conversion size when converted to markdown.

|            |                                                                                |
| ---------- | ------------------------------------------------------------------------------ |
| **Weight** | High (7)                                                                       |
| **Spec**   | [page-size-html](https://agentdocsspec.com/spec/web/page-size/#page-size-html) |

### Why it matters

Many agents receive HTML, either because they don't request markdown or because the server doesn't support delivering markdown when requested. When agents receive HTML, the page size that matters isn't the raw HTML; it's how large the page is after the agent's platform converts it to text. Navigation boilerplate, serialized tabbed content, and deeply nested page structure can all inflate the converted output well beyond the documentation content itself. This can push the actual documentation content past agent truncation limits.

AFDocs measures both the raw HTML size and the post-conversion size, and scores based on the conversion result. See [content-start-position](#content-start-position) below for more on how boilerplate affects what agents see.

### Results

Based on post-conversion character count:

| Result | Condition                 |
| ------ | ------------------------- |
| Pass   | Under 50,000 characters   |
| Warn   | 50,000-100,000 characters |
| Fail   | Over 100,000 characters   |

The output also reports the conversion ratio. A page that converts from 505KB HTML to 12KB markdown has 98% boilerplate, meaning only 2% of the HTML was documentation content.

### How to fix

**If pages convert to too many characters**, review pages for reducible boilerplate (navigation, serialized tabbed content) and consider these fixes:

- **Large pages**: Break long reference pages into smaller sections.
- **Navigation boilerplate**: Reduce navigation, sidebar, and breadcrumb markup that inflates the converted output.
- **Tabbed content**: See [tabbed-content-serialization](/checks/content-structure#tabbed-content-serialization).
- **Generated tables and data blobs**: See [embedded-data-serialization](/checks/content-structure#embedded-data-serialization), which attributes the page's size to the specific elements responsible.
- **Markdown alternative**: Provide markdown versions as a smaller alternative path for agents that bypass HTML conversion overhead.

Markdown availability helps agents that request it, but most agents still fetch HTML, so fixing the HTML path remains important.

---

## page-size-transfer

How much an agent has to download to read one page: the size of the HTML page file as served, before anything in it is read. This is often many times larger than the content a reader sees.

|            |                                                                                        |
| ---------- | -------------------------------------------------------------------------------------- |
| **Weight** | Medium (4)                                                                             |
| **Spec**   | [page-size-transfer](https://agentdocsspec.com/spec/web/page-size/#page-size-transfer) |

### Why it matters

An agent fetches a page the way a browser does, but it does not run the page's JavaScript or lay it out. Everything in the page file, visible or not, counts against the agent's budget. Two things make that file larger than the content:

- **Framework payloads.** Many documentation platforms embed a copy of the page's data inside the page itself, in script tags, so the interactive version can be rebuilt in the browser. This [hydration payload](/glossary#hydration-payload) can include the page's entire content a second time, plus menus, metadata, and settings. The reader never sees it. The agent downloads all of it.
- **Download caps.** Some agent tools stop reading a page after a fixed number of bytes. Claude Code stops at about 10MB. Content past that point is unreachable no matter how well the rest converts.

`page-size-html` measures what is left after an agent strips the scripts and converts the page to text, which is how many agents work. This check measures what the agent had to download to get there. A page can pass one and fail the other. On one hosted documentation platform, pages measured for the spec carried 75-84% of their bytes as framework payload, at 40 to 200 times the size of their content. They score well on `page-size-html` because conversion removes the payload, and every agent still downloads half a megabyte to several megabytes per page.

### What is measured

AFDocs downloads each sampled page the way an agent's HTTP client would, with compression enabled, and counts the size of the page file after decompression, because that is what the agent has to process. Linked files (stylesheets, scripts, images) are not counted, because agents generally don't fetch them. Anything embedded in the page file itself is counted, because agents can't avoid receiving it.

The same download feeds `page-size-html`, so the served size and the converted content size come from the same response. When the server compressed the response, the compressed size is reported too; framework payloads compress well, so the compressed size understates the processing burden.

### Results

Based on the decompressed size of the page file:

| Result | Condition                                                                                     |
| ------ | --------------------------------------------------------------------------------------------- |
| Pass   | Under 1MB                                                                                     |
| Warn   | 1MB-10MB (no documented cap is exceeded, but most of what the agent downloads is not content) |
| Fail   | Over 10MB (exceeds Claude Code's download cap; content beyond it is unreachable)              |

These are byte thresholds, not character thresholds. Download caps are less documented than the character limits the other size checks use, so the defaults are conservative and configurable with `--transfer-pass-threshold` and `--transfer-fail-threshold` (or `transferThresholds` in the [config file](/reference/config-file)).

Each page is reported as served bytes alongside its converted content size and the ratio between them, for example `3.4MB served → 29KB content (~120:1)`. A ratio of 20:1 or more on an oversized page is treated as a platform signature: the bytes are framework payload or embedded duplicate content rather than documentation, and the fix suggestion says so.

### How to fix

**Who owns this.** Almost always the documentation platform or the engineers who configure it, not the writers. The extra bytes are added at build time by the framework, so the fix is a platform setting or a framework change. Hand the ratio from the report (`3.4MB served → 29KB content`) to whoever runs the platform; it tells them where to look.

**If this check warns**, find out what the non-content bytes are. In practice they are framework payloads visible in the page source: a copy of the page's data for the interactive version, an embedded duplicate of the page's markdown, resolved data objects. Avoid shipping the same content twice in different formats, load large data on demand, and make sure markdown versions of pages are available and discoverable so agents have a cheaper path.

**If this check fails**, take the same actions urgently. At this size, at least one major agent tool cuts the page off before the end.

Markdown availability gives agents that find it an escape hatch, but it does not shrink what agents on the [HTML path](/glossary#html-path-and-markdown-path) download; the served page still needs fixing.

This check complements [rendering-strategy](#rendering-strategy), which catches pages that ship too little content; this check catches the opposite failure, pages that render content fine but ship many times its weight in overhead. Unlike the other HTML-path checks it is not scaled by the [HTML path coefficient](/agent-score-calculation#html-path-coefficient): an empty shell's served bytes are still what the agent downloads.

---

## content-start-position

How far into the response actual documentation content begins.

|            |                                                                                                |
| ---------- | ---------------------------------------------------------------------------------------------- |
| **Weight** | Medium (4)                                                                                     |
| **Spec**   | [content-start-position](https://agentdocsspec.com/spec/web/page-size/#content-start-position) |

### Why it matters

After HTML-to-markdown conversion, boilerplate often survives. Navigation menus, breadcrumbs, sidebars, and footer content all convert to text that precedes or surrounds the actual documentation. Depending on the agent's conversion pipeline, inline CSS and JavaScript may also survive as raw text. If enough of this boilerplate appears before your actual content, the agent may never see your documentation at all because it hits truncation limits first.

In observed cases, actual content didn't start until 87% through the converted page: 441,000 characters of styling code before the first paragraph of actual documentation. The agent reported seeing a documentation page _about_ CSS instead of the actual documentation content.

### Results

Based on where content begins in the converted output:

| Result | Condition                           |
| ------ | ----------------------------------- |
| Pass   | Content starts within the first 10% |
| Warn   | Content starts between 10-50%       |
| Fail   | Content starts after 50%            |

### How to fix

**If this check warns or fails**, reduce navigation, breadcrumb, and sidebar markup that precedes the content area. These are the most common sources of boilerplate that pushes content past truncation limits.

If your platform inlines CSS or JavaScript, check whether you can reduce the amount or move it to external files. Navigation chrome, theme variables, and third-party widget styles all contribute to the boilerplate before content.

---

## single-fetch-completeness

Whether a markdown response delivers its complete content in one fetch, and when it doesn't, whether the continuation is machine-followable: declared where agents will see it, linked with an absolute URL, and actually working.

|                |                                                                                                      |
| -------------- | ---------------------------------------------------------------------------------------------------- |
| **Weight**     | Medium (4)                                                                                           |
| **Depends on** | `markdown-url-support`, `content-negotiation`, or `llms-txt-links-markdown`                          |
| **Spec**       | [single-fetch-completeness](https://agentdocsspec.com/spec/web/page-size/#single-fetch-completeness) |

### Why it matters

Pagination is application-level truncation, and it is quieter than the platform truncation the rest of this category measures. A paginated markdown response looks complete: it is well-formed, ends cleanly, and returns 200. The signals that it is partial are easy for agent pipelines to lose:

- **Summarization pipelines** run fetched content through a smaller model before the orchestrating agent sees it. A pagination note may not survive, and the summarizer cannot fetch the next page itself.
- **Trailing pagination notes** sit at the end of the content, the first region platform truncation removes. A truncated response loses the only indication that it was also paginated.
- **Retrieval pipelines** ([RAG](/glossary#rag)) cut content into chunks and store them for later lookup. A pagination marker lands in one chunk, unrelated to the content it describes, and effectively disappears.

The spec grounds this check in a production model catalog whose markdown variant showed 100 of 102 entries, with a pagination note at the bottom, a root-relative continuation URL, and a continuation response that returned an empty body. An agent fetching that page got 98% of the catalog and no working way to learn what was missing. The complete catalog would have serialized to about 32,000 characters, under this category's 50,000-character pass threshold. The pagination was inherited from the HTML UI, which has interaction, by a markdown variant that doesn't.

### What is measured

The check scans each sampled markdown page (the same responses `page-size-markdown` measures, so nothing is fetched twice) for pagination signals: "N of M" phrasing such as "Showing 100 of 102", links whose URL carries a paging parameter (`?page=2`, `?offset=100`, a cursor) or a `/page/2` segment, "next page" link text, and a `Link: rel="next"` response header. Fenced code and inline code are ignored, so API references that document pagination parameters don't register, and paging links to other hosts are ignored for the same reason. Ordinary prev/next navigation between separate pages is not a signal: a plain "Next" link counts only when its URL looks like pagination or points back at the same document with a different query.

When signals are found, the check fetches the earliest declared continuation (asking for markdown by header only when the URL does not already end in `.md` or `.mdx`, since some servers answer that header on a `.md` path with a 404) and verifies that it returns a success status, a non-empty body, markdown rather than HTML, not a [soft 404](/glossary#soft-404), and content different from the first page. A declaration counts as "at the top" when it falls within the first 10% of the content, bounded to between 1,000 and 5,000 characters, which keeps it ahead of the strictest documented platform truncation point.

Absence of signals is treated as complete. A markdown page that silently omits content is not detectable here; see [markdown-content-parity](/checks/observability#markdown-content-parity) for the cross-representation comparison that can catch it.

When a site serves markdown only through its llms.txt links (no `.md` page variants, no content negotiation), the check fetches that linked markdown itself, because it deserves the same evaluation.

### Results

Each sampled markdown page is scored; the overall result is proportional.

| Result | Condition                                                                                                                                                                 |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pass   | Complete in one fetch (no pagination signals), or paginated with the continuation declared at the top of the content as an absolute URL that resolves to the next segment |
| Warn   | Paginated and the continuation works, but it is fragile: declared only late in the content, linked with a relative URL, or discoverable only from the `Link` header       |
| Fail   | Partial and the continuation is missing, unresolvable, or broken (non-success status, empty body, soft 404, HTML instead of markdown, or the same content again)          |

The verbose output names the evidence per page: the signal found, the continuation URL as declared, and the verification outcome.

### How to fix

**If this check warns**, move the pagination declaration to the top of the content, before anything truncation could remove, and make continuation links absolute. A trailing note is the first thing truncation removes, summarization may drop it, and a relative URL loses its base once the content leaves the fetch.

**If this check fails**, first ask whether the markdown variant needs pagination at all. Complete content that fits under the 50,000-character pass threshold should be served in one response, even when the HTML UI paginates. If pagination is genuinely necessary, declare it at the top with absolute links, and verify the continuation URLs actually serve content.

This check targets windowing, not the number of fetches. The spec elsewhere recommends _more_ fetches: progressive disclosure splits an oversized `llms.txt` into section files, and the page-size checks recommend breaking large pages up. Splitting creates self-contained units reached by navigation; pagination slices one logical unit into arbitrary windows, each incomplete for any question. Split by meaning, don't window by size.

Like `page-size-markdown`, this check is scaled by the [discovery coefficient](/agent-score-calculation#discovery-coefficient): a complete markdown response is worth less when agents can't find the markdown path.
