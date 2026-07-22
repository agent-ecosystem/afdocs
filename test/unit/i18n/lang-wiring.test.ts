import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { setLang } from '../../../src/i18n/index.js';
import { formatJson } from '../../../src/cli/formatters/json.js';

const server = setupServer();

beforeAll(() => {
  server.listen({ onUnhandledRequest: 'bypass' });
  return () => server.close();
});

afterEach(() => {
  setLang('en');
  server.resetHandlers();
});

describe('output lang zh', () => {
  it('emits Chinese check messages and resolutions in JSON when lang=zh', async () => {
    server.use(
      http.get('http://lang-zh.local/llms.txt', () => new HttpResponse(null, { status: 404 })),
      http.get('http://lang-zh.local/docs/llms.txt', () => new HttpResponse(null, { status: 404 })),
    );

    const { runChecks } = await import('../../../src/runner.js');
    await import('../../../src/checks/index.js');

    const report = await runChecks('http://lang-zh.local', {
      checkIds: ['llms-txt-exists'],
      requestDelay: 0,
      lang: 'zh',
    });

    const exists = report.results.find((r) => r.id === 'llms-txt-exists');
    expect(exists?.status).toBe('fail');
    expect(exists?.message).toMatch(/未找到|找不到|不存在/);

    const json = JSON.parse(formatJson(report, { score: true }));
    expect(json.scoring.resolutions['llms-txt-exists']).toMatch(/创建|添加|llms\.txt/);
    // Must not be the English resolution opener
    expect(json.scoring.resolutions['llms-txt-exists']).not.toMatch(/^Create an llms\.txt/);
  });

  it('keeps English by default', async () => {
    server.use(
      http.get('http://lang-en.local/llms.txt', () => new HttpResponse(null, { status: 404 })),
      http.get('http://lang-en.local/docs/llms.txt', () => new HttpResponse(null, { status: 404 })),
    );

    const { runChecks } = await import('../../../src/runner.js');
    await import('../../../src/checks/index.js');

    const report = await runChecks('http://lang-en.local', {
      checkIds: ['llms-txt-exists'],
      requestDelay: 0,
    });

    const exists = report.results.find((r) => r.id === 'llms-txt-exists');
    expect(exists?.message).toMatch(/No llms\.txt|not found|llms\.txt/i);
  });
});
