import { registerCheck } from '../registry.js';
import { getMarkdownContent } from '../../helpers/get-markdown-content.js';
import type { CheckContext, CheckResult, CheckStatus } from '../../types.js';
import { t } from '../../i18n/index.js';

interface FenceIssue {
  line: number;
  type: 'unclosed';
  opener: string;
}

interface PageFenceResult {
  url: string;
  source: string;
  fenceCount: number;
  issues: FenceIssue[];
  status: CheckStatus;
}

/**
 * Strip blockquote prefixes (`> `) from a line so that fences inside
 * blockquotes are detected the same way a CommonMark parser would
 * handle them. Supports nested blockquotes (`> > `).
 */
function stripBlockquotePrefix(line: string): string {
  return line.replace(/^(?:\s{0,3}> ?)+/, '');
}

/** Match a line that opens or closes a code fence (after blockquote and list-container stripping). */
const FENCE_RE = /^( {0,3})((`{3,})|(~{3,}))(.*)?$/;

/** Match a list-item marker (bullet or 1-9 digit ordered) at the start of a line. */
const LIST_MARKER_RE = /^( {0,3})(?:([-*+])|(\d{1,9})([.)]))( *)(.*)$/;

function countLeadingSpaces(s: string): number {
  let i = 0;
  while (i < s.length && s[i] === ' ') i++;
  return i;
}

function stripUpTo(s: string, n: number): string {
  let i = 0;
  while (i < n && i < s.length && s[i] === ' ') i++;
  return s.slice(i);
}

/**
 * Detect a list-item marker and return the absolute column (within `line`)
 * where the item's content begins — i.e. the indent threshold subsequent
 * lines need to clear to remain inside this list item. Returns null if
 * the line isn't a list-item opener.
 *
 * Per CommonMark §5.2: the content column = leading spaces + marker width
 * + spaces after marker (1-4). If the marker is followed by 5+ spaces, or
 * by no content at all, the content column is marker-end + 1.
 */
function detectListMarker(line: string): number | null {
  const m = LIST_MARKER_RE.exec(line);
  if (!m) return null;
  const leadingSpaces = m[1].length;
  const markerLen = m[2] ? 1 : m[3].length + 1; // digits + ('.' or ')')
  const spacesAfter = m[5].length;
  const content = m[6];
  // A marker followed by content but no separating space isn't a valid marker
  // (e.g. "1.foo" is just text, not a list item).
  if (content !== '' && spacesAfter === 0) return null;
  if (content === '' || spacesAfter >= 5) {
    return leadingSpaces + markerLen + 1;
  }
  return leadingSpaces + markerLen + spacesAfter;
}

function analyzeFences(content: string): { fenceCount: number; issues: FenceIssue[] } {
  // Normalize CRLF/CR to LF so the fence regex's `$` anchor matches on
  // Windows-authored docs. Without this, lines retain a trailing `\r`,
  // FENCE_RE fails to match, and we silently undercount fences.
  const lines = content.replace(/\r\n?/g, '\n').split('\n');
  const issues: FenceIssue[] = [];
  let fenceCount = 0;
  let openFence: { line: number; char: string; length: number } | null = null;

  // Stack of open list-item content columns. A line whose indent (within the
  // post-blockquote frame) is at least the top of the stack belongs to that
  // list item; less indent pops the list. Tracking this lets us detect fences
  // that inherit a list item's indent — e.g. tutorial-style docs with 2-digit
  // ordered lists or nested-list code blocks where fence indent is 4+.
  const listStack: number[] = [];

  for (let i = 0; i < lines.length; i++) {
    const stripped = stripBlockquotePrefix(lines[i]);

    // Pop list containers when the line's indent drops below the current
    // list-item content column. Blank lines and lines inside an open fence
    // don't pop — fences may legitimately contain less-indented content,
    // and CommonMark allows blank lines within list items.
    if (!openFence && stripped.trim() !== '') {
      const indent = countLeadingSpaces(stripped);
      while (listStack.length && indent < listStack[listStack.length - 1]) {
        listStack.pop();
      }
    }

    const containerIndent = listStack.length ? listStack[listStack.length - 1] : 0;
    const containerStripped = stripUpTo(stripped, containerIndent);

    // Skip fences inside markdown table cells (e.g. "``` | ```" or "| ```")
    // These aren't real CommonMark fences — multi-line table cells are a vendor extension
    if (containerStripped.includes('|')) continue;

    const match = FENCE_RE.exec(containerStripped);

    if (match) {
      const char = match[3] ? '`' : '~';
      const length = (match[3] || match[4]).length;
      const info = (match[5] || '').trim();

      if (!openFence) {
        // Opening fence
        openFence = { line: i + 1, char, length };
        fenceCount++;
      } else {
        // Potential closing fence: must use same char, be at least as long,
        // and per CommonMark §4.5 "may not be followed by anything other than
        // spaces and tabs" — a fence line carrying an info string is content,
        // not a closer. Different delimiter types are also just content.
        if (char === openFence.char && length >= openFence.length && info === '') {
          openFence = null;
        }
      }
      continue;
    }

    // Not a fence line. If we're not inside a fence, see if this line opens
    // a new list item, and if so push its content column onto the stack.
    if (!openFence) {
      const W = detectListMarker(containerStripped);
      if (W !== null) {
        listStack.push(containerIndent + W);
      }
    }
  }

  // Intentional divergence from CommonMark §4.5: the spec says an unclosed
  // fence is implicitly closed at end of document. We flag it instead, since
  // a missing closer in published docs is almost always an authoring bug
  // (and the symptom — the rest of the page rendering as code — is exactly
  // what this check exists to catch).
  if (openFence) {
    issues.push({
      line: openFence.line,
      type: 'unclosed',
      opener: openFence.char.repeat(openFence.length),
    });
  }

  return { fenceCount, issues };
}

