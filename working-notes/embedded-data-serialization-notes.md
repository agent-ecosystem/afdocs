# embedded-data-serialization: design notes

Design record for the `embedded-data-serialization` check (spec v0.6.0,
Category 4: Content Structure), the fifth and last of the v0.6.0 checks,
and for the two pieces of v0.6.0 that were held back to land with it: the
"Dynamic Content Rendered Statically" interaction diagnostic and the
item-count extension to `markdown-content-parity`. Issue #125.

## What the check answers

`page-size-html` says a page converts to 83,000 characters. This check says
_why_: a 218-row generated table is 72% of it, and the prose that explains
the table sits after it. The spec's framing is attribution for the person
who can fix the page and does not know anything is wrong, because the
authored source is two paragraphs and a widget.

The verdict is deliberately not a size measurement of its own. It reads
`page-size-html`'s bucket for the same page and only ever warns or fails on a
page that check already put in its warn or fail band. What this check adds
is the attribution and the "dominant contributor" test.

## Where the content comes from

The check measures exactly what `page-size-html` measured: `fetchPage`
(shared `htmlCache`, so no second request) followed by `htmlToMarkdown` for
HTML responses, or the body itself for markdown responses. Everything the
detector sees therefore survived conversion into content the model reads.
`<script>` payloads are stripped before the detector runs; they are
`page-size-transfer`'s domain, and the spec's division of the data-dump
problem by pipeline (script payloads burden every fetch, content-embedded
bulk burdens what the model reads) is what keeps the two checks from
double-counting.

Two conversion facts shaped the detector (`src/helpers/detect-bulk-data.ts`):

- `turndown-plugin-gfm` converts a table to a pipe table only when it has a
  heading row. A headerless table stays in the output as raw `<table>`
  markup, and it still occupies the converted characters, so the detector
  recognizes both forms (`pipe-table`, `html-table`) and counts rows in each.
- Turndown's default code block style is indented, not fenced, so a JSON
  response example in a `<pre>` arrives as four-space-indented lines. The
  detector accepts fenced, indented, and inline (paragraph) JSON.

## What counts as bulk

Following the spec's list: tables above a row threshold with uniform row
structure, JSON blobs above a size threshold, and base64 runs.

- **Tables.** At least `bulkTableRows` data rows (default 20; header and
  delimiter rows excluded) and at least 80% of rows sharing the modal cell
  count. Uniformity is measured, not assumed, because converted content puts
  unescaped pipes inside cells (`| 1 | x | y |` for a cell reading `x | y`),
  which would otherwise make a generated table look irregular. The
  uniformity fraction is reported per element.
- **JSON.** At least `bulkBlobChars` characters (default 2,000). A block is
  JSON when its fence says so (`json`, `jsonc`, `json5`, `jsonl`, `ndjson`,
  `geojson`, `json-ld`), when it parses, or when it starts and ends like
  JSON and carries at least one quoted key per 150 characters (documentation
  JSON routinely has comments, trailing commas, and `...` elisions that
  break `JSON.parse`). Long code samples in other languages are not bulk:
  the spec names JSON, and a 20K Python example is content.
- **Base64.** Runs of the base64 alphabet at least `bulkBlobChars` long,
  with a `data:` URI prefix attributed when present. Runs inside a non-JSON
  code block count (a PEM certificate); runs inside a JSON blob do not,
  because the blob already covers them.

The share is computed as the union of element ranges over the converted
length, so overlapping detections cannot exceed 100%. `proseBeforeBulk` is
the character offset of the first element (everything before it is
non-bulk by construction), and `proseBeforeBulkPercent` divides it by the
non-bulk total. That is the number that makes the spec's "place prose
before bulk elements" recommendation checkable per page.

### Thresholds and why they are configurable

The spec says thresholds for "bulk" need calibration against real pages and
should be configurable. Three options: `bulkTableRows` (20),
`bulkBlobChars` (2,000), `bulkDominantShare` (50). The flags are
`--bulk-table-rows`, `--bulk-blob-chars`, `--bulk-dominant-share`, and the
same names work under `options` in the config file.

