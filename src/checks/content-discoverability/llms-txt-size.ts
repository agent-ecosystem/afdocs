import { registerCheck } from '../registry.js';
import { getLlmsTxtFilesForAnalysis } from '../../helpers/llms-txt.js';
import { t } from '../../i18n/index.js';
import type { CheckContext, CheckResult } from '../../types.js';

async function checkLlmsTxtSize(ctx: CheckContext): Promise<CheckResult> {
  const existsResult = ctx.previousResults.get('llms-txt-exists');
  const discovered = getLlmsTxtFilesForAnalysis(existsResult);

  if (discovered.length === 0) {
    return {
      id: 'llms-txt-size',
      category: 'content-discoverability',
      status: 'skip',
      message: t('check.llms-txt-size.skip_none'),
      dependsOn: ['llms-txt-exists'],
    };
  }

  const { pass: passThreshold, fail: failThreshold } = ctx.options.thresholds;

  const sizes = discovered.map((f) => ({
    url: f.url,
    characters: f.content.length,
    bytes: new TextEncoder().encode(f.content).byteLength,
  }));

  const details: Record<string, unknown> = { sizes, thresholds: ctx.options.thresholds };

  // Use the worst-case (largest) file for the overall status
  const maxSize = Math.max(...sizes.map((s) => s.characters));
  const size = maxSize.toLocaleString();
  const pass = passThreshold.toLocaleString();
  const fail = failThreshold.toLocaleString();

  if (maxSize <= passThreshold) {
    return {
      id: 'llms-txt-size',
      category: 'content-discoverability',
      status: 'pass',
      message: t('check.llms-txt-size.pass', { size, pass }),
      details,
    };
  }

  if (maxSize <= failThreshold) {
    return {
      id: 'llms-txt-size',
      category: 'content-discoverability',
      status: 'warn',
      message: t('check.llms-txt-size.warn', { size, pass, fail }),
      details,
    };
  }

  return {
    id: 'llms-txt-size',
    category: 'content-discoverability',
    status: 'fail',
    message: t('check.llms-txt-size.fail', { size, fail }),
    details,
  };
}

registerCheck({
  id: 'llms-txt-size',
  category: 'content-discoverability',
  description: 'Whether llms.txt fits within agent truncation limits',
  dependsOn: ['llms-txt-exists'],
  run: checkLlmsTxtSize,
});
