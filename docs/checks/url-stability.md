# URL Stability and Redirects

Whether documentation URLs behave predictably for agents. Agents retrieve URLs from training data and `llms.txt`. When those URLs don't resolve cleanly, the agent either silently consumes the wrong content or fails to reach the page at all.

## http-status-codes

Whether error pages return correct HTTP status codes.

|            |                                                                        |
| ---------- | ---------------------------------------------------------------------- |
| **Weight** | High (7)                                                               |
| **Spec**   | [http-status-codes](https://agentdocsspec.com/spec/#http-status-codes) |

### Why it matters

In empirical testing, soft 404s (pages returning 200 with "page not found" content) performed _worse_ than real 404s for agents. When an agent sees a 200 response, it trusts the content and tries to extract information from whatever is on the page. With a soft 404, that means the agent tries to use the error page content as if it were documentation. A clean 404 tells the agent to try a different approach.

### Results

| Result | Condition                                                                                  |
| ------ | ------------------------------------------------------------------------------------------ |
| Pass   | Fabricated bad URLs return proper 4xx status codes                                         |
| Warn   | Every sampled response was indeterminate (HTTP 202 or 5xx); bad-URL handling is unmeasured |
| Fail   | Bad URLs return 200 (soft 404)                                                             |

AFDocs tests this by generating non-existent URLs based on your site's URL structure and checking whether the server returns 404 or 200. Per-page responses fall into one of three buckets:

- **`correct-error`** (counts toward pass): 4xx status code.
- **`soft-404`** (counts toward fail): 2xx/3xx status code, often a templated "page not found" page.
- **`indeterminate`** (excluded from the soft-404 tally): HTTP 202 or 5xx. RFC 7231 says 202 means "still processing," and Vercel/Next.js ISR returns it during cache-miss/build for fresh URLs. 5xx responses tell us nothing about how the site handles bad URLs. Both are reported separately rather than penalized as soft 404s.

If at least one response is determinate, the check scores from the determinate subset (e.g., 2 correct-error + 1 indeterminate scores as 2/2 = pass). The warn state only fires when **every** sampled response is indeterminate, in which case the check applies the default 0.5 warn coefficient because bad-URL handling could not be measured.

### How to fix

Configure your server or hosting platform to return a 404 status code for pages that don't exist. Most docs platforms handle this correctly by default; the common exception is single-page applications that serve the shell HTML for all routes and handle 404s client-side.

**If this check warns** with "all sampled pages returned indeterminate responses," the most common causes are:

- **Vercel/Next.js ISR** returning 202 during cache-miss or build. Real agents (low concurrency, warm cache) typically don't hit this, so it's noise rather than signal. No action needed.
- **A misconfigured server returning 5xx for missing paths** (e.g., an Apache rewrite rule that maps `/foo` to `/foo.html` without checking that the target file exists, then loops or hits an internal error). This is a real issue: agents requesting a typo'd URL get a 500 instead of a clean 404. Add a guard so the rewrite only fires when the target exists, and set an `ErrorDocument 404` directive that points at your platform's 404 page.

### What about serving helpful content on missing pages?

It's tempting to serve something useful when an agent requests a page that doesn't exist. For example, you might return your `llms.txt` as a fallback, or a "did you mean?" page with links to related content. This seems like an elegant solution to agents hallucinating URLs.

The problem is the status code, not the content. If you serve a helpful fallback with a 200 status, the agent doesn't know the page it asked for doesn't exist. It trusts the 200 and tries to extract an answer from whatever you returned. If that's your `llms.txt`, the agent may try to answer a specific question using your table of contents. In testing, this performed worse than a clean 404 because the agent confidently uses the wrong content instead of recognizing its mistake and trying a different approach.

The good news is that HTTP lets you do both: **return a 404 status code with a helpful response body.** Agents that check status codes will know the page doesn't exist; agents that read the body anyway get something useful. This is the best of both worlds.

A more interesting long-term approach: if you notice agents consistently requesting pages that don't exist (the same hallucinated URL appearing repeatedly in your 404 logs), consider creating content at that URL. Agents hallucinate URLs based on patterns in their training data, and if many agents expect a page to exist, there may be a real content gap worth filling.

---

## redirect-behavior

Whether redirects use standard HTTP methods and stay on the same host.

|            |                                                                        |
| ---------- | ---------------------------------------------------------------------- |
| **Weight** | Medium (4)                                                             |
| **Spec**   | [redirect-behavior](https://agentdocsspec.com/spec/#redirect-behavior) |

### Why it matters

Same-host redirects (where the path changes but the host stays the same) work transparently because HTTP clients follow them automatically. Cross-host redirects are a known failure point: some agents, including Claude Code, don't automatically follow them as a security measure against open redirects. JavaScript-based redirects don't work at all because agents don't execute JavaScript.

Agents often retrieve URLs from training data, which may point to old paths. Redirects from old paths to new ones are expected and fine, as long as they're same-host HTTP redirects.

### Results

| Result | Condition                                                                               |
| ------ | --------------------------------------------------------------------------------------- |
| Pass   | All redirects are same-host HTTP redirects (301/302)                                    |
| Warn   | Cross-host HTTP redirects present (agents may or may not follow, depending on platform) |
| Fail   | JavaScript-based redirects detected                                                     |

### How to fix

**If this check warns**, you have cross-host HTTP redirects. Where possible, use same-host redirects or update URLs to point directly to the final destination. Common causes: migrating docs from one subdomain to another, or CDN configurations that redirect between `www` and non-`www`.

**If this check fails**, JavaScript-based redirects were detected. Replace them with HTTP 301/302 redirects. Agents don't execute JavaScript and will never follow these.
