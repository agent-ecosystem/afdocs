# markdown-link-portability: design notes

Implements spec v0.6.0 `markdown-link-portability` (Category 4: Content
Structure). Issue #124. Fourth of the five v0.6.0 checks merging into
`spec-v0.6.0`.

## What it measures

Two things about the links in a markdown response: how much of the base URL
each one needs in order to be reconstructable, and whether a sample of them
actually resolves to the representation the link promised.

The first half is a portability property, not a correctness one. RFC 3986
resolution is well defined, and a relative link is perfectly correct while
the fetch URL is still around. Agent pipelines lose it: markdown goes through
a summarization model, gets chunked for RAG, or gets pasted somewhere the
source URL is gone. After that a root-relative link is unreconstructable and
a path-relative link is meaningless.

The second half is the spec's grounding case, and it is why status codes are
not enough: a catalog's markdown variant emitted over 100 well-formatted
links into a wrong internal path prefix, and every one of them returned 200
with an HTML SPA shell at a `.md` URL.

The HTML path is exempt by design. The spec argues it at length and the docs
page carries the argument: relative links in HTML are correct practice, and
a pipeline converting HTML to markdown still holds the fetch URL at
conversion time, so resolving them is the converter's job with full
information. Served markdown is different on both ends: the generator knows
the canonical host, and on the best-case consumption path the site's bytes
reach the model verbatim with no conversion step where anything could be
resolved.

## Where the pages come from

The same plumbing `single-fetch-completeness` built in #123, reused without
change:

- `getMarkdownContent` reads `ctx.pageCache`, filtered to drop
  `source === 'llms-txt'`. Links inside `llms.txt` are
  `llms-txt-links-resolve`'s job, which the spec states outright, and the
  file is an index rather than a document under test.
- `fetchLlmsTxtLinkedMarkdown` is the fallback for sites that serve
  agent-facing markdown through llms.txt alone. Same inverted OR-group
  prerequisite: `markdown-url-support` or `content-negotiation` passes, or
  `llms-txt-links-markdown` finds markdown links.
- **Relative links resolve against `MarkdownPage.mdUrl`**, the URL that
  actually served the markdown after any redirect, never against the page
  URL. `guide.md` next to `/md/docs/api.md` is a different target than
  `guide.md` next to `/docs/api`, and a check that got this wrong would
  invent broken links on every site that serves markdown from a separate
  path. There is a unit test that pins it.

## Extraction and classification

`src/helpers/classify-markdown-links.ts`, a pure module with its own tests.

- **Inline links only** (`[text](url)`), via `extractMarkdownLinks` from
  `llms-txt-valid`, run over a copy with fenced code and inline code replaced
  by same-length whitespace. Blanking code is not optional: documentation
  about markdown is full of example links, and afdocs' own docs would have
  been graded on its examples otherwise.
- Autolinks and bare URLs are deliberately not collected. They are absolute
  by construction, so including them would only pad the absolute count and
  flatter sites that write out full URLs in prose. Reference definitions
  (`[label]: url`) are not collected either; generated markdown does not
  emit them.
- **Classes**, named for how much of the base each one needs: `absolute`
  (nothing), `protocol-relative` (the scheme), `root-relative` (scheme and
  host), `path-relative` (scheme, host, and the directory of the document
  that carried the link), `fragment`, `other-scheme`.
- **Fragments and non-HTTP schemes are exempt.** The spec exempts
  same-document fragments explicitly: they resolve inside content the agent
  already holds. `mailto:` and `tel:` are exempt for the same reason, and
  neither is fetchable.
- **Protocol-relative links count with the root-relative ones.** They are
  rare, and they lose the same thing a root-relative link does the moment
  the base is gone, minus the host. Folding them into the warn bucket rather
  than giving them a level of their own keeps the result levels the spec's
  three.
- **Images are classified but never scored.** They are reported in
  `pageResults[].images` with the same class tally. The reasoning follows
  `detect-pagination`'s existing position in this repo ("images are not links
  an agent follows"): an image reference points at a binary asset, not at
  documentation the agent navigates to, and the representation verification
  has nothing to say about a PNG. Rejected alternative: fold them into the
  scored counts. A page with absolute prose links and relative image
  sources would then warn on a Medium check, which is not what the spec's
  failure modes are about. The tally is kept so the decision can be revisited
  against real data rather than re-argued.
