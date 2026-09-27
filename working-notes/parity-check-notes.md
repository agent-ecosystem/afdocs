# markdown-content-parity check: implementation notes

## Goal

Detect when a documentation site's markdown version of a page is missing
content that exists in the HTML version. The motivating use case is build
pipeline failures where elements like inline code, collapsible sections,
or tabbed content don't survive the HTML-to-markdown conversion.

The check depends on `markdown-url-support` or `content-negotiation` (OR
dependency). It reads cached markdown from `pageCache` and fetches the HTML
version for comparison.

## Current state of the code

- Implementation: `src/checks/observability/markdown-content-parity.ts`
- Tests: `test/unit/checks/markdown-content-parity.test.ts` (41 tests, all passing)
- Full suite: 1216 tests passing, lint clean
- The `diff` dependency has been removed; comparison now uses containment checking
- No unused imports or cleanup needed

## Current approach: containment checking (approach 4)

For each HTML page, extract plain text segments, then check whether each
segment appears anywhere in the markdown text (normalized substring match).
The percentage of HTML segments NOT found in the markdown is the "missing"
score.

This replaced `diffLines()` (approach 3) because positional diffing was
too sensitive to reordering and formatting differences. Containment is
order-independent, so reordered sections and reformatted paragraphs don't
count as "missing."

### Content extraction pipeline

