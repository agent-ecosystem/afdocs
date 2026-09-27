# single-fetch-completeness: design notes

Implements spec v0.6.0 `single-fetch-completeness` (Category 3: Page Size and
Truncation Risk). Issue #123. Third of the five v0.6.0 checks merging into
`spec-v0.6.0`.

## What it measures

Whether each sampled markdown response is complete in one fetch, and when it
paginates, whether the continuation is machine-followable: declared where an
agent will see it (the top of the content), linked with an absolute URL, and
actually serving the next segment. HTML pagination is out of scope; it is an
interaction pattern agents share with human readers.

The spec's grounding case is a model catalog's markdown variant: 100 of 102
entries, a pagination note at the bottom, a root-relative continuation URL,
and a continuation response with an empty body. The complete set would have
serialized to about 32K characters, under the 50K pass threshold, so the
pagination was inherited from the HTML UI rather than needed.

## Where the pages come from

- **Cached first.** `getMarkdownContent` reads `ctx.pageCache`, which
  `markdown-url-support` and `content-negotiation` fill. `llms.txt` files
  are filtered out (`source === 'llms-txt'`): they are indexes, not the
  documents under test. Nothing is fetched twice in a full run.
- **The cache now carries `mdUrl` and `linkHeader`.** `CachedPage.markdown`
  gained both fields; the two markdown-availability checks record them.
  `mdUrl` is the URL that actually served the markdown (`/models.md`, or the
  page URL under content negotiation). Relative continuation URLs resolve
  against it, not against the page URL: `page-2.md` next to `/md/page-1.md`
  is a different target than `page-2.md` next to `/docs/models`. `linkHeader`
  is the raw `Link` response header, needed for `rel="next"`. Standalone
  mode (`fetchMarkdownPages`) records the same two fields.
- **llms.txt-only fallback.** The prerequisite is an OR-group of
  `markdown-url-support`, `content-negotiation`, and
  `llms-txt-links-markdown`. When the cache yields nothing (the page-level
  checks failed or found nothing) but the runner let the check run because
  llms.txt links to markdown, `fetchLlmsTxtLinkedMarkdown` fetches those
  links directly: same-origin, under the base path, `.md`/`.mdx` links
  first, capped at `maxLinksToTest`, taken in file order (deterministic,
  unlike the link checks' random sample; the set is meant to be stable
  across runs). A response counts when its content type is `text/markdown`
  or the body looks like markdown, and it is not a soft 404.
  `details.viaLlmsTxtLinks` records that this path was used.
- **Skip messages.** Cached mode with no passing dependency and an empty
  fallback skips as "does not serve markdown by any detected path";
  otherwise "no markdown pages available".

## Signals

Detection lives in `src/helpers/detect-pagination.ts`, a pure module with
its own tests. It scans a copy of the content with fenced code blocks and
inline code replaced by same-length whitespace, so offsets survive and API
references that document pagination (`GET /v1/items?page=2`) never
register. Signals, in the spec's order:

- **"N of M" phrasing.** Three patterns: a leading verb or noun
  (`Showing 100 of 102`, `Page 1 of 5`, `Displaying the first 50 of 200`),
  a range (`Showing 1-100 of 102`, `results 1 to 25 of 80`), and a trailing
  noun (`100 of 102 models`, `25 of 1,200 results`). N must be less than M;
  `Showing 20 of 20` is complete. `Step 2 of 5` and `Part 1 of 3` are
  deliberately not matched: they describe sequence, not a window. One
  phrase can match two patterns; overlapping spans are reported once.
