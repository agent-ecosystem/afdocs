import chalk from 'chalk';
import type { ReportResult } from '../../types.js';
import type { ScoreResult, Diagnostic } from '../../scoring/types.js';
import { computeScore } from '../../scoring/index.js';
import { CATEGORIES, SPEC_BASE_URL } from '../../constants.js';
import { describeNetworkContext } from '../../helpers/network-context.js';

const STATUS_LABELS: Record<string, string> = {
  pass: 'PASS',
  warn: 'WARN',
  fail: 'FAIL',
  skip: 'SKIP',
  error: 'ERR ',
};

const STATUS_COLORS: Record<string, (s: string) => string> = {
  pass: chalk.green,
  warn: chalk.yellow,
  fail: chalk.red,
  skip: chalk.gray,
  error: chalk.red,
};

const GRADE_COLORS: Record<string, (s: string) => string> = {
  'A+': chalk.green,
  A: chalk.green,
  B: chalk.green,
  C: chalk.yellow,
  D: chalk.red,
  F: chalk.red,
};

const SEVERITY_ICONS: Record<string, string> = {
  critical: chalk.red('[!]'),
  warning: chalk.yellow('[!]'),
  info: chalk.blue('[i]'),
};

function gradeColor(grade: string): (s: string) => string {
  return GRADE_COLORS[grade] ?? ((s: string) => s);
}

function formatLocalTime(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}

function formatCategoryLine(name: string, score: number | null, grade: string | null): string {
  const paddedName = name.padEnd(36);
  if (score === null) {
    return `    ${paddedName} ${chalk.dim('–'.padStart(9))} ${chalk.dim('(N/A)')}`;
  }
  const scoreStr = `${score} / 100`;
  const coloredGrade = gradeColor(grade!)(`(${grade})`);
  return `    ${paddedName} ${scoreStr.padStart(9)} ${coloredGrade}`;
}

function formatDiagnostic(diag: Diagnostic): string[] {
  const icon = SEVERITY_ICONS[diag.severity] ?? '[?]';
  const lines: string[] = [];
  // Extract first sentence for heading. Split on ". " (period + space) rather than
  // bare "." to avoid breaking on file extensions like .md or llms.txt.
  const firstSentenceEnd = diag.message.indexOf('. ');
  const heading = firstSentenceEnd !== -1 ? diag.message.slice(0, firstSentenceEnd) : diag.message;
  lines.push(`    ${icon} ${chalk.bold(heading)}`);

  // Full message as detail text
  const fullMsg = diag.message;
  lines.push(`        ${chalk.dim(fullMsg)}`);
  lines.push('');
  lines.push(`        ${chalk.cyan('Fix:')} ${diag.resolution}`);

  return lines;
}

export function formatScorecard(report: ReportResult, scoreResult?: ScoreResult): string {
  const score = scoreResult ?? computeScore(report);
  const lines: string[] = [];

  // Header
  lines.push('');
  lines.push(chalk.bold('Agent-Friendly Docs Scorecard'));
  lines.push(chalk.bold('=============================='));
  lines.push('');
  lines.push(chalk.gray(`${report.url} · ${formatLocalTime(report.timestamp)}`));
  if (report.networkContext) {
    lines.push(chalk.gray(`Scanned from ${describeNetworkContext(report.networkContext)}`));
  }
  lines.push('');

  // Overall score
  const overallColor = gradeColor(score.grade);
  lines.push(
    `  ${chalk.bold('Overall Score:')} ${overallColor(`${score.overall} / 100`)} ${overallColor(`(${score.grade})`)}`,
  );

  if (score.cap) {
    lines.push(`  ${chalk.dim(`(Capped: ${score.cap.checkId} — ${score.cap.reason})`)}`);
  }

  lines.push('');

  // Category scores
  lines.push(`  ${chalk.bold('Category Scores:')}`);
  for (const cat of CATEGORIES) {
    const catScore = score.categoryScores[cat.id];
    if (catScore) {
      lines.push(formatCategoryLine(cat.name, catScore.score, catScore.grade));
    }
  }
  lines.push('');

  // Tag scores (when curated pages have tags)
  if (score.tagScores) {
    lines.push(`  ${chalk.bold('Tag Scores:')}`);
    const sortedTags = Object.entries(score.tagScores).sort(([a], [b]) => a.localeCompare(b));
    for (const [tag, tagScore] of sortedTags) {
      lines.push(
        formatCategoryLine(tag, tagScore.score, tagScore.grade) +
          chalk.dim(` · ${tagScore.pageCount} page${tagScore.pageCount !== 1 ? 's' : ''}`),
      );

      // Show checks that aren't fully passing
      const issues = tagScore.checks.filter((c) => c.proportion < 1);
      for (const check of issues) {
        const counts = { pass: 0, warn: 0, fail: 0 };
        for (const p of check.pages) {
          if (p.status in counts) counts[p.status as keyof typeof counts]++;
        }
        const parts: string[] = [];
        if (counts.fail > 0) parts.push(chalk.red(`${counts.fail} fail`));
        if (counts.warn > 0) parts.push(chalk.yellow(`${counts.warn} warn`));
        if (counts.pass > 0) parts.push(chalk.green(`${counts.pass} pass`));
        const worstStatus = counts.fail > 0 ? 'fail' : 'warn';
        const label = STATUS_LABELS[worstStatus];
        const color = STATUS_COLORS[worstStatus];
        lines.push(`      ${color(label)}  ${check.checkId.padEnd(30)} ${parts.join(', ')}`);
      }
    }
    lines.push('');
  }

  // Interaction diagnostics
  if (score.diagnostics.length > 0) {
    lines.push(`  ${chalk.bold('Interaction Diagnostics:')}`);
    for (const diag of score.diagnostics) {
      lines.push(...formatDiagnostic(diag));
      lines.push('');
    }
  }

  // Check results grouped by category
  lines.push(`  ${chalk.bold('Check Results:')}`);
  lines.push('');

  const byCategory = new Map<string, typeof report.results>();
  for (const result of report.results) {
    const existing = byCategory.get(result.category) ?? [];
    existing.push(result);
    byCategory.set(result.category, existing);
  }

  for (const cat of CATEGORIES) {
    const results = byCategory.get(cat.id);
    if (!results) continue;

    lines.push(`    ${chalk.bold.underline(cat.name)}`);
    for (const result of results) {
      const label = STATUS_LABELS[result.status] ?? '????';
      const color = STATUS_COLORS[result.status] ?? ((s: string) => s);
      const partial = score.checkScores[result.id]?.partialSample
        ? chalk.dim(' (partial sample)')
        : '';
      lines.push(`      ${color(label)}  ${result.id.padEnd(30)} ${result.message}${partial}`);

      // Resolution text for warn/fail
      const resolution = score.resolutions[result.id];
      if (resolution) {
        lines.push(`            ${chalk.cyan('Fix:')} ${resolution}`);
      }
    }
    lines.push('');
  }

  // Footer
  lines.push(chalk.dim(`Full spec: ${SPEC_BASE_URL}`));
  lines.push('');

  return lines.join('\n');
}
