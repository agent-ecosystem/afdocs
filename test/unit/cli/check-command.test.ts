import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import * as validationMod from '../../../src/validation.js';

const VALID_LLMS_TXT = `# Test

> Summary.

## Links

- [A](http://cmd-test.local/a): A
`;

const server = setupServer();

beforeAll(() => {
  server.listen({ onUnhandledRequest: 'bypass' });
  return () => server.close();
});

afterEach(() => {
  process.exitCode = undefined;
});

describe('check command', () => {
  it('runs via CLI entry point with text format', async () => {
    server.use(
      http.get('http://cmd-test.local/llms.txt', () => HttpResponse.text(VALID_LLMS_TXT)),
      http.get(
        'http://cmd-test.local/docs/llms.txt',
        () => new HttpResponse(null, { status: 404 }),
      ),
    );

    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    const { run } = await import('../../../src/cli/index.js');
    await run([
      'node',
      'afdocs',
      'check',
      'http://cmd-test.local',
      '--checks',
      'llms-txt-exists',
      '--request-delay',
      '0',
    ]);

    // Commander actions are async; give it a tick
    await new Promise((r) => setTimeout(r, 100));

    const output = writeSpy.mock.calls.map((c) => c[0]).join('');
    expect(output).toContain('llms-txt-exists');
    expect(output).toContain('pass');

    writeSpy.mockRestore();
  });

  it('runs with json format', async () => {
    server.use(
      http.get('http://cmd-json.local/llms.txt', () => HttpResponse.text(VALID_LLMS_TXT)),
      http.get(
        'http://cmd-json.local/docs/llms.txt',
        () => new HttpResponse(null, { status: 404 }),
      ),
    );

    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    const { run } = await import('../../../src/cli/index.js');
    await run([
      'node',
      'afdocs',
      'check',
      'http://cmd-json.local',
      '--checks',
      'llms-txt-exists',
      '--format',
      'json',
      '--request-delay',
      '0',
    ]);

    await new Promise((r) => setTimeout(r, 100));

    const output = writeSpy.mock.calls.map((c) => c[0]).join('');
    const parsed = JSON.parse(output.trim());
    expect(parsed.url).toBe('http://cmd-json.local');
    expect(parsed.results[0].id).toBe('llms-txt-exists');

    writeSpy.mockRestore();
  });

  it('sets exit code 1 on failure', async () => {
    server.use(
      http.get('http://cmd-fail.local/llms.txt', () => new HttpResponse(null, { status: 404 })),
      http.get(
        'http://cmd-fail.local/docs/llms.txt',
        () => new HttpResponse(null, { status: 404 }),
      ),
    );

    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    const { run } = await import('../../../src/cli/index.js');
    await run([
      'node',
      'afdocs',
      'check',
      'http://cmd-fail.local',
      '--checks',
      'llms-txt-exists',
      '--request-delay',
      '0',
    ]);

    await new Promise((r) => setTimeout(r, 100));

    expect(process.exitCode).toBe(1);

    writeSpy.mockRestore();
  });

  it('runs with scorecard format', async () => {
    server.use(
      http.get('http://cmd-scorecard.local/llms.txt', () => HttpResponse.text(VALID_LLMS_TXT)),
      http.get(
        'http://cmd-scorecard.local/docs/llms.txt',
        () => new HttpResponse(null, { status: 404 }),
      ),
    );

    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    const { run } = await import('../../../src/cli/index.js');
    await run([
      'node',
      'afdocs',
      'check',
      'http://cmd-scorecard.local',
      '--checks',
      'llms-txt-exists',
      '--format',
      'scorecard',
      '--request-delay',
      '0',
    ]);

    await new Promise((r) => setTimeout(r, 100));

    const output = writeSpy.mock.calls.map((c) => c[0]).join('');
    expect(output).toContain('Agent-Friendly Docs Scorecard');
    expect(output).toContain('Overall Score');
    expect(output).toContain('/ 100');

    writeSpy.mockRestore();
  });

  it('runs json format with --score flag', async () => {
    server.use(
      http.get('http://cmd-json-score.local/llms.txt', () => HttpResponse.text(VALID_LLMS_TXT)),
      http.get(
        'http://cmd-json-score.local/docs/llms.txt',
        () => new HttpResponse(null, { status: 404 }),
      ),
    );

    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    const { run } = await import('../../../src/cli/index.js');
    await run([
      'node',
      'afdocs',
      'check',
      'http://cmd-json-score.local',
      '--checks',
      'llms-txt-exists',
      '--format',
      'json',
      '--score',
      '--request-delay',
      '0',
    ]);

    await new Promise((r) => setTimeout(r, 100));

    const output = writeSpy.mock.calls.map((c) => c[0]).join('');
    const parsed = JSON.parse(output.trim());
    expect(parsed.scoring).toBeDefined();
    expect(parsed.scoring.overall).toBeTypeOf('number');
    expect(parsed.scoring.grade).toBeTypeOf('string');

    writeSpy.mockRestore();
  });

  it('rejects invalid format option', async () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const { run } = await import('../../../src/cli/index.js');
    await run([
      'node',
      'afdocs',
      'check',
      'http://cmd-invalid-fmt.local',
      '--format',
      'xml',
      '--request-delay',
      '0',
    ]);

    await new Promise((r) => setTimeout(r, 100));

    const output = stderrSpy.mock.calls.map((c) => c[0]).join('');
    expect(output).toContain('Invalid format');
    expect(output).toContain('xml');
    expect(process.exitCode).toBe(1);

    stderrSpy.mockRestore();
  });

  it('errors when no URL is provided and no config exists', async () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    // Point to a config with no url field so auto-discovery doesn't find a real one
    const tmpDir = resolve(import.meta.dirname, '../../fixtures/cli-no-url-test');
    await mkdir(tmpDir, { recursive: true });
    const configPath = resolve(tmpDir, 'no-url.yml');
    await writeFile(configPath, 'checks:\n  - llms-txt-exists\n');

    const { run } = await import('../../../src/cli/index.js');
    await run(['node', 'afdocs', 'check', '--config', configPath, '--request-delay', '0']);

    await new Promise((r) => setTimeout(r, 100));

    const output = stderrSpy.mock.calls.map((c) => c[0]).join('');
    expect(output).toContain('No URL provided');
    expect(process.exitCode).toBe(1);

    stderrSpy.mockRestore();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('accepts --locale and --version flags without error', async () => {
    server.use(
      http.get('http://cmd-opts.local/llms.txt', () => HttpResponse.text(VALID_LLMS_TXT)),
      http.get(
        'http://cmd-opts.local/docs/llms.txt',
        () => new HttpResponse(null, { status: 404 }),
      ),
    );

    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    const { run } = await import('../../../src/cli/index.js');
    await run([
      'node',
      'afdocs',
      'check',
      'http://cmd-opts.local',
      '--checks',
      'llms-txt-exists',
      '--request-delay',
      '0',
      '--doc-locale',
      'fr',
      '--doc-version',
      'v3',
      '--format',
      'json',
    ]);

    await new Promise((r) => setTimeout(r, 100));

    const output = writeSpy.mock.calls.map((c) => c[0]).join('');
    const parsed = JSON.parse(output.trim());
    expect(parsed.results[0].id).toBe('llms-txt-exists');
    expect(parsed.results[0].status).toBe('pass');

    writeSpy.mockRestore();
  });

  it('does not set exit code 1 when all pass', async () => {
    server.use(
      http.get('http://cmd-pass.local/llms.txt', () => HttpResponse.text(VALID_LLMS_TXT)),
      http.get(
        'http://cmd-pass.local/docs/llms.txt',
        () => new HttpResponse(null, { status: 404 }),
      ),
    );

    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    const { run } = await import('../../../src/cli/index.js');
    await run([
      'node',
      'afdocs',
      'check',
      'http://cmd-pass.local',
      '--checks',
      'llms-txt-exists',
      '--request-delay',
      '0',
    ]);

    await new Promise((r) => setTimeout(r, 100));

    expect(process.exitCode).toBeUndefined();

    writeSpy.mockRestore();
  });
});

