/** English (default) output strings. Keys shared with zh catalog. */
export const en: Record<string, string> = {
  // --- runner ---
  'runner.skip_excluded': 'Check skipped (excluded via --skip-checks)',
  'runner.skip_dependency': 'Skipped: dependency check did not pass',
  'runner.check_error': 'Check error: {error}',
  'runner.__test_en_only__': 'english-only-fallback',

  // --- common fragments ---
  'common.sampled_pages': 'sampled pages',
  'common.pages': 'pages',
  'common.link': 'link',
  'common.links': 'links',
  'common.sampled_links': 'sampled links',
  'common.fetch_errors_suffix': '; {count} failed to fetch',
  'common.rate_limited_suffix': '; {count} rate-limited (HTTP 429)',

  // --- check: llms-txt-exists ---
  'check.llms-txt-exists.fail_explicit':
    'No llms.txt found at the URL specified via --llms-txt-url ({url}){redirectNote}{suffix}',
  'check.llms-txt-exists.fail_candidates':
    'No llms.txt found at any candidate location ({candidates}){redirectNote}{suffix}',
  'check.llms-txt-exists.redirect_note':
    "; candidates redirected cross-host to {origins} (agents can't follow cross-host redirects)",
  'check.llms-txt-exists.warn_cross_host':
    'llms.txt found but only reachable via cross-host redirect (agents may not follow it){suffix}',
  'check.llms-txt-exists.pass_explicit': 'llms.txt found at {url} (specified via --llms-txt-url)',
  'check.llms-txt-exists.pass_single': 'llms.txt found at {url}',
  'check.llms-txt-exists.pass_multi_canonical':
    'llms.txt found at {count} locations; using {url} as canonical',
  'check.llms-txt-exists.pass_multi': 'llms.txt found at {count} location(s)',

  // --- check: llms-txt-valid ---
  'check.llms-txt-valid.skip_none': 'No llms.txt files to validate',
  'check.llms-txt-valid.pass':
    'llms.txt follows the proposed structure (H1, blockquote, heading-delimited link sections)',
  'check.llms-txt-valid.warn':
    "llms.txt contains parseable links but doesn't fully follow the proposed structure: {issues}",
  'check.llms-txt-valid.fail': 'llms.txt exists but contains no parseable links',

  // --- check: llms-txt-size ---
  'check.llms-txt-size.skip_none': 'No llms.txt files to measure',
  'check.llms-txt-size.pass': 'llms.txt is {size} characters (under {pass} threshold)',
  'check.llms-txt-size.warn':
    'llms.txt is {size} characters (between {pass} and {fail}; consider splitting)',
  'check.llms-txt-size.fail':
    'llms.txt is {size} characters (exceeds {fail} threshold; will be truncated by most agents)',

  // --- check: llms-txt-links-resolve ---
  'check.llms-txt-links-resolve.skip_none': 'No llms.txt files to check links for',
  'check.llms-txt-links-resolve.skip_filtered':
    'llms.txt contains {count} link{plural}, but none are under {path}',
  'check.llms-txt-links-resolve.skip_no_http': 'No HTTP(S) links found in llms.txt',
  'check.llms-txt-links-resolve.pass_external':
    'All {count} links are external and resolve ({total} total links)',
  'check.llms-txt-links-resolve.warn_external':
    'All links are external; {resolved}/{total} resolve ({broken} failed; may be bot-detection or rate-limiting)',
  'check.llms-txt-links-resolve.pass':
    'All {sameCount} same-origin {linkLabel} resolve ({total} total links){suffix}{crossNote}',
  'check.llms-txt-links-resolve.warn':
    '{resolved}/{sameCount} same-origin {linkLabel} resolve ({rate}%); {broken} broken{suffix}{crossNote}',
  'check.llms-txt-links-resolve.fail':
    'Only {resolved}/{sameCount} same-origin {linkLabel} resolve ({rate}%); {broken} broken{suffix}{crossNote}',

  // --- check: llms-txt-links-markdown ---
  'check.llms-txt-links-markdown.skip_none': 'No llms.txt files to check links for',
  'check.llms-txt-links-markdown.skip_external':
    'All {total} links are external; cannot assess markdown support',
  'check.llms-txt-links-markdown.pass':
    '{markdown}/{total} same-origin {linkLabel} point to markdown content ({rate}%){suffix}{crossNote}',
  'check.llms-txt-links-markdown.warn_variants':
    'Same-origin links point to HTML, but {count} have .md variants available{suffix}{crossNote}',
  'check.llms-txt-links-markdown.fail':
    'Same-origin links point to HTML and no markdown alternatives detected{suffix}{crossNote}',

  // --- check: llms-txt-directive-html ---
  'check.llms-txt-directive-html.error_none': 'Could not test any pages{suffix}',
  'check.llms-txt-directive-html.fail_none':
    'No llms.txt directive found in HTML of any of {count} {pageLabel}{suffix}',
  'check.llms-txt-directive-html.warn_buried':
    'llms.txt directive found in HTML of {found} of {total} {pageLabel}, but buried deep in the page (past 20% of content){suffix}',
  'check.llms-txt-directive-html.warn_partial':
    'llms.txt directive found in HTML of {found} of {total} {pageLabel} ({missing} missing){suffix}',
  'check.llms-txt-directive-html.pass':
    'llms.txt directive found in HTML of all {total} {pageLabel}{nearTop}{suffix}',
  'check.llms-txt-directive-html.near_top': ', near the top of content',

  // --- check: llms-txt-directive-md ---
  'check.llms-txt-directive-md.no_md_suffix': '; {count} had no markdown version',
  'check.llms-txt-directive-md.error_none':
    'Could not fetch markdown for any of {count} pages{suffix}',
  'check.llms-txt-directive-md.fail_none':
    'No llms.txt directive found in markdown of any of {count} {pageLabel}{suffix}',
  'check.llms-txt-directive-md.warn_buried':
    'llms.txt directive found in markdown of {found} of {total} {pageLabel}, but buried deep in the page (past 20% of content){suffix}',
  'check.llms-txt-directive-md.warn_partial':
    'llms.txt directive found in markdown of {found} of {total} {pageLabel} ({missing} missing){suffix}',
  'check.llms-txt-directive-md.pass':
    'llms.txt directive found in markdown of all {total} {pageLabel}{nearTop}{suffix}',
  'check.llms-txt-directive-md.near_top': ', near the top of content',

  // --- check: markdown-url-support ---
  'check.markdown-url-support.pass':
    '{supported}/{total} {pageLabel} support .md URLs ({rate}%){suffix}',
  'check.markdown-url-support.warn':
    '{supported}/{total} {pageLabel} support .md URLs ({rate}%); inconsistent support{suffix}',
  'check.markdown-url-support.fail': 'No {pageLabel} support .md URLs (0/{total} tested){suffix}',

  // --- check: content-negotiation ---
  'check.content-negotiation.pass':
    '{correct}/{total} {pageLabel} support content negotiation ({rate}%){suffix}',
  'check.content-negotiation.warn':
    'Content negotiation partially supported: {correct} correct type, {wrong} wrong type, {htmlOnly} HTML only{suffix}',
  'check.content-negotiation.fail':
    'Server ignores Accept: text/markdown header (0/{total} {pageLabel} return markdown){suffix}',

  // --- check: page-size-markdown ---
  'check.page-size-markdown.skip_no_md':
    'Site does not serve markdown; skipping markdown size check',
  'check.page-size-markdown.skip_none': 'No markdown pages available to measure',
  'check.page-size-markdown.pass':
    'All {total} {pageLabel} under {pass} chars (median {median}, max {max})',
  'check.page-size-markdown.warn':
    '{warn} of {total} {pageLabel} between {pass}–{fail} chars (max {max})',
  'check.page-size-markdown.fail':
    '{failCount} of {total} {pageLabel} exceed {fail} chars (max {max})',

  // --- check: page-size-html ---
  'check.page-size-html.error_none': 'Could not fetch any pages to measure{suffix}',
  'check.page-size-html.pass':
    'All {total} {pageLabel} under {pass} chars (median {medianHtml} HTML → {medianMd} markdown ({avgRatio}% boilerplate)){suffix}',
  'check.page-size-html.warn':
    '{warn} of {total} {pageLabel} convert to {pass}–{fail} chars (max {maxHtml} HTML → {maxMd} markdown ({avgRatio}% boilerplate)){suffix}',
  'check.page-size-html.fail':
    '{failCount} of {total} {pageLabel} convert to over {fail} chars (max {maxHtml} HTML → {maxMd} markdown ({avgRatio}% boilerplate)){suffix}',

  // --- check: content-start-position ---
  'check.content-start-position.error_none': 'Could not fetch any pages to analyze{suffix}',
  'check.content-start-position.pass':
    'Content starts within first 10% on all {total} {pageLabel} (median {median}%){suffix}',
  'check.content-start-position.warn':
    '{warn} of {total} {pageLabel} have content starting at 10–50% (worst {worst}%){suffix}',
  'check.content-start-position.fail':
    '{failCount} of {total} {pageLabel} have content starting past 50% (worst {worst}%){suffix}',

  // --- check: rendering-strategy ---
  'check.rendering-strategy.sparse_note':
    '; {sparse} more have page structure but little substantive content',
  'check.rendering-strategy.fetch_note': '; {count} failed to fetch',
  'check.rendering-strategy.error_none': 'Could not fetch any pages to analyze{suffix}',
  'check.rendering-strategy.pass':
    'All {total} {pageLabel} contain server-rendered content{fetchNote}',
  'check.rendering-strategy.fail_spa':
    '{spa} of {total} {pageLabel} appear to be client-side rendered SPA shells{frameworkHint}; agents using HTTP fetches will see no content{sparseNote}{fetchNote}',
  'check.rendering-strategy.warn_sparse':
    "{sparse} of {total} {pageLabel} have server-rendered page structure but little substantive content; agents will see headings and navigation but not the page's actual documentation{fetchNote}",

  // --- check: tabbed-content-serialization ---
  'check.tabbed-content-serialization.error_none': 'Could not fetch any pages to analyze{suffix}',
  'check.tabbed-content-serialization.pass_none':
    'No tabbed content detected across {total} {pageLabel}',
  'check.tabbed-content-serialization.pass':
    '{groups} tab group(s) across {pages} of {total} {pageLabel}; all serialize under 50K chars',
  'check.tabbed-content-serialization.warn':
    '{groups} tab group(s) found; worst page serializes to {size} chars (50K–100K)',
  'check.tabbed-content-serialization.fail':
    '{groups} tab group(s) found; worst page serializes to {size} chars (over 100K)',

  // --- check: section-header-quality ---
  'check.section-header-quality.skip_dep': 'Skipped: tabbed-content-serialization did not run',
  'check.section-header-quality.skip_no_tabs':
    'No tabbed content found; header quality check not applicable',
  'check.section-header-quality.skip_few_panels':
    'Tab groups have fewer than 2 panels; header quality check not applicable',
  'check.section-header-quality.skip_no_headers':
    '{pages} page(s) with tabs found, but no section headers inside tab panels to evaluate',
  'check.section-header-quality.pass':
    '{pages} page(s) with tab headers checked; headers include variant context',
  'check.section-header-quality.issue':
    '{summary} (e.g. "{header}" repeats across {groups} tab groups)',

  // --- check: markdown-code-fence-validity ---
  'check.markdown-code-fence-validity.skip_no_md':
    'Site does not serve markdown content; nothing to analyze',
  'check.markdown-code-fence-validity.skip_none': 'No markdown content found{hint}',
  'check.markdown-code-fence-validity.pass':
    'All {fences} code fences properly closed across {pages} pages',
  'check.markdown-code-fence-validity.fail':
    '{count} unclosed code fences found across {pages} pages',

  // --- check: http-status-codes ---
  'check.http-status-codes.error_none': 'Could not test any URLs{suffix}',
  'check.http-status-codes.warn_indeterminate':
    'Could not determine bad-URL handling: all {count} {pageLabel} returned indeterminate responses{suffix}',
  'check.http-status-codes.fail_soft404':
    '{soft404s} of {determinate} {pageLabel} return 200 for non-existent URLs (soft 404){suffix}',
  'check.http-status-codes.pass':
    'All {determinate} {pageLabel} return proper error codes for bad URLs{suffix}',

  // --- check: redirect-behavior ---
  'check.redirect-behavior.part_js': '{count} JavaScript redirect(s)',
  'check.redirect-behavior.part_cross_host': '{count} cross-host redirect(s)',
  'check.redirect-behavior.and': ' and ',
  'check.redirect-behavior.error_none': 'Could not test any URLs{suffix}',
  'check.redirect-behavior.pass_none': 'No redirects detected across {total} {pageLabel}{suffix}',
  'check.redirect-behavior.pass_same_host':
    'All {redirects} redirect(s) across {total} {pageLabel} are same-host HTTP redirects{suffix}',
  'check.redirect-behavior.warn_cross_host':
    '{crossHost} of {total} {pageLabel} use cross-host redirects{suffix}',
  'check.redirect-behavior.fail_mixed': '{parts} detected across {total} {pageLabel}{suffix}',

  // --- check: llms-txt-coverage ---
  'check.llms-txt-coverage.skip_no_pages': 'No page URLs found in llms.txt',
  'check.llms-txt-coverage.skip_no_sitemap':
    'No sitemap found; cannot assess llms.txt coverage without a sitemap as ground truth',
  'check.llms-txt-coverage.skip_prefix':
    'Sitemap has {count} URLs but none are under the docs path prefix ({prefix})',
  'check.llms-txt-coverage.pass': 'llms.txt covers {coverage}% of {total} sitemap doc pages',
  'check.llms-txt-coverage.nonpass':
    'llms.txt covers {covered}/{total} sitemap doc pages ({coverage}%); {missing} missing',
  'check.llms-txt-coverage.omitted':
    '{indexes} nested indexes omitted ({pages} sitemap pages excluded)',
  'check.llms-txt-coverage.unmatched':
    '{count} llms.txt links not in sitemap (may indicate stale links or incomplete sitemap)',

  // --- check: markdown-content-parity ---
  'check.markdown-content-parity.skip_none': 'No pages with markdown versions available to compare',
  'check.markdown-content-parity.error_none':
    'Could not fetch HTML for any pages to compare{suffix}',
  'check.markdown-content-parity.pass':
    'All {total} pages have equivalent markdown and HTML content (avg {avg}% missing){suffix}',
  'check.markdown-content-parity.warn':
    '{warn} of {total} pages have minor content differences between markdown and HTML{suffix}',
  'check.markdown-content-parity.fail':
    '{failCount} of {total} pages have substantive content differences between markdown and HTML (avg {avg}% missing){suffix}',

  // --- check: cache-header-hygiene ---
  'check.cache-header-hygiene.error_none':
    'Could not fetch any endpoints to check cache headers{suffix}',
  'check.cache-header-hygiene.pass': 'All {total} endpoints have appropriate cache headers{suffix}',
  'check.cache-header-hygiene.warn':
    '{warn} of {total} endpoints have moderate cache lifetimes (1–24 hours){suffix}',
  'check.cache-header-hygiene.fail':
    '{failCount} of {total} endpoints have aggressive caching or missing cache headers{suffix}',

  // --- check: auth-gate-detection ---
  'check.auth-gate-detection.error_none':
    'Could not fetch any pages to check authentication{suffix}',
  'check.auth-gate-detection.pass': 'All {count} {pageLabel} are publicly accessible{suffix}',
  'check.auth-gate-detection.warn':
    '{gated} of {total} {pageLabel} require authentication ({accessible} accessible){suffix}',
  'check.auth-gate-detection.fail': 'All {total} {pageLabel} require authentication{suffix}',

  // --- check: auth-alternative-access ---
  'check.auth-alternative-access.skip_dep_missing': 'auth-gate-detection did not run',
  'check.auth-alternative-access.pass_public':
    'All docs pages are publicly accessible; no alternative access paths needed',
  'check.auth-alternative-access.skip_dep_status':
    'auth-gate-detection {status}; cannot assess alternative access',
  'check.auth-alternative-access.skip_fetch_errors':
    'auth-gate-detection failed due to fetch errors, not detected auth responses; cannot assess alternative access',
  'check.auth-alternative-access.fail_none':
    'No alternative access paths detected for {gated} auth-gated pages. {note}',
  'check.auth-alternative-access.manual_note':
    'Some access paths cannot be detected automatically: bundled SDK docs, CLI doc commands, and MCP servers',
  'check.auth-alternative-access.warn_partial':
    'Partial alternative access detected ({paths}) for site with {gated} auth-gated pages. {note}',
  'check.auth-alternative-access.pass':
    'Alternative access detected ({paths}) for site with {gated} auth-gated pages',

  // --- resolutions ---
  'resolution.llms-txt-exists.warn':
    "Your llms.txt is only reachable via a cross-host redirect, which some agents don't follow. Serve llms.txt directly from the same host as your documentation, or add a same-host redirect.",
  'resolution.llms-txt-exists.fail':
    'Create an llms.txt file at your site root containing an H1 title, a blockquote summary, and markdown links to your key documentation pages. This is the single highest-impact improvement for agent access to your docs.',
  'resolution.llms-txt-valid.warn':
    "Your llms.txt contains parseable links but doesn't follow the standard structure. Add an H1 title as the first line and a blockquote summary (lines starting with >) to improve agent parsing.",
  'resolution.llms-txt-valid.fail':
    'Your llms.txt exists but contains no parseable markdown links. Add links in [name](url): description format under heading-delimited sections.',
  'resolution.llms-txt-size.warn':
    'Your llms.txt is {size} characters, which may be truncated on some agent platforms. If it grows further, split into nested llms.txt files with a root index under 50,000 characters.',
  'resolution.llms-txt-size.fail':
    'Your llms.txt is {size} characters and will be truncated by all major agent platforms. Split into a root index linking to section-level llms.txt files, each under 50,000 characters.',
  'resolution.llms-txt-links-resolve.warn':
    '{broken} of {total} links in your llms.txt return errors. Audit and fix or remove broken URLs to prevent agents from hitting dead ends.',
  'resolution.llms-txt-links-resolve.fail':
    '{broken} of {total} links in your llms.txt return errors. A stale llms.txt with broken links is worse than no llms.txt at all because it sends agents down dead ends with high confidence.',
  'resolution.llms-txt-links-markdown.warn':
    'Some links in your llms.txt point to HTML pages instead of markdown. Where possible, update links to use .md URLs so agents get clean markdown content directly.',
  'resolution.llms-txt-links-markdown.fail':
    'Your llms.txt links point to HTML pages. Update them to .md URL variants so agents receive markdown instead of converted HTML.',
  'resolution.llms-txt-directive-html.warn':
    'An llms.txt directive was found in the HTML of some pages but is missing from others, or is buried deep in the page. Ensure the directive appears near the top of every documentation page.',
  'resolution.llms-txt-directive-html.fail':
    'No agent-facing directive pointing to llms.txt was detected in the HTML of any tested page. Add a visually-hidden element near the top of each page (e.g., a div with CSS clip-rect) containing a link to your llms.txt. If your site serves markdown versions of pages, mention that in the directive too so agents know to request it.',
  'resolution.llms-txt-directive-md.warn':
    'An llms.txt directive was found in the markdown of some pages but is missing from others, or is buried deep in the page. Ensure the directive appears near the top of every markdown page.',
  'resolution.llms-txt-directive-md.fail':
    'No llms.txt directive was detected in the markdown of any tested page. Add a blockquote near the top of each markdown page (e.g., "> For the complete documentation index, see [llms.txt](/llms.txt)").',
  'resolution.markdown-url-support.warn':
    '{warnCount} of {tested} pages support .md URLs inconsistently. Ensure all documentation pages serve markdown when .md is appended to the URL.',
  'resolution.markdown-url-support.fail':
    "Your pages don't return markdown when .md is appended to the URL. Configure your docs platform to serve .md variants for all documentation pages.",
  'resolution.content-negotiation.warn':
    'Your server returns markdown content for Accept: text/markdown requests but with an incorrect Content-Type header. Set the response Content-Type to text/markdown for proper agent handling.',
  'resolution.content-negotiation.fail':
    'Your server ignores Accept: text/markdown and returns HTML. Some agents (Claude Code, Cursor, OpenCode) request markdown this way. Configure your server to honor content negotiation.',
  'resolution.rendering-strategy.warn':
    '{warnCount} of {tested} pages have sparse content that may rely on client-side JavaScript to populate. Verify that key content is present in the server-rendered HTML response.',
  'resolution.rendering-strategy.fail':
    '{failCount} of {tested} pages use client-side rendering. Agents receive an empty shell with no documentation content. Enable server-side rendering or pre-rendering for documentation pages.',
  'resolution.page-size-markdown.warn':
    '{warnCount} of {tested} markdown pages are between 50K and 100K characters. These may be truncated on some agent platforms or routed through summarization. Consider splitting large pages.',
  'resolution.page-size-markdown.fail':
    '{failCount} of {tested} markdown pages exceed 100K characters and will be truncated by agents. Break these into smaller pages or restructure serialized tabbed content.',
  'resolution.page-size-html.warn':
    '{warnCount} of {tested} pages convert to 50K-100K characters of markdown. Review pages for reducible boilerplate (navigation, serialized tabbed content). Consider providing markdown versions as a smaller alternative path for agents.',
  'resolution.page-size-html.fail':
    '{failCount} of {tested} pages convert to over 100K characters of markdown. Break large pages into smaller units, reduce navigation boilerplate, or provide markdown versions that bypass the HTML conversion overhead.',
  'resolution.content-start-position.warn':
    '{warnCount} of {tested} pages have documentation content starting 10-50% into the converted output. Reduce navigation, breadcrumb, and sidebar markup that precedes the content area.',
  'resolution.content-start-position.fail':
    '{failCount} of {tested} pages have content starting past 50% of the converted output. Agents may never see the documentation content. Reduce navigation, breadcrumb, and sidebar markup that precedes the content area.',
  'resolution.tabbed-content-serialization.warn':
    'Tabbed content on {warnCount} pages serializes to 50K-100K characters. Consider breaking tab variants into separate pages or providing a mechanism for agents to request specific variants.',
  'resolution.tabbed-content-serialization.fail':
    'Tabbed content on {failCount} pages serializes to over 100K characters. Agents see only the first few tab variants; content in later tabs is truncated. Break variants into separate pages.',
  'resolution.section-header-quality.warn':
    '25-50% of headers in tabbed sections are generic (e.g., repeated "Step 1" across variants). Add variant context to headers (e.g., "Step 1 (Python)") so agents can distinguish sections.',
  'resolution.section-header-quality.fail':
    'Over 50% of headers are generic across tab variants. When serialized, agents cannot tell which section belongs to which variant.',
  'resolution.markdown-code-fence-validity.fail':
    '{failCount} pages have unclosed code fences. Everything after an unclosed fence is interpreted as code, causing agents to misread documentation as literal content. Ensure every opening ``` or ~~~ has a matching closing delimiter.',
  'resolution.http-status-codes.fail':
    "Your site returns 200 for non-existent pages (soft 404). Agents try to extract information from the error page content instead of recognizing the page is missing. Configure your server to return 404 for pages that don't exist.",
  'resolution.redirect-behavior.warn':
    "{warnCount} pages use cross-host HTTP redirects, which some agents don't follow. Where possible, use same-host redirects or update URLs to point directly to the final destination.",
  'resolution.redirect-behavior.fail':
    "JavaScript-based redirects detected on {failCount} pages. Agents don't execute JavaScript and will not follow these redirects. Use HTTP 301/302 redirects instead.",
  'resolution.llms-txt-coverage.warn':
    "Your llms.txt covers {coverage}% of your site's pages ({warnThreshold}-{passThreshold}% is warn). {missing} live pages are not represented in the index. Review missing pages and add them, or adjust --coverage-pass-threshold/--coverage-warn-threshold if they are intentionally excluded.",
  'resolution.llms-txt-coverage.fail':
    "Your llms.txt covers {coverage}% of your site's pages (below {warnThreshold}% threshold). {missing} live pages are missing from the index. If unintentional, regenerate llms.txt from your sitemap or build pipeline. If intentional, lower the threshold or set it to 0 to make the check informational.",
  'resolution.markdown-content-parity.warn':
    '{warnCount} pages have minor content differences between their markdown and HTML versions. If this is intentional audience segmentation, adjust --parity-pass-threshold and --parity-warn-threshold (set both to 0 for informational mode).',
  'resolution.markdown-content-parity.fail':
    '{failCount} pages have substantive content differences between markdown and HTML (avg {avgMissing}% missing). If unintentional, agents are getting outdated content; regenerate markdown from source or fix the build pipeline. If intentional (audience segmentation), add data-markdown-ignore to human-only HTML elements, or adjust thresholds with --parity-pass-threshold/--parity-warn-threshold.',
  'resolution.cache-header-hygiene.warn':
    '{warnCount} endpoints have moderate cache lifetimes (1-24 hours). Updates to llms.txt or markdown content may take hours to propagate. Consider reducing cache lifetimes for these resources.',
  'resolution.cache-header-hygiene.fail':
    '{failCount} endpoints have aggressive caching (>24h) or missing cache headers. Set max-age under 3600 or add must-revalidate with ETag/Last-Modified so content updates reach agents promptly.',
  'resolution.auth-gate-detection.warn':
    'Some documentation pages require authentication while others are public. Agents can access public pages but will fall back on training data for gated content. Consider ungating reference docs and API guides.',
  'resolution.auth-gate-detection.fail':
    'All or most documentation pages require authentication. Agents cannot access your documentation and will rely on potentially outdated training data or secondary sources. Consider providing alternative access paths (see auth-alternative-access check).',
  'resolution.auth-alternative-access.warn':
    'Partial alternative access detected for auth-gated content (e.g., public llms.txt covers some but not all gated pages). Expand alternative access to cover more of the gated documentation.',
  'resolution.auth-alternative-access.fail':
    'No alternative access paths detected for auth-gated content. Consider providing a public llms.txt, ungating reference docs, shipping docs with your SDK, or providing an MCP server for authenticated access.',

  // --- diagnostics ---
  'diagnostic.markdown-undiscoverable.message':
    'Your site serves markdown at .md URLs, but agents have no way to discover this. No agent-facing directive points to your llms.txt, and the server does not support content negotiation. Most agents will default to the HTML path and never benefit from your markdown support.',
  'diagnostic.markdown-undiscoverable.resolution':
    'Add a directive near the top of each docs page pointing to your llms.txt, and implement content negotiation for Accept: text/markdown. The directive is the primary discovery mechanism (it reaches all agents); content negotiation provides a fast path for agents that request markdown by default.',
  'diagnostic.markdown-partially-discoverable.message':
    'Your site serves markdown and supports content negotiation, but has no agent-facing directive on HTML pages pointing to llms.txt. Agents that send Accept: text/markdown (Claude Code, Cursor, OpenCode) get markdown automatically, but the majority of agents fetch HTML by default and have no signal to try the markdown path.',
  'diagnostic.markdown-partially-discoverable.resolution':
    'Add a directive near the top of each docs page pointing to your llms.txt. If your site serves markdown, mention that in the directive too. The directive reaches all agents, not just the ones that request markdown by default.',
  'diagnostic.truncated-index.message':
    "Your llms.txt is {size} characters. Agents see roughly the first 100,000 characters ({visiblePct}% of the file). Links, structure, and freshness beyond that point don't affect agent experience. Quality checks on the invisible portion are discounted in the score.",
  'diagnostic.truncated-index.resolution':
    "Split into a root index linking to section-level llms.txt files, each under 50,000 characters. See the spec's progressive disclosure recommendation.",
  'diagnostic.spa-shell-html-invalid.message':
    '{spaShells} of {total} sampled pages are client-side-rendered shells: the HTML response contains a framework root element but no documentation content. Agents using HTTP fetches receive empty pages. Page size and content structure scores for the HTML path are discounted because they are partially measuring shells rather than content.{mdNote}',
  'diagnostic.spa-shell-html-invalid.md_note_ok':
    ' Your markdown path still works for agents that can discover it.',
  'diagnostic.spa-shell-html-invalid.md_note_bad':
    ' Agents currently have no alternative path to content on affected pages.',
  'diagnostic.spa-shell-html-invalid.resolution':
    'Enable server-side rendering or static generation for affected page types. If only specific page templates use client-side content loading, target those templates rather than rebuilding the entire site.',
  'diagnostic.sparse-content-html.message':
    '{sparseContent} of {total} sampled pages render server-side but have unusually short body content. The HTML response contains real content (headings and visible text), just less than the threshold for a full documentation page. This is often legitimate (short reference pages, integration one-liners, glossary entries), but can also indicate a renderer that is not emitting full content. Page size scoring on the HTML path is discounted for these pages.{mdNote}',
  'diagnostic.sparse-content-html.md_note_ok':
    ' Your markdown path still works for agents that can discover it.',
  'diagnostic.sparse-content-html.md_note_bad':
    ' Agents have no alternative path on affected pages, so any missing content is invisible.',
  'diagnostic.sparse-content-html.resolution':
    'Verify the affected pages render their full content server-side. If the pages are intentionally brief, no action is needed; this is informational. If content is missing, check whether your renderer is emitting paragraphs, lists, and code blocks server-side rather than hydrating them client-side.',
  'diagnostic.no-viable-path.message':
    "Agents have no effective way to access your documentation. {llmsReason}, there is no discoverable markdown path, and the HTML responses either don't contain content or weren't tested. This is the lowest-possible agent accessibility state.",
  'diagnostic.no-viable-path.llms_missing': 'There is no llms.txt for navigation',
  'diagnostic.no-viable-path.llms_broken':
    'The llms.txt exists but only {resolveRate}% of links resolve, making it effectively unusable',
  'diagnostic.no-viable-path.resolution':
    'The single highest-impact action is creating an llms.txt at your site root with working links. If your site uses client-side rendering, enabling server-side rendering is the second priority.',
  'diagnostic.auth-no-alternative.message':
    'Your documentation requires authentication, and no alternative access paths were detected. Agents that encounter your docs will fall back on training data or seek secondary sources that may be inaccurate.',
  'diagnostic.auth-no-alternative.resolution':
    'Consider providing a public llms.txt as a navigational index, ungating API references and integration guides, or shipping docs with your SDK/package. See the spec\'s "Making Private Docs Agent-Accessible" section for options ordered by implementation effort.',
  'diagnostic.page-size-no-markdown-escape.message':
    '{failBucket} pages exceed agent truncation limits on the HTML path, and there is no discoverable markdown path for agents to get smaller representations. Agents will silently receive truncated content on these pages.',
  'diagnostic.page-size-no-markdown-escape.resolution':
    'Either reduce HTML page sizes (break large pages, reduce inline CSS/JS), or provide markdown versions and ensure agents can discover them via content negotiation or an llms.txt directive.',
  'diagnostic.single-page-sample.message':
    'Only {n} {pageWord} discovered and tested (minimum {min} needed for reliable scoring). Page-level category scores (page size, content structure, URL stability, etc.) may not represent the site. These categories are marked as N/A in the score.',
  'diagnostic.single-page-sample.page_was': 'page was',
  'diagnostic.single-page-sample.pages_were': 'pages were',
  'diagnostic.single-page-sample.resolution':
    'If your site has an llms.txt, ensure it contains working links so the tool can discover more pages. If testing a preview deployment, use --canonical-origin to rewrite cross-origin llms.txt links. You can also provide specific pages with --urls.',
  'diagnostic.cross-origin-llms-txt.message':
    'All {total} links in your llms.txt point to {dominant}, not the origin being tested. This typically happens when testing a preview or staging deployment whose llms.txt still references the production domain. Page discovery falls back to a single page.',
  'diagnostic.cross-origin-llms-txt.resolution':
    'Use --canonical-origin <production-origin> to rewrite cross-origin links during testing. For example: --canonical-origin https://docs.example.com',
  'diagnostic.gzipped-sitemap-skipped.message':
    'A gzipped sitemap was skipped during URL discovery{urlNote}. If this is the only sitemap source, it may have reduced the number of pages discovered for testing.',
  'diagnostic.gzipped-sitemap-skipped.resolution':
    'Provide an uncompressed sitemap.xml alongside the gzipped version, or supply specific pages via --urls for targeted testing.',
  'diagnostic.rate-limiting-severe.message':
    '{pct}% of tested URLs returned HTTP 429 (rate limited). Check results may be unreliable because rate-limited requests are not retried indefinitely.',
  'diagnostic.rate-limiting-severe.resolution':
    'Increase --request-delay to slow down requests, or contact the site operator to allowlist your IP or user-agent for testing.',
};
