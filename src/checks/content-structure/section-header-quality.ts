import type { HTMLElement } from 'node-html-parser';
import { parse } from 'node-html-parser';
import type { Nodes } from 'mdast';
import { registerCheck } from '../registry.js';
import type { CheckContext, CheckResult, CheckStatus } from '../../types.js';
import type { DetectedTabGroup } from '../../helpers/detect-tabs.js';
import { parseMarkdown } from '../../helpers/parse-markdown.js';

interface TabbedPageResult {
  url: string;
  tabGroups: DetectedTabGroup[];
  totalTabbedChars: number;
  status: CheckStatus;
  error?: string;
}

interface GroupHeaderAnalysis {
  url: string;
  framework: string;
  totalHeaders: number;
  genericHeaders: number;
  contextualHeaders: number;
  hasGenericMajority: boolean;
  hasCrossGroupGeneric: boolean;
}

const HTML_HEADING_TAGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']);

const CALLOUT_ROLES = new Set(['alert', 'note', 'status', 'complementary']);

/**
 * Check whether a heading is inside a callout/admonition container rather than
 * being a structural section header. Walks up the ancestor chain looking for
 * signals: semantic HTML (<aside>), ARIA roles, class names containing
 * "callout"/"admonition", or data-* attribute values containing those keywords.
 */
function isCalloutHeading(h: HTMLElement): boolean {
  let el: HTMLElement | null = h;
  while (el) {
    // Semantic HTML
    if (el.rawTagName === 'aside') return true;

    // ARIA roles
    const role = el.getAttribute('role');
    if (role && CALLOUT_ROLES.has(role)) return true;

    // Class and data-* attribute values
    const attrs = el.attributes;
    for (const [key, value] of Object.entries(attrs)) {
      if (key === 'role') continue; // already checked
      if (key === 'class' || key.startsWith('data-')) {
        const lower = value.toLowerCase();
        if (lower.includes('callout') || lower.includes('admonition')) return true;
      }
    }

    el = el.parentNode as HTMLElement | null;
  }
  return false;
}

function headingText(node: Nodes): string {
  if (node.type === 'text' || node.type === 'inlineCode') return node.value;
  if (node.type === 'image' || node.type === 'imageReference') return node.alt ?? '';
  if (node.type === 'break') return '\n';
  return 'children' in node ? node.children.map(headingText).join('') : '';
}

/**
 * Extract section header text from content that may be HTML, markdown, or a
 * mix (MDX). Excludes headings inside callout/admonition containers, which
 * are supplementary labels rather than structural section headers.
 */
function extractHeaders(content: string): string[] {
  const headers: string[] = [];
  const markdownHeaders: Array<{ text: string; offset: number }> = [];
  const htmlSource = content.split('');
  const panel = parse(content).querySelector('tab, tabitem');
  const start = panel?.firstChild?.range[0];
  const end = panel?.lastChild?.range[1];
  let markdownSource = content;
  if (
    panel &&
    start !== undefined &&
    end !== undefined &&
    content.slice(0, panel.range[0]).trim() === '' &&
    content.slice(panel.range[1]).trim() === ''
  ) {
    markdownSource =
      content.slice(0, start).replace(/[^\r\n]/g, ' ') +
      content.slice(start, end) +
      content.slice(end).replace(/[^\r\n]/g, ' ');
  }
  const tree = parseMarkdown(markdownSource, { normalizeVendorFences: false });

  const visit = (node: Nodes): void => {
    const offset = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (offset === undefined || end === undefined) return;

    if (node.type === 'heading') {
      const text = headingText(node).trim();
      if (text.length > 0) markdownHeaders.push({ text, offset });
    }
    if (node.type === 'code' || node.type === 'inlineCode') {
      for (let index = offset; index < end; index++) {
        if (htmlSource[index] !== '\n' && htmlSource[index] !== '\r') htmlSource[index] = ' ';
      }
      return;
    }
    if ('children' in node) node.children.forEach(visit);
  };
  visit(tree);

  // HTML headers — skip callout/admonition headings
  const root = parse(htmlSource.join(''));
  const htmlHeaders = root.querySelectorAll('h1, h2, h3, h4, h5, h6');
  for (const h of htmlHeaders) {
    if (isCalloutHeading(h)) continue;
    const text = h.textContent.trim();
    if (text.length > 0) headers.push(text);
  }

  const excludedContainers = root
    .querySelectorAll('*')
    .filter((element) => HTML_HEADING_TAGS.has(element.rawTagName) || isCalloutHeading(element));
  for (const { text, offset } of markdownHeaders) {
    if (
      excludedContainers.some((element) => offset >= element.range[0] && offset < element.range[1])
    ) {
      continue;
    }
    headers.push(text);
  }

  return headers;
}

