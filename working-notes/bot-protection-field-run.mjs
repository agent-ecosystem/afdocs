#!/usr/bin/env node
/* global process, console, setTimeout, URL */
// Field harness for bot-protection-interference. Run each site ONCE, save
// the full fetch ledger, and do all tuning offline against the saved files.
//
//   node working-notes/bot-protection-field-run.mjs run <slug> <url> <outdir>
//   grep -v '^#' working-notes/bot-protection-sites.txt | grep -v '^\s*$' \
//     | xargs -P 6 -L 1 sh -c 'node working-notes/bot-protection-field-run.mjs run "$0" "$1" bot-results'
//   node working-notes/bot-protection-field-run.mjs analyze <outdir>   # table + samples
//   node working-notes/bot-protection-field-run.mjs rescore <outdir>   # re-run the check on saved ledgers
//
// Requires `npm run build` first (imports from dist/). <outdir> should be
// gitignored (bot-results/ at the repo root is a fine choice).
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const repo = resolve(new URL('..', import.meta.url).pathname);
const { createContext } = await import(`${repo}/dist/runner.js`);
const { getChecksSorted, getCheck } = await import(`${repo}/dist/checks/index.js`);
const { summarizeRequests } = await import(`${repo}/dist/helpers/fetch-ledger.js`);

const [mode, ...args] = process.argv.slice(2);

async function run(slug, url, outdir) {
  const started = Date.now();
  const results = [];
  let ctx;
  const dump = (partial) => {
    writeFileSync(
      `${outdir}/${slug}.json`,
      JSON.stringify(
        {
          slug,
          url,
          partial,
          elapsedMs: Date.now() - started,
          requestSummary: ctx ? summarizeRequests(ctx.fetchLedger.records) : null,
          networkContext: ctx?.networkContext,
          results,
          records: ctx ? ctx.fetchLedger.records : [],
        },
        null,
        1,
      ),
    );
  };
  setTimeout(
    () => {
      process.stderr.write(`${slug}: wall-clock cap hit, dumping partial\n`);
      dump(true);
      process.exit(2);
    },
    12 * 60 * 1000,
  ).unref();

  const normalize = (deps) =>
    deps.length === 0 ? [] : typeof deps[0] === 'string' ? deps.map((d) => [d]) : deps;
  const depsMet = (deps, prev) =>
    normalize(deps).every((g) => g.some((id) => ['pass', 'warn'].includes(prev.get(id)?.status)));

  ctx = createContext(url, {
    requestDelay: 200,
    maxLinksToTest: 20,
    samplingStrategy: 'deterministic',
  });
  for (const check of getChecksSorted()) {
    const t0 = Date.now();
    let r;
    const anyDepRan = normalize(check.dependsOn).some((g) =>
      g.some((id) => ctx.previousResults.has(id)),
    );
    if (check.dependsOn.length > 0 && anyDepRan && !depsMet(check.dependsOn, ctx.previousResults)) {
      r = {
        id: check.id,
        category: check.category,
        status: 'skip',
        message: 'dependency did not pass',
      };
    } else {
      ctx.fetchLedger.currentCheckId = check.id;
      try {
        r = await check.run(ctx);
      } catch (e) {
        r = {
          id: check.id,
          category: check.category,
          status: 'error',
          message: String(e?.message ?? e),
        };
      }
      ctx.fetchLedger.currentCheckId = undefined;
    }
    ctx.previousResults.set(check.id, r);
    results.push({ ...r, durationMs: Date.now() - t0 });
    process.stderr.write(
      `${slug.padEnd(14)} ${check.id.padEnd(30)} ${r.status.padEnd(5)} ${Date.now() - t0}ms  reqs=${ctx.fetchLedger.records.length}\n`,
    );
  }
  dump(false);
}

function load(dir) {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => JSON.parse(readFileSync(`${dir}/${f}`, 'utf8')));
}

