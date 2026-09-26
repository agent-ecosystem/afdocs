import type { FetchLedger as FetchLedgerLike, FetchRecord, RequestSummary } from '../types.js';
import { looksLikeHtml } from './detect-markdown.js';
import { analyzeRendering, hasSubstantiveContent } from './detect-rendering.js';

interface Signature {
  label: string;
  pattern: RegExp;
}

/**
 * Artifacts that only a challenge interstitial or block page carries: the
 * vendor's challenge-page element ids, incident strings, or page titles.
 * A match is conclusive on its own and is never vetoed. Titles are anchored
 * at the start so prose mentioning them does not match.
 */
const ARTIFACT_SIGNATURES: Signature[] = [
  {
    label: 'Cloudflare challenge',
    pattern:
      /cf-browser-verification|_cf_chl_opt|cf_chl_prog|cf-challenge-running|<title[^>]*>\s*just a moment/i,
  },
  {
    label: 'Cloudflare block page',
    pattern: /<title[^>]*>\s*attention required!?\s*\|\s*cloudflare/i,
  },
  {
    label: 'Imperva/Incapsula challenge',
    pattern: /request unsuccessful\. incapsula|incapsula incident id|pardon our interruption/i,
  },
  {
    label: 'PerimeterX/HUMAN challenge',
    pattern: /px-captcha|<title[^>]*>\s*access to this page has been denied/i,
  },
  { label: 'DataDome challenge', pattern: /captcha-delivery\.com/i },
  {
    label: 'Akamai block page',
    pattern: /reference&#32;#\s*\d|reference #\d+\.[0-9a-f]+\.\d+\.[0-9a-f]+/i,
  },
];

/**
 * What an interstitial says to a human. Prose on a documentation page can
 * say the same things, so a phrase match is vetoed when the body carries
 * substantive documentation content; a real interstitial is near-empty.
 */
const PHRASE_SIGNATURES: Signature[] = [
  {
    label: 'Browser verification interstitial',
    pattern:
      /checking your browser before accessing|checking if the site connection is secure|verify(?:ing)? (?:that )?you are (?:not a robot|human|a human)|please complete the security check|enable javascript and cookies to continue|are you a robot\?|bot verification|human verification|sorry, you have been blocked/i,
  },
  {
    label: 'Challenge page title',
    pattern:
      /<title[^>]*>\s*(?:access denied|one more step|please wait\.\.\.|security check|verifying\b|bot verification|human verification|are you a human)/i,
  },
];

/**
 * Vendor SDKs, tags, and widgets that protected sites inject into every
 * ordinary page: Cloudflare's JS-detections script, Imperva's resource
 * script, DataDome's tag, PerimeterX's client, AWS WAF's integration, and
 * CAPTCHA widgets on forms. Their presence says the site uses the vendor,
 * not that this response is a challenge, so they are never evidence on
 * their own. They only name the vendor when a phrase signature matched.
 */
const VENDOR_MARKERS: Signature[] = [
  {
    label: 'Cloudflare challenge',
    pattern: /\/cdn-cgi\/challenge-platform|cf-turnstile|challenges\.cloudflare\.com/i,
  },
  { label: 'Imperva/Incapsula challenge', pattern: /_incapsula_resource|incapsula/i },
  { label: 'PerimeterX/HUMAN challenge', pattern: /perimeterx|px-cdn\.net|px-cloud\.net|_pxhd/i },
  { label: 'DataDome challenge', pattern: /datadome/i },
  { label: 'AWS WAF challenge', pattern: /awswafintegration|aws-waf-token|awswaf\.com/i },
  { label: 'CAPTCHA widget', pattern: /hcaptcha\.com|h-captcha|g-recaptcha|recaptcha\/api\.js/i },
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

  // An explicit non-HTML type (markdown, plain text, JSON, XML) is taken at
  // its word: markdown with raw HTML examples must not be sniffed into an
  // HTML classification. Sniffing is only for responses with no type.
  if (contentType) {
    if (!/html/i.test(contentType)) return undefined;
  } else if (!looksLikeHtml(body)) {
    return undefined;
  }

  const sample = body.slice(0, SIGNATURE_SCAN_LENGTH);

  const artifact = ARTIFACT_SIGNATURES.find((sig) => sig.pattern.test(sample));
  if (artifact) return artifact.label;

  const phrase = PHRASE_SIGNATURES.find((sig) => sig.pattern.test(sample));
  if (!phrase) return undefined;

  // Veto: a page with real documentation content is a docs page that
  // happens to use the phrase, not an interstitial. Parsing is only paid
  // for candidates, so the common path stays a cheap regex.
  if (hasSubstantiveContent(analyzeRendering(body))) return undefined;

  const vendor = VENDOR_MARKERS.find((sig) => sig.pattern.test(sample));
  return vendor ? vendor.label : phrase.label;
}

/**
 * Records every request the HTTP client completes, in order. One ledger per
 * run, shared through `ctx.fetchLedger`.
 */
export class InMemoryFetchLedger implements FetchLedgerLike {
  readonly records: FetchRecord[] = [];
  currentCheckId?: string;

  onRecord(record: FetchRecord): void {
    if (this.currentCheckId !== undefined && record.checkId === undefined) {
      record.checkId = this.currentCheckId;
    }
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
    record.outcome === 'body-error' ||
    record.challenge !== undefined
  );
}

export function summarizeRequests(records: readonly FetchRecord[]): RequestSummary {
  let stalledBodies = 0;
  let challengePages = 0;
  let fetchErrors = 0;
  for (const r of records) {
    if (r.outcome === 'stalled-body') stalledBodies++;
    else if (r.outcome === 'fetch-error' || r.outcome === 'body-error') fetchErrors++;
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
