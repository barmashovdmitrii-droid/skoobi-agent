import fs from 'node:fs';
import path from 'node:path';

import {
  checkRegisteredArtifactAcceptance,
  createArtifactAcceptanceDeliveryPolicy,
  registerArtifactAcceptanceContract,
} from '@skoobi/core/artifact-acceptance-policy';
import {
  defaultArtifactAcceptanceHost,
  prepareArtifactAcceptanceHost,
  validateArtifactAcceptanceRequirements,
  type ArtifactAcceptanceHost,
} from '@skoobi/core/artifact-acceptance';

const usage = `Host artifact acceptance (no model-facing IPC endpoint)
Usage: node dist/scripts/artifact-acceptance.js <prepare|register|check|verify>
  [--instance-root <instance>] [--artifact <archive.zip|final.pdf|final.xlsx>]
  [--requirements <host-approved.json>] [--python <absolute-executable>]
  [--soffice <absolute-native-executable>]

prepare explicitly copies the reviewed checker to private host state outside the instance.
register stores host-approved criteria and clears any earlier receipt.
check uses the current deployment boundary. This ordinary same-user host CLI
cannot prove isolation and returns inconclusive in owner-full-access mode.
verify checks a protected delivery snapshot, then removes that temporary copy.
Only register takes --requirements. Registration is an explicit host action.
No flag may upgrade this CLI to workspace-isolated. Use artifact-job.js for an actual enforced macOS producer and signed receipt.
The browser evaluation is evals/task-continuity/artifact-acceptance/run.mjs.
Install the declared Playwright dev dependency and its Chromium build in the
isolated tool installation. Do not build or install in a live service instance.
`;

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (!command || command === '--help') {
    process.stdout.write(usage);
    return;
  }
  if (!['prepare', 'register', 'check', 'verify'].includes(command))
    throw new Error('invalid_command');
  const options = new Map<string, string>();
  const allowed = [
    '--artifact',
    '--instance-root',
    '--requirements',
    '--python',
    '--soffice',
  ];
  for (let index = 0; index < args.length; index += 2) {
    const option = args[index];
    const value = args[index + 1];
    if (!allowed.includes(option) || !value || value.startsWith('--'))
      throw new Error('invalid_argument');
    if (options.has(option)) throw new Error('duplicate_argument');
    else options.set(option, value);
  }
  const instanceRoot = path.resolve(
    options.get('--instance-root') ?? process.cwd(),
  );
  if (command === 'prepare') {
    if (options.has('--artifact') || options.has('--requirements'))
      throw new Error('invalid_argument');
    prepareArtifactAcceptanceHost(
      instanceRoot,
      path.join(instanceRoot, 'scripts/artifact-acceptance-checker.mjs'),
    );
    process.stdout.write(
      `${JSON.stringify({ status: 'prepared', assurance: 'owner-full-access' })}\n`,
    );
    return;
  }
  if (!options.has('--artifact')) throw new Error('missing_argument');
  const host: ArtifactAcceptanceHost = {
    ...defaultArtifactAcceptanceHost(instanceRoot),
    ...(options.has('--python')
      ? { pythonCommand: path.resolve(options.get('--python')!) }
      : {}),
    ...(options.has('--soffice')
      ? { sofficeCommand: path.resolve(options.get('--soffice')!) }
      : {}),
  };
  const artifactPath = path.resolve(options.get('--artifact')!);
  if (command === 'register') {
    const filename = options.get('--requirements');
    if (!filename || fs.statSync(filename).size > 16_384)
      throw new Error('requirements_invalid');
    const requirements: unknown = JSON.parse(fs.readFileSync(filename, 'utf8'));
    if (!validateArtifactAcceptanceRequirements(requirements))
      throw new Error('requirements_invalid');
    registerArtifactAcceptanceContract({ artifactPath, requirements, host });
    process.stdout.write(
      `${JSON.stringify({ status: 'registered', checked: false })}\n`,
    );
  } else {
    if (options.has('--requirements'))
      throw new Error('criteria_must_be_registered_first');
    if (command === 'check') {
      const result = await checkRegisteredArtifactAcceptance({
        artifactPath,
        host,
      });
      process.stdout.write(
        `${JSON.stringify({ status: result.status, code: result.code, receiptId: result.receipt?.payload.id })}\n`,
      );
      if (result.status !== 'passed')
        process.exitCode = result.status === 'failed' ? 1 : 2;
    } else {
      const decision =
        await createArtifactAcceptanceDeliveryPolicy(host)(artifactPath);
      try {
        process.stdout.write(
          `${JSON.stringify({ required: decision.required, status: decision.status, code: decision.code })}\n`,
        );
      } finally {
        decision.cleanup?.();
      }
      if (decision.required && decision.status !== 'passed')
        process.exitCode = 2;
    }
  }
}
main().catch(() => {
  process.stderr.write(
    'Artifact acceptance could not complete; check host configuration and documented arguments.\n',
  );
  process.exitCode = 2;
});
