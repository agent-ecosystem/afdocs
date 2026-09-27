# Page discovery notes

Design history of `src/helpers/get-page-urls.ts`: how page URLs are found
in `llms.txt` and sitemaps, how `.md` links become page URLs, and how the
sample is drawn. Every entry below was a response to a real site, and
several later issues were about the side effects of an earlier fix, so
read this before changing `normalizePageUrl`, the aggregate walker,
`deduplicateVersionedUrls` or `discoverAndSamplePages`.

The recurring tension is **request budget versus correctness**. The
default run makes at most `maxLinksToTest` (50) page samples, and a
number of past changes exist only to cut wasted requests. Anything that
adds a request per discovered URL (as opposed to per sampled URL) is a
regression of that work, whatever else it fixes.

## Timeline

### March 2026: progressive disclosure walker (68df656)

Cloudflare's root `llms.txt` links to per-product `llms.txt` files and
Supabase's links to aggregate `.txt` files, so discovery found zero pages
and the markdown checks reported `0/0 tested`. `walkAggregateLinks` was
added: same-origin `.txt` links are fetched and their links become page
URLs. One level only. Root-relative links are resolved against the source
file's origin. Details and before/after numbers are in
`parity-check-notes.md`, "Bug fixed in session 5".

### April 2026: normalize `.md` links to page URLs (PR #44, e5fdaaa)

`llms.txt` links such as `/r2/get-started/index.md` and sitemap entries
such as `/r2/get-started/` were treated as two pages. `normalizePageUrl`
now rewrites `.md`/`.mdx` links to the clean page URL during discovery.
Measured on Cloudflare: about half as many pages tested and roughly 3x
faster runs, and `page-size-html` stopped measuring markdown bodies.

Decision that persists: **discovery produces page (HTML) URLs, and
markdown checks derive `.md` candidates from them.** Do not undo this to
fix a markdown check; see #77 below for the sanctioned way.

### April 2026: `.md` form preference in `markdown-url-support` (PR #45, 841a7e3)

`toMdUrls()` yields two candidates per page (`page.md`, `page/index.md`).
Sites using the second form paid a 404 per page. The check now tallies
which form wins after each batch and, once 80% agree, tries that form
first. About 60% faster on `index.md` sites. This heuristic lives in the
check, is bounded to the sampled pages, and never changes which pages are
sampled. It is the only place the tool infers a URL convention.

### April 2026: depth-1 walk with omitted subtrees (ce698fc)

`llms-txt-coverage` needs to know which parts of the sitemap the walker
did not reach. Depth-1 `.txt` links are recorded as `omittedTxtUrls` and
their directory prefixes are excluded from the coverage denominator. The
walker is deliberately not recursive: Alchemy has about 86 nested indexes
over three levels, Microsoft Learn would be hundreds, and a silent cap
would produce partial numbers with no indication they are partial. The
rationale is written up in `docs/checks/observability.md`, "Omitted
subtrees".

### May 2026: preserve the original `.md` URL (issue #77, PR #78, 4edcc3e)

The #44 normalization threw away the only URL form Plaid actually
serves (`/docs/auth/index.html.md`), so `markdown-url-support` went from
100% to 0%. Rather than stop normalizing, discovery now carries the
original link in a sidecar map, `originalMdUrls`, keyed by page URL.
`markdown-url-support` tries it first. `toMdUrls()` was left unchanged so
the other markdown checks could not regress to an earlier false-positive
class. PR #78's tests pin the request count per page.

### May 2026: slow tests from unmocked hosts (e4696b7)

Unmocked `.local` URLs go to the network and time out after 5 seconds.
Any discovery change that adds a fetch must mock that fetch in the
affected tests. This happened again with #112 (below).

### August 2026: `--url-path-pattern` (issue #95, PR #101, d20609f)

Sites that serve real filenames want `/guide.md` mapped to `/guide.html`,
not `/guide`. The reporter suggested the tool could "magically sniff out"
the pattern and then proposed a flag as the simpler option. **The flag
was chosen over sniffing.** `urlPathPattern` (`clean`, `html`, `md`) is
declared by the user and threaded through every `.md` to page-URL
conversion. Nothing infers it from responses.

### September 2026: self-links and markdown-only files (issues #111 and #112, PR #116)

Both from Redpanda, whose production `llms.txt` exhibits both patterns.

**#111.** The root `llms.txt` listed its own URL. The walker treated that
link as a nested index, fetched the root again at depth 1, and so
recorded every real nested index as a depth-2 omitted subtree. Coverage
on their local build fell from 100% to 67%. The walker now seeds a
seen-set with the root file URL (and its redirect target), compares
`.txt` URLs ignoring scheme and `www.`, and skips any index already
seen at either depth. This only removes fetches. It also stops an index
linked twice from being walked twice or counted as omitted twice, which
the walker had never guarded against.

**#112.** `llms.txt` linked to markdown-only files such as
`/sitemap-llms.md`. #44's normalization produced `/sitemap-llms`, a URL
the site never served, and it was sampled: `auth-gate-detection` saw a
404 and `content-start-position` warned on the 404 body. The fix
verifies existence at sampling time, in `discoverAndSamplePages`:

- Only sampled URLs that have an `originalMdUrl` are fetched. Sitemap
  URLs and plain `llms.txt` page links are taken as published.
- A 404 or 410 drops the URL and a replacement is drawn from the
  unsampled remainder; the total examined is capped at 2 × `maxLinksToTest`.
  Network errors keep the URL so a transient failure does not reshape the
  sample.
