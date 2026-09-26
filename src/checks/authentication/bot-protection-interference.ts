import { registerCheck } from '../registry.js';
import { discoverAndSamplePages } from '../../helpers/get-page-urls.js';
import { fetchPage } from '../../helpers/fetch-page.js';
import { isFailedRecord, summarizeRequests } from '../../helpers/fetch-ledger.js';
import { describeNetworkContext } from '../../helpers/network-context.js';
import type { CheckContext, CheckResult, FetchRecord } from '../../types.js';

/**
 * Below this many observed requests the run is not a "sustained scan", so the
 * check performs one baseline pass over the sampled pages itself. This only
 * happens when the check runs alone (`--checks bot-protection-interference`);
 * in a full run the other checks supply far more evidence than this.
 */
export const MIN_REQUESTS_FOR_EVIDENCE = 5;

/**
 * Fail threshold: once interference has started, at least this fraction of
 * the remaining requests were challenged, stalled, or failed. The spec's fail
 * level is "most requests" after enforcement triggers.
 */
export const SUSTAINED_FAILURE_RATE = 0.5;

/** A post-onset window smaller than this cannot support a "sustained" verdict. */
export const MIN_POST_ONSET_REQUESTS = 5;

/**
 * Volume-correlation test. The ordered ledger is split into thirds; failures
 * are volume-correlated when the last third's failure rate is at least
 * VOLUME_LATE_FAILURE_RATE, at least VOLUME_RATE_MULTIPLIER times the first
 * third's rate, and backed by at least MIN_LATE_FAILURES events (so one
 * flaky request late in a short run does not trip it).
 */
export const VOLUME_LATE_FAILURE_RATE = 0.2;
export const VOLUME_RATE_MULTIPLIER = 3;
export const MIN_LATE_FAILURES = 2;
export const MIN_REQUESTS_FOR_VOLUME_TREND = 6;

/** How many example URLs of each kind to keep in details. */
const MAX_SAMPLE_URLS = 10;

function isInterference(r: FetchRecord): boolean {
  return r.outcome === 'stalled-body' || r.challenge !== undefined;
}

interface VolumeTrend {
  volumeCorrelated: boolean;
  earlyRequests: number;
  earlyFailures: number;
  lateRequests: number;
  lateFailures: number;
}

function analyzeVolumeTrend(records: readonly FetchRecord[]): VolumeTrend {
  const n = records.length;
  const third = Math.floor(n / 3);
  const early = records.slice(0, third);
  const late = records.slice(n - third);
  const earlyFailures = early.filter(isFailedRecord).length;
  const lateFailures = late.filter(isFailedRecord).length;
  const earlyRate = third > 0 ? earlyFailures / third : 0;
  const lateRate = third > 0 ? lateFailures / third : 0;

  const volumeCorrelated =
    n >= MIN_REQUESTS_FOR_VOLUME_TREND &&
    lateFailures >= MIN_LATE_FAILURES &&
    lateRate >= VOLUME_LATE_FAILURE_RATE &&
    lateRate >= earlyRate * VOLUME_RATE_MULTIPLIER;

  return {
    volumeCorrelated,
    earlyRequests: third,
    earlyFailures,
    lateRequests: third,
    lateFailures,
  };
}

function pluralize(n: number, singular: string, plural = `${singular}s`): string {
  return `${n} ${n === 1 ? singular : plural}`;
}

function describeKinds(stalled: number, challenged: number, errored: number): string {
  const parts: string[] = [];
  if (stalled > 0) parts.push(pluralize(stalled, 'stalled body', 'stalled bodies'));
  if (challenged > 0) parts.push(pluralize(challenged, 'challenge page'));
  if (errored > 0) parts.push(pluralize(errored, 'connection error'));
  return parts.join(', ');
}

/**
 * Standalone mode: with no other checks generating traffic there is nothing
 * to evaluate, so make one ordinary pass over the sampled pages at the
 * normal cadence. Errors are swallowed here because the ledger already
 * recorded them; that record is the evidence.
 */
async function baselineScan(ctx: CheckContext): Promise<string[]> {
  const { urls, warnings } = await discoverAndSamplePages(ctx);
  const concurrency = ctx.options.maxConcurrency;
  for (let i = 0; i < urls.length; i += concurrency) {
    await Promise.all(
      urls.slice(i, i + concurrency).map(async (url) => {
        try {
          await fetchPage(ctx, url);
        } catch {
          // recorded in the ledger
        }
      }),
    );
  }
  return warnings;
}

