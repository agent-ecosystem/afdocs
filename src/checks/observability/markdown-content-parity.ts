import { parse } from 'node-html-parser';
import { registerCheck } from '../registry.js';
import { fetchPage } from '../../helpers/fetch-page.js';
import { toHtmlUrl } from '../../helpers/to-md-urls.js';
import { DEFAULT_PARITY_PASS_THRESHOLD, DEFAULT_PARITY_WARN_THRESHOLD } from '../../constants.js';
import type { CheckContext, CheckResult, CheckStatus } from '../../types.js';

/** Minimum character length for a text segment to be considered meaningful. */
const MIN_SEGMENT_LENGTH = 20;

/**
 * Minimum number of unique HTML segments required for a meaningful comparison.
 * Pages below this threshold auto-pass because the percentage is too volatile
 * (e.g., 3 breadcrumb items on a 10-segment page = 30% "missing").
 */
const MIN_SEGMENTS_FOR_COMPARISON = 10;

/** HTML tags to strip before extracting text (non-content chrome). */
const STRIP_TAGS = [
  'script',
  'style',
  'nav',
  'footer',
  'header',
  'noscript',
  'button',
  'svg',
  'aside',
  'select',
  'input',
  'textarea',
];

/**
 * Tags that were removed at the DOM level (STRIP_TAGS). If these tag names
 * appear in `.text` output, they came from entity-decoded content (e.g.,
 * `&lt;nav&gt;` → `<nav>` in prose discussing HTML elements), not from
 * actual DOM elements. The text-level tag stripping regex should keep their
 * content rather than deleting it, so both sides produce matching text
 * after normalize() strips the angle brackets.
 */
const DOM_STRIPPED_TAGS = new Set(STRIP_TAGS);

/** CSS selectors for common doc-site chrome that lives inside <main>. */
const STRIP_SELECTORS = [
  '[aria-label="breadcrumb"]',
  '[aria-label="pagination"]',
  '[class*="breadcrumb"]',
  '[class*="pagination"]',
  '[class*="prev-next"]',
  '[class*="prevnext"]',
  '[class*="page-nav"]',
  '[class*="feedback"]',
  '[class*="helpful"]',
  '[class*="table-of-contents"]',
  '[class*="toc"]',
  '[rel="prev"]',
  '[rel="next"]',
  '.sr-only',
  '[aria-label="Anchor"]',
];

/**
 * Segment-level patterns for common non-content text that survives DOM stripping.
 * Matched against normalized (lowercased, whitespace-collapsed) segments.
 */
const NOISE_PATTERNS = [
  /^last updated/,
  /^was this page helpful/,
  /^thank you for your feedback/,
  /^previous\s+\S.*next\s+\S/, // "Previous X Next Y" pagination
  /^start from the beginning$/,
  /^join our .* server/, // "Join our Discord Server..."
  /^loading video content/,
  /^\/.+\/.+/, // breadcrumb paths like "/Connect to Neon/..."
  /^for ai agents:/, // llms.txt directive banner text
];

interface PageParityResult {
  url: string;
  markdownSource: string;
  status: CheckStatus;
  /** Percentage of HTML text segments not found in the markdown version. */
  missingPercent: number;
  /** Total meaningful text segments extracted from HTML. */
  totalSegments: number;
  /** Number of HTML segments not found in the markdown. */
  missingSegments: number;
  /** Sample of missing segments for diagnostics. */
  sampleDiffs: string[];
  error?: string;
}

/**
 * Known HTML tag names used to distinguish real tags from angle-bracket
 * placeholders like <YOUR_API_KEY> or <clusterName> in code examples.
 * Only needs to cover tags that appear in node-html-parser's .text output
 * (i.e., tags inside <pre> that survive as raw text).
 */
