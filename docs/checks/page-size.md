# Page Size and Truncation Risk

Whether agents can process your pages without losing content. Agent platforms have diverse truncation limits, from 5K characters on some platforms to over 100K on others. Pages that exceed these limits are silently truncated: the agent sees the beginning of the page and loses the rest.

This category also covers the related problem of pages that technically fit within limits but waste most of that budget on boilerplate (navigation chrome, breadcrumbs, sidebars) instead of documentation content.

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
- **Markdown alternative**: Provide markdown versions as a smaller alternative path for agents that bypass HTML conversion overhead.

Markdown availability helps agents that request it, but most agents still fetch HTML, so fixing the HTML path remains important.

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
