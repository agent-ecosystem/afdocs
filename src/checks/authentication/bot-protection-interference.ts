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

/** A pass on fewer requests than this says so: it is weak evidence of absence. */
export const LIMITED_EVIDENCE_REQUESTS = 20;

/**
 * Fail threshold: once interference has started, at least this fraction of
 * the remaining requests were challenged, stalled, or failed. The spec's fail
 * level is "most requests" after enforcement triggers.
 */
export const SUSTAINED_FAILURE_RATE = 0.5;

/**
 * A "sustained" verdict needs a post-onset window of at least this many
 * requests and at least MIN_POST_ONSET_FAILURES failures in it. A handful
 * of stalls at the very tail of a run is the onset signature, but the run
 * ended before it could show whether enforcement stayed engaged; that is a
 * warn, not a fail.
 */
export const MIN_POST_ONSET_REQUESTS = 10;
export const MIN_POST_ONSET_FAILURES = 5;

/**
 * Volume-correlation test. The ordered ledger is split into thirds; events
 * are volume-correlated when the last third's rate is at least
 * VOLUME_LATE_FAILURE_RATE, at least VOLUME_RATE_MULTIPLIER times the first
 * third's rate, backed by at least MIN_LATE_FAILURES events, and (outside
 * standalone mode) spread across at least MIN_CHECKS_SPANNED checks. The
 * span rule keeps one check's URL class (fabricated 404 probes, `.md`
 * variants) from looking like enforcement engaging.
 */
export const VOLUME_LATE_FAILURE_RATE = 0.2;
export const VOLUME_RATE_MULTIPLIER = 3;
export const MIN_LATE_FAILURES = 2;
export const MIN_REQUESTS_FOR_VOLUME_TREND = 6;
export const MIN_CHECKS_SPANNED = 2;

/** How many example URLs of each kind to keep in details. */
const MAX_SAMPLE_URLS = 10;

/** Definitive interference: the tarpit or challenge signature itself. */
function isInterference(r: FetchRecord): boolean {
  return r.outcome === 'stalled-body' || r.challenge !== undefined;
}

interface Trend {
  correlated: boolean;
  earlyRequests: number;
  earlyEvents: number;
  lateRequests: number;
  lateEvents: number;
  /** Distinct checks whose requests produced the late events. */
  lateChecksSpanned: number;
}

function analyzeTrend(
  records: readonly FetchRecord[],
  isEvent: (r: FetchRecord) => boolean,
  requireSpan: boolean,
): Trend {
  const n = records.length;
  const third = Math.floor(n / 3);
  const early = records.slice(0, third);
  const late = records.slice(n - third);
  const earlyEvents = early.filter(isEvent).length;
  const lateEventRecords = late.filter(isEvent);
  const lateEvents = lateEventRecords.length;
  const earlyRate = third > 0 ? earlyEvents / third : 0;
  const lateRate = third > 0 ? lateEvents / third : 0;
  const lateChecksSpanned = new Set(lateEventRecords.map((r) => r.checkId ?? '(unattributed)'))
    .size;

  const correlated =
    n >= MIN_REQUESTS_FOR_VOLUME_TREND &&
    lateEvents >= MIN_LATE_FAILURES &&
    lateRate >= VOLUME_LATE_FAILURE_RATE &&
    lateRate >= earlyRate * VOLUME_RATE_MULTIPLIER &&
    (!requireSpan || lateChecksSpanned >= MIN_CHECKS_SPANNED);

  return {
    correlated,
    earlyRequests: third,
    earlyEvents,
    lateRequests: third,
    lateEvents,
    lateChecksSpanned,
  };
}

function pluralize(n: number, singular: string, plural = `${singular}s`): string {
  return `${n} ${n === 1 ? singular : plural}`;
}

