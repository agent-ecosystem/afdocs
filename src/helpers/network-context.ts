import type { NetworkContext } from '../types.js';

/**
 * Environment variables that identify CI runners. Checked before the cloud
 * list because CI providers often run on cloud infrastructure and the more
 * specific label is the useful one.
 */
const CI_INDICATORS = [
  'GITHUB_ACTIONS',
  'GITLAB_CI',
  'CIRCLECI',
  'TRAVIS',
  'BUILDKITE',
  'JENKINS_URL',
  'TF_BUILD',
  'TEAMCITY_VERSION',
  'CODEBUILD_BUILD_ID',
  'BITBUCKET_BUILD_NUMBER',
  'DRONE',
  'CI',
];

/** Environment variables that identify cloud-hosted execution (serverless, containers, cloud dev environments). */
const CLOUD_INDICATORS = [
  'AWS_EXECUTION_ENV',
  'AWS_LAMBDA_FUNCTION_NAME',
  'ECS_CONTAINER_METADATA_URI',
  'ECS_CONTAINER_METADATA_URI_V4',
  'K_SERVICE',
  'GOOGLE_CLOUD_PROJECT',
  'CLOUD_SHELL',
  'WEBSITE_INSTANCE_ID',
  'KUBERNETES_SERVICE_HOST',
  'DYNO',
  'FLY_APP_NAME',
  'RAILWAY_ENVIRONMENT',
  'RENDER',
  'VERCEL',
  'CODESPACES',
  'GITPOD_WORKSPACE_ID',
];

function isSet(value: string | undefined): boolean {
  if (value === undefined) return false;
  const v = value.trim().toLowerCase();
  return v !== '' && v !== '0' && v !== 'false';
}

/**
 * Classify where the scan is running from, using only environment variables.
 * Bot enforcement is commonly keyed to client reputation (IP range, ASN), so
 * a scan from CI or cloud infrastructure can trigger enforcement that a
 * developer's residential connection would not. That mirrors real agent
 * traffic, which comes from both kinds of vantage point; the classification
 * lets a reader interpret an interference finding, and it never carries the
 * scanner's IP address because reports are often shared.
 */
export function detectNetworkContext(
  env: Record<string, string | undefined> = process.env,
): NetworkContext {
  for (const name of CI_INDICATORS) {
    if (isSet(env[name])) return { classification: 'ci', source: 'environment', indicator: name };
  }
  for (const name of CLOUD_INDICATORS) {
    if (isSet(env[name])) {
      return { classification: 'cloud', source: 'environment', indicator: name };
    }
  }
  return { classification: 'developer-machine', source: 'environment' };
}

export function describeNetworkContext(ctx: NetworkContext): string {
  switch (ctx.classification) {
    case 'ci':
      return 'CI infrastructure';
    case 'cloud':
      return 'cloud infrastructure';
    default:
      return 'a developer machine';
  }
}
