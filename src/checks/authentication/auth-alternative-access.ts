import { registerCheck } from '../registry.js';
import type { CheckContext, CheckResult } from '../../types.js';
import { t } from '../../i18n/index.js';

interface AuthGateDetails {
  accessible?: number;
  authRequired?: number;
  softAuthGate?: number;
  authRedirect?: number;
  testedPages?: number;
  fetchErrors?: number;
  pageResults?: Array<{
    url: string;
    classification: string;
  }>;
}

interface DetectedPath {
  type: string;
  description: string;
}

async function check(ctx: CheckContext): Promise<CheckResult> {
  const id = 'auth-alternative-access';
  const category = 'authentication';

  // Read auth-gate-detection result; skip if it didn't run or docs are all public
  const authResult = ctx.previousResults.get('auth-gate-detection');
  if (!authResult) {
    return {
      id,
      category,
      status: 'skip',
      message: t('check.auth-alternative-access.skip_dep_missing'),
    };
  }

  if (authResult.status === 'pass') {
    return {
      id,
      category,
      status: 'skip',
      message: t('check.auth-alternative-access.pass_public'),
    };
  }

  if (authResult.status === 'skip' || authResult.status === 'error') {
    return {
      id,
      category,
      status: 'skip',
      message: t('check.auth-alternative-access.skip_dep_status', {
        status: authResult.status === 'error' ? 'errored' : 'was skipped',
      }),
    };
  }

  // Auth-gate-detection returned warn or fail — look for alternative access paths
  const authDetails = (authResult.details ?? {}) as AuthGateDetails;
  const gatedCount =
    (authDetails.authRequired ?? 0) +
    (authDetails.softAuthGate ?? 0) +
    (authDetails.authRedirect ?? 0);
  const accessibleCount = authDetails.accessible ?? 0;
  const testedCount = authDetails.testedPages ?? 0;
  const fetchErrors = authDetails.fetchErrors ?? 0;

  // If auth-gate-detection failed solely because pages couldn't be fetched
  // (DNS failure, network error, etc.) rather than from detected auth responses,
  // we have no signal about authentication. Skip rather than imply an auth problem.
  if (gatedCount === 0 && fetchErrors > 0) {
    return {
      id,
      category,
      status: 'skip',
      message: t('check.auth-alternative-access.skip_fetch_errors'),
    };
  }

  const detectedPaths: DetectedPath[] = [];

  // 1. Check for public llms.txt
  const llmsResult = ctx.previousResults.get('llms-txt-exists');
  if (llmsResult?.status === 'pass' || llmsResult?.status === 'warn') {
    detectedPaths.push({
      type: 'public-llms-txt',
      description:
        'Site serves a public llms.txt file, giving agents a navigational index even though docs pages are gated',
    });
  }

  // 2. Check for publicly accessible markdown
  const mdUrlResult = ctx.previousResults.get('markdown-url-support');
  const cnResult = ctx.previousResults.get('content-negotiation');
  if (mdUrlResult?.status === 'pass' || mdUrlResult?.status === 'warn') {
    detectedPaths.push({
      type: 'public-markdown',
      description:
        'Some pages serve markdown via .md URLs, providing agent-readable content without authentication',
    });
  } else if (cnResult?.status === 'pass' || cnResult?.status === 'warn') {
    detectedPaths.push({
      type: 'public-markdown',
      description:
        'Some pages serve markdown via content negotiation, providing agent-readable content without authentication',
    });
  }

  // 3. Check for partially accessible pages (from auth-gate-detection itself)
  if (accessibleCount > 0 && gatedCount > 0) {
    const pct = Math.round((accessibleCount / testedCount) * 100);
    detectedPaths.push({
      type: 'partial-public-access',
      description: `${accessibleCount} of ${testedCount} tested pages (${pct}%) are publicly accessible without authentication`,
    });
  }

  // Determine status
  const manualOnlyNote = t('check.auth-alternative-access.manual_note');

  let status: 'pass' | 'warn' | 'fail';
  let message: string;

  if (detectedPaths.length === 0) {
    status = 'fail';
    message = t('check.auth-alternative-access.fail_none', {
      gated: gatedCount,
      note: manualOnlyNote,
    });
  } else {
    // Pass if we found a full-content path (llms.txt + markdown, or most pages accessible).
    // Warn if we only found partial paths (llms.txt alone is just an index, not content).
    const hasContentPath = detectedPaths.some((p) => p.type === 'public-markdown');
    const hasHighAccessibility =
      accessibleCount > 0 && testedCount > 0 && accessibleCount / testedCount >= 0.5;

    if (hasContentPath || hasHighAccessibility) {
      status = 'pass';
    } else {
      status = 'warn';
    }

    const pathSummary = detectedPaths.map((p) => p.type).join(', ');
    message =
      status === 'pass'
        ? t('check.auth-alternative-access.pass', { paths: pathSummary, gated: gatedCount })
        : t('check.auth-alternative-access.warn_partial', {
            paths: pathSummary,
            gated: gatedCount,
            note: manualOnlyNote,
          });
  }

  return {
    id,
    category,
    status,
    message,
    details: {
      gatedPages: gatedCount,
      accessiblePages: accessibleCount,
      testedPages: testedCount,
      detectedPaths,
      manualVerificationNeeded: [
        'Bundled documentation (docs shipped in package/SDK)',
        'CLI-based doc access (e.g. `yourproduct docs search "topic"`)',
        'MCP server providing doc access through tool calls',
      ],
    },
  };
}

registerCheck({
  id: 'auth-alternative-access',
  category: 'authentication',
  description:
    'Whether an auth-gated documentation site provides alternative access paths for agents',
  dependsOn: [],
  run: check,
});
