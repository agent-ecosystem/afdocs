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

  it('detects vendor markers for PerimeterX, DataDome, Incapsula, AWS WAF', () => {
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
        '<html><body><script>window.AwsWafIntegration = {}</script></body></html>',
        'text/html',
      ),
    ).toBe('AWS WAF challenge');
  });

  it('detects generic browser-verification phrasing', () => {
    const body =
      '<html><body><h1>Verify you are human</h1><p>Please complete the security check to access the site.</p></body></html>';
    expect(detectChallengePage(body, 'text/html')).toBe('Browser verification interstitial');
  });

  it('vetoes a documentation page that merely mentions challenge markers', () => {
    expect(detectChallengePage(DOCS_PAGE, 'text/html')).toBeUndefined();
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
    expect(ledger.records[1].challenge).toBe('Challenge page title');
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
    ];
    expect(summarizeRequests(records)).toEqual({
      requests: 5,
      stalledBodies: 1,
      challengePages: 1,
      fetchErrors: 1,
      failed: 3,
      failureRate: 60,
    });
  });

  it('handles an empty ledger', () => {
    expect(summarizeRequests([]).failureRate).toBe(0);
  });
});