- **Paging parameters.** `page`, `offset`, `cursor`, `page_token`,
  `pageToken` in a link URL, or a `/page/N` path segment. A link counts only
  when it points past the first window (`page >= 2`, `offset > 0`, a
  non-empty cursor): `?page=1` is the page itself. Absolute URLs must be on
  the same host as the markdown or the page; a link to
  `api.example.com/v1/items?page=2` in prose is documentation, not
  pagination. Root-relative paths quoted in prose ("fetch /models?page=2
  for the rest") count too; the spec says "links or instructions".
- **"Next" link text.** Two tiers. Explicit text (`next page`, `next 50`,
  `more results`, `load more`, `show more`) counts wherever it points.
  Generic text (`next`, `more`, `continue`, `see more`, `older`, `»`)
  counts only when the URL has a paging shape or points at the same
  document with a different query. This is the guard against prev/next
  navigation between separate pages, which every docs framework emits and
  which the spec classifies as navigation, not pagination. `Next: Deployment`
  and `[Next](/docs/advanced)` are not signals.
- **`Link: rel="next"`.** Parsed from the header the cache kept; handles
  multiple entries, unquoted `rel`, and multi-valued `rel="next last"`.

Absence of signals is treated as complete, as the spec requires. A page
that omits content with no marker is `markdown-content-parity`'s job.

## Choosing and verifying the continuation

- The continuation is the **earliest in-content link** that registered as a
  signal. Position is what decides pass versus warn, and a site that
  declares at both top and bottom should get credit for the top one. The
  `Link` header is used only when the content declares no link at all.
- **"At the top"** means the declaration's offset is within the first 10% of
  the content, bounded to between 1,000 and 5,000 characters
  (`TOP_DECLARATION_*` in the check). The floor keeps a note after the H1
  of a short page at the top; the ceiling is the strictest platform
  truncation limit the spec documents (5K), past which "top" would no longer
  mean "before anything truncation could remove". `positionPercent` is
  reported alongside so the verbose line can say "declared at 97% of
  content".
- **Verification** fetches the resolved URL with `Accept: text/markdown`
  (what Claude Code and similar agents send, and the most generous reading
  of "the expected representation"). Outcomes, checked in order:
  `http-error` (non-2xx), `empty` (blank body), `not-markdown` (HTML by
  content type or by shape, or a non-text type with no markdown signals),
  `soft-404` (`isSoft404Body`), `same-content` (the server ignored the
  parameter and returned the first page again), then `ok`. `same-content`
  is not in the spec's list but is the same failure: the agent cannot get
  the rest.
- Per-page status: no signals → pass; signals but no link → fail
  (`missing`); link that cannot resolve → fail (`unresolvable`); verified
  but not `ok` → fail (`broken`); `ok` from the header only → warn
  (`headerOnly`); `ok` but relative → warn (`relativeUrl`); `ok` but not at
  the top → warn (`declaredLate`); otherwise pass. `details.reasons` tallies
  these six so the fix text can name the dominant one, and each page's
  `issues` array carries the human-readable versions the formatter prints.

## Scoring

- Medium (4), per the spec's checks table. Warn coefficient **0.60**, the
  "partial coverage or platform-dependent" tier, alongside the directive
  checks: a working-but-fragile continuation is lost or kept depending on
  the agent's pipeline (truncation, summarization, RAG chunking), which is
  the same shape as a directive that exists but is buried deep in the page.
  Not 0.50: the content is reachable by an agent that reads the whole
  response and follows relative links. Not 0.75: the spec's three loss
  mechanisms are common, not cosmetic.
- `bucketExtractor` (pass/warn/fail buckets), `PAGE_LEVEL_CHECKS`, and
  `DISCOVERY_CHECKS`: a complete markdown response is worth nothing to an
  agent that never finds the markdown path, the same reasoning as
  `page-size-markdown` and `markdown-content-parity`.

## Detail shape (for the pending interaction diagnostic)

This is one of the four checks in the spec's "Dynamic Content Rendered
Statically" interaction effect, with `markdown-content-parity`,
`markdown-link-portability`, and `embedded-data-serialization`. The
diagnostic lands with whichever of those is implemented last. What it can
read from this check:

- `details.paginatedPages` (count) and `details.pageResults[].paginated`
  (per page), to know which pages paginate at all.
- `details.pageResults[].status` and `.issues`, keyed by `url` (the page
  URL, the same key the parity check uses) and `mdUrl`.
- `details.reasons` for the shape of the failure (`missing`/`broken` is the
  spec's "too little" direction).
- `details.pageResults[].continuation.outcome` for the specific break.

## Field run (2026-09-26)

See the table below. Ten sites,
`--checks llms-txt-exists,markdown-url-support,content-negotiation,llms-txt-links-markdown,single-fetch-completeness --sampling deterministic --max-links 8`,
one run each, JSON kept only in the session scratchpad.

| site       | platform (observed)  | md-url | c-neg | result | pages | paginated |
| ---------- | -------------------- | ------ | ----- | ------ | ----- | --------- |
| afdocs.dev | VitePress            | pass   | pass  | pass\* | 8     | 0         |
| cloudflare | Starlight (Astro)    | pass   | pass  | pass   | 8     | 0         |
| supabase   | Next.js              | warn   | warn  | pass   | 5     | 0         |
| stripe     | custom               | pass   | pass  | pass   | 8     | 0         |
| anthropic  | Mintlify             | pass   | pass  | pass   | 8     | 0         |
| pinecone   | Mintlify             | pass   | pass  | pass   | 8     | 0         |
| mongodb    | Snooty (Gatsby/Next) | warn   | warn  | pass   | 7     | 0         |
| vercel     | Next.js              | pass   | pass  | pass   | 8     | 0         |
| neon       | Next.js              | pass   | pass  | pass   | 7     | 0         |
| resend     | Mintlify             | pass   | pass  | pass   | 8     | 0         |

\* afdocs.dev **failed on the first run** and is the reason the "N of M"
patterns are anchored to the start of a line. Its checks index
(`/checks/index.md`) explains proportional scoring with the sentence "If 3
out of 50 pages fail, the check scores ~94% of its weight", and the
trailing-noun pattern (`N of M pages`) read that as a pagination note with
no continuation link: a fail on a Medium check for ordinary prose. The fix
(`NOTE_LEAD` in `detect-pagination.ts`) requires the phrase to begin its
line, after at most markdown structure and one short label such as
"Note:", because real pagination notes are standalone lines while
illustrative counts sit mid-sentence. The site was re-run once after the
fix and passed; the sentence is now a regression test.

Reading the run:

- **No pagination was found on any of these ten sites**, which is the
  expected shape for documentation sites: pagination in a markdown variant
  is a catalog and listing pattern, not a prose-page pattern, and the
  deterministic sample of eight pages per site is mostly prose. The check
  therefore has no live positive case in this run; its positive behaviour
  is covered by the unit tests, which reconstruct the spec's production
  case (100 of 102, trailing note, root-relative URL, empty continuation
  body) and each of the other outcomes.
- **The false-positive budget is the thing to watch.** With absence of
  signals treated as complete, the check's only way to hurt a site is to
  see pagination that isn't there, and each false signal costs a page its
  full weight. The code-blanking, same-host, later-window, and
  line-anchoring guards each exist because a specific plausible prose or
  API-reference pattern would otherwise register. Any new signal pattern
  should be checked against a site's own explanatory prose before it ships.
- **The llms.txt-only path was not exercised here**: every site's cache was
  populated by the markdown-availability checks (`viaLlmsTxtLinks: false`
  on all ten). It is covered by unit tests. A site that would exercise it
  needs an llms.txt linking to `.md` files that the page-level checks do
  not reach.
- **Cost.** With no paginated pages the check made zero additional
  requests on every site: it reads the markdown the earlier checks cached
  and only fetches when it has a continuation to verify.
- Raw JSON for this run was kept only in the session scratchpad and not
  committed.
