/**
 * Human-readable decimal size: 512 → "512B", 29_400 → "29KB", 3_400_000 → "3.4MB".
 * Decimal units match how the spec states the page-size-transfer thresholds
 * (1MB warn, 10MB fail) and its report examples ("3.4MB served -> 29KB content").
 */
export function formatBytes(n: number): string {
  // 999,600 rounds to 1000KB in kilobytes; show it as 1MB instead.
  if (n >= 999_500) {
    const mb = n / 1_000_000;
    return `${mb >= 10 ? Math.round(mb) : Math.round(mb * 10) / 10}MB`;
  }
  if (n >= 1_000) return `${Math.round(n / 1_000)}KB`;
  return `${n}B`;
}

/** The page-size-transfer report line: "3.4MB served → 29KB content (~120:1)". */
export function describeTransfer(
  servedBytes: number,
  contentCharacters: number,
  ratio?: number,
): string {
  const base = `${formatBytes(servedBytes)} served → ${formatBytes(contentCharacters)} content`;
  return ratio === undefined ? base : `${base} (~${ratio}:1)`;
}
