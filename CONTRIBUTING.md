# Contributing

Thank you for your interest in contributing to afdocs. This guide covers
how to set up your development environment, run checks, and submit changes.

## Getting started

### Prerequisites

- Node.js >= 22 (CI tests against 22 and 24)
- npm

### Setup

1. Fork and clone the repository.
2. Install dependencies:

   ```bash
   npm install
   ```

   Husky installs automatically via the `prepare` script and will run
   lint-staged on pre-commit (Prettier + ESLint on staged files).

3. Verify everything works:

   ```bash
   npm test
   npm run build
   ```

## Development workflow

### Commands

| Command                 | Description                              |
| ----------------------- | ---------------------------------------- |
| `npm test`              | Run all tests once                       |
| `npm run test:watch`    | Run tests in watch mode                  |
| `npm run test:coverage` | Run tests with coverage report           |
| `npm run build`         | Compile TypeScript to `dist/`            |
| `npm run lint`          | ESLint + `tsc --noEmit` type checking    |
| `npm run format`        | Format all files with Prettier           |
| `npm run format:check`  | Check formatting without writing changes |

### Building and running locally

Build the TypeScript source to `dist/`:

```bash
npm run build
```

Then run the CLI from the repo:

```bash
node bin/afdocs.mjs check https://docs.example.com
```

Or link it globally so you can use `afdocs` as a command:

```bash
npm link
afdocs check https://docs.example.com
```

The build step is required after any source change. The CLI entry point
(`bin/afdocs.mjs`) imports from `dist/`, not `src/`, so stale builds will
give you stale behavior.

A typical edit-test cycle looks like:

```bash
# Edit source files in src/
npm run build && node bin/afdocs.mjs check https://docs.example.com
```

For running specific checks or changing output format, see the CLI options
in the README.

### Code style

- Prettier handles formatting (config in `.prettierrc.json`): single quotes,
  trailing commas, 100-char line width
- ESLint with typescript-eslint for linting (flat config in `eslint.config.js`)
- Unused variables prefixed with `_` are allowed
- Pre-commit hooks enforce formatting and linting automatically

## Making changes

### Bug fixes

If you've found a bug, check [existing issues](https://github.com/agent-ecosystem/afdocs/issues)
first. If it hasn't been reported, open an issue describing the bug, then submit
a PR with the fix. Include a test that reproduces the bug where practical.

### New features

For anything beyond a small fix, open an issue first to discuss the approach.
This saves you from investing time in a direction that might not fit the project's
goals. Things worth discussing up front:

- New checks or check categories
- Changes to existing check behavior
- New output formats or integrations
- New CLI commands or flags
- Changes to the programmatic API

### Scoring changes

`SCORING.md` carries a scoring version, separate from the package version and
the spec version. Bump it whenever a change alters what a site would score
without the site changing:

- adding or removing a check (the denominator changes)
- changing a weight tier, warn coefficient, threshold, cap, or the formula
- adding a check to, or removing one from, a cluster coefficient
- adding a score-affecting flag or diagnostic

Bump the minor version for additive changes such as new checks, and the major
version when an existing weight, coefficient, cap, or formula changes. Add a
line to the version history at the top of `SCORING.md` saying what changed
and, where you can, which direction scores move. Keep
`docs/agent-score-calculation.md` and `docs/interaction-diagnostics.md` in
step with it; the three describe the same rules.

## Submitting a pull request

1. Create a branch from `main`.
2. Make your changes, ensuring tests pass and lint is clean.
3. Push your branch and open a PR against `main`.
4. A clear description of what changed and why helps reviewers give useful
   feedback faster.

## Testing

Tests use [Vitest](https://vitest.dev/) with [MSW](https://mswjs.io/) (Mock
Service Worker) for HTTP mocking. Run the full suite before submitting:

```bash
npm test
```

CI runs lint, format check, tests, and build on every pull request. Your PR
needs to pass all of them.

## AI usage

We expect contributors to use AI tools. If you use AI to help write code, review
the output before submitting. Make sure tests pass, the code handles edge cases
you care about, and you understand what it does. The bar is the same whether you
wrote it by hand or not.

## Code of Conduct

This project follows the [Contributor Covenant Code of Conduct](CODE_OF_CONDUCT.md).
By participating, you agree to uphold it.