1. **Find content container**: heuristic inside article/main > article inside main > article > heuristic inside main > main > heuristic on root > body
2. **Strip chrome tags**: script, style, nav, footer, header, noscript, button, svg, aside
3. **Strip chrome selectors**: breadcrumbs, pagination, feedback widgets, TOC
4. **Strip high-link-density elements**: remove elements where >70% of text is inside links and there are >10 links. This catches navigation panels (sidebars, header menus) that use `<div>` instead of `<nav>`/`<aside>`. Based on the readability algorithm heuristic that navigation consists almost entirely of links while content sections have substantial non-link text.
5. **Insert newlines** around block-level elements so `.text` produces separated lines
6. **Strip CSS-in-JS**: remove `<style>...</style>` blocks from `.text` output (CSS-in-JS libraries like Emotion/Leafygreen inject `<style>` inside `<pre>`, which `node-html-parser` treats as raw text)
7. **Strip HTML comments**: remove `<!-- ... -->` from `.text` output
8. **Inject code line breaks**: insert newlines before `<div` tags in raw text output. Since `node-html-parser` treats `<pre>` content as raw text, `<div>` elements inside code blocks (used by Expressive Code, Shiki, Vercel's Geist code blocks, etc.) appear as literal text. This separates smashed-together code lines into individual segments for better matching.
9. **Strip HTML tags, preserve placeholders**: remove closing tags, then for opening tags check the tag name against a known HTML tag list. Known tags (div, span, code, etc.) are stripped; unknown "tags" like `<YOUR_API_KEY>` or `<field name>` are kept as text content (these are angle-bracket placeholders decoded from `&lt;...&gt;` entities)
10. **Segment**: split into lines, trim, filter to >=20 chars, filter noise patterns
11. **Deduplicate**: remove duplicate segments (by normalized text) so repeated breadcrumbs/nav titles are counted once
12. **Minimum segment gate**: pages with <10 unique segments auto-pass (too few for meaningful comparison)
13. **Normalize**: strip zero-width chars, normalize typographic quotes, strip angle brackets from placeholders, lowercase, collapse whitespace
14. **Containment check**: for each HTML segment, check if it appears in the normalized markdown text

### Container selection priority

The extractor always prefers the tightest available container:

1. Heuristic selector inside `<article>` or `<main>` (tightest)
2. `<article>` nested inside `<main>`
3. Standalone `<article>`
4. Heuristic selector inside `<main>` (when no `<article>` exists)
5. `<main>` alone
6. Heuristic selectors on the document root
7. `<body>` (fallback)

This ordering matters because:

- Neon puts `<article>` inside `<main>`, with toolbars and CTAs between
  `</article>` and `</main>`.
- Val Town (Starlight) has `<main>` with `.sl-markdown-content` inside it,
  plus sidebar chrome between the content div and `</main>`.
- Mintlify/ReadMe have no semantic containers but use `#content`.

### Heuristic content container selectors

When `<main>` and `<article>` are absent, these selectors are tried in order:
`[role="main"]`, `#content`, `.sl-markdown-content`, `.markdown-content`,
`.markdown-body`, `.docs-content`, `.doc-content`, `.main-pane`,
`.page-content`, `.prose`

This was added because Mintlify, ReadMe, and some other platforms don't use
semantic HTML containers. The `#content` selector alone cut average missing
from 42% to 19% on Mintlify sites.

### Chrome stripping (CSS selectors)

Beyond tag-level stripping, these selectors are removed from the content container:
`[aria-label="breadcrumb"]`, `[aria-label="pagination"]`, `[class*="breadcrumb"]`,
`[class*="pagination"]`, `[class*="prev-next"]`, `[class*="prevnext"]`,
`[class*="page-nav"]`, `[class*="feedback"]`, `[class*="helpful"]`,
`[class*="table-of-contents"]`, `[class*="toc"]`, `[rel="prev"]`, `[rel="next"]`,
`.sr-only`

### Noise segment patterns

Segments matching these patterns (after lowercasing) are excluded:

- `^last updated` - timestamp metadata
- `^was this page helpful` - feedback widgets
- `^thank you for your feedback` - feedback responses
- `^previous\s+\S.*next\s+\S` - prev/next pagination text
- `^start from the beginning$` - series navigation
- `^join our .* server` - community CTAs ("Join our Discord Server...")
- `^loading video content` - video placeholders
- `^\/.+\/.+` - breadcrumb paths ("/Connect to Neon/...")

### Normalization

The `normalize()` function prepares text for fuzzy substring matching:

- Strips zero-width characters (U+200B, U+200C, U+200D, U+FEFF) — Mintlify
  injects these before heading anchors
- Normalizes typographic quotes: curly single quotes → `'`, curly double
  quotes → `"`, em/en dashes → `-`, ellipsis → `...`
- Strips angle brackets while keeping content: `<YOUR_API_KEY>` → `YOUR_API_KEY`.
  This ensures both HTML-side (entities decoded, tags stripped) and markdown-side
  (raw angle brackets in code) produce the same text for comparison.
- Lowercases and collapses whitespace

### HTML tag vs placeholder detection

The `extractHtmlText()` function uses a known HTML tag name set to distinguish
real tags from angle-bracket placeholders in `.text` output. When
`node-html-parser` decodes `&lt;clusterName&gt;` to `<clusterName>` in text
output, the tag stripping regex checks if `clusterName` is a known HTML tag.
Since it's not, the content is preserved. This works for both single-word
(`<clusterName>`) and multi-word (`<field name>`) placeholders.

The known tag set covers all standard HTML elements. The regex
`<([a-zA-Z][a-zA-Z0-9-]*)([^>]*)>` captures the first word as the tag name
and checks it against the set. Tags with attributes (like `<span class="...">`)
have their first word extracted as the tag name.

### Markdown text extraction ordering

The `extractMarkdownText()` function strips markdown formatting in a specific
order:

1. Code fences (keep content)
2. Heading markers
3. Setext heading underlines
4. Link/image URLs (keep text)
5. Reference-style link definitions
6. List bullets/numbers (before emphasis, so leading `*` isn't misinterpreted)
7. **Inline code backticks** (before emphasis, so underscores in code
   identifiers like `mongoc_client_get_database` aren't mangled)
8. Emphasis markers (`*` only, not `_` — underscores are too common in code
   identifiers and cause false mismatches when stripped as emphasis)
9. Blockquote markers
10. Horizontal rules

### Thresholds

- Pass: <5% of HTML segments missing from markdown
- Warn: 5-19%
- Fail: >=20%

### Minimum segment threshold

Pages with fewer than 10 unique HTML segments auto-pass without comparison.
Small pages (landing pages, index pages, stubs) have so few real content
segments that even 2-3 breadcrumb or nav items can produce 30%+ "missing."
The percentage is too volatile to be meaningful.

Validated on MongoDB docs: all 4 pages below the threshold had 0% missing
(no genuine issues masked). Pages at 10-14 segments showed a mix of
breadcrumb noise and genuine gaps, confirming 10 as a reasonable boundary.

## Key infrastructure decisions (settled)

1. **Pages to compare**: Only pages already in `pageCache` from upstream checks.
   No independent page discovery.

2. **HTML URL derivation**: The `toHtmlUrl()` function strips `.md`/`.mdx` from
   cached URLs. Needed because llms.txt often links to `.md` URLs directly
   (Stripe, Neon, OpenAI all do this). Also handles `/index.md` > `/` case.

3. **HTML fetching**: Uses `fetchPage()` (cache-first via `htmlCache`, fetch as
   fallback). If the fetched page is not HTML (`isHtml === false`), the check
   auto-passes (no comparison needed).

4. **Hidden content is NOT stripped**: We decided not to strip elements with
   `hidden`, `opacity-0`, or similar CSS classes because tabbed code content
   (e.g., Python/Ruby/Go variants) uses these mechanisms. Stripping by
   visibility would remove real content that should be in the markdown.
   Chrome is handled through container selection, explicit selectors, and
   link density heuristics instead.

## Real-site test results

### Session 2 results (final, after all fixes)

Fixes applied: container selection hierarchy, 404 detection, bullet/emphasis
ordering, zero-width space stripping, typographic quote normalization,
`.sr-only` stripping, `.sl-markdown-content` selector.

| Site      | Platform  | Container used        | Avg missing | P/W/F        | Notes                                    |
| --------- | --------- | --------------------- | ----------- | ------------ | ---------------------------------------- |
| Anthropic | Custom    | article (inside main) | 0%          | 1/0/0        | Site updated, now has article            |
| Loops     | Mintlify  | #content              | 2%          | 7/1/0        | Normalization fixes resolved most issues |
| Resend    | Mintlify  | #content              | 7%          | 4/3/1        | Remaining: code snippets, angle-brackets |
| Neon      | Custom    | article (inside main) | 10%         | 2/6/0        | Chrome-free on article pages             |
| PostHog   | Custom    | article               | 13%         | 2/1/2        | 404 pages now skipped; Radix CSS leaks   |
| Resend\*  | Mintlify  | #content              | 15%         | (session 2a) | Before final fixes                       |
| Val Town  | Starlight | .sl-markdown-content  | 20%         | 3/1/4        | sr-only stripped; real content gaps      |
| Daytona   | Starlight | .sl-markdown-content  | 27%         | 0/3/5        | Multi-language code tabs (real gaps)     |
| Stripe    | Custom    | article               | 31%         | 1/2/3        | API ref pages + code tabs                |
| Vercel    | Custom    | varies                | 52%         | 1/0/4        | API ref pages dominate                   |
| Knock     | CSR       | body (fallback)       | 52%         | 0/0/8        | Fully CSR, nav from RSC payload          |

### Session 1 results (before fixes)

| Site      | Platform  | `<main>`/`<article>`    | Avg missing | Pass/Warn/Fail |
| --------- | --------- | ----------------------- | ----------- | -------------- |
| Loops     | Mintlify  | neither (uses #content) | 14%         | 15/19/14       |
| Resend    | Mintlify  | neither (uses #content) | 19%         | 12/12/21       |
| Stripe    | Custom    | article only            | 20%         | 19/13/15       |
| Pinecone  | ReadMe    | neither (uses #content) | 22%         | 13/14/19       |
| OpenAI    | Astro     | main + article          | 24%         | 8/16/26        |
| Plaid     | Custom    | neither                 | 24%         | 1/2/8          |
| Neon      | Custom    | main + article          | 25%         | 0/24/25        |
| Anthropic | Custom    | neither                 | 31%         | 7/3/24         |
| Daytona   | Starlight | main                    | 36%         | 1/9/40         |
| Vercel    | Custom    | ?                       | 36%         | 6/10/26        |

### What drives the remaining "missing" percentages

After session 4 fixes, the remaining gaps are almost all genuine content
asymmetries rather than extraction bugs:

**Multi-language code tabs** (Daytona, OpenAI): HTML pages have code examples
in 3-5 languages behind tabs. All language variants are in the DOM (some with
CSS class `hidden`, some just shown/hidden via JS). When the markdown also
includes all languages (like Daytona), the code line separation fix helps
matching. When it doesn't (like OpenAI), it's a legitimate content gap.

**API reference pages** (Stripe, Vercel): HTML API reference pages include
fully rendered fetch examples, auth headers, and response schemas that the
markdown version omits or summarizes. These are genuine content asymmetries.

**Heading numbers in HTML** (minor): Mintlify renders headings like
`## 2. Setup` as `2. Setup` in the DOM (with zero-width space). Our markdown
extractor strips both the heading marker and the numbered prefix, but the
HTML text retains the number, causing a mismatch.

**Client-side rendered pages** (rare): Some pages serve a Next.js RSC shell
with no rendered DOM. The "body" is serialized React data. Neither our
approach nor any readability library can extract content from these.

**Resolved in sessions 3-4**: Angle-bracket placeholders (fixed with tag
name set), CSS-in-JS leaking into code blocks (fixed with style stripping),
navigation contamination from non-semantic HTML (fixed with link density
heuristic), smashed code lines (fixed with div newline injection).

## Readability library evaluation

Considered using `@mozilla/readability` (Firefox reader mode) for content
extraction. Conclusion: **not needed**. The chrome stripping problem was
primarily a container selection issue (preferring `<main>` when `<article>`
was a tighter boundary). After fixing that, chrome is well-contained on
all tested sites. The remaining "missing" content is genuine content
asymmetry or normalization bugs, neither of which readability addresses.

Readability would also require `jsdom` as a dependency (it needs a real DOM
API), which is significantly heavier than `node-html-parser`.

## Approaches tried (historical)

### Approach 1: Turndown HTML>MD then diff markdown

- Convert HTML to markdown via Turndown, diff against served markdown
- **Problem**: Turndown's formatting (setext headers, indented code, bullet
  spacing, relative vs absolute URLs) differs from served markdown, inflating
  diffs massively (80-100% on identical content).

### Approach 2: Turndown with content extraction + text normalization

- Extract `<article>`/`<main>` first, strip chrome tags, then Turndown
- Normalize: collapse whitespace, normalize bullets, strip link URLs
- **Problem**: Remaining formatting differences still produced 40-100% diffs.

### Approach 3: Plain text extraction + diffLines

- Skip Turndown entirely. Use DOM `.text` for HTML, regex strip for markdown.
- Filter to segments >=20 chars, use `diffLines()` from the `diff` package.
- **Problem**: `diffLines()` is positional, so reordered sections and
  reformatted paragraphs all counted as changes. 60-80% average on real sites.

### Approach 4: Containment checking (current)

- Same text extraction as approach 3, but instead of diffing, check whether
  each HTML segment appears anywhere in the markdown text.
- Added heuristic content container detection and chrome stripping.
- Session 1 results: 14-36% average across 10 sites.
- Session 2: Fixed container selection and normalization bugs, reducing
  false positives from chrome and matching issues.

## Bugs fixed in session 2

1. **Container selection hierarchy**: Rewrote container selection to always
   prefer the tightest container. The priority is now: heuristic selector
   inside article/main > article inside main > article > heuristic inside
   main > main > heuristic on root > body. On Neon, this eliminated all
   chrome (toolbar, CTAs, feedback widgets). On Val Town (Starlight), this
   finds `.sl-markdown-content` inside `<main>`, excluding sidebar chrome.

2. **Added `.sl-markdown-content` selector**: Starlight/Astro uses this
   class for the content area. `.markdown-content` (our existing selector)
   doesn't match because CSS class selectors require exact class name match.

3. **404 page detection**: Added `status` field to `FetchedPage` interface.
   The parity check now skips pages where the HTML URL returns HTTP 4xx/5xx.
   PostHog serves a novelty BSOD 404 page for API spec URLs that return 200
   for `.md` but 404 for HTML. Previously these showed 100% missing.

4. **Screen-reader-only text stripping**: Added `.sr-only` to strip selectors.
   Starlight adds `<span class="sr-only">Section titled "..."</span>` to
   every heading anchor, which inflated scores on Val Town and Daytona.

5. **Bullet/emphasis ordering**: Moved list bullet stripping before emphasis
   stripping in `extractMarkdownText()`. Previously, `* **SMTP Host**`
   was parsed as emphasis (`*...*`) instead of a bullet followed by bold,
   producing `SMTP Host*:` instead of `SMTP Host:`.

6. **Zero-width space stripping**: Added U+200B/200C/200D/FEFF removal to
   `normalize()`. Mintlify injects U+200B before heading anchors, which
   broke substring matching.

7. **Typographic quote normalization**: Added curly quote/dash/ellipsis
   normalization to `normalize()`. HTML renders `you'll` with U+2019 while
   markdown has straight `'` (U+0027).

## Bugs fixed in session 3

Tested against MongoDB docs (Leafygreen design system, Emotion CSS-in-JS).
Starting point: 16% avg, 7/25/16 P/W/F. After all fixes: 9% avg, 20/21/7.

1. **CSS-in-JS inside `<pre>` blocks**: `node-html-parser` treats `<pre>`
   content as raw text, so `<style>` tags injected by CSS-in-JS libraries
   (Emotion/Leafygreen, Radix UI) inside code blocks can't be found by
   `querySelectorAll('style')`. Their CSS declarations leak into `.text`
   output. Fixed by stripping `<style>...</style>` blocks (including
   content) from the text output before the generic tag cleanup regex.
   This also resolves the Radix UI CSS leak on PostHog (open question 4
   from session 2).

2. **Segment deduplication**: Identical text segments (e.g., breadcrumb
   titles repeated 3x) were counted separately, inflating percentages.
   Now deduplicates by normalized text before comparison. Breadcrumbs
   like "Sharded Cluster Components" appearing 3 times count as 1
   missing segment instead of 3.

3. **Underscore emphasis stripping**: The emphasis regex
   `(\*{1,3}|_{1,3})(.*?)\1` treated underscores in code identifiers as
   emphasis markers. `mongoc_client_get_database` had `_client_` matched
   as `_emphasis_`, producing `mongocclientget_database` and breaking
   containment matching. Fixed by restricting emphasis stripping to `*`
   only; underscores are far more common in code identifiers than in
   `_italic_` formatting in documentation.

4. **Minimum segment threshold**: Pages with fewer than 10 unique HTML
   segments now auto-pass. Small pages (landing pages, index stubs) have
   so few content segments that 2-3 breadcrumb items produce 30%+
   "missing." Validated on MongoDB: all pages below threshold had 0%
   missing. See "Minimum segment threshold" section above.

5. **Inline code before emphasis**: Moved backtick stripping before
   emphasis stripping in `extractMarkdownText()`. This ensures content
   inside backticks (which is literal in markdown) gets the backticks
   removed before the emphasis regex runs, preventing underscores in
   code from being misinterpreted.

### Session 3 results (MongoDB)

| Fix applied                | Avg missing | Pass/Warn/Fail |
| -------------------------- | ----------- | -------------- |
| Before fixes               | 16%         | 7/25/16        |
| + CSS-in-JS strip          | 11%         | 12/29/7        |
| + Segment dedup            | 10%         | 17/20/7        |
| + Underscore emphasis      | 10%         | 14/26/8        |
| + Min segment threshold    | 9%          | 20/21/7        |
| + Angle-bracket fix (full) | 6%          | 25/21/2        |

The two remaining failures after all fixes are genuine content gaps
(kubernetes reference architecture page, aggregation operator page).

6. **Angle-bracket placeholder preservation**: The tag stripping regex
   `/<[^>]+>/g` was removing placeholders like `<YOUR_API_KEY>` and
   `<field name>` decoded from HTML entities. Fixed with a two-part
   approach: (a) in `extractHtmlText()`, use a known HTML tag name set
   to distinguish real tags from placeholders; unknown "tags" keep their
   content. Handles both single-word (`<clusterName>`) and multi-word
   (`<field name>`) placeholders. (b) in `normalize()`, strip angle
   brackets while keeping content so both HTML-side and markdown-side
   produce the same text.

7. **HTML comment stripping**: Added `<!-- ... -->` removal from `.text`
   output. MongoDB's Leafygreen renders `<!-- -->` spacer comments that
   appear in pre block text output.

### MongoDB-specific documentation issues

Documented separately in `MONGODB-PARITY-ISSUES.md`. Key findings:

- **Abbreviation auto-expansion**: Build pipeline expands "TLS" to
  "TLS (Transport Layer Security)" in markdown but not HTML, breaking
  substring matching.
- **Code block line numbers**: Leafygreen table-based line numbers get
  concatenated with code content in text extraction.
- **Breadcrumbs without semantic markup**: Emotion class names, no aria.
- **CSS-in-JS inside pre**: Emotion `<style>` tags inside `<pre>`.

## Open questions

1. **Heading numbers**: HTML has `2. Setup` while markdown extraction strips
   the number prefix. Could skip number stripping when the line is a heading.

2. ~~**CSR pages**~~: Largely resolved by the link density heuristic in
   session 4. Knock went from 50% to 8% avg missing. The remaining 8% is
   genuine content differences, not nav contamination. Pure RSC shells with
   no DOM could still benefit from detection, but this is no longer a
   high-priority issue.

3. ~~**Breadcrumb chrome without semantic markup**~~: Partially resolved by
   the link density heuristic. If breadcrumbs live inside a high-link-density
   container (which they usually do), they get stripped with the rest of the
   nav. Standalone breadcrumbs are already handled by deduplication (counted
   once instead of repeated).

4. **Thresholds**: Confirmed reasonable after session 4. Clean sites (Loops
   3%, Neon 4%, Knock 8%) are in pass/warn territory. Sites with genuine
   content gaps (Vercel API ref 24%, Daytona multi-lang 18%) are flagged
   appropriately.

## Bugs fixed in session 4

Broad re-test across 11 sites. Investigated Knock (50% avg) and Daytona
(31% avg) as outliers; both had distinct root causes.

1. **Link density navigation stripping**: Knock's sidebar and header
   navigation used `<div>` tags instead of `<nav>`/`<aside>`, so our
   tag-based stripping couldn't remove them. All nav text (2925 chars)
   ended up in the extracted content alongside actual page content
   (2138 chars). Implemented a link density heuristic: after selecting
   the content container, walk its subtree and remove any element where

   > 70% of text is inside `<a>` tags and there are >10 links. This is
   > the same approach used by readability algorithms (Readability.js,
   > boilerpipe). It's class-name independent and won't affect tab content
   > (which has code, not links) or "Related resources" sections (which
   > have enough description text to stay well below the threshold).
   > Validated across Knock (88% link density in nav), Neon (79% in sidebar),
   > Resend (9% in content), and Loops (14% in content).

2. **Code line separation in `<pre>` blocks**: Daytona and Vercel use
   `<div class="ec-line">` or `<div class="line">` elements inside `<pre>`
   for syntax-highlighted code. Since `node-html-parser` treats `<pre>`
   content as raw text, our DOM-level block newline insertion can't reach
   these elements. Added `<div` newline injection in the text post-processing
   pipeline (before tag stripping) to separate code lines into individual
   segments. This improved matching for sites where code IS in the markdown
   (Daytona: 31% -> 18%, Stripe: 19% -> 10%) and provided more accurate
   per-line measurement for sites where code differs (Vercel: 17% -> 24%,
   which is genuine API ref content asymmetry, not a regression).

### Session 4 results (broad re-test)

| Site      | Before s4 | After s4 | P/W/F    | Change                                       |
| --------- | --------- | -------- | -------- | -------------------------------------------- |
| Knock     | 50%       | 8%       | 35/9/6   | Link density stripped nav panels             |
| Daytona   | 31%       | 18%      | 10/18/22 | Code line separation helped matching         |
| Stripe    | 19%       | 10%      | 21/20/5  | Code line separation helped matching         |
| Vercel    | 17%       | 24%      | 19/8/14  | More accurate: API ref code counted per-line |
| MongoDB   | 9%        | 9%       | 21/22/6  | Stable                                       |
| Resend    | 4%        | 5%       | 29/16/3  | Stable                                       |
| Neon      | 2%        | 4%       | 35/12/2  | Minor; sampling variance                     |
| Loops     | 3%        | 3%       | 36/8/2   | Stable                                       |
| Anthropic | 0%        | 0%       | 1/0/0    | Stable (1 page sampled)                      |
| PostHog   | 10%       | —        | —        | Not re-tested in s4                          |
| Val Town  | 15%       | —        | —        | Not re-tested in s4                          |

## Bug fixed in session 5: progressive disclosure in page discovery

Cloudflare and Supabase both failed the `markdown-content-parity`
prerequisite checks (`content-negotiation` and `markdown-url-support`)
despite both sites genuinely supporting markdown. The root cause was in
page discovery, not the checks themselves.

### Root cause

Both sites use progressive disclosure in their `llms.txt` files:

- **Cloudflare** (root): `llms.txt` links to 130 per-product `llms.txt`
  files (`/workers/llms.txt`, `/cache/llms.txt`, etc.), which in turn
  link to actual `.md` page URLs. Running against a sub-path like
  `/workers/` worked fine because that product's `llms.txt` links
  directly to page URLs.

- **Supabase**: `llms.txt` links to aggregate `.txt` files
  (`/llms/guides.txt`, `/llms/js.txt`, etc.). These contain inline
  markdown with relative links like `/docs/guides/auth`.

The page discovery pipeline (`getPageUrls`) extracted links from the
root `llms.txt`, but all extracted URLs were `.txt` files. The
`isNonPageUrl()` function correctly identified these as non-page URLs
and the checks skipped them all, resulting in "0/0 tested" and a fail
status.

Additionally, Supabase's aggregate files use root-relative URLs (e.g.
`/docs/guides/auth`) but `extractLinksFromLlmsTxtFiles` only kept
absolute URLs starting with `http://` or `https://`.

### Fix

Two changes to `src/helpers/get-page-urls.ts`:

1. **Relative URL resolution**: `extractLinksFromLlmsTxtFiles` now
   resolves root-relative URLs (`/path/...`) against the source file's
   origin.

2. **Aggregate file walking**: New `walkAggregateLinks()` function
   identifies `.txt` links on the same origin as the site being tested,
   fetches them, and extracts page URLs from them. This follows one
   level of progressive disclosure (root `llms.txt` → product/aggregate
   files → page URLs). Cross-origin `.txt` links are silently dropped
   (not pages, not walkable). Deeper `.txt` nesting is not followed.

### Results after fix

| Site              | Before                | After                                      |
| ----------------- | --------------------- | ------------------------------------------ |
| Cloudflare (root) | 0/0 tested, both fail | 17,351 pages discovered, both pass at 100% |
| Supabase          | 0/0 tested, both fail | 906 pages discovered, both warn at 40%     |

Supabase warns at 40% because its aggregate files contain links to blog
posts and dashboard routes alongside actual doc pages. Content
negotiation only works for `/docs/guides/*` pages. The warn status is
accurate.

### Tests added

5 new tests in `test/unit/helpers/get-page-urls.test.ts`:

- Walks aggregate `.txt` files (Cloudflare pattern with absolute URLs)
- Walks aggregate `.txt` files (Supabase pattern with relative URLs)
- Resolves relative URLs in root `llms.txt`
- Does not walk `.txt` files from a different origin
- Falls through to baseUrl when all aggregate files fail

Full suite: 380 tests passing, lint clean.

## Bugs fixed in session 6: Hugo/Congo dual-output false positives

GitHub issue #7 reported 19% avg missing on agentskillimplementation.com,
a Hugo site using the Congo theme with dual HTML + Markdown output
(`{{ .Content }}` for HTML, `{{ .RawContent }}` for markdown). The issue
attributed the failures to smart quotes, inline markdown syntax, and
whitespace differences, but all three were already handled by the
existing normalization. The actual root causes were different.

### Root causes

1. **Heading anchor `#` text**: The Congo theme adds an anchor link
   inside every heading: `<span class="opacity-0 ..."><a href="#..."
aria-label="Anchor">#</a></span>`. The `#` text from the `<a>` tag
   survived text extraction, so HTML segments became e.g.
   `Category 1: Loading Timing #` while the markdown had
   `Category 1: Loading Timing` (no trailing `#`). With ~36 headings
   on the checks page, this accounted for most of the 41 missing
   segments.

2. **Visually-hidden llms.txt directive banner**: The site includes a
   site-wide hidden `<div>` with the llms.txt directive text ("For AI
   agents: a documentation index is available at /llms.txt..."). It
   uses Tailwind's visually-hidden pattern (`w-px h-px overflow-hidden`
   with `clip:rect(0,0,0,0)` inline style) instead of `.sr-only`, so
   our existing `.sr-only` stripping didn't catch it. This is template
   chrome that doesn't exist in the raw markdown content.

### Fixes

1. **Added `[aria-label="Anchor"]` to STRIP_SELECTORS**: Removes
   heading anchor link elements during DOM cleanup. This is the same
   approach as stripping `.sr-only` for Starlight heading anchors;
   different theme, different markup pattern, same intent.

2. **Added `^for ai agents:` to NOISE_PATTERNS**: Filters out the
   first line of the llms.txt directive banner text at the segment
   level. The second line ("versions of all pages are available...")
   still appears as 1 missing segment but doesn't affect the score
   meaningfully.

### Results

| Page                          | Before               | After              |
| ----------------------------- | -------------------- | ------------------ |
| Homepage (index.md)           | 6% (3/53 missing)    | 2% (1/52 missing)  |
| Checks page (checks/index.md) | 31% (41/133 missing) | 3% (4/132 missing) |
| Overall                       | 19% avg, fail        | 3% avg, pass       |

Full suite: 446 tests passing, lint clean.

3. **Cross-line angle-bracket matching in `normalize()`**: The regex
   `<([^>]+)>` (meant to strip placeholders like `<YOUR_API_KEY>`)
   operated on the full markdown text as a single string. A literal `<`
   on one line (e.g., `< 5,000 tokens`) would match with a `>` hundreds
   of lines later, stripping the `<` and that distant `>` while
   preserving everything between. This distorted the normalized markdown
   text: the HTML segment `instructions (< 5,000` couldn't be found in
   markdown text that had `instructions ( 5,000` (missing `<`).

   This bug affected any page where markdown contains literal `<` or `>`
   characters, which is common in technical documentation (CLI flags,
   mathematical comparisons, HTML/XML examples). It was masked on
   previously tested sites because they didn't have stray `<` in their
   content, but would have surfaced on sites with more technical content.

   **Fix**: Changed the regex to `<([^>\n]+)>`, preventing matches
   across line boundaries. Placeholders like `<YOUR_API_KEY>` are always
   single-line, so this restriction is safe. This fixed 2 of the 4
   remaining residual segments.

4. **Inline code span protection in `extractMarkdownText()`**: The
   link stripping regex `[text](url) → text` and the emphasis regex
   `**bold** → bold` were running on the full markdown text without
   regard for inline code boundaries. Content inside backticks like
   `` `[API errors](url)` `` had its link syntax stripped on the
   markdown side (producing `API errors`), while the HTML side
   preserved the literal syntax inside `<code>` tags.

   This affected any documentation that shows markdown syntax as
   examples in inline code: style guides, CMS docs, writing guides,
   and meta-documentation about documentation tools.

   **Fix**: Replaced the sequential strip approach with a
   placeholder-based protection scheme. Before any markdown stripping
   runs, inline code spans (`` `...` ``) are replaced with null-byte
   placeholders (`\x00CODEn\x00`). All link, emphasis, and other
   stripping runs on the placeholder-protected text. Placeholders are
   then restored with the original literal content (without backticks).
   This ensures link/emphasis regexes never see content that was inside
   backticks.

   Edge cases verified:
   - Links containing code: ``[`code`](url)`` → correctly produces
     `code` (link stripped, placeholder restored)
   - Code containing emphasis: `` `**not bold**` `` → correctly
     preserves `**not bold**` (emphasis regex can't see it)
   - Placeholder markers can't collide with stripping regexes (use
     `\x00` null byte, not present in markdown content)

5. **Fenced code block protection in `extractMarkdownText()`**: Same
   issue as fix 4, but for fenced code blocks instead of inline code
   spans. Content inside ```fences (e.g., example llms.txt files with
headings, blockquotes, list items, and links) had those markdown
patterns stripped by subsequent regexes, while the HTML side preserved
them as literal text inside`<pre><code>` tags.

   **Fix**: Extended the placeholder scheme to fenced code blocks. Before
   inline code protection runs, entire fenced blocks are replaced with
   `\x00BLOCKn\x00` placeholders. Restored after all stripping. Fenced
   blocks are processed first so that backticks inside code blocks don't
   interfere with the inline code span regex.

6. **Entity-decoded HTML tag names in `extractHtmlText()`**: Documentation
   that discusses HTML elements (e.g., "strip `<nav>` and `<aside>`
   elements") has those tags entity-encoded in the HTML source as
   `&lt;nav&gt;`. When `node-html-parser` extracts `.text`, it decodes
   them back to `<nav>`. The tag stripping regex then treated these as
   real HTML tags and deleted them entirely, leaving gaps like
   `, , and  elements` in the extracted text.

   **Key insight**: Tags in STRIP_TAGS (`nav`, `footer`, `header`,
   `aside`, etc.) were already removed at the DOM level. Any occurrence
   of these tag names in `.text` output must be from entity decoding,
   not real elements. Tags NOT in STRIP_TAGS (`span`, `div`, `code`)
   legitimately appear in `<pre>` block text from syntax highlighting
   and should still be stripped.

   **Fix**: Added `DOM_STRIPPED_TAGS` set (mirrors STRIP_TAGS). The tag
   stripping regex now has three branches: DOM-stripped tags keep the
   tag name as text; other known tags are stripped entirely; unknown
   "tags" (placeholders like `<YOUR_API_KEY>`) keep full content.

### Updated results (after all six fixes)

agentskillimplementation.com:

| Page        | Before s6     | After all fixes |
| ----------- | ------------- | --------------- |
| Homepage    | 6% (3/53)     | 2% (1/52)       |
| Checks page | 31% (41/133)  | 1% (1/132)      |
| Overall     | 19% avg, fail | 2% avg, pass    |

agentdocsspec.com (also tested, same Hugo/Congo setup):

| Page      | Before s6 fixes | After all fixes |
| --------- | --------------- | --------------- |
| Homepage  | 2% (1/50)       | 2% (1/50)       |
| Spec page | 12% (109/941)   | 10% (96/941)    |
| Overall   | 7% avg, warn    | 6% avg, warn    |

The spec page is uniquely challenging because it's meta-documentation
that discusses HTML tags, markdown syntax, and code fences in its prose.
The remaining 96 missing segments on the spec page are driven by:

- **Double-backtick code spans**: The spec uses ` ``` ` (double
  backtick-enclosed triple backtick) to show literal code fence syntax.
  Our inline code regex only handles single-backtick spans. Double-
  backtick spans are a valid markdown feature but significantly rarer.
- **Remaining entity-decoded tags**: Some tags like `<code>` appear
  both as real tags in `<pre>` blocks and as entity-decoded mentions
  in prose. These can't be distinguished with the DOM_STRIPPED_TAGS
  approach since they weren't stripped at the DOM level.

### Remaining residual segment on agentskillimplementation.com

After all six fixes, only 1 segment doesn't match on each page:

- `versions of all pages are available by appending index.md...` —
  Second line of the llms.txt directive banner. Template chrome that
  genuinely doesn't exist in the raw markdown content.

At 1-2% total these are well within the pass threshold.

### Tests added in session 6

15 new tests added (15 → 30 total) covering all session 2-3-6 fixes:

Session 6 fixes:

- Heading anchor `#` stripping (`[aria-label="Anchor"]`)
- llms.txt directive noise filtering (`^for ai agents:`)
- Cross-line angle-bracket normalization (`[^>\n]`)
- Inline code span protection (placeholder scheme)
- Fenced code block protection (placeholder scheme)
- Entity-decoded HTML tag name preservation (`DOM_STRIPPED_TAGS`)

Session 2 fixes (previously untested):

- Typographic quote normalization (curly → straight)
- Zero-width space stripping (U+200B)
- `.sr-only` screen-reader text stripping
- Bullet/emphasis ordering (`* **Bold**`)

Session 3 fixes (previously untested):

- CSS-in-JS `<style>` stripping inside `<pre>`
- Segment deduplication (repeated chrome)
- Underscore emphasis preservation (code identifiers)
- Angle-bracket placeholder preservation (`<YOUR_API_KEY>`)
- HTML comment stripping

Full suite: 461 tests passing, lint clean.

## Session 7: CommonMark-compliant inline code span handling

### Root cause: cascading backtick mispairing

The single-backtick code span regex `` `([^`]+)` `` had two critical
problems that caused it to swallow large sections of text into protected
placeholders, preventing bullet/emphasis stripping from running on those lines:

1. **Double-backtick code spans not handled.** Markdown like ` ` `` ` ``
   (showing literal triple backticks) was parsed by the single-backtick regex,
   which misidentified the delimiter boundaries. Stray backticks from the
   broken parse paired with distant backticks, swallowing entire sections.

2. **Bare triple backticks in prose caused cascade.** When unmatched triple
   backticks appeared in prose (e.g., discussing code fence syntax), the
   single-backtick regex paired one of the backticks with a distant backtick
   in a completely unrelated code span like `` `llms.txt` ``, swallowing
   everything in between. This shifted all subsequent backtick pairing for
   the rest of the file.

### Fixes applied (session 7)

#### Fix 7: Double-backtick code span support

Added a new regex pass before single-backtick processing to handle
double-backtick delimited code spans:

```
/(?<!`)``(?!`)([\s\S]*?)(?<!`)``(?!`)/g
```

The lookbehind/lookahead assertions enforce the CommonMark rule that a
backtick string must not be preceded or followed by another backtick.
This prevents `` inside ``` from being treated as a valid delimiter.

#### Fix 8: CommonMark space stripping for multi-backtick content

When code span content starts and ends with a space (and isn't entirely
spaces), CommonMark strips one space from each end. Without this,
` ` ``` `` `` would produce ` ``` `(with extra spaces) on the markdown
side while the HTML side renders just` ``` `. Added the stripping rule
to the double-backtick handler.

#### Fix 9: CommonMark-compliant single-backtick matching

Changed the single-backtick regex from:

```
/`([^`]+)`/g
```

to:

```
/(?<!`)`([^`]+)`(?!`)/g
```

The lookbehind/lookahead prevents a single backtick that's part of a
longer backtick run (like ```) from being treated as a standalone
delimiter. This stops the cascading mispairing problem.

### Results after session 7

| Site                          | Before               | After              | Status           |
| ----------------------------- | -------------------- | ------------------ | ---------------- |
| agentdocsspec.com (spec page) | 10% (96/941 missing) | 0% (1/941 missing) | pass             |
| agentdocsspec.com (homepage)  | 2% (1/50 missing)    | 2% (1/50 missing)  | pass             |
| agentskillimplementation.com  | 2% avg (pass)        | 2% avg (pass)      | pass (no change) |

The one remaining segment on both agentdocsspec.com pages is the same
template chrome text ("versions of all pages are available by appending
index.md...") that genuinely doesn't exist in the raw markdown content.

### Tests added in session 7

3 new tests added (30 → 33 total):

- Double-backtick code spans containing literal backticks
- Bare triple backticks in prose not cascading into distant backtick pairing
- CommonMark space stripping for multi-backtick code span content

Full suite: 464 tests passing, lint clean.

## Session 8: Underscore emphasis stripping with word boundaries

### Root cause

The `extractMarkdownText()` function stripped `*` emphasis but not `_`
emphasis. This was a deliberate decision from session 3 (fix 3) to protect
code identifiers like `mongoc_client_get_database` from being mangled into
`mongocclientget_database`. However, this caused false parity mismatches
on any page using `_emphasis_` formatting: the HTML side extracted plain
text (`worse`), while the markdown side preserved the underscore markers
(`_worse_`).

The session 6 inline code span placeholder protection (fix 4) resolved the
original concern for identifiers _inside backticks_, but identifiers in
plain text (not wrapped in backticks) were still vulnerable. A blanket
strip of `_` emphasis would break those cases.

### Fix: CommonMark word-boundary rule

Changed the `_` emphasis regex from a blanket strip to one that respects
CommonMark's delimiter rules. Per CommonMark, `_` is only an emphasis
delimiter when it is NOT adjacent to an alphanumeric character:

```
Before: (no _ stripping)
After:  /(?<!\w)(_{1,3})(.*?)\1(?!\w)/g
```

The `(?<!\w)` lookbehind and `(?!\w)` lookahead ensure that underscores
adjacent to word characters (as in `mongoc_client_get_database`) are
never treated as emphasis delimiters, while standalone emphasis like
`_text_` (preceded/followed by spaces or punctuation) is correctly
stripped.

This handles both scenarios:

- `Use _emphasis_ here` → `Use emphasis here` (matches HTML extraction)
- `mongoc_client_get_database` → preserved as-is (underscores adjacent
  to word characters, not emphasis)

### Fix: Single-backtick spans with backtick content

The session 7 single-backtick regex `(?<!`)`([^`]+)`(?!`)`uses`[^`]+` for content, which prevents matching code spans whose content includes
backtick runs (e.g., `` ` ``` ` `` where the triple backtick is content).
These spans were left unprotected, causing parity mismatches: the HTML
side had ```` ``` ``` (from `<code>``</code>`) while the markdown side
had `` ` ``` ` `` (with backtick delimiters still present).

Changed the content pattern from `[^`]+`to`(?:[^`]|`{2,})+`, which
allows multi-backtick runs (length >= 2) inside single-backtick spans.
Also added `(?!`)` to the opening delimiter to prevent bare triple
backticks in prose from cascading into distant backtick pairing (the
same protection session 7 fix 9 provided):

```
Before: /(?<!`)`([^`]+)`(?!`)/g
After:  /(?<!`)`(?!`)((?:[^`]|`{2,})+)(?<!`)`(?!`)/g
```

Both opening and closing delimiters now require `(?<!`)`and`(?!`)`,
ensuring only standalone single backticks (not part of a multi-backtick
run) can serve as delimiters. CommonMark space stripping is also applied
to match what HTML rendering produces.

### Results

All 38 parity unit tests pass, including the existing session 3 test for
code identifier preservation and the session 7 test for bare triple
backtick cascading. The afdocs.dev docs site (which uses `_` emphasis
and `` ` ``` ` `` code spans throughout) now passes parity at 0% missing
without needing workarounds in its markdown generation pipeline.

Full suite: 1215 tests passing, lint clean.

## Session 9: Strip form-control chrome

External contributor PR (#70) added `select`, `input`, and `textarea` to
`STRIP_TAGS`. Form controls like language pickers, version selectors, and
search boxes appear in the HTML reference but have no markdown equivalent,
so their option/placeholder text was inflating "missing" scores on sites
that use them.

This is consistent with the existing `button` strip (also a form control,
also chrome with no markdown analogue). All three tag names were already
present in `HTML_TAG_NAMES`, so entity-decoded mentions of these elements
in prose (e.g., docs that discuss `<input>` elements) continue to be
preserved as text via the `DOM_STRIPPED_TAGS` path rather than being
deleted entirely.

### Test added

1 new test (40 → 41 total):

- Strips `<select><option>` form-control chrome before comparison; page
  with 11 paragraphs and a 2-option language picker passes at 0 missing
  segments.

Full suite: 1216 tests passing, lint clean.

## Session 10: DOM-aware HTML extraction and heading-line protection

External issues #90 and #91 reported parity false positives that
remained after sessions 1–9. Both stemmed from text-level pattern
matching that couldn't distinguish "markdown source" from "rendered
output" in two specific cases.

### Issue #90: inline `<tag>` code spans get text-stripped

A code span like `` `<code>` `` in markdown renders to
`<code>&lt;code&gt;</code>`. After `node-html-parser`'s `.text` decodes
entities, the flat-text output contains a literal `<code>` substring.
The tag-stripping regex couldn't tell that apart from a real `<code>`
element from `<pre>` raw-text content (where syntax-highlighter markup
survives), so it deleted the `<code>` text entirely. Markdown side had
"the HTML code tag", HTML side had `"the HTML  tag"` — substring
containment failed.

The same bug affected `<main>`, `<title>`, `<h1>`, `<link>`, `<a>`,
`<nav>`, `<em>`, `<article>`, `<section>` and any other HTML tag name
mentioned inline in technical prose.

### Issue #91: numbered-list regex strips leading "1. " from headings

A heading `### 1. How well are X supported?` renders to `<h1>1. How
well are X supported?</h1>`, where the `1.` is part of the heading
text. But `extractMarkdownText` ran the heading-marker strip and the
numbered-list strip in sequence on the same line: first `### ` →
`1. How well...`, then `1. ` → `How well...`. HTML side kept the
number, markdown side dropped it, segments didn't match.

### Why session 8's underscore fix made #89 a non-issue

Issue #89 (underscore emphasis not stripped) was already resolved in
session 8 (commit `9d675a3`, shipped in 0.18.0). The reporter quoted
older code in the issue body. Verified against the existing
"strips underscore emphasis at word boundaries" test plus a manual
repro of the reporter's exact example (`my office was _cold_ and
dark`). Recommended action: comment on the issue and close.

### Fix 10a: DOM walker replaces flat-text + regex pipeline

The accumulated text-level patches from sessions 3, 4, and 6 (CSS-in-JS
strip, comment strip, `<div` newline injection, closing-tag strip,
opening-tag strip with `HTML_TAG_NAMES`/`DOM_STRIPPED_TAGS` dispatch,
placeholder-tag preservation) all existed because `node-html-parser`
treats `<pre>` content as a single raw text node, leaving inner
syntax-highlighter markup as literal text. Once you commit to flat
text, a tag mention in prose like `<code>` from entity decoding becomes
indistinguishable from a real `<code>` element that survived as raw
pre text.

Replaced `content.text` + 5 regex passes with a DOM walker that:

1. For text nodes: emit the decoded text as-is.
2. For block elements: emit newlines around children, recurse.
3. For `<pre>`: re-parse its `rawText` as HTML and walk that subtree.
   This exposes inner `<span>`/`<code>`/`<div>` as real DOM nodes whose
   textContent is just the code (no markup leaking through).
4. For inline elements: recurse into children. `<code>` containing
   entity-decoded `&lt;code&gt;` walks to a text node holding the
   literal string `<code>`, which `normalize()` then bracket-strips to
   "code" — matching the markdown-side behavior.
5. Defensive skip of `STRIP_TAGS` tags (script/style/etc.) inside
   re-parsed `<pre>` content (e.g., a stray Emotion `<style>` block).

The `HTML_TAG_NAMES` set was deleted entirely. The `DOM_STRIPPED_TAGS`
set is kept solely for the re-parsed-pre defensive skip.

### Fix 10b: heading-line placeholder protection in extractMarkdownText

Replaced the heading-marker strip with a placeholder-protection pass
that captures heading content (everything after `^#{1,6}\s+`) into a
`headings[]` array, leaving `\x00HEAD<n>\x00` markers in the text.
List-marker strips (bullets, numbered) run on the protected text,
unable to touch heading content. Headings are restored after the
list-marker strips but before emphasis/link/blockquote strips so
those passes still apply to heading text (matching how the HTML side
extracts heading text — `<h1><em>Foo</em></h1>` → "Foo").

The pipeline order is now:

1. Protect fenced code blocks (`\x00BLOCK<n>\x00`).
2. Protect inline code spans (`\x00CODE<n>\x00`).
3. Protect heading content (`\x00HEAD<n>\x00`).
4. Run setext-underline, ref-link-def, bullet, numbered-list strips.
5. Restore heading content.
6. Run link/image, emphasis, blockquote, hrule strips.
7. Restore inline code spans.
8. Restore fenced code blocks.

### Validation against the 20 sites in this document

Captured baseline JSON output for all 20 sites listed across sessions
1–9 before the fix, then re-ran with the fix. Stored in
`parity-baseline-results/` and `parity-postfix-results/` (gitignored
locally; not committed).

Improvements (3 sites):

| Site    | Before            | After            |
| ------- | ----------------- | ---------------- |
| mongodb | fail 8% (20/22/5) | warn 2% (40/7/0) |
| resend  | fail 4% (33/13/3) | warn 1% (45/4/0) |
| posthog | warn 1%           | pass 0%          |

Bucket shifts at the same avg% (5 sites): loops, valtown, stripe,
pinecone, cloudflare — all moved one or two pages from fail/warn into
pass.

Regressions: **none**.

dacharycarey.com (the explicit issue-repro target): 4 pages improved,
46 unchanged, 0 worse. The audit-conclusions blog post (the
#90/#91 repro) went from 6 missing / warn to 0 missing / pass. The
make-hugo-site-agent-friendly post (a meta-page about agent-friendly
docs that mentions HTML tags throughout) went from 13/298 missing to
1/297.

### Tests added in session 10

2 new tests (42 → 44 total):

- `preserves inline \`<tag>\` code spans on the HTML side (issue #90)`:
page with `` `<code>` ``, `` `<main>` ``, `` `<title>` ``, `` `<h1>` ``,
`` `<link>` ``, `` `<a>` ``, `` `<nav>` ``, `` `<em>` ``, `` `<article>` ``,
`` `<section>` `` mentions in prose passes at 0 missing.
- `preserves leading numbers in headings (issue #91)`: page with four
  `### 1. ...` through `### 4. ...` numbered research-question headings
  passes at 0 missing.

Full suite: 1294 tests passing, lint clean, type-check clean.

### Code deleted

The `HTML_TAG_NAMES` set (~110 lines) is gone. The text-level regex
chain in `extractHtmlText` (`<style>` strip, comment strip, `<div`
newline injection, closing-tag strip, opening-tag dispatch) is
replaced by a 40-line DOM walker. Net diff: 156 deletions, 221
insertions (the additions are mostly the heading-protection logic and
the new tests).

## Session 11: Backslash escapes and a CommonMark code-span scanner

Issue #110 (kysely.dev, reported against 0.20.0; fixed in PR #114).

### Root cause: escape backslashes treated as content

`extractMarkdownText` kept Markdown escape backslashes, so prose like
`snake\_case`, `string\[]`, or `ReferenceExpression\<DB, "person">`
never matched the HTML rendering (`snake_case`, `string[]`,
`ReferenceExpression<DB, "person">`). Docusaurus/MDX and Turndown both
emit these escapes liberally in prose, so any page with a snake_case
identifier outside backticks lost that segment. kysely.dev's homepage
and `/docs/plugins` were flagged for exactly this.

### Why escapes and code spans had to become one pass

Escape handling cannot be bolted on as a regex pass either side of the
session 7/8 code-span regexes. CommonMark resolves the two positionally
in a single left-to-right scan:

- `` \`literal\` `` is prose: the backslash consumes the first backtick,
  so no code span opens. Running the code-span regexes first turned this
  into a span with content `literal\` and a stray leading backslash.
- `` `C:\Users\` `` is one code span: backslashes inside an open span are
  literal. Running escape handling first would have eaten the `` \` `` and
  swallowed the closer.

### Fix 11: `protectCodeSpansAndEscapes` scanner

Replaced the double-backtick and single-backtick regexes (session 7 fixes
7-9, session 8 backtick-content fix) with one scanner that follows
CommonMark §2.4 and §6.1 directly:

- A backtick run of length N opens a code span closed by the next run of
  exactly N backticks. This is the rule the old lookbehind/lookahead
  regexes were approximating, so a double-backtick span containing a
  single backtick, a single-backtick span containing a triple-backtick
  run, and a bare triple-backtick run with no partner all behave as
  before. One-space trim is unchanged.
- A code span cannot pair across a blank line (paragraph boundary). This
  is new and stricter than the old regexes, which allowed `[\s\S]*?`
  across the whole file. It closes the remaining cascade path where a
  stray backtick pairs with one far away.
- Outside code spans, a backslash followed by ASCII punctuation becomes a
  `\x00ESC<n>\x00` placeholder holding the bare character. The heading,
  list, link, and emphasis passes never see the backslash and never see
  the escaped character as syntax (`\*not bold\*`, `1\. not a list`,
  `\# not a heading` all survive). Escapes are restored in the final
  step, after formatting is stripped, so a restored `*` or `_` is not
  re-read as emphasis.
- Backslashes inside code spans and fenced blocks are untouched, matching
  what `<code>` / `<pre>` preserve on the HTML side.

Pipeline order is now: protect fences; scanner (code spans + escapes);
protect headings; list/setext/ref-def strips; restore headings;
link/emphasis/blockquote/hrule strips; restore escapes, code spans,
fences.

### Validation: dual-extractor run against the 20 sites

Rather than compare against the Sept 13 `parity-postfix-results/` (site
drift since then would confound the comparison), the worktree build was
temporarily instrumented to run both the old and new `extractMarkdownText`
on the same fetched content and record, per HTML segment, which
extractor matched it. One network pass, same flags as
`working-notes/run-parity-baseline.sh`.

| Site           | Old missing | New missing | Regress | Improve |
| -------------- | ----------- | ----------- | ------- | ------- |
| afdocsdev      | 0/1271      | 0/1271      | 0       | 0       |
| agentdocsspec  | 14/2071     | 14/2071     | 0       | 0       |
| agentskillimpl | 266/1752    | 204/1752    | 0       | 62      |
| anthropic      | 0/0         | 0/0         | 0       | 0       |
| cloudflare     | 36/1748     | 33/1748     | 0       | 3       |
| dacharycarey   | 2/3495      | 1/3495      | 0       | 1       |
| daytona        | 197/7258    | 61/7258     | 0       | 136     |
| knock          | 3465/4181   | 3465/4181   | 0       | 0       |
| loops          | 8/1285      | 5/1285      | 0       | 3       |
| mongodb        | 106/2324    | 94/2324     | 0       | 12      |
| neon           | 24/25       | 24/25       | 0       | 0       |
| openai         | 276/7137    | 269/7137    | 0       | 7       |
| pinecone       | 71/1648     | 46/1648     | 0       | 25      |
| plaid          | 525/4428    | 419/4428    | 0       | 106     |
| posthog        | 6/755       | 0/755       | 0       | 6       |
| resend         | 21/1688     | 21/1688     | 0       | 0       |
| stripe         | 578/2631    | 575/2631    | 0       | 3       |
| supabase       | 188/1736    | 181/1736    | 0       | 7       |
| valtown        | 97/1483     | 95/1483     | 0       | 2       |
| vercel         | 360/2995    | 359/2995    | 0       | 1       |

Totals: 51,911 segments compared, **0 regressions**, 374 improvements.
Sampled improvements are all escape cases: `run_code`, `DEFAULT_UPDATE`,
`[daytona.GitService.Clone]`, `(message: OutputMessage) => any`.

Knock and Neon are unchanged and remain genuine content gaps (Knock's
markdown is a stub; Neon's single sampled page is a landing page).

kysely.dev (the issue's target): homepage 0/38 missing, `/docs/plugins`
0/12 missing, both pass.

### Known residual risk: indented code blocks

Indented (4-space) code blocks are not fence-protected in step 1, so
backslashes inside them (`\"`, `\$`, `\.`, `\\`) are now unescaped on
the markdown side while `<pre>` keeps them. Protecting indented blocks
is not straightforward because list continuation paragraphs are also
indented 4 spaces (see the session 10 "fenced code blocks indented
inside list items" test). None of the 20 sites hit this; Turndown
defaults to indented code, so a site using stock Turndown output with
backslash-heavy code could. Revisit if a report comes in.

### Tests added in session 11

4 new tests (48 → 52 total). Three fail on the pre-fix code; the
code-content test passes on both and guards the boundary.

- `treats backslash-escaped punctuation as the literal character (issue #110)`:
  `snake\_case`, `Foo\<T>`, `string\[]`, `\*`, `\|`, `\\` in prose.
- `does not interpret escaped punctuation as markdown formatting`:
  `\*not bold\*`, `\_not italic\_`, `\[not a link](x)`, `\#`, `1\.`,
  `\-` at line start, `` \`not code\` ``.
- `preserves literal backslashes inside inline code and fenced code blocks`:
  regex and Windows-path examples in inline code and fenced blocks.
- `still detects genuinely missing content when markdown uses escapes`:
  a paragraph present only in HTML is still reported as 1 missing.

Fixtures are padded past `MIN_SEGMENTS_FOR_COMPARISON` (10); an earlier
draft with 7-8 segments auto-passed and hid the bug.

Full suite: 1364 tests passing, lint clean, type-check clean.

## Session 12: Fern OpenAPI reference pages (issue #106)

Issue #106 (docs.nvidia.com/nemo-platform, Fern-hosted, filed 2026-08-24
against 0.20.0) reported 45–70% missing on OpenAPI endpoint pages and
13–18 of 50 sampled pages flagged. The issue named two causes and
proposed three fixes. Only one of the causes reproduces today, and it is
not the one the issue emphasised.

### What the issue attributed the failures to

1. **Schema-row serialization.** Fern renders each schema field as a flex
   row of adjacent inline spans (key, type badge, required badge). The DOM
   text runs together as `workspacestringRequired`, which can never match
   the markdown's `- \`workspace\` (string, required)`.
2. **Typographic quotes.** Curly quotes in HTML vs straight quotes in
   markdown.

### What actually reproduces

**Cause 2 was already handled.** `normalize()` has folded curly quotes,
en/em dashes and the ellipsis since session 2 (shipped long before
0.20.0). The example page has 15 curly quotes in the article and every
segment containing one matches. Same pattern as issue #7 in session 6:
the reporter's diagnosis named normalization that already existed.

**Cause 1 no longer reproduces, because Fern changed its markup.** On the
current page the type/required badges sit in
`<span class="fern-api-property-meta" data-markdown-ignore="">`. The check
has stripped `data-markdown-ignore` since 0.17.0 (session "audience
segmentation", April), so the row's remaining text is the bare key,
which is under `MIN_SEGMENT_LENGTH` and drops out. What is compared is
the field descriptions, which the markdown carries.

Confirmed by ablation rather than by history: stripping the attribute
from the saved HTML and re-running the extractor gives 23/43 missing
(53%) with exactly the segments the issue quoted
(`workspacestringRequired`, `default_model_entitystringOptional`,
`autoprovisionedbooleanOptionalDefaults to false`). With the attribute,
1/24 missing (4%, pass). Every relevant extractor feature (`.prose`
container, DOM walker, `data-markdown-ignore`) predates 0.20.0, so the
HTML must have changed between August and now. Fern's docs frontend is
not publicly searchable and the Wayback Machine has no snapshot of the
page, so the exact date is unconfirmed; the mechanism is not. Fern is a
hosted platform, so the change applies to every Fern site at once. This
is the `data-markdown-ignore` convention working as designed: the
platform declares human-only chrome instead of the checker guessing.

The issue's third suggestion (treat `Ask a question | Copy page | View
as Markdown` as chrome inside `<article>`) is moot: that toolbar lives in
an `<header>` inside the article, which `STRIP_TAGS` removes, and the
`.prose` container selection excludes it anyway. Zero occurrences in the
extracted text.

### What still failed on the live site, and the fix

One 50-page deterministic run against `https://docs.nvidia.com/nemo-helix/`
(the `nemo-platform` prefix now redirects there; see the discovery note
below) on the pre-fix code: 47/1/2 P/W/F, avg 2%, overall **fail**
because the check aggregates worst-status. The two failing pages (17 and
10 segments) and the one warn page showed a pattern none of sessions 1–11
had seen: **the HTML shows unrendered markdown.**

- `list-workspaces`: the endpoint description is displayed in a
  `whitespace-pre-wrap` block as raw text, so HTML segments are
  `- page, page_size: Pagination` with a literal list marker. The
  markdown has the same lines as real list items, and
  `extractMarkdownText` strips the marker on that side only.
- `gateway-proxy-put`: same raw display, so the HTML carries literal
  backticks (``must resolve to a `VirtualModel`.``) and hard line wraps.
  The markdown side has the backticks removed as code-span delimiters.
- `list-deployment-config-versions`: markdown source `--`, HTML em dash.
  `normalize()` folded `—` to `-` but left `--` alone.

All three are the same shape as the angle-bracket rule that has been in
`normalize()` since session 3: a character that is syntax on one side
and literal text on the other. Fix 12 adds three rules to `normalize()`:

1. `-{2,}` → `-` (after the en/em dash fold, so `--`, `---` and `—` all
   become one hyphen).
2. Drop every backtick.
3. Strip one leading list marker (`-`, `*`, `+`, `N.`) after the final
   trim.

**Why these are safe to add without a per-site review.** Each rule is
applied identically to the needle (HTML segment) and the haystack
(markdown text) and either deletes or collapses a fixed character set or
trims the needle's leading edge. Deleting the same characters from both
strings preserves substring containment, and shortening the needle to a
suffix does too. So a rule of this class can turn a missing segment into
a match but never the reverse. The one indirect effect is deduplication:
two HTML segments that now normalize identically merge, which lowers the
segment count by one and can move a rounded percentage by a point. The
dual run below found no case where that changed a bucket. The docstring
on `normalize()` now states this invariant so future additions are held
to it.

### Rejected alternative: token-level containment fallback

The issue proposed that a segment whose word tokens all appear in the
markdown (in order, or as a set) should count as present. Rejected. Set
containment would mark almost any prose "present" on a long page, since
common words appear somewhere; ordered-subsequence containment is only a
little stricter. Either one changes what "missing" means for every site
and would mask the genuine gaps this check exists to find (Knock's stub
markdown, Stripe's API pages). The whole history of this check is
tightening extraction and normalization so that exact containment is
fair, not loosening the comparison when it is not. The schema-row case
that motivated the suggestion is already solved at the source by
`data-markdown-ignore`; a platform that renders similar badges without
the attribute has `--parity-exclusions` for the same effect.

Also considered and rejected: inserting a space between adjacent inline
element siblings in the DOM walker. It would fix `workspacestringRequired`
generically but corrupts every syntax-highlighted code line
(`<span>foo</span><span>(</span>` → `foo (`), and exempting `<pre>` still
leaves inline `<code>` with nested spans exposed.

### Validation: dual-normalize run against the 20 sites plus the issue's site

Same method as session 11: the worktree build was instrumented to run
both the old and new `normalize()` on the same fetched content and log
every segment where the two disagreed. One network pass, baseline-script
flags, 21 sites.

| Site           | Old missing | New missing | Regress | Improve |
| -------------- | ----------- | ----------- | ------- | ------- |
| afdocsdev      | 0/1265      | 0/1265      | 0       | 0       |
| agentdocsspec  | 14/2071     | 14/2071     | 0       | 0       |
| agentskillimpl | 204/1748    | 186/1748    | 0       | 18      |
| anthropic      | 0/0         | 0/0         | 0       | 0       |
| cloudflare     | 33/1678     | 32/1678     | 0       | 1       |
| dacharycarey   | 1/3453      | 1/3453      | 0       | 0       |
| daytona        | 56/726      | 56/726      | 0       | 0       |
| knock          | 3465/4181   | 3465/4181   | 0       | 0       |
| loops          | 5/1246      | 5/1246      | 0       | 0       |
| mongodb        | 94/2278     | 94/2278     | 0       | 0       |
| neon           | 24/25       | 24/25       | 0       | 0       |
| openai         | 269/7119    | 268/7119    | 0       | 1       |
| pinecone       | 46/2024     | 46/2024     | 0       | 0       |
| plaid          | 419/4410    | 419/4410    | 0       | 0       |
| posthog        | 0/3460      | 0/3460      | 0       | 0       |
| resend         | 21/1658     | 20/1658     | 0       | 1       |
| stripe         | 459/1598    | 459/1598    | 0       | 0       |
| supabase       | 181/1721    | 180/1721    | 0       | 1       |
| valtown        | 95/1431     | 95/1431     | 0       | 0       |
| vercel         | 359/2995    | 335/2995    | 0       | 24      |
| nemohelix      | 16/2654     | 7/2654      | 0       | 9       |

Totals: 47,741 segments compared, **0 regressions**, 55 improvements.
Sampled improvements are all literal-backtick prose (Vercel CLI docs:
``Revoke the token with ID `tok_abc123`.``; Resend: ``Select the event
type `email.received`.``) and `--`/em-dash pairs (agentskillimpl).

docs.nvidia.com/nemo-helix (the issue's target) after the fix: 49/1/0,
avg 0%, **warn**. The remaining warn is `gateway-proxy-put` at 1/10: the
HTML says "a map from strings to any" and the markdown says "a map from
string to any". That is Fern's generator disagreeing with itself and is
correctly reported. Sampled API reference pages: 18 of 50, 17 pass.

### Discovery note (out of scope, not changed)

Running against the issue's original URL `docs.nvidia.com/nemo-platform/`
now discovers only the landing page (`discoverySources: ["fallback"]`,
2m21s). The prefix 301s to `nemo-helix`, whose root `llms.txt` links only
to per-version indexes (`/nemo-helix/latest/llms.txt`), and discovery
does not follow that across the redirected prefix. Running against
`nemo-helix/` directly walks the version index (370 pages) and works.
Recorded here so the next discovery session can decide whether a
redirected base URL should re-anchor discovery; per
`page-discovery-notes.md` that is a design decision, not a quick flip.

### Tests added in session 12

2 new tests (52 → 54 total):

- `strips inline data-markdown-ignore badges in API schema rows (issue #106)`:
  Fern's exact row shape (adjacent key/badge spans in a flex row, badges
  tagged). Passes at 0 missing with the attribute and asserts the
  untagged variant reports `default_model_entitystringOptional` as
  missing, so the fixture is proven to exercise the run-together path.
- `matches HTML that shows markdown syntax verbatim (issue #106)`: a
  `whitespace-pre-wrap` block with literal backticks, `- ` and `N. `
  markers and hard wraps, plus a `--` vs em dash paragraph. Fails on the
  pre-fix `normalize()` with 5 missing; passes at 0 after. Note the
  fixture must not put `.prose` on the raw block, or the container
  heuristic selects just that block and the page falls under the
  10-segment gate.

Full suite: 1377 tests passing, lint clean, type-check clean.

## Session 13: item counts for generated pages (spec v0.6.0)

Spec v0.6.0 extended the parity notes with guidance for dynamically
generated pages: compare item counts between representations, and
distinguish default-filter divergence, pagination windowing, and staleness.
Landed with `embedded-data-serialization` (#125). Design and field results
are in `embedded-data-serialization-notes.md`; the parity-side facts:

- **Nothing about the status changed.** Containment, thresholds, and the
  10-segment gate are untouched. The extension adds an `itemCounts` detail
  per page and an `itemCountDivergences` count; it is read by the
  `dynamic-content-rendered-statically` diagnostic.
- **Why containment needs it.** The spec's case is a catalog whose HTML
  showed 98 items under a default filter while the markdown listed 102.
  Nothing is missing from the markdown, so containment passes; the
  representations still disagree.
- **What is counted.** `extractHtmlText` now also returns the largest list
  (direct `li` children of one list) and the largest table (data rows) in
  the container it selected, after the existing chrome stripping.
  `countMarkdownItems` measures the top-level items of the largest
  contiguous list block (nested bullets excluded, mirroring the HTML side)
  and the largest pipe table outside fences, honouring CommonMark fence
  lengths, and deduplicates entries within that block with the check's own
  `normalize()`. Largest structure rather than a sum, so small
  side lists do not shift the count.
- **Gates.** Compared once either side reaches 20 items; a cause is named
  only when both sides have at least 5 (one side at zero is an extraction
  artifact: a pure-link list removed by the link-density heuristic, or a
  client-rendered table). Divergence is more than one item and more than
  2% (the first draft's 10% missed the spec's own 4% example).
- **Live.** On build.nvidia.com/models the markdown lists 200 entries of
  which 100 are distinct (the duplication first seen in the
  single-fetch-completeness field run), against 24 items in the largely
  client-rendered HTML; reported as a divergence with `default-filter` as
  the best guess, and as 100 duplicates.

Tests added (10): equal counts, no repeated structure, default filter,
pagination, staleness, duplicated entries, table rows versus header rows,
and, from the Copilot round on PR #130, nested bullets counted once, a
four-backtick fence not closed by a three-backtick line, and duplicates
scoped to the compared list rather than the document.

## Files modified

- `src/checks/observability/markdown-content-parity.ts` - main implementation
- `test/unit/checks/markdown-content-parity.test.ts` - 40 unit tests
- `src/types.ts` - added `status` field to `FetchedPage` interface
- `src/helpers/fetch-page.ts` - populate `status` field from HTTP response
- `package.json` / `package-lock.json` - removed `diff` and `@types/diff`
- `src/helpers/get-page-urls.ts` - aggregate file walking, relative URL resolution