const HTML_TAG_NAMES = new Set([
  'a',
  'abbr',
  'address',
  'article',
  'aside',
  'audio',
  'b',
  'bdi',
  'bdo',
  'blockquote',
  'body',
  'br',
  'button',
  'canvas',
  'caption',
  'cite',
  'code',
  'col',
  'colgroup',
  'data',
  'dd',
  'del',
  'details',
  'dfn',
  'dialog',
  'div',
  'dl',
  'dt',
  'em',
  'embed',
  'fieldset',
  'figcaption',
  'figure',
  'footer',
  'form',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'head',
  'header',
  'hr',
  'html',
  'i',
  'iframe',
  'img',
  'input',
  'ins',
  'kbd',
  'label',
  'legend',
  'li',
  'link',
  'main',
  'map',
  'mark',
  'meta',
  'meter',
  'nav',
  'noscript',
  'object',
  'ol',
  'optgroup',
  'option',
  'output',
  'p',
  'param',
  'picture',
  'pre',
  'progress',
  'q',
  'rp',
  'rt',
  'ruby',
  's',
  'samp',
  'script',
  'section',
  'select',
  'slot',
  'small',
  'source',
  'span',
  'strong',
  'style',
  'sub',
  'summary',
  'sup',
  'table',
  'tbody',
  'td',
  'template',
  'textarea',
  'tfoot',
  'th',
  'thead',
  'time',
  'title',
  'tr',
  'track',
  'u',
  'ul',
  'var',
  'video',
  'wbr',
]);

/** Block-level HTML elements that should produce line breaks in extracted text. */
const BLOCK_TAGS = new Set([
  'p',
  'div',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'li',
  'tr',
  'td',
  'th',
  'blockquote',
  'pre',
  'dt',
  'dd',
  'figcaption',
  'section',
  'article',
  'details',
  'summary',
  'br',
  'hr',
]);

/**
 * Minimum link density (0–1) and minimum link count for an element to be
 * classified as navigation chrome. Navigation panels are structurally
 * distinguishable from content: they consist almost entirely of links with
 * very little non-link text between them. Content sections, even link-heavy
 * ones like "Related resources", include enough description text to stay
 * well below this threshold.
 */
const NAV_LINK_DENSITY_THRESHOLD = 0.7;
const NAV_MIN_LINK_COUNT = 10;

/**
 * Extract plain text from HTML, stripping chrome elements.
 * Inserts newlines between block-level elements so that paragraphs,
 * list items, etc. become separate lines in the output.
 */
/**
 * Heuristic selectors for content containers, tried in order when
 * <main> and <article> are not present. Common across doc platforms
 * like Mintlify, ReadMe, Docusaurus/Starlight, and custom sites.
 */
const CONTENT_SELECTORS = [
  '[role="main"]',
  '#content',
  '.sl-markdown-content',
  '.markdown-content',
  '.markdown-body',
  '.docs-content',
  '.doc-content',
  '.main-pane',
  '.page-content',
  '.prose',
];

interface HtmlExtractionResult {
  text: string;
  segmentationStripped: number;
}

