import type { FetchLedger as FetchLedgerLike, FetchRecord, RequestSummary } from '../types.js';
import { looksLikeHtml } from './detect-markdown.js';
import { analyzeRendering, hasSubstantiveContent } from './detect-rendering.js';

/**
 * Bot-challenge signatures, checked against the first part of an HTML body.
 *
 * Two tiers: vendor markers (script paths, form ids, cookie names that only a
 * challenge page carries) and interstitial phrasing (what the page says to a
 * human). Any match makes the page a candidate; the candidate is then vetoed
 * if the body carries substantive documentation content, because a real docs
 * page about Cloudflare Turnstile or reCAPTCHA legitimately mentions these
 * markers while a challenge interstitial is near-empty.
 */
const CHALLENGE_SIGNATURES: Array<{ label: string; pattern: RegExp }> = [
  {
    label: 'Cloudflare challenge',
    pattern:
      /cf-browser-verification|_cf_chl_opt|\/cdn-cgi\/challenge-platform|cf-challenge-running|cf-turnstile|challenges\.cloudflare\.com/i,
  },
  {
    label: 'Imperva/Incapsula challenge',
    pattern:
      /_incapsula_resource|incapsula incident|request unsuccessful\. incapsula|pardon our interruption/i,
  },
  { label: 'PerimeterX/HUMAN challenge', pattern: /perimeterx|px-captcha|_pxhd=|px-cdn\.net/i },
  { label: 'DataDome challenge', pattern: /datadome|captcha-delivery\.com/i },
  { label: 'AWS WAF challenge', pattern: /awswafintegration|aws-waf-token|\/awswaf\//i },
  {
    label: 'Akamai bot manager',
    pattern: /akamai.{0,80}bot|reference #\d+\.[0-9a-f]+\.\d+\.[0-9a-f]+/i,
  },
  { label: 'CAPTCHA', pattern: /hcaptcha\.com|h-captcha|g-recaptcha|recaptcha\/api\.js/i },
  {
    label: 'Browser verification interstitial',
    pattern:
      /checking your browser before accessing|checking if the site connection is secure|verify(?:ing)? (?:that )?you are (?:not a robot|human|a human)|please complete the security check|enable javascript and cookies to continue|are you a robot\?|bot verification|human verification/i,
  },
  {
    label: 'Challenge page title',
    pattern:
      /<title[^>]*>\s*(?:just a moment|attention required|access denied|pardon our interruption|one more step|please wait\.\.\.|security check|verifying|bot verification|human verification|are you a human)/i,
  },
];

/** How much of a body to scan for signatures. Challenge pages are small. */
const SIGNATURE_SCAN_LENGTH = 40_000;

/**
 * Bodies larger than this are never challenge interstitials (real ones run
 * a few KB, with inlined challenge JavaScript pushing them to a few tens of
 * KB at most). Skipping them avoids the DOM parse in the veto step on large
 * documentation pages that happen to mention a CAPTCHA or bot-management
 * product near the top.
 */
export const MAX_CHALLENGE_PAGE_LENGTH = 100_000;

/**
 * Returns the label of the bot-challenge signature the body matches, or
 * undefined. Only HTML bodies are inspected: challenge interstitials are
 * HTML, and markdown prose about bot management would otherwise match.
 */
export function detectChallengePage(body: string, contentType: string): string | undefined {
  if (body.length > MAX_CHALLENGE_PAGE_LENGTH) return undefined;

  const isHtml = /text\/html|application\/xhtml/i.test(contentType) || looksLikeHtml(body);
  if (!isHtml) return undefined;

  const sample = body.slice(0, SIGNATURE_SCAN_LENGTH);
  const match = CHALLENGE_SIGNATURES.find((sig) => sig.pattern.test(sample));
  if (!match) return undefined;

  // Veto: a page with real documentation content is a docs page that
  // mentions the marker, not an interstitial. Parsing is only paid for
  // candidates, so the common path stays a cheap regex.
  if (hasSubstantiveContent(analyzeRendering(body))) return undefined;

  return match.label;
}

/**
 * Records every request the HTTP client completes, in order. One ledger per
 * run, shared through `ctx.fetchLedger`.
 */
export class InMemoryFetchLedger implements FetchLedgerLike {
  readonly records: FetchRecord[] = [];

  onRecord(record: FetchRecord): void {
    this.records.push(record);
  }

  onBody(record: FetchRecord, body: string, contentType: string): void {
    if (record.challenge !== undefined) return;
    const challenge = detectChallengePage(body, contentType);
    if (challenge) record.challenge = challenge;
  }
}

export function createFetchLedger(): InMemoryFetchLedger {
  return new InMemoryFetchLedger();
}

/** Whether a record is one of the failure kinds the run-level summary counts. */
export function isFailedRecord(record: FetchRecord): boolean {
  return (
    record.outcome === 'stalled-body' ||
    record.outcome === 'fetch-error' ||
    record.challenge !== undefined
  );
}

export function summarizeRequests(records: readonly FetchRecord[]): RequestSummary {
  let stalledBodies = 0;
  let challengePages = 0;
  let fetchErrors = 0;
  for (const r of records) {
    if (r.outcome === 'stalled-body') stalledBodies++;
    else if (r.outcome === 'fetch-error') fetchErrors++;
    if (r.challenge !== undefined) challengePages++;
  }
  const failed = records.filter(isFailedRecord).length;
  return {
    requests: records.length,
    stalledBodies,
    challengePages,
    fetchErrors,
    failed,
    failureRate: records.length > 0 ? Math.round((failed / records.length) * 100) : 0,
  };
}
