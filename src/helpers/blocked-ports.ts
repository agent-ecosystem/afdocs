// Ports on the WHATWG fetch spec's bad port list.
// https://fetch.spec.whatwg.org/#port-blocking
//
// Node's built-in fetch (undici) refuses to connect to these ports before any
// network request is made, so every check against a target on one of them
// fails with a bare "fetch failed". undici implements the list but doesn't
// export it; it's small and stable (changes only via fetch spec updates), so
// we vendor it to diagnose the problem up front.
const BLOCKED_PORTS = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102,
  103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465,
  512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993,
  995, 1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668,
  6669, 6679, 6697, 10080,
]);

/**
 * Returns true if the port is on the WHATWG fetch blocked-port list.
 */
export function isBlockedPort(port: number): boolean {
  return BLOCKED_PORTS.has(port);
}

/**
 * If the URL targets a blocked port, return that port number; otherwise null.
 * Only http/https URLs with an explicit non-default port can be blocked.
 */
export function getBlockedPort(url: string): number | null {
  try {
    const parsed = new URL(url);
    if (!parsed.port) return null;
    const port = parseInt(parsed.port, 10);
    return isBlockedPort(port) ? port : null;
  } catch {
    return null;
  }
}

/**
 * Build the actionable error message for a blocked-port target.
 */
export function blockedPortMessage(port: number): string {
  return (
    `Port ${port} is on the WHATWG fetch blocked-port list ` +
    `(https://fetch.spec.whatwg.org/#port-blocking); Node's fetch refuses to ` +
    `connect to it, so every check would fail with "fetch failed". Restart ` +
    `your dev server on a different port (1313, 3000, and 5173 are all safe) ` +
    `and re-run.`
  );
}