const CONFIG_TMP = resolve(import.meta.dirname, '../../fixtures/cli-config-test');

describe('check command config integration', () => {
  beforeEach(async () => {
    await mkdir(CONFIG_TMP, { recursive: true });
  });

  afterEach(async () => {
    await rm(CONFIG_TMP, { recursive: true, force: true });
    process.exitCode = undefined;
  });

  it('uses URL from config when no CLI arg is passed', async () => {
    server.use(
      http.get('http://cfg-url.local/llms.txt', () => HttpResponse.text(VALID_LLMS_TXT)),
      http.get('http://cfg-url.local/docs/llms.txt', () => new HttpResponse(null, { status: 404 })),
    );

    const configPath = resolve(CONFIG_TMP, 'agent-docs.config.yml');
    await writeFile(configPath, 'url: http://cfg-url.local\nchecks:\n  - llms-txt-exists\n');

    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    const { run } = await import('../../../src/cli/index.js');
    await run(['node', 'afdocs', 'check', '--config', configPath, '--request-delay', '0']);
    await new Promise((r) => setTimeout(r, 100));

    const output = writeSpy.mock.calls.map((c) => c[0]).join('');
    expect(output).toContain('llms-txt-exists');
    expect(output).toContain('pass');

    writeSpy.mockRestore();
  });

  it('CLI URL arg overrides config URL', async () => {
    server.use(
      http.get('http://cfg-override.local/llms.txt', () => HttpResponse.text(VALID_LLMS_TXT)),
      http.get(
        'http://cfg-override.local/docs/llms.txt',
        () => new HttpResponse(null, { status: 404 }),
      ),
    );

    const configPath = resolve(CONFIG_TMP, 'agent-docs.config.yml');
    await writeFile(configPath, 'url: http://cfg-url.local\nchecks:\n  - llms-txt-exists\n');

    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    const { run } = await import('../../../src/cli/index.js');
    await run([
      'node',
      'afdocs',
      'check',
      'http://cfg-override.local',
      '--config',
      configPath,
      '--request-delay',
      '0',
    ]);
    await new Promise((r) => setTimeout(r, 100));

    const output = writeSpy.mock.calls.map((c) => c[0]).join('');
    expect(output).toContain('cfg-override.local');

    writeSpy.mockRestore();
  });

  it('uses checks from config when no --checks flag', async () => {
    server.use(
      http.get('http://cfg-checks.local/llms.txt', () => HttpResponse.text(VALID_LLMS_TXT)),
      http.get(
        'http://cfg-checks.local/docs/llms.txt',
        () => new HttpResponse(null, { status: 404 }),
      ),
    );

    const configPath = resolve(CONFIG_TMP, 'agent-docs.config.yml');
    await writeFile(configPath, 'url: http://cfg-checks.local\nchecks:\n  - llms-txt-exists\n');

    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    const { run } = await import('../../../src/cli/index.js');
    await run(['node', 'afdocs', 'check', '--config', configPath, '--request-delay', '0']);
    await new Promise((r) => setTimeout(r, 100));

    const output = writeSpy.mock.calls.map((c) => c[0]).join('');
    // Only llms-txt-exists ran — output should not contain checks outside the config list
    expect(output).toContain('llms-txt-exists');
    expect(output).not.toContain('rendering-strategy');

    writeSpy.mockRestore();
  });

  it('errors when --sampling curated is used without pages', async () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const { run } = await import('../../../src/cli/index.js');
    await run([
      'node',
      'afdocs',
      'check',
      'http://no-pages.local',
      '--sampling',
      'curated',
      '--request-delay',
      '0',
    ]);

    await new Promise((r) => setTimeout(r, 100));

    const output = stderrSpy.mock.calls.map((c) => c[0]).join('');
    expect(output).toContain('Curated sampling requires curatedPages to be non-empty');
    expect(process.exitCode).toBe(1);

    stderrSpy.mockRestore();
  });

  it('--checks flag overrides config checks', async () => {
    server.use(
      http.get('http://cfg-checks-override.local/llms.txt', () =>
        HttpResponse.text(VALID_LLMS_TXT),
      ),
      http.get(
        'http://cfg-checks-override.local/docs/llms.txt',
        () => new HttpResponse(null, { status: 404 }),
      ),
    );

    const configPath = resolve(CONFIG_TMP, 'agent-docs.config.yml');
    // Config lists llms-txt-exists; CLI overrides with llms-txt-valid
    await writeFile(
      configPath,
      'url: http://cfg-checks-override.local\nchecks:\n  - llms-txt-exists\n',
    );

    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    const { run } = await import('../../../src/cli/index.js');
    await run([
      'node',
      'afdocs',
      'check',
      '--config',
      configPath,
      '--checks',
      'llms-txt-valid',
      '--request-delay',
      '0',
    ]);
    await new Promise((r) => setTimeout(r, 100));

    const output = writeSpy.mock.calls.map((c) => c[0]).join('');
    expect(output).toContain('llms-txt-valid');
    expect(output).not.toContain('llms-txt-exists');

    writeSpy.mockRestore();
  });

  it('infers base URL from --urls when no URL argument given', async () => {
    server.use(
      http.get('http://infer-url.local/llms.txt', () => HttpResponse.text(VALID_LLMS_TXT)),
      http.get(
        'http://infer-url.local/docs/llms.txt',
        () => new HttpResponse(null, { status: 404 }),
      ),
    );

    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    const { run } = await import('../../../src/cli/index.js');
    await run([
      'node',
      'afdocs',
      'check',
      '--urls',
      'http://infer-url.local/a',
      '--checks',
      'llms-txt-exists',
      '--format',
      'json',
      '--request-delay',
      '0',
    ]);
    await new Promise((r) => setTimeout(r, 100));

    const output = writeSpy.mock.calls.map((c) => c[0]).join('');
    const parsed = JSON.parse(output.trim());
    expect(parsed.url).toBe('http://infer-url.local');

    writeSpy.mockRestore();
  });

  it('errors when --urls value is empty', async () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const { run } = await import('../../../src/cli/index.js');
    await run([
      'node',
      'afdocs',
      'check',
      'http://example.local',
      '--urls',
      ' , , ',
      '--request-delay',
      '0',
    ]);

    await new Promise((r) => setTimeout(r, 100));

    const output = stderrSpy.mock.calls.map((c) => c[0]).join('');
    expect(output).toContain('--urls requires at least one URL');
    expect(process.exitCode).toBe(1);

    stderrSpy.mockRestore();
  });

  it('rejects invalid sampling strategy', async () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const { run } = await import('../../../src/cli/index.js');
    await run([
      'node',
      'afdocs',
      'check',
      'http://example.local',
      '--sampling',
      'invalid-strategy',
      '--request-delay',
      '0',
    ]);

    await new Promise((r) => setTimeout(r, 100));

    const output = stderrSpy.mock.calls.map((c) => c[0]).join('');
    expect(output).toContain('Invalid sampling strategy');
    expect(output).toContain('invalid-strategy');
    expect(process.exitCode).toBe(1);

    stderrSpy.mockRestore();
  });

  it('rejects invalid URLs in --urls', async () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const { run } = await import('../../../src/cli/index.js');
    await run([
      'node',
      'afdocs',
      'check',
      'http://example.local',
      '--urls',
      'not-a-url',
      '--request-delay',
      '0',
    ]);
    await new Promise((r) => setTimeout(r, 100));

    const output = stderrSpy.mock.calls.map((c) => c[0]).join('');
    expect(output).toContain('not a valid URL');
    expect(process.exitCode).toBe(1);

    stderrSpy.mockRestore();
  });

  it('accepts --llms-txt-url and uses it as canonical', async () => {
    const customLlmsTxt = `# Custom\n\n> Custom docs.\n\n## Links\n\n- [Page](http://cmd-llms-url.local/x): X\n`;
    server.use(
      // The discovery heuristic would normally fall back to /llms.txt, but the
      // explicit URL should be the only thing probed.
      http.get('http://cmd-llms-url.local/custom/llms.txt', () => HttpResponse.text(customLlmsTxt)),
    );

    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    const { run } = await import('../../../src/cli/index.js');
    await run([
      'node',
      'afdocs',
      'check',
      'http://cmd-llms-url.local',
      '--checks',
      'llms-txt-exists',
      '--format',
      'json',
      '--llms-txt-url',
      'http://cmd-llms-url.local/custom/llms.txt',
      '--request-delay',
      '0',
    ]);
    await new Promise((r) => setTimeout(r, 100));

    const output = writeSpy.mock.calls.map((c) => c[0]).join('');
    const parsed = JSON.parse(output.trim());
    expect(parsed.results[0].status).toBe('pass');
    expect(parsed.results[0].details.canonicalUrl).toBe(
      'http://cmd-llms-url.local/custom/llms.txt',
    );
    expect(parsed.results[0].details.canonicalSource).toBe('explicit');

    writeSpy.mockRestore();
  });

  it('rejects invalid --llms-txt-url', async () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const { run } = await import('../../../src/cli/index.js');
    await run([
      'node',
      'afdocs',
      'check',
      'http://cmd-llms-url-bad.local',
      '--llms-txt-url',
      ':::not-a-url:::',
      '--request-delay',
      '0',
    ]);
    await new Promise((r) => setTimeout(r, 100));

    const output = stderrSpy.mock.calls.map((c) => c[0]).join('');
    expect(output).toContain('llmsTxtUrl is not a valid URL');
    expect(process.exitCode).toBe(1);

    stderrSpy.mockRestore();
  });

  it('warns when --llms-txt-url origin differs from target origin', async () => {
    const customLlmsTxt = `# Other\n\n> Other.\n\n## Links\n\n- [P](http://other.local/x): X\n`;
    server.use(
      http.get('http://other.local/custom/llms.txt', () => HttpResponse.text(customLlmsTxt)),
    );

    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const { run } = await import('../../../src/cli/index.js');
    await run([
      'node',
      'afdocs',
      'check',
      'http://cmd-llms-url-cross.local',
      '--checks',
      'llms-txt-exists',
      '--format',
      'json',
      '--llms-txt-url',
      'http://other.local/custom/llms.txt',
      '--request-delay',
      '0',
    ]);
    await new Promise((r) => setTimeout(r, 100));

    const stderr = stderrSpy.mock.calls.map((c) => c[0]).join('');
    expect(stderr).toContain('--llms-txt-url origin');
    expect(stderr).toContain('differs from target origin');

    // Check still runs and uses the explicit URL
    const stdout = stdoutSpy.mock.calls.map((c) => c[0]).join('');
    const parsed = JSON.parse(stdout.trim());
    expect(parsed.results[0].details.canonicalUrl).toBe('http://other.local/custom/llms.txt');

    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
  });

  it('errors when config file is invalid YAML', async () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const configPath = resolve(CONFIG_TMP, 'bad-config.yml');
    await writeFile(configPath, ':\ninvalid: [yaml\n');

    const { run } = await import('../../../src/cli/index.js');
    await run(['node', 'afdocs', 'check', '--config', configPath, '--request-delay', '0']);
    await new Promise((r) => setTimeout(r, 100));

    const output = stderrSpy.mock.calls.map((c) => c[0]).join('');
    expect(output).toContain('Error:');
    expect(process.exitCode).toBe(1);

    stderrSpy.mockRestore();
  });

  it('parses --skip-checks flag', async () => {
    server.use(
      http.get('http://cmd-skip.local/llms.txt', () => HttpResponse.text(VALID_LLMS_TXT)),
      http.get(
        'http://cmd-skip.local/docs/llms.txt',
        () => new HttpResponse(null, { status: 404 }),
      ),
    );

    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    const { run } = await import('../../../src/cli/index.js');
    await run([
      'node',
      'afdocs',
      'check',
      'http://cmd-skip.local',
      '--checks',
      'llms-txt-exists,llms-txt-valid',
      '--skip-checks',
      'llms-txt-valid',
      '--format',
      'json',
      '--request-delay',
      '0',
    ]);
    await new Promise((r) => setTimeout(r, 100));

    const output = writeSpy.mock.calls.map((c) => c[0]).join('');
    const parsed = JSON.parse(output.trim());
    const skipped = parsed.results.find((r: { id: string }) => r.id === 'llms-txt-valid');
    expect(skipped.status).toBe('skip');

    writeSpy.mockRestore();
  });

  it('warns when --canonical-origin matches target origin', async () => {
    server.use(
      http.get('http://cmd-canon-same.local/llms.txt', () => HttpResponse.text(VALID_LLMS_TXT)),
      http.get(
        'http://cmd-canon-same.local/docs/llms.txt',
        () => new HttpResponse(null, { status: 404 }),
      ),
    );

    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const { run } = await import('../../../src/cli/index.js');
    await run([
      'node',
      'afdocs',
      'check',
      'http://cmd-canon-same.local',
      '--canonical-origin',
      'http://cmd-canon-same.local',
      '--checks',
      'llms-txt-exists',
      '--request-delay',
      '0',
    ]);
    await new Promise((r) => setTimeout(r, 100));

    const stderr = stderrSpy.mock.calls.map((c) => c[0]).join('');
    expect(stderr).toContain('same as the target');
    expect(stderr).toContain('no effect');

    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
  });

  it('warns when origin-only --canonical-origin matches target whose URL has a path', async () => {
    server.use(
      http.get('http://cmd-canon-path.local/docs/llms.txt', () =>
        HttpResponse.text(VALID_LLMS_TXT),
      ),
      http.get('http://cmd-canon-path.local/llms.txt', () => HttpResponse.text(VALID_LLMS_TXT)),
    );

    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const { run } = await import('../../../src/cli/index.js');
    await run([
      'node',
      'afdocs',
      'check',
      'http://cmd-canon-path.local/docs',
      '--canonical-origin',
      'http://cmd-canon-path.local',
      '--checks',
      'llms-txt-exists',
      '--request-delay',
      '0',
    ]);
    await new Promise((r) => setTimeout(r, 100));

    const stderr = stderrSpy.mock.calls.map((c) => c[0]).join('');
    // Origin-only canonical == target origin → no effect, even though target has a path.
    expect(stderr).toContain('no effect');

    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
  });

  it('does not suppress --canonical-origin when same origin but different sub-path', async () => {
    server.use(
      http.get('http://cmd-canon-subpath.local/preview/llms.txt', () =>
        HttpResponse.text(VALID_LLMS_TXT),
      ),
      http.get(
        'http://cmd-canon-subpath.local/llms.txt',
        () => new HttpResponse(null, { status: 404 }),
      ),
      http.get(
        'http://cmd-canon-subpath.local/docs/llms.txt',
        () => new HttpResponse(null, { status: 404 }),
      ),
    );

    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const { run } = await import('../../../src/cli/index.js');
    await run([
      'node',
      'afdocs',
      'check',
      'http://cmd-canon-subpath.local/preview',
      '--canonical-origin',
      'http://cmd-canon-subpath.local/aws/en',
      '--checks',
      'llms-txt-exists',
      '--request-delay',
      '0',
    ]);
    await new Promise((r) => setTimeout(r, 100));

    const stdout = stdoutSpy.mock.calls.map((c) => c[0]).join('');
    const stderr = stderrSpy.mock.calls.map((c) => c[0]).join('');
    expect(stderr).not.toContain('no effect');
    expect(stdout).toContain('llms-txt-exists');

    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
  });

  it('warns without suppressing when --canonical-origin is a path-prefix of the target base', async () => {
    server.use(
      http.get('http://cmd-canon-overlap.local/docs/preview/llms.txt', () =>
        HttpResponse.text(VALID_LLMS_TXT),
      ),
      http.get(
        'http://cmd-canon-overlap.local/llms.txt',
        () => new HttpResponse(null, { status: 404 }),
      ),
      http.get(
        'http://cmd-canon-overlap.local/docs/llms.txt',
        () => new HttpResponse(null, { status: 404 }),
      ),
    );

    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const { run } = await import('../../../src/cli/index.js');
    await run([
      'node',
      'afdocs',
      'check',
      'http://cmd-canon-overlap.local/docs/preview',
      '--canonical-origin',
      'http://cmd-canon-overlap.local/docs',
      '--checks',
      'llms-txt-exists',
      '--request-delay',
      '0',
    ]);
    await new Promise((r) => setTimeout(r, 100));

    const stdout = stdoutSpy.mock.calls.map((c) => c[0]).join('');
    const stderr = stderrSpy.mock.calls.map((c) => c[0]).join('');
    // Self-referencing URLs in content will double-rewrite; warn but stay active.
    expect(stderr).toContain('path-prefix of the target base');
    expect(stderr).not.toContain('no effect');
    expect(stdout).toContain('llms-txt-exists');

    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
  });

  it('warns when a path-prefix --canonical-origin equals the target base', async () => {
    server.use(
      http.get('http://cmd-canon-eq.local/docs/llms.txt', () => HttpResponse.text(VALID_LLMS_TXT)),
      http.get('http://cmd-canon-eq.local/llms.txt', () => HttpResponse.text(VALID_LLMS_TXT)),
    );

    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const { run } = await import('../../../src/cli/index.js');
    await run([
      'node',
      'afdocs',
      'check',
      'http://cmd-canon-eq.local/docs',
      '--canonical-origin',
      'http://cmd-canon-eq.local/docs',
      '--checks',
      'llms-txt-exists',
      '--request-delay',
      '0',
    ]);
    await new Promise((r) => setTimeout(r, 100));

    const stderr = stderrSpy.mock.calls.map((c) => c[0]).join('');
    // Path-prefix canonical resolves to the same base as the target → no-op rewrite.
    expect(stderr).toContain('no effect');

    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
  });

  it('falls through invalid --canonical-origin to validation', async () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const { run } = await import('../../../src/cli/index.js');
    await run([
      'node',
      'afdocs',
      'check',
      'http://cmd-canon-bad.local',
      '--canonical-origin',
      ':::not-a-url:::',
      '--checks',
      'llms-txt-exists',
      '--request-delay',
      '0',
    ]);
    await new Promise((r) => setTimeout(r, 100));

    const output = stderrSpy.mock.calls.map((c) => c[0]).join('');
    expect(output).toContain('canonicalOrigin');
    expect(output).toContain('not a valid URL');
    expect(process.exitCode).toBe(1);

    stderrSpy.mockRestore();
  });

  it('passes --coverage-exclusions to runner', async () => {
    server.use(
      http.get('http://cmd-cov-excl.local/llms.txt', () => HttpResponse.text(VALID_LLMS_TXT)),
      http.get(
        'http://cmd-cov-excl.local/docs/llms.txt',
        () => new HttpResponse(null, { status: 404 }),
      ),
    );

    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    const { run } = await import('../../../src/cli/index.js');
    await run([
      'node',
      'afdocs',
      'check',
      'http://cmd-cov-excl.local',
      '--checks',
      'llms-txt-exists',
      '--coverage-exclusions',
      '/docs/ref/**,/docs/changelog/**',
      '--format',
      'json',
      '--request-delay',
      '0',
    ]);
    await new Promise((r) => setTimeout(r, 100));

    const output = writeSpy.mock.calls.map((c) => c[0]).join('');
    const parsed = JSON.parse(output.trim());
    expect(parsed.results[0].status).toBe('pass');

    writeSpy.mockRestore();
  });

  it('passes --parity-exclusions to runner', async () => {
    server.use(
      http.get('http://cmd-par-excl.local/llms.txt', () => HttpResponse.text(VALID_LLMS_TXT)),
      http.get(
        'http://cmd-par-excl.local/docs/llms.txt',
        () => new HttpResponse(null, { status: 404 }),
      ),
    );

    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    const { run } = await import('../../../src/cli/index.js');
    await run([
      'node',
      'afdocs',
      'check',
      'http://cmd-par-excl.local',
      '--checks',
      'llms-txt-exists',
      '--parity-exclusions',
      '.nav-content,[data-human-only]',
      '--format',
      'json',
      '--request-delay',
      '0',
    ]);
    await new Promise((r) => setTimeout(r, 100));

    const output = writeSpy.mock.calls.map((c) => c[0]).join('');
    const parsed = JSON.parse(output.trim());
    expect(parsed.results[0].status).toBe('pass');

    writeSpy.mockRestore();
  });

  it('displays validation warnings on stderr', async () => {
    server.use(
      http.get('http://cmd-warn.local/llms.txt', () => HttpResponse.text(VALID_LLMS_TXT)),
      http.get(
        'http://cmd-warn.local/docs/llms.txt',
        () => new HttpResponse(null, { status: 404 }),
      ),
    );

    const spy = vi.spyOn(validationMod, 'validateRunnerOptions').mockReturnValueOnce({
      valid: true,
      errors: [],
      warnings: [{ field: 'testField', message: 'This is a test warning' }],
    });

    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const { run } = await import('../../../src/cli/index.js');
    await run([
      'node',
      'afdocs',
      'check',
      'http://cmd-warn.local',
      '--checks',
      'llms-txt-exists',
      '--request-delay',
      '0',
    ]);
    await new Promise((r) => setTimeout(r, 100));

    const stderr = stderrSpy.mock.calls.map((c) => c[0]).join('');
    expect(stderr).toContain('Warning: This is a test warning');

    spy.mockRestore();
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
  });

  it('infers base URL from config pages when url field is omitted', async () => {
    server.use(
      http.get('http://cfg-infer.local/llms.txt', () => HttpResponse.text(VALID_LLMS_TXT)),
      http.get(
        'http://cfg-infer.local/docs/llms.txt',
        () => new HttpResponse(null, { status: 404 }),
      ),
    );

    const configPath = resolve(CONFIG_TMP, 'agent-docs.config.yml');
    await writeFile(
      configPath,
      'pages:\n  - http://cfg-infer.local/a\nchecks:\n  - llms-txt-exists\n',
    );

    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    const { run } = await import('../../../src/cli/index.js');
    await run([
      'node',
      'afdocs',
      'check',
      '--config',
      configPath,
      '--format',
      'json',
      '--request-delay',
      '0',
    ]);
    await new Promise((r) => setTimeout(r, 100));

    const output = writeSpy.mock.calls.map((c) => c[0]).join('');
    const parsed = JSON.parse(output.trim());
    expect(parsed.url).toBe('http://cfg-infer.local');

    writeSpy.mockRestore();
  });
});
