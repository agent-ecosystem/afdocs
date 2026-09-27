import { expect, vi } from 'vitest';
import type * as Vitest from 'vitest';
import {
  describeAgentDocs,
  describeAgentDocsPerCheck,
} from '../../../src/helpers/vitest-runner.js';
import { loadConfig } from '../../../src/helpers/config.js';
import { runChecks } from '../../../src/runner.js';
import type { AgentDocsConfig } from '../../../src/types.js';

const { describe, it, beforeEach } = await vi.importActual<typeof Vitest>('vitest');

const { runCallbacks } = vi.hoisted(() => ({
  runCallbacks: [] as Array<() => Promise<void>>,
}));

vi.mock('vitest', async (importOriginal) => {
  const actual = await importOriginal<typeof Vitest>();
  return {
    ...actual,
    describe: (_name: string, register: () => void) => register(),
    it: (name: string, run: () => Promise<void>) => {
      if (name === 'should run checks') runCallbacks.push(run);
    },
    beforeAll: (run: () => Promise<void>) => runCallbacks.push(run),
  };
});

vi.mock('../../../src/helpers/config.js', () => ({ loadConfig: vi.fn() }));
vi.mock('../../../src/runner.js', () => ({
  runChecks: vi.fn(async () => ({ results: [] })),
}));

beforeEach(() => {
  vi.clearAllMocks();
  runCallbacks.length = 0;
});

describe.each([
  { name: 'describeAgentDocs', helper: describeAgentDocs },
  { name: 'describeAgentDocsPerCheck', helper: describeAgentDocsPerCheck },
])('$name', ({ helper }) => {
  const config: AgentDocsConfig = {
    url: 'https://docs.example.com',
    checks: ['llms-txt-exists', 'content-negotiation'],
    skipChecks: ['content-negotiation'],
    pages: [
      'https://docs.example.com/quickstart',
      { url: 'https://docs.example.com/api/auth', tag: 'api-reference' },
    ],
    options: { maxLinksToTest: 5 },
  };

  it.each(['inline', 'directory', 'default'] as const)(
    'forwards checks, skipChecks, pages, and options from %s config',
    async (source) => {
      vi.mocked(loadConfig).mockResolvedValue(config);
      const input = source === 'inline' ? config : source === 'directory' ? '/docs' : undefined;

      helper(input);
      expect(runCallbacks).toHaveLength(1);
      await runCallbacks[0]();

      expect(runChecks).toHaveBeenCalledExactlyOnceWith(config.url, {
        checkIds: config.checks,
        skipCheckIds: config.skipChecks,
        curatedPages: config.pages,
        maxLinksToTest: 5,
        samplingStrategy: 'curated',
      });
      if (source === 'inline') {
        expect(loadConfig).not.toHaveBeenCalled();
      } else {
        expect(loadConfig).toHaveBeenCalledExactlyOnceWith(input);
      }
    },
  );

  it('leaves selection and sampling unset when not configured', async () => {
    helper({ url: config.url });
    await runCallbacks[0]();

    expect(runChecks).toHaveBeenCalledExactlyOnceWith(config.url, {
      checkIds: undefined,
      skipCheckIds: undefined,
      curatedPages: undefined,
    });
  });

  it('preserves an explicit sampling strategy with curated pages', async () => {
    helper({ ...config, options: { samplingStrategy: 'deterministic' } });
    await runCallbacks[0]();

    expect(runChecks).toHaveBeenCalledExactlyOnceWith(config.url, {
      checkIds: config.checks,
      skipCheckIds: config.skipChecks,
      curatedPages: config.pages,
      samplingStrategy: 'deterministic',
    });
  });
});
