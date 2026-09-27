# Working notes

Implementation logs and real-site test results that inform how the checks
are built. These are working documents, not user documentation: they read
as session-by-session records of what was tried, what broke, and why the
code ended up the way it did. User-facing docs live in `docs/`.

They are tracked here because the same questions keep coming back when a
check is iterated on or a user files an issue against it, and the source
history alone does not carry the reasoning.

## Contents

- `parity-check-notes.md`: design history of the `markdown-content-parity`
  check across eleven sessions. Covers the four comparison approaches
  tried, the content-extraction pipeline, every real-site false positive
  fixed, and the validation runs against 20 documentation sites. Start
  with "Current approach" and "Markdown text extraction ordering" before
  touching `extractMarkdownText` or `extractHtmlText`.
- `page-discovery-notes.md`: design history of page discovery in
  `src/helpers/get-page-urls.ts`: the aggregate walker, `.md` link
  normalization, `urlPathPattern`, and sample verification, with the
  request-budget reasoning behind each and the alternatives rejected.
  Read "Invariants" before changing how URLs are discovered or sampled.
- `page-size-transfer-notes.md`: design notes for the `page-size-transfer`
  check (spec v0.6.0): why served bytes come from the decoded stream, the
  `Accept-Encoding` choice, how the fetch is shared with `page-size-html`,
  the architecture-signature ratio, and the field run that checked the
  thresholds against real sites.
- `single-fetch-completeness-notes.md`: design notes for the
  `single-fetch-completeness` check (spec v0.6.0): which pagination signals
  count and which navigation patterns deliberately don't, how the
  continuation is chosen and verified, what "at the top" means, the
  llms.txt-only prerequisite path, and the field run against real sites.
- `markdown-link-portability-notes.md`: design notes for the
  `markdown-link-portability` check (spec v0.6.0): the link classes and what
  each one needs from the base URL, why images and cross-origin links are
  classified but not scored, how the per-page sample spends the link budget,
  the `html-redirect` addition to the verification vocabulary, and the field
  run that reproduced the spec's grounding case live.
- `embedded-data-serialization-notes.md`: design notes for the
  `embedded-data-serialization` check (spec v0.6.0): what counts as bulk
  and why the thresholds default where they do, how the verdict is coupled
  to `page-size-html`'s buckets, the twelve-page field run, the
  "Dynamic Content Rendered Statically" interaction diagnostic, and the
  item-count extension to `markdown-content-parity`.
- `parity-sites.txt`: the 20 sites used to validate parity changes, with
  base URLs. Referenced throughout the parity notes.
- `run-parity-baseline.sh`: runs the parity check against one of those
  sites with the flags used for the validation tables. Output goes to
  `parity-results/` (gitignored). Result snapshots are deliberately not
  tracked; they go stale within weeks as sites change.
- `docs-platform-comparison.md`: April 2026 scan of seven documentation
  platforms' own docs sites with afdocs 0.8.4.
- `redirect-behavior-results.md`: March 2026 real-site validation of the
  `redirect-behavior` check's classifications.

The parity notes mention a `MONGODB-PARITY-ISSUES.md` with site-specific
findings; that file was never added to the repository.

## Conventions

Append a new dated or numbered section for each round of work rather than
rewriting earlier ones. Record what was tried and rejected, not only what
shipped. When a change is validated against live sites, capture the
before/after table in the notes and delete the raw result files.
