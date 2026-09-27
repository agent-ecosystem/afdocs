# Improve Your Score

This guide walks you through improving your Agent Score in priority order. Start at the top: the fixes are ordered by score impact, so each step moves the needle as much as possible.

## Step 1: Run the scorecard

If you haven't already, get your baseline:

```bash
npx afdocs check https://docs.example.com --format scorecard
```

Note your overall score and letter grade. This is your starting point.

## Step 2: Read the scorecard

The scorecard gives you two levels of information:

**Interaction diagnostics** are system-level problems that emerge from combinations of check results. If any appear, start here. They typically have outsized score impact because they affect multiple checks at once. For example, "Markdown support is undiscoverable" means you've done the work to support markdown but agents can't find it, which causes three downstream checks to be excluded from your score entirely. See [Interaction Diagnostics](/interaction-diagnostics) for what each diagnostic means and what to do about it.

**Check results** show individual pass/warn/fail outcomes with fix suggestions for each failing check. The scorecard includes these by default. To see _which specific pages_ have problems, run the text format with `--verbose`:

```bash
npx afdocs check https://docs.example.com --verbose --fixes
```

The scorecard tells you _what's wrong_. The verbose text output tells you _where_.

## Step 3: Work through fixes iteratively

You don't need to run all 28 checks every time you make a change. Target just the check you're fixing for fast feedback:

```bash
# Iterate on llms.txt
npx afdocs check https://docs.example.com --checks llms-txt-exists,llms-txt-valid,llms-txt-size

# Test a single page for size or rendering issues
npx afdocs check https://docs.example.com/api/auth --sampling none --checks page-size-html,rendering-strategy
```

If your docs platform can't support certain checks (for example, you can't serve markdown on a platform that doesn't support it), don't let those checks distract you. Create a [config file](/run-locally#use-a-config-file) that lists only the checks you can control:

```yaml
url: https://docs.example.com
checks:
  - llms-txt-exists
  - llms-txt-valid
  - llms-txt-size
  - llms-txt-links-resolve
  - llms-txt-directive-html
  - llms-txt-directive-md
  - rendering-strategy
  - page-size-html
  - content-start-position
  - http-status-codes
  - auth-gate-detection
```

This focuses your score on what's actionable. You can expand the list as your platform adds capabilities.

## Step 4: Prioritize fixes by impact

Not all fixes are equal. Here are the highest-impact changes, ordered by the score points they can recover:

### Critical impact (10 points each)

**Add an llms.txt file**

If `llms-txt-exists` fails, create an `llms.txt` at your site root listing your documentation pages with markdown links. See the [llms.txt specification](https://llmstxt.org/) for the format.

This also unblocks five dependent checks (`llms-txt-valid`, `llms-txt-size`, `llms-txt-links-resolve`, `llms-txt-links-markdown`, `llms-txt-coverage`) that are currently skipped.

**Enable server-side rendering**

If `rendering-strategy` fails, your site is delivering empty JavaScript shells to agents. Enable SSR or static site generation in your docs platform. This is typically a configuration flag, not a code change.

If `rendering-strategy` warns, your pages render server-side but have unusually short body content. Spot-check a few of them with `curl` to confirm the full content is in the HTML response. If the pages are legitimately short, no action is needed. If content is missing, your renderer may be hydrating sections client-side; emitting them server-side will fix it.

When SPA shells (and sparse pages, weighted at half) exceed half the sampled pages, the score is [capped at D](/agent-score-calculation#score-caps) regardless of everything else; when they exceed three quarters, it's capped at F.

**Remove or work around authentication gates**

If `auth-gate-detection` warns or fails, agents can't reach your docs. Consider ungating public API references and integration guides, providing a public `llms.txt` with links to ungated content, or shipping documentation with your SDK.

At 50%+ gated pages, the score is [capped at D](/agent-score-calculation#score-caps).

### High impact (7 points each)

**Serve markdown at .md URLs**

If `markdown-url-support` fails, agents are stuck with HTML. Many docs platforms support this natively (VitePress, for example, serves markdown at `.md` URLs out of the box). Others need a server configuration change.

**Add an llms.txt directive to HTML pages**

If `llms-txt-directive-html` fails, agents visiting individual pages have no way to discover your llms.txt. Add a visually-hidden element near the top of each page pointing to your llms.txt. If your site serves markdown, mention that in the directive too so agents know to request it.

**Fix broken llms.txt links**

If `llms-txt-links-resolve` warns or fails, run with `--verbose` to see which specific links are broken. These are often pages that were renamed or removed without updating llms.txt.

**Point llms.txt links to markdown**

If `llms-txt-links-markdown` warns or fails, your llms.txt links point to HTML pages even though markdown versions exist. Update the links to use `.md` URLs. This is usually a find-and-replace.

**Keep llms.txt under size limits**

If `llms-txt-size` warns or fails, agents are seeing a truncated version of your index. Split into a root llms.txt that links to section-level files, each under 50,000 characters.

### Medium impact (4 points each)

These are worth addressing but won't move the score as dramatically:

- **llms.txt directive in markdown** (`llms-txt-directive-md`): Add a blockquote near the top of each markdown page pointing to your llms.txt.
- **Content negotiation** (`content-negotiation`): Return markdown when agents send `Accept: text/markdown`. Requires server-side support.
- **Content start position** (`content-start-position`): Reduce navigation, breadcrumb, and sidebar markup that precedes the main content area.
- **Single-fetch completeness** (`single-fetch-completeness`): Serve complete markdown in one response instead of paginating it. If pagination is unavoidable, declare the continuation at the top with an absolute URL that works.
- **Tabbed content** (`tabbed-content-serialization`): If tabbed UI components create oversized output, consider restructuring into separate pages or using query params to retrieve only specific tab versions.
- **Code fence validity** (`markdown-code-fence-validity`): Fix unclosed code fences in your markdown sources.
- **Markdown link portability** (`markdown-link-portability`): Emit absolute URLs when generating markdown, and verify a sample of the generated links in CI by checking both status and content type.
- **Embedded data** (`embedded-data-serialization`): If a generated table or data blob is what pushes a page over the size thresholds, split it into per-section pages reached from an index, offer a filtered view, and put the explanatory prose before the data.
- **Redirect behavior** (`redirect-behavior`): Replace JavaScript and cross-host redirects with standard HTTP redirects.
- **llms.txt coverage** (`llms-txt-coverage`): Generate llms.txt at build time to keep it in sync with your site.
- **Content parity** (`markdown-content-parity`): Ensure markdown and HTML versions of pages contain the same content.
- **llms.txt validity** (`llms-txt-valid`): Follow the [llmstxt.org](https://llmstxt.org/) structure.

### Low impact (2 points each)

- **Section header quality** (`section-header-quality`): Add variant context to headers in tabbed sections (e.g., "Step 1 (Python)" instead of just "Step 1").
- **Cache header hygiene** (`cache-header-hygiene`): Set reasonable cache lifetimes on `.md` and `.txt` files so agents see updates within hours, not days.

## Step 5: Re-run and verify

After each fix, re-run the scorecard to verify improvement:

```bash
npx afdocs check https://docs.example.com --format scorecard
```

Use `--sampling deterministic` for consistent results between runs, so you can be confident the score change is from your fix, not from a different page sample.

## Step 6: Add to CI

Once you're happy with your score, add AFDocs to your CI pipeline to prevent regressions. See [CI Integration](/ci-integration) for setup.