function analyze(dir) {
  const pad = (s, n) => String(s).padEnd(n);
  console.log(
    pad('site', 15) +
      pad('st', 6) +
      pad('secs', 6) +
      pad('reqs', 6) +
      pad('blk', 5) +
      pad('chal', 5) +
      pad('stl', 4) +
      pad('err', 4) +
      pad('vol', 4) +
      pad('failTrend', 16) +
      pad('blockTrend', 16) +
      'status histogram',
  );
  const detail = [];
  for (const d of load(dir)) {
    const recs = d.records ?? [];
    const hist = {};
    for (const r of recs) {
      const k = r.outcome === 'ok' ? String(r.status) : r.outcome;
      hist[k] = (hist[k] ?? 0) + 1;
    }
    const bot = d.results.find((r) => r.id === 'bot-protection-interference');
    const det = bot?.details ?? {};
    const trend = (t) =>
      t
        ? `${t.earlyEvents}/${t.earlyRequests}→${t.lateEvents}/${t.lateRequests} s${t.lateChecksSpanned}`
        : '';
    const challenged = recs.filter((r) => r.challenge);
    const stalled = recs.filter((r) => r.outcome === 'stalled-body');
    const errored = recs.filter((r) => r.outcome === 'fetch-error');
    const blocked = recs.filter((r) => r.blocked);
    console.log(
      pad(d.slug + (d.partial ? '*' : ''), 15) +
        pad(bot?.status ?? '-', 6) +
        pad(Math.round(d.elapsedMs / 1000), 6) +
        pad(recs.length, 6) +
        pad(blocked.length, 5) +
        pad(challenged.length, 5) +
        pad(stalled.length, 4) +
        pad(errored.length, 4) +
        pad(det.volumeCorrelated ? 'Y' : 'n', 4) +
        pad(trend(det.failureTrend), 16) +
        pad(trend(det.blockTrend), 16) +
        Object.entries(hist)
          .sort((a, b) => b[1] - a[1])
          .map(([k, v]) => `${k}:${v}`)
          .join(' '),
    );
    if (
      bot?.status !== 'pass' ||
      challenged.length ||
      stalled.length ||
      blocked.length ||
      errored.length
    ) {
      detail.push(`--- ${d.slug}: ${bot?.status}: ${bot?.message}`);
      const by = (rs) =>
        JSON.stringify(
          rs.reduce((m, r) => ((m[r.checkId ?? '?'] = (m[r.checkId ?? '?'] ?? 0) + 1), m), {}),
        );
      if (blocked.length) detail.push(`   denied by check: ${by(blocked)}`);
      if (errored.length) detail.push(`   errors by check: ${by(errored)}`);
      for (const c of challenged.slice(0, 6))
        detail.push(`   CHAL ${c.status} [${c.checkId}] ${c.challenge}: ${c.url}`);
      for (const s of stalled.slice(0, 6)) detail.push(`   STALL [${s.checkId}] ${s.url}`);
      for (const e of errored.slice(0, 4))
        detail.push(`   ERR [${e.checkId}] ${e.url} :: ${e.error?.slice(0, 80)}`);
    }
  }
  console.log('');
  for (const line of detail) console.log(line);
}

async function rescore(dir) {
  const check = getCheck('bot-protection-interference');
  for (const d of load(dir)) {
    if (!d.records?.length) continue;
    const ctx = createContext(d.url, { requestDelay: 0 });
    ctx.networkContext = { classification: 'developer-machine', source: 'environment' };
    for (const r of d.records) ctx.fetchLedger.onRecord(r);
    const res = await check.run(ctx);
    const det = res.details ?? {};
    const extra =
      res.status === 'pass'
        ? det.limitedEvidence
          ? ' [limited]'
          : ''
        : ` affected=${JSON.stringify(det.affectedChecks)}`;
    console.log(
      `${d.slug.padEnd(15)} ${res.status.padEnd(5)} ${res.message.slice(0, 150)}${extra}`,
    );
  }
}

if (mode === 'run') await run(args[0], args[1], args[2] ?? 'bot-results');
else if (mode === 'analyze') analyze(args[0] ?? 'bot-results');
else if (mode === 'rescore') await rescore(args[0] ?? 'bot-results');
else {
  console.error('usage: run <slug> <url> [outdir] | analyze [outdir] | rescore [outdir]');
  process.exit(1);
}
