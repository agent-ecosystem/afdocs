# page-size-transfer: design notes

Implements spec v0.6.0 `page-size-transfer` (Category 3: Page Size and
Truncation Risk). Issue #122. Second of the five v0.6.0 checks merging into
`spec-v0.6.0`.

## What it measures

The decoded byte size of the HTML document response: the body after
transfer decoding (gzip/deflate/brotli), which is what an agent's HTTP client
hands to its pipeline. Subresources are not fetched or counted. Inline
scripts, styles, and serialized data payloads are counted because the agent
cannot avoid receiving them.

`page-size-html` models convert-then-truncate pipelines (scripts stripped,
then a character limit). This check models truncate-then-convert and
raw-ingestion pipelines, plus tools that cap response bytes (Claude Code's
fetch buffer, ~10MB). A page can pass one and fail the other.

## Invariants

- **Bytes come from the stream, not the string.** `readStreamedBody` in
  `src/http.ts` already accumulates `received` for the tarpit guard; that
  count is the served size. Node's fetch (undici) decodes
  `Content-Encoding` transparently, so the stream yields decoded bytes.
  Verified on Node 25: a 5,026-byte body served as 65 bytes of gzip reads as
  5,026 bytes from the stream, and the response still carries
  `content-encoding: gzip` and `content-length: 65`. That is why
  `FetchedPage.wireBytes` is taken from `Content-Length` only when a
  `Content-Encoding` other than `identity` is present: on an identity
  response the header equals the decoded size and says nothing.
- **Never `body.length`.** Characters undercount multi-byte text and say
  nothing about what was transferred. When a response double exposes no
  stream (hand-rolled test doubles), `readWholeBody` falls back to
  `Buffer.byteLength(text, 'utf8')`, and `fetchPage` does the same when the
  client only implements `text()`. Those are approximations for doubles, not
  the production path.
- **One read per response.** `HttpResponse.body()` and `text()` share a
  memoized read (`pendingBody`), because a body stream can be consumed
  once. The origin-rewrite branch returns the rewritten text but the
  original byte count: the rewrite is a preview-testing convenience, not
  something a server served.
- **Explicit `Accept-Encoding: gzip, deflate, br`.** Node's default was
  `gzip, deflate` on the version tested and has changed between releases.
  Pinning the header keeps the measurement deterministic and matches what
  agent HTTP clients typically negotiate. Callers can override it per
  request. Servers that would only compress for `br` are measured the same
  way either way, since the count is post-decoding; the header mainly
  affects `wireBytes`.
- **One fetch feeds both size checks.** The check reads pages through
  `fetchPage`, which caches on `ctx.htmlCache`; `page-size-html` uses the
  same cache. The ratio in the report is therefore served bytes and
  post-conversion characters from the same response. The check also reads
  `page-size-html`'s `pageResults` from `previousResults` to reuse
  `convertedCharacters` for the same URL instead of converting twice; it
  converts itself when that result is missing (subset run) or errored.
- **Thresholds are bytes, decimal, configurable.** `transferThresholds`
  (`pass: 1_000_000`, `fail: 10_000_000`) sits next to the character
  `thresholds` in `CheckOptions`, with the same CLI/config/validation
  plumbing (`--transfer-pass-threshold`, `--transfer-fail-threshold`,
  `options.transferThresholds`). Decimal units (1MB = 1,000,000) match the
  spec's "1MB"/"10MB" wording and are marginally more conservative than
  binary. `formatBytes` in `src/helpers/format-bytes.ts` renders them the
  way the spec's examples read ("3.4MB served -> 29KB content").
- **Ratio is bytes per character.** `ratio = round(servedBytes /
contentCharacters)`, undefined when the page converts to nothing. The
  units differ, which is deliberate and matches the spec's example; it is a
  signature, not a physical quantity. `ARCHITECTURE_SIGNATURE_RATIO` (20)
  marks warn/fail pages whose bytes are mostly non-content; ordinary
  boilerplate-heavy HTML lands at roughly 5:1 to 15:1 while the
  serialized-payload pages that motivated the spec check measured 40:1 to
  200:1. A high ratio on a _passing_ page is not flagged: the page is small
  enough that the payload costs little. `details.architectureSignaturePages`
  and `details.maxRatio` drive the fix text, which then says the fix lives in
  framework configuration, not the docs.