async function check(ctx: CheckContext): Promise<CheckResult> {
  const id = 'section-header-quality';
  const category = 'content-structure';

  const tabResult = ctx.previousResults.get('tabbed-content-serialization');

  if (!tabResult || tabResult.status === 'skip') {
    return {
      id,
      category,
      status: 'skip',
      message: 'Skipped: tabbed-content-serialization did not run',
    };
  }

  const tabbedPages = (tabResult.details?.tabbedPages as TabbedPageResult[] | undefined) ?? [];
  const pagesWithGroups = tabbedPages.filter((p) => p.tabGroups && p.tabGroups.length > 0);

  if (pagesWithGroups.length === 0) {
    return {
      id,
      category,
      status: 'pass',
      message: 'No tabbed content found; header quality check not applicable',
    };
  }

  const analyses: GroupHeaderAnalysis[] = [];
  // Track unique headers per analysis for cross-group pass
  const analysisHeaderSets: Set<string>[] = [];

  for (const page of pagesWithGroups) {
    for (const group of page.tabGroups) {
      if (group.panels.length < 2) continue;

      // Extract headers from each panel
      const panelHeaders: Array<{ label: string | null; headers: string[] }> = group.panels.map(
        (panel) => ({
          label: panel.label,
          headers: extractHeaders(panel.html),
        }),
      );

      // Count how many times each header text appears across panels
      const headerCounts = new Map<string, number>();
      const uniqueHeaders = new Set<string>();
      for (const ph of panelHeaders) {
        for (const h of ph.headers) {
          const lower = h.toLowerCase();
          headerCounts.set(lower, (headerCounts.get(lower) ?? 0) + 1);
          uniqueHeaders.add(lower);
        }
      }

      const allHeaders = panelHeaders.flatMap((ph) => ph.headers);
      let genericCount = 0;
      let contextualCount = 0;

      for (const ph of panelHeaders) {
        for (const h of ph.headers) {
          const lower = h.toLowerCase();
          const appearsInMultiple = (headerCounts.get(lower) ?? 0) >= 2;

          // A header is contextual if it includes the panel label or is unique
          const includesLabel = ph.label != null && lower.includes(ph.label.toLowerCase());

          if (includesLabel || !appearsInMultiple) {
            contextualCount++;
          } else {
            genericCount++;
          }
        }
      }

      const totalHeaders = allHeaders.length;
      const hasGenericMajority = totalHeaders > 0 && genericCount > totalHeaders / 2;

      analysisHeaderSets.push(uniqueHeaders);
      analyses.push({
        url: page.url,
        framework: group.framework,
        totalHeaders,
        genericHeaders: genericCount,
        contextualHeaders: contextualCount,
        hasGenericMajority,
        hasCrossGroupGeneric: false,
      });
    }
  }

  // Cross-group analysis: detect identical headers repeated across separate tab groups
  // on the same page without variant context (e.g. "Build a MongoDB Search Query"
  // appearing in 7 driver-specific tab groups).
  let crossGroupGenericGroupCount = 0;
  let crossGroupTotalGroupCount = 0;
  const crossGroupRepeatedHeaders: Array<{ url: string; header: string; groupCount: number }> = [];

  for (const page of pagesWithGroups) {
    if (page.tabGroups.length < 2) continue;

    // Collect all panel labels and unique headers per group
    const allLabels = new Set<string>();
    const perGroup: Set<string>[] = [];
    for (const group of page.tabGroups) {
      const headers = new Set<string>();
      for (const panel of group.panels) {
        if (panel.label) allLabels.add(panel.label.toLowerCase());
        for (const h of extractHeaders(panel.html)) headers.add(h.toLowerCase());
      }
      perGroup.push(headers);
    }

    // Count how many groups each header appears in
    const headerGroupCount = new Map<string, number>();
    for (const hs of perGroup) {
      for (const h of hs) headerGroupCount.set(h, (headerGroupCount.get(h) ?? 0) + 1);
    }

    // A header is cross-group generic if it appears in 2+ groups and doesn't
    // include any panel label (i.e. lacks variant context)
    const crossGenericSet = new Set<string>();
    for (const [header, count] of headerGroupCount) {
      if (count >= 2 && ![...allLabels].some((l) => header.includes(l))) {
        crossGenericSet.add(header);
        crossGroupRepeatedHeaders.push({ url: page.url, header, groupCount: count });
      }
    }

    // Count groups affected by cross-group generic headers
    for (const hs of perGroup) {
      if (hs.size === 0) continue;
      crossGroupTotalGroupCount++;
      if ([...hs].some((h) => crossGenericSet.has(h))) crossGroupGenericGroupCount++;
    }

    // Update individual analyses with cross-group flag
    if (crossGenericSet.size > 0) {
      for (let i = 0; i < analyses.length; i++) {
        if (analyses[i].url !== page.url) continue;
        if ([...analysisHeaderSets[i]].some((h) => crossGenericSet.has(h))) {
          analyses[i].hasCrossGroupGeneric = true;
        }
      }
    }
  }

  if (analyses.length === 0 && crossGroupTotalGroupCount === 0) {
    return {
      id,
      category,
      status: 'pass',
      message: 'Tab groups have fewer than 2 panels; header quality check not applicable',
    };
  }

  const groupsWithGenericMajority = analyses.filter((a) => a.hasGenericMajority).length;
  const groupsWithHeaders = analyses.filter((a) => a.totalHeaders > 0).length;

  // If no tab panels contain any section headers, we can't evaluate quality
  if (groupsWithHeaders === 0 && crossGroupTotalGroupCount === 0) {
    return {
      id,
      category,
      status: 'skip',
      message: `${pagesWithGroups.length} page(s) with tabs found, but no section headers inside tab panels to evaluate`,
    };
  }

  // Identify affected pages: pages where any group has within-group or cross-group issues
  const pagesWithWithinGroupIssues = new Set(
    analyses.filter((a) => a.hasGenericMajority).map((a) => a.url),
  );
  const pagesWithCrossGroupIssues = new Set(crossGroupRepeatedHeaders.map((h) => h.url));
  const affectedPages = new Set([...pagesWithWithinGroupIssues, ...pagesWithCrossGroupIssues]);

  // Count pages where we actually found headers to evaluate
  const pagesWithHeaders = new Set(analyses.filter((a) => a.totalHeaders > 0).map((a) => a.url));

  // Scoring: use group-level ratios for fine-grained thresholds
  // Within-group: ratio of groups-with-headers that have majority-generic
  let withinStatus: CheckStatus = 'pass';
  if (groupsWithHeaders > 0) {
    const wRatio = groupsWithGenericMajority / groupsWithHeaders;
    if (wRatio > 0.5) withinStatus = 'fail';
    else if (wRatio > 0.25) withinStatus = 'warn';
  }

  // Cross-group: ratio of groups on multi-group pages that have cross-group generics
  let crossGroupStatus: CheckStatus = 'pass';
  if (crossGroupTotalGroupCount > 0) {
    const cRatio = crossGroupGenericGroupCount / crossGroupTotalGroupCount;
    if (cRatio > 0.5) crossGroupStatus = 'fail';
    else if (cRatio > 0.25) crossGroupStatus = 'warn';
  }

  // Combined status: worst of both
  const statusRank: Record<CheckStatus, number> = { pass: 0, skip: 0, warn: 1, fail: 2, error: 2 };
  const status: CheckStatus =
    statusRank[crossGroupStatus] > statusRank[withinStatus] ? crossGroupStatus : withinStatus;

  // Build a page-oriented message for docs teams
  let message: string;
  if (affectedPages.size === 0) {
    message = `${pagesWithHeaders.size} page(s) with tab headers checked; headers include variant context`;
  } else {
    // Find the most-repeated cross-group header for a concrete example
    const worstHeader =
      crossGroupRepeatedHeaders.length > 0
        ? [...crossGroupRepeatedHeaders].sort((a, b) => b.groupCount - a.groupCount)[0]
        : null;

    const pageSummary =
      `${affectedPages.size} of ${pagesWithHeaders.size} page(s) with tab headers ` +
      `don't distinguish between variants`;

    if (worstHeader) {
      message = `${pageSummary} (e.g. "${worstHeader.header}" repeats across ${worstHeader.groupCount} tab groups)`;
    } else {
      message = pageSummary;
    }
  }

  return {
    id,
    category,
    status,
    message,
    details: {
      pagesWithTabs: pagesWithGroups.length,
      pagesAffected: affectedPages.size,
      totalGroupsAnalyzed: analyses.length,
      groupsWithHeaders,
      groupsWithGenericMajority,
      crossGroupGenericGroupCount,
      crossGroupTotalGroupCount,
      crossGroupRepeatedHeaders,
      analyses,
    },
  };
}

registerCheck({
  id: 'section-header-quality',
  category: 'content-structure',
  description: 'Whether headers in tabbed sections include variant context',
  // No hard dependency: we read from previousResults if available,
  // but the check handles missing data gracefully (returns skip).
  dependsOn: [],
  run: check,
});
