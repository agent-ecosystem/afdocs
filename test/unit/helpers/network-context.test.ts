import { describe, it, expect } from 'vitest';
import {
  detectNetworkContext,
  describeNetworkContext,
} from '../../../src/helpers/network-context.js';

describe('detectNetworkContext', () => {
  it('defaults to a developer machine with no indicators', () => {
    expect(detectNetworkContext({})).toEqual({
      classification: 'developer-machine',
      source: 'environment',
    });
  });

  it('classifies CI runners and names the indicator', () => {
    expect(detectNetworkContext({ GITHUB_ACTIONS: 'true' })).toEqual({
      classification: 'ci',
      source: 'environment',
      indicator: 'GITHUB_ACTIONS',
    });
    expect(detectNetworkContext({ CI: 'true' }).classification).toBe('ci');
  });

  it('treats falsey values as unset', () => {
    expect(detectNetworkContext({ CI: 'false' }).classification).toBe('developer-machine');
    expect(detectNetworkContext({ CI: '0' }).classification).toBe('developer-machine');
    expect(detectNetworkContext({ CI: '' }).classification).toBe('developer-machine');
  });

  it('classifies cloud execution environments', () => {
    expect(detectNetworkContext({ AWS_LAMBDA_FUNCTION_NAME: 'fn' })).toEqual({
      classification: 'cloud',
      source: 'environment',
      indicator: 'AWS_LAMBDA_FUNCTION_NAME',
    });
    expect(detectNetworkContext({ CODESPACES: 'true' }).classification).toBe('cloud');
  });

  it('prefers the CI label when both CI and cloud indicators are set', () => {
    expect(
      detectNetworkContext({ GITLAB_CI: 'true', KUBERNETES_SERVICE_HOST: '10.0.0.1' })
        .classification,
    ).toBe('ci');
  });

  it('never includes an IP address', () => {
    const ctx = detectNetworkContext({ CI: 'true' });
    expect(JSON.stringify(ctx)).not.toMatch(/\d+\.\d+\.\d+\.\d+/);
  });
});

describe('describeNetworkContext', () => {
  it('renders each classification', () => {
    expect(describeNetworkContext({ classification: 'ci', source: 'option' })).toBe(
      'CI infrastructure',
    );
    expect(describeNetworkContext({ classification: 'cloud', source: 'environment' })).toBe(
      'cloud infrastructure',
    );
    expect(
      describeNetworkContext({ classification: 'developer-machine', source: 'environment' }),
    ).toBe('a developer machine');
  });
});
