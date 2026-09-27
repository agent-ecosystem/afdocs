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
- `bot-protection-notes.md`: design notes for the `bot-protection-interference`
  check (spec v0.6.0): the fetch-ledger invariants, the threshold table with
  the reasoning behind each constant, the partial-sample attribution that was
  tried and reverted, and the 33-site field run. Read "Invariants" before
  changing what counts as interference.
- `bot-protection-sites.txt` and `bot-protection-field-run.mjs`: the sites
  and harness for that field run. The harness saves each site's full fetch
  ledger to `bot-results/` (gitignored) so thresholds can be re-scored
  offline with `rescore` instead of re-running the sites.
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
