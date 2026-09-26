import { describe, it, expect, beforeAll } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { createContext } from '../../../src/runner.js';
import { getCheck } from '../../../src/checks/registry.js';
import '../../../src/checks/index.js';
import type { DiscoveredFile } from '../../../src/types.js';
import { mockSitemapNotFound } from '../../helpers/mock-sitemap-not-found.js';

const server = setupServer();

beforeAll(() => {
  server.listen({ onUnhandledRequest: 'bypass' });
  return () => server.close();
});

describe('auth-gate-detection', () => {
  const check = getCheck('auth-gate-detection')!;

  function makeCtx(llmsTxtContent?: string) {
    const ctx = createContext('http://test.local', { requestDelay: 0 });

    if (llmsTxtContent) {
      const discovered: DiscoveredFile[] = [
        {
          url: 'http://test.local/llms.txt',
          content: llmsTxtContent,
          status: 200,
          redirected: false,
        },
      ];
      ctx.previousResults.set('llms-txt-exists', {
        id: 'llms-txt-exists',
        category: 'content-discoverability',
        status: 'pass',
        message: 'Found',
        details: { discoveredFiles: discovered },
      });
      mockSitemapNotFound(server, 'http://test.local');
    } else {
      ctx.previousResults.set('llms-txt-exists', {
        id: 'llms-txt-exists',
        category: 'content-discoverability',
        status: 'fail',
        message: 'No llms.txt found',
        details: { discoveredFiles: [] },
      });
    }

    return ctx;
  }

  it('passes when all pages are accessible', async () => {
    server.use(
      http.get(
        'http://test.local/docs/page1',
        () =>
          new HttpResponse('<html><body><h1>Docs</h1><p>Content here.</p></body></html>', {
            status: 200,
            headers: { 'Content-Type': 'text/html' },
          }),
      ),
    );

    const content = `# Docs\n## Links\n- [Page 1](http://test.local/docs/page1): First\n`;
    const result = await check.run(makeCtx(content));
    expect(result.status).toBe('pass');
    expect(result.details?.accessible).toBe(1);
  });

  it('fails when page returns 401', async () => {
    server.use(
      http.get(
        'http://test.local/docs/page1',
        () => new HttpResponse('Unauthorized', { status: 401 }),
      ),
    );

    const content = `# Docs\n## Links\n- [Page 1](http://test.local/docs/page1): First\n`;
    const result = await check.run(makeCtx(content));
    expect(result.status).toBe('fail');
    expect(result.details?.authRequired).toBe(1);
  });

  it('fails when page returns 403', async () => {
    server.use(
      http.get(
        'http://test.local/docs/page1',
        () => new HttpResponse('Forbidden', { status: 403 }),
      ),
    );

    const content = `# Docs\n## Links\n- [Page 1](http://test.local/docs/page1): First\n`;
    const result = await check.run(makeCtx(content));
    expect(result.status).toBe('fail');
    expect(result.details?.authRequired).toBe(1);
  });

  it('warns when some pages are gated and some accessible', async () => {
    server.use(
      http.get(
        'http://test.local/docs/page1',
        () =>
          new HttpResponse('<html><body><h1>Docs</h1></body></html>', {
            status: 200,
            headers: { 'Content-Type': 'text/html' },
          }),
      ),
      http.get(
        'http://test.local/docs/page2',
        () => new HttpResponse('Unauthorized', { status: 401 }),
      ),
    );

    const content = `# Docs\n## Links\n- [Page 1](http://test.local/docs/page1): First\n- [Page 2](http://test.local/docs/page2): Second\n`;
    const result = await check.run(makeCtx(content));
    expect(result.status).toBe('warn');
    expect(result.details?.accessible).toBe(1);
    expect(result.details?.authRequired).toBe(1);
  });

  it('detects SSO redirect to known domain', async () => {
    server.use(
      http.get(
        'http://test.local/docs/page1',
        () =>
          new HttpResponse(null, {
            status: 302,
            headers: {
              Location: 'https://login.microsoftonline.com/oauth2/authorize?client_id=abc',
            },
          }),
      ),
    );

    const content = `# Docs\n## Links\n- [Page 1](http://test.local/docs/page1): First\n`;
    const result = await check.run(makeCtx(content));
    expect(result.status).toBe('fail');
    expect(result.details?.authRedirect).toBe(1);
    expect(result.details?.ssoDomains).toContain('login.microsoftonline.com');
  });

  it('detects login form (password field)', async () => {
    server.use(
      http.get(
        'http://test.local/docs/page1',
        () =>
          new HttpResponse(
            '<html><body><form><input type="text" name="user"><input type="password" name="pass"><button>Log in</button></form></body></html>',
            { status: 200, headers: { 'Content-Type': 'text/html' } },
          ),
      ),
    );

    const content = `# Docs\n## Links\n- [Page 1](http://test.local/docs/page1): First\n`;
    const result = await check.run(makeCtx(content));
    expect(result.status).toBe('fail');
    expect(result.details?.softAuthGate).toBe(1);
  });

  it('detects login form via page title', async () => {
    server.use(
      http.get(
        'http://test.local/docs/page1',
        () =>
          new HttpResponse(
            '<html><head><title>Sign In - Company Portal</title></head><body><div>Please authenticate</div></body></html>',
            { status: 200, headers: { 'Content-Type': 'text/html' } },
          ),
      ),
    );

    const content = `# Docs\n## Links\n- [Page 1](http://test.local/docs/page1): First\n`;
    const result = await check.run(makeCtx(content));
    expect(result.status).toBe('fail');
    expect(result.details?.softAuthGate).toBe(1);
  });

  it('detects login form via title with separator pattern', async () => {
    server.use(
      http.get(
        'http://test.local/docs/page1',
        () =>
          new HttpResponse(
            '<html><head><title>Company Portal | Log In</title></head><body><div>Welcome</div></body></html>',
            { status: 200, headers: { 'Content-Type': 'text/html' } },
          ),
      ),
    );

    const content = `# Docs\n## Links\n- [Page 1](http://test.local/docs/page1): First\n`;
    const result = await check.run(makeCtx(content));
    expect(result.status).toBe('fail');
    expect(result.details?.softAuthGate).toBe(1);
  });

  it('does not flag pages that mention login as a topic', async () => {
    server.use(
      http.get(
        'http://test.local/docs/page1',
        () =>
          new HttpResponse(
            '<html><head><title>the user is unable to login</title></head><body><h1>Troubleshooting</h1><p>Steps to fix login issues.</p></body></html>',
            { status: 200, headers: { 'Content-Type': 'text/html' } },
          ),
      ),
    );

    const content = `# Docs\n## Links\n- [Page 1](http://test.local/docs/page1): First\n`;
    const result = await check.run(makeCtx(content));
    expect(result.status).toBe('pass');
    expect(result.details?.accessible).toBe(1);
  });

  it('does not flag API reference pages titled "Authenticate ..." (#107)', async () => {
    // Thin server-rendered shell like a Fern API reference page: nav chrome,
    // a couple of section headings, no form. Only the title mentions auth.
    server.use(
      http.get(
        'http://test.local/docs/page1',
        () =>
          new HttpResponse(
            '<html><head><title>Authenticate Bearer Token Get | NVIDIA NeMo Platform</title></head>' +
              '<body><nav><a href="/">Home</a><a href="/reference">API Reference</a></nav>' +
              '<main><h3>Response</h3><h3>Errors</h3></main></body></html>',
            { status: 200, headers: { 'Content-Type': 'text/html' } },
          ),
      ),
    );

    const content = `# Docs\n## Links\n- [Page 1](http://test.local/docs/page1): First\n`;
    const result = await check.run(makeCtx(content));
    expect(result.status).toBe('pass');
    expect(result.details?.accessible).toBe(1);
    expect(result.details?.softAuthGate).toBe(0);
  });

  it('does not flag docs pages about signing in when the body has real content', async () => {
    const paragraph =
      '<p>' + 'Explains how the sign-in flow works in enough detail. '.repeat(3) + '</p>';
    server.use(
      http.get(
        'http://test.local/docs/page1',
        () =>
          new HttpResponse(
            '<html><head><title>Sign in with SSO | Acme Docs</title></head><body><main>' +
              '<h1>Sign in with SSO</h1>' +
              paragraph +
              '<h2>Configure your identity provider</h2>' +
              paragraph +
              '<pre><code>acme login --sso https://idp.example.com</code></pre>' +
              '<h2>Troubleshooting</h2>' +
              paragraph +
              '</main></body></html>',
            { status: 200, headers: { 'Content-Type': 'text/html' } },
          ),
      ),
    );

    const content = `# Docs\n## Links\n- [Page 1](http://test.local/docs/page1): First\n`;
    const result = await check.run(makeCtx(content));
    expect(result.status).toBe('pass');
    expect(result.details?.accessible).toBe(1);
    expect(result.details?.softAuthGate).toBe(0);
  });

  it('still flags a login-titled page whose body is a bare SSO launcher', async () => {
    server.use(
      http.get(
        'http://test.local/docs/page1',
        () =>
          new HttpResponse(
            '<html><head><title>Log in | Acme</title></head><body>' +
              '<h1>Log in</h1><p>Use your company account to continue.</p>' +
              '<a href="https://idp.example.com/start">Continue with SSO</a></body></html>',
            { status: 200, headers: { 'Content-Type': 'text/html' } },
          ),
      ),
    );

    const content = `# Docs\n## Links\n- [Page 1](http://test.local/docs/page1): First\n`;
    const result = await check.run(makeCtx(content));
    expect(result.status).toBe('fail');
    expect(result.details?.softAuthGate).toBe(1);
  });

  it('treats non-SSO redirects as accessible', async () => {
    server.use(
      http.get(
        'http://test.local/docs/page1',
        () =>
          new HttpResponse(null, {
            status: 301,
            headers: { Location: 'http://test.local/docs/page1-new' },
          }),
      ),
    );

    const content = `# Docs\n## Links\n- [Page 1](http://test.local/docs/page1): First\n`;
    const result = await check.run(makeCtx(content));
    expect(result.status).toBe('pass');
    expect(result.details?.accessible).toBe(1);
  });

  it('resolves relative Location headers in SSO redirects', async () => {
    server.use(
      http.get(
        'http://test.local/docs/page1',
        () =>
          new HttpResponse(null, {
            status: 302,
            headers: { Location: '/login?redirect=/docs/page1' },
          }),
      ),
    );

    const content = `# Docs\n## Links\n- [Page 1](http://test.local/docs/page1): First\n`;
    const result = await check.run(makeCtx(content));
    // login.* prefix matches SSO_DOMAINS
    expect(result.status).toBe('pass');
    expect(result.details?.accessible).toBe(1);
  });

  it('treats other status codes (e.g. 500) as accessible', async () => {
    server.use(
      http.get(
        'http://test.local/docs/page1',
        () => new HttpResponse('Internal Server Error', { status: 500 }),
      ),
    );

    const content = `# Docs\n## Links\n- [Page 1](http://test.local/docs/page1): First\n`;
    const result = await check.run(makeCtx(content));
    expect(result.status).toBe('pass');
    expect(result.details?.accessible).toBe(1);
  });

  it('fails when all fetches error out', async () => {
    server.use(
      http.get('http://test.local/docs/page1', () => HttpResponse.error()),
      http.get('http://test.local/docs/page2', () => HttpResponse.error()),
    );

    const content = `# Docs\n## Links\n- [Page 1](http://test.local/docs/page1): First\n- [Page 2](http://test.local/docs/page2): Second\n`;
    const result = await check.run(makeCtx(content));
    // All results are errors with classification 'accessible', so tested.length > 0 but no gated
    expect(result.details?.fetchErrors).toBe(2);
  });

  it('detects SSO form action as soft auth gate', async () => {
    server.use(
      http.get(
        'http://test.local/docs/page1',
        () =>
          new HttpResponse(
            '<html><body><form action="https://idp.example.com/saml/login"><button>Login with SSO</button></form></body></html>',
            { status: 200, headers: { 'Content-Type': 'text/html' } },
          ),
      ),
    );

    const content = `# Docs\n## Links\n- [Page 1](http://test.local/docs/page1): First\n`;
    const result = await check.run(makeCtx(content));
    expect(result.status).toBe('fail');
    expect(result.details?.softAuthGate).toBe(1);
  });
});
