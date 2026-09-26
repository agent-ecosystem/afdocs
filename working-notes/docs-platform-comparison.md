# Docs Platform Agent-Friendliness Comparison

Scanned 2026-04-05 with afdocs v0.8.4 against each platform's own documentation site.

## Summary

| Platform          | Site                                | Score | Grade | Page Size (HTML)          | Boilerplate | Content Start              | Markdown?  | llms.txt? |
| ----------------- | ----------------------------------- | ----- | ----- | ------------------------- | ----------- | -------------------------- | ---------- | --------- |
| VitePress         | vitepress.dev                       | 92    | A     | median 4K, max 22K        | **0%**      | 4/35 warn (worst 44%)      | Yes (100%) | Yes       |
| Mintlify          | mintlify.com/docs                   | 96    | A     | median 5K, max 22K        | **0%**      | **0% median**              | Yes (100%) | Yes       |
| MkDocs Material   | squidfunk.github.io/mkdocs-material | 59    | F     | median 19K                | 77%         | 16% (warn)                 | No         | No        |
| Hextra (Hugo)     | golangci-lint.run                   | 59    | F     | max 219K, 1 page >100K    | **90%**     | 28/36 warn (worst 40%)     | No         | No        |
| Starlight (Astro) | starlight.astro.build               | 59    | F     | median 13K                | 66%         | 61% (fail)                 | No         | No        |
| Docusaurus        | docusaurus.io                       | 59    | F     | max 79K, 1 page warn      | **77%**     | **21/50 fail** (worst 83%) | No         | No        |
| Nextra (Next.js)  | nextra.site                         | 56    | F     | max 265K, **32/50 >100K** | 53%         | 24/50 warn (worst 14%)     | No         | No        |

## Key Findings

### Platforms with agent-friendliness built in

**Mintlify (96/A)** and **VitePress (92/A)** stand apart. Both serve markdown via .md URLs and content negotiation, have llms.txt, produce clean HTML with 0% boilerplate, and content starts immediately. Mintlify's only issues are llms.txt freshness (26% sitemap coverage) and minor markdown-content parity drift. VitePress has a missing llms-txt-directive and minor parity issues.

### Platforms without agent-friendliness features (but could add them)

**MkDocs Material**, **Hextra**, **Starlight**, and **Docusaurus** all score 59/F, capped by missing llms.txt. Their HTML-path numbers tell the real story of what agents see today:

- **MkDocs Material**: Cleanest of this group. 77% boilerplate, 16% content-start. Moderate overhead.
- **Hextra (golangci-lint)**: 90% boilerplate, 28/36 pages with content starting 10-40% in, and one page at 219K (over 100K limit). The sidebar alone is a major overhead contributor.
- **Starlight**: 66% boilerplate, but content-start-position fails at 61%. Content is buried past the halfway point.
- **Docusaurus**: 77% boilerplate, and 21/50 pages have content starting past 50%. The worst page starts content at 83%. Most agents would get CSS/JS/nav and little documentation.

### Nextra (Next.js) is the worst performer

56/F. 32 out of 50 pages exceed 100K characters after HTML-to-markdown conversion. Max page is 265K. This confirms the Next.js HTML bloat problem: even with 53% boilerplate (lower than Hextra), the absolute sizes push well past truncation limits.

## Notes

- Scores for platforms without llms.txt or markdown are capped at 59 regardless of HTML quality, because Content Discoverability and Markdown Availability both score 0/F.
- The "could add them" platforms could improve significantly by enabling llms.txt and markdown output, but their HTML-path numbers reveal the baseline agent experience for the 4/6 agents that don't request markdown.
- VitePress and Mintlify demonstrate that 0% boilerplate is achievable. The gap between 0% and 53-90% is the difference between agents seeing your content and agents seeing your CSS.
