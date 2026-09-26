import { describe, it, expect } from 'vitest';
import { CHECK_WEIGHTS, getCheckWeight } from '../../../src/scoring/weights.js';

describe('weights', () => {
  it('has weights for all 24 checks', () => {
    expect(Object.keys(CHECK_WEIGHTS)).toHaveLength(24);
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
  });

  it('has 3 critical, 9 high, 10 medium, 2 low checks', () => {
    const tiers = Object.values(CHECK_WEIGHTS).map((w) => w.tier);
    expect(tiers.filter((t) => t === 'critical')).toHaveLength(3);
    expect(tiers.filter((t) => t === 'high')).toHaveLength(9);
    expect(tiers.filter((t) => t === 'medium')).toHaveLength(10);
    expect(tiers.filter((t) => t === 'low')).toHaveLength(2);
  });

  it('sums to 137 max raw score', () => {
    const total = Object.values(CHECK_WEIGHTS).reduce((sum, w) => sum + w.weight, 0);
    expect(total).toBe(137);
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