- **20 rows.** Hand-written tables in documentation rarely pass twenty
  rows; generated matrices and catalogs run to hundreds (218, 909, 1,807 in
  the pages below). The field run found authored tables of 21 to 36 rows
  (Node's `fs` flags table, an AWS region table, MDN's element lists),
  which the default does classify as bulk. That is harmless: the verdict is
  gated on the size bucket and the dominant share, and a 21-row table on a
  460K page is 1% of it. The cost of a low threshold is a noisier
  attribution list on passing pages, not a wrong verdict.
- **2,000 characters.** A 2K JSON example is a long but ordinary API
  response sample. Below it, blobs cannot move a 50K page by more than a
  few percent each. Cloudflare's JSON-LD block (see below) is 1,401
  characters and is not flagged, which is the right call for a 30K page.
- **50%.** The spec's "for example, over half of converted content".

## The verdict

| Bulk present | Size bucket | Dominant | Result                       |
| ------------ | ----------- | -------- | ---------------------------- |
| no           | any         |          | pass                         |
| yes          | pass        | any      | pass                         |
| yes          | warn        | no       | pass (attribution in detail) |
| yes          | warn        | yes      | warn                         |
| yes          | fail        | no       | pass (attribution in detail) |
| yes          | fail        | yes      | fail                         |

The two "pass with attribution" rows are the spec's reading: the check's
warn and fail levels both require bulk to be the dominant contributor. An
oversized page whose data is a minority of its content is `page-size-html`'s
finding, not this check's, and scoring it twice would double-penalize the
page. The attribution is still in `pageResults[].elements` for anyone
reading the report.

The bucket comes from `previousResults.get('page-size-html')` when the size
check ran and measured the URL (the sample is shared through
`ctx._sampledPages`, so it always has), and is recomputed from
`ctx.options.thresholds` otherwise (a `--checks` subset).
`sizeBucketSource` records which, per page and at the top level.

## Scoring

Medium weight, 0.50 warn coefficient: a warn is a page in the size warn band
because of its data, the same genuine degradation as
`tabbed-content-serialization`'s warn. In `PAGE_LEVEL_CHECKS` and in
`HTML_PATH_CHECKS` (not `DISCOVERY_CHECKS`): the check measures the HTML
path, like `tabbed-content-serialization`, and attribution on SPA shells
measures nothing. Proportional scoring through the standard
pass/warn/fail buckets. Check count 27 to 28, max raw score 149 to 153.

## Field run (2026-09-26)

Twelve URLs chosen for large tables, catalogs, and controls, each run once
with `--urls <url> --checks rendering-strategy,page-size-html,embedded-data-serialization --format json --quiet`
from the origin. JSON kept only in the session scratchpad.

| page                                             | converted | bucket | bulk elements                                 | share | result                  |
| ------------------------------------------------ | --------- | ------ | --------------------------------------------- | ----- | ----------------------- |
| iana.org media-types registry                    | 497K      | fail   | 8 tables: 1,807 rows (61%), 909 rows (22%), … | 97%   | **fail**                |
| developer.mozilla.org HTML element reference     | 72K       | warn   | 2 tables: 29 rows, 23 rows                    | 21%   | pass (not dominant)     |
| nodejs.org `fs` API                              | 462K      | fail   | 1 table: 21 rows                              | 1%    | pass (not dominant)     |
| docs.aws.amazon.com regions and endpoints        | 11K       | pass   | 1 table: 36 rows                              | 14%   | pass                    |
| postgresql.org string functions                  | 36K       | pass   | none                                          | 0%    | pass                    |
| afdocs.dev checks index                          | 6K        | pass   | none                                          | 0%    | pass                    |
| mongodb.com PyMongo compatibility                | 21K       | pass   | none                                          | 0%    | pass (see note)         |
| mongodb.com query operators reference            | 38K       | pass   | none                                          | 0%    | pass (see note)         |
| mongodb.com Atlas limits                         | 43K       | pass   | none                                          | 0%    | pass (see note)         |
| developers.cloudflare.com Workers AI models (md) | 30K       | pass   | none                                          | 0%    | pass                    |
| build.nvidia.com models.md                       | 32K       | pass   | none                                          | 0%    | pass                    |
| developers.cloudflare.com Workers AI models      | —         | —      | —                                             | —     | fetch error (see below) |

Reading it:

