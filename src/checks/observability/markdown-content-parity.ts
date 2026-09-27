import { parse, NodeType, type HTMLElement, type Node } from 'node-html-parser';
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
 * Tag names corresponding to STRIP_TAGS, used by the DOM walker to skip
 * these elements if they reappear inside re-parsed <pre> content (e.g.,
 * a stray <style> block injected by a CSS-in-JS library).
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

/**
 * Item-count comparison for pages with repeated structure (catalogs, model
 * listings, compatibility matrices). Informational: it never changes the
 * page's status. The spec's parity notes ask implementations to compare item
 * counts between representations and to name the likely cause when they
 * differ, because each cause has a different owner and fix.
 */
export interface ItemCounts {
  /** Which repeated structure was compared: the one with more items. */
  structure: 'list' | 'table';
  /** Items in the HTML content container (list items or table data rows). */
  html: number;
  /** Items in the markdown (list-item lines or pipe-table data rows). */
  markdown: number;
  /** Distinct markdown items; the comparison uses this when entries repeat. */
  markdownUnique: number;
  /** Markdown entries that repeat an earlier entry verbatim. */
  duplicates: number;
  /** True when the counts differ by more than the tolerance. */
  diverges: boolean;
  /**
   * Best guess at why the counts differ, when they do:
   * - `default-filter`: the markdown lists more than the HTML shows, the
   *   signature of a dynamic view applying a default filter that the dump
   *   does not (the spec's observed case: 98 shown, 102 listed).
   * - `pagination`: the markdown lists fewer and `single-fetch-completeness`
   *   found the page paginated (windowing).
   * - `staleness`: the markdown lists fewer with no pagination in sight,
   *   most often one representation generated from older data.
   */
  likelyCause?: 'default-filter' | 'pagination' | 'staleness';
}

/** Items in the larger structure before an item-count comparison is meaningful. */
const MIN_REPEATED_ITEMS = 20;

/**
 * Items the smaller side must have for the comparison to be trusted. One
 * side at zero while the other lists a catalog is an extraction artifact
 * (a pure-link list stripped as navigation, a table rendered client-side),
 * not a filter, and is reported without a cause.
 */
const MIN_ITEMS_EACH_SIDE = 5;

/**
 * Difference that counts as divergence: more than one item, and more than
 * 2% of the larger count. The spec's observed case (98 shown, 102 listed)
 * is a 4% difference of real items; a one-item difference is noise.
 */
const ITEM_COUNT_TOLERANCE = 0.02;

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
  /** Present when the page has repeated structure on either side. */
  itemCounts?: ItemCounts;
  error?: string;
}

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

interface HtmlItemCounts {
  listItems: number;
  tableRows: number;
}

interface HtmlExtractionResult {
  text: string;
  segmentationStripped: number;
  items: HtmlItemCounts;
}

/**
 * Size of the largest repeated structure in the content container after
 * chrome is stripped: the list with the most direct items, and the table
 * with the most data rows (header rows excluded). The largest structure,
 * not the sum, so a "Related" list or a small options table next to a
 * catalog does not shift the count.
 */
function countHtmlItems(content: HTMLElement): HtmlItemCounts {
  let listItems = 0;
  for (const list of content.querySelectorAll('ul, ol')) {
    const direct = list.childNodes.filter(
      (n) =>
        n.nodeType === NodeType.ELEMENT_NODE && (n as HTMLElement).tagName?.toLowerCase() === 'li',
    ).length;
    if (direct > listItems) listItems = direct;
  }
  let tableRows = 0;
  for (const table of content.querySelectorAll('table')) {
    let rows = 0;
    for (const tr of table.querySelectorAll('tr')) {
      if (tr.closest('thead')) continue;
      const cells = tr.querySelectorAll('td, th');
      if (cells.length > 0 && cells.every((c) => c.tagName?.toLowerCase() === 'th')) continue;
      rows++;
    }
    if (rows > tableRows) tableRows = rows;
  }
  return { listItems, tableRows };
}

interface MarkdownItemCounts {
  /** Items in the largest contiguous list. */
  listItems: number;
  /** Distinct items in that list. */
  uniqueListItems: number;
  /** List entries anywhere in the document that repeat an earlier entry verbatim. */
  duplicateListItems: number;
  /** Data rows in the largest pipe table. */
  tableRows: number;
}

