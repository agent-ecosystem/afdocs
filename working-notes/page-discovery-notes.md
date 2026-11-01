# Page discovery notes

Design history of `src/helpers/get-page-urls.ts`: how page URLs are found
in `llms.txt` and sitemaps, how `.md` links become page URLs, and how the
sample is drawn. Every entry below was a response to a real site, and
several later issues were about the side effects of an earlier fix, so
read this before changing `isNonPageUrl`, `normalizePageUrl`, the aggregate walker,
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

### September 2026: numeric suffixes are not file-type evidence (issue #134)

`isNonPageUrl` treated the final `.0` in `/migration/v0.22.0` as a file
extension. This is separate from #135: even after version leaves survive
deduplication, the classifier can exclude them elsewhere. It removed
versioned links from depth-1 aggregate indexes and from the sitemap side
of coverage matching, creating false "llms.txt links not in sitemap"
diagnostics. Markdown URL support and content negotiation skipped them
instead of counting failures. Directive checks fell back to negotiation,
so production could pass while a local server without negotiation failed.

Decision: **a non-page extension must contain at least one letter.**
Numeric-only suffixes are not sufficient evidence to exclude a page.
This preserves version and date paths such as `v0.22.0`, `2.4.1`, and
`release.2026` while retaining asset filtering for `.txt`, `.json`, `.xml`,
`.7z`, `.mp4`, and `.h264`. HTML and Markdown exceptions remain unchanged.
Do not strip trailing slashes before classifying: this change concerns a
numeric suffix on the last path segment, not dotted directory names.

This remains a URL heuristic, not content-type detection. A real file
with a numeric-only suffix, such as a split archive ending in `.001`, can
now be a page candidate. Conversely, a documentation route ending in
`node.js` still looks like a non-page file. Neither ambiguity is solved
here. A semver-only exception would miss date and other numeric suffixes;
an asset-extension allowlist would broaden the change and require ongoing
maintenance. Fetching candidate URLs to classify them would violate the
discovery request budget. Keep the decision in the shared classifier,
not separate exceptions in each check.

No classification requests are added. Retained aggregate links enter the
existing sampling process; previously skipped sampled pages now receive
their normal checks. This can add requests and change denominators, but
does not imply fetching every discovered URL or raising sampling limits.
Coverage compares URL sets without probing the pages. No runtime
benchmark was performed.

Tests cover numeric suffixes with and without trailing slashes, preserved
asset filtering, success and failure denominators, coverage matching for
plain and `.md` links, and directives on a server without negotiation.
Nested-index regressions assert that discovery fetches only the index,
not its page candidates. Markdown and negotiation regressions also pin
the requests made for the formerly skipped pages.

### September 2026: bounded sitemap walks and infix locales (issue #120)

A narrow Microsoft Learn base URL (`/en-us/docs`) matched no sitemap
pages, so the accepted-URL cap never fired. The index contained thousands
of large shards. The locale filter also missed product filenames such as
`dotnet_en-us_1.xml` and `previous-versions_fr-fr_3.xml`.

Decisions:

- Recognize a filename locale token delimited by `_` or `-`, optionally
  followed by a numeric shard. Match the parsed pathname, ignoring query
  strings. Validate with the existing locale-code helper, require two
  distinct locales before filtering, preserve non-locale sitemaps, and
  retain the existing preferred-locale and fallback rules.
- Each sitemap walk has a shared ceiling of 20 sitemap fetch attempts,
  including roots, indexes, children, failed responses, and empty responses.
  This is independent of accepted URLs. Gzipped sitemaps remain unsupported
  and do not consume fetch slots. Robots discovery is separate; HTTP
  redirects and retries retain their existing behavior, so 20 fetch calls
  is not a promise of 20 wire requests.
- Stop starting additional sitemap fetches after successfully read bodies
  total 50 MiB of decoded bytes. This leaves room for one of the reported
  roughly 46 MB shards plus its index, while preventing hundreds of such
  downloads. Use `HttpResponse.body()` for served-byte accounting, or UTF-8
  text length for custom clients without that method.
- The byte budget is checked between responses, not during streaming.
  The final body can overshoot it, and a failed partial read has no byte
  count. It is not a per-response memory ceiling or a wall-clock guarantee;
  the existing HTTP timeouts still apply. A hard streaming cap would require
  a separate HTTP API change, including canonical-origin rewriting.
- When a budget prevents another fetch, retain already-collected URLs and
  warn that discovery is partial. Do not issue a budget warning merely
  because the last input or the existing accepted-URL cap ended the walk.
  Normal locale/version refinement and sampling limits remain unchanged.