- **The check separates the two kinds of oversized page.** Node's `fs`
  reference and the IANA registry both fail `page-size-html` at over 450K
  characters. Node is prose and passes here; IANA is 97% table and fails
  here with the 1,807-row table named. That is the whole point of the
  check: same size symptom, different cause, different owner.
- **MDN's element reference is the "not dominant" row in practice.** 72K
  converted, two element-list tables making up 21%. The page is oversized
  because it is long, not because of its tables, and the check says so by
  passing with the attribution in the detail.
- **The MongoDB pages have no tables in their HTML at all.** The PyMongo
  compatibility page is 1.15MB of HTML, 729K of it `<script>`. The body
  contains zero `<table>` and zero `<tr>`; "PyMongo" appears 56 times in
  the script payload and 0 times in the body. The compatibility tables are
  shipped in the framework payload and rendered client-side, so on the HTML
  path there is no bulk to attribute. That is `page-size-transfer`'s and
  `rendering-strategy`'s territory (the spec's division by pipeline), and
  this check is right to pass. It also means the spec's grounding page
  (302KB, 64% table markup) is not this page as served today.
- **Cloudflare's models index in markdown ends in a JSON-LD blob** inside a
  ` ```json ` fence: schema.org `Organization` markup serialized into
  the agent representation. It is 1,401 characters, under the blob
  threshold, and 5% of a 30K page, so it is not flagged. Worth knowing the
  pattern exists; not worth a lower default.
- **NVIDIA's models.md is a 200-line list, not a table**, so it has no bulk
  by this check's definition. Its problems are the other three checks' (see
  the grounding-page run below).

### A conversion crash found by the run

The Cloudflare models HTML page failed with
`Cannot read properties of undefined (reading 'parentNode')`, and so did
`page-size-html` on the same page. The page contains a model-comparison
widget whose `<table>` has an empty `<thead>` and `<tbody>` that a script
fills in; `turndown-plugin-gfm`'s table rule reads `node.rows[0]` and
dereferences it. Every HTML-path check converts through the same helper, so
one empty table skeleton took the whole page out of four checks.
`htmlToMarkdown` now drops tables with no rows before conversion (they
contribute nothing to the converted content), with a regression test. This
is a fix to shared code and is called out in the PR.

### The grounding page, all four checks together (2026-09-26)

The diagnostic's motivating page is https://build.nvidia.com/models. Run
once with the four checks plus their prerequisites and `--score`:

| check                       | result | evidence                                                                                     |
| --------------------------- | ------ | -------------------------------------------------------------------------------------------- |
| page-size-html              | pass   | 479K HTML to 15K converted (97% boilerplate)                                                 |
| embedded-data-serialization | pass   | no bulk in the HTML path (the catalog is not in the served HTML)                             |
| single-fetch-completeness   | warn   | paginated; relative continuation URL declared at 100% of content                             |
| markdown-link-portability   | fail   | 100 of 100 links root-relative; 22 of 50 sampled links do not resolve                        |
| markdown-content-parity     | pass   | 4% missing; item counts: HTML 24, markdown 200 lines, 100 distinct, 100 duplicates, diverges |

The `dynamic-content-rendered-statically` diagnostic fired with three of the
four directions (too little, inconsistent, unnavigable) on the one page, and
its message reads:

> 1 generated page shows several symptoms of the same flattening problem.
> https://build.nvidia.com/models: too little (markdown is paginated:
> relative URL); inconsistent (the HTML shows 24 items while the markdown
> lists 100 (likely default filter)); unnavigable (100 of 100 links are
> relative and 22 of 50 sampled links do not resolve). Each check flags one
> symptom, but the cause is shared: the markdown variant is a second
> rendering pipeline, and it needs the same QA the HTML pipeline gets.

Two honest limits visible in that output:

- The parity item count's "24 items" on the HTML side is whatever list
  survived chrome stripping on a page that is 97% boilerplate; the real
  catalog is client-rendered. The cause label `default-filter` follows the
  rule (markdown lists more than the HTML shows) and is a best guess, which
  is how the docs describe it. The direction is still right: the two
  representations disagree.
- The duplicated-entries defect (every model listed twice in the markdown,
  first seen during the `single-fetch-completeness` field run) is now
  measured: 200 list lines, 100 distinct. The comparison uses the distinct
  count, so the page is not reported as a catalog twice the size.

## The interaction diagnostic

`dynamic-content-rendered-statically` (`src/scoring/diagnostics.ts`) is
spec-level: it tracks the v0.6.0 "Dynamic Content Rendered Statically"
interaction effect, and lands here because this is the last of its four
checks (working-notes for `single-fetch-completeness` and
`markdown-link-portability` each record the detail shape they expose for
it).

- **Key.** Pages are joined on a normalized URL: hash dropped, trailing
  `.md`/`.mdx` and trailing slash stripped, host lowercased. Three of the
  checks key `pageResults[]` by the published page URL; the parity check
  keys by the cached URL, which is the `.md` URL when llms.txt links to
  markdown directly, hence the normalization.
- **Directions.** `embedded-data-serialization` warn/fail is "too much";
  `single-fetch-completeness` warn/fail is "too little";
  `markdown-link-portability` warn/fail is "unnavigable";
  `markdown-content-parity` warn/fail is "inconsistent", and so is an
  item-count divergence or a duplicated catalog on a page whose parity
  status passed, because containment cannot see a markdown variant that
  lists more than the HTML shows. Passing page results and pages with fetch
  errors never count.
- **Trigger.** Any page with two or more directions. The message lists up
  to three pages with each direction's evidence in the spec's order, and
  counts the rest. Severity `warning`, no coefficient or cap: the four
  checks already carry the score; the diagnostic exists so the report
  presents one pipeline problem rather than four findings.

## The parity item-count extension

Additive and informational: `markdown-content-parity` gains an `itemCounts`
detail per page and an `itemCountDivergences` count at the top level, and
its status logic is untouched (per `parity-check-notes.md`, the containment
approach and its thresholds are settled).

- **What is counted.** The largest list (direct `li` children of one
  `ul`/`ol`) and the largest table (data rows, header rows excluded) in the
  parity extractor's content container, after its chrome stripping; and the
  largest contiguous list block and the largest pipe table in the markdown,
  outside fences. Largest, not sum, so a "Related" list or an options table
  next to a catalog does not move the number.
- **When.** Either side's larger structure has at least 20 items, and both
  sides have at least 5. One side at zero while the other lists a catalog is
  an extraction artifact (a pure-link list stripped as navigation, a table
  rendered client-side), not a filter, and is reported without a cause.
- **Divergence.** More than one item and more than 2% of the larger count.
  The spec's observed case (98 shown, 102 listed) is a 4% difference of
  real items; the first draft used 10% and did not flag the spec's own
  example.
- **Cause.** Markdown lists more: `default-filter`. Markdown lists fewer and
  `single-fetch-completeness` found the page paginated: `pagination`.
  Markdown lists fewer otherwise: `staleness`. These are the three causes
  the spec names, with the one signal (pagination) that can be observed;
  the docs call the label a best guess.
- **Duplicates.** List entries are deduplicated by the parity check's own
  `normalize()` across the document, and the comparison uses the distinct
  count of the largest block. A generator that emits every entry twice is
  reported as duplication, not as a bigger catalog.

## Detail shape

For anyone reading `embedded-data-serialization` results downstream:

- `details.pageResults[]`, keyed by `url` (the page URL): `status`,
  `source` (`html` or `markdown`), `sizeBucket` and `sizeBucketSource`,
  `convertedCharacters`, `bulkCharacters`, `bulkShare` (percent),
  `dominant`, `proseBeforeBulkPercent`, `dominantElement`, `elements` (up
  to ten, largest first), `elementCount`.
- Each element: `kind` (`table`, `json`, `base64`), `form` (`pipe-table`,
  `html-table`, `fenced`, `indented`, `inline`), `start`, `chars`, `share`,
  `position` (percent of content where it starts), and for tables `rows`,
  `columns`, `uniformity`.
- `details.reasons`: `table`, `json`, `base64` (flagged pages by dominant
  element kind) and `proseAfterBulk` (flagged pages where less than half the
  prose precedes the data). The resolution text reads these.
- `details.thresholds`: `tableRows`, `blobChars`, `dominantShare`, and
  `size.pass` / `size.fail` (the size thresholds the bucket used).
