# Content Structure

Whether page content is structured in ways agents can consume. These checks cover patterns that are great for humans but problematic for agents: tabbed interfaces that serialize into massive documents, generic headers that lose context when tabs are flattened, code fences that corrupt everything after them when left unclosed, links that stop working once the content leaves the fetch that carried its base URL, and data widgets that flatten into hundreds of serialized rows under a few paragraphs of prose.

The checks in this section focus on structural patterns that have measurable impact on agents: serialization behavior, header disambiguation, code fence integrity, link portability, and size attribution. How you organize your content (page granularity, information architecture, what to include) is a separate question that we don't yet have enough empirical data to score.

## tabbed-content-serialization

Whether tabbed UI components create oversized output when serialized.

|            |                                                                                                                    |
| ---------- | ------------------------------------------------------------------------------------------------------------------ |
| **Weight** | Medium (4)                                                                                                         |
| **Spec**   | [tabbed-content-serialization](https://agentdocsspec.com/spec/web/content-structure/#tabbed-content-serialization) |

### Why it matters

Tabbed content is great for humans but can create truncation-based discoverability issues for agents. A tutorial showing the same steps in 11 language variants serializes into a single massive document in the HTML source. The agent sees only the first few variants before hitting truncation limits; everything past that point is invisible. Asking for a specific variant (like Python) doesn't help if that variant is beyond the truncation point.

### Results

| Result | Condition                                                           |
| ------ | ------------------------------------------------------------------- |
| Pass   | No tabbed content, or serialized content is under 50,000 characters |
| Warn   | Serialized tabbed content is 50,000-100,000 characters              |
| Fail   | Serialized tabbed content exceeds 100,000 characters                |

### How to fix

If tabbed content creates oversized output, consider these approaches:

- **Separate pages**: Break each variant into its own page (e.g., `/quickstart/python`, `/quickstart/node`). Each page is self-contained and fits within limits.
- **Query parameters**: Provide a mechanism for agents to request a specific variant (e.g., `?lang=python`), returning only that variant's content.

---

## section-header-quality

Whether headers in tabbed sections include enough context to be meaningful without the surrounding UI.

|                |                                                                                                        |
| -------------- | ------------------------------------------------------------------------------------------------------ |
| **Weight**     | Low (2)                                                                                                |
| **Depends on** | `tabbed-content-serialization`                                                                         |
| **Spec**       | [section-header-quality](https://agentdocsspec.com/spec/web/content-structure/#section-header-quality) |

### Why it matters

When agents see serialized tabbed content, headers are the only way to tell which section applies to which context. Generic headers like "Step 1" repeated across Python, Node, and Go variants are indistinguishable in the serialized output. Headers like "Step 1 (Python/PyMongo)" preserve the filtering context agents need.

### Results

| Result | Condition                                                                                            |
| ------ | ---------------------------------------------------------------------------------------------------- |
| Pass   | 25% or fewer of headers within tabbed sections are generic (repeated without distinguishing context) |
| Warn   | 25-50% of headers are generic across variants                                                        |
| Fail   | Over 50% generic, or identical header sets repeated across tab groups with no variant context        |

### How to fix

Add variant context to headers in tabbed sections. For example, change "Step 1" to "Step 1 (Python)" or "Installation (npm)". This change benefits agents without affecting the human reading experience because the tab UI already provides the variant context visually.

---

## markdown-code-fence-validity

Whether markdown content has properly closed code fences.

|                |                                                                                                                    |
| -------------- | ------------------------------------------------------------------------------------------------------------------ |
| **Weight**     | Medium (4)                                                                                                         |
| **Depends on** | `markdown-url-support` or `content-negotiation`                                                                    |
| **Spec**       | [markdown-code-fence-validity](https://agentdocsspec.com/spec/web/content-structure/#markdown-code-fence-validity) |

### Why it matters

An unclosed code fence causes everything after it to be interpreted as code rather than prose. The agent sees the rest of the document as literal content to reproduce, not natural language instructions to follow. An early unclosed fence means the agent loses the entire rest of the page's meaning.

Per CommonMark, a backtick fence (` ``` `) can only be closed by another backtick fence of equal or greater length. A tilde fence (`~~~`) closing a backtick-opened fence leaves the backtick fence unclosed.

### Results

| Result | Condition                                  |
| ------ | ------------------------------------------ |
| Pass   | All code fences properly opened and closed |
| Fail   | One or more unclosed code fences detected  |

This check has no warn state; it's strictly pass/fail.

### How to fix

Run with `--verbose` to see which pages have unclosed fences. Ensure every opening ` ``` ` or `~~~` has a matching closing delimiter of the same type and equal or greater length. Pay particular attention to nested code examples (code blocks inside code blocks) which are the most common source of fence mismatches.

---

## markdown-link-portability

Whether links in served markdown are absolute URLs, and whether a sample of them resolves to the representation they promise.

|                |                                                                                                              |
| -------------- | ------------------------------------------------------------------------------------------------------------ |
| **Weight**     | Medium (4)                                                                                                   |
| **Depends on** | `markdown-url-support`, `content-negotiation`, or `llms-txt-links-markdown`                                  |
| **Spec**       | [markdown-link-portability](https://agentdocsspec.com/spec/web/content-structure/#markdown-link-portability) |

### Why it matters

Relative URL resolution is well defined by RFC 3986, but it requires knowing the base URL, and agent pipelines routinely lose it. A browser always carries the base. Markdown fetched by an agent passes through a summarization model, gets chunked for RAG, or gets pasted into a context where the source URL is gone. Once the base is lost, a root-relative link (`/docs/guide.md`) is unreconstructable, and a path-relative link (`../guide.md`) is meaningless. This is why the spec already recommends absolute URLs between llms.txt levels; served markdown deserves the same rule.

Link verification also has to go past status codes. The spec's grounding case is a production catalog whose markdown variant emitted over 100 well-formatted links into a wrong internal path prefix, apparently a build-time substitution error. Every one of them returned 200 with a body. The body was an HTML SPA shell whose only acknowledgment of failure was a framework error digest inside a script payload: a soft 404 served as HTML at a `.md` URL. A checker that tested status codes alone would have called those links working. The `Content-Type` alone would have caught it.

**Why this check exempts the HTML path.** Relative links in HTML are correct web practice, and they are what makes staging domains, mirrors, and CDN setups work. The HTML path also doesn't need the site's help: a pipeline converting HTML to markdown still holds the fetch URL at conversion time, so resolving relative links is the pipeline's job, with full information. The base URL is only lost downstream of conversion. Served markdown is different on both ends. The generator knows the canonical host, so absolute links are free to produce, and on the best-case consumption path (direct delivery of `text/markdown` under the summarization threshold) the site's bytes reach the model verbatim, with no conversion step where anything could be resolved.

### What is measured

The check reads the same markdown responses the other markdown checks already fetched, so nothing is fetched twice, and it classifies every inline link by how much of the base URL the link needs to survive:

- **Absolute** (`https://docs.example.com/guide.md`): nothing.
- **Root-relative** (`/guide.md`): the scheme and host.
- **Path-relative** (`guide.md`, `../guide.md`): the scheme, the host, and the directory of the document that carried the link.

A destination that never parses as a URL at all (a generator emitting `https://[`) fails the page rather than being counted as a well-formed absolute link.

Same-document fragment links (`#anchor` with no path) are exempt: they resolve within the content the agent already holds, and rewriting them to absolute URLs adds nothing. Links with a non-HTTP scheme (`mailto:`, `tel:`) are exempt for the same reason. Links inside fenced code blocks and inline code are ignored, so documentation that shows example markdown is not graded on its examples. Image references are classified and reported but never affect the result: they point at assets rather than at documentation an agent navigates to.

Relative links are resolved against the URL that served the markdown, not the page URL. For a site serving `/docs/api` as `/md/docs/api.md`, `guide.md` means `/md/docs/guide.md`.

A sample of the links is then fetched and verified: a success status, a non-empty body, no soft-404 signature, and, for links whose path promises markdown (`.md`, `.mdx`), a response that is actually markdown rather than an HTML shell. Cross-origin links are counted as absolute (which they always are) but never fetched, following the same same-origin/cross-origin split `llms-txt-links-resolve` uses: a third party's availability is not this site's result. The sample is spread evenly across the pages, links that promise markdown are tried first, and a URL that appears on several pages is fetched once, so the whole check stays within the `--max-links` budget.

### Results

Each sampled markdown page is scored from the worst link class it carries and the results for its sampled links; the overall result is proportional.

| Result | Condition                                                                                                                                             |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pass   | Links are absolute, and sampled links resolve to the expected representation                                                                          |
| Warn   | Links are root-relative, or a sampled `.md` link redirects to an HTML page that carries the right content                                             |
| Fail   | Links are path-relative or malformed, or a sampled link is broken: a hard 404, a soft 404, an empty body, or a content type that contradicts the link |

The redirect case is narrow on purpose. A `.md` link that redirects to an HTML page has delivered the content in the wrong representation, which is the warn. A `.md` link that redirects to another `.md` URL and then serves HTML is not: the final URL still promises markdown and still doesn't deliver it, so that fails like any other shell at a `.md` address.

The verbose output names the link counts per page and each broken sample with its reason.

### How to fix

**If this check warns**, emit absolute URLs when generating markdown. The site's canonical host is known at build time, so absolute links cost nothing to produce, and they are the only form that survives a pipeline that has lost the fetch URL. Where the warn is a `.md` link that redirects to an HTML page, absolute URLs are not the fix: serve markdown at the linked URL, or link to the URL that serves it.

**If this check fails**, fix the link generation first, then make the links absolute. Verify generated links in CI by fetching a sample and checking both status and content type: a link set that is generated is a link set that can break wholesale, and a status code alone will not catch it.

Like `page-size-markdown`, this check is scaled by the [discovery coefficient](/agent-score-calculation#discovery-coefficient): portable links in markdown are worth less when agents can't find the markdown path.

---

## embedded-data-serialization

Whether machine-generated bulk data (large uniform tables, inline JSON or data blobs, base64 payloads) is what makes a page oversized, and which elements are responsible.

|            |                                                                                                                  |
| ---------- | ---------------------------------------------------------------------------------------------------------------- |
| **Weight** | Medium (4)                                                                                                       |
| **Spec**   | [embedded-data-serialization](https://agentdocsspec.com/spec/web/content-structure/#embedded-data-serialization) |

### Why it matters

Dynamic widgets (compatibility matrices, model catalogs, spec browsers, pricing tables) flatten into static content when a page is rendered for agents. The result can be a page whose size wildly exceeds what its author believes they wrote: the author sees a few paragraphs and a widget; the built page carries hundreds of serialized rows under them. The [size checks](/checks/page-size) catch the symptom but do not explain it, and without attribution the person who can fix the page has no idea what to fix, or that anything is wrong at all.

The spec's grounding case is a production reference page that served 302KB of HTML, 64% of it table markup, including a single generated table of 218 rows. The page converts to roughly 83,000 characters (the warn band) while its non-table prose totals about 17,000. The page's truncation risk is entirely a property of its generated tables, which an aggregate size number cannot show.

### What is measured

The check reads exactly the content `page-size-html` measured: the HTML-to-markdown conversion for HTML responses, or the body itself for markdown responses, from the same cached fetch. In that content it looks for three kinds of bulk element:

- **Tables** with at least 20 data rows (configurable with `--bulk-table-rows`) whose rows share a common cell structure. Pipe tables and raw `<table>` markup that the converter left in place (tables without a header row) both count, because both occupy the converted content.
- **JSON blobs** of at least 2,000 characters (configurable with `--bulk-blob-chars`), whether in a fenced or indented code block or dropped inline as a paragraph. JSON is recognized by a `json` language tag, by parsing, or by key density when the blob carries comments or elisions. Long code samples in other languages are not bulk data.
- **Base64 runs** of at least the same size, including `data:` URIs.

For each element the check records its kind, size, share of the converted content, position, and for tables the row and column counts. It also records how much of the page's prose comes before the first bulk element, so the spec's "prose before data" recommendation is checkable per page.

This check only sees bulk that survives conversion into content. Serialized payloads inside `<script>` tags are stripped by conversion and belong to [page-size-transfer](/checks/page-size#page-size-transfer): script payloads burden every fetch, content-embedded bulk burdens what the model reads.

### Results

The verdict is coupled to `page-size-html`: the check reads that check's per-page bucket when it ran (or applies the same thresholds when it did not), so the two checks never disagree about the same content. Bulk data is the dominant contributor when it makes up at least half of the converted content (configurable with `--bulk-dominant-share`).

| Result | Condition                                                                                                |
| ------ | -------------------------------------------------------------------------------------------------------- |
| Pass   | No bulk elements, or the page passes the size checks regardless, or bulk is not the dominant contributor |
| Warn   | Bulk elements are the dominant contributor to a page in the size checks' warn band                       |
| Fail   | Bulk elements are the dominant contributor to a page over the size checks' fail threshold                |

An oversized page whose bulk is not the dominant contributor passes here: the size check already carries that page, and the attribution is still reported in the details. The verbose output names the largest element on each flagged page, its share of the converted content, and how much of the prose precedes it.

### How to fix

Bulk data is usually legitimate content (a support matrix is the point of a support-matrix page), so the goal is structure, not removal:

- **Split large generated tables across per-section pages**, as self-contained units reached from an index, each complete for its scope. Paginating one table into windows trades this problem for the one [single-fetch-completeness](/checks/page-size#single-fetch-completeness) describes.
- **Provide filtered or queryable views** so an agent can fetch the rows it needs.
- **Load embedded data blobs on demand** rather than inlining them in the page.
- **Place prose before bulk elements**, so truncation removes data rows rather than explanation.
- **Report the attribution to content authors.** A page that an author experiences as two paragraphs should not ship as a hundred kilobytes without the author knowing.

This is the data-widget sibling of [tabbed-content-serialization](#tabbed-content-serialization), which covers the same flattening failure for tab and accordion UI. Together with [content-start-position](/checks/page-size#content-start-position), these checks explain why a page fails the size checks, not just that it does. When this check flags a page that [single-fetch-completeness](/checks/page-size#single-fetch-completeness), [markdown-content-parity](/checks/observability#markdown-content-parity), or [markdown-link-portability](#markdown-link-portability) also flagged, the report presents them together as the [dynamic content rendered statically](/interaction-diagnostics#dynamic-content-rendered-statically) diagnostic.

Like the other HTML-path checks, this check is scaled by the [HTML path coefficient](/agent-score-calculation#html-path-coefficient): attribution on pages that are SPA shells measures nothing.