- The GET goes through `fetchPage`, so it lands in `ctx.htmlCache`.
- A discovery warning names the skipped files. When at least three are
  skipped and they are at least half of what was verified, the warning
  also points at `--url-path-pattern`, because a mostly-missing sample
  means the mapping is wrong for the site, not that the site has a few
  markdown-only files.

Request budget, checked against the check sources on 2026-09-26: four
checks read pages through `fetchPage` (`page-size-html`,
`content-start-position`, `rendering-strategy`,
`tabbed-content-serialization`). The other page-level checks call
`ctx.http.fetch` directly because they need manual redirects, a
different `Accept` header, or only headers. A full run always includes
the `fetchPage` checks, so the verification adds no requests; it moves
up to 50 GETs earlier, into whichever check first samples pages. A
partial run that includes none of those four checks (for example
`--checks markdown-url-support`) pays up to `maxLinksToTest` extra GETs,
and up to twice that if many sampled pages are missing.

Alternatives considered and rejected for #112:

1. **Name heuristics** (`sitemap*.md`, `llms*.md` at the root). Zero
   requests, but the class is "markdown-only files linked from
   llms.txt", and Redpanda's `home/how-to-use-these-docs.md` shows the
   names are not predictable.
2. **Keep the `.md` URL as the page.** The HTML checks would then run on
   markdown bodies. A site that wants `.md` as its canonical page URL
   declares `--url-path-pattern md`.
3. **Tolerate the 404 in each check.** Spreads the rule across nine
   checks, lets each check's denominator drift, and still fetches the
   URL.
4. **HEAD instead of GET.** Cheaper per request but not reusable by
   `fetchPage`, so a full run would make strictly more requests.
5. **Infer `urlPathPattern` when most sampled pages 404.** Rejected on
   the #95 decision: the mapping is declared, not sniffed. The warning
   points at the flag instead.
6. **Verify every discovered `.md` link.** Thousands of requests on
   large sites. Verification is per sampled page only.

### September 2026: version-named leaf pages (issue #135, PR #136)

`deduplicateVersionedUrls` stripped a terminal version segment, giving
`/docs/v1.0/` the same grouping key as `/docs/`. The unversioned parent
won, silently removing the leaf before any check could report it as
skipped. Without a parent index, sibling release pages such as
`/changelog/2.4.1/` and `/changelog/2.4.0/` still collapsed to one.

Decision: **only non-terminal segments can be version prefixes for
deduplication.** Keep terminal version segments in the grouping key.
Ordinary child pages such as `/docs/v1/intro` and `/docs/v2/intro` still
deduplicate, using the existing version priorities. Version roots such
as `/docs/v1/` and `/docs/v2/` remain separate candidates, even with an
explicit version preference, subject to the existing path and locale
filters. URL shape alone cannot distinguish a version landing page from
a distinct release note; preserving documents is preferable to silently
discarding them.

Do not apply this rule to `extractVersionFromUrl`. A user-supplied base
URL ending in `/v1/` must still select v1 child pages. Detecting the
requested version and deciding that two discovered pages are duplicates
are different decisions.

Alternative rejected: give terminal versions a separate shared key
namespace. This prevents collisions with the parent index but still
discards sibling changelog entries. Fetching every version root to infer
whether its content is redundant would violate the per-sample request
budget; this fix adds no content probing.

Request budget and sampling tradeoffs:

- The change operates on already-discovered URL strings. It adds no
  fetch operation and does not expand the walker depth.
- With random or deterministic sampling, retained pages can increase
  the number checked up to `maxLinksToTest` (50 by default). Once the
  sample is full, roots can displace other pages rather than enlarge
  it. Curated and `none` strategies bypass this discovery path.
- A page limit is not a request limit. Additional sampled pages can
  require HTML and multiple Markdown probes; the existing caches still
  apply. Even a fixed-size sample can take longer if different pages
  require more probes or time out. No wall-clock benchmark was performed.

The existing 20% version-duplication threshold is unchanged, but its
inputs change: leaves no longer contribute false duplicate groups.
On a borderline URL set this can disable deduplication of child-version
groups too, so the candidate increase is not necessarily just the roots.
The sampling cap still applies. Future grouping or threshold changes
need to consider sample composition, not only the number of requests.

Regression tests in `test/unit/helpers/get-page-urls.test.ts` cover
leaves with and without trailing slashes, siblings with and without a
parent index, mixed roots and child pages with default and explicit
version preferences, and both `llms.txt` and sitemap discovery. The four
initial leaf cases failed before the fix. These tests establish page
preservation and version selection, not identical request counts or
runtime.

## Invariants

- Discovery emits page URLs; `.md` candidates are derived per check.
  (#44, #77)
- The `.md` to page-URL mapping is declared with `urlPathPattern`, never
  inferred. (#95)
- Version deduplication may strip only non-terminal version segments
  from grouping keys. A version-named leaf alone is not evidence of
  duplicate content. (#135)
- Every request made during discovery is bounded by `maxLinksToTest` or
  by the number of `.txt` indexes at depth 0 and 1, never by the number
  of discovered URLs. (#45, ce698fc, #112)
- The walker goes one level deep and never re-fetches an index it has
  already seen. (ce698fc, #111)
- New discovery fetches get mocked in the affected tests. (e4696b7, #112)

## Open observations

- 2026-09-26, `markdown-link-portability` field run (PR #129): one MongoDB
  page was sampled as
  `https://www.mongodb.com/docs/manual/reference/command/stopsharddraining.md/`,
  a trailing slash after the `.md` extension. Discovery produced the URL,
  not the check. Not yet investigated; it did not change a verdict.