function worstStatus(statuses: CheckStatus[]): CheckStatus {
  if (statuses.includes('fail')) return 'fail';
  if (statuses.includes('warn')) return 'warn';
  return 'pass';
}

async function check(ctx: CheckContext): Promise<CheckResult> {
  const id = 'markdown-code-fence-validity';
  const category = 'content-structure';

  const mdResult = await getMarkdownContent(ctx);

  if (mdResult.pages.length === 0) {
    if (mdResult.mode === 'cached' && !mdResult.depPassed) {
      return {
        id,
        category,
        status: 'skip',
        message: t('check.markdown-code-fence-validity.skip_no_md'),
      };
    }
    const hint =
      mdResult.mode === 'standalone'
        ? '; try running with markdown-url-support or content-negotiation checks'
        : '';
    return {
      id,
      category,
      status: 'skip',
      message: t('check.markdown-code-fence-validity.skip_none', { hint }),
    };
  }

  const results: PageFenceResult[] = mdResult.pages.map(({ url, content, source }) => {
    const { fenceCount, issues } = analyzeFences(content);
    const hasUnclosed = issues.some((i) => i.type === 'unclosed');

    const status: CheckStatus = hasUnclosed ? 'fail' : 'pass';

    return { url, source, fenceCount, issues, status };
  });

  const overallStatus = worstStatus(results.map((r) => r.status));
  const totalFences = results.reduce((sum, r) => sum + r.fenceCount, 0);
  const unclosedCount = results.reduce((sum, r) => sum + r.issues.length, 0);

  const message =
    overallStatus === 'pass'
      ? t('check.markdown-code-fence-validity.pass', { fences: totalFences, pages: results.length })
      : t('check.markdown-code-fence-validity.fail', {
          count: unclosedCount,
          pages: results.length,
        });

  return {
    id,
    category,
    status: overallStatus,
    message,
    details: {
      pagesAnalyzed: results.length,
      totalFences,
      unclosedCount,
      pageResults: results,
    },
  };
}

registerCheck({
  id: 'markdown-code-fence-validity',
  category: 'content-structure',
  description: 'Whether markdown contains unclosed code fences',
  dependsOn: [],
  run: check,
});
