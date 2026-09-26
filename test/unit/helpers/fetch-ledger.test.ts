import { describe, it, expect } from 'vitest';
import {
  createFetchLedger,
  detectChallengePage,
  summarizeRequests,
} from '../../../src/helpers/fetch-ledger.js';
import type { FetchRecord } from '../../../src/types.js';

const DOCS_PAGE = `<html><head><title>Turnstile widget reference</title></head><body>
<main>
<h1>Turnstile widget</h1>
<p>Turnstile replaces CAPTCHAs with a lightweight challenge. Add the cf-turnstile class to a container element and load the script from challenges.cloudflare.com to render the widget on your form.</p>
<h2>Configuration</h2>
<p>The data-sitekey attribute identifies your widget. Optional attributes control theme, size, and callback behavior for the rendered element.</p>
<h2>Callbacks</h2>
<p>When the challenge completes, the callback receives a token that your server verifies with the siteverify endpoint before accepting the form submission.</p>
<h2>Troubleshooting</h2>
<p>If the widget does not render, confirm the script loaded and that the container is visible when render is called.</p>
</main></body></html>`;

describe('detectChallengePage', () => {
  it('detects a Cloudflare challenge interstitial', () => {
    const body = `<html><head><title>Just a moment...</title></head><body>
      <div id="cf-browser-verification">Checking your browser before accessing example.com</div>
      <script src="/cdn-cgi/challenge-platform/h/b/orchestrate/jsch/v1"></script></body></html>`;
    expect(detectChallengePage(body, 'text/html')).toBe('Cloudflare challenge');
  });

  it('detects a challenge by title alone', () => {
    const body = `<html><head><title>Attention Required! | Cloudflare</title></head><body><p>Please wait.</p></body></html>`;
    expect(detectChallengePage(body, 'text/html')).toBeDefined();
  });

  it('detects challenge-page artifacts for PerimeterX, DataDome, Incapsula, Akamai', () => {
    expect(
      detectChallengePage('<html><body><div id="px-captcha"></div></body></html>', 'text/html'),
    ).toBe('PerimeterX/HUMAN challenge');
    expect(
      detectChallengePage(
        '<html><body><script src="https://ct.captcha-delivery.com/c.js"></script></body></html>',
        'text/html',
      ),
    ).toBe('DataDome challenge');
    expect(
      detectChallengePage(
        '<html><head><title>Request unsuccessful. Incapsula incident ID: 1</title></head><body></body></html>',
        'text/html',
      ),
    ).toBe('Imperva/Incapsula challenge');
    expect(
      detectChallengePage(
        "<html><head><title>Access Denied</title></head><body><h1>Access Denied</h1><p>You don't have permission to access this page.</p><p>Reference #18.4f3a1b02.1727300000.2a1c9f</p></body></html>",
        'text/html',
      ),
    ).toBe('Akamai block page');
  });

  it('detects the Cloudflare block page even though it has headings and prose', () => {
    const body = `<html><head><title>Attention Required! | Cloudflare</title></head><body>
      <div class="cf-wrapper"><h1>Sorry, you have been blocked</h1>
      <h2>Why have I been blocked?</h2><p>This website is using a security service to protect itself from online attacks. The action you just performed triggered the security solution.</p>
      <h2>What can I do to resolve this?</h2><p>You can email the site owner to let them know you were blocked. Please include what you were doing when this page came up and the Cloudflare Ray ID found at the bottom of this page.</p>
      <p>Cloudflare Ray ID: 8c1234567890abcd</p></div></body></html>`;
    expect(detectChallengePage(body, 'text/html')).toBe('Cloudflare block page');
  });

  it('never counts vendor SDK markers on their own', () => {
    // Cloudflare Bot Management injects its JS-detections script into every
    // page; a Next.js shell carries it with no content to veto on.
    const shell =
      '<html><head><script src="/cdn-cgi/challenge-platform/scripts/jsd/main.js"></script></head>' +
      '<body><div id="__next"></div><script src="/_next/static/chunks/main.js"></script></body></html>';
    expect(detectChallengePage(shell, 'text/html')).toBeUndefined();

    const datadomeShell =
      '<html><head><script src="https://js.datadome.co/tags.js"></script></head><body><div id="root"></div></body></html>';
    expect(detectChallengePage(datadomeShell, 'text/html')).toBeUndefined();

    const recaptchaShell =
      '<html><head><script src="https://www.google.com/recaptcha/api.js"></script></head><body><div id="root"></div></body></html>';
    expect(detectChallengePage(recaptchaShell, 'text/html')).toBeUndefined();
  });

  it('uses a vendor marker only to name the vendor behind a phrase match', () => {
    const body =
      '<html><head><script src="https://js.datadome.co/tags.js"></script></head>' +
      '<body><p>Please complete the security check to continue.</p></body></html>';
    expect(detectChallengePage(body, 'text/html')).toBe('DataDome challenge');
  });

  it('vetoes a phrase match on a page with substantive documentation content', () => {
    const body = `<html><head><title>Troubleshooting</title></head><body><main>
      <h1>Troubleshooting access errors</h1>
      <h2>Verify you are human</h2><p>If the site shows a "verify you are human" prompt, your network may be flagged. Complete the check once and the session continues normally for the rest of the day.</p>
      <h2>Rate limits</h2><p>The API returns 429 with a Retry-After header when you exceed the quota. Back off for the indicated interval before retrying the request.</p>
      <h2>Support</h2><p>Contact support with the request id if the problem persists after following the steps above.</p>
      </main></body></html>`;
    expect(detectChallengePage(body, 'text/html')).toBeUndefined();
  });

  it('detects generic browser-verification phrasing', () => {
    const body =
      '<html><body><h1>Verify you are human</h1><p>Please complete the security check to access the site.</p></body></html>';
    expect(detectChallengePage(body, 'text/html')).toBe('Browser verification interstitial');
  });

  it('vetoes a documentation page that merely mentions challenge markers', () => {
    expect(detectChallengePage(DOCS_PAGE, 'text/html')).toBeUndefined();
  });

  it('never treats a body over 100KB as a challenge page', () => {
    const filler = '<p>' + 'Prose about bot management. '.repeat(20) + '</p>\n';
    let body =
      '<html><head><title>Just a moment...</title></head><body><div id="cf-browser-verification">';
    while (body.length <= 100_000) body += filler;
    body += '</div></body></html>';
    expect(detectChallengePage(body, 'text/html')).toBeUndefined();
  });

  it('never sniffs an explicitly typed markdown body, even one with raw HTML', () => {
    const md =
      '# Embedding\n\nPaste this snippet:\n\n<html><head><title>Just a moment...</title></head><body><div id="cf-browser-verification"></div></body></html>\n';
    expect(detectChallengePage(md, 'text/markdown; charset=utf-8')).toBeUndefined();
    expect(detectChallengePage(md, 'text/plain')).toBeUndefined();
  });

  it('sniffs only when the response has no content type', () => {
    const body =
      '<html><head><title>Just a moment...</title></head><body><div id="cf-browser-verification"></div></body></html>';
    expect(detectChallengePage(body, '')).toBe('Cloudflare challenge');
  });

  it('ignores markdown bodies', () => {
    const md = '# Turnstile\n\nAdd the `cf-turnstile` class and load challenges.cloudflare.com.\n';
    expect(detectChallengePage(md, 'text/markdown')).toBeUndefined();
  });

  it('returns undefined for an ordinary docs page', () => {
    const body = '<html><body><main><h1>Install</h1><p>Run npm install.</p></main></body></html>';
    expect(detectChallengePage(body, 'text/html')).toBeUndefined();
  });
});

