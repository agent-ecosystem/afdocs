import { registerCheck } from '../registry.js';
import { discoverAndSamplePages } from '../../helpers/get-page-urls.js';
import { htmlToMarkdown } from '../../helpers/html-to-markdown.js';
import { fetchPage } from '../../helpers/fetch-page.js';
import type { CheckContext, CheckResult, CheckStatus } from '../../types.js';
import { t } from '../../i18n/index.js';

interface PagePositionResult {
  url: string;
  contentStartChar: number;
  totalChars: number;
  contentStartPercent: number;
  status: CheckStatus;
  error?: string;
}

const CSS_PATTERN = /[{}\s]*[a-z0-9_-]+\s*:\s*[^;]+;/;
const JS_PATTERNS = [/^\s*(function|var|const|let|import|export)\b/, /^\s*\/\//, /[{};]\s*$/];
const INLINE_SCRIPT_MIN_LENGTH = 200;
const INLINE_SCRIPT_TOKENS =
  /function\s*\(|=>\s*\{|document\.|window\.|localStorage|\.addEventListener|\.getElementById|\.querySelector|\.setAttribute|self\.\\/;
const NAV_MAX_LENGTH = 40;

/** Measure how much of a line is markdown link syntax: `[text](url)` */
function linkDensity(line: string): number {
  // Simple [text](url) pattern without nested-group repetition.
  // The previous regex (/\[(?:[^[\]]*|!\[...)*\]\(...)/) used a repeated
  // alternation group to handle image links, which caused catastrophic
  // backtracking on lines containing bracket characters from non-markdown
  // content (JSON-LD, Next.js RSC payloads, etc.). The simple pattern
  // is sufficient for density estimation since image-link syntax is rare
  // in the nav/boilerplate lines this function is designed to classify.
  const links = line.match(/\[[^\]]+\]\([^)]+\)/g);
  if (!links) return 0;
  return links.join('').length / line.length;
}

/** Returns true if the line is script or CSS content that should be ignored. */
function isBoilerplateLine(line: string): boolean {
  if (CSS_PATTERN.test(line)) return true;
  if (JS_PATTERNS.some((p) => p.test(line))) return true;
  if (line.length >= INLINE_SCRIPT_MIN_LENGTH && INLINE_SCRIPT_TOKENS.test(line)) return true;
  return false;
}

/**
 * Check whether a heading is followed by prose (content heading) rather than
 * a list of links (sidebar/nav heading). Looks ahead up to 6 non-empty,
 * non-boilerplate lines after the heading for a prose paragraph.
 */
function headingFollowedByContent(lines: string[], headingIdx: number): boolean {
  // Skip the heading line itself and any setext underline
  let start = headingIdx + 1;
  if (start < lines.length && /^[=-]+$/.test(lines[start].trim())) {
    start++;
  }

  let nonEmptyCount = 0;
  for (let i = start; i < lines.length && nonEmptyCount < 6; i++) {
    const t = lines[i].trim();
    if (t.length === 0) continue;

    // Skip script/CSS boilerplate — don't count it as "content after heading"
    if (isBoilerplateLine(t)) continue;

    nonEmptyCount++;

    // If we hit a link-heavy line or a list item starting with [, keep scanning
    if (linkDensity(t) > 0.5) continue;
    if (/^\*\s+\[/.test(t)) continue;
    if (/^\]\(/.test(t)) continue;

    // Another heading (ATX or setext) means the previous one had no prose body
    if (/^#{1,6}\s/.test(t)) return false;
    const nextLine = i + 1 < lines.length ? lines[i + 1].trim() : '';
    if (/^[=-]+$/.test(nextLine) && nextLine.length >= 2) return false;

    // Markdown table row (e.g. "| Col A | Col B |")
    if (/^\|.+\|/.test(t)) return true;

    // HTML table tags inside .md files (not converted by htmlToMarkdown)
    if (/^<table[\s>]/i.test(t) || /^<tr[\s>]/i.test(t)) return true;

    // A line > NAV_MAX_LENGTH that isn't a link is likely real prose
    if (t.length > NAV_MAX_LENGTH && linkDensity(t) < 0.5) return true;

    // A shorter line with sentence-ending punctuation is also prose
    if (/[.!?]$/.test(t) && t.length >= 10 && linkDensity(t) < 0.5) return true;

    // Short lines under headings are typically nav items
  }
  return false;
}

/**
 * Find the character position where meaningful content begins in converted markdown.
 * Meaningful content is a heading followed by prose, or a standalone prose paragraph
 * that isn't navigation, scripts, CSS, or link-heavy boilerplate.
 */
function findContentStart(markdown: string): number {
  const lines = markdown.split('\n');
  let charPos = 0;

  for (let idx = 0; idx < lines.length; idx++) {
    const line = lines[idx];
    const trimmed = line.trim();

    if (trimmed.length === 0) {
      charPos += line.length + 1;
      continue;
    }

    // ATX heading h1-h4 followed by prose content (not a nav/sidebar heading)
    if (/^#{1,4}\s+\S/.test(trimmed) && !/^#{5,6}\s/.test(trimmed)) {
      if (headingFollowedByContent(lines, idx)) {
        return charPos;
      }
      // Otherwise skip it as a sidebar/nav heading
      charPos += line.length + 1;
      continue;
    }

    // Setext heading followed by prose content
    const nextLine = idx + 1 < lines.length ? lines[idx + 1].trim() : '';
    if (/^[=-]+$/.test(nextLine) && nextLine.length >= 2 && trimmed.length > 0) {
      if (headingFollowedByContent(lines, idx)) {
        return charPos;
      }
      charPos += line.length + 1;
      continue;
    }

    // Skip CSS, JS, and inline script boilerplate
    if (isBoilerplateLine(trimmed)) {
      charPos += line.length + 1;
      continue;
    }

    // Skip lines dominated by markdown link syntax (nav bars, TOC, link lists)
    if (linkDensity(trimmed) > 0.5) {
      charPos += line.length + 1;
      continue;
    }

    // Skip bare link fragments from Turndown splitting links across lines: `](/path)`
    if (/^\]\(/.test(trimmed)) {
      charPos += line.length + 1;
      continue;
    }

    // Standalone prose paragraph (not preceded by a heading we recognized).
    // Must be a strong signal of real content to avoid matching UI chrome like
    // "Press Enter to activate dropdown" or "Select language: English".
    // Require sentence punctuation + substantial length, or very long text.
    if (trimmed.length >= 80 && linkDensity(trimmed) < 0.5) {
      return charPos;
    }
    if (/[.!?]$/.test(trimmed) && trimmed.length >= 40 && linkDensity(trimmed) < 0.5) {
      return charPos;
    }

    charPos += line.length + 1;
  }

  // If nothing matched, content starts at the end (all boilerplate)
  return charPos;
}

function positionStatus(percent: number): CheckStatus {
  if (percent <= 10) return 'pass';
  if (percent <= 50) return 'warn';
  return 'fail';
}

function worstStatus(statuses: CheckStatus[]): CheckStatus {
  if (statuses.includes('fail')) return 'fail';
  if (statuses.includes('warn')) return 'warn';
  return 'pass';
}

async function check(ctx: CheckContext): Promise<CheckResult> {
  const id = 'content-start-position';
  const category = 'page-size';

  const {
    urls: pageUrls,
    totalPages,
    sampled: wasSampled,
    warnings,
  } = await discoverAndSamplePages(ctx);

  const results: PagePositionResult[] = [];
  const concurrency = ctx.options.maxConcurrency;

  for (let i = 0; i < pageUrls.length; i += concurrency) {
    const batch = pageUrls.slice(i, i + concurrency);
    const batchResults = await Promise.all(
      batch.map(async (url): Promise<PagePositionResult> => {
        try {
          const page = await fetchPage(ctx, url);
          const markdown = page.isHtml ? htmlToMarkdown(page.body) : page.body;
          const totalChars = markdown.length;
          const contentStartChar = findContentStart(markdown);
          const contentStartPercent =
            totalChars > 0 ? Math.round((contentStartChar / totalChars) * 100) : 0;

          return {
            url,
            contentStartChar,
            totalChars,
            contentStartPercent,
            status: positionStatus(contentStartPercent),
          };
        } catch (err) {
          return {
            url,
            contentStartChar: 0,
            totalChars: 0,
            contentStartPercent: 100,
            status: 'fail',
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
      message: t('check.content-start-position.error_none', {
        suffix: fetchErrors > 0 ? t('common.fetch_errors_suffix', { count: fetchErrors }) : '',
      }),
      details: {
        totalPages,
        testedPages: results.length,
        sampled: wasSampled,
        fetchErrors,
        pageResults: results,
        discoveryWarnings: warnings,
      },
    };
  }

  const percents = successful.map((r) => r.contentStartPercent);
  const medianPercent = percents.sort((a, b) => a - b)[Math.floor(percents.length / 2)];
  const maxPercent = Math.max(...percents);

  const overallStatus = worstStatus(successful.map((r) => r.status));
  const pageLabel = wasSampled ? t('common.sampled_pages') : t('common.pages');

  const passBucket = successful.filter((r) => r.status === 'pass').length;
  const warnBucket = successful.filter((r) => r.status === 'warn').length;
  const failBucket = successful.filter((r) => r.status === 'fail').length;

  const suffix = fetchErrors > 0 ? t('common.fetch_errors_suffix', { count: fetchErrors }) : '';

  let message: string;
  if (overallStatus === 'pass') {
    message = t('check.content-start-position.pass', {
      total: successful.length,
      pageLabel,
      median: medianPercent,
      suffix,
    });
  } else if (overallStatus === 'warn') {
    message = t('check.content-start-position.warn', {
      warn: warnBucket,
      total: successful.length,
      pageLabel,
      worst: maxPercent,
      suffix,
    });
  } else {
    message = t('check.content-start-position.fail', {
      failCount: failBucket,
      total: successful.length,
      pageLabel,
      worst: maxPercent,
      suffix,
    });
  }

  return {
    id,
    category,
    status: overallStatus,
    message,
    details: {
      totalPages,
      testedPages: results.length,
      sampled: wasSampled,
      medianPercent,
      maxPercent,
      passBucket,
      warnBucket,
      failBucket,
      fetchErrors,
      pageResults: results,
      discoveryWarnings: warnings,
    },
  };
}

registerCheck({
  id: 'content-start-position',
  category: 'page-size',
  description: 'How far into content the actual documentation begins',
  dependsOn: [],
  run: check,
});