const MD_FENCE = /^\s*(`{3,}|~{3,})/;
const MD_LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/;
const MD_TABLE_DELIMITER = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/;

/**
 * Measure the largest contiguous list (blank lines between items allowed,
 * any other line ends it) and the largest pipe table in markdown, outside
 * fenced code. List entries are also deduplicated by normalized text across
 * the whole document, so a generator that emits every entry twice shows up
 * as duplicates rather than as twice the catalog.
 */
function countMarkdownItems(markdown: string): MarkdownItemCounts {
  const lines = markdown.split('\n');
  let inFence: string | null = null;
  let listItems = 0;
  let uniqueListItems = 0;
  let tableRows = 0;
  let totalListItems = 0;
  const seenAnywhere = new Set<string>();
  let block: string[] = [];

  const closeBlock = () => {
    if (block.length > listItems) {
      listItems = block.length;
      uniqueListItems = new Set(block).size;
    }
    block = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = MD_FENCE.exec(line);
    if (fence) {
      closeBlock();
      if (inFence === null) inFence = fence[1][0];
      else if (fence[1][0] === inFence && line.trim() === fence[1]) inFence = null;
      continue;
    }
    if (inFence !== null) continue;
    const item = MD_LIST_ITEM.exec(line);
    if (item) {
      const key = normalize(item[1]);
      block.push(key);
      totalListItems++;
      seenAnywhere.add(key);
      continue;
    }
    if (line.trim() === '') continue;
    closeBlock();
    if (line.includes('|') && i + 1 < lines.length && MD_TABLE_DELIMITER.test(lines[i + 1])) {
      let j = i + 2;
      while (j < lines.length && lines[j].trim() !== '' && lines[j].includes('|')) j++;
      const rows = j - (i + 2);
      if (rows > tableRows) tableRows = rows;
      i = j - 1;
    }
  }
  closeBlock();
  return {
    listItems,
    uniqueListItems,
    duplicateListItems: totalListItems - seenAnywhere.size,
    tableRows,
  };
}

/**
 * Compare item counts between representations when either side has enough
 * repeated structure to make the comparison meaningful.
 */
function compareItemCounts(
  html: HtmlItemCounts,
  md: MarkdownItemCounts,
  paginated: boolean,
): ItemCounts | undefined {
  const listMax = Math.max(html.listItems, md.listItems);
  const tableMax = Math.max(html.tableRows, md.tableRows);
  if (listMax < MIN_REPEATED_ITEMS && tableMax < MIN_REPEATED_ITEMS) return undefined;

  const structure: ItemCounts['structure'] = listMax >= tableMax ? 'list' : 'table';
  const htmlCount = structure === 'list' ? html.listItems : html.tableRows;
  const mdCount = structure === 'list' ? md.listItems : md.tableRows;
  const mdUnique = structure === 'list' ? md.uniqueListItems : md.tableRows;
  const duplicates = structure === 'list' ? md.duplicateListItems : 0;

  // Compare against distinct entries: a duplicated catalog is not a bigger one.
  const compared = mdUnique;
  const larger = Math.max(htmlCount, compared);
  const trusted = Math.min(htmlCount, compared) >= MIN_ITEMS_EACH_SIDE;
  const diverges =
    trusted && Math.abs(htmlCount - compared) > Math.max(1, larger * ITEM_COUNT_TOLERANCE);

  let likelyCause: ItemCounts['likelyCause'];
  if (diverges) {
    if (compared > htmlCount) likelyCause = 'default-filter';
    else if (paginated) likelyCause = 'pagination';
    else likelyCause = 'staleness';
  }

  return {
    structure,
    html: htmlCount,
    markdown: mdCount,
    markdownUnique: mdUnique,
    duplicates,
    diverges,
    ...(likelyCause && { likelyCause }),
  };
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
  if (!content) {
    return { text: root.text, segmentationStripped: 0, items: { listItems: 0, tableRows: 0 } };
  }

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

  // Walk the DOM to produce text. Doing this ourselves (instead of relying
  // on .text) lets us handle two cases that flat-text + regex stripping
  // can't disambiguate:
  //
  // 1. node-html-parser treats <pre> content as a single raw-text node, so
  //    syntax-highlighter markup inside (<span class="kw">, <div class="line">,
  //    <code class="lang-js">) appears as literal text. We re-parse that
  //    rawText as HTML and walk the resulting subtree, which yields just the
  //    code's textContent without any markup leaking through.
  //
  // 2. Inline `<code>` mentions in prose (rendered as <code>&lt;code&gt;</code>
  //    from a `\`<code>\`` markdown span) decode to literal `<code>` text. The
  //    DOM walk preserves that as text; normalize() then strips the angle
  //    brackets so it matches the markdown side. Previously the text-level
  //    tag-stripping regex deleted these as if they were tags.
  const text = walkContent(content);
  return { text, segmentationStripped, items: countHtmlItems(content) };
}