function extractHtmlText(html: string, parityExclusions?: string[]): HtmlExtractionResult {
  const root = parse(html);

  // Prefer the tightest content container available.
  // Priority: heuristic selector inside article/main > article inside main
  // > article > heuristic selector inside main > main > heuristic on root > body
  const main = root.querySelector('main');
  const article = main?.querySelector('article') ?? root.querySelector('article');
  let content: ReturnType<typeof root.querySelector> = null;

  // Look for a heuristic content selector inside the best semantic container
  const semanticContainer = article ?? main;
  if (semanticContainer) {
    for (const selector of CONTENT_SELECTORS) {
      content = semanticContainer.querySelector(selector);
      if (content) break;
    }
  }
  // Fall back to the semantic container itself
  if (!content) content = semanticContainer;

  // If no semantic container, try heuristic selectors on the root
  if (!content) {
    for (const selector of CONTENT_SELECTORS) {
      content = root.querySelector(selector);
      if (content) break;
    }
  }

  if (!content) content = root.querySelector('body');
  if (!content) return { text: root.text, segmentationStripped: 0 };

  // Strip audience-segmentation elements before comparison.
  // data-markdown-ignore marks content intended only for human readers;
  // it is expected to be absent from the markdown version.
  let segmentationStripped = 0;
  for (const el of content.querySelectorAll('[data-markdown-ignore]')) {
    el.remove();
    segmentationStripped++;
  }

  // Strip user-provided CSS selectors (additional platform conventions)
  if (parityExclusions?.length) {
    for (const selector of parityExclusions) {
      try {
        for (const el of content.querySelectorAll(selector)) {
          el.remove();
        }
      } catch {
        throw new Error(
          `Invalid CSS selector in parityExclusions: "${selector}". ` +
            'If the selector contains [ or ], wrap it in quotes in your YAML config.',
        );
      }
    }
  }

  // Remove non-content elements by tag
  for (const tag of STRIP_TAGS) {
    for (const el of content.querySelectorAll(tag)) {
      el.remove();
    }
  }

  // Remove common doc-site chrome by CSS selector
  for (const selector of STRIP_SELECTORS) {
    for (const el of content.querySelectorAll(selector)) {
      el.remove();
    }
  }

  // Remove elements that look like navigation based on link density.
  // Navigation panels (sidebars, header menus) are structurally distinct
  // from content: they consist almost entirely of links. This catches
  // nav-like elements that use <div> instead of <nav>/<aside>.
  for (const el of content.querySelectorAll('*')) {
    const text = el.text || '';
    if (text.length < 100) continue;
    const links = el.querySelectorAll('a');
    if (links.length < NAV_MIN_LINK_COUNT) continue;
    const linkTextLen = links.reduce((sum, a) => sum + (a.text?.length || 0), 0);
    if (linkTextLen / text.length > NAV_LINK_DENSITY_THRESHOLD) {
      el.remove();
    }
  }

  // Insert newlines before block-level elements so .text produces
  // separated lines instead of smashing paragraphs together
  for (const tag of BLOCK_TAGS) {
    for (const el of content.querySelectorAll(tag)) {
      el.insertAdjacentHTML('beforebegin', '\n');
      el.insertAdjacentHTML('afterend', '\n');
    }
  }

  // node-html-parser treats <pre> content as raw text, so <style> tags
  // injected inside code blocks (e.g., Emotion CSS-in-JS / Leafygreen)
  // survive DOM-level stripping. Remove <style>...</style> blocks first,
  // inject newlines before <div tags to separate code lines (e.g.,
  // Expressive Code / Shiki use <div class="ec-line"> inside <pre>),
  // then strip HTML tags while preserving angle-bracket placeholders
  // like <YOUR_API_KEY> or <clusterName> (decoded from &lt;...&gt; entities).
  const text = content.text
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<div[\s>]/gi, '\n<div ')
    .replace(/<\/[^>\s]+>/g, '')
    .replace(/<([a-zA-Z][a-zA-Z0-9-]*)([^>]*)>/g, (_match, tag, rest) => {
      const lower = tag.toLowerCase();
      if (DOM_STRIPPED_TAGS.has(lower)) return tag;
      if (HTML_TAG_NAMES.has(lower)) return '';
      return tag + rest;
    });
  return { text, segmentationStripped };
}

/**
 * Extract plain text from markdown by stripping all formatting.
 *
 * Code content (both fenced blocks and inline spans) is protected from
 * stripping via placeholders. Without this, content like `# Heading` or
 * `[link](url)` inside code blocks/spans would have its markdown syntax
 * stripped (headings, links, blockquotes, emphasis), while the HTML side
 * preserves the literal text inside <pre><code> and <code> tags. The
 * placeholder approach hides code content from the stripping regexes,
 * then restores it after all stripping is done.
 */
