# Content Structure

Whether page content is structured in ways agents can consume. These checks cover patterns that are great for humans but problematic for agents: tabbed interfaces that serialize into massive documents, generic headers that lose context when tabs are flattened, and code fences that corrupt everything after them when left unclosed.

The checks in this section focus on structural patterns that have measurable impact on agents: serialization behavior, header disambiguation, and code fence integrity. How you organize your content (page granularity, information architecture, what to include) is a separate question that we don't yet have enough empirical data to score.

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
