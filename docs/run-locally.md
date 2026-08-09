# Run Locally

You can run AFDocs against a local development server to iterate on fixes without deploying. This is the fastest way to work through the [Improve Your Score](/improve-your-score) workflow.

## Basic setup

Start your docs site locally, then point AFDocs at it:

```bash
# In one terminal, start your dev server
npm run dev
# → http://localhost:3000

# In another terminal, run checks
npx afdocs check http://localhost:3000
```

## Pick a safe port

AFDocs fetches pages with Node's built-in `fetch`, which implements the
WHATWG fetch spec, including its [bad port list](https://fetch.spec.whatwg.org/#port-blocking). Requests to a blocked port are refused before they reach the network, so a dev server on one of those ports is reachable by your browser and `curl` but not by AFDocs.

AFDocs detects this before running any checks and exits with an error naming the port, so a blocked port never shows up as a wall of "fetch failed" check results.

The common dev ports (3000, 4321, 5173, 8080, and Hugo's 1313) are all safe. The traps are ports reserved for other protocols that look reasonable for a dev server, like 1719 and 1720 (H.323), 6000 (X11), or 6667 (IRC). Moving the dev server to another port is the whole fix:

```bash
hugo server -p 1721   # not 1719
npx afdocs check http://localhost:1721
```

## Single-page mode

When working on a specific page, skip discovery and check just that page:

```bash
npx afdocs check http://localhost:3000/api/auth --sampling none
```

This is much faster than a full site check because it skips page discovery and only makes requests for the one URL.

## Run specific checks

If you're fixing a particular issue, run only the relevant checks:

```bash
# Just page size checks
npx afdocs check http://localhost:3000 --checks page-size-html,content-start-position

# Just llms.txt checks
npx afdocs check http://localhost:3000 --checks llms-txt-exists,llms-txt-valid,llms-txt-size

# Single page, single check
npx afdocs check http://localhost:3000/api/auth --sampling none --checks rendering-strategy
```

## Use a config file

For repeated local runs, create an `agent-docs.config.yml` pointing to localhost:

```yaml
url: http://localhost:3000

# Optional: run only specific checks
# checks:
#   - llms-txt-exists
#   - llms-txt-valid
#   - rendering-strategy

# Optional: tune sampling
# options:
#   maxLinksToTest: 20
#   samplingStrategy: deterministic
```

Then run checks without specifying the URL each time:

```bash
npx afdocs check --format scorecard
```

By default, the CLI looks for `agent-docs.config.yml` in the current directory (or any parent directory). You can also pass an explicit config path with `--config`:

```bash
npx afdocs check --config agent-docs.local.yml --format scorecard
```

This lets you maintain separate configs for different contexts (local development, staging, production) and choose the right one at runtime. It's the same config format used by the [vitest test helpers](/ci-integration). Any CLI flags you pass override the config values.

## Local vs. production differences

Some checks may behave differently against a local server:

- **Redirects**: Your production CDN or hosting provider may add redirects (e.g., trailing slash normalization, www redirects) that your local server doesn't. The `redirect-behavior` check may pass locally but warn or fail in production.
- **Cache headers**: Local dev servers typically don't set cache headers. The `cache-header-hygiene` check will likely fail locally. This is expected; check it against production instead.
- **Auth gating**: If your production site has authentication, your local server probably doesn't. The `auth-gate-detection` check will pass locally but may fail in production. This represents a real agent failure mode; if an agent can't access your documentation without logging in, an agent can't access your documentation.
- **Hot reload injection**: Some dev servers inject hot-reload scripts into the page HTML. This can affect `page-size-html` and `content-start-position` results. Build and serve the production output locally (e.g., `npm run build && npm run preview`) for accurate size measurements.
- **llms.txt**: If your llms.txt is generated at build time, it won't exist on the dev server. Either generate it first or skip the llms.txt checks locally.

## Production URLs in local builds

When you build your site locally, generated files like `llms.txt` and `sitemap.xml` typically contain your production domain. AFDocs sees URLs pointing to `https://docs.example.com` but you're testing `http://localhost:3000`, so origin comparisons fail and checks like `llms-txt-coverage` report 0% coverage.

Use `--canonical-origin` to tell AFDocs which production domain to rewrite:

```bash
npm run build
npx serve dist
npx afdocs check http://localhost:3000 --canonical-origin https://docs.example.com
```

Or in your config file:

```yaml
url: http://localhost:3000
options:
  canonicalOrigin: https://docs.example.com
```

AFDocs rewrites the production origin to localhost in every fetched response body, so all downstream checks see consistent same-origin URLs. This also works for preview deployments (Vercel, Netlify, etc.) where the same mismatch occurs.

## Building for accurate results

For the most accurate results, build the production output and serve it with a local static server:

```bash
npm run build
npx serve dist    # or however your site serves its build output
npx afdocs check http://localhost:3000
```