function extractMarkdownText(markdown: string): string {
  let text = markdown;

  // Step 1: Protect fenced code block content from subsequent stripping.
  // Replace entire fenced blocks (``` ... ```) with placeholders so
  // heading/link/emphasis/blockquote regexes don't modify literal content
  // that the HTML side preserves as-is inside <pre><code> tags.
  //
  // Per CommonMark §4.5, a fence opens with N>=3 backticks and closes only
  // on a run of >=N. Capture the opener so the close-side backreference
  // matches; otherwise nested example fences (4-backtick outer, 3-backtick
  // inner) get mis-paired and inner markers leak out as text.
  const codeBlocks: string[] = [];
  text = text.replace(/^(`{3,})[^`\n]*\n([\s\S]*?)^\1`*\s*$/gm, (_match, _opener, content) => {
    const idx = codeBlocks.length;
    codeBlocks.push(content);
    return `\x00BLOCK${idx}\x00`;
  });

  // Step 2: Protect inline code spans from subsequent stripping.
  // Replace `...` with placeholders so link/emphasis regexes don't
  // modify literal content that the HTML side preserves as-is.
  //
  // Multi-backtick spans (`` `...` ``, ``` ``...`` ```, etc.) must be
  // processed before single-backtick spans. CommonMark allows using N
  // backticks as delimiters to include literal backticks in code spans.
  // If single-backtick matching runs first, it misparses the delimiters
  // and pairs stray backticks with distant ones, swallowing large chunks
  // of surrounding text into protected placeholders. This prevents
  // bullet/emphasis stripping from running on those lines.
  //
  // Per CommonMark, a backtick string is a run of backticks NOT preceded
  // or followed by another backtick. The lookbehind/lookahead assertions
  // enforce this so that `` inside ``` isn't treated as a valid delimiter.
  const codeSpans: string[] = [];
  text = text.replace(/(?<!`)``(?!`)([\s\S]*?)(?<!`)``(?!`)/g, (_match, content) => {
    const idx = codeSpans.length;
    // CommonMark space stripping: if content starts and ends with a space
    // and isn't entirely spaces, strip one space from each end. This matches
    // what HTML rendering produces (browsers show the trimmed content).
    let trimmed = content;
    if (trimmed.startsWith(' ') && trimmed.endsWith(' ') && trimmed.trim().length > 0) {
      trimmed = trimmed.slice(1, -1);
    }
    codeSpans.push(trimmed);
    return `\x00CODE${idx}\x00`;
  });
  // Single-backtick spans: content may include backtick runs of length != 1
  // (e.g. ` ``` ` where the triple backtick is content, not a closer).
  // Both opening and closing delimiters require (?<!`) and (?!`) to ensure
  // they are standalone single backticks, not part of a multi-backtick run.
  // This prevents bare ``` in prose from cascading into distant backtick pairing.
  text = text.replace(/(?<!`)`(?!`)((?:[^`]|`{2,})+)(?<!`)`(?!`)/g, (_match, content) => {
    const idx = codeSpans.length;
    let trimmed = content;
    if (trimmed.startsWith(' ') && trimmed.endsWith(' ') && trimmed.trim().length > 0) {
      trimmed = trimmed.slice(1, -1);
    }
    codeSpans.push(trimmed);
    return `\x00CODE${idx}\x00`;
  });

  // Step 3: Strip markdown formatting on non-code text
  text = text
    // Remove heading markers
    .replace(/^#{1,6}\s+/gm, '')
    // Remove setext-style heading underlines
    .replace(/^[=-]+$/gm, '')
    // Remove link/image URLs, keep text: [text](url) → text
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    // Remove reference-style link definitions
    .replace(/^\[.*?\]:\s+.*$/gm, '')
    // Remove list bullets/numbers (before emphasis, so leading * isn't
    // misinterpreted as an emphasis marker)
    .replace(/^[\s]*[-*+]\s+/gm, '')
    .replace(/^[\s]*\d+\.\s+/gm, '')
    // Remove emphasis markers. * emphasis is stripped unconditionally.
    // _ emphasis is stripped only at word boundaries (per CommonMark,
    // _text_ is emphasis only when _ is not adjacent to an alphanumeric).
    // This preserves code identifiers like mongoc_client_get_database
    // that appear as plain text (not inside backticks).
    .replace(/(\*{1,3})(.*?)\1/g, '$2')
    .replace(/(?<!\w)(_{1,3})(.*?)\1(?!\w)/g, '$2')
    // Remove blockquote markers
    .replace(/^>\s?/gm, '')
    // Remove horizontal rules
    .replace(/^[-*_]{3,}$/gm, '');

  // Step 4: Restore code content (without backticks/fence markers)
  // eslint-disable-next-line no-control-regex
  text = text.replace(/\x00CODE(\d+)\x00/g, (_match, idxStr) => codeSpans[parseInt(idxStr, 10)]);
  // eslint-disable-next-line no-control-regex
  text = text.replace(/\x00BLOCK(\d+)\x00/g, (_match, idxStr) => codeBlocks[parseInt(idxStr, 10)]);

  return text;
}

/**
 * Normalize text for fuzzy containment matching:
 * strip zero-width characters, normalize typographic quotes,
 * strip angle brackets around placeholders, collapse whitespace, and lowercase.
 */
function normalize(text: string): string {
  return (
    text
      .replace(/\u200B/g, '')
      .replace(/\u200C/g, '')
      .replace(/\u200D/g, '')
      .replace(/\uFEFF/g, '')
      .replace(/[\u2018\u2019\u201A]/g, "'")
      .replace(/[\u201C\u201D\u201E]/g, '"')
      .replace(/[\u2013\u2014]/g, '-')
      .replace(/\u2026/g, '...')
      // Strip angle brackets but keep content — normalizes <YOUR_API_KEY> to
      // YOUR_API_KEY so HTML-side (entities decoded, tags stripped) and
      // markdown-side (raw angle brackets) produce the same text.
      // Uses [^>\n] to prevent cross-line matching: a stray '<' (e.g.,
      // '< 5,000 tokens') must not match a '>' hundreds of lines later,
      // which would distort the normalized text and break containment checks.
      .replace(/<([^>\n]+)>/g, '$1')
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .trim()
  );
}

/**
 * Check if a normalized segment matches any common noise pattern.
 */
function isNoiseSegment(normalized: string): boolean {
  return NOISE_PATTERNS.some((pattern) => pattern.test(normalized));
}

/**
 * Split text into meaningful segments: non-empty lines of at least
 * MIN_SEGMENT_LENGTH characters, trimmed, with common noise filtered out.
 */
function toSegments(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length >= MIN_SEGMENT_LENGTH)
    .filter((line) => !isNoiseSegment(line.toLowerCase()));
}