- Share the bounded walker with coverage's docs-specific sitemap fallback
  through an optional explicit sitemap-root list. Coverage and page discovery
  can run separate walks, each with its own budget; this is not a scan-wide
  quota. Partial coverage results retain `sitemapWarnings` and should not be
  treated as exhaustive coverage of the site.
- Warn when a non-root path prefix matches fewer than 1% of examined
  same-site URLs, before locale/version refinement. Include the prefix,
  counts, and a suggestion to use a broader base URL. Apply this to both
  sitemap and llms.txt discovery. Empty sources and root prefixes do not
  warn; zero matches from a nonempty source does. Do not broaden the scope
  automatically.

Rejected alternatives: relying on locale filtering alone (one locale can
still have hundreds of shards), stopping after a few nonmatching shards
(later shards may contain the requested product), and counting only
successful or accepted pages (the original unbounded-walk failure).
No per-page probes, deeper traversal, or configurable budget API were added.

Regression tests pin locale forms, fetch and byte limits, shared budgets
across roots and indexes, empty/error responses, raw coverage mode, fallback
warning propagation, normal termination, and the strict 1% boundary.
The initial locale and unbounded-walk tests both failed before the fix.

### September 2026: shared CommonMark link extraction (issue #151)

The llms.txt link regex truncated `/guide_(intro)` and missed reference
links. Both it and the portability scanner treated indented code and HTML
comments as navigation. Discovery, coverage, llms.txt link checks, and
Markdown fetching now use the same parser-backed scan as portability and
pagination. The shared parser retains the GFM table extension from #150.

Extraction decisions and intentional corrections:

- Collect inline and resolved full, collapsed, and shortcut references in
  document order. The first definition wins. Raw scanning and the exported
  `extractMarkdownLinks()` retain duplicates; portability deduplicates by
  decoded destination as before. Link labels now use rendered text,
  including inline code and image alt text, rather than Markdown syntax.
- Exclude inline, fenced, and indented code and HTML comments, including
  nested containers and unclosed comments. Markdown inside raw HTML blocks
  is not parsed as navigation; HTML anchors are not Markdown links.
- Standalone images no longer count as llms.txt navigation links. A linked
  badge contributes its enclosing destination, while portability continues
  to report images separately without fetching or scoring them.
- Use parser-decoded destinations directly. CommonMark unescapes ASCII
  punctuation and resolves the full entity set once. In particular,
  `&amp;amp;` becomes `&amp;`, not `&`. The legacy exported
  `decodeCharacterReferences()` remains available but is not applied to
  parser output. Portability's unsafe-destination guard for raw MDX regexes
  and templates remains, as do diagnostics for malformed URLs such as
  `https://[`.
- Preserve UTF-16 offsets and exclusive end positions against the original
  source, including non-ASCII characters and CRLF. The `blanked` result is
  the original length, with code, comments, and definitions replaced by
  spaces while preserving CR and LF.
- Keep autolinks and bare URLs out of shared navigation extraction.
  Pagination still has its own bare-URL/path and declaration policies;
  those are not discovery rules. It shares parser setup, not text analysis,
  with the other consumers.
- Retain the vendor table-cell fence exception. A parsed code block whose
  opening fence line contains a pipe has its opening marker masked with
  same-length spaces and is reparsed. Repeat if this exposes another such
  opener. The existing multiline table fixture otherwise swallows a real
  following link. Pipes inside genuine code blocks remain code.

Scope filters, URL mapping, traversal depth, and verification limits are
unchanged. No per-discovered-URL content probes were added. Real references
can now enter the existing sample and trigger normal checks; example links
no longer trigger requests or false stale/broken-link results. Correcting
the candidate set can change scores and request totals without changing
scoring thresholds or budgets. Random and deterministic samples retain
their caps, and curated input remains an uncapped explicit list.

Regressions pin original-source spans, one-pass decoding, check outcomes,
coverage exclusions, nested-index traversal, and exact request lists for
discovery, sampling, fetching, and link verification. Heading extraction,
content-parity analysis, fence validity, and llms.txt structural validation
remain separate work.

### October 2026: unprefixed default locale when the base URL is listed (issue #158)

