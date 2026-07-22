#!/usr/bin/env node
// Only install git hooks when developing this repo (has .git + husky).
// Skip for git/npm consumers so `prepare` can focus on `npm run build`.
import process from 'node:process';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
if (!existsSync(join(root, '.git'))) process.exit(0);

const result = spawnSync('npx', ['husky'], {
  cwd: root,
  stdio: 'inherit',
  shell: process.platform === 'win32',
});
process.exit(result.status ?? 0);