/**
 * Check what fraction of HTML segments can be found in the markdown text.
 * Uses normalized substring containment rather than positional diffing,
 * so reordering and formatting differences don't cause false positives.
 */
function computeParity(
  htmlText: string,
  markdownText: string,
  warnThreshold: number,
  failThreshold: number,
): Omit<PageParityResult, 'url' | 'markdownSource' | 'error'> {
  // Deduplicate segments so repeated chrome (breadcrumbs, nav titles) or
  // repeated content is only counted once when checking for presence.
  const allSegments = toSegments(htmlText);
  const seen = new Set<string>();
  const htmlSegments: string[] = [];
  for (const seg of allSegments) {
    const key = normalize(seg);
    if (!seen.has(key)) {
      seen.add(key);
      htmlSegments.push(seg);
    }
  }

  if (htmlSegments.length === 0) {
    return {
      status: 'pass',
      missingPercent: 0,
      totalSegments: 0,
      missingSegments: 0,
      sampleDiffs: [],
    };
  }

  // Pages with very few segments produce volatile percentages (a couple of
  // breadcrumb items on a 7-segment page = 30%+). Auto-pass these.
  if (htmlSegments.length < MIN_SEGMENTS_FOR_COMPARISON) {
    return {
      status: 'pass',
      missingPercent: 0,
      totalSegments: htmlSegments.length,
      missingSegments: 0,
      sampleDiffs: [],
    };
  }

  const normalizedMd = normalize(extractMarkdownText(markdownText));
  const sampleDiffs: string[] = [];
  let missingCount = 0;

  for (const segment of htmlSegments) {
    const normalizedSegment = normalize(segment);
    if (!normalizedMd.includes(normalizedSegment)) {
      missingCount++;
      if (sampleDiffs.length < 5) {
        sampleDiffs.push(`- ${segment}`);
      }
    }
  }

  const missingPercent =
    htmlSegments.length > 0 ? Math.round((missingCount / htmlSegments.length) * 100) : 0;

  // A threshold of 0 means "disabled" (informational mode per spec).
  // This naturally falls out: `0 > 0` is false, so the guard prevents
  // the threshold from firing, and the check passes.
  const shouldFail = failThreshold > 0 && missingPercent >= failThreshold;
  const shouldWarn = warnThreshold > 0 && missingPercent >= warnThreshold;
  let status: CheckStatus;
  if (shouldFail) {
    status = 'fail';
  } else if (shouldWarn) {
    status = 'warn';
  } else {
    status = 'pass';
  }

  return {
    status,
    missingPercent,
    totalSegments: htmlSegments.length,
    missingSegments: missingCount,
    sampleDiffs,
  };
}

function worstStatus(statuses: CheckStatus[]): CheckStatus {
  if (statuses.includes('fail')) return 'fail';
  if (statuses.includes('warn')) return 'warn';
  return 'pass';
}

