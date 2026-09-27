import { describe, it, expect } from 'vitest';
import { CHECK_WEIGHTS, getCheckWeight } from '../../../src/scoring/weights.js';

describe('weights', () => {
  it('has weights for all 28 checks', () => {
    expect(Object.keys(CHECK_WEIGHTS)).toHaveLength(28);
  });

  it('returns undefined for unknown check IDs', () => {
    expect(getCheckWeight('nonexistent')).toBeUndefined();
  });

  it('assigns correct tiers', () => {
    expect(getCheckWeight('llms-txt-exists')!.tier).toBe('critical');
    expect(getCheckWeight('llms-txt-exists')!.weight).toBe(10);

    expect(getCheckWeight('page-size-html')!.tier).toBe('high');
    expect(getCheckWeight('page-size-html')!.weight).toBe(7);

    expect(getCheckWeight('content-negotiation')!.tier).toBe('medium');
    expect(getCheckWeight('content-negotiation')!.weight).toBe(4);

    expect(getCheckWeight('cache-header-hygiene')!.tier).toBe('low');
    expect(getCheckWeight('cache-header-hygiene')!.weight).toBe(2);

    // Spec v0.6.0 checks table: Page Size, Medium, warn at the 0.50 degradation tier
    expect(getCheckWeight('page-size-transfer')!.tier).toBe('medium');
    expect(getCheckWeight('page-size-transfer')!.weight).toBe(4);
    expect(getCheckWeight('page-size-transfer')!.warnCoefficient).toBe(0.5);
  });

  it('gives single-fetch-completeness the medium weight and the platform-dependent warn tier', () => {
    // Spec v0.6.0 checks table: Page Size, Medium. A fragile continuation is
    // lost or kept depending on the agent's pipeline, like a buried directive.
    expect(getCheckWeight('single-fetch-completeness')!.tier).toBe('medium');
    expect(getCheckWeight('single-fetch-completeness')!.weight).toBe(4);
    expect(getCheckWeight('single-fetch-completeness')!.warnCoefficient).toBe(0.6);
  });

  it('gives embedded-data-serialization the medium weight and the degradation warn tier', () => {
    // Spec v0.6.0 checks table: Content Structure, Medium. A warn is a page
    // in the size warn band because of its data, the same degradation as
    // tabbed-content-serialization's.
    expect(getCheckWeight('embedded-data-serialization')!.tier).toBe('medium');
    expect(getCheckWeight('embedded-data-serialization')!.weight).toBe(4);
    expect(getCheckWeight('embedded-data-serialization')!.warnCoefficient).toBe(0.5);
  });

  it('gives markdown-link-portability the medium weight and the platform-dependent warn tier', () => {
    // Spec v0.6.0 checks table: Content Structure, Medium. A root-relative
    // link survives or breaks depending on whether the agent's pipeline still
    // holds the fetch URL, which is the same platform-dependent shape as a
    // buried directive or a fragile continuation.
    expect(getCheckWeight('markdown-link-portability')!.tier).toBe('medium');
    expect(getCheckWeight('markdown-link-portability')!.weight).toBe(4);
    expect(getCheckWeight('markdown-link-portability')!.warnCoefficient).toBe(0.6);
  });

  it('has 3 critical, 9 high, 14 medium, 2 low checks', () => {
    const tiers = Object.values(CHECK_WEIGHTS).map((w) => w.tier);
    expect(tiers.filter((t) => t === 'critical')).toHaveLength(3);
    expect(tiers.filter((t) => t === 'high')).toHaveLength(9);
    expect(tiers.filter((t) => t === 'medium')).toHaveLength(14);
    expect(tiers.filter((t) => t === 'low')).toHaveLength(2);
  });

  it('sums to 153 max raw score', () => {
    const total = Object.values(CHECK_WEIGHTS).reduce((sum, w) => sum + w.weight, 0);
    expect(total).toBe(153);
  });

  it('assigns warn coefficients correctly', () => {
    // 0.75 tier
    expect(getCheckWeight('llms-txt-valid')!.warnCoefficient).toBe(0.75);
    // 0.60 tier
    expect(getCheckWeight('llms-txt-directive-html')!.warnCoefficient).toBe(0.6);
    // 0.50 tier
    expect(getCheckWeight('llms-txt-exists')!.warnCoefficient).toBe(0.5);
    // 0.25 tier
    expect(getCheckWeight('llms-txt-links-markdown')!.warnCoefficient).toBe(0.25);
    // No warn state
    expect(getCheckWeight('http-status-codes')!.warnCoefficient).toBeUndefined();
    expect(getCheckWeight('markdown-code-fence-validity')!.warnCoefficient).toBeUndefined();
  });
});
