import { registerCheck } from '../registry.js';
import { getLlmsTxtFilesForAnalysis } from '../../helpers/llms-txt.js';
import { t } from '../../i18n/index.js';
import type { CheckContext, CheckResult } from '../../types.js';

interface ValidationResult {
  url: string;
  hasH1: boolean;
  hasBlockquote: boolean;
  hasSections: boolean;
  linkCount: number;
  issues: string[];
}

/** Extract markdown links from text: [name](url) */
export function extractMarkdownLinks(content: string): Array<{ name: string; url: string }> {
  const linkRegex = /\[([^\]]+)\]\(([^\s)]+)(?:\s+["'][^"']*["'])?\)/g;
  const links: Array<{ name: string; url: string }> = [];
  let match;
  while ((match = linkRegex.exec(content)) !== null) {
    links.push({ name: match[1], url: match[2] });
  }
  return links;
}

function validateLlmsTxt(content: string, url: string): ValidationResult {
  const lines = content.split('\n');
  const issues: string[] = [];

  // Check for H1 (first non-empty line starts with #)
  const firstContentLine = lines.find((l) => l.trim().length > 0);
  const hasH1 = firstContentLine?.startsWith('# ') ?? false;
  if (!hasH1) issues.push('No H1 heading found');

  // Check for blockquote summary
  const hasBlockquote = lines.some((l) => l.trimStart().startsWith('> '));
  if (!hasBlockquote) issues.push('No blockquote summary found');

  // Check for heading-delimited sections (any heading level)
  const headingLines = lines.filter((l) => /^#{1,6}\s/.test(l));
  const hasSections = headingLines.length > 1; // H1 + at least one section heading
  if (!hasSections) issues.push('No heading-delimited sections found');

  // Extract and count links
  const links = extractMarkdownLinks(content);
  if (links.length === 0) issues.push('No markdown links found');

  return { url, hasH1, hasBlockquote, hasSections, linkCount: links.length, issues };
}

async function checkLlmsTxtValid(ctx: CheckContext): Promise<CheckResult> {
  const existsResult = ctx.previousResults.get('llms-txt-exists');
  const discovered = getLlmsTxtFilesForAnalysis(existsResult);

  if (discovered.length === 0) {
    return {
      id: 'llms-txt-valid',
      category: 'content-discoverability',
      status: 'skip',
      message: t('check.llms-txt-valid.skip_none'),
      dependsOn: ['llms-txt-exists'],
    };
  }

  const validations = discovered.map((f) => validateLlmsTxt(f.content, f.url));
  const details: Record<string, unknown> = { validations };

  // Determine overall status
  const allValid = validations.every(
    (v) => v.hasH1 && v.hasBlockquote && v.hasSections && v.linkCount > 0,
  );
  const anyLinks = validations.some((v) => v.linkCount > 0);

  if (allValid) {
    return {
      id: 'llms-txt-valid',
      category: 'content-discoverability',
      status: 'pass',
      message: t('check.llms-txt-valid.pass'),
      details,
    };
  }

  if (anyLinks) {
    const issuesSummary = validations
      .filter((v) => v.issues.length > 0)
      .map((v) => `${v.url}: ${v.issues.join(', ')}`)
      .join('; ');
    return {
      id: 'llms-txt-valid',
      category: 'content-discoverability',
      status: 'warn',
      message: t('check.llms-txt-valid.warn', { issues: issuesSummary }),
      details,
    };
  }

  return {
    id: 'llms-txt-valid',
    category: 'content-discoverability',
    status: 'fail',
    message: t('check.llms-txt-valid.fail'),
    details,
  };
}

registerCheck({
  id: 'llms-txt-valid',
  category: 'content-discoverability',
  description: 'Whether llms.txt follows the proposed structure from llmstxt.org',
  dependsOn: ['llms-txt-exists'],
  run: checkLlmsTxtValid,
});