Mintlify's docs (`/docs/intro`, `/docs/es/intro`, `/docs/fr/intro`,
`/docs/zh/intro`) collapsed to two tested pages and a `single-page-sample`
cap. Three locale codes at position 1 covered 75% of discovered URLs, so
detection fired with the default target `en`. No URL carried `en`, but the
base URL `/docs` survived the target filter because URLs with fewer segments
than the locale position are always kept. That non-empty result
short-circuited the unprefixed fallback added for issue #56 (PR #60). The
fallback's tests never caught this because their fixtures omit the base URL.
Both discovery paths were affected: the llms.txt walk follows Mintlify's
nested `_llms/{en,es,fr,zh}` aggregates and the sitemap lists every locale,
and each collapsed independently to the base URL.

Decision: **filter to the target locale only when some URL carries the
target at the detected position, compared against the raw segment.**
Otherwise go straight to the unprefixed fallback. The short-URL keep rule
is unchanged in both branches, so the base URL stays in the sample either
way.

Rejected alternatives: deciding from the per-position code counts gathered
during detection (the first draft of the fix; Copilot review pointed out
that the counts only hold codes `isLocaleSegment` recognizes, so an
explicit `--doc-locale zh-Hans` would have fallen through to unprefixed
even when zh-Hans URLs existed, a regression from the raw comparison the
old filter did); dropping the short-URL keep rule (would exclude the base
URL on prefixed sites and break the existing test); triggering the fallback
when the filtered set is "mostly" short URLs (a threshold where a direct
check exists).

Script-subtag codes are a pre-existing gap across all locale handling, not
just this branch: detection, base-URL locale extraction, and the unprefixed
fallback all treat `/docs/zh-Hans/intro` as unprefixed. Tracked in issue
#161.

