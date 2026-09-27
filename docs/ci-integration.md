# CI Integration

AFDocs includes vitest helpers so you can add agent-friendliness checks to your CI pipeline. Checks run as tests: each check is its own test case, so you can see exactly what passed, warned, failed, or was skipped.

## Quick setup

Install AFDocs and vitest as dev dependencies:

```bash
npm install -D afdocs vitest
```

### Config file

Create `agent-docs.config.yml` in your project root:

```yaml
url: https://docs.example.com
```

The helpers look for this file starting from `process.cwd()` and walking up the directory tree.

### Test file

Create `agent-docs.test.ts`:

```ts
import { describeAgentDocsPerCheck } from 'afdocs/helpers';

describeAgentDocsPerCheck();
```

### Run it

```bash
npx vitest run agent-docs.test.ts
```

Each check appears as its own test in the output:

```
 ✓ Agent-Friendly Documentation > llms-txt-exists
 ✓ Agent-Friendly Documentation > llms-txt-valid
 ✓ Agent-Friendly Documentation > llms-txt-size
 × Agent-Friendly Documentation > markdown-url-support
 ↓ Agent-Friendly Documentation > page-size-markdown
```

Checks that fail cause the test to fail. Checks that warn still pass (they're informational). Checks skipped due to unmet dependencies show as skipped.

## Running a subset of checks

If certain checks don't apply to your site (for example, you don't serve markdown), limit which checks run in the config:

```yaml
url: https://docs.example.com
checks:
  - llms-txt-exists
  - llms-txt-valid
  - llms-txt-size
  - http-status-codes
  - auth-gate-detection
```

Checks not in the list show as skipped in the test output.

## Config options

```yaml
url: https://docs.example.com

# Optional: run only specific checks (omit to run all 28)
# checks:
#   - llms-txt-exists
#   - llms-txt-valid
#   - llms-txt-size

# Optional: tune sampling behavior
# options:
#   maxLinksToTest: 50
#   samplingStrategy: deterministic

# Optional: test specific pages (implies samplingStrategy: curated)
# pages:
#   - https://docs.example.com/quickstart
#   - url: https://docs.example.com/api/auth
#     tag: api-reference
```

### Config resolution

The helpers look for `agent-docs.config.yml` (or `.yaml`) starting from `process.cwd()` and walking up the directory tree. You can also pass an explicit directory:

```ts
describeAgentDocsPerCheck(__dirname);
```

## Summary helper

If you don't need per-check granularity, `describeAgentDocs` provides a simpler two-test suite (one to run checks, one to assert no failures):

```ts
import { describeAgentDocs } from 'afdocs/helpers';

describeAgentDocs();
```

## Direct imports

For full control, use the programmatic API directly:

```ts
import { createContext, getCheck } from 'afdocs';
import { describe, it, expect } from 'vitest';

describe('agent-friendliness', () => {
  it('has a valid llms.txt', async () => {
    const ctx = createContext('https://docs.example.com');
    const check = getCheck('llms-txt-exists')!;
    const result = await check.run(ctx);
    expect(result.status).toBe('pass');
  });
});
```

## GitHub Actions

Add a workflow file at `.github/workflows/agent-docs.yml`:

```yaml
name: Agent-Friendly Docs

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  agent-docs-check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6

      - uses: actions/setup-node@v6
        with:
          node-version: 22

      - run: npm install

      - name: Run agent-friendly docs checks
        run: npx vitest run agent-docs.test.ts
        timeout-minutes: 5
```

### Add a test script

Alternatively, add a script to your `package.json`:

```json
{
  "scripts": {
    "test:agent-docs": "vitest run agent-docs.test.ts"
  }
}
```

Then reference it in the workflow:

```yaml
- name: Run agent-friendly docs checks
  run: npm run test:agent-docs
```

## Other CI providers

The GitHub Actions workflow is just Node.js setup + `npm install` + running the test. The same steps work on any CI provider. The test exits with code 0 if all checks pass (or warn) and code 1 if any check fails.

## Organizing files

If you prefer to keep test files out of your project root, move `agent-docs.config.yml` and `agent-docs.test.ts` into a subdirectory (e.g., `tests/`). Update the test file to tell AFDocs where to find the config:

```ts
import { describeAgentDocsPerCheck } from 'afdocs/helpers';

describeAgentDocsPerCheck(__dirname);
```

## Timeouts

The helpers set a 120-second timeout on the check run by default. If your site has many pages or your CI runner is slow, you can increase it by passing a second argument (in milliseconds):

```ts
// 5-minute timeout
describeAgentDocsPerCheck(__dirname, 300_000);
```

This works with both helpers:

```ts
describeAgentDocs(undefined, 300_000);
describeAgentDocsPerCheck(undefined, 300_000);
```

## Ready-to-copy example

The [`examples/`](https://github.com/agent-ecosystem/afdocs/tree/main/examples) directory in the AFDocs repo contains a complete, ready-to-copy setup with all the files from this page, including the GitHub Actions workflow.
