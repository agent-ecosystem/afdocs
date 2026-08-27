import type { CheckProgressEvent } from '../../types.js';

function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

/**
 * Render a runner progress event as a stderr line fragment. A check's 'start'
 * event opens the line (no newline) so a stalled check leaves its name visible;
 * the 'complete' event finishes it.
 */
export function formatProgressEvent(event: CheckProgressEvent): string {
  if (event.phase === 'start') {
    return `[${event.index}/${event.total}] ${event.checkId}... `;
  }

  if (event.result.status === 'skip') {
    return 'skipped\n';
  }

  const details = event.result.details ?? {};
  const parts: string[] = [];
  const tested = details.testedPages ?? details.tested;
  if (typeof tested === 'number') {
    parts.push(`${tested} tested`);
  }
  const fetchErrors = details.fetchErrors;
  if (typeof fetchErrors === 'number' && fetchErrors > 0) {
    parts.push(`${fetchErrors} fetch error${fetchErrors === 1 ? '' : 's'}`);
  }
  parts.push(formatDuration(event.durationMs));
  return `done (${parts.join(', ')})\n`;
}