async function check(ctx: CheckContext): Promise<CheckResult> {
  const id = 'bot-protection-interference';
  const category = 'authentication';

  const ledger = ctx.fetchLedger;
  if (!ledger) {
    return {
      id,
      category,
      status: 'skip',
      message: 'No fetch ledger on this context; interference cannot be evaluated',
    };
  }

  let standaloneScan = false;
  let discoveryWarnings: string[] = [];
  if (ledger.records.length < MIN_REQUESTS_FOR_EVIDENCE) {
    standaloneScan = true;
    discoveryWarnings = await baselineScan(ctx);
  }

  const records = ledger.records;
  const summary = summarizeRequests(records);
  const networkContext = ctx.networkContext;
  const vantage = networkContext ? describeNetworkContext(networkContext) : undefined;

  if (summary.requests === 0) {
    return {
      id,
      category,
      status: 'skip',
      message: 'No HTTP requests were made during this run, so interference could not be evaluated',
      details: { requests: 0, standaloneScan, discoveryWarnings, networkContext },
    };
  }

  const trend = analyzeVolumeTrend(records);
  const interferenceEvents = summary.stalledBodies + summary.challengePages;
  const challengePagesServedAs200 = records.filter(
    (r) => r.challenge !== undefined && r.status !== null && r.status >= 200 && r.status < 300,
  ).length;

  const samples = {
    stalled: records
      .filter((r) => r.outcome === 'stalled-body')
      .slice(0, MAX_SAMPLE_URLS)
      .map((r) => r.url),
    challenged: records
      .filter((r) => r.challenge !== undefined)
      .slice(0, MAX_SAMPLE_URLS)
      .map((r) => ({ url: r.url, status: r.status, challenge: r.challenge })),
    errored: records
      .filter((r) => r.outcome === 'fetch-error')
      .slice(0, MAX_SAMPLE_URLS)
      .map((r) => ({ url: r.url, error: r.error })),
  };

  const thresholds = {
    sustainedFailureRate: SUSTAINED_FAILURE_RATE,
    minPostOnsetRequests: MIN_POST_ONSET_REQUESTS,
    volumeLateFailureRate: VOLUME_LATE_FAILURE_RATE,
    volumeRateMultiplier: VOLUME_RATE_MULTIPLIER,
  };

  const baseDetails = {
    requests: summary.requests,
    stalledBodies: summary.stalledBodies,
    challengePages: summary.challengePages,
    challengePagesServedAs200,
    fetchErrors: summary.fetchErrors,
    failedRequests: summary.failed,
    failureRate: summary.failureRate,
    volumeCorrelated: trend.volumeCorrelated,
    volumeTrend: trend,
    samples,
    standaloneScan,
    networkContext,
    thresholds,
    discoveryWarnings,
  };

  // Pass: nothing definitive and no volume-correlated failure trend. Generic
  // fetch errors on their own are ordinary flakiness, not interference.
  if (interferenceEvents === 0 && !trend.volumeCorrelated) {
    const errorNote =
      summary.fetchErrors > 0
        ? `; ${summary.fetchErrors} failed to fetch (not volume-correlated)`
        : '';
    return {
      id,
      category,
      status: 'pass',
      message: `No bot-protection interference observed across ${pluralize(summary.requests, 'request')}${errorNote}`,
      details: { ...baseDetails, onsetRequest: null, postOnsetFailureRate: null },
    };
  }

  // Onset: the first definitive interference event; or, for a purely
  // volume-correlated pattern, the first failure past the early third.
  let onsetIndex = records.findIndex(isInterference);
  if (onsetIndex === -1) {
    const earlyCutoff = trend.earlyRequests;
    onsetIndex = records.findIndex((r, i) => i >= earlyCutoff && isFailedRecord(r));
  }
  const postOnset = records.slice(onsetIndex);
  const postOnsetFailures = postOnset.filter(isFailedRecord).length;
  const postOnsetFailureRate = postOnset.length > 0 ? postOnsetFailures / postOnset.length : 0;

  const sustained =
    summary.failed / summary.requests >= SUSTAINED_FAILURE_RATE ||
    (postOnset.length >= MIN_POST_ONSET_REQUESTS && postOnsetFailureRate >= SUSTAINED_FAILURE_RATE);

  const vantageNote = vantage ? `; scanned from ${vantage}` : '';
  const kinds = describeKinds(summary.stalledBodies, summary.challengePages, summary.fetchErrors);

  let message: string;
  if (sustained) {
    message =
      `Sustained interference: after request #${records[onsetIndex].seq}, ` +
      `${postOnsetFailures} of ${postOnset.length} requests (${Math.round(postOnsetFailureRate * 100)}%) ` +
      `were challenged, stalled, or failed (${kinds})${vantageNote}`;
  } else if (interferenceEvents > 0) {
    message =
      `Intermittent interference: ${summary.failed} of ${summary.requests} requests ` +
      `were challenged, stalled, or failed (${kinds})${vantageNote}`;
  } else {
    message =
      `Failures climbed as the scan progressed: ${trend.earlyFailures} of ${trend.earlyRequests} early requests failed ` +
      `vs ${trend.lateFailures} of ${trend.lateRequests} late requests ` +
      `(no challenge pages or stalled bodies observed)${vantageNote}`;
  }

  return {
    id,
    category,
    status: sustained ? 'fail' : 'warn',
    message,
    details: {
      ...baseDetails,
      onsetRequest: records[onsetIndex].seq,
      postOnsetRequests: postOnset.length,
      postOnsetFailures,
      postOnsetFailureRate: Math.round(postOnsetFailureRate * 100),
    },
  };
}

registerCheck({
  id: 'bot-protection-interference',
  category: 'authentication',
  description:
    'Whether bot-protection systems interfere with automated fetching of documentation content',
  dependsOn: [],
  run: check,
});
