import { describe, it, expect } from 'vitest';
import { describeTransfer, formatBytes } from '../../../src/helpers/format-bytes.js';

describe('formatBytes', () => {
  it('uses decimal units matching the spec thresholds', () => {
    expect(formatBytes(0)).toBe('0B');
    expect(formatBytes(512)).toBe('512B');
    expect(formatBytes(29_400)).toBe('29KB');
    expect(formatBytes(999_499)).toBe('999KB');
    expect(formatBytes(999_600)).toBe('1MB');
    expect(formatBytes(1_000_000)).toBe('1MB');
    expect(formatBytes(3_400_000)).toBe('3.4MB');
    expect(formatBytes(10_000_000)).toBe('10MB');
    expect(formatBytes(12_600_000)).toBe('13MB');
  });
});

describe('describeTransfer', () => {
  it('renders the spec example shape', () => {
    expect(describeTransfer(3_400_000, 29_000, 120)).toBe('3.4MB served → 29KB content (~120:1)');
  });

  it('omits the ratio when there is none', () => {
    expect(describeTransfer(4_000, 0)).toBe('4KB served → 0B content');
  });
});
