import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { AgentDocsConfig, PageConfigEntry } from '../types.js';
import { validateNumber } from '../validation.js';
import { VALID_SAMPLING_STRATEGIES, VALID_URL_PATH_PATTERNS } from '../constants.js';

const CONFIG_FILENAMES = ['agent-docs.config.yml', 'agent-docs.config.yaml'];

/**
 * Validate the `pages` field in a config file.
 * Each entry must be a valid URL string or an object with a valid `url` and optional `tag`.
 */
function assertPagesArray(pages: unknown, source: string): asserts pages is unknown[] {
  if (!Array.isArray(pages)) {
    throw new Error(`${source}: "pages" must be an array of URLs or { url, tag? } objects`);
  }
}

export function validatePages(pages: unknown[], source: string): void {
  for (let i = 0; i < pages.length; i++) {
    const entry = pages[i] as PageConfigEntry;
    if (typeof entry === 'string') {
      try {
        new URL(entry);
      } catch {
        throw new Error(`${source}: pages[${i}] is not a valid URL: ${entry}`);
      }
    } else if (typeof entry === 'object' && entry !== null && typeof entry.url === 'string') {
      try {
        new URL(entry.url);
      } catch {
        throw new Error(`${source}: pages[${i}].url is not a valid URL: ${entry.url}`);
      }
      if (entry.tag !== undefined && typeof entry.tag !== 'string') {
        throw new Error(`${source}: pages[${i}].tag must be a string`);
      }
    } else {
      throw new Error(`${source}: pages[${i}] must be a URL string or { url, tag? } object`);
    }
  }
}

/**
 * Validate that a config field is a flat array of strings.
 * Catches the common YAML mistake of unquoted values containing special
 * characters (e.g., `[data-foo]` parsed as a nested array instead of a string).
 */
function validateStringArray(value: unknown, field: string, source: string): void {
  if (!Array.isArray(value)) {
    throw new Error(`${source}: "${field}" must be an array of strings`);
  }
  for (let i = 0; i < value.length; i++) {
    if (typeof value[i] !== 'string') {
      throw new Error(
        `${source}: ${field}[${i}] must be a string, got ${typeof value[i]}. ` +
          'If the value contains [ or *, wrap it in quotes.',
      );
    }
  }
}

const NUMERIC_OPTION_RULES: [string, { integer?: boolean; min?: number; max?: number }][] = [
  ['maxConcurrency', { integer: true, min: 1, max: 100 }],
  ['requestDelay', { integer: true, min: 0 }],
  ['requestTimeout', { integer: true, min: 0 }],
  ['maxLinksToTest', { integer: true, min: 1 }],
  ['coveragePassThreshold', { integer: true, min: 0, max: 100 }],
  ['coverageWarnThreshold', { integer: true, min: 0, max: 100 }],
  ['parityPassThreshold', { integer: true, min: 0, max: 100 }],
  ['parityWarnThreshold', { integer: true, min: 0, max: 100 }],
];

function validateOptions(options: Record<string, unknown>, source: string): void {
  if (options.coverageExclusions != null) {
    validateStringArray(options.coverageExclusions, 'options.coverageExclusions', source);
  }
  if (options.parityExclusions != null) {
    validateStringArray(options.parityExclusions, 'options.parityExclusions', source);
  }
  if (
    options.samplingStrategy != null &&
    !VALID_SAMPLING_STRATEGIES.includes(
      options.samplingStrategy as string as (typeof VALID_SAMPLING_STRATEGIES)[number],
    )
  ) {
    throw new Error(
      `${source}: options.samplingStrategy must be one of: ${VALID_SAMPLING_STRATEGIES.join(', ')}`,
    );
  }
  if (
    options.urlPathPattern != null &&
    !VALID_URL_PATH_PATTERNS.includes(
      options.urlPathPattern as string as (typeof VALID_URL_PATH_PATTERNS)[number],
    )
  ) {
    throw new Error(
      `${source}: options.urlPathPattern must be one of: ${VALID_URL_PATH_PATTERNS.join(', ')}`,
    );
  }
  for (const [field, constraints] of NUMERIC_OPTION_RULES) {
    if (options[field] != null) {
      const issue = validateNumber(options[field], `options.${field}`, constraints);
      if (issue) {
        throw new Error(`${source}: ${issue.message}`);
      }
    }
  }
  if (options.thresholds != null) {
    const thresholds = options.thresholds as Record<string, unknown>;
    if (thresholds.pass != null) {
      const issue = validateNumber(thresholds.pass, 'options.thresholds.pass', {
        integer: true,
        min: 1,
      });
      if (issue) throw new Error(`${source}: ${issue.message}`);
    }
    if (thresholds.fail != null) {
      const issue = validateNumber(thresholds.fail, 'options.thresholds.fail', {
        integer: true,
        min: 1,
      });
      if (issue) throw new Error(`${source}: ${issue.message}`);
    }
  }
}

function validateConfig(parsed: AgentDocsConfig, source: string): void {
  if (parsed.checks != null) {
    validateStringArray(parsed.checks, 'checks', source);
  }
  if (parsed.skipChecks != null) {
    validateStringArray(parsed.skipChecks, 'skipChecks', source);
  }
  if (parsed.pages) {
    assertPagesArray(parsed.pages, source);
    validatePages(parsed.pages, source);
  }
  if (parsed.options) {
    validateOptions(parsed.options as Record<string, unknown>, source);
  }
}

/**
 * Search for an agent-docs config file starting from `dir` and walking up
 * to the filesystem root (like eslint, prettier, etc.).
 * If `dir` is omitted, starts from `process.cwd()`.
 */
export async function loadConfig(dir?: string): Promise<AgentDocsConfig> {
  let searchDir = resolve(dir ?? process.cwd());

  while (true) {
    for (const filename of CONFIG_FILENAMES) {
      const filepath = resolve(searchDir, filename);
      try {
        const content = await readFile(filepath, 'utf-8');
        const parsed = parseYaml(content) as AgentDocsConfig;
        if (!parsed.url) {
          throw new Error(`Config file ${filepath} is missing required "url" field`);
        }
        validateConfig(parsed, filepath);
        return parsed;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw err;
      }
    }

    const parent = dirname(searchDir);
    if (parent === searchDir) break; // reached filesystem root
    searchDir = parent;
  }

  throw new Error(
    `No agent-docs config file found. Create ${CONFIG_FILENAMES[0]} with at least a "url" field.`,
  );
}

/**
 * CLI-oriented config loader:
 * - If explicitPath is given, reads that file directly and throws if not found.
 * - Otherwise, auto-discovers by walking up from startDir (default: cwd).
 * - Returns null if no config file is found (instead of throwing).
 * - Does not require the "url" field — the CLI can supply it via argument.
 */
export async function findConfig(
  explicitPath?: string,
  startDir?: string,
): Promise<AgentDocsConfig | null> {
  if (explicitPath) {
    const filepath = resolve(process.cwd(), explicitPath);
    const content = await readFile(filepath, 'utf-8');
    const parsed = parseYaml(content) as AgentDocsConfig;
    validateConfig(parsed, filepath);
    return parsed;
  }

  let searchDir = resolve(startDir ?? process.cwd());
  while (true) {
    for (const filename of CONFIG_FILENAMES) {
      const filepath = resolve(searchDir, filename);
      try {
        const content = await readFile(filepath, 'utf-8');
        const parsed = parseYaml(content) as AgentDocsConfig;
        validateConfig(parsed, filepath);
        return parsed;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw err;
      }
    }
    const parent = dirname(searchDir);
    if (parent === searchDir) break;
    searchDir = parent;
  }

  return null;
}
