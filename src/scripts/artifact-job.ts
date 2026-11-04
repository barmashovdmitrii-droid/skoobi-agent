import fs from 'node:fs';
import path from 'node:path';
import {
  configuredArtifactJobCodex,
  runIsolatedArtifactJob,
  type IsolatedArtifactJobOptions,
} from '@skoobi/core/artifact-job';
import {
  defaultArtifactAcceptanceHost,
  validateArtifactAcceptanceRequirements,
} from '@skoobi/core/artifact-acceptance';
import {
  bindRegisteredArtifactAcceptanceReceipt,
  registerArtifactAcceptanceContract,
} from '@skoobi/core/artifact-acceptance-policy';

const usage = `Host-controlled artifact job (macOS only)
node dist/scripts/artifact-job.js --job <host-approved.json> --output <new-file>
  [--instance-root <instance>] [--soffice <native-executable>]

Prepare the host checker first with artifact-acceptance.js prepare.
The job JSON contains requirements, inputs, artifactRelativePath and either:
  producer: {executable, args, readOnlyPaths?} (offline program), or
  producer: {kind:"codex", authJsonPath, promptFile} (configured model).
Paths in the JSON are resolved against the JSON directory. Codex uses the selected
instance's existing gateway model/effort/quota tier and pinned native toolchain;
it never chooses a model or installed CLI from a global fallback configuration.
Only explicit inputs are copied to the sandbox. No ordinary MCP/plugins are loaded.
A successful actual isolated job writes the new output and binds its signed receipt
to the registered criteria. Missing isolation/viewer/checker returns inconclusive.
No existing output is overwritten. This command is not a model-facing IPC tool.
`;
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (!args.length || args.includes('--help')) {
    process.stdout.write(usage);
    return;
  }
  const options = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    if (
      !['--job', '--output', '--instance-root', '--soffice'].includes(
        args[i],
      ) ||
      !args[i + 1] ||
      args[i + 1].startsWith('--') ||
      options.has(args[i])
    )
      throw new Error('invalid_argument');
    options.set(args[i], args[i + 1]);
  }
  if (!options.has('--job') || !options.has('--output'))
    throw new Error('missing_argument');
  const filename = path.resolve(options.get('--job')!),
    output = path.resolve(options.get('--output')!);
  const instanceRoot = fs.realpathSync(
    path.resolve(options.get('--instance-root') || process.cwd()),
  );
  const metadata = fs.lstatSync(filename);
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.size > 32 * 1024
  )
    throw new Error('invalid_job');
  if (fs.existsSync(output)) throw new Error('output_exists');
  const job = JSON.parse(fs.readFileSync(filename, 'utf8'));
  if (
    !job ||
    !validateArtifactAcceptanceRequirements(job.requirements) ||
    !Array.isArray(job.inputs) ||
    !job.producer ||
    Object.keys(job).some(
      (key) =>
        ![
          'requirements',
          'inputs',
          'artifactRelativePath',
          'producer',
          'timeoutMs',
        ].includes(key),
    )
  )
    throw new Error('invalid_job');
  const resolve = (value: string): string => {
    if (typeof value !== 'string') throw new Error('invalid_path');
    return path.resolve(path.dirname(filename), value);
  };
  const requirements = structuredClone(job.requirements);
  if (requirements.kind === 'calculation-v1')
    for (const source of requirements.sources)
      source.path = resolve(source.path);
  const host = {
    ...defaultArtifactAcceptanceHost(instanceRoot),
    ...(options.has('--soffice')
      ? { sofficeCommand: path.resolve(options.get('--soffice')!) }
      : {}),
  };
  const inputs = job.inputs.map(
    (input: { sourcePath: string; relativePath: string }) => ({
      sourcePath: resolve(input.sourcePath),
      relativePath: input.relativePath,
    }),
  );
  let producer: IsolatedArtifactJobOptions['producer'],
    codex: IsolatedArtifactJobOptions['codex'];
  if (job.producer.kind === 'codex') {
    const promptPath = resolve(job.producer.promptFile),
      stat = fs.lstatSync(promptPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 32 * 1024)
      throw new Error('invalid_prompt');
    // The provider loader binds cwd at module load; select it before dynamic import.
    process.chdir(instanceRoot);
    const configured = await configuredArtifactJobCodex(
      instanceRoot,
      resolve(job.producer.authJsonPath),
      fs.readFileSync(promptPath, 'utf8'),
    );
    producer = { executable: configured.executable, args: [] };
    codex = configured.codex;
  } else
    producer = {
      executable: resolve(job.producer.executable),
      args: job.producer.args,
      readOnlyPaths: job.producer.readOnlyPaths?.map(resolve),
    };
  const result = await runIsolatedArtifactJob({
    host,
    requirements,
    inputs,
    producer,
    codex,
    artifactRelativePath: job.artifactRelativePath,
    timeoutMs: job.timeoutMs,
  });
  try {
    if (result.status === 'passed' && result.artifactPath && result.receipt) {
      fs.copyFileSync(result.artifactPath, output, fs.constants.COPYFILE_EXCL);
      fs.chmodSync(output, 0o600);
      registerArtifactAcceptanceContract({
        artifactPath: output,
        requirements,
        host,
      });
      const bound = bindRegisteredArtifactAcceptanceReceipt({
        artifactPath: output,
        receipt: result.receipt,
        host,
      });
      if (bound.status !== 'passed') throw new Error('receipt_binding_failed');
    }
    process.stdout.write(
      JSON.stringify({
        status: result.status,
        code: result.code,
        jobId: result.jobId,
        receiptId: result.receipt?.payload.id,
        humanAcceptance: 'not_recorded',
      }) + '\n',
    );
    if (result.status !== 'passed')
      process.exitCode = result.status === 'failed' ? 1 : 2;
  } finally {
    result.cleanup?.();
  }
}
main().catch(() => {
  process.stderr.write(
    'Artifact job could not complete; check the approved job, selected instance and supported runtime.\n',
  );
  process.exitCode = 2;
});
