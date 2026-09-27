#!/usr/bin/env node
/**
 * Keep in-repo references to a *published* afdocs version in step with
 * package.json.
 *
 * Two modes:
 *   (no flags)  report drift and exit 1
 *   --fix       rewrite the references
 *
 * `npm version` runs the --fix pass through the "version" lifecycle script, so
 * a release bump carries the updated references in the same commit. CI and
 * prepublishOnly run the check as a guard for anything added by hand.
 *
 * This covers this repository only. The spec site pins afdocs in
 * agent-docs-spec/site/package.json and has to be bumped in its own repo.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const shouldFix = process.argv.includes('--fix');

const { version } = JSON.parse(readFileSync(resolve(repoRoot, 'package.json'), 'utf8'));

/**
 * Paths whose version mentions are historical on purpose and must not be
 * rewritten: upgrade guides name the version they upgrade to, design notes
 * name the version they were written against, and the rest is saved output.
 */
const EXCLUDED = [
  /(^|\/)package-lock\.json$/,
  /^docs\/migration\//,
  /^working-notes\//,
  /^bot-results\//,
];

/**
 * Each rule matches one shape of version reference. The match is split into a
 * prefix to keep and the version text to replace, so neither pattern needs to
 * consume the delimiter that follows it.
 *
 * The dependency range requires a leading digit or range operator, which keeps
 * the root package.json's `"afdocs": "bin/afdocs.mjs"` bin entry out of scope.
 */
const RULES = [
  {
    name: 'dependency range',
    pattern: /("afdocs"\s*:\s*")([\^~]?\d[^"]*)/g,
    expected: `^${version}`,
  },
  {
    name: 'pinned install',
    pattern: /(afdocs@)(\d[^\s`'")]*)/g,
    expected: version,
  },
];

const files = execFileSync('git', ['ls-files', '-z'], { cwd: repoRoot, encoding: 'utf8' })
  .split('\0')
  .filter(Boolean)
  .filter((file) => !EXCLUDED.some((pattern) => pattern.test(file)));

const drift = [];
const rewritten = [];

for (const file of files) {
  const path = resolve(repoRoot, file);
  let content;
  try {
    content = readFileSync(path, 'utf8');
  } catch {
    continue; // unreadable or binary; no version references to find
  }
  if (content.includes('\0')) continue;

  let updated = content;
  for (const rule of RULES) {
    updated = updated.replace(rule.pattern, (match, prefix, found, offset, whole) => {
      if (found === rule.expected) return match;
      const line = whole.slice(0, offset).split('\n').length;
      drift.push({ file, line, rule: rule.name, found, expected: rule.expected });
      return `${prefix}${rule.expected}`;
    });
  }

  if (updated !== content && shouldFix) {
    writeFileSync(path, updated);
    rewritten.push(file);
  }
}

if (drift.length === 0) {
  console.log(`afdocs version references are in step with package.json (${version}).`);
  process.exit(0);
}

for (const item of drift) {
  const label = shouldFix ? 'Updated' : 'Stale';
  console.log(
    `${label} ${item.rule} in ${item.file}:${item.line}: ${item.found} -> ${item.expected}`,
  );
}

if (shouldFix) {
  console.log(`\nRewrote ${rewritten.length} file(s) to afdocs ${version}.`);
  if (process.env.npm_lifecycle_event === 'version') {
    console.log('They are part of the version bump, so commit them with it.');
  }
  process.exit(0);
}

console.log(
  `\n${drift.length} stale reference(s). Run 'npm run version:sync' to update them, ` +
    `or let 'npm version' do it on the next release.`,
);
process.exit(1);