function describeKinds(
  stalled: number,
  challenged: number,
  errored: number,
  blocked: number,
): string {
  const parts: string[] = [];
  if (stalled > 0) parts.push(pluralize(stalled, 'stalled body', 'stalled bodies'));
  if (challenged > 0) parts.push(pluralize(challenged, 'challenge page'));
  if (errored > 0) parts.push(pluralize(errored, 'connection error'));
  if (blocked > 0) parts.push(pluralize(blocked, 'denied response'));
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

  // In standalone mode every request belongs to this check, so the
  // cross-check span rule would suppress every trend; order is volume there.
  const requireSpan = !standaloneScan;
  const failureTrend = analyzeTrend(records, isFailedRecord, requireSpan);
  const blockTrend = analyzeTrend(records, (r) => r.blocked === true, requireSpan);

  // Denied responses (403/503, unhonored 429) count as failures only when
  // the block rate climbed during the scan. An auth-gated site is denied
  // from its first request and belongs to auth-gate-detection.
  const blockCorrelated = blockTrend.correlated;
  const isFailure = (r: FetchRecord): boolean =>
    isFailedRecord(r) || (blockCorrelated && r.blocked === true);
  const volumeCorrelated = failureTrend.correlated || blockCorrelated;

  const blockedResponses = records.filter((r) => r.blocked === true).length;
  const interferenceEvents = summary.stalledBodies + summary.challengePages;
  const failed = records.filter(isFailure).length;
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
    denied: records
      .filter((r) => r.blocked === true)
      .slice(0, MAX_SAMPLE_URLS)
      .map((r) => ({ url: r.url, status: r.status })),
  };

  const thresholds = {
    sustainedFailureRate: SUSTAINED_FAILURE_RATE,
    minPostOnsetRequests: MIN_POST_ONSET_REQUESTS,
    minPostOnsetFailures: MIN_POST_ONSET_FAILURES,
    volumeLateFailureRate: VOLUME_LATE_FAILURE_RATE,
    volumeRateMultiplier: VOLUME_RATE_MULTIPLIER,
    minChecksSpanned: requireSpan ? MIN_CHECKS_SPANNED : 1,
    limitedEvidenceRequests: LIMITED_EVIDENCE_REQUESTS,
  };

  const baseDetails = {
    requests: summary.requests,
    stalledBodies: summary.stalledBodies,
    challengePages: summary.challengePages,
    challengePagesServedAs200,
    fetchErrors: summary.fetchErrors,
    blockedResponses,
    failedRequests: failed,
    failureRate: Math.round((failed / summary.requests) * 100),
    volumeCorrelated,
    failureTrend,
    blockTrend,
    samples,
    standaloneScan,
    limitedEvidence: summary.requests < LIMITED_EVIDENCE_REQUESTS,
    networkContext,
    thresholds,
    discoveryWarnings,
  };

  // Pass: nothing definitive and no volume-correlated trend. Plain fetch
  // errors and steady 403s on their own are flakiness and auth gating.
  if (interferenceEvents === 0 && !volumeCorrelated) {
    const notes: string[] = [];
    if (summary.fetchErrors > 0) {
      notes.push(`${summary.fetchErrors} failed to fetch (not volume-correlated)`);
    }
    if (summary.requests < LIMITED_EVIDENCE_REQUESTS) {
      notes.push(`limited evidence: only ${pluralize(summary.requests, 'request')} observed`);
    }
    const suffix = notes.length > 0 ? `; ${notes.join('; ')}` : '';
    return {
      id,
      category,
      status: 'pass',
      message: `No bot-protection interference observed across ${pluralize(summary.requests, 'request')}${suffix}`,
      details: { ...baseDetails, onsetRequest: null, postOnsetFailureRate: null },
    };
  }

  // Onset: the first definitive interference event; or, for a purely
  // trend-based pattern, the first failure past the early third.
  let onsetIndex = records.findIndex(isInterference);
  if (onsetIndex === -1) {
    const earlyCutoff = failureTrend.earlyRequests;
    onsetIndex = records.findIndex((r, i) => i >= earlyCutoff && isFailure(r));
  }
  const postOnset = records.slice(onsetIndex);
  const postOnsetFailures = postOnset.filter(isFailure).length;
  const postOnsetFailureRate = postOnset.length > 0 ? postOnsetFailures / postOnset.length : 0;

  const sustained =
    (failed >= MIN_POST_ONSET_FAILURES && failed / summary.requests >= SUSTAINED_FAILURE_RATE) ||
    (postOnset.length >= MIN_POST_ONSET_REQUESTS &&
      postOnsetFailures >= MIN_POST_ONSET_FAILURES &&
      postOnsetFailureRate >= SUSTAINED_FAILURE_RATE);

  const vantageNote = vantage ? `; scanned from ${vantage}` : '';
  const kinds = describeKinds(
    summary.stalledBodies,
    summary.challengePages,
    summary.fetchErrors,
    blockCorrelated ? blockedResponses : 0,
  );

  let message: string;
  if (sustained) {
    message =
      `Sustained interference: after request #${records[onsetIndex].seq}, ` +
      `${postOnsetFailures} of ${postOnset.length} requests (${Math.round(postOnsetFailureRate * 100)}%) ` +
      `were challenged, stalled, denied, or failed (${kinds})${vantageNote}`;
  } else if (interferenceEvents > 0) {
    message =
      `Intermittent interference: ${failed} of ${summary.requests} requests ` +
      `were challenged, stalled, denied, or failed (${kinds})${vantageNote}`;
  } else if (failureTrend.correlated) {
    message =
      `Failures climbed as the scan progressed: ${failureTrend.earlyEvents} of ${failureTrend.earlyRequests} early requests failed ` +
      `vs ${failureTrend.lateEvents} of ${failureTrend.lateRequests} late requests across ${pluralize(failureTrend.lateChecksSpanned, 'check')} ` +
      `(no challenge pages or stalled bodies observed)${vantageNote}`;
  } else {
    message =
      `Denials climbed as the scan progressed: ${blockTrend.earlyEvents} of ${blockTrend.earlyRequests} early requests were denied ` +
      `vs ${blockTrend.lateEvents} of ${blockTrend.lateRequests} late requests across ${pluralize(blockTrend.lateChecksSpanned, 'check')} ` +
      `(403/503 without a challenge page)${vantageNote}`;
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