The coverage check was not affected: its `filterByLocale` requires the
segment to exist, so the base URL never masks a missing target there.
Coverage's second detection pass handles several minority locale codes
(PR #100) while discovery's handles one; that drift is tracked in
issue #159.

### October 2026: one locale-position detector for discovery and coverage (issue #159)

PR #100 (issue #98) generalized the coverage check's second detection pass
so that any locale code at a position confirmed by structural duplication
marks it as a locale position, which catches an unprefixed default language
with several minority translations (Datadog's `/fr/`, `/ja/`, `/ko/`,
`/es/` at about 40% of URLs). Discovery kept its own copy of the detector
whose second pass required exactly one code, so the same site was
locale-filtered by coverage and left mixed-language in the page sample.
Noticed while fixing issue #158.

Decision: **`detectLocalePosition` lives in `src/helpers/locale-codes.ts`
and is the only detector.** `filterLocalizedUrls` and the coverage check
both call it. Its tests moved next to it. Discovery gained the
minority-translation regression that previously existed only for coverage.

Rejected alternatives: porting the generalized pass into discovery's copy
(leaves two detectors to drift again); re-exporting from the coverage
module (keeps a helper under a check's namespace for no reason). The
target-locale and unprefixed-fallback rules from issue #158 are unchanged;
only how the position is found moved.

### October 2026: script-subtag locale codes (issue #161)

`isLocaleSegment` accepted `xx` and `xx-yy` only, so `zh-Hans`, `zh-Hant`,
and `sr-Latn` were invisible to every locale consumer: base-URL locale
extraction, position detection, the unprefixed fallback (which treated
`/docs/zh-Hans/intro` as an unprefixed page), coverage's locale filter, and
the locale-sitemap patterns. Raised by Copilot's review of PR #160.

Decision: **accept `language-Script` and `language-Script-REGION` where the
language is ISO 639-1 and the script is in a curated ISO 15924 list.** The
list holds scripts that appear as path prefixes on docs sites; it is not
the full registry. Region stays a two-character tail. The three
locale-sitemap regexes share one capture shape, `language[-Script][-REGION]`,
and defer to `isLocaleSegment` for validation. Copilot review caught two
regressions in the first draft, which captured any two to four letter
subtags: a two-letter product prefix (`dotnet-cs-fr-fr-1.xml`) consumed
the real locale, and an invalid filename capture (`/fr/sitemap-en-docs.xml`)
masked the valid path locale because the first regex to match won. The
fixed shape blocks the first; taking the first _validated_ candidate
across the three patterns fixes the second. A third review pass found that a regex only returns its
leftmost match, so `dotnet-cs-docs-en-1.xml` produced the invalid
`cs-docs-en` and never reached the valid `en`. The infix pattern is now
anchored to the filename tail and tried from every `_` or `-` delimiter
left to right, and the first valid candidate across filename, path
segment, and infix positions wins.

Rejected alternatives: a length rule such as "two letters, hyphen, four
letters" (lowercased `en-vivo`, `es-tudo`, `de-dupe` would pass; the
original two-letter regex was replaced with the ISO 639-1 set for the same
reason in PR #60); the full ISO 15924 registry (over 200 codes, most never
used as locale prefixes, each a new false-positive surface); validating
`--doc-locale` against the helper (an explicit value the helper does not
know, such as `latam`, is still honored by the raw-segment match from
issue #158, and rejecting it would remove that escape hatch).

### October 2026: locale preferences resolve to same-language variants (issue #164)

Locale preferences were matched by exact code in three places: the
locale-sitemap selector, the page-URL filter, and coverage's explicit-locale
branch. A site organized by `en-us` and `fr-fr` therefore matched neither the
default `en` nor a bare `--doc-locale en`, and `--doc-locale en-US` failed
against a site that uses bare `en`. Microsoft Learn worked only because its
base URL supplies `en-us`. Found while writing the PR #163 fixtures.

Decision: **one resolver, `resolveLocaleVariant`, in
`src/helpers/locale-codes.ts`, used by all three call sites.** Exact match
wins. Otherwise the best-represented code with the same language is chosen,
and when both the preference and the candidate name a script they must
agree (`zh-Hans` resolves to `zh-Hans-CN`, never to `zh-Hant`). Ties break
alphabetically. No same-language code resolves to null, which preserves the
issue #158 unprefixed fallback. The page-URL filter still tries the exact
raw segment first so a site-specific code such as `latam` keeps working.

Rejected alternatives: selecting every same-language variant (`en-us` plus
`en-gb` would put regional duplicates of each page into the sample, and the
page-level filter has no later step that would remove them); preferring a
canonical region such as `en-us` (arbitrary across languages; representation
count is a property of the site); validating or normalizing `--doc-locale`
at the CLI (the raw value is still useful as an escape hatch).

Copilot review of the first draft found three gaps, all addressed:

- Coverage's explicit-locale branch resolved before checking the exact raw
  prefix, so `--doc-locale en-custom` selected `en-us`. It now mirrors the
  page filter: exact prefix first, variant only when absent.
- Coverage's raw sitemap walk (`skipRefinement`) ran the sitemap selector
  with the built-in default `en`, which now resolved `{en-gb, en-us}` to
  `en-gb` and discarded the US children before coverage inferred `en-us`
  from llms.txt. Before this change the same case returned every child
  because no `en` key existed. The raw walk now keeps every child when no
  locale is known from the flag or the base URL. The fetch and byte budgets
  from issue #120 still bound it; the trade-off is that a site with many
  locale shards and no known locale may spend budget on other locales.
- `rewriteFilterBase` replaced the base URL's locale with the preference
  whenever they differed, so base `/en` with `--doc-locale en-US` scoped
  discovery to `/en-us/` and found nothing. This predates the branch. The
  first fix kept the base path for same-language variants, which Copilot
  showed breaks the opposite case: base `/en-us` with `--doc-locale en-GB`
  on a site that has both kept the US pages. Discovery is now scoped to
  both paths when the preference is a same-language variant of the base
  locale (primary: rewritten; secondary: original), for llms.txt links and
  sitemap URLs alike, and `filterLocalizedUrls` takes the exact variant
  when present and resolves to the base variant otherwise. A different
  language still rewrites without fallback.
- Three consequences of the dual scope, found on the next review pass:
  a site-specific preference (`en-custom`) over a `/en-us` base kept both
  paths and, with no recognized second code, locale detection never fired,
  so both locales were returned (dual scope now applies only to recognized
  locale codes); the thin-llms.txt branch refined each source alone and
  merged two variants, and refining the merge again could not recover pages
  of the winning variant that only one source listed (the path-scoped,
  unrefined pools are merged first and refined once; the sitemap walker
  gained `deferRefinement` for this, distinct from coverage's
  `skipRefinement` because child selection and the collection cap stay as
  in refined discovery); the 500-URL sitemap cap is then applied to the
  sitemap additions only, because `maxLinksToTest` has no upper bound and
  llms.txt pages were never subject to that cap;
- A seventh review pass asked for human assessment of indexed-sitemap
  pruning without a concrete finding. One real gap was identifiable:
  child-sitemap selection resolved a variant by counting _sitemaps_, while
  the page-level pass counts _pages_ and sees llms.txt. Two GB shards and
  one US shard selected GB children only; if llms.txt then tipped the page
  pass to en-us, the US sitemap pages had never been fetched. Child
  selection is now inclusive when it resolves by variant: every
  same-language child is fetched (`sameLanguageVariants`) and the single
  page-level pass picks the variant. An exact code still selects its own
  children alone. Fetching a rejected variant costs bounded budget;
  skipping the chosen one loses pages. This is consistent with the raw
  coverage walk keeping every child when no locale is known. child-sitemap selection resolved the preference
  alone and could pick an `en-au` child whose pages neither scope keeps
  (children needed by any fallback scope's locale are kept as well).

## Documentation at scale: design considerations

Drafting `docs/documentation-at-scale.md` after the #120 live reproduction
exposed several distinctions that the current CLI makes easy to miss. These
are design questions, not new configuration options or requirements to
expand the bounded-walk fix.

### Prioritize completeness and source selection

1. **Make discovery completeness machine-readable.** Budget exhaustion is
   currently communicated through warning strings. A completed scan, an
   incomplete discovery set, and a base-page fallback are different states.
   Consider structured metadata for sources, stop reasons, examined and
   retained counts, and the scope of each walk. Preserve it in reports and
   show it prominently enough that a high page-quality score cannot be
   mistaken for a complete product assessment. Avoid claiming an exhaustive
   set even when a budget was not reached: collection caps, omitted nested
   indexes, and locale/version refinement still affect the corpus.
2. **Define a product-specific sitemap selection contract.** The CLI/config
   can select a published llms.txt with `llmsTxtUrl` but has no equivalent
   sitemap selector. A correct product prefix can still find nothing before
   the global index budget runs out. The helper's explicit sitemap roots
   added for coverage fallback do not settle a user-facing API. Any selector
   needs consistent behavior across discovery and coverage, origin rewriting,
   scope and locale rules, and explainable fallback when the selected source
   fails. An explicit narrow source is preferable to guessing products from
   filenames or silently increasing traversal depth.

### Keep selection, requests, and scoring distinct

- **Separate page selection from index work in the interface.** Curated
  sampling is repeatable page selection, not a request allowlist. Coverage
  and index link checks have their own work. Documentation now corrects the
  old "skips discovery entirely" wording. A future resolved-config summary
  or check-scope summary could show this before network work begins, without
  promising an exact request count. Prefer visibility over adding named
  profiles until teams demonstrate stable profile needs.
- **Choose an explicit policy for incomplete CI evidence.** Warning-level
  conditions do not normally fail the CLI. A team may want incomplete
  discovery to block a discovery audit while allowing its curated page
  regression job to run. This should be an explicit policy built on
  structured completeness, not matching warning text or treating missing
  evidence as a page-quality failure. Consider exit behavior, skipped checks,
  JSON consumers, and scoring together before choosing a flag or default.
- **Distinguish a scope from a network boundary.** Today the base path and
  locale/version preferences filter discovered candidates, while curated
  entries are used directly. Redirects, Markdown candidates, and index link
  checks can reach other URLs. An enforced allowlist would be a separate
  feature with explicit behavior for those cases; do not imply that a base
  URL already provides it. Keep this separate from page/non-page URL
  classification and Markdown URL mapping.
- **Consider shared budgets and reuse before higher limits.** Discovery and
  coverage can repeat sitemap work in separate walks, and parallel product
  jobs do not share a rate limiter. A scan-wide budget or cache needs to
  respect origin rewriting, path scope, raw coverage versus refined samples,
  and cancellation. A hard response-byte cap also needs HTTP-layer support;
  the current between-response budget is not that guarantee. Larger default
  limits would not establish representative sampling across products.
- **Report enough context for comparison.** Config-selected checks, curated
  pages, tags, environment, and AFDocs/scoring versions affect what a score
  means. Define how those inputs travel with a report before adding
  cross-product score aggregation. Tags currently group selected results;
  they do not implement stratified discovery or statistically representative
  sampling.

The published guide uses existing controls only: product-owned configs,
explicit page-check selection, separate discovery audits, and review of
warnings and tested pages. Future implementations should keep the existing
no-per-discovered-page-probe and bounded-depth invariants, and test request
accounting and partial-result semantics alongside any new option.

## Invariants

- Discovery emits page URLs; `.md` candidates are derived per check.
  (#44, #77)
- The `.md` to page-URL mapping is declared with `urlPathPattern`, never
  inferred. (#95)
- Version deduplication may strip only non-terminal version segments
  from grouping keys. A version-named leaf alone is not evidence of
  duplicate content. (#135)
- Numeric-only suffixes are not sufficient evidence of a non-page file;
  classify them without adding discovery fetches. (#134)
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
