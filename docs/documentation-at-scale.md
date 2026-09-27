# Documentation at Scale

Use this guide as a rule of thumb when your site has roughly 500 or more
documentation pages, or two or more products sharing a host that need
separate results. These are workflow guidelines, not crawl limits. Smaller
sites can benefit too when their content types, locales, or versions need
separate attention.

The default run samples at most 50 pages. As the corpus grows or becomes more
varied, which pages are selected matters more than the total count alone.
Start with the product and audience you own, maintain a representative page
set, and understand what your checks do and do not cover.

AFDocs samples documentation; it is not an exhaustive crawler. A completed
run tells you about the pages and checks it evaluated, not every page on the
host.

## Define the scope your team owns

Use a separate config for each product, locale, or supported version that
needs its own results and owner. Choose a base URL whose path actually
contains that content.

For example, a Microsoft Learn team might own content under
`https://learn.microsoft.com/en-us/dotnet/`. Neither the whole Learn host nor
the general `/en-us/docs/` landing page is a useful substitute for that
product scope. In the live run that motivated this guidance, `/en-us/docs/`
matched none of the examined sitemap URLs; AFDocs finished by checking the
base page instead.

With `https://learn.microsoft.com/en-us/dotnet/` as your starting URL, AFDocs
looks for pages whose addresses begin with that URL. This shared beginning
is the **[product prefix](/glossary#product-prefix)**. Changing the starting URL to
`https://learn.microsoft.com/` opens the search to other products and
languages, including Azure and SQL Server. A sample from that wider search
would no longer tell you specifically how your .NET documentation performs.

On a large site, the published list of pages may be split across many files.
AFDocs limits how much of that list it reads, so it may stop before reaching
your product even when your starting URL is correct. If that happens, keep
the product URL and supply your own page list for page checks, as shown
below. Changing to the whole-site URL just to remove the warning does not
solve the problem of finding a useful sample for your team.

A **[curated page list](/glossary#curated-page-list)** is a list of pages you
choose yourself. For an assessment of English-language .NET documentation:

- Include `https://learn.microsoft.com/en-us/dotnet/core/install/`, an installation guide.
- Include `https://learn.microsoft.com/en-us/dotnet/csharp/`, the C# documentation.
- Leave out `https://learn.microsoft.com/en-us/azure/virtual-machines/overview`, which belongs to a different product.
- Leave out `https://learn.microsoft.com/de-de/dotnet/core/install/`, which is a German-language version, unless you intend to assess that language too.

When you use a curated page list, AFDocs scores the pages you list, even if
they belong to another product or language. Setting the starting URL to the
English .NET section does not remove the Azure or German pages from your list.
Review the list to make sure it contains the pages your team wants results for.

## Maintain a representative page set

Commit a curated config alongside your documentation. Include examples of the
content and templates agents need to consume:

- An installation page and a first successful task.
- A tutorial with commands and code examples.
- An API or command reference with tables and parameters.
- A page with tabs, generated content, or other complex rendering.
- An upgrade or troubleshooting page used by existing customers.

These are selection criteria, not a statistical sampling guarantee. Add pages
when a new template ships or a regression reveals a missing case. Retire
obsolete entries deliberately; do not replace a failing page just to improve
the score. Tags can group results by content type or ownership, but AFDocs
does not use them to balance the sample.

### Routine page checks

The following example uses placeholder URLs for one product. Replace them
with real pages your team owns and save the config as something like
`agent-docs.YOUR_PRODUCT-pages.yml`. For example, you might name the
config below `agent-docs.widgets-pages.yml` and include these specific URLs:

```yaml
url: https://docs.example.com/en-us/widgets/

options:
  samplingStrategy: curated
  requestDelay: 500
  maxConcurrency: 1

checks:
  - markdown-url-support
  - content-negotiation
  - page-size-html
  - page-size-transfer
  - auth-gate-detection

pages:
  - url: https://docs.example.com/en-us/widgets/install
    tag: getting-started
  - url: https://docs.example.com/en-us/widgets/tutorials/first-app
    tag: getting-started
  - url: https://docs.example.com/en-us/widgets/reference/commands
    tag: reference
  - url: https://docs.example.com/en-us/widgets/guides/configuration
    tag: guides
  - url: https://docs.example.com/en-us/widgets/troubleshooting
    tag: guides
```

Run it with:

```bash
npx afdocs check --config agent-docs.widgets-pages.yml --format scorecard
```

This deliberately limited check set evaluates Markdown access, HTML size,
and authentication behavior without walking a sitemap or the site's llms.txt
links. It is a starting point, not a full assessment of agent-friendliness.
Expand it using the [Checks Reference](/checks/), including dependencies where
required. An explicit `checks` list does not pick up newly added checks
automatically; review it when upgrading AFDocs.

All curated entries are used for the page sample; `maxLinksToTest` does not
truncate the list. If you provide 80 URLs and set `maxLinksToTest` to 50,
AFDocs checks all 80 URLs you provide. Individual checks still apply their
normal eligibility rules. Five listed pages also does not mean five requests:
Markdown URL candidates, content negotiation, redirects, and other checks
can require additional requests.

Adding other checks can change the request scope. In particular,
`llms-txt-coverage` reads sitemaps independently of the curated sample, and
llms.txt link checks follow links published in that file. Curated sampling
does not restrict every check to fetching only the listed URLs.

For details on tags and config selection, see the
[Config File Reference](/reference/config-file#pages-optional).

## What curated checks don't tell you

A maintained page list answers whether known pages remain usable. It does
not establish whether an agent can discover new content or whether llms.txt
covers the product's documentation.

Automatic discovery can work when AFDocs reaches the relevant published
lists of pages. On a large shared site, it can stop before finding your
product. In our live test of Microsoft Learn's .NET section, AFDocs reached
its sitemap-reading limit while reading lists of archived content. It found
no .NET pages and checked only the landing page. Coverage was skipped
because no llms.txt was found at the locations AFDocs checked.

For a site in that situation, use the curated config above for repeatable
page checks. A quick run or a good score does not establish that agents can
find your product's pages. AFDocs does not yet let you choose a product's
sitemap in a config file; that work is tracked in
[#142](https://github.com/agent-ecosystem/afdocs/issues/142). Until it can
reach the relevant page lists, it cannot provide a reliable product-wide
discovery or coverage assessment for that site.

On a shared platform, product teams can maintain page samples and fix their
content, while platform owners handle shared rendering, Markdown delivery,
index publication, and server behavior. Send findings to the team that can
change the behavior rather than treating every failure as a writer's task.

## Recognize incomplete evidence

Review the actual tested pages and check results before interpreting a
score. Use `--verbose` with your curated config for investigation, or retain
a JSON report for CI:

```bash
npx afdocs check --config agent-docs.widgets-pages.yml --format json --score > widgets-pages-report.json
```

If you also run checks that find pages automatically or read sitemaps, review
their discovery warnings. The following findings limit what you can conclude:

| Finding                                         | What to do                                                                                                                                                                                       |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A path prefix matches few or no examined URLs   | Check the prefix against actual content URLs. If it is correct, a shared index may not have reached your product; use a curated page set for page checks and investigate index scope separately. |
| A sitemap budget stops discovery                | Treat the discovered set and coverage result as partial. Review the reported source with the platform owner. Do not assume increasing `--max-links` raises the sitemap budget.                   |
| Only the base page was tested                   | Do not interpret that as a product-wide assessment. Check discovery warnings, then provide a representative list or repair discovery.                                                            |
| A check is skipped                              | Inspect its dependencies and applicability. A skipped coverage check does not establish coverage.                                                                                                |
| Requests are blocked, rate-limited, or time out | Review the request summary and network context; coordinate the test cadence and CI environment with the platform owner.                                                                          |

The [CLI Reference](/reference/cli#url-discovery) describes sitemap budgets
and their limitations. Limits apply per walk, not per scan; the byte budget
is checked between responses. They prevent a runaway walk but do not certify
that enough of the corpus was discovered.

Warnings do not normally cause a failing CLI exit code. A successful command
is therefore not proof of complete discovery. Preserve warnings and check
details with the report, especially when deciding whether a result is
suitable as a release gate.

## Make results useful in CI

Run curated regression checks against a preview of the change on pull
requests. Check that the configured page URLs target that preview, not the
production site. Run the same curated page list against the deployed site on
release or on a schedule to evaluate the server behavior a local preview
cannot reproduce. See
[Run Locally](/run-locally) and
[CI Integration](/ci-integration#checking-a-build-and-the-deployed-site).

Pin the AFDocs version in your project's dependencies, set a CI job timeout,
and stagger product jobs that share a host. Request delay and concurrency
settings apply to each run; ten concurrent jobs do not share one limiter.
Lowering `--max-links` reduces a discovered page sample, not all discovery
traffic, and does not reduce an explicit curated list.

Keep the scope, page list, tags, selected checks, AFDocs version, and target
environment with each report. Compare like-for-like runs. A score for five
curated pages and a selected check set is not directly comparable to a
full-check score for another product or a different page sample. Do not average
product scores into a host-wide score without defining what that aggregate
would represent.

For a team on a platform such as Microsoft Learn, the first useful milestone
is a repeatable product-owned regression run with actionable findings. A
platform-wide assessment needs a separately designed sampling and discovery
strategy, not a larger value of `--max-links`.