async function check(ctx: CheckContext): Promise<CheckResult> {
  const id = 'markdown-content-parity';
  const category = 'observability';

  // Collect pages that have cached markdown from upstream checks
  const pagesToCompare: Array<{
    url: string;
    markdownContent: string;
    markdownSource: string;
  }> = [];

  for (const [url, cached] of ctx.pageCache) {
    if (cached.markdown?.content) {
      pagesToCompare.push({
        url,
        markdownContent: cached.markdown.content,
        markdownSource: cached.markdown.source,
      });
    }
  }

  if (pagesToCompare.length === 0) {
    return {
      id,
      category,
      status: 'skip',
      message: 'No pages with markdown versions available to compare',
    };
  }

  const warnThreshold = ctx.options.parityPassThreshold ?? DEFAULT_PARITY_PASS_THRESHOLD;
  const failThreshold = ctx.options.parityWarnThreshold ?? DEFAULT_PARITY_WARN_THRESHOLD;
  const parityExclusions = ctx.options.parityExclusions;

  const results: PageParityResult[] = [];
  const concurrency = ctx.options.maxConcurrency;
  let totalSegmentationStripped = 0;

  for (let i = 0; i < pagesToCompare.length; i += concurrency) {
    const batch = pagesToCompare.slice(i, i + concurrency);
    const batchResults = await Promise.all(
      batch.map(async ({ url, markdownContent, markdownSource }): Promise<PageParityResult> => {
        try {
          // Fetch the HTML version of the page
          const htmlUrl = toHtmlUrl(url);
          const page = await fetchPage(ctx, htmlUrl);

          if (page.status >= 400) {
            // HTML URL returned an error (e.g., 404) — skip this page
            return {
              url,
              markdownSource,
              status: 'pass',
              missingPercent: 0,
              totalSegments: 0,
              missingSegments: 0,
              sampleDiffs: [],
              error: `HTML page returned ${page.status}`,
            };
          }

          if (!page.isHtml) {
            // The "HTML" version is already markdown/plain text — no meaningful comparison
            return {
              url,
              markdownSource,
              status: 'pass',
              missingPercent: 0,
              totalSegments: 0,
              missingSegments: 0,
              sampleDiffs: [],
            };
          }

          const { text: htmlText, segmentationStripped } = extractHtmlText(
            page.body,
            parityExclusions,
          );
          totalSegmentationStripped += segmentationStripped;
          const parity = computeParity(htmlText, markdownContent, warnThreshold, failThreshold);

          return { url, markdownSource, ...parity };
        } catch (err) {
          return {
            url,
            markdownSource,
            status: 'fail',
            missingPercent: 100,
            totalSegments: 0,
            missingSegments: 0,
            sampleDiffs: [],
            error: err instanceof Error ? err.message : String(err),
          };
        }
      }),
    );
    results.push(...batchResults);
  }

  const successful = results.filter((r) => !r.error);
  const fetchErrors = results.filter((r) => r.error).length;

  if (successful.length === 0) {
    return {
      id,
      category,
      status: 'fail',
      message: `Could not fetch HTML for any pages to compare${fetchErrors > 0 ? `; ${fetchErrors} failed to fetch` : ''}`,
      details: {
        pagesCompared: 0,
        fetchErrors,
        pageResults: results,
      },
    };
  }

  const overallStatus = worstStatus(successful.map((r) => r.status));
  const passBucket = successful.filter((r) => r.status === 'pass').length;
  const warnBucket = successful.filter((r) => r.status === 'warn').length;
  const failBucket = successful.filter((r) => r.status === 'fail').length;
  const avgMissingPercent =
    successful.length > 0
      ? Math.round(successful.reduce((sum, r) => sum + r.missingPercent, 0) / successful.length)
      : 0;
  const suffix = fetchErrors > 0 ? `; ${fetchErrors} failed to fetch` : '';

  let message: string;
  if (overallStatus === 'pass') {
    message = `All ${successful.length} pages have equivalent markdown and HTML content (avg ${avgMissingPercent}% missing)${suffix}`;
  } else if (overallStatus === 'warn') {
    message = `${warnBucket} of ${successful.length} pages have minor content differences between markdown and HTML${suffix}`;
  } else {
    message = `${failBucket} of ${successful.length} pages have substantive content differences between markdown and HTML (avg ${avgMissingPercent}% missing)${suffix}`;
  }

  return {
    id,
    category,
    status: overallStatus,
    message,
    details: {
      pagesCompared: successful.length,
      passBucket,
      warnBucket,
      failBucket,
      fetchErrors,
      avgMissingPercent,
      ...(totalSegmentationStripped > 0 && {
        segmentationElementsStripped: totalSegmentationStripped,
      }),
      ...(ctx.options.parityPassThreshold != null && {
        parityPassThreshold: warnThreshold,
      }),
      ...(ctx.options.parityWarnThreshold != null && {
        parityWarnThreshold: failThreshold,
      }),
      pageResults: results,
    },
  };
}

registerCheck({
  id: 'markdown-content-parity',
  category: 'observability',
  description: 'Whether markdown and HTML versions contain equivalent content',
  dependsOn: [['markdown-url-support', 'content-negotiation']],
  run: check,
});
