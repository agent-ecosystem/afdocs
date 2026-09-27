# Markdown Availability

Whether agents can get documentation as markdown instead of HTML. Agents work more effectively and efficiently with markdown: it's smaller, cleaner, and avoids the lossy HTML-to-markdown conversion that many agent web fetch pipelines apply. But agents don't discover markdown support on their own. Your docs must signal it.

## markdown-url-support

Whether appending `.md` to a documentation URL returns valid markdown.

|            |                                                                                                        |
| ---------- | ------------------------------------------------------------------------------------------------------ |
| **Weight** | High (7)                                                                                               |
| **Spec**   | [markdown-url-support](https://agentdocsspec.com/spec/web/markdown-availability/#markdown-url-support) |

### Why it matters

Sites serving markdown directly bypass the entire HTML-to-markdown conversion pipeline, which is lossy and unpredictable across agent platforms. This is the core format capability agents look for when directed to it via `llms.txt` links or a page directive.

Some docs platforms support this natively. VitePress, for example, serves markdown at `.md` URLs out of the box.

### Results

| Result | Condition                                        |
| ------ | ------------------------------------------------ |
| Pass   | `.md` URLs return valid markdown with 200 status |
| Warn   | Some pages support `.md` but not consistently    |
| Fail   | `.md` URLs return errors or HTML                 |

### How to fix

Configure your docs platform to serve `.md` variants for all documentation pages. The implementation depends on your platform:

- **VitePress**: Works out of the box; `.md` URLs serve the raw source files.
- **Other static generators**: You may need to copy source markdown files into the build output directory, or configure the server to serve them alongside the HTML.
- **Server-rendered platforms**: Add a route that serves the markdown source when the `.md` extension is requested.

### Dependencies

`page-size-markdown`, `markdown-code-fence-validity`, and `markdown-content-parity` all require either this check or `content-negotiation` to pass. If neither passes, those downstream checks are skipped. `single-fetch-completeness` and `markdown-link-portability` have the same prerequisite, with one more way in: they also run when `llms-txt-links-markdown` finds markdown links, because a site can serve agent-facing markdown through llms.txt alone.

---

## content-negotiation

Whether your server returns markdown when agents send `Accept: text/markdown`.

|            |                                                                                                      |
| ---------- | ---------------------------------------------------------------------------------------------------- |
| **Weight** | Medium (4)                                                                                           |
| **Spec**   | [content-negotiation](https://agentdocsspec.com/spec/web/markdown-availability/#content-negotiation) |

### Why it matters

Some agents, including Claude Code and Cursor, send `Accept: text/markdown` as their preferred content type. If your server honors this, agents get clean markdown automatically without needing to know about `.md` URL patterns. This is the most transparent form of markdown delivery because it requires no changes to agent behavior.

Most agents don't request markdown this way, but those that do benefit significantly.

### Results

| Result | Condition                                                                   |
| ------ | --------------------------------------------------------------------------- |
| Pass   | Server returns markdown with `Content-Type: text/markdown`                  |
| Warn   | Server returns markdown content but with an incorrect `Content-Type` header |
| Fail   | Server ignores the `Accept` header and returns HTML                         |

### How to fix

**If this check warns**, your server returns markdown content but doesn't set the `Content-Type` header correctly. Set the response `Content-Type` to `text/markdown` when the `Accept` header requests it.

**If this check fails**, configure your server to honor content negotiation. This requires server-side support: when a request includes `Accept: text/markdown`, serve the markdown source instead of the HTML page.

### Score impact

Content negotiation passing sets the [discovery coefficient](/agent-score-calculation#discovery-coefficient) to 1.0 for downstream markdown quality checks, because agents that request markdown get it automatically with no decision involved.
