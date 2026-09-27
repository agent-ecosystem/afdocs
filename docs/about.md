# About AFDocs

<div class="about-intro">
<div class="about-text">

AFDocs is an open-source tool that tests documentation sites against the [Agent-Friendly Documentation Spec](https://agentdocsspec.com). The spec defines what makes documentation accessible to AI coding agents, based on observed behavior across real agent platforms. AFDocs automates those observations into 28 checks that produce a score and actionable fix suggestions.

</div>
<div class="about-logo">
  <img class="light-only" src="/logos/afdoc_logo_light.svg" alt="afdocs logo" width="200" height="200">
  <img class="dark-only" src="/logos/afdoc_logo_dark.svg" alt="afdocs logo" width="200" height="200">
</div>
</div>

## The Agent-Friendly Documentation Spec

The [Agent-Friendly Documentation Spec](https://agentdocsspec.com) is the foundation for everything AFDocs checks. It documents:

- How agents actually discover, fetch, and consume documentation
- What fails in practice (truncation, empty SPA shells, auth gates, broken redirects)
- What works (llms.txt, markdown availability, content negotiation, proper status codes)
- Specific agent behaviors observed across Claude Code, Cursor, GitHub Copilot, OpenAI Codex, Gemini CLI, and others

The spec is maintained at [github.com/agent-ecosystem/agent-docs-spec](https://github.com/agent-ecosystem/agent-docs-spec) and is open for contributions.

AFDocs implements spec v0.6.0 (2026-09-13).

## Status

AFDocs is in early development (0.x). Check IDs, CLI flags, and output formats may change between minor versions. The tool is usable today, but don't build automation against specific output details until 1.0.

## Contributing

AFDocs is developed at [github.com/agent-ecosystem/afdocs](https://github.com/agent-ecosystem/afdocs). Issues, bug reports, and pull requests are welcome.

If you've tested AFDocs against your docs site and found a check that doesn't accurately reflect agent behavior, or a failure mode that isn't covered, that's especially valuable feedback. The checks are based on observed behavior, and more observations make them better.

## License

MIT

<style>
.about-intro {
  display: flex;
  align-items: center;
  gap: 4.5rem;
}
.about-text {
  flex: 1;
}
.about-logo {
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
  .about-intro {
    flex-direction: column;
  }
  .about-logo {
    order: -1;
    text-align: center;
  }
}
</style>
