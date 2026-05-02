import { describe, it, expect } from 'vitest';
import { canonicalHost, isSameSite } from '../../../src/helpers/host-equivalence.js';

describe('canonicalHost', () => {
  it('strips a leading www.', () => {
    expect(canonicalHost('www.swift.org')).toBe('swift.org');
  });

  it('leaves bare hosts unchanged', () => {
    expect(canonicalHost('swift.org')).toBe('swift.org');
  });

  it('only strips a leading www., not interior', () => {
    expect(canonicalHost('docs.www.example.com')).toBe('docs.www.example.com');
  });
});

describe('isSameSite', () => {
  it('returns true for identical URLs', () => {
    expect(isSameSite('https://example.com/', 'https://example.com/')).toBe(true);
  });

  it('returns true for www vs bare-host (issue #83)', () => {
    expect(isSameSite('https://swift.org/x', 'https://www.swift.org/y')).toBe(true);
    expect(isSameSite('https://www.swift.org/x', 'https://swift.org/y')).toBe(true);
  });

  it('ignores scheme — http→https on the same host is same site', () => {
    expect(isSameSite('http://example.com/x', 'https://example.com/x')).toBe(true);
  });

  it('ignores path, query, and fragment', () => {
    expect(isSameSite('https://example.com/a?q=1#x', 'https://example.com/b')).toBe(true);
  });

  it('returns false for different ports', () => {
    expect(isSameSite('https://example.com:8443/', 'https://example.com/')).toBe(false);
  });

  it('returns false for unrelated hosts', () => {
    expect(isSameSite('https://example.com/', 'https://other.com/')).toBe(false);
  });

  it('returns false for non-www subdomains (e.g. docs)', () => {
    expect(isSameSite('https://docs.example.com/', 'https://example.com/')).toBe(false);
  });

  it('returns false for malformed URLs', () => {
    expect(isSameSite('not-a-url', 'https://example.com/')).toBe(false);
  });
});