describe('InMemoryFetchLedger', () => {
  it('records requests in order and annotates challenge bodies', () => {
    const ledger = createFetchLedger();
    const a: FetchRecord = { seq: 1, url: 'http://x/a', status: 200, outcome: 'ok' };
    const b: FetchRecord = { seq: 2, url: 'http://x/b', status: 200, outcome: 'ok' };
    ledger.onRecord(a);
    ledger.onRecord(b);
    ledger.onBody(a, '<html><body><h1>Docs</h1></body></html>', 'text/html');
    ledger.onBody(
      b,
      '<html><head><title>Just a moment...</title></head><body></body></html>',
      'text/html',
    );

    expect(ledger.records.map((r) => r.url)).toEqual(['http://x/a', 'http://x/b']);
    expect(ledger.records[0].challenge).toBeUndefined();
    expect(ledger.records[1].challenge).toBe('Cloudflare challenge');
  });
});

describe('InMemoryFetchLedger check attribution', () => {
  it('stamps records with the current check id', () => {
    const ledger = createFetchLedger();
    ledger.currentCheckId = 'page-size-html';
    ledger.onRecord({ seq: 1, url: 'http://x/a', status: 200, outcome: 'ok' });
    ledger.currentCheckId = undefined;
    ledger.onRecord({ seq: 2, url: 'http://x/b', status: 200, outcome: 'ok' });
    expect(ledger.records[0].checkId).toBe('page-size-html');
    expect(ledger.records[1].checkId).toBeUndefined();
  });
});

describe('summarizeRequests', () => {
  it('counts each failure kind and the overall rate', () => {
    const records: FetchRecord[] = [
      { seq: 1, url: 'u1', status: 200, outcome: 'ok' },
      { seq: 2, url: 'u2', status: 200, outcome: 'stalled-body', error: 'stalled' },
      { seq: 3, url: 'u3', status: null, outcome: 'fetch-error', error: 'ECONNRESET' },
      { seq: 4, url: 'u4', status: 200, outcome: 'ok', challenge: 'Cloudflare challenge' },
      { seq: 5, url: 'u5', status: 404, outcome: 'ok' },
      { seq: 6, url: 'u6', status: 200, outcome: 'body-error', error: 'terminated' },
    ];
    expect(summarizeRequests(records)).toEqual({
      requests: 6,
      stalledBodies: 1,
      challengePages: 1,
      fetchErrors: 2,
      failed: 4,
      failureRate: 67,
    });
  });

  it('handles an empty ledger', () => {
    expect(summarizeRequests([]).failureRate).toBe(0);
  });
});
