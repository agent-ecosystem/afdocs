import type { CheckResult, CheckStatus } from '../types.js';

interface ResolutionTemplate {
  warn?: (details: Record<string, unknown>) => string;
  fail?: (details: Record<string, unknown>) => string;
}

const RESOLUTION_TEMPLATES: Record<string, ResolutionTemplate> = {
  'llms-txt-exists': {
    warn: () =>
      'Your llms.txt is only reachable via a cross-host redirect, which ' +
      "some agents don't follow. Serve llms.txt directly from the same " +
      'host as your documentation, or add a same-host redirect.',
    fail: () =>
      'Create an llms.txt file at your site root containing an H1 title, ' +
      'a blockquote summary, and markdown links to your key documentation ' +
      'pages. This is the single highest-impact improvement for agent ' +
      'access to your docs.',
  },

  'llms-txt-valid': {
    warn: () =>
      "Your llms.txt contains parseable links but doesn't follow the " +
      'standard structure. Add an H1 title as the first line and a ' +
      'blockquote summary (lines starting with >) to improve agent parsing.',
    fail: () =>
      'Your llms.txt exists but contains no parseable markdown links. Add ' +
      'links in [name](url): description format under heading-delimited ' +
      'sections.',
  },

  'llms-txt-size': {
    warn: (d) => {
      const size = formatSize(d);
      return (
        `Your llms.txt is ${size} characters, which may be truncated on ` +
        'some agent platforms. If it grows further, split into nested ' +
        'llms.txt files with a root index under 50,000 characters.'
      );
    },
    fail: (d) => {
      const size = formatSize(d);
      return (
        `Your llms.txt is ${size} characters and will be truncated by all ` +
        'major agent platforms. Split into a root index linking to ' +
        'section-level llms.txt files, each under 50,000 characters.'
      );
    },
  },

  'llms-txt-links-resolve': {
    warn: (d) => {
      const broken = (d.broken as Array<unknown>)?.length ?? 0;
      const total = (d.testedLinks as number) ?? 0;
      return (
        `${broken} of ${total} links in your llms.txt return errors. ` +
        'Audit and fix or remove broken URLs to prevent agents from ' +
        'hitting dead ends.'
      );
    },
    fail: (d) => {
      const broken = (d.broken as Array<unknown>)?.length ?? 0;
      const total = (d.testedLinks as number) ?? 0;
      return (
        `${broken} of ${total} links in your llms.txt return errors. A ` +
        'stale llms.txt with broken links is worse than no llms.txt at all ' +
        'because it sends agents down dead ends with high confidence.'
      );
    },
  },

  'llms-txt-links-markdown': {
    warn: () =>
      'Some links in your llms.txt point to HTML pages instead of markdown. ' +
      'Where possible, update links to use .md URLs so agents get clean ' +
      'markdown content directly.',
    fail: () =>
      'Your llms.txt links point to HTML pages. Update them to .md URL ' +
      'variants so agents receive markdown instead of converted HTML.',
  },

  'llms-txt-directive-html': {
    warn: () =>
      'An llms.txt directive was found in the HTML of some pages but is ' +
      'missing from others, or is buried deep in the page. Ensure the ' +
      'directive appears near the top of every documentation page.',
    fail: () =>
      'No agent-facing directive pointing to llms.txt was detected in the ' +
      'HTML of any tested page. Add a visually-hidden element near the top ' +
      'of each page (e.g., a div with CSS clip-rect) containing a link to ' +
      'your llms.txt. If your site serves markdown versions of pages, ' +
      'mention that in the directive too so agents know to request it.',
  },

  'llms-txt-directive-md': {
    warn: () =>
      'An llms.txt directive was found in the markdown of some pages but is ' +
      'missing from others, or is buried deep in the page. Ensure the ' +
      'directive appears near the top of every markdown page.',
    fail: () =>
      'No llms.txt directive was detected in the markdown of any tested ' +
      'page. Add a blockquote near the top of each markdown page (e.g., ' +
      '"> For the complete documentation index, see [llms.txt](/llms.txt)").',
  },

  'markdown-url-support': {
    warn: (d) => {
      const warnCount = countStatus(d, 'warn');
      const tested = (d.testedPages as number) ?? 0;
      return (
        `${warnCount} of ${tested} pages support .md URLs inconsistently. ` +
        'Ensure all documentation pages serve markdown when .md is appended ' +
        'to the URL.'
      );
    },
    fail: () =>
      "Your pages don't return markdown when .md is appended to the URL. " +
      'Configure your docs platform to serve .md variants for all ' +
      'documentation pages.',
  },

  'content-negotiation': {
    warn: () =>
      'Your server returns markdown content for Accept: text/markdown ' +
      'requests but with an incorrect Content-Type header. Set the response ' +
      'Content-Type to text/markdown for proper agent handling.',
    fail: () =>
      'Your server ignores Accept: text/markdown and returns HTML. Some ' +
      'agents (Claude Code, Cursor, OpenCode) request markdown this way. ' +
      'Configure your server to honor content negotiation.',
  },

  'rendering-strategy': {
    warn: (d) => {
      const warnCount = (d.sparseContent as number) ?? 0;
      const tested = (d.testedPages as number) ?? 0;
      return (
        `${warnCount} of ${tested} pages have sparse content that may rely ` +
        'on client-side JavaScript to populate. Verify that key content is ' +
        'present in the server-rendered HTML response.'
      );
    },
    fail: (d) => {
      const failCount = (d.spaShells as number) ?? 0;
      const tested = (d.testedPages as number) ?? 0;
      return (
        `${failCount} of ${tested} pages use client-side rendering. Agents ` +
        'receive an empty shell with no documentation content. Enable ' +
        'server-side rendering or pre-rendering for documentation pages.'
      );
    },
  },

  'page-size-markdown': {
    warn: (d) => {
      const warnCount = (d.warnBucket as number) ?? 0;
      const tested = (d.testedPages as number) ?? 0;
      return (
        `${warnCount} of ${tested} markdown pages are between 50K and 100K ` +
        'characters. These may be truncated on some agent platforms or ' +
        'routed through summarization. Consider splitting large pages.'
      );
    },
    fail: (d) => {
      const failCount = (d.failBucket as number) ?? 0;
      const tested = (d.testedPages as number) ?? 0;
      return (
        `${failCount} of ${tested} markdown pages exceed 100K characters ` +
        'and will be truncated by agents. Break these into smaller pages or ' +
        'restructure serialized tabbed content.'
      );
    },
  },

  'page-size-html': {
    warn: (d) => {
      const warnCount = (d.warnBucket as number) ?? 0;
      const tested = (d.testedPages as number) ?? 0;
      return (
        `${warnCount} of ${tested} pages convert to 50K-100K characters of ` +
        'markdown. Review pages for reducible boilerplate (navigation, ' +
        'serialized tabbed content). Consider providing markdown versions ' +
        'as a smaller alternative path for agents.'
      );
    },
    fail: (d) => {
      const failCount = (d.failBucket as number) ?? 0;
      const tested = (d.testedPages as number) ?? 0;
      return (
        `${failCount} of ${tested} pages convert to over 100K characters of ` +
        'markdown. Break large pages into smaller units, reduce navigation ' +
        'boilerplate, or provide markdown versions that bypass the HTML ' +
        'conversion overhead.'
      );
    },
  },

  'content-start-position': {
    warn: (d) => {
      const warnCount = (d.warnBucket as number) ?? 0;
      const tested = (d.testedPages as number) ?? 0;
      return (
        `${warnCount} of ${tested} pages have documentation content ` +
        'starting 10-50% into the converted output. Reduce navigation, ' +
        'breadcrumb, and sidebar markup that precedes the content area.'
      );
    },
    fail: (d) => {
      const failCount = (d.failBucket as number) ?? 0;
      const tested = (d.testedPages as number) ?? 0;
      return (
        `${failCount} of ${tested} pages have content starting past 50% of ` +
        'the converted output. Agents may never see the documentation ' +
        'content. Reduce navigation, breadcrumb, and sidebar markup that ' +
        'precedes the content area.'
      );
    },
  },

  'tabbed-content-serialization': {
    warn: (d) => {
      const pages = d.tabbedPages as Array<{ status?: string }> | undefined;
      const warnCount = pages?.filter((p) => p.status === 'warn').length ?? 0;
      return (
        `Tabbed content on ${warnCount} pages serializes to 50K-100K ` +
        'characters. Consider breaking tab variants into separate pages or ' +
        'providing a mechanism for agents to request specific variants.'
      );
    },
    fail: (d) => {
      const pages = d.tabbedPages as Array<{ status?: string }> | undefined;
      const failCount = pages?.filter((p) => p.status === 'fail').length ?? 0;
      return (
        `Tabbed content on ${failCount} pages serializes to over 100K ` +
        'characters. Agents see only the first few tab variants; content in ' +
        'later tabs is truncated. Break variants into separate pages.'
      );
    },
  },

  'section-header-quality': {
    warn: () =>
      '25-50% of headers in tabbed sections are generic (e.g., repeated ' +
      '"Step 1" across variants). Add variant context to headers (e.g., ' +
      '"Step 1 (Python)") so agents can distinguish sections.',
    fail: () =>
      'Over 50% of headers are generic across tab variants. When ' +
      'serialized, agents cannot tell which section belongs to which variant.',
  },

  'markdown-code-fence-validity': {
    fail: (d) => {
      const failCount = (d.unclosedCount as number) ?? 0;
      return (
        `${failCount} pages have unclosed code fences. Everything after an ` +
        'unclosed fence is interpreted as code, causing agents to misread ' +
        'documentation as literal content. Ensure every opening ``` or ~~~ ' +
        'has a matching closing delimiter.'
      );
    },
  },

  'http-status-codes': {
    fail: () =>
      'Your site returns 200 for non-existent pages (soft 404). Agents try ' +
      'to extract information from the error page content instead of ' +
      'recognizing the page is missing. Configure your server to return 404 ' +
      "for pages that don't exist.",
  },

  'redirect-behavior': {
    warn: (d) => {
      const warnCount = (d.crossHostCount as number) ?? 0;
      return (
        `${warnCount} pages use cross-host HTTP redirects, which some ` +
        "agents don't follow. Where possible, use same-host redirects or " +
        'update URLs to point directly to the final destination.'
      );
    },
    fail: (d) => {
      const failCount = (d.jsRedirectCount as number) ?? 0;
      return (
        `JavaScript-based redirects detected on ${failCount} pages. Agents ` +
        "don't execute JavaScript and will not follow these redirects. Use " +
        'HTTP 301/302 redirects instead.'
      );
    },
  },

  'llms-txt-coverage': {
    warn: (d) => {
      const missing = (d.missingCount as number) ?? 0;
      const coverage = (d.coverageRate as number) ?? 0;
      const warnThreshold = (d.coverageWarnThreshold as number) ?? 80;
      const passThreshold = (d.coveragePassThreshold as number) ?? 95;
      return (
        `Your llms.txt covers ${coverage}% of your site's pages ` +
        `(${warnThreshold}-${passThreshold}% is warn). ${missing} live ` +
        'pages are not represented in the index. Review missing pages ' +
        'and add them, or adjust --coverage-pass-threshold/' +
        '--coverage-warn-threshold if they are intentionally excluded.'
      );
    },
    fail: (d) => {
      const missing = (d.missingCount as number) ?? 0;
      const coverage = (d.coverageRate as number) ?? 0;
      const warnThreshold = (d.coverageWarnThreshold as number) ?? 80;
      return (
        `Your llms.txt covers ${coverage}% of your site's pages ` +
        `(below ${warnThreshold}% threshold). ` +
        `${missing} live pages are missing from the index. If ` +
        'unintentional, regenerate llms.txt from your sitemap or build ' +
        'pipeline. If intentional, lower the threshold or set it to 0 to ' +
        'make the check informational.'
      );
    },
  },

  'markdown-content-parity': {
    warn: (d) => {
      const warnCount = (d.warnBucket as number) ?? 0;
      return (
        `${warnCount} pages have minor content differences between their ` +
        'markdown and HTML versions. If this is intentional audience ' +
        'segmentation, adjust --parity-pass-threshold and ' +
        '--parity-warn-threshold (set both to 0 for informational mode).'
      );
    },
    fail: (d) => {
      const failCount = (d.failBucket as number) ?? 0;
      const avgMissing = (d.avgMissingPercent as number) ?? 0;
      return (
        `${failCount} pages have substantive content differences between ` +
        `markdown and HTML (avg ${Math.round(avgMissing)}% missing). ` +
        'If unintentional, agents are getting outdated content; ' +
        'regenerate markdown from source or fix the build pipeline. ' +
        'If intentional (audience segmentation), add ' +
        'data-markdown-ignore to human-only HTML elements, or adjust ' +
        'thresholds with --parity-pass-threshold/--parity-warn-threshold.'
      );
    },
  },

  'cache-header-hygiene': {
    warn: (d) => {
      const warnCount = (d.warnBucket as number) ?? 0;
      return (
        `${warnCount} endpoints have moderate cache lifetimes (1-24 hours). ` +
        'Updates to llms.txt or markdown content may take hours to ' +
        'propagate. Consider reducing cache lifetimes for these resources.'
      );
    },
    fail: (d) => {
      const failCount = (d.failBucket as number) ?? 0;
      return (
        `${failCount} endpoints have aggressive caching (>24h) or missing ` +
        'cache headers. Set max-age under 3600 or add must-revalidate with ' +
        'ETag/Last-Modified so content updates reach agents promptly.'
      );
    },
  },

  'auth-gate-detection': {
    warn: () =>
      'Some documentation pages require authentication while others are ' +
      'public. Agents can access public pages but will fall back on ' +
      'training data for gated content. Consider ungating reference docs ' +
      'and API guides.',
    fail: () =>
      'All or most documentation pages require authentication. Agents ' +
      'cannot access your documentation and will rely on potentially ' +
      'outdated training data or secondary sources. Consider providing ' +
      'alternative access paths (see auth-alternative-access check).',
  },

  'bot-protection-interference': {
    warn: () =>
      'Some requests during a sustained scan were challenged, stalled, or ' +
      'blocked while others succeeded. Identify which bot-management layer ' +
      '(CDN bot management, WAF, behavioral rate enforcement) is doing this ' +
      'and exempt public documentation routes from behavioral enforcement. ' +
      'Intermittent interference means enforcement thresholds sit close to ' +
      'normal agent reading cadence, so small configuration changes or ' +
      'ordinary traffic growth can tip it into sustained blocking.',
    fail: () =>
      'Sustained automated fetching is effectively blocked. Treat public ' +
      'documentation paths as automation-friendly in your bot-management ' +
      'configuration: exempt docs routes from behavioral enforcement, or ' +
      'scope enforcement to interactive product surfaces. Where limits are ' +
      'genuinely needed, prefer an explicit 429 with Retry-After over ' +
      'tarpits or silent blocks, and never serve challenge interstitials ' +
      'with a 200 status.',
  },

  'auth-alternative-access': {
    warn: () =>
      'Partial alternative access detected for auth-gated content (e.g., ' +
      'public llms.txt covers some but not all gated pages). Expand ' +
      'alternative access to cover more of the gated documentation.',
    fail: () =>
      'No alternative access paths detected for auth-gated content. ' +
      'Consider providing a public llms.txt, ungating reference docs, ' +
      'shipping docs with your SDK, or providing an MCP server for ' +
      'authenticated access.',
  },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatSize(d: Record<string, unknown>): string {
  const sizes = d.sizes as Array<{ characters?: number }> | undefined;
  if (sizes && sizes.length > 0) {
    const maxSize = Math.max(...sizes.map((s) => s.characters ?? 0));
    return maxSize.toLocaleString();
  }
  return 'unknown';
}

function countStatus(d: Record<string, unknown>, status: CheckStatus): number {
  const pageResults = d.pageResults as Array<{ status?: string }> | undefined;
  if (!pageResults) return 0;
  return pageResults.filter((p) => p.status === status).length;
}

/**
 * Get resolution text for a check result, or undefined if none applies.
 */
export function getResolution(result: CheckResult): string | undefined {
  if (result.status !== 'warn' && result.status !== 'fail') return undefined;

  const template = RESOLUTION_TEMPLATES[result.id];
  if (!template) return undefined;

  const fn = result.status === 'warn' ? template.warn : template.fail;
  if (!fn) return undefined;

  return fn(result.details ?? {});
}