- Links are deduplicated by raw URL, in document order.

## Cross-origin policy

Cross-origin links are **classified, never verified**. Every one of them is
absolute by definition, so they never cost a site anything in the
classification half, and they are counted separately in
`pageResults[].links.crossOrigin` so the evidence is visible.

This follows the `llms-txt-links-resolve` precedent, which partitions
same-origin from cross-origin and lets only same-origin results drive
pass/fail. Two reasons hold here too: a third party's availability is not
this site's result, and fetching other people's hosts to grade this one is
how a scan collects bot-protection noise and 429s that read as the scanned
site's defects.

## Spending the link sample

The check adds fetches per page, so the budget is site-wide, not per page:

- `perPageQuota = max(1, floor(maxLinksToTest / pageCount))`. Every page gets
  the same quota, so a site with eight sampled pages and `--max-links 8`
  verifies one link per page rather than eight links on the first page.
- **Global deduplication by fetch URL** (the resolved URL with its fragment
  stripped). Documentation pages share navigation and footer links, and one
  page often links twice into the same document under different anchors; a
  URL planned for one page is reused by the next without another request.
  Both pages still get the outcome, so dedup costs no coverage.
- **Links that promise markdown (`.md`, `.mdx`) are tried first.** The
  representation mismatch the spec is built around can only appear on those,
  and when the quota is 1 a page should spend it where the check can see
  something status codes cannot.
- Order is document order within each tier: deterministic, unlike the link
  checks' random sample, so repeated runs test the same set. Same reasoning
  as `fetchLlmsTxtLinkedMarkdown`.
- The hard ceiling is `maxLinksToTest` new requests for the whole check.
  Pages whose quota is exhausted by the global budget are still classified;
  they are just scored on classification alone, which is the honest reading
  of "resolve a sample".

## Verification

One GET per sampled URL, with no `Accept` override and no fragment (see the
field run below for why each of those is deliberate). Outcomes, in the order
they are checked, using `single-fetch-completeness`'s vocabulary:

| outcome         | condition                                    | page |
| --------------- | -------------------------------------------- | ---- |
| `http-error`    | non-2xx                                      | fail |
| `empty`         | blank body                                   | fail |
| `soft-404`      | `isSoft404Body`                              | fail |
| `not-markdown`  | a `.md` link answering with HTML in place    | fail |
| `html-redirect` | a `.md` link redirecting to substantive HTML | warn |
| `fetch-error`   | no response                                  | fail |
| `ok`            | everything else                              | pass |

`html-redirect` is this check's one addition to the vocabulary, and it exists
because the spec names that exact case as the minor mismatch: "a `.md` link
that redirects to an HTML page with the right content". The distinction that
carries it is whether the response moved. A `.md` URL that answers with HTML
**in place** is the SPA-shell failure; one that redirects somewhere else and
serves a real page has delivered the content in the wrong representation.

Content-type checking only applies to links that promised markdown. A link to
`/docs/guide` is supposed to return HTML, and grading it for that would fail
every site.

Per-page status is the worse of the two halves: `fail` on any path-relative
link or any broken sample, `warn` on any root-relative or protocol-relative
link or any `html-redirect`, `pass` otherwise. A page with no links at all
passes; there is nothing there to be unportable.

## Scoring