/**
 * Walk a DOM subtree and emit text content with newlines around block
 * elements. Used by extractHtmlText.
 */
function walkContent(node: HTMLElement): string {
  let out = '';
  for (const child of node.childNodes) {
    out += walkNode(child);
  }
  return out;
}

function walkNode(node: Node): string {
  if (node.nodeType === NodeType.TEXT_NODE) {
    // text getter decodes entities (&lt; -> <, &amp; -> &)
    return node.text;
  }
  if (node.nodeType !== NodeType.ELEMENT_NODE) {
    // Skip comments and anything else
    return '';
  }
  const el = node as HTMLElement;
  const tag = el.tagName?.toLowerCase();
  if (!tag) return walkContent(el);

  // Defensive: even though STRIP_TAGS removes these at DOM level above,
  // re-parsed <pre> content can re-introduce script/style/etc. as elements,
  // so skip them here too.
  if (DOM_STRIPPED_TAGS.has(tag)) return '';

  if (tag === 'pre') {
    // node-html-parser parses <pre> content as a single raw text node, so
    // any inner markup (syntax-highlighter spans/divs/code) is opaque.
    // Re-parse the rawText to expose that markup as DOM nodes, then walk.
    const reparsed = parse(el.rawText);
    return '\n' + walkContent(reparsed) + '\n';
  }

  if (BLOCK_TAGS.has(tag)) {
    return '\n' + walkContent(el) + '\n';
  }
  return walkContent(el);
}

/** ASCII punctuation that a backslash escapes (CommonMark §2.4). */
const ESCAPABLE_PUNCTUATION = new Set('!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~');

/**
 * Find the start of the next backtick run of exactly `runLength` backticks
 * at or after `from`, or -1 if none precedes a blank line. Per CommonMark
 * §6.1 a code span closes only on a run of the same length, and inline
 * content never crosses a paragraph boundary, so a stray backtick cannot
 * pair with one hundreds of lines later and swallow the text between.
 */
function findClosingBacktickRun(text: string, from: number, runLength: number): number {
  const n = text.length;
  let i = from;
  while (i < n) {
    const ch = text[i];
    if (ch === '`') {
      let j = i;
      while (j < n && text[j] === '`') j++;
      if (j - i === runLength) return i;
      i = j;
      continue;
    }
    if (ch === '\n') {
      let j = i + 1;
      while (j < n && (text[j] === ' ' || text[j] === '\t')) j++;
      if (j >= n || text[j] === '\n') return -1;
    }
    i++;
  }
  return -1;
}

/**
 * Single left-to-right pass that replaces inline code spans with
 * \x00CODE{n}\x00 placeholders and backslash-escaped punctuation with
 * \x00ESC{n}\x00 placeholders, following CommonMark's inline rules:
 *
 * - A backtick run of length N opens a code span closed by the next run of
 *   exactly N backticks (so `` `a` `` contains a literal backtick and a
 *   bare ``` in prose with no partner is just text). Content keeps
 *   backslashes verbatim, as <code> does in HTML, and gets the spec's
 *   one-space trim when it both starts and ends with a space.
 * - Outside code spans, a backslash followed by ASCII punctuation is that
 *   punctuation as literal text: snake\_case renders as snake_case,
 *   string\[] as string[], \*not bold\* keeps its asterisks (issue #110).
 *   The escaped character is stashed so the heading/list/link/emphasis
 *   regexes never see it as syntax, and restored after they run.
 *
 * Fenced blocks must already be placeholder-protected; their content is
 * opaque here.
 */
