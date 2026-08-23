import { describe, it, expect, beforeAll } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { createContext } from '../../../src/runner.js';
import { getCheck } from '../../../src/checks/registry.js';
import '../../../src/checks/index.js';

const server = setupServer();

beforeAll(() => {
  server.listen({ onUnhandledRequest: 'bypass' });
  return () => server.close();
});

describe('markdown-content-parity', () => {
  const check = getCheck('markdown-content-parity')!;

  function makeCtx(
    pages: Array<{ url: string; markdown: string; htmlBody: string }>,
    host: string,
    options?: Record<string, unknown>,
  ) {
    const ctx = createContext(`http://${host}`, { requestDelay: 0, ...options });

    // Simulate upstream markdown-url-support having run
    ctx.previousResults.set('markdown-url-support', {
      id: 'markdown-url-support',
      category: 'markdown-availability',
      status: 'pass',
      message: 'OK',
    });

    // Populate pageCache as upstream checks would
    for (const page of pages) {
      ctx.pageCache.set(page.url, {
        url: page.url,
        markdown: { content: page.markdown, source: 'md-url' },
      });
    }

    return ctx;
  }

  it('passes when markdown and HTML have equivalent content', async () => {
    const html = `<html><body>
      <h1>Getting Started</h1>
      <p>Install the SDK with npm to get started with the integration process.</p>
      <pre><code>npm install @example/sdk</code></pre>
      <p>Then import the client and configure your API key for authentication.</p>
    </body></html>`;
    const markdown = `# Getting Started

Install the SDK with npm to get started with the integration process.

\`\`\`
npm install @example/sdk
\`\`\`

Then import the client and configure your API key for authentication.`;
    const url = 'http://mcp-pass.local/docs/getting-started';

    server.use(
      http.get(
        url,
        () =>
          new HttpResponse(html, {
            status: 200,
            headers: { 'Content-Type': 'text/html' },
          }),
      ),
    );

    const ctx = makeCtx([{ url, markdown, htmlBody: html }], 'mcp-pass.local');
    const result = await check.run(ctx);
    expect(result.status).toBe('pass');
  });

  it('warns when markdown is missing some content from HTML', async () => {
    const html = `<html><body>
      <h1>API Reference</h1>
      <p>The API supports the following operations for managing resources.</p>
      <h2>Authentication</h2>
      <p>Use bearer tokens for authentication with the API endpoints.</p>
      <p>Include your API key in the Authorization header of every request.</p>
      <h2>Rate Limiting</h2>
      <p>Requests are limited to 100 per minute per API key.</p>
      <h2>Errors</h2>
      <p>Error responses include a JSON body with details about the failure.</p>
      <p>Each error includes a code field and a human-readable message field.</p>
      <h2>Pagination</h2>
      <p>Use cursor-based pagination with the after parameter in your requests.</p>
      <p>Each page returns up to 50 items by default unless configured otherwise.</p>
      <h2>Versioning</h2>
      <p>Pass the version header to select a specific API version for your requests.</p>
      <p>If no version header is provided the latest stable version is used automatically.</p>
      <h2>Webhooks</h2>
      <p>Configure webhook endpoints to receive real-time notifications about events.</p>
      <p>All webhook payloads include a signature header for verification purposes.</p>
    </body></html>`;

    // Markdown version is missing only the Rate Limiting section (minor omission)
    const markdown = `# API Reference

The API supports the following operations for managing resources.

## Authentication

Use bearer tokens for authentication with the API endpoints.

Include your API key in the Authorization header of every request.

## Errors

Error responses include a JSON body with details about the failure.

Each error includes a code field and a human-readable message field.

## Pagination

Use cursor-based pagination with the after parameter in your requests.

Each page returns up to 50 items by default unless configured otherwise.

## Versioning

Pass the version header to select a specific API version for your requests.

If no version header is provided the latest stable version is used automatically.

## Webhooks

Configure webhook endpoints to receive real-time notifications about events.

All webhook payloads include a signature header for verification purposes.`;

    const url = 'http://mcp-warn.local/docs/api';

    server.use(
      http.get(
        url,
        () =>
          new HttpResponse(html, {
            status: 200,
            headers: { 'Content-Type': 'text/html' },
          }),
      ),
    );

    const ctx = makeCtx([{ url, markdown, htmlBody: html }], 'mcp-warn.local');
    const result = await check.run(ctx);
    expect(result.status).toBe('warn');
  });

  it('fails when markdown is substantially different from HTML', async () => {
    const html = `<html><body>
      <h1>Installation Guide</h1>
      <p>You need Node.js 18 or later installed on your system before proceeding.</p>
      <p>Create a configuration file with your API credentials and region settings.</p>
      <p>Import and initialize the client using the configuration you just created.</p>
      <p>Run the health check to verify everything is working correctly in your environment.</p>
      <p>Common issues include connection timeouts and authentication failures with expired keys.</p>
      <p>Check your network connectivity if you experience connection timeout errors repeatedly.</p>
      <p>Verify your API key has not expired if you see authentication failure messages.</p>
      <p>Make sure the target host is accessible and responding to network requests properly.</p>
      <p>Review the troubleshooting section for additional debugging information and tips.</p>
      <p>Contact support if you continue to experience issues after following these steps.</p>
      <p>The installation process should take approximately five minutes from start to finish.</p>
    </body></html>`;

    // Markdown version is a completely different page
    const markdown = `# Changelog

## v2.0.0

Breaking changes in this release that affect all existing integrations.

## v1.5.0

Added new features for managing team resources and permissions.

## v1.4.0

Improved error handling and added retry logic for failed requests.`;

    const url = 'http://mcp-fail.local/docs/install';

    server.use(
      http.get(
        url,
        () =>
          new HttpResponse(html, {
            status: 200,
            headers: { 'Content-Type': 'text/html' },
          }),
      ),
    );

    const ctx = makeCtx([{ url, markdown, htmlBody: html }], 'mcp-fail.local');
    const result = await check.run(ctx);
    expect(result.status).toBe('fail');
    expect(result.details?.avgMissingPercent).toBeGreaterThanOrEqual(20);
  });

  it('skips when no pages have markdown versions', async () => {
    const ctx = createContext('http://mcp-skip.local', { requestDelay: 0 });
    const result = await check.run(ctx);
    expect(result.status).toBe('skip');
  });

  it('handles fetch errors gracefully', async () => {
    const url = 'http://mcp-err.local/docs/page';
    server.use(http.get(url, () => HttpResponse.error()));

    const ctx = makeCtx(
      [
        {
          url,
          markdown: '# Page\n\nThis is some content that is long enough to be a segment.',
          htmlBody: '',
        },
      ],
      'mcp-err.local',
    );
    const result = await check.run(ctx);
    expect(result.details?.fetchErrors).toBe(1);
  });

  it('passes when HTML version is already markdown/plain text', async () => {
    const url = 'http://mcp-plain.local/docs/page';
    const markdown = '# Page\n\nSome content that is at least twenty characters long.';

    server.use(
      http.get(
        url,
        () =>
          new HttpResponse(markdown, {
            status: 200,
            headers: { 'Content-Type': 'text/plain' },
          }),
      ),
    );

    const ctx = makeCtx([{ url, markdown, htmlBody: markdown }], 'mcp-plain.local');
    const result = await check.run(ctx);
    expect(result.status).toBe('pass');
  });

  it('detects missing inline code elements', async () => {
    const html = `<html><body>
      <h1>Usage</h1>
      <p>Call the <code>initialize()</code> method first, then use <code>client.fetch()</code> to make requests to the server.</p>
      <p>Set the <code>DEBUG=true</code> environment variable for verbose logging output.</p>
      <p>The client supports automatic retry with exponential backoff for failed requests.</p>
      <p>Configure the maximum number of retries using the <code>maxRetries</code> option parameter.</p>
      <p>All responses include standard headers with rate limiting information for your reference.</p>
      <p>Error responses contain a machine-readable error code and a human-readable description.</p>
      <p>Use the <code>client.close()</code> method to cleanly shut down all connections and resources.</p>
      <p>The library automatically handles connection pooling and keep-alive management for you.</p>
      <p>Requests timeout after thirty seconds by default but this is configurable per request.</p>
      <p>Authentication tokens are refreshed automatically before they expire to prevent failures.</p>
      <p>The client validates all input parameters before sending requests to the remote server.</p>
    </body></html>`;

    // Markdown version lost the inline code content
    const markdown = `# Usage

Call the method first, then use to make requests to the server.

Set the environment variable for verbose logging output.

The client supports automatic retry with exponential backoff for failed requests.

Configure the maximum number of retries using the option parameter.

All responses include standard headers with rate limiting information for your reference.

Error responses contain a machine-readable error code and a human-readable description.

Use the method to cleanly shut down all connections and resources.

The library automatically handles connection pooling and keep-alive management for you.

Requests timeout after thirty seconds by default but this is configurable per request.

Authentication tokens are refreshed automatically before they expire to prevent failures.

The client validates all input parameters before sending requests to the remote server.`;

    const url = 'http://mcp-code.local/docs/usage';

    server.use(
      http.get(
        url,
        () =>
          new HttpResponse(html, {
            status: 200,
            headers: { 'Content-Type': 'text/html' },
          }),
      ),
    );

    const ctx = makeCtx([{ url, markdown, htmlBody: html }], 'mcp-code.local');
    const result = await check.run(ctx);
    // Should detect the missing inline code content
    expect(result.status).not.toBe('pass');
    const pageResults = result.details?.pageResults as Array<{ missingSegments: number }>;
    expect(pageResults[0].missingSegments).toBeGreaterThan(0);
  });

  it('provides sample diffs in results', async () => {
    const html = `<html><body><h1>Title</h1>
      <p>Original content here that is long enough to count as a segment.</p>
      <p>The system processes incoming requests through a middleware pipeline before routing.</p>
      <p>Each middleware component can inspect and modify the request before passing it along.</p>
      <p>Authentication middleware verifies the bearer token against the identity provider.</p>
      <p>Rate limiting middleware enforces per-client request quotas based on the API key.</p>
      <p>Logging middleware records request metadata for monitoring and debugging purposes.</p>
      <p>Error handling middleware catches unhandled exceptions and returns structured responses.</p>
      <p>Validation middleware checks request bodies against the defined JSON schema rules.</p>
      <p>Compression middleware applies gzip encoding to responses larger than one kilobyte.</p>
      <p>Caching middleware stores frequently accessed responses to reduce backend load times.</p>
      <p>The final handler processes the request and returns the appropriate response data.</p>
    </body></html>`;
    const markdown =
      '# Title\n\nDifferent content here that is long enough to count as a segment.\n\nThe system processes incoming requests through a completely different pipeline.';
    const url = 'http://mcp-diffs.local/docs/page';

    server.use(
      http.get(
        url,
        () =>
          new HttpResponse(html, {
            status: 200,
            headers: { 'Content-Type': 'text/html' },
          }),
      ),
    );

    const ctx = makeCtx([{ url, markdown, htmlBody: html }], 'mcp-diffs.local');
    const result = await check.run(ctx);
    const pageResults = result.details?.pageResults as Array<{ sampleDiffs: string[] }>;
    expect(pageResults[0].sampleDiffs.length).toBeGreaterThan(0);
  });

  it('compares multiple pages and reports worst status', async () => {
    const goodUrl = 'http://mcp-multi.local/docs/good';
    const badUrl = 'http://mcp-multi.local/docs/bad';

    const goodHtml =
      '<html><body><h1>Good Page</h1><p>Content that matches between HTML and markdown versions exactly.</p></body></html>';
    const goodMd =
      '# Good Page\n\nContent that matches between HTML and markdown versions exactly.';

    const badHtml = `<html><body>
      <h1>Bad Page</h1>
      <p>This page has lots of content that is only in the HTML version.</p>
      <p>Details about section A that should be in the markdown but are missing.</p>
      <p>Details about section B that should be in the markdown but are missing.</p>
      <p>Details about section C that should be in the markdown but are missing.</p>
      <p>Details about section D that should be in the markdown but are missing.</p>
      <p>Details about section E that should be in the markdown but are missing.</p>
    </body></html>`;
    const badMd = '# Bad Page\n\nCompletely different content that does not match the HTML at all.';

    server.use(
      http.get(
        goodUrl,
        () =>
          new HttpResponse(goodHtml, {
            status: 200,
            headers: { 'Content-Type': 'text/html' },
          }),
      ),
      http.get(
        badUrl,
        () =>
          new HttpResponse(badHtml, {
            status: 200,
            headers: { 'Content-Type': 'text/html' },
          }),
      ),
    );

    const ctx = makeCtx(
      [
        { url: goodUrl, markdown: goodMd, htmlBody: goodHtml },
        { url: badUrl, markdown: badMd, htmlBody: badHtml },
      ],
      'mcp-multi.local',
    );
    const result = await check.run(ctx);
    expect(result.details?.pagesCompared).toBe(2);
    expect(result.details?.passBucket).toBeGreaterThanOrEqual(1);
  });

  it('strips navigation panels with high link density', async () => {
    // Simulate a page where nav is inside <main> using <div> instead of <nav>
    const navLinks = Array.from(
      { length: 15 },
      (_, i) => `<a href="/page-${i}">Navigation item number ${i} for testing</a>`,
    ).join('\n');
    const html = `<html><body><main>
      <div class="sidebar">${navLinks}</div>
      <div class="content">
        <h1>Actual Page Content</h1>
        <p>This is the real content that should be compared against markdown output.</p>
        <p>It contains multiple paragraphs with enough text to form segments for comparison.</p>
        <p>The sidebar navigation should be stripped because it has very high link density.</p>
        <p>Without link density stripping the nav text would inflate the missing percentage.</p>
        <p>Each paragraph here represents genuine documentation content for the reader.</p>
        <p>Authentication requires a valid API key passed in the Authorization header field.</p>
        <p>Rate limiting is applied per API key with a maximum of one hundred requests per minute.</p>
        <p>Error responses include a JSON body with a code field and a message field for details.</p>
        <p>Pagination uses cursor-based navigation with the after parameter in query strings.</p>
        <p>The SDK supports automatic retries with exponential backoff for transient failures.</p>
        <p>Configure the maximum number of retries using the maxRetries constructor option.</p>
      </div>
    </main></body></html>`;

    const markdown = `# Actual Page Content

This is the real content that should be compared against markdown output.

It contains multiple paragraphs with enough text to form segments for comparison.

The sidebar navigation should be stripped because it has very high link density.

Without link density stripping the nav text would inflate the missing percentage.

Each paragraph here represents genuine documentation content for the reader.

Authentication requires a valid API key passed in the Authorization header field.

Rate limiting is applied per API key with a maximum of one hundred requests per minute.

Error responses include a JSON body with a code field and a message field for details.

Pagination uses cursor-based navigation with the after parameter in query strings.

The SDK supports automatic retries with exponential backoff for transient failures.

Configure the maximum number of retries using the maxRetries constructor option.`;

    const url = 'http://mcp-nav.local/docs/page';

    server.use(
      http.get(
        url,
        () =>
          new HttpResponse(html, {
            status: 200,
            headers: { 'Content-Type': 'text/html' },
          }),
      ),
    );

    const ctx = makeCtx([{ url, markdown, htmlBody: html }], 'mcp-nav.local');
    const result = await check.run(ctx);
    // Should pass because nav was stripped; without stripping it would fail
    expect(result.status).toBe('pass');
  });

  it('separates code lines from div-based syntax highlighting', async () => {
    // Simulate Expressive Code / Shiki / Geist code blocks with <div> per line inside <pre>
    const html = `<html><body>
      <h1>Installation Guide</h1>
      <p>Install the package using npm to add it to your project dependencies.</p>
      <p>Then import the client module and configure it with your API credentials.</p>
      <p>Run the following commands to get started with the installation process.</p>
      <pre><code><div class="ec-line"><span style="--0:#fff">npm install @example/sdk</span></div><div class="ec-line"><span style="--0:#fff">npm install @example/cli</span></div></code></pre>
      <p>After installation import the client and call the initialize method first.</p>
      <p>The client will automatically detect your configuration from environment variables.</p>
      <p>You can override any configuration option by passing it to the constructor directly.</p>
      <p>Make sure your API key is set before attempting to make any requests to the server.</p>
      <p>The library validates all configuration options and throws helpful error messages.</p>
      <p>Connection pooling is handled automatically for optimal performance and throughput.</p>
      <p>TLS certificates are verified by default to ensure secure communication channels.</p>
    </body></html>`;

    const markdown = `# Installation Guide

Install the package using npm to add it to your project dependencies.

Then import the client module and configure it with your API credentials.

Run the following commands to get started with the installation process.

\`\`\`
npm install @example/sdk
npm install @example/cli
\`\`\`

After installation import the client and call the initialize method first.

The client will automatically detect your configuration from environment variables.

You can override any configuration option by passing it to the constructor directly.

Make sure your API key is set before attempting to make any requests to the server.

The library validates all configuration options and throws helpful error messages.

Connection pooling is handled automatically for optimal performance and throughput.

TLS certificates are verified by default to ensure secure communication channels.`;

    const url = 'http://mcp-codediv.local/docs/install';

    server.use(
      http.get(
        url,
        () =>
          new HttpResponse(html, {
            status: 200,
            headers: { 'Content-Type': 'text/html' },
          }),
      ),
    );

    const ctx = makeCtx([{ url, markdown, htmlBody: html }], 'mcp-codediv.local');
    const result = await check.run(ctx);
    expect(result.status).toBe('pass');
  });

  it('skips pages that return HTTP 404', async () => {
    const url = 'http://mcp-404.local/docs/page';

    server.use(
      http.get(
        url,
        () =>
          new HttpResponse('Not Found', {
            status: 404,
            headers: { 'Content-Type': 'text/html' },
          }),
      ),
    );

    const ctx = makeCtx(
      [
        {
          url,
          markdown: '# Page\n\nContent that is long enough for a meaningful segment.',
          htmlBody: '',
        },
      ],
      'mcp-404.local',
    );
    const result = await check.run(ctx);
    // Page should be skipped (auto-pass), not counted as a failure
    const pageResults = result.details?.pageResults as Array<{ error?: string }>;
    expect(pageResults[0].error).toContain('404');
  });

  it('uses heuristic selectors when no semantic container exists', async () => {
    // Page with no <main> or <article>, but has #content
    const html = `<html><body>
      <div class="site-header"><a href="/">Home</a><a href="/docs">Docs</a></div>
      <div id="content">
        <h1>Getting Started Guide</h1>
        <p>This tutorial walks you through the initial setup process for the platform.</p>
        <p>You will need an active account and valid API credentials before proceeding.</p>
        <p>The setup process takes approximately five minutes from start to finish today.</p>
        <p>Begin by installing the command line tool using your preferred package manager.</p>
        <p>After installation run the init command to create a configuration file locally.</p>
        <p>The configuration file stores your API key and preferred region settings securely.</p>
        <p>Next authenticate by running the login command with your account credentials here.</p>
        <p>Once authenticated you can begin making API calls and managing your resources now.</p>
        <p>The dashboard provides a visual overview of all your resources and their status.</p>
        <p>Check the troubleshooting guide if you encounter any issues during the setup.</p>
        <p>Our support team is available around the clock to help with technical questions.</p>
      </div>
      <div class="site-footer">Copyright 2024</div>
    </body></html>`;

    const markdown = `# Getting Started Guide

This tutorial walks you through the initial setup process for the platform.

You will need an active account and valid API credentials before proceeding.

The setup process takes approximately five minutes from start to finish today.

Begin by installing the command line tool using your preferred package manager.

After installation run the init command to create a configuration file locally.

The configuration file stores your API key and preferred region settings securely.

Next authenticate by running the login command with your account credentials here.

Once authenticated you can begin making API calls and managing your resources now.

The dashboard provides a visual overview of all your resources and their status.

Check the troubleshooting guide if you encounter any issues during the setup.

Our support team is available around the clock to help with technical questions.`;

    const url = 'http://mcp-heuristic.local/docs/start';

    server.use(
      http.get(
        url,
        () =>
          new HttpResponse(html, {
            status: 200,
            headers: { 'Content-Type': 'text/html' },
          }),
      ),
    );

    const ctx = makeCtx([{ url, markdown, htmlBody: html }], 'mcp-heuristic.local');
    const result = await check.run(ctx);
    expect(result.status).toBe('pass');
  });

  it('handles index.md URL by stripping to directory path', async () => {
    const mdUrl = 'http://mcp-index.local/docs/guide/index.md';
    const htmlUrl = 'http://mcp-index.local/docs/guide/';
    const html =
      '<html><body><h1>Guide</h1><p>Step one of the installation process requires downloading the package.</p><p>Step two involves configuring the environment variables for your setup.</p></body></html>';
    const markdown =
      '# Guide\n\nStep one of the installation process requires downloading the package.\n\nStep two involves configuring the environment variables for your setup.';

    server.use(
      http.get(
        htmlUrl,
        () =>
          new HttpResponse(html, {
            status: 200,
            headers: { 'Content-Type': 'text/html' },
          }),
      ),
    );

    const ctx = createContext('http://mcp-index.local', { requestDelay: 0 });
    ctx.previousResults.set('markdown-url-support', {
      id: 'markdown-url-support',
      category: 'markdown-availability',
      status: 'pass',
      message: 'OK',
    });
    ctx.pageCache.set(mdUrl, {
      url: mdUrl,
      markdown: { content: markdown, source: 'md-url' },
    });

    const result = await check.run(ctx);
    expect(result.status).toBe('pass');
    const pageResults = result.details?.pageResults as Array<{ totalSegments: number }>;
    expect(pageResults[0].totalSegments).toBeGreaterThan(0);
  });

  it('strips .md from cached URL to fetch the HTML version', async () => {
    const mdUrl = 'http://mcp-mdurl.local/docs/guide.md';
    const htmlUrl = 'http://mcp-mdurl.local/docs/guide';
    const html =
      '<html><body><h1>Guide</h1><p>Step one of the installation process requires downloading the package.</p><p>Step two involves configuring the environment variables for your setup.</p></body></html>';
    const markdown =
      '# Guide\n\nStep one of the installation process requires downloading the package.\n\nStep two involves configuring the environment variables for your setup.';

    server.use(
      http.get(
        mdUrl,
        () =>
          new HttpResponse(markdown, {
            status: 200,
            headers: { 'Content-Type': 'text/markdown' },
          }),
      ),
      http.get(
        htmlUrl,
        () =>
          new HttpResponse(html, {
            status: 200,
            headers: { 'Content-Type': 'text/html' },
          }),
      ),
    );

    const ctx = createContext('http://mcp-mdurl.local', { requestDelay: 0 });
    ctx.previousResults.set('markdown-url-support', {
      id: 'markdown-url-support',
      category: 'markdown-availability',
      status: 'pass',
      message: 'OK',
    });
    ctx.pageCache.set(mdUrl, {
      url: mdUrl,
      markdown: { content: markdown, source: 'md-url' },
    });

    const result = await check.run(ctx);
    expect(result.status).toBe('pass');
    const pageResults = result.details?.pageResults as Array<{ totalSegments: number }>;
    expect(pageResults[0].totalSegments).toBeGreaterThan(0);
  });

  it('strips heading anchor links with aria-label="Anchor"', async () => {
    // Hugo/Congo theme adds <a aria-label="Anchor">#</a> inside every heading.
    // Without stripping, each heading becomes "Heading Text #" which doesn't
    // match the markdown "Heading Text", causing false mismatches.
    const anchorSpan = (id: string) =>
      `<span class="absolute opacity-0"><a href="#${id}" aria-label="Anchor">#</a></span>`;
    const html = `<html><body><main>
      <h1>Guide Title</h1>
      <h2 id="setup" class="relative group">Setup ${anchorSpan('setup')}</h2>
      <p>Install the package using npm to add it to your project dependencies list.</p>
      <p>Then import the client module and configure it with your API credentials here.</p>
      <h2 id="auth" class="relative group">Authentication ${anchorSpan('auth')}</h2>
      <p>Use bearer tokens for authentication with the API endpoints on every request.</p>
      <p>Include your API key in the Authorization header of every request you send.</p>
      <h2 id="usage" class="relative group">Usage ${anchorSpan('usage')}</h2>
      <p>Call the initialize method first to set up the connection pool and configuration.</p>
      <p>Then use the client fetch method to make requests to the remote server endpoint.</p>
      <h2 id="errors" class="relative group">Error Handling ${anchorSpan('errors')}</h2>
      <p>Error responses include a JSON body with a code field and a message for details.</p>
      <p>Wrap API calls in try-catch blocks to handle network and validation errors properly.</p>
    </main></body></html>`;

    const markdown = `# Guide Title

## Setup

Install the package using npm to add it to your project dependencies list.

Then import the client module and configure it with your API credentials here.

## Authentication

Use bearer tokens for authentication with the API endpoints on every request.

Include your API key in the Authorization header of every request you send.

## Usage

Call the initialize method first to set up the connection pool and configuration.

Then use the client fetch method to make requests to the remote server endpoint.

## Error Handling

Error responses include a JSON body with a code field and a message for details.

Wrap API calls in try-catch blocks to handle network and validation errors properly.`;

    const url = 'http://mcp-anchor.local/docs/guide';

    server.use(
      http.get(
        url,
        () =>
          new HttpResponse(html, {
            status: 200,
            headers: { 'Content-Type': 'text/html' },
          }),
      ),
    );

    const ctx = makeCtx([{ url, markdown, htmlBody: html }], 'mcp-anchor.local');
    const result = await check.run(ctx);
    expect(result.status).toBe('pass');
    const pageResults = result.details?.pageResults as Array<{ missingSegments: number }>;
    expect(pageResults[0].missingSegments).toBe(0);
  });

  it('filters llms.txt directive banner text as noise', async () => {
    // Sites using the llms.txt directive add a visually-hidden banner like
    // "For AI agents: a documentation index is available at /llms.txt..."
    // This is template chrome that doesn't exist in the raw markdown content.
    const html = `<html><body><main>
      <div class="not-prose absolute w-px h-px overflow-hidden" style="clip:rect(0,0,0,0)">
        For AI agents: a documentation index is available at /llms.txt for this site.
      </div>
      <h1>Getting Started</h1>
      <p>Install the package using npm to add it to your project dependencies list.</p>
      <p>Then import the client module and configure it with your API credentials here.</p>
      <p>Run the following commands to get started with the installation process now.</p>
      <p>After installation import the client and call the initialize method first please.</p>
      <p>The client will automatically detect your configuration from environment variables.</p>
      <p>You can override any configuration option by passing it to the constructor directly.</p>
      <p>Make sure your API key is set before attempting to make any requests to the server.</p>
      <p>The library validates all configuration options and throws helpful error messages.</p>
      <p>Connection pooling is handled automatically for optimal performance and throughput.</p>
      <p>TLS certificates are verified by default to ensure secure communication channels.</p>
    </main></body></html>`;

    const markdown = `# Getting Started

Install the package using npm to add it to your project dependencies list.

Then import the client module and configure it with your API credentials here.

Run the following commands to get started with the installation process now.

After installation import the client and call the initialize method first please.

The client will automatically detect your configuration from environment variables.

You can override any configuration option by passing it to the constructor directly.

Make sure your API key is set before attempting to make any requests to the server.

The library validates all configuration options and throws helpful error messages.

Connection pooling is handled automatically for optimal performance and throughput.

TLS certificates are verified by default to ensure secure communication channels.`;

    const url = 'http://mcp-directive.local/docs/start';

    server.use(
      http.get(
        url,
        () =>
          new HttpResponse(html, {
            status: 200,
            headers: { 'Content-Type': 'text/html' },
          }),
      ),
    );

    const ctx = makeCtx([{ url, markdown, htmlBody: html }], 'mcp-directive.local');
    const result = await check.run(ctx);
    expect(result.status).toBe('pass');
    const pageResults = result.details?.pageResults as Array<{ missingSegments: number }>;
    expect(pageResults[0].missingSegments).toBe(0);
  });

  it('does not match angle brackets across lines during normalization', async () => {
    // A literal '<' in one paragraph (e.g., "< 5,000 tokens") must not match
    // with a '>' in a completely different paragraph, which would strip the '<'
    // from the full normalized markdown text and break containment matching.
    const html = `<html><body><main>
      <h1>Skill Structure</h1>
      <p>Instructions should be under five thousand tokens for optimal loading performance.</p>
      <p>The recommended size is &lt; 5,000 tokens to keep activation latency low for users.</p>
      <p>Resources are loaded on demand rather than eagerly to reduce initial context usage.</p>
      <p>The platform validates all configuration options and throws helpful error messages.</p>
      <p>Connection pooling is handled automatically for optimal performance and throughput.</p>
      <p>TLS certificates are verified by default to ensure secure communication channels.</p>
      <p>Error responses include a JSON body with a code field and a message for details.</p>
      <p>Wrap API calls in try-catch blocks to handle network and validation errors properly.</p>
      <p>Rate limiting is applied per API key with a maximum of one hundred requests per minute.</p>
      <p>The SDK supports automatic retries with exponential backoff for transient failures.</p>
      <p>Use the &lt;YOUR_API_KEY&gt; placeholder in configuration files for your actual key.</p>
    </main></body></html>`;

    const markdown = `# Skill Structure

Instructions should be under five thousand tokens for optimal loading performance.

The recommended size is < 5,000 tokens to keep activation latency low for users.

Resources are loaded on demand rather than eagerly to reduce initial context usage.

The platform validates all configuration options and throws helpful error messages.

Connection pooling is handled automatically for optimal performance and throughput.

TLS certificates are verified by default to ensure secure communication channels.

Error responses include a JSON body with a code field and a message for details.

Wrap API calls in try-catch blocks to handle network and validation errors properly.

Rate limiting is applied per API key with a maximum of one hundred requests per minute.

The SDK supports automatic retries with exponential backoff for transient failures.

Use the <YOUR_API_KEY> placeholder in configuration files for your actual key.`;

    const url = 'http://mcp-angles.local/docs/structure';

    server.use(
      http.get(
        url,
        () =>
          new HttpResponse(html, {
            status: 200,
            headers: { 'Content-Type': 'text/html' },
          }),
      ),
    );

    const ctx = makeCtx([{ url, markdown, htmlBody: html }], 'mcp-angles.local');
    const result = await check.run(ctx);
    expect(result.status).toBe('pass');
    const pageResults = result.details?.pageResults as Array<{ missingSegments: number }>;
    expect(pageResults[0].missingSegments).toBe(0);
  });

  // --- Session 2 regression tests ---

  it('normalizes typographic quotes to match straight quotes', async () => {
    // Hugo and other markdown processors convert straight quotes to curly
    // quotes in HTML output. The raw markdown retains straight quotes.
    // normalize() must convert curly quotes to straight so both sides match.
    const html = `<html><body><main>
      <h1>Configuration</h1>
      <p>The agent\u2019s context window determines how much content it can process at once.</p>
      <p>Set the \u201Cverbose\u201D flag to enable detailed logging for debugging purposes.</p>
      <p>When you\u2019re ready to deploy, run the build command to generate production assets.</p>
      <p>The platform\u2019s API supports both synchronous and asynchronous request patterns.</p>
      <p>It\u2019s important to validate all input parameters before sending requests upstream.</p>
      <p>The \u201Cstrict mode\u201D setting enforces additional validation rules on all endpoints.</p>
      <p>Your application\u2019s performance depends heavily on the caching strategy you choose.</p>
      <p>The library\u2019s retry logic handles transient failures with exponential backoff.</p>
      <p>Each endpoint\u2019s rate limit is documented in the API reference section online.</p>
      <p>The \u201Cdebug\u201D environment variable controls the verbosity of log output levels.</p>
    </main></body></html>`;

    const markdown = `# Configuration

The agent's context window determines how much content it can process at once.

Set the "verbose" flag to enable detailed logging for debugging purposes.

When you're ready to deploy, run the build command to generate production assets.

The platform's API supports both synchronous and asynchronous request patterns.

It's important to validate all input parameters before sending requests upstream.

The "strict mode" setting enforces additional validation rules on all endpoints.

Your application's performance depends heavily on the caching strategy you choose.

The library's retry logic handles transient failures with exponential backoff.

Each endpoint's rate limit is documented in the API reference section online.

The "debug" environment variable controls the verbosity of log output levels.`;

    const url = 'http://mcp-quotes.local/docs/config';

    server.use(
      http.get(
        url,
        () =>
          new HttpResponse(html, {
            status: 200,
            headers: { 'Content-Type': 'text/html' },
          }),
      ),
    );

    const ctx = makeCtx([{ url, markdown, htmlBody: html }], 'mcp-quotes.local');
    const result = await check.run(ctx);
    expect(result.status).toBe('pass');
    const pageResults = result.details?.pageResults as Array<{ missingSegments: number }>;
    expect(pageResults[0].missingSegments).toBe(0);
  });

  it('strips zero-width characters that break substring matching', async () => {
    // Mintlify injects U+200B (zero-width space) before heading anchors.
    // Without stripping, "Install\u200Bation" !== "Installation".
    const html = `<html><body><main>
      <h1>Install\u200Bation Guide</h1>
      <p>Begin by installing the command\u200B line tool using your preferred package manager.</p>
      <p>After install\u200Bation run the init command to create a configuration file locally.</p>
      <p>The configuration file stores your API key and preferred region settings securely.</p>
      <p>Next authenticate by running the login command with your account credentials here.</p>
      <p>Once authenticated you can begin making API calls and managing your resources now.</p>
      <p>The dashboard provides a visual overview of all your resources and their status.</p>
      <p>Check the troubleshooting guide if you encounter any issues during the setup.</p>
      <p>Our support team is available around the clock to help with technical questions.</p>
      <p>The setup process takes approximately five minutes from start to finish today.</p>
      <p>All configuration changes take effect immediately without requiring a restart.</p>
    </main></body></html>`;

    const markdown = `# Installation Guide

Begin by installing the command line tool using your preferred package manager.

After installation run the init command to create a configuration file locally.

The configuration file stores your API key and preferred region settings securely.

Next authenticate by running the login command with your account credentials here.

Once authenticated you can begin making API calls and managing your resources now.

The dashboard provides a visual overview of all your resources and their status.

Check the troubleshooting guide if you encounter any issues during the setup.

Our support team is available around the clock to help with technical questions.

The setup process takes approximately five minutes from start to finish today.

All configuration changes take effect immediately without requiring a restart.`;

    const url = 'http://mcp-zwsp.local/docs/install';

    server.use(
      http.get(
        url,
        () =>
          new HttpResponse(html, {
            status: 200,
            headers: { 'Content-Type': 'text/html' },
          }),
      ),
    );

    const ctx = makeCtx([{ url, markdown, htmlBody: html }], 'mcp-zwsp.local');
    const result = await check.run(ctx);
    expect(result.status).toBe('pass');
    const pageResults = result.details?.pageResults as Array<{ missingSegments: number }>;
    expect(pageResults[0].missingSegments).toBe(0);
  });

  it('strips .sr-only screen-reader text from headings', async () => {
    // Starlight adds <span class="sr-only">Section titled "..."</span> to
    // heading anchors. Without stripping, headings get extra text that
    // doesn't appear in the markdown.
    const srOnly = (title: string) => `<span class="sr-only">Section titled ${title}</span>`;
    const html = `<html><body><main>
      <h1>API Reference</h1>
      <h2>Authentication ${srOnly('Authentication')}</h2>
      <p>Use bearer tokens for authentication with the API endpoints on every request.</p>
      <p>Include your API key in the Authorization header of every request you send.</p>
      <h2>Rate Limiting ${srOnly('Rate Limiting')}</h2>
      <p>Requests are limited to one hundred per minute per API key by default now.</p>
      <p>Contact support to request a higher rate limit for your production workloads.</p>
      <h2>Errors ${srOnly('Errors')}</h2>
      <p>Error responses include a JSON body with a code field and a message for details.</p>
      <p>All error codes are documented in the error reference section of the API docs.</p>
      <h2>Pagination ${srOnly('Pagination')}</h2>
      <p>Use cursor-based pagination with the after parameter in your requests to pages.</p>
      <p>Each page returns up to fifty items by default unless configured otherwise here.</p>
    </main></body></html>`;

    const markdown = `# API Reference

## Authentication

Use bearer tokens for authentication with the API endpoints on every request.

Include your API key in the Authorization header of every request you send.

## Rate Limiting

Requests are limited to one hundred per minute per API key by default now.

Contact support to request a higher rate limit for your production workloads.

## Errors

Error responses include a JSON body with a code field and a message for details.

All error codes are documented in the error reference section of the API docs.

## Pagination

Use cursor-based pagination with the after parameter in your requests to pages.

Each page returns up to fifty items by default unless configured otherwise here.`;

    const url = 'http://mcp-sronly.local/docs/api';

    server.use(
      http.get(
        url,
        () =>
          new HttpResponse(html, {
            status: 200,
            headers: { 'Content-Type': 'text/html' },
          }),
      ),
    );

    const ctx = makeCtx([{ url, markdown, htmlBody: html }], 'mcp-sronly.local');
    const result = await check.run(ctx);
    expect(result.status).toBe('pass');
    const pageResults = result.details?.pageResults as Array<{ missingSegments: number }>;
    expect(pageResults[0].missingSegments).toBe(0);
  });

  it('handles list bullets before emphasis markers correctly', async () => {
    // Markdown list items starting with * followed by **bold** must be parsed
    // as bullet + bold, not as emphasis. Without correct ordering,
    // "* **SMTP Host**: configure..." is parsed as *...*emphasis, producing
    // mangled text like "SMTP Host*: configure...".
    const html = `<html><body><main>
      <h1>Email Configuration</h1>
      <p>Configure the following settings in your email provider dashboard panel.</p>
      <ul>
        <li><strong>SMTP Host</strong>: Use smtp.example.com for all outgoing mail delivery.</li>
        <li><strong>SMTP Port</strong>: Use port 587 for TLS connections to the server.</li>
        <li><strong>Username</strong>: Your full email address is used as the login username.</li>
        <li><strong>Password</strong>: Generate an app-specific password in your account settings.</li>
        <li><strong>TLS Mode</strong>: Enable STARTTLS for secure connections to the mail server.</li>
        <li><strong>From Address</strong>: Set the sender address that appears in outgoing emails.</li>
        <li><strong>Reply To</strong>: Configure a different reply-to address if needed for routing.</li>
        <li><strong>Timeout</strong>: Set the connection timeout to thirty seconds for reliability.</li>
        <li><strong>Max Retries</strong>: Configure up to three retries for failed delivery attempts.</li>
        <li><strong>Batch Size</strong>: Limit batch sending to one hundred recipients per request.</li>
      </ul>
    </main></body></html>`;

    const markdown = `# Email Configuration

Configure the following settings in your email provider dashboard panel.

* **SMTP Host**: Use smtp.example.com for all outgoing mail delivery.
* **SMTP Port**: Use port 587 for TLS connections to the server.
* **Username**: Your full email address is used as the login username.
* **Password**: Generate an app-specific password in your account settings.
* **TLS Mode**: Enable STARTTLS for secure connections to the mail server.
* **From Address**: Set the sender address that appears in outgoing emails.
* **Reply To**: Configure a different reply-to address if needed for routing.
* **Timeout**: Set the connection timeout to thirty seconds for reliability.
* **Max Retries**: Configure up to three retries for failed delivery attempts.
* **Batch Size**: Limit batch sending to one hundred recipients per request.`;

    const url = 'http://mcp-bullets.local/docs/email';

    server.use(
      http.get(
        url,
        () =>
          new HttpResponse(html, {
            status: 200,
            headers: { 'Content-Type': 'text/html' },
          }),
      ),
    );

    const ctx = makeCtx([{ url, markdown, htmlBody: html }], 'mcp-bullets.local');
    const result = await check.run(ctx);
    expect(result.status).toBe('pass');
    const pageResults = result.details?.pageResults as Array<{ missingSegments: number }>;
    expect(pageResults[0].missingSegments).toBe(0);
  });

  // --- Session 3 regression tests ---

  it('strips CSS-in-JS style blocks inside pre elements', async () => {
    // CSS-in-JS libraries (Emotion/Leafygreen) inject <style> tags inside
    // <pre> blocks. node-html-parser treats <pre> content as raw text, so
    // querySelectorAll('style') can't find them. They must be stripped from
    // the text output directly.
    const html = `<html><body><main>
      <h1>Code Example</h1>
      <p>The following example demonstrates the basic initialization and configuration.</p>
      <pre><code><style>.css-1a2b3c{color:red;font-size:14px;line-height:1.5;margin:0;padding:8px}</style>const client = new Client()
client.connect()</code></pre>
      <p>After connecting you can start making requests to the API endpoints directly.</p>
      <p>The client handles connection pooling and retry logic automatically for you.</p>
      <p>Configure the timeout setting to control how long requests wait for responses.</p>
      <p>Error handling is built in and provides detailed error messages for debugging.</p>
      <p>The library supports both promise-based and callback-based programming styles.</p>
      <p>All requests are authenticated automatically using the configured API credentials.</p>
      <p>Rate limiting information is included in response headers for monitoring usage.</p>
      <p>The connection pool size defaults to ten but is configurable per environment.</p>
      <p>TLS certificate verification is enabled by default for security best practices.</p>
    </main></body></html>`;

    const markdown = `# Code Example

The following example demonstrates the basic initialization and configuration.

\`\`\`
const client = new Client()
client.connect()
\`\`\`

After connecting you can start making requests to the API endpoints directly.

The client handles connection pooling and retry logic automatically for you.

Configure the timeout setting to control how long requests wait for responses.

Error handling is built in and provides detailed error messages for debugging.

The library supports both promise-based and callback-based programming styles.

All requests are authenticated automatically using the configured API credentials.

Rate limiting information is included in response headers for monitoring usage.

The connection pool size defaults to ten but is configurable per environment.

TLS certificate verification is enabled by default for security best practices.`;

    const url = 'http://mcp-cssinjs.local/docs/example';

    server.use(
      http.get(
        url,
        () =>
          new HttpResponse(html, {
            status: 200,
            headers: { 'Content-Type': 'text/html' },
          }),
      ),
    );

    const ctx = makeCtx([{ url, markdown, htmlBody: html }], 'mcp-cssinjs.local');
    const result = await check.run(ctx);
    expect(result.status).toBe('pass');
    // Without CSS-in-JS stripping, the style content would leak into a segment
    // and appear as missing content
    const pageResults = result.details?.pageResults as Array<{ missingSegments: number }>;
    expect(pageResults[0].missingSegments).toBe(0);
  });

  it('deduplicates repeated segments so chrome is counted once', async () => {
    // Breadcrumb text or nav titles can appear multiple times in the DOM.
    // Without deduplication, 3 copies of the same breadcrumb count as 3
    // missing segments instead of 1, inflating the percentage.
    const html = `<html><body><main>
      <div class="breadcrumb">Docs &gt; Getting Started &gt; Installation and Setup Guide</div>
      <div class="breadcrumb">Docs &gt; Getting Started &gt; Installation and Setup Guide</div>
      <div class="breadcrumb">Docs &gt; Getting Started &gt; Installation and Setup Guide</div>
      <h1>Installation</h1>
      <p>Install the package using npm to add it to your project dependencies list today.</p>
      <p>Then import the client module and configure it with your API credentials here.</p>
      <p>Run the following commands to get started with the installation process now.</p>
      <p>After installation import the client and call the initialize method first please.</p>
      <p>The client will automatically detect your configuration from environment variables.</p>
      <p>You can override any configuration option by passing it to the constructor directly.</p>
      <p>Make sure your API key is set before attempting to make any requests to the server.</p>
      <p>The library validates all configuration options and throws helpful error messages.</p>
      <p>Connection pooling is handled automatically for optimal performance and throughput.</p>
      <p>TLS certificates are verified by default to ensure secure communication channels.</p>
    </main></body></html>`;

    const markdown = `# Installation

Install the package using npm to add it to your project dependencies list today.

Then import the client module and configure it with your API credentials here.

Run the following commands to get started with the installation process now.

After installation import the client and call the initialize method first please.

The client will automatically detect your configuration from environment variables.

You can override any configuration option by passing it to the constructor directly.

Make sure your API key is set before attempting to make any requests to the server.

The library validates all configuration options and throws helpful error messages.

Connection pooling is handled automatically for optimal performance and throughput.

TLS certificates are verified by default to ensure secure communication channels.`;

    const url = 'http://mcp-dedup.local/docs/install';

    server.use(
      http.get(
        url,
        () =>
          new HttpResponse(html, {
            status: 200,
            headers: { 'Content-Type': 'text/html' },
          }),
      ),
    );

    const ctx = makeCtx([{ url, markdown, htmlBody: html }], 'mcp-dedup.local');
    const result = await check.run(ctx);
    // With deduplication: 1 breadcrumb miss out of 11 unique segments = 9% (warn)
    // Without deduplication: 3 breadcrumb misses out of 13 segments = 23% (fail)
    expect(result.status).not.toBe('fail');
    const pageResults = result.details?.pageResults as Array<{ missingSegments: number }>;
    // Should count the breadcrumb only once, not three times
    expect(pageResults[0].missingSegments).toBeLessThanOrEqual(1);
  });

  it('preserves underscores in code identifiers during emphasis stripping', async () => {
    // The emphasis regex must use * only, not _. Stripping _ as emphasis
    // would mangle code identifiers like mongoc_client_get_database into
    // mongocclientget_database, breaking containment matching.
    const html = `<html><body><main>
      <h1>MongoDB C Driver Reference</h1>
      <p>Use mongoc_client_get_database to obtain a database handle from the client.</p>
      <p>Call mongoc_collection_find_with_opts to query documents with filter options.</p>
      <p>The mongoc_cursor_next function advances the cursor to the next result document.</p>
      <p>Release resources with mongoc_client_destroy when the client is no longer needed.</p>
      <p>Use mongoc_database_get_collection to get a collection handle from the database.</p>
      <p>The mongoc_collection_insert_one function inserts a single document into collection.</p>
      <p>Call mongoc_collection_update_one to modify a single document matching the filter.</p>
      <p>Use mongoc_collection_delete_one to remove a single document matching the filter.</p>
      <p>The mongoc_client_get_default_database returns the database from the connection URI.</p>
      <p>Call mongoc_collection_count_documents to count documents matching a given filter.</p>
    </main></body></html>`;

    const markdown = `# MongoDB C Driver Reference

Use mongoc_client_get_database to obtain a database handle from the client.

Call mongoc_collection_find_with_opts to query documents with filter options.

The mongoc_cursor_next function advances the cursor to the next result document.

Release resources with mongoc_client_destroy when the client is no longer needed.

Use mongoc_database_get_collection to get a collection handle from the database.

The mongoc_collection_insert_one function inserts a single document into collection.

Call mongoc_collection_update_one to modify a single document matching the filter.

Use mongoc_collection_delete_one to remove a single document matching the filter.

The mongoc_client_get_default_database returns the database from the connection URI.

Call mongoc_collection_count_documents to count documents matching a given filter.`;

    const url = 'http://mcp-underscore.local/docs/mongodb';

    server.use(
      http.get(
        url,
        () =>
          new HttpResponse(html, {
            status: 200,
            headers: { 'Content-Type': 'text/html' },
          }),
      ),
    );

    const ctx = makeCtx([{ url, markdown, htmlBody: html }], 'mcp-underscore.local');
    const result = await check.run(ctx);
    expect(result.status).toBe('pass');
    const pageResults = result.details?.pageResults as Array<{ missingSegments: number }>;
    expect(pageResults[0].missingSegments).toBe(0);
  });

  it('preserves angle-bracket placeholders like <YOUR_API_KEY> in text', async () => {
    // node-html-parser decodes &lt;YOUR_API_KEY&gt; to <YOUR_API_KEY> in .text
    // output. The tag stripping regex must recognize this is not a real HTML tag
    // and preserve the content. normalize() then strips the angle brackets so
    // both HTML-side and markdown-side produce "YOUR_API_KEY".
    const html = `<html><body><main>
      <h1>Authentication Setup</h1>
      <p>Replace &lt;YOUR_API_KEY&gt; with the key from your dashboard settings page.</p>
      <p>Set the &lt;REGION&gt; parameter to match your deployment region preference.</p>
      <p>The &lt;CLUSTER_NAME&gt; value identifies your specific database cluster instance.</p>
      <p>Use &lt;PROJECT_ID&gt; from the project settings page in the admin console.</p>
      <p>The endpoint URL follows the pattern https://&lt;REGION&gt;.api.example.com path.</p>
      <p>Configure &lt;MAX_CONNECTIONS&gt; based on your expected concurrent usage levels.</p>
      <p>The &lt;TIMEOUT_MS&gt; parameter controls how long each request waits for response.</p>
      <p>Set &lt;LOG_LEVEL&gt; to debug for verbose logging during development and testing.</p>
      <p>Replace &lt;WEBHOOK_SECRET&gt; with the signing secret from webhook settings page.</p>
      <p>The &lt;BASE_URL&gt; defaults to the production endpoint unless overridden locally.</p>
    </main></body></html>`;

    const markdown = `# Authentication Setup

Replace <YOUR_API_KEY> with the key from your dashboard settings page.

Set the <REGION> parameter to match your deployment region preference.

The <CLUSTER_NAME> value identifies your specific database cluster instance.

Use <PROJECT_ID> from the project settings page in the admin console.

The endpoint URL follows the pattern https://<REGION>.api.example.com path.

Configure <MAX_CONNECTIONS> based on your expected concurrent usage levels.

The <TIMEOUT_MS> parameter controls how long each request waits for response.

Set <LOG_LEVEL> to debug for verbose logging during development and testing.

Replace <WEBHOOK_SECRET> with the signing secret from webhook settings page.

The <BASE_URL> defaults to the production endpoint unless overridden locally.`;

    const url = 'http://mcp-placeholder.local/docs/auth';

    server.use(
      http.get(
        url,
        () =>
          new HttpResponse(html, {
            status: 200,
            headers: { 'Content-Type': 'text/html' },
          }),
      ),
    );

    const ctx = makeCtx([{ url, markdown, htmlBody: html }], 'mcp-placeholder.local');
    const result = await check.run(ctx);
    expect(result.status).toBe('pass');
    const pageResults = result.details?.pageResults as Array<{ missingSegments: number }>;
    expect(pageResults[0].missingSegments).toBe(0);
  });

  it('strips HTML comments from text output', async () => {
    // node-html-parser can leave <!-- --> comments in .text output,
    // especially inside <pre> blocks (e.g., Leafygreen spacer comments).
    // These must be stripped so they don't appear as spurious segment text.
    const html = `<html><body><main>
      <h1>Code Example</h1>
      <p>The following example demonstrates the basic initialization and setup process.</p>
      <pre><code><!-- spacer -->const client = new Client()<!-- spacer -->
client.initialize()</code></pre>
      <p>After initializing you can start making requests to the API endpoints now.</p>
      <p>The client handles connection pooling and retry logic automatically for you.</p>
      <p>Configure the timeout setting to control how long requests wait for response.</p>
      <p>Error handling is built in and provides detailed error messages for debugging.</p>
      <p>The library supports both promise-based and callback-based programming styles.</p>
      <p>All requests are authenticated automatically using your configured API credentials.</p>
      <p>Rate limiting information is included in response headers for monitoring usage.</p>
      <p>The connection pool size defaults to ten but is configurable per environment.</p>
      <p>TLS certificate verification is enabled by default for security best practices.</p>
    </main></body></html>`;

    const markdown = `# Code Example

The following example demonstrates the basic initialization and setup process.

\`\`\`
const client = new Client()
client.initialize()
\`\`\`

After initializing you can start making requests to the API endpoints now.

The client handles connection pooling and retry logic automatically for you.

Configure the timeout setting to control how long requests wait for response.

Error handling is built in and provides detailed error messages for debugging.

The library supports both promise-based and callback-based programming styles.

All requests are authenticated automatically using your configured API credentials.

Rate limiting information is included in response headers for monitoring usage.

The connection pool size defaults to ten but is configurable per environment.

TLS certificate verification is enabled by default for security best practices.`;

    const url = 'http://mcp-comments.local/docs/example';

    server.use(
      http.get(
        url,
        () =>
          new HttpResponse(html, {
            status: 200,
            headers: { 'Content-Type': 'text/html' },
          }),
      ),
    );

    const ctx = makeCtx([{ url, markdown, htmlBody: html }], 'mcp-comments.local');
    const result = await check.run(ctx);
    expect(result.status).toBe('pass');
    const pageResults = result.details?.pageResults as Array<{ missingSegments: number }>;
    expect(pageResults[0].missingSegments).toBe(0);
  });

  it('preserves markdown syntax inside inline code backticks', async () => {
    // Documentation that shows markdown syntax as examples uses inline code
    // like `[text](url)` or `**bold**`. In HTML, <code> preserves the literal
    // syntax. On the markdown side, extractMarkdownText() must not strip link
    // or emphasis syntax that's inside backticks, or the two sides won't match.
    const html = `<html><body><main>
      <h1>Markdown Syntax Guide</h1>
      <p>Use <code>[text](url)</code> to create links in your documentation pages.</p>
      <p>Use <code>**bold text**</code> to add bold emphasis to important words.</p>
      <p>Use <code>*italic text*</code> to add italic emphasis to specific terms.</p>
      <p>Use <code>![alt](image.png)</code> to embed images in your markdown pages.</p>
      <p>The link syntax is flexible and supports both relative and absolute URL paths.</p>
      <p>Bold and italic can be combined using <code>***bold italic***</code> for emphasis.</p>
      <p>All formatting syntax is preserved exactly as written inside code spans here.</p>
      <p>Inline code is delimited by backticks and renders in a monospace font style.</p>
      <p>Nested formatting inside code spans is treated as literal text not markup.</p>
      <p>These examples cover the most common markdown formatting patterns in use.</p>
    </main></body></html>`;

    const markdown = `# Markdown Syntax Guide

Use \`[text](url)\` to create links in your documentation pages.

Use \`**bold text**\` to add bold emphasis to important words.

Use \`*italic text*\` to add italic emphasis to specific terms.

Use \`![alt](image.png)\` to embed images in your markdown pages.

The link syntax is flexible and supports both relative and absolute URL paths.

Bold and italic can be combined using \`***bold italic***\` for emphasis.

All formatting syntax is preserved exactly as written inside code spans here.

Inline code is delimited by backticks and renders in a monospace font style.

Nested formatting inside code spans is treated as literal text not markup.

These examples cover the most common markdown formatting patterns in use.`;

    const url = 'http://mcp-codespan.local/docs/syntax';

    server.use(
      http.get(
        url,
        () =>
          new HttpResponse(html, {
            status: 200,
            headers: { 'Content-Type': 'text/html' },
          }),
      ),
    );

    const ctx = makeCtx([{ url, markdown, htmlBody: html }], 'mcp-codespan.local');
    const result = await check.run(ctx);
    expect(result.status).toBe('pass');
    const pageResults = result.details?.pageResults as Array<{ missingSegments: number }>;
    expect(pageResults[0].missingSegments).toBe(0);
  });

  it('preserves entity-decoded HTML tag names in prose text', async () => {
    // Documentation that discusses HTML elements (e.g., "strip <nav> and
    // <aside> elements") has those tags entity-encoded in HTML as &lt;nav&gt;.
    // node-html-parser decodes them back to <nav> in .text output. The tag
    // stripping regex must NOT delete these because the real <nav> elements
    // were already removed at the DOM level. Without this fix, the HTML text
    // has empty gaps ("strip , , and  elements") while the markdown has the
    // tag names ("strip nav, aside, and footer elements").
    const html = `<html><body><main>
      <h1>Content Extraction</h1>
      <p>The extractor strips non-content elements from the page before comparing.</p>
      <p>Chrome elements like &lt;nav&gt;, &lt;aside&gt;, and &lt;footer&gt; are removed from the DOM.</p>
      <p>The &lt;header&gt; element is also stripped because it typically contains site navigation.</p>
      <p>Elements like &lt;script&gt; and &lt;style&gt; are removed to exclude non-visible content.</p>
      <p>The &lt;button&gt; element is stripped because buttons are interactive, not documentation.</p>
      <p>After stripping, the remaining content is extracted as plain text for comparison.</p>
      <p>The &lt;noscript&gt; fallback content is also removed as it duplicates script content.</p>
      <p>SVG elements are stripped using the &lt;svg&gt; tag to remove inline graphics and icons.</p>
      <p>This approach ensures only meaningful documentation content is used for matching.</p>
      <p>The content container is selected using semantic elements like main and article tags.</p>
    </main></body></html>`;

    const markdown = `# Content Extraction

The extractor strips non-content elements from the page before comparing.

Chrome elements like \`<nav>\`, \`<aside>\`, and \`<footer>\` are removed from the DOM.

The \`<header>\` element is also stripped because it typically contains site navigation.

Elements like \`<script>\` and \`<style>\` are removed to exclude non-visible content.

The \`<button>\` element is stripped because buttons are interactive, not documentation.

After stripping, the remaining content is extracted as plain text for comparison.

The \`<noscript>\` fallback content is also removed as it duplicates script content.

SVG elements are stripped using the \`<svg>\` tag to remove inline graphics and icons.

This approach ensures only meaningful documentation content is used for matching.

The content container is selected using semantic elements like main and article tags.`;

    const url = 'http://mcp-entitytags.local/docs/extraction';

    server.use(
      http.get(
        url,
        () =>
          new HttpResponse(html, {
            status: 200,
            headers: { 'Content-Type': 'text/html' },
          }),
      ),
    );

    const ctx = makeCtx([{ url, markdown, htmlBody: html }], 'mcp-entitytags.local');
    const result = await check.run(ctx);
    expect(result.status).toBe('pass');
    const pageResults = result.details?.pageResults as Array<{ missingSegments: number }>;
    expect(pageResults[0].missingSegments).toBe(0);
  });

  it('protects fenced code block content from markdown stripping', async () => {
    // Documentation with example markdown/llms.txt content inside fenced code
    // blocks should not have headings, links, blockquotes, or list items
    // stripped from the code block content. The HTML side preserves this
    // literal text inside <pre><code> tags.
    const html = `<html><body><main>
      <h1>Example Format</h1>
      <p>The following shows a typical llms.txt file structure for documentation.</p>
      <pre><code># MongoDB Documentation

&gt; MongoDB is the leading document database. This index covers all
&gt; products, drivers, and tools documentation.

## Products

- [Atlas](https://www.mongodb.com/docs/atlas/llms.txt): Cloud database
- [Compass](https://www.mongodb.com/docs/compass/llms.txt): GUI tool</code></pre>
      <p>Each section starts with a level two heading followed by a list of links.</p>
      <p>The blockquote after the title provides a brief description of the documentation.</p>
      <p>Links use standard markdown syntax with the URL pointing to sub-project files.</p>
      <p>The structure is designed to be both human-readable and machine-parseable today.</p>
      <p>Sites can include as many sections as needed to cover all their documentation.</p>
      <p>The format is intentionally simple to encourage broad adoption across platforms.</p>
      <p>No special tooling is required to create or maintain these index files for sites.</p>
    </main></body></html>`;

    const markdown = `# Example Format

The following shows a typical llms.txt file structure for documentation.

\`\`\`
# MongoDB Documentation

> MongoDB is the leading document database. This index covers all
> products, drivers, and tools documentation.

## Products

- [Atlas](https://www.mongodb.com/docs/atlas/llms.txt): Cloud database
- [Compass](https://www.mongodb.com/docs/compass/llms.txt): GUI tool
\`\`\`

Each section starts with a level two heading followed by a list of links.

The blockquote after the title provides a brief description of the documentation.

Links use standard markdown syntax with the URL pointing to sub-project files.

The structure is designed to be both human-readable and machine-parseable today.

Sites can include as many sections as needed to cover all their documentation.

The format is intentionally simple to encourage broad adoption across platforms.

No special tooling is required to create or maintain these index files for sites.`;

    const url = 'http://mcp-codeblock.local/docs/format';

    server.use(
      http.get(
        url,
        () =>
          new HttpResponse(html, {
            status: 200,
            headers: { 'Content-Type': 'text/html' },
          }),
      ),
    );

    const ctx = makeCtx([{ url, markdown, htmlBody: html }], 'mcp-codeblock.local');
    const result = await check.run(ctx);
    expect(result.status).toBe('pass');
    const pageResults = result.details?.pageResults as Array<{ missingSegments: number }>;
    expect(pageResults[0].missingSegments).toBe(0);
  });

  it('protects fenced code blocks with non-word info strings (filename, attributes)', async () => {
    const html = `<html><body><main>
      <p>The greet helper takes a name and returns a friendly greeting string.</p>
      <pre><code>export default function greet(name) { return 'hi ' + name }</code></pre>
      <p>Good to know: This value must be set at build time and cannot be changed afterwards.</p>
      <pre><code>const x = 1</code></pre>
      <p>Callers import the default export and invoke it with any string argument.</p>
      <p>The implementation is intentionally minimal so that it has no runtime dependencies.</p>
      <p>Concatenation uses the plus operator which works for any value coerced to a string.</p>
      <p>The function returns a new string and never mutates the argument it receives.</p>
      <p>Errors are not handled; passing undefined produces the string "hi undefined".</p>
      <p>Tests cover the happy path and one edge case where the input is the empty string.</p>
      <p>The module has no side effects so tree-shaking removes it when it is unused.</p>
      <p>Bundlers see this as a pure ES module export and compile it without polyfills.</p>
      <p>Documentation examples elsewhere on the site reuse this helper for brevity.</p>
      <p>The greet helper is also re-exported from the package index for convenience.</p>
    </main></body></html>`;

    const markdown = `The greet helper takes a name and returns a friendly greeting string.

\`\`\`js filename="src/index.js"
export default function greet(name) { return 'hi ' + name }
\`\`\`

> **Good to know**: This value must be set at build time and cannot be changed afterwards.

\`\`\`tsx {1,3-5} showLineNumbers title="example"
const x = 1
\`\`\`

Callers import the default export and invoke it with any string argument.

The implementation is intentionally minimal so that it has no runtime dependencies.

Concatenation uses the plus operator which works for any value coerced to a string.

The function returns a new string and never mutates the argument it receives.

Errors are not handled; passing undefined produces the string "hi undefined".

Tests cover the happy path and one edge case where the input is the empty string.

The module has no side effects so tree-shaking removes it when it is unused.

Bundlers see this as a pure ES module export and compile it without polyfills.

Documentation examples elsewhere on the site reuse this helper for brevity.

The greet helper is also re-exported from the package index for convenience.`;

    const url = 'http://mcp-fence-attrs.local/docs/basepath';
    server.use(
      http.get(
        url,
        () =>
          new HttpResponse(html, {
            status: 200,
            headers: { 'Content-Type': 'text/html' },
          }),
      ),
    );

    const ctx = makeCtx([{ url, markdown, htmlBody: html }], 'mcp-fence-attrs.local');
    const result = await check.run(ctx);
    expect(result.status).toBe('pass');
    const pageResults = result.details?.pageResults as Array<{ missingSegments: number }>;
    expect(pageResults[0].missingSegments).toBe(0);
  });

  it('handles double-backtick code spans containing literal backticks', async () => {
    // Markdown uses double-backtick delimiters to show literal triple backticks:
    // `` ``` `` renders as <code>```</code> in HTML
    const html = `<html><body>
      <h1>Code Fence Documentation</h1>
      <p>Open a code fence with <code>\`\`\`</code> and close it with another <code>\`\`\`</code> delimiter.</p>
      <p>Tilde fences use <code>~~~</code> as their delimiter instead of backticks here.</p>
      <p>The opening and closing delimiters must use the same character type to match.</p>
      <p>Code fences can include an optional info string after the opening delimiter marker.</p>
      <p>The info string typically specifies the programming language for syntax highlighting.</p>
      <p>Indented code blocks are an alternative to fenced code blocks for simple cases.</p>
      <p>Blank lines inside a fenced code block are preserved exactly as written in source.</p>
      <p>The closing fence must have at least as many backticks as the opening fence marker.</p>
      <p>Fenced code blocks can contain any content including raw HTML tags and entities.</p>
      <p>Nested code fences require using more backticks than the inner fence uses here.</p>
    </body></html>`;

    const markdown = `# Code Fence Documentation

Open a code fence with \`\` \`\`\` \`\` and close it with another \`\` \`\`\` \`\` delimiter.

Tilde fences use \`~~~\` as their delimiter instead of backticks here.

The opening and closing delimiters must use the same character type to match.

Code fences can include an optional info string after the opening delimiter marker.

The info string typically specifies the programming language for syntax highlighting.

Indented code blocks are an alternative to fenced code blocks for simple cases.

Blank lines inside a fenced code block are preserved exactly as written in source.

The closing fence must have at least as many backticks as the opening fence marker.

Fenced code blocks can contain any content including raw HTML tags and entities.

Nested code fences require using more backticks than the inner fence uses here.`;

    const url = 'http://mcp-dblbacktick.local/docs/fences';

    server.use(
      http.get(
        url,
        () =>
          new HttpResponse(html, {
            status: 200,
            headers: { 'Content-Type': 'text/html' },
          }),
      ),
    );

    const ctx = makeCtx([{ url, markdown, htmlBody: html }], 'mcp-dblbacktick.local');
    const result = await check.run(ctx);
    expect(result.status).toBe('pass');
    const pageResults = result.details?.pageResults as Array<{ missingSegments: number }>;
    expect(pageResults[0].missingSegments).toBe(0);
  });

  it('does not let bare triple backticks cascade into distant backtick pairing', async () => {
    // When unmatched triple backticks appear in prose (e.g., discussing code
    // fence syntax), the single-backtick regex must not pair one of the
    // backticks with a distant backtick, swallowing content in between.
    const html = `<html><body>
      <h1>Delimiter Matching Rules</h1>
      <p>Mismatched delimiters (opening \`\`\` closing ~~~) produce unclosed fences.</p>
      <p>The <code>afdocs</code> tool validates that all code fences are properly closed.</p>
      <p>Common mistakes include forgetting to close a fence or mixing delimiter types.</p>
      <p>Always verify your markdown renders correctly before publishing documentation.</p>
      <p>The <code>llms.txt</code> file should also be checked for unclosed code fences.</p>
      <p>Automated linting can catch these issues before they reach production servers.</p>
      <p>Consider adding a pre-commit hook that validates markdown fence structure first.</p>
      <p>The check reports which line number contains the unclosed fence for debugging.</p>
      <p>Fix unclosed fences by adding the matching closing delimiter at the right spot.</p>
      <p>Some editors highlight unclosed fences to help you spot them while writing docs.</p>
    </body></html>`;

    const markdown = `# Delimiter Matching Rules

Mismatched delimiters (opening \`\`\` closing ~~~) produce unclosed fences.

The \`afdocs\` tool validates that all code fences are properly closed.

Common mistakes include forgetting to close a fence or mixing delimiter types.

Always verify your markdown renders correctly before publishing documentation.

The \`llms.txt\` file should also be checked for unclosed code fences.

Automated linting can catch these issues before they reach production servers.

Consider adding a pre-commit hook that validates markdown fence structure first.

The check reports which line number contains the unclosed fence for debugging.

Fix unclosed fences by adding the matching closing delimiter at the right spot.

Some editors highlight unclosed fences to help you spot them while writing docs.`;

    const url = 'http://mcp-barebacktick.local/docs/delimiters';

    server.use(
      http.get(
        url,
        () =>
          new HttpResponse(html, {
            status: 200,
            headers: { 'Content-Type': 'text/html' },
          }),
      ),
    );

    const ctx = makeCtx([{ url, markdown, htmlBody: html }], 'mcp-barebacktick.local');
    const result = await check.run(ctx);
    expect(result.status).toBe('pass');
    const pageResults = result.details?.pageResults as Array<{ missingSegments: number }>;
    expect(pageResults[0].missingSegments).toBe(0);
  });

  it('applies CommonMark space stripping to multi-backtick code span content', async () => {
    // CommonMark: when code span content starts and ends with a space (and
    // isn't entirely spaces), one space is stripped from each end.
    // `` ``` `` renders as ``` (spaces stripped), not  ```  (with spaces).
    const html = `<html><body>
      <h1>Fence Delimiter Reference</h1>
      <p>A backtick fence (<code>\`\`\`</code>) opens a code block for multi-line content.</p>
      <p>The info string after <code>\`\`\`</code> specifies the language for highlighting.</p>
      <p>This documentation explains how to properly format code blocks in markdown files.</p>
      <p>Proper formatting ensures that syntax highlighting works correctly in renderers.</p>
      <p>All major markdown processors support fenced code blocks with language hints now.</p>
      <p>The CommonMark specification defines the exact rules for fence delimiter matching.</p>
      <p>GitHub Flavored Markdown extends CommonMark with additional features for tables.</p>
      <p>Documentation generators like Hugo and Jekyll also support fenced code blocks well.</p>
      <p>Testing your markdown output helps catch formatting issues before they go live now.</p>
      <p>Use a linter to automatically verify code fence syntax across all your documents.</p>
    </body></html>`;

    const markdown = `# Fence Delimiter Reference

A backtick fence (\`\` \`\`\` \`\`) opens a code block for multi-line content.

The info string after \`\` \`\`\` \`\` specifies the language for highlighting.

This documentation explains how to properly format code blocks in markdown files.

Proper formatting ensures that syntax highlighting works correctly in renderers.

All major markdown processors support fenced code blocks with language hints now.

The CommonMark specification defines the exact rules for fence delimiter matching.

GitHub Flavored Markdown extends CommonMark with additional features for tables.

Documentation generators like Hugo and Jekyll also support fenced code blocks well.

Testing your markdown output helps catch formatting issues before they go live now.

Use a linter to automatically verify code fence syntax across all your documents.`;

    const url = 'http://mcp-cmark-space.local/docs/fences';

    server.use(
      http.get(
        url,
        () =>
          new HttpResponse(html, {
            status: 200,
            headers: { 'Content-Type': 'text/html' },
          }),
      ),
    );

    const ctx = makeCtx([{ url, markdown, htmlBody: html }], 'mcp-cmark-space.local');
    const result = await check.run(ctx);
    expect(result.status).toBe('pass');
    const pageResults = result.details?.pageResults as Array<{ missingSegments: number }>;
    expect(pageResults[0].missingSegments).toBe(0);
  });

  it('handles single-backtick code spans containing literal backticks', async () => {
    // CommonMark allows ` ``` ` (single-backtick delimiters with triple-backtick
    // content). The triple backtick inside is not a closer because it's a
    // backtick string of length 3, not length 1. The regex must match this
    // as a valid code span without cascading into distant backtick pairing.
    const html = `<html><body>
      <h1>Code Fence Syntax</h1>
      <p>A backtick fence (<code>\`\`\`</code>) can only be closed by another backtick fence.</p>
      <p>A tilde fence (<code>~~~</code>) closing a backtick-opened fence leaves it unclosed.</p>
      <p>Run with <code>--verbose</code> to see which pages have unclosed code fences today.</p>
      <p>Ensure every opening <code>\`\`\`</code> or <code>~~~</code> has a matching closing fence.</p>
      <p>Nested code examples are the most common source of fence mismatches in practice.</p>
      <p>The check validates all code fences across every page discovered during the scan.</p>
      <p>CommonMark requires the closing delimiter to be the same type as the opening one.</p>
      <p>Indented code blocks do not require explicit delimiters but are harder to maintain.</p>
      <p>Some editors provide visual indicators for unclosed fences to help catch mistakes.</p>
      <p>Always preview your rendered markdown to verify code blocks display correctly here.</p>
    </body></html>`;

    const markdown =
      '# Code Fence Syntax\n\n' +
      'A backtick fence (` ``` `) can only be closed by another backtick fence.\n\n' +
      'A tilde fence (`~~~`) closing a backtick-opened fence leaves it unclosed.\n\n' +
      'Run with `--verbose` to see which pages have unclosed code fences today.\n\n' +
      'Ensure every opening ` ``` ` or `~~~` has a matching closing fence.\n\n' +
      'Nested code examples are the most common source of fence mismatches in practice.\n\n' +
      'The check validates all code fences across every page discovered during the scan.\n\n' +
      'CommonMark requires the closing delimiter to be the same type as the opening one.\n\n' +
      'Indented code blocks do not require explicit delimiters but are harder to maintain.\n\n' +
      'Some editors provide visual indicators for unclosed fences to help catch mistakes.\n\n' +
      'Always preview your rendered markdown to verify code blocks display correctly here.';

    const url = 'http://mcp-singlebacktick.local/docs/fences';

    server.use(
      http.get(
        url,
        () =>
          new HttpResponse(html, {
            status: 200,
            headers: { 'Content-Type': 'text/html' },
          }),
      ),
    );

    const ctx = makeCtx([{ url, markdown, htmlBody: html }], 'mcp-singlebacktick.local');
    const result = await check.run(ctx);
    expect(result.status).toBe('pass');
    const pageResults = result.details?.pageResults as Array<{ missingSegments: number }>;
    expect(pageResults[0].missingSegments).toBe(0);
  });

  it('strips underscore emphasis at word boundaries without mangling identifiers', async () => {
    // _emphasis_ in prose (underscores at word boundaries) should be stripped
    // to match HTML extraction. But mongoc_client_get_database (underscores
    // adjacent to word characters) must be preserved.
    const html = `<html><body><main>
      <h1>Database Driver Guide</h1>
      <p>In empirical testing, soft 404s performed <em>worse</em> than real 404s for agents.</p>
      <p>Agents do <em>not</em> read your navigation structure when fetching documentation.</p>
      <p>Use mongoc_client_get_database to obtain a database handle from the client object.</p>
      <p>The mongoc_cursor_next function advances the cursor to the <em>next</em> result document.</p>
      <p>This behavior is <em>intentional</em> and matches the CommonMark specification exactly.</p>
      <p>Release resources with mongoc_client_destroy when the client is no longer needed here.</p>
      <p>The response includes a <em>detailed</em> error message explaining what went wrong here.</p>
      <p>Call mongoc_collection_find_with_opts to query documents with filter options today.</p>
      <p>Documentation should be <em>clear</em> and concise for both humans and agents reading.</p>
      <p>The mongoc_collection_insert_one function inserts a single document into collection.</p>
    </main></body></html>`;

    const markdown = `# Database Driver Guide

In empirical testing, soft 404s performed _worse_ than real 404s for agents.

Agents do _not_ read your navigation structure when fetching documentation.

Use mongoc_client_get_database to obtain a database handle from the client object.

The mongoc_cursor_next function advances the cursor to the _next_ result document.

This behavior is _intentional_ and matches the CommonMark specification exactly.

Release resources with mongoc_client_destroy when the client is no longer needed here.

The response includes a _detailed_ error message explaining what went wrong here.

Call mongoc_collection_find_with_opts to query documents with filter options today.

Documentation should be _clear_ and concise for both humans and agents reading.

The mongoc_collection_insert_one function inserts a single document into collection.`;

    const url = 'http://mcp-underscore-emphasis.local/docs/driver';

    server.use(
      http.get(
        url,
        () =>
          new HttpResponse(html, {
            status: 200,
            headers: { 'Content-Type': 'text/html' },
          }),
      ),
    );

    const ctx = makeCtx([{ url, markdown, htmlBody: html }], 'mcp-underscore-emphasis.local');
    const result = await check.run(ctx);
    expect(result.status).toBe('pass');
    const pageResults = result.details?.pageResults as Array<{ missingSegments: number }>;
    expect(pageResults[0].missingSegments).toBe(0);
  });

  // --- Audience segmentation tests ---

  it('strips data-markdown-ignore elements from HTML before comparison', async () => {
    // Content inside data-markdown-ignore is intended only for human readers;
    // it is expected to be absent from the markdown version.
    const html = `<html><body><main>
      <h1>Getting Started</h1>
      <p>Install the SDK with npm to add it to your project dependencies list.</p>
      <div data-markdown-ignore>
        <p>Click the gear icon in the top-right corner to open the settings panel.</p>
        <p>Navigate to the API section and click Generate New Key to create credentials.</p>
      </div>
      <p>Then import the client module and configure it with your API credentials here.</p>
      <p>Run the following commands to get started with the installation process now.</p>
      <p>After installation import the client and call the initialize method first please.</p>
      <p>The client will automatically detect your configuration from environment variables.</p>
      <p>You can override any configuration option by passing it to the constructor directly.</p>
      <p>Make sure your API key is set before attempting to make any requests to the server.</p>
      <p>The library validates all configuration options and throws helpful error messages.</p>
      <p>Connection pooling is handled automatically for optimal performance and throughput.</p>
      <p>TLS certificates are verified by default to ensure secure communication channels.</p>
    </main></body></html>`;

    const markdown = `# Getting Started

Install the SDK with npm to add it to your project dependencies list.

Then import the client module and configure it with your API credentials here.

Run the following commands to get started with the installation process now.

After installation import the client and call the initialize method first please.

The client will automatically detect your configuration from environment variables.

You can override any configuration option by passing it to the constructor directly.

Make sure your API key is set before attempting to make any requests to the server.

The library validates all configuration options and throws helpful error messages.

Connection pooling is handled automatically for optimal performance and throughput.

TLS certificates are verified by default to ensure secure communication channels.`;

    const url = 'http://mcp-segmentation.local/docs/start';

    server.use(
      http.get(
        url,
        () =>
          new HttpResponse(html, {
            status: 200,
            headers: { 'Content-Type': 'text/html' },
          }),
      ),
    );

    const ctx = makeCtx([{ url, markdown, htmlBody: html }], 'mcp-segmentation.local');
    const result = await check.run(ctx);
    expect(result.status).toBe('pass');
    const pageResults = result.details?.pageResults as Array<{ missingSegments: number }>;
    expect(pageResults[0].missingSegments).toBe(0);
    expect(result.details?.segmentationElementsStripped).toBe(1);
  });

  it('strips form-control chrome (select, input, textarea) before comparison', async () => {
    const html = `<html><body><main>
      <p>The greet helper takes a name and returns a friendly greeting string.</p>
      <pre><code>greet('world')</code></pre>
      <select><option value="js">JavaScript Source</option><option value="ts">TypeScript Source</option></select>
      <p>Callers import the default export and invoke it with any string argument.</p>
      <p>The implementation is intentionally minimal so that it has no runtime dependencies.</p>
      <p>Concatenation uses the plus operator which works for any value coerced to a string.</p>
      <p>The function returns a new string and never mutates the argument it receives.</p>
      <p>Errors are not handled; passing undefined produces the string "hi undefined".</p>
      <p>Tests cover the happy path and one edge case where the input is the empty string.</p>
      <p>The module has no side effects so tree-shaking removes it when it is unused.</p>
      <p>Bundlers see this as a pure ES module export and compile it without polyfills.</p>
      <p>Documentation examples elsewhere on the site reuse this helper for brevity.</p>
      <p>The greet helper is also re-exported from the package index for convenience.</p>
    </main></body></html>`;

    const markdown = `The greet helper takes a name and returns a friendly greeting string.

\`\`\`js
greet('world')
\`\`\`

Callers import the default export and invoke it with any string argument.

The implementation is intentionally minimal so that it has no runtime dependencies.

Concatenation uses the plus operator which works for any value coerced to a string.

The function returns a new string and never mutates the argument it receives.

Errors are not handled; passing undefined produces the string "hi undefined".

Tests cover the happy path and one edge case where the input is the empty string.

The module has no side effects so tree-shaking removes it when it is unused.

Bundlers see this as a pure ES module export and compile it without polyfills.

Documentation examples elsewhere on the site reuse this helper for brevity.

The greet helper is also re-exported from the package index for convenience.`;

    const url = 'http://mcp-form-controls.local/docs/greet';
    server.use(
      http.get(
        url,
        () =>
          new HttpResponse(html, {
            status: 200,
            headers: { 'Content-Type': 'text/html' },
          }),
      ),
    );

    const ctx = makeCtx([{ url, markdown, htmlBody: html }], 'mcp-form-controls.local');
    const result = await check.run(ctx);
    expect(result.status).toBe('pass');
    const pageResults = result.details?.pageResults as Array<{ missingSegments: number }>;
    expect(pageResults[0].missingSegments).toBe(0);
  });

  it('preserves inline `<tag>` code spans on the HTML side (issue #90)', async () => {
    // Markdown like `<code>` (a code span whose content looks like an HTML
    // tag) renders to <code>&lt;code&gt;</code>. The DOM walker emits the
    // entity-decoded text "<code>" literally; normalize() then strips angle
    // brackets so both sides produce "code". Previously the text-level
    // tag-stripping regex deleted these as if they were tags.
    const html = `<html><body><main>
      <h1>Code Examples in Prose</h1>
      <p>This type of code example should not be rendered using the HTML <code>&lt;code&gt;</code> tag in any context.</p>
      <p>The <code>&lt;main&gt;</code> element is for the main content area of the page document body.</p>
      <p>Use the <code>&lt;title&gt;</code> tag inside <code>&lt;head&gt;</code> to set the page title for browsers.</p>
      <p>The <code>&lt;h1&gt;</code> element should appear once per page as the top-level heading content.</p>
      <p>The <code>&lt;link&gt;</code> element pulls in stylesheets and other external resources for rendering.</p>
      <p>Anchor elements use <code>&lt;a&gt;</code> with an href attribute pointing to the destination url.</p>
      <p>The <code>&lt;nav&gt;</code> element wraps navigation menus that link to other pages on the site.</p>
      <p>For inline emphasis use <code>&lt;em&gt;</code> rather than the older italic element from the past.</p>
      <p>The <code>&lt;article&gt;</code> element groups self-contained pieces of content like blog posts.</p>
      <p>Use <code>&lt;section&gt;</code> for thematic groupings of content within a page or document body.</p>
    </main></body></html>`;

    const markdown = `# Code Examples in Prose

This type of code example should not be rendered using the HTML \`<code>\` tag in any context.

The \`<main>\` element is for the main content area of the page document body.

Use the \`<title>\` tag inside \`<head>\` to set the page title for browsers.

The \`<h1>\` element should appear once per page as the top-level heading content.

The \`<link>\` element pulls in stylesheets and other external resources for rendering.

Anchor elements use \`<a>\` with an href attribute pointing to the destination url.

The \`<nav>\` element wraps navigation menus that link to other pages on the site.

For inline emphasis use \`<em>\` rather than the older italic element from the past.

The \`<article>\` element groups self-contained pieces of content like blog posts.

Use \`<section>\` for thematic groupings of content within a page or document body.`;

    const url = 'http://mcp-tag-spans.local/docs/code-examples';
    server.use(
      http.get(
        url,
        () =>
          new HttpResponse(html, {
            status: 200,
            headers: { 'Content-Type': 'text/html' },
          }),
      ),
    );

    const ctx = makeCtx([{ url, markdown, htmlBody: html }], 'mcp-tag-spans.local');
    const result = await check.run(ctx);
    expect(result.status).toBe('pass');
    const pageResults = result.details?.pageResults as Array<{ missingSegments: number }>;
    expect(pageResults[0].missingSegments).toBe(0);
  });

  it('preserves leading numbers in headings (issue #91)', async () => {
    // Headings like "### 1. How well..." render to "<h3>1. How well...</h3>",
    // where "1. " is part of the heading text, not a list marker. The
    // markdown extractor must not run the numbered-list regex against
    // heading content or the segments won't match.
    const html = `<html><body><main>
      <h1>Audit Conclusions</h1>
      <p>This document summarizes findings across four numbered research questions about agent docs.</p>
      <h3>1. How well are key programming languages supported by code examples?</h3>
      <p>Most documentation covers JavaScript and Python well but lags on Go and Rust ecosystem support.</p>
      <h3>2. Are authentication flows documented for both web and machine-to-machine clients?</h3>
      <p>Web flows are well documented but service-to-service flows often skip the credential rotation steps.</p>
      <h3>3. Is the rate-limiting behavior described in enough detail to handle gracefully?</h3>
      <p>Most APIs document headers and quotas but few cover the retry-after semantics in detail.</p>
      <h3>4. Are versioning and deprecation policies clearly communicated to integrators?</h3>
      <p>Versioning is consistent across the platforms surveyed but deprecation timelines are often vague.</p>
      <p>The above questions framed the audit and inform the recommendations in the next section.</p>
    </main></body></html>`;

    const markdown = `# Audit Conclusions

This document summarizes findings across four numbered research questions about agent docs.

### 1. How well are key programming languages supported by code examples?

Most documentation covers JavaScript and Python well but lags on Go and Rust ecosystem support.

### 2. Are authentication flows documented for both web and machine-to-machine clients?

Web flows are well documented but service-to-service flows often skip the credential rotation steps.

### 3. Is the rate-limiting behavior described in enough detail to handle gracefully?

Most APIs document headers and quotas but few cover the retry-after semantics in detail.

### 4. Are versioning and deprecation policies clearly communicated to integrators?

Versioning is consistent across the platforms surveyed but deprecation timelines are often vague.

The above questions framed the audit and inform the recommendations in the next section.`;

    const url = 'http://mcp-numbered-headings.local/blog/audit';
    server.use(
      http.get(
        url,
        () =>
          new HttpResponse(html, {
            status: 200,
            headers: { 'Content-Type': 'text/html' },
          }),
      ),
    );

    const ctx = makeCtx([{ url, markdown, htmlBody: html }], 'mcp-numbered-headings.local');
    const result = await check.run(ctx);
    expect(result.status).toBe('pass');
    const pageResults = result.details?.pageResults as Array<{ missingSegments: number }>;
    expect(pageResults[0].missingSegments).toBe(0);
  });

  it('uses configurable thresholds (0/0 = informational mode)', async () => {
    // Setting both thresholds to 0 means the check always passes,
    // making it informational for sites with intentional content divergence.
    const html = `<html><body>
      <h1>Installation Guide</h1>
      <p>You need Node.js 18 or later installed on your system before proceeding.</p>
      <p>Create a configuration file with your API credentials and region settings.</p>
      <p>Import and initialize the client using the configuration you just created.</p>
      <p>Run the health check to verify everything is working correctly in your environment.</p>
      <p>Common issues include connection timeouts and authentication failures with expired keys.</p>
      <p>Check your network connectivity if you experience connection timeout errors repeatedly.</p>
      <p>Verify your API key has not expired if you see authentication failure messages.</p>
      <p>Make sure the target host is accessible and responding to network requests properly.</p>
      <p>Review the troubleshooting section for additional debugging information and tips.</p>
      <p>Contact support if you continue to experience issues after following these steps.</p>
      <p>The installation process should take approximately five minutes from start to finish.</p>
    </body></html>`;

    const markdown = `# Changelog

## v2.0.0

Breaking changes in this release that affect all existing integrations.

## v1.5.0

Added new features for managing team resources and permissions.`;

    const url = 'http://mcp-informational.local/docs/install';

    server.use(
      http.get(
        url,
        () =>
          new HttpResponse(html, {
            status: 200,
            headers: { 'Content-Type': 'text/html' },
          }),
      ),
    );

    const ctx = makeCtx([{ url, markdown, htmlBody: html }], 'mcp-informational.local', {
      parityPassThreshold: 0,
      parityWarnThreshold: 0,
    });
    const result = await check.run(ctx);
    // With thresholds at 0, even massive differences pass
    expect(result.status).toBe('pass');
    const pageResults = result.details?.pageResults as Array<{ missingPercent: number }>;
    // The missing percentage is still reported even though the check passes
    expect(pageResults[0].missingPercent).toBeGreaterThan(0);
  });

  it('applies custom parityExclusions CSS selectors', async () => {
    // Site uses a custom attribute for audience segmentation that isn't
    // data-markdown-ignore. The user provides it via parityExclusions.
    const html = `<html><body><main>
      <h1>API Reference</h1>
      <p>The API supports the following operations for managing resources securely.</p>
      <section class="human-only-ui-steps">
        <p>Open the dashboard and navigate to the API Keys section in the sidebar.</p>
        <p>Click the Create button to generate a new API key for your application.</p>
      </section>
      <p>Use bearer tokens for authentication with the API endpoints on every request.</p>
      <p>Include your API key in the Authorization header of every request you send.</p>
      <p>Requests are limited to one hundred per minute per API key by default now.</p>
      <p>Error responses include a JSON body with a code field and a message for details.</p>
      <p>Use cursor-based pagination with the after parameter in your requests to pages.</p>
      <p>Each page returns up to fifty items by default unless configured otherwise here.</p>
      <p>The SDK supports automatic retries with exponential backoff for transient failures.</p>
      <p>Configure the maximum number of retries using the maxRetries constructor option.</p>
      <p>All requests are authenticated automatically using the configured API credentials.</p>
    </main></body></html>`;

    const markdown = `# API Reference

The API supports the following operations for managing resources securely.

Use bearer tokens for authentication with the API endpoints on every request.

Include your API key in the Authorization header of every request you send.

Requests are limited to one hundred per minute per API key by default now.

Error responses include a JSON body with a code field and a message for details.

Use cursor-based pagination with the after parameter in your requests to pages.

Each page returns up to fifty items by default unless configured otherwise here.

The SDK supports automatic retries with exponential backoff for transient failures.

Configure the maximum number of retries using the maxRetries constructor option.

All requests are authenticated automatically using the configured API credentials.`;

    const url = 'http://mcp-custom-excl.local/docs/api';

    server.use(
      http.get(
        url,
        () =>
          new HttpResponse(html, {
            status: 200,
            headers: { 'Content-Type': 'text/html' },
          }),
      ),
    );

    const ctx = makeCtx([{ url, markdown, htmlBody: html }], 'mcp-custom-excl.local', {
      parityExclusions: ['.human-only-ui-steps'],
    });
    const result = await check.run(ctx);
    expect(result.status).toBe('pass');
    const pageResults = result.details?.pageResults as Array<{ missingSegments: number }>;
    expect(pageResults[0].missingSegments).toBe(0);
  });

  it('reports custom thresholds in details when non-default', async () => {
    const html =
      '<html><body><h1>Page</h1><p>Content that matches between HTML and markdown versions exactly.</p></body></html>';
    const markdown = '# Page\n\nContent that matches between HTML and markdown versions exactly.';
    const url = 'http://mcp-threshold-report.local/docs/page';

    server.use(
      http.get(
        url,
        () =>
          new HttpResponse(html, {
            status: 200,
            headers: { 'Content-Type': 'text/html' },
          }),
      ),
    );

    const ctx = makeCtx([{ url, markdown, htmlBody: html }], 'mcp-threshold-report.local', {
      parityPassThreshold: 10,
      parityWarnThreshold: 30,
    });
    const result = await check.run(ctx);
    expect(result.details?.parityPassThreshold).toBe(10);
    expect(result.details?.parityWarnThreshold).toBe(30);
  });

  it('reports a clear error for invalid CSS selectors in parityExclusions', async () => {
    const html = `<html><body><main>
      <h1>Page Title</h1>
      <p>Content that is long enough to form a meaningful segment for comparison.</p>
      <p>Additional content that provides enough segments for a valid comparison run.</p>
      <p>Third paragraph ensures we are above the minimum segment threshold limit.</p>
      <p>Fourth paragraph provides additional content for the comparison to process.</p>
      <p>Fifth paragraph rounds out the content to ensure robust segment extraction.</p>
      <p>Sixth paragraph adds more unique text to exceed the minimum required amount.</p>
      <p>Seventh paragraph continues to build the content body for a thorough check.</p>
      <p>Eighth paragraph ensures this page has plenty of content for the check run.</p>
      <p>Ninth paragraph keeps the content flowing with additional unique text here.</p>
      <p>Tenth paragraph wraps up the page with one final block of meaningful text.</p>
    </main></body></html>`;
    const markdown = '# Page Title\n\nSome markdown content here.';
    const url = 'http://mcp-bad-selector.local/docs/page';

    server.use(
      http.get(
        url,
        () =>
          new HttpResponse(html, {
            status: 200,
            headers: { 'Content-Type': 'text/html' },
          }),
      ),
    );

    const ctx = makeCtx([{ url, markdown, htmlBody: html }], 'mcp-bad-selector.local', {
      parityExclusions: ['[data-foo='],
    });
    const result = await check.run(ctx);
    const pageResults = result.details?.pageResults as Array<{ error?: string }>;
    expect(pageResults[0].error).toContain('Invalid CSS selector');
  });

  it('honors fence length: an N-backtick fence contains shorter runs as content', async () => {
    // 4-backtick outer fence wrapping 3-backtick inner fences. The inner
    // markers are content per CommonMark §4.5 and must not be consumed as
    // delimiters when extracting markdown text.
    const html = `<html><body><main>
      <p>The following demonstrates how an outer fenced block can contain shorter fences.</p>
      <p>Readers should see the inner backtick lines exactly as written, with no rendering applied.</p>
      <pre><code>\`\`\`alpha filename="first.txt"
first inner body line that is long enough to count
\`\`\`

\`\`\`beta filename="second.txt"
second inner body line that is long enough to count
\`\`\`

\`\`\`gamma filename="third.txt"
third inner body line that is long enough to count
\`\`\`</code></pre>
      <p>This pattern lets prose explain how to author fenced blocks without rendering them.</p>
      <p>The same shape appears in any documentation that teaches markdown or MDX syntax.</p>
      <p>It is also used when one tool's output happens to include backtick-delimited regions.</p>
      <p>Comparing the two formats requires both sides to treat the inner lines as plain text.</p>
      <p>Otherwise the markdown extractor will consume the inner markers as real delimiters.</p>
      <p>That asymmetry produces missing segments even though the two sources carry equal text.</p>
      <p>Extracting the markdown side must respect the opener length and look for a matching close.</p>
      <p>A four-backtick opener can only be terminated by a four-or-more-backtick closing line.</p>
    </main></body></html>`;

    const markdown = `The following demonstrates how an outer fenced block can contain shorter fences.

Readers should see the inner backtick lines exactly as written, with no rendering applied.

\`\`\`\`outer filename="example.mdx"
\`\`\`alpha filename="first.txt"
first inner body line that is long enough to count
\`\`\`

\`\`\`beta filename="second.txt"
second inner body line that is long enough to count
\`\`\`

\`\`\`gamma filename="third.txt"
third inner body line that is long enough to count
\`\`\`
\`\`\`\`

This pattern lets prose explain how to author fenced blocks without rendering them.

The same shape appears in any documentation that teaches markdown or MDX syntax.

It is also used when one tool's output happens to include backtick-delimited regions.

Comparing the two formats requires both sides to treat the inner lines as plain text.

Otherwise the markdown extractor will consume the inner markers as real delimiters.

That asymmetry produces missing segments even though the two sources carry equal text.

Extracting the markdown side must respect the opener length and look for a matching close.

A four-backtick opener can only be terminated by a four-or-more-backtick closing line.`;

    const url = 'http://mcp-nested-fence.local/docs/page';
    server.use(
      http.get(
        url,
        () =>
          new HttpResponse(html, {
            status: 200,
            headers: { 'Content-Type': 'text/html' },
          }),
      ),
    );

    const ctx = makeCtx([{ url, markdown, htmlBody: html }], 'mcp-nested-fence.local');
    const result = await check.run(ctx);
    expect(result.status).toBe('pass');
    const pageResults = result.details?.pageResults as Array<{ missingSegments: number }>;
    expect(pageResults[0].missingSegments).toBe(0);
  });

  it('allows a 3-backtick fence to be closed by a longer backtick run', async () => {
    // CommonMark allows the closer to be longer than the opener. Markdown
    // syntax inside the block must still be shielded from later stripping.
    const html = `<html><body><main>
      <p>The block below is a regular three-backtick fence with a longer closing run.</p>
      <p>Both formats should preserve every line inside it as literal text content.</p>
      <pre><code># Heading inside a code block stays as literal text
- list item inside a code block stays as literal text
&gt; blockquote inside a code block stays as literal text</code></pre>
      <p>Heading-like content inside the fenced block must not be stripped on either side.</p>
      <p>The same applies to list bullets and blockquote markers that look like markdown syntax.</p>
      <p>This shape appears whenever an author chose a longer run for visual symmetry reasons.</p>
      <p>The closer can have any number of backticks above the opener length, with optional spaces.</p>
      <p>Trailing whitespace on the closer line is also tolerated by the underlying CommonMark spec.</p>
      <p>Authors sometimes pad closers with extra backticks to make blocks visually distinct.</p>
      <p>The parity check should treat all of those variations as equivalent fenced regions.</p>
    </main></body></html>`;

    const markdown = `The block below is a regular three-backtick fence with a longer closing run.

Both formats should preserve every line inside it as literal text content.

\`\`\`
# Heading inside a code block stays as literal text
- list item inside a code block stays as literal text
> blockquote inside a code block stays as literal text
\`\`\`\`

Heading-like content inside the fenced block must not be stripped on either side.

The same applies to list bullets and blockquote markers that look like markdown syntax.

This shape appears whenever an author chose a longer run for visual symmetry reasons.

The closer can have any number of backticks above the opener length, with optional spaces.

Trailing whitespace on the closer line is also tolerated by the underlying CommonMark spec.

Authors sometimes pad closers with extra backticks to make blocks visually distinct.

The parity check should treat all of those variations as equivalent fenced regions.`;

    const url = 'http://mcp-longer-closer.local/docs/page';
    server.use(
      http.get(
        url,
        () =>
          new HttpResponse(html, {
            status: 200,
            headers: { 'Content-Type': 'text/html' },
          }),
      ),
    );

    const ctx = makeCtx([{ url, markdown, htmlBody: html }], 'mcp-longer-closer.local');
    const result = await check.run(ctx);
    expect(result.status).toBe('pass');
    const pageResults = result.details?.pageResults as Array<{ missingSegments: number }>;
    expect(pageResults[0].missingSegments).toBe(0);
  });

  it('handles deeply nested fences with strictly decreasing backtick runs', async () => {
    // 5/4/3 nesting. Each level's closer must match its own opener length;
    // guards against regressions that special-case any single run length.
    const html = `<html><body><main>
      <p>The following demonstrates a three-level nest with five, four, and three backticks.</p>
      <p>All inner backtick lines must reach the reader as literal text on both sides.</p>
      <pre><code>\`\`\`\`level-two filename="middle.md"
\`\`\`level-three filename="inner.txt"
innermost body line that is long enough to count
\`\`\`
\`\`\`\`</code></pre>
      <p>Authors use this pattern when the example itself is meta and contains other examples.</p>
      <p>Each layer must independently survive segmentation and comparison without leaks.</p>
      <p>The outermost fence opens and closes with five backticks to dominate every inner run.</p>
      <p>The middle fence uses four backticks because its content includes triple-backtick lines.</p>
      <p>The innermost three-backtick fence is just a normal code block at the bottom of the nest.</p>
      <p>Removing any layer would change the literal text and is therefore not equivalent content.</p>
      <p>This test guards against regressions that special-case any single backtick run length.</p>
    </main></body></html>`;

    const markdown = `The following demonstrates a three-level nest with five, four, and three backticks.

All inner backtick lines must reach the reader as literal text on both sides.

\`\`\`\`\`level-one filename="outer.mdx"
\`\`\`\`level-two filename="middle.md"
\`\`\`level-three filename="inner.txt"
innermost body line that is long enough to count
\`\`\`
\`\`\`\`
\`\`\`\`\`

Authors use this pattern when the example itself is meta and contains other examples.

Each layer must independently survive segmentation and comparison without leaks.

The outermost fence opens and closes with five backticks to dominate every inner run.

The middle fence uses four backticks because its content includes triple-backtick lines.

The innermost three-backtick fence is just a normal code block at the bottom of the nest.

Removing any layer would change the literal text and is therefore not equivalent content.

This test guards against regressions that special-case any single backtick run length.`;

    const url = 'http://mcp-deep-nest.local/docs/page';
    server.use(
      http.get(
        url,
        () =>
          new HttpResponse(html, {
            status: 200,
            headers: { 'Content-Type': 'text/html' },
          }),
      ),
    );

    const ctx = makeCtx([{ url, markdown, htmlBody: html }], 'mcp-deep-nest.local');
    const result = await check.run(ctx);
    expect(result.status).toBe('pass');
    const pageResults = result.details?.pageResults as Array<{ missingSegments: number }>;
    expect(pageResults[0].missingSegments).toBe(0);
  });

  it('protects fenced code blocks indented inside list items', async () => {
    // Turndown indents fenced code blocks by 4 spaces when they appear inside
    // numbered list items. Without this fix, the code fence regex (which
    // required backticks at column 0) failed to match, leaving the YAML list
    // lines unprotected. The list-marker stripper then removed the leading
    // "- " from lines like "- db_data:/var/lib/postgresql/data", so the HTML
    // segment "- db_data:/var/lib/postgresql/data" had no match in the
    // stripped markdown text.
    const html = `<html><body><main>
      <h1>Install with Docker</h1>
      <p>Use the steps below to install FusionAuth using Docker Compose.</p>
      <ol>
        <li>
          <p>Download the configuration files from the repository.</p>
          <p>Full docker-compose.yml example:</p>
          <pre><code class="language-yaml">services:
  db:
    image: postgres:16.0-bookworm
    volumes:
      <span class="token punctuation">-</span> db_data<span class="token punctuation">:</span>/var/lib/postgresql/data
  fusionauth:
    image: fusionauth/fusionauth-app:latest
    volumes:
      <span class="token punctuation">-</span> fusionauth_config<span class="token punctuation">:</span>/usr/local/fusionauth/config
      <span class="token punctuation">-</span> \${FUSIONAUTH_LOCAL_KICKSTART_DIRECTORY}<span class="token punctuation">:</span>/usr/local/fusionauth/kickstart
volumes:
  db_data<span class="token punctuation">:</span>
  fusionauth_config<span class="token punctuation">:</span>
</code></pre>
        </li>
        <li>
          <p>Start the services with docker compose up.</p>
          <p>The first startup may take several minutes while images download.</p>
        </li>
      </ol>
    </main></body></html>`;

    const markdown = `# Install with Docker

Use the steps below to install FusionAuth using Docker Compose.

1.  Download the configuration files from the repository.

    Full docker-compose.yml example:

    \`\`\`yaml
    services:
      db:
        image: postgres:16.0-bookworm
        volumes:
          - db_data:/var/lib/postgresql/data
      fusionauth:
        image: fusionauth/fusionauth-app:latest
        volumes:
          - fusionauth_config:/usr/local/fusionauth/config
          - \${FUSIONAUTH_LOCAL_KICKSTART_DIRECTORY}:/usr/local/fusionauth/kickstart
    volumes:
      db_data:
      fusionauth_config:
    \`\`\`

2.  Start the services with docker compose up.

    The first startup may take several minutes while images download.`;

    const url = 'http://mcp-indented-fence.local/docs/docker';

    server.use(
      http.get(
        url,
        () =>
          new HttpResponse(html, {
            status: 200,
            headers: { 'Content-Type': 'text/html' },
          }),
      ),
    );

    const ctx = makeCtx([{ url, markdown, htmlBody: html }], 'mcp-indented-fence.local');
    const result = await check.run(ctx);
    expect(result.status).toBe('pass');
    const pageResults = result.details?.pageResults as Array<{ missingSegments: number }>;
    expect(pageResults[0].missingSegments).toBe(0);
  });
});