- Medium (4), per the spec's checks table. Warn coefficient **0.60**, the
  "partial coverage or platform-dependent" tier, alongside the directive
  checks and `single-fetch-completeness`.

  The warn case is a root-relative link. Whether it survives is a property of
  the consuming pipeline, not of the site: an agent that fetches and
  immediately resolves is fine, and one that summarizes, chunks, or hands the
  text to another model is not. That is the same shape as a directive that
  exists but sits below the truncation point. Not 0.50 (#122's tier, "genuine
  functional degradation"): the target is reachable on the direct path, which
  is the common path. Not 0.75: the three loss mechanisms the spec names are
  ordinary agent plumbing, not corner cases.

- `bucketExtractor` (pass/warn/fail buckets), `PAGE_LEVEL_CHECKS`, and
  `DISCOVERY_CHECKS`. Portable links in markdown are worth nothing to an
  agent that never finds the markdown path, the same reasoning as
  `page-size-markdown`, `markdown-content-parity`, and
  `single-fetch-completeness`.

## Detail shape (for the pending interaction diagnostic)

This is the third of the four checks in the spec's "Dynamic Content Rendered
Statically" interaction effect, with `markdown-content-parity`,
`single-fetch-completeness`, and `embedded-data-serialization`. The
diagnostic lands with #125, the last of them. What it can read here:

- `details.pageResults[]`, keyed by `url` (the page URL, the same key parity
  and completeness use) and `mdUrl`.
- `details.pageResults[].links`, the full class tally. A generated page
  whose links are uniformly one class is the signature of a generator, not
  of hand-authored prose: the grounding case is 100 root-relative links and
  0 of anything else.
- `details.pageResults[].samples[]`, each with `url`, `resolvedUrl`,
  `promisesMarkdown`, `outcome`, `status`, and `redirectedTo`. A run of
  `not-markdown` outcomes at 200 on `.md` URLs is the spec's wholesale
  build-time breakage, and it is the strongest single piece of evidence the
  diagnostic will have that the markdown variant is a second, unreviewed
  rendering pipeline.
- `details.reasons` (`pathRelative`, `rootRelative`, `broken`, `mismatched`)
  as per-page counts, and `details.brokenSamples` as a link count.
- `details.viaLlmsTxtLinks`, to know which path the markdown came from.

## Field run (2026-09-26)

Eleven runs: ten documentation sites plus the curated NVIDIA URL,
`--checks llms-txt-exists,markdown-url-support,content-negotiation,llms-txt-links-markdown,markdown-link-portability --sampling deterministic --max-links 8`,
one run each, JSON kept only in the session scratchpad.

| site       | platform (observed)  | md-url | c-neg | result | pages | links | abs / root / rel | verified | outcomes             |
| ---------- | -------------------- | ------ | ----- | ------ | ----- | ----- | ---------------- | -------- | -------------------- |
| afdocs.dev | VitePress            | pass   | pass  | warn   | 8     | 46    | 10 / 35 / 0      | 5        | 7 ok                 |
| cloudflare | Starlight (Astro)    | pass   | pass  | pass   | 8     | 94    | 84 / 0 / 0       | 8        | 8 ok                 |
| supabase   | Next.js              | warn   | warn  | pass   | 5     | 26    | 25 / 0 / 0       | 5        | 5 ok                 |
| stripe     | custom               | pass   | pass  | pass   | 8     | 226   | 226 / 0 / 0      | 8        | 8 ok                 |
| anthropic  | Mintlify             | pass   | pass  | pass   | 1     | 4     | 4 / 0 / 0        | 4        | 4 ok                 |
| pinecone   | Mintlify             | pass   | pass  | warn   | 8     | 38    | 20 / 16 / 0      | 2        | 2 ok                 |
| mongodb    | Snooty (Gatsby/Next) | warn   | warn  | pass   | 7     | 117   | 116 / 0 / 0      | 6        | 6 ok                 |
| vercel     | Next.js              | pass   | pass  | warn   | 8     | 190   | 74 / 108 / 0     | 8        | 8 ok                 |
| neon       | Next.js              | pass   | pass  | pass   | 7     | 207   | 207 / 0 / 0      | 5        | 5 ok                 |
| resend     | Mintlify             | pass   | pass  | warn   | 8     | 52    | 32 / 19 / 0      | 6        | 6 ok                 |
| **nvidia** | custom (curated URL) | pass   | pass  | `fail` | 1     | 100   | 0 / 100 / 0      | 8        | 7 not-markdown, 1 ok |

The remaining columns are the class tally summed across each site's sampled
pages: absolute, root-relative (including protocol-relative), path-relative.
Fragment and `mailto:` links are excluded from the three.

Reading the run:

- **Six pass, four warn, one fail**, and the fail is the spec's grounding
  case. The warns are all the same thing: a generator emitting root-relative
  links. VitePress, Mintlify, and Next.js all do it; Starlight, Snooty, and
  Stripe's custom pipeline emit absolute URLs. This is a platform property,
  not a per-site authoring choice, which is exactly why the warn coefficient
  sits in the platform-dependent tier.
- **afdocs.dev warns on its own docs**, 35 root-relative links across seven
  of eight sampled pages. That is a true result and it stays in the table.
- **No path-relative links exist anywhere in the run** once the
  false-positive fixes below landed. The class is real (the spec's fail
  level names it) but no modern generator emits one, so in practice `fail`
  means broken links rather than relative ones.
- **The counts in this table are from the final code**, re-run after the
  review round rewrote the link parser. Every verdict is identical to the
  first run; only the link totals moved, and only upward (Stripe 208 to 226,
  Vercel 188 to 190, Neon 206 to 207, Supabase 25 to 26), which is the
  parser finding links the regex had dropped. No site changed bucket, which
  is the evidence that the rewrite added recall without adding false
  positives.
- **Cost.** Between 2 and 8 requests per site: the per-page quota is 1 at
  `--max-links 8` with eight sampled pages, and shared navigation links
  collapse to a single fetch. Pinecone spent 2 for 8 pages because its
  sampled pages link to almost nothing but each other.
- **Cross-origin volume is large on some sites** (Stripe 92, Neon 51,
  Resend 19) and none of it was fetched. Verifying it would have roughly
  doubled the check's request count for no signal about the site under test.

### Three false positives the field run found, and what they changed

Every one of these was caught by running against real sites, and each has a
unit test now.

1. **The fragment was being sent to the server.** MongoDB's markdown links
   carry `#std-label-…` anchors. `new URL()` keeps the fragment, the HTTP
   client passed it through, and MongoDB's routing 404s on it; the same URL
   without it returns 200 and `text/markdown`. Four of MongoDB's seven
   sampled pages failed on links that work. `MarkdownLink.fetchUrl` is now
   `resolvedUrl` with the hash cleared, and it is also the dedup key, so two
   anchors into the same document cost one request instead of two.

2. **Source code served as markdown parses as links.** Mintlify ships a
   page's raw MDX, so Resend's `get-domain-claim.md` opens with a JSX
   preamble containing `str.replace(/[_-](\w)/g, …)`. The regex literal
   reads as a markdown link whose destination is `\w`, which the URL parser
   resolves to `https://resend.com/w`: a 404, and the only path-relative
   "link" in the entire ten-site run. Destinations containing a character a
   URL generator always percent-encodes (``\ < > { } | ^ ` "``) are now
   dropped before classification. Residual exposure: noise shaped like
   `[a-z](x)` would still parse, because `x` is a legal relative path.
   Nothing in the run produced one, and the guard should not be widened
   without evidence that something does.

3. **Negotiating a representation the path already names.** The check
   originally sent `Accept: text/markdown` for `.md` links, copied from
   `single-fetch-completeness`'s continuation fetch. MongoDB's docs answer a
   `.md` URL with 404 under that header and with 200 and `text/markdown`
   without it. Three of MongoDB's four failures were this, reported as
   broken generated links on a site whose links are fine. The header is
   gone. A `.md` path is itself the representation request; the response's
   content type is still verified, which is what the spec asks for; and
   whether a site negotiates correctly is `content-negotiation`'s subject.

   Worth keeping in mind for the other v0.6.0 checks: the "most generous
   reading" argument for sending `Accept: text/markdown` does not survive
   contact with a site that treats the header as a filter rather than a
   preference.

One unrelated observation from the same data, recorded because it will come
back: one MongoDB page was sampled as
`https://www.mongodb.com/docs/manual/reference/command/stopsharddraining.md/`,
with a trailing slash after the extension. That comes from page discovery,
not from this check, and belongs with the `page-discovery-notes.md`
invariants if it turns out to matter.

### The grounding case, live

The spec's motivating catalog is https://build.nvidia.com/models.md, run once
with `--urls https://build.nvidia.com/models`:

| what       | observed                                                                       |
| ---------- | ------------------------------------------------------------------------------ |
| links      | 100 unique, **all root-relative**, 0 absolute, 0 path-relative, 0 cross-origin |
| the prefix | every one under `/qc69jvmznzxy/`, e.g. `/qc69jvmznzxy/boltz2.md`               |
| sample     | 8 verified (the full per-page quota)                                           |
| outcomes   | 7 `not-markdown` at HTTP 200, 1 `ok`                                           |
| result     | **fail**: 100 root-relative links; 7 of 8 sampled links return HTML shells     |

The spec's description reproduces exactly, two years of site churn later. The
one link that did return markdown (`bevformer.md`) is worth noting as the
reason a sample of one would not have been enough evidence to call the
failure wholesale: the check reports the ratio, and the fix text tells the
site to verify a sample in CI for that reason.

`/qc69jvmznzxy/` is the tell. It is not a path any part of the site serves
documentation from; it reads as a build-time identifier substituted into the
link template. Status codes alone pass all 100 of these links, which is the
spec's point.

## Review round (PR #129)

Six findings, all acted on. Four of them were about the link parser, which is
the part of this check that decides everything else.

- **Extraction no longer goes through `extractMarkdownLinks`.** The issue
  said to reuse it, and the first build did. It is a single regex written for
  `llms.txt`, where destinations are plain absolute URLs, and it is not
  enough for arbitrary served markdown: `[guide](https://host/chapter_(draft).md)`
  stops at the first `)` and yields `https://host/chapter_(draft`, which this
  check would then fetch and report as a broken link that does not exist.
  Inventing a 404 is the worst failure this check has. An angle-bracket
  destination containing a space (`[g](</docs/user guide.md>)`) is missed
  entirely, and nested brackets in link text break the label match.

  `scanInlineLinks` and `readDestination` in the helper now parse the
  CommonMark inline-link form directly: angle-bracket and bare destinations,
  balanced parentheses, optional titles, nested brackets in labels, and
  backslash escapes restricted to ASCII punctuation as the spec requires.
  A destination whose parentheses never close is skipped rather than
  truncated. `extractMarkdownLinks` is untouched; the llms.txt checks keep
  using it, and `fetchLlmsTxtLinkedMarkdown` still does too.

  The punctuation restriction on escapes is load-bearing: treating `\w` as an
  escaped `w` would have unescaped the Mintlify MDX regex literal into a
  plausible destination and undone the field-run fix below.

- **Fence blanking is now a line scanner.** The first build reused
  `detect-pagination`'s regex, whose backreference requires the closing fence
  to be at column 1 and exactly as long as the opener. CommonMark allows a
  longer closer, and a fence nested in a list item carries the list's indent.
  Neither was theoretical: deeply nested fenced code is ordinary in tutorial
  documentation, and an unrecognized fence puts every example link inside it
  into the scan. The scanner accepts an opener at any indent and a closer of
  at least the opener's length, and it keeps the existing table-cell guard
  `markdown-code-fence-validity` uses. Accepting an opener at any indent
  trades recall for safety deliberately, in the same direction
  `detect-pagination` documents: blanking too much loses a link, blanking too
  little invents a broken one.

  `detect-pagination.ts` has the same weakness and is deliberately left
  alone: changing it would move `single-fetch-completeness`'s behaviour with
  no field evidence behind it. Worth revisiting together if either check
  produces a fence-related false positive.

- **A destination that never parses is no longer silently absolute.** A
  malformed target such as `https://[` was classified `absolute`, dropped
  from sampling for want of a `fetchUrl`, and counted toward the absolute
  total, so a page whose only link was malformed passed as fully portable.
  `MarkdownLink.unresolvable` records it, `LinkClassCounts.unresolvable`
  tallies it, and it fails the page: an unusable link is not a portable one.

- **A `.md` link that redirects to another `.md` URL serving HTML now
  fails.** The first build warned on any redirect that ended in HTML. The
  spec's minor mismatch is "a `.md` link that redirects to an HTML page";
  when the final URL still ends in `.md` and still answers with a shell, the
  representation still contradicts the link and nothing about the redirect
  softens it. `promisesMarkdownUrl(finalUrl)` decides which it is.

- **Protocol-relative links appear in the verbose counts.** They warn
  alongside root-relative links but the detail line printed only
  `rootRelative`, so a page whose only fragile links were `//host/path`
  showed zeroes beside its warning. They are now reported in the same
  number, which is also how the status is computed, and malformed links get
  their own count on the line.

- The field-run section said "Ten sites" and "Five pass" against an
  eleven-row table with six passes. Corrected.