- **Not in `HTML_PATH_CHECKS`.** The rendering coefficient scales checks
  whose measurement is meaningless on an SPA shell. Served bytes are what
  the agent transfers whether or not the shell renders, so the check keeps
  full weight when `rendering-strategy` fails. It is in `PAGE_LEVEL_CHECKS`
  (proportional scoring, partial-sample flag, insufficient-data exclusion).
- **Markdown responses are measured too.** If a page URL serves markdown to
  a plain fetch, the served bytes are still what the agent transfers; the
  ratio is ~1:1. The check does not request markdown itself.
- **Fetch errors are excluded from the buckets** and counted in
  `fetchErrors`, as in `page-size-html`; the verbose formatter skips them.

## Field run (2026-09-26)

Ten sites, `--sampling deterministic --max-links 8`, one run each, output
saved offline. See the table below; raw JSON was not kept.

| site       | platform (observed)  | transfer | html | median served | max served | ratio range | arch. sig. pages |
| ---------- | -------------------- | -------- | ---- | ------------- | ---------- | ----------- | ---------------- |
| afdocs.dev | VitePress            | pass     | pass | 42KB          | 48KB       | 3-5:1       | 0                |
| cloudflare | Starlight (Astro)    | pass     | warn | 125KB         | 220KB      | 3-12:1      | 0                |
| supabase   | Next.js              | pass     | pass | 172KB         | 655KB      | 1-38:1      | 0                |
| docker     | Hugo                 | pass     | fail | 524KB         | 673KB      | 5-20:1      | 0                |
| resend     | Mintlify             | pass     | pass | 501KB         | 675KB      | 25-61:1     | 0                |
| stripe     | custom               | pass     | pass | 514KB         | 926KB      | 34-116:1    | 0                |
| anthropic  | Mintlify             | pass     | pass | 665KB         | 905KB      | 19-54:1     | 0                |
| pinecone   | Mintlify             | warn     | warn | 636KB         | 1.5MB      | 26-141:1    | 1                |
| mongodb    | Snooty (Gatsby/Next) | warn     | pass | 953KB         | 1.1MB      | 22-35:1     | 3                |
| vercel     | Next.js              | warn     | warn | 995KB         | 1.0MB      | 19-58:1     | 1                |

Reading the run:

- **The spec's motivating pattern is visible.** The Mintlify-hosted sites
  and Stripe pass `page-size-html` comfortably (7KB to 40KB of content) while
  serving 300KB to 1.5MB per page, at 40:1 to 141:1. Pinecone's model pages
  are 5KB of content in 640KB of HTML. None of these are "content problems".
- **Content-heavy pages sit at the other end.** Docker's CLI reference pages
  fail `page-size-html` (98KB to 145KB of content) but serve at ~5:1; the
  bytes are the docs. afdocs.dev and Cloudflare land at 3:1 to 12:1. This
  is the spread `ARCHITECTURE_SIGNATURE_RATIO = 20` is meant to split. In
  this run every oversized page was payload-heavy (22:1 to 33:1) and every
  content-heavy page (Docker at 5:1) stayed under 1MB, so the flag fired on
  exactly the pages where the fix is framework configuration.
- **1MB is a live line, not a theoretical one.** MongoDB, Vercel and
  Pinecone each had pages straddling it (999KB to 1.5MB). Nothing came near
  10MB, so no fail was observed; the fail tier stays anchored to Claude
  Code's fetch buffer rather than to field data.
- **Wire size is rarely available.** Nine of ten sites use chunked transfer
  encoding with no `Content-Length`, so `wireBytes` was recorded only for
  afdocs.dev (5KB to 9KB gzip for 18KB to 48KB served). `contentEncoding`
  is still recorded, and the formatter prints the wire size only when it
  exists. Counting compressed bytes on the wire would need the raw socket
  stream, which fetch does not expose; not worth a second client.
- **The message is useful on a pass.** "All 8 sampled pages serve under 1MB
  (median 665KB served → 16KB content (~43:1))" tells a Mintlify site owner
  what is coming before it crosses the line.
- Raw JSON for this run was kept only in the session scratchpad and not
  committed.