function protectCodeSpansAndEscapes(text: string, codeSpans: string[], escapes: string[]): string {
  const n = text.length;
  const out: string[] = [];
  let i = 0;
  let plainStart = 0;

  while (i < n) {
    const ch = text[i];

    if (ch === '\\' && i + 1 < n && ESCAPABLE_PUNCTUATION.has(text[i + 1])) {
      out.push(text.slice(plainStart, i));
      const idx = escapes.length;
      escapes.push(text[i + 1]);
      out.push(`\x00ESC${idx}\x00`);
      i += 2;
      plainStart = i;
      continue;
    }

    if (ch === '`') {
      let j = i;
      while (j < n && text[j] === '`') j++;
      const runLength = j - i;
      const close = findClosingBacktickRun(text, j, runLength);
      if (close === -1) {
        // Unmatched run: literal text. Skip past it so its backticks are
        // not re-examined as potential openers.
        i = j;
        continue;
      }
      out.push(text.slice(plainStart, i));
      let content = text.slice(j, close);
      if (content.startsWith(' ') && content.endsWith(' ') && content.trim().length > 0) {
        content = content.slice(1, -1);
      }
      const idx = codeSpans.length;
      codeSpans.push(content);
      out.push(`\x00CODE${idx}\x00`);
      i = close + runLength;
      plainStart = i;
      continue;
    }

    i++;
  }

  out.push(text.slice(plainStart));
  return out.join('');
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
 *
 * Heading lines are also placeholder-protected: a heading like
 * "### 1. How well..." has the "1. " stripped by the numbered-list regex
 * if processed normally, even though that "1. " is part of the heading
 * text on the HTML side. Protecting heading content keeps the bullet/
 * numbered-list passes from touching it.
 *
 * Backslash-escaped punctuation is likewise placeholder-protected and then
 * restored as the bare character, so "snake\_case" in markdown matches
 * "snake_case" in HTML and "\*literal\*" is not stripped as emphasis.
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
  //
  // Fences inside list items are indented by the list marker width (e.g.
  // Turndown indents them 4 spaces under "1.  item"), so the opener may not
  // sit at column 0. Capture the opener's indentation and require the closer
  // at the same indent plus the 0-3 spaces of slack CommonMark allows, so a
  // more deeply indented literal ``` inside the block can't close it early.
  const codeBlocks: string[] = [];
  text = text.replace(
    /^( *)(`{3,})[^`\n]*\n([\s\S]*?)^\1 {0,3}\2`*\s*$/gm,
    (_match, _indent, _opener, content) => {
      const idx = codeBlocks.length;
      codeBlocks.push(content);
      return `\x00BLOCK${idx}\x00`;
    },
  );

  // Step 2: Protect inline code spans and backslash escapes from
  // subsequent stripping. Both are placeholder-protected in one
  // left-to-right pass (see protectCodeSpansAndEscapes) because CommonMark
  // resolves them positionally: a backslash before a backtick consumes it
  // (\`literal\` is prose, not a code span), while a backslash inside an
  // open code span is literal content (`C:\Users\` is one span). Neither
  // ordering of two independent regex passes gets both cases right.
  const codeSpans: string[] = [];
  const escapes: string[] = [];
  text = protectCodeSpansAndEscapes(text, codeSpans, escapes);

  // Step 3: Protect heading lines from list-marker stripping. Headings
  // like "### 1. How well are X supported?" survive into the HTML as
  // "<h3>1. How well are X supported?</h3>", so the leading "1. " is
  // part of the heading text — not a list marker. Without this, the
  // numbered-list regex would strip it and the markdown side wouldn't
  // contain the HTML segment.
  const headings: string[] = [];
  text = text.replace(/^#{1,6}\s+(.*)$/gm, (_match, content) => {
    const idx = headings.length;
    headings.push(content);
    return `\x00HEAD${idx}\x00`;
  });

  // Step 4: Strip list markers and setext underlines while heading lines
  // are still placeholder-protected. These are the passes that would
  // misinterpret heading text — e.g., the numbered-list regex stripping
  // "1. " from "### 1. How well..." (issue #91).
  text = text
    // Remove setext-style heading underlines
    .replace(/^[=-]+$/gm, '')
    // Remove reference-style link definitions
    .replace(/^\[.*?\]:\s+.*$/gm, '')
    // Remove list bullets/numbers (before emphasis, so leading * isn't
    // misinterpreted as an emphasis marker)
    .replace(/^[\s]*[-*+]\s+/gm, '')
    .replace(/^[\s]*\d+\.\s+/gm, '');

  // Step 5: Restore heading text. From here on, heading content is
  // processed like any other body text — emphasis, links, etc. inside
  // heading text gets the same treatment so it matches the HTML side
  // (where <h1><em>Foo</em></h1> renders as "Foo").
  // eslint-disable-next-line no-control-regex
  text = text.replace(/\x00HEAD(\d+)\x00/g, (_match, idxStr) => headings[parseInt(idxStr, 10)]);

  // Step 6: Strip remaining markdown formatting on body and heading text.
  text = text
    // Remove link/image URLs, keep text: [text](url) → text
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
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

  // Step 7: Restore escaped characters as their literal selves, then code
  // content (without backticks/fence markers). Escapes are restored after
  // formatting is stripped so a restored * or _ is never re-read as emphasis.
  // eslint-disable-next-line no-control-regex
  text = text.replace(/\x00ESC(\d+)\x00/g, (_match, idxStr) => escapes[parseInt(idxStr, 10)]);
  // eslint-disable-next-line no-control-regex
  text = text.replace(/\x00CODE(\d+)\x00/g, (_match, idxStr) => codeSpans[parseInt(idxStr, 10)]);
  // eslint-disable-next-line no-control-regex
  text = text.replace(/\x00BLOCK(\d+)\x00/g, (_match, idxStr) => codeBlocks[parseInt(idxStr, 10)]);

  return text;
}

/**
 * Normalize text for fuzzy containment matching:
 * strip zero-width characters, normalize typographic quotes and dashes,
 * strip angle brackets around placeholders, drop characters that are
 * markdown syntax on one side and literal text on the other, collapse
 * whitespace, and lowercase.
 *
 * Every rule here is applied identically to the HTML segment (needle) and
 * the markdown text (haystack), and each one only deletes or collapses a
 * fixed set of characters or trims the needle's leading edge. Such rules
 * preserve substring containment, so adding one can turn a missing segment
 * into a match but can never turn a match into a missing segment.
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
      // Markdown source writes "--" / "---" where the renderer emits an en/em
      // dash (smart-punctuation). Both sides collapse to a single hyphen.
      .replace(/-{2,}/g, '-')
      .replace(/\u2026/g, '...')
      // Strip angle brackets but keep content — normalizes <YOUR_API_KEY> to
      // YOUR_API_KEY so HTML-side (entities decoded, tags stripped) and
      // markdown-side (raw angle brackets) produce the same text.
      // Uses [^>\n] to prevent cross-line matching: a stray '<' (e.g.,
      // '< 5,000 tokens') must not match a '>' hundreds of lines later,
      // which would distort the normalized text and break containment checks.
      .replace(/<([^>\n]+)>/g, '$1')
      // Backticks are code-span delimiters on the markdown side (already
      // removed by extractMarkdownText) but literal text on the HTML side when
      // a page shows unrendered markdown, e.g. an OpenAPI description that the
      // platform displays verbatim (issue #106). Drop them everywhere.
      .replace(/`/g, '')
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .trim()
      // A leading list marker is stripped from markdown lines by
      // extractMarkdownText; strip it from HTML segments too so a description
      // shown as raw "- item" text (issue #106) matches the markdown's list item.
      .replace(/^(?:[-*+]|\d+\.)\s+/, '')
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

  // Pages single-fetch-completeness found paginated: a markdown variant that
  // lists fewer items than the HTML because it is windowed, not stale.
  const paginatedPages = new Set<string>();
  const completeness = ctx.previousResults.get('single-fetch-completeness')?.details
    ?.pageResults as Array<{ url: string; paginated?: boolean }> | undefined;
  for (const r of completeness ?? []) if (r.paginated) paginatedPages.add(r.url);

  for (let i = 0; i < pagesToCompare.length; i += concurrency) {
    const batch = pagesToCompare.slice(i, i + concurrency);
    const batchResults = await Promise.all(
      batch.map(async ({ url, markdownContent, markdownSource }): Promise<PageParityResult> => {
        try {
          // Fetch the HTML version of the page
          const htmlUrl = toHtmlUrl(url, ctx.options.urlPathPattern);
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

          const {
            text: htmlText,
            segmentationStripped,
            items,
          } = extractHtmlText(page.body, parityExclusions);
          totalSegmentationStripped += segmentationStripped;
          const parity = computeParity(htmlText, markdownContent, warnThreshold, failThreshold);
          const itemCounts = compareItemCounts(
            items,
            countMarkdownItems(markdownContent),
            paginatedPages.has(url),
          );

          return { url, markdownSource, ...parity, ...(itemCounts && { itemCounts }) };
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
  const itemCountDivergences = successful.filter((r) => r.itemCounts?.diverges).length;
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
      ...(itemCountDivergences > 0 && { itemCountDivergences }),
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
