import { parse } from 'node-html-parser';

const SPA_MARKERS = ['id="___gatsby"', 'id="__next"', 'id="__nuxt"', 'id="root"'];

export interface RenderingAnalysis {
  /** Whether the page appears to be server-rendered with real content. */
  hasContent: boolean;
  /** Whether known SPA framework markers were found. */
  hasSpaMarkers: boolean;
  /** Which SPA marker was found, if any. */
  spaMarker: string | null;
  /** Number of content headings found (excluding nav-only headings). */
  contentHeadings: number;
  /** Number of paragraphs with substantial prose (>30 chars). */
  contentParagraphs: number;
  /** Number of code blocks found. */
  codeBlocks: number;
  /** Whether a <main> or [role="main"] element with children exists. */
  hasMainContent: boolean;
  /** Visible text length after stripping script/style/noscript. */
  visibleTextLength: number;
  /** Total HTML length. */
  htmlLength: number;
}

/** The concrete content signals `hasSubstantiveContent` evaluates. */
export type ContentSignals = Pick<
  RenderingAnalysis,
  'contentHeadings' | 'contentParagraphs' | 'codeBlocks' | 'hasMainContent' | 'visibleTextLength'
>;

/**
 * Whether the measured content signals add up to a real documentation page:
 * headings, prose paragraphs, code blocks, or a populated main region.
 *
 * This is the positive-evidence half of `analyzeRendering`'s `hasContent`
 * verdict, exposed on its own so other checks can ask "does this page carry
 * substantive documentation content?" without the "no SPA markers, so assume
 * server-rendered" escape hatch that `hasContent` also accepts. A traditional
 * server-rendered login page has no SPA markers yet is not documentation, so
 * callers vetoing a weak signal (such as a login-looking page title) need
 * this stricter question.
 *
 * The disjunction combines several independent positive signals; any one is
 * enough. All text-length thresholds apply after chrome stripping
 * (nav/header/footer/aside removed), so menu and breadcrumb text on an
 * otherwise-empty SPA shell does not satisfy them.
 *
 * - visibleTextLength >= 1500: long page, possibly without semantic markup
 *   (rare wall-of-text case where no headings parse).
 * - contentHeadings >= 1 && visibleTextLength >= 500: short doc pages that
 *   have a heading and a meaningful body. Catches div-soup renderers
 *   (Archbee, custom Next.js setups) on legitimately short pages —
 *   integration explainers, glossary entries, single-feature notes — that
 *   used to be misclassified as sparse because their <500-char body sat
 *   below the 1500 wall-of-text threshold. True SPA shells fail this
 *   clause: their post-chrome-strip body is effectively empty (~0 chars),
 *   nowhere near 500.
 * - contentHeadings >= 3: multi-section pages (typical reference docs).
 * - contentParagraphs >= 5: well-structured prose with semantic <p> tags.
 * - hasMainContent && contentHeadings >= 1: pages with a populated <main>
 *   region and at least one heading — the canonical doc-page shape.
 * - codeBlocks >= 3: API references and code-heavy pages.
 */
export function hasSubstantiveContent(signals: ContentSignals): boolean {
  const { contentHeadings, contentParagraphs, codeBlocks, hasMainContent, visibleTextLength } =
    signals;
  return (
    visibleTextLength >= 1500 ||
    (contentHeadings >= 1 && visibleTextLength >= 500) ||
    contentHeadings >= 3 ||
    contentParagraphs >= 5 ||
    (hasMainContent && contentHeadings >= 1) ||
    codeBlocks >= 3
  );
}

/**
 * Analyze whether an HTML page contains server-rendered content or is
 * a client-side-rendered SPA shell.
 *
 * Unlike a simple text-ratio heuristic, this checks for concrete content
 * signals: headings, paragraphs with prose, code blocks, and main content
 * regions. SSR sites with heavy bundled assets (low text ratio but real
 * content) will pass; true SPA shells (framework marker + no content) will fail.
 */
export function analyzeRendering(html: string): RenderingAnalysis {
  const htmlLength = html.length;

  // Check for SPA framework markers
  let spaMarker: string | null = null;
  for (const marker of SPA_MARKERS) {
    if (html.includes(marker)) {
      spaMarker = marker;
      break;
    }
  }
  const hasSpaMarkers = spaMarker !== null;

  // Parse and strip non-content elements
  const root = parse(html);
  const body = root.querySelector('body') ?? root;

  // Strip non-content elements (scripts/styles) and chrome regions
  // (nav/header/footer/aside + ARIA equivalents). Chrome must be excluded so
  // visibleTextLength reflects actual content the agent sees, not menus and
  // breadcrumbs that happen to be server-rendered on otherwise-empty shells.
  for (const el of body.querySelectorAll(
    'script, style, noscript, svg, nav, header, footer, aside, ' +
      '[role="navigation"], [role="banner"], [role="contentinfo"], [role="complementary"]',
  )) {
    el.remove();
  }

  // Visible text
  const visibleText = body.textContent.replace(/\s+/g, ' ').trim();
  const visibleTextLength = visibleText.length;

  // Content signals: headings with substantive text
  const headings = body.querySelectorAll('h1, h2, h3, h4, h5, h6');
  let contentHeadings = 0;
  for (const h of headings) {
    const text = h.textContent.trim();
    // Skip very short headings that are likely nav labels
    if (text.length > 3) contentHeadings++;
  }

  // Content signals: paragraphs with prose
  const paragraphs = body.querySelectorAll('p');
  let contentParagraphs = 0;
  for (const p of paragraphs) {
    const text = p.textContent.trim();
    if (text.length > 30) contentParagraphs++;
  }

  // Content signals: code blocks
  const codeBlocks = body.querySelectorAll('pre, code').length;

  // Content signals: main content region with substantive content inside it.
  // An SPA shell can have a <main> element with just a page title and breadcrumbs,
  // so we check for real content (paragraphs, code) inside <main> specifically.
  const main = body.querySelector('main, [role="main"]');
  let hasMainContent = false;
  if (main) {
    const mainParas = main.querySelectorAll('p');
    let mainParagraphs = 0;
    for (const p of mainParas) {
      if (p.textContent.trim().length > 30) mainParagraphs++;
    }
    const mainCode = main.querySelectorAll('pre, code').length;
    hasMainContent = mainParagraphs >= 2 || mainCode >= 1;
  }

  // Determine if the page has real content: either the positive signals in
  // `hasSubstantiveContent` add up, or the page has no SPA markers at all
  // (traditional server-rendered HTML; not a shell candidate).
  const hasContent =
    hasSubstantiveContent({
      contentHeadings,
      contentParagraphs,
      codeBlocks,
      hasMainContent,
      visibleTextLength,
    }) || !hasSpaMarkers;

  return {
    hasContent,
    hasSpaMarkers,
    spaMarker,
    contentHeadings,
    contentParagraphs,
    codeBlocks,
    hasMainContent,
    visibleTextLength,
    htmlLength,
  };
}
