---
layout: home

hero:
  name: AFDocs
  text: Test your docs against the Agent-Friendly Documentation Spec
  tagline: Measure how well AI agents can read, navigate, and use your documentation site.
  actions:
    - theme: brand
      text: Understand Your Score
      link: /what-is-agent-score
    - theme: alt
      text: Improve Your Score
      link: /improve-your-score
    - theme: alt
      text: Run It Yourself
      link: /quick-start

features:
  - title: 28 Checks, 7 Categories
    details: From content discoverability to markdown availability, AFDocs tests everything that affects how agents interact with your docs.
  - title: Actionable Fixes
    details: Every failing check comes with a specific fix suggestion, so you know exactly what to change.
  - title: CI-Ready
    details: Add agent-friendliness checks to your test suite with the built-in vitest helper. Catch regressions before they ship.
---

<div class="audience-section">
<div class="audience-text">

## Your docs have a new audience

Claude Code, Cursor, GitHub Copilot, Windsurf, Codex, Gemini CLI; millions of developers use AI coding agents that read your documentation in real time. When an agent can't read your docs, it falls back on training data or other sources, and developers get bad answers. You won't get bug reports about it. The developer blames the agent, or your product, and moves on. Or the agent recommends a different product it can understand and use better, and developers never discover your product at all.

Many documentation sites have problems agents can't work around: client-side rendering that delivers empty shells, pages so bloated with CSS and JavaScript that content gets truncated, no discovery path to clean markdown versions. These are invisible to human readers but dealbreakers for agents.

The good news: most fixes are configuration changes, not content rewrites. Adding an `llms.txt`, enabling server-side rendering, or serving `.md` URLs can move a site from an F to a B in a single sprint. [Read the full business case →](/why-agent-friendliness-matters)

</div>
<div class="audience-logo">
  <img class="light-only" src="/logos/afdoc_logo_light.svg" alt="afdocs — a friendly agent reading documentation" width="280" height="280">
  <img class="dark-only" src="/logos/afdoc_logo_dark.svg" alt="afdocs — a friendly agent reading documentation" width="280" height="280">
</div>
</div>

<style>
.audience-section {
  display: flex;
  align-items: center;
  gap: 4.5rem;
}
.audience-text {
  flex: 1;
}
.audience-logo {
  flex-shrink: 0;
}
.dark .light-only {
  display: none;
}
.dark-only {
  display: none;
}
.dark .dark-only {
  display: block;
}
@media (max-width: 768px) {
  .audience-section {
    flex-direction: column;
  }
  .audience-logo {
    order: -1;
    text-align: center;
  }
}
</style>

## Get your score

```bash
npx afdocs check https://docs.example.com --format scorecard
```

The scorecard shows category breakdowns, system-level diagnostics, and per-check results with fix suggestions.
