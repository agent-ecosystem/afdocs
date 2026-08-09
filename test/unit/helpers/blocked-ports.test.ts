import { describe, it, expect } from 'vitest';
import {
  isBlockedPort,
  getBlockedPort,
  blockedPortMessage,
} from '../../../src/helpers/blocked-ports.js';

describe('isBlockedPort', () => {
  it('returns true for ports on the WHATWG bad port list', () => {
    expect(isBlockedPort(1719)).toBe(true); // H.323 gatestat
    expect(isBlockedPort(1720)).toBe(true); // H.323 hostcall
    expect(isBlockedPort(6000)).toBe(true); // X11
    expect(isBlockedPort(6667)).toBe(true); // IRC
    expect(isBlockedPort(22)).toBe(true); // SSH
    expect(isBlockedPort(10080)).toBe(true); // amanda
  });

  it('returns false for common dev server ports', () => {
    expect(isBlockedPort(1313)).toBe(false); // Hugo
    expect(isBlockedPort(3000)).toBe(false);
    expect(isBlockedPort(4321)).toBe(false); // Astro
    expect(isBlockedPort(5173)).toBe(false); // Vite
    expect(isBlockedPort(8080)).toBe(false);
  });
});

describe('getBlockedPort', () => {
  it('returns the port when the URL targets a blocked port', () => {
    expect(getBlockedPort('http://localhost:1719')).toBe(1719);
    expect(getBlockedPort('http://127.0.0.1:6000/docs')).toBe(6000);
  });

  it('returns null for URLs on safe ports', () => {
    expect(getBlockedPort('http://localhost:1313')).toBeNull();
    expect(getBlockedPort('http://localhost:3000/docs')).toBeNull();
  });

  it('returns null when no explicit port is present', () => {
    expect(getBlockedPort('https://example.com/docs')).toBeNull();
    expect(getBlockedPort('http://localhost')).toBeNull();
  });

  it('returns null for malformed URLs', () => {
    expect(getBlockedPort('not a url')).toBeNull();
  });
});

describe('blockedPortMessage', () => {
  it('names the port and suggests safe alternatives', () => {
    const msg = blockedPortMessage(1719);
    expect(msg).toContain('1719');
    expect(msg).toContain('blocked-port list');
    expect(msg).toContain('different port');
  });
});
