import fs from 'node:fs';
import crypto from 'node:crypto';
import { codexAccountUsedPercentAcrossHomes } from './codex-accounting.js';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import net from 'node:net';
import dns from 'node:dns/promises';
import { readBoundedRegularFileNoFollowSync } from './safe-file-read.js';

export interface ArtifactJobCodexConfig {
  model: string;
  reasoningEffort?: string;
  serviceTier?: string;
  authJsonPath: string;
  prompt: string;
}

export const ARTIFACT_CODEX_PERMISSION_PROFILE = 'artifact-tools';
export const ARTIFACT_CODEX_TOOL_POLICY = 'macos-codex-tool-permissions-v1';
export interface ArtifactJobCodexLaunch {
  args: string[];
  env: Record<string, string>;
  input: string;
  permissionsProfile: typeof ARTIFACT_CODEX_PERMISSION_PROFILE;
  toolProfileSha256: string;
  /** Хост вызывает только после проверки границы на синтетической авторизации. */
  seedAuth: () => void;
}

const ARTIFACT_DISABLED_FEATURES = [
  'apps',
  'plugins',
  'hooks',
  'browser_use',
  'browser_use_external',
  'browser_use_full_cdp_access',
  'computer_use',
  'in_app_browser',
  'image_generation',
  'view_image',
  'multi_agent',
  'multi_agent_v2',
  'memories',
  'external_agent_memory_import',
  'code_mode',
  'skill_search',
  'skill_mcp_dependency_install',
  'workspace_dependencies',
  'plugin_discovery_prefetch',
  'remote_plugin',
  'multi_env_copy_file',
  'in_app_local_automation',
  'auth_elicitation',
  'daemon_auto_start',
];

/** Только command sandbox. Контроллер Codex читает auth, его инструменты — нет. */
export function artifactCodexPermissionConfiguration(
  workspace: string,
  home: string,
  readPaths: string[] = [],
): string[] {
  const root = fs.realpathSync(workspace);
  if (root !== workspace || path.dirname(home) !== path.join(root, 'home'))
    throw new Error('model_workspace_invalid');
  const reads = [
    ...new Set(
      [
        '/opt/homebrew/Cellar',
        '/opt/homebrew/opt',
        ...readPaths.map((p) => fs.realpathSync(p)),
      ].filter((p) => fs.existsSync(p)),
    ),
  ];
  if (
    reads.length > 24 ||
    reads.some((p) => p === '/' || p === home || p.startsWith(home + path.sep))
  )
    throw new Error('model_tool_roots_invalid');
  // Codex's minimal macOS baseline includes the shared /private/tmp tree.
  // Deny temporary roots explicitly; the narrower workspace/output rules below
  // grant only this job's paths. Do not make sibling jobs readable via :minimal.
  const deniedTemps = [
    ...new Set(
      ['/private/tmp', '/private/var/tmp', '/private/var/folders', os.tmpdir()]
        .filter((p) => fs.existsSync(p))
        .map((p) => fs.realpathSync(p)),
    ),
  ];
  const filesystemRules = new Map<string, string>();
  for (const [directory, mode] of [
    [':root', 'deny'],
    [':minimal', 'read'],
    ...deniedTemps.map((p) => [p, 'deny']),
    ...reads.map((p) => [p, 'read']),
    [root, 'read'],
    [path.join(root, 'output'), 'write'],
    [path.join(root, 'scratch'), 'write'],
    [home, 'deny'],
  ]) {
    const existing = filesystemRules.get(directory);
    if (existing && existing !== mode)
      throw new Error('model_tool_policy_conflict');
    filesystemRules.set(directory, mode);
  }
  return [
    `default_permissions = ${JSON.stringify(ARTIFACT_CODEX_PERMISSION_PROFILE)}`,
    'approval_policy = "never"',
    'notify = []',
    '[shell_environment_policy]',
    'inherit = "core"',
    'ignore_default_excludes = false',
    '[shell_environment_policy.set]',
    'OPENSSL_CONF = "/dev/null"',
    'SSL_CERT_FILE = "/etc/ssl/cert.pem"',
    '[shell_environment_policy.filters]',
    ...[
      'CODEX_*',
      'OPENAI_*',
      '*_TOKEN',
      '*_SECRET',
      '*_PASSWORD',
      '*_API_KEY',
      'HTTP_PROXY',
      'HTTPS_PROXY',
      'ALL_PROXY',
    ].map((key) => `${JSON.stringify(key)} = "exclude"`),
    `[permissions.${ARTIFACT_CODEX_PERMISSION_PROFILE}.filesystem]`,
    ...[...filesystemRules].map(
      ([p, mode]) => `${JSON.stringify(p)} = ${JSON.stringify(mode)}`,
    ),
    `[permissions.${ARTIFACT_CODEX_PERMISSION_PROFILE}.network]`,
    'enabled = false',
  ];
}

/** CLI-only: cwd must be the selected instance before provider config is imported. */
export async function configuredArtifactJobCodex(
  instanceRoot: string,
  authJsonPath: string,
  prompt: string,
): Promise<{
  executable: string;
  codex: ArtifactJobCodexConfig;
  version: string;
}> {
  const root = fs.realpathSync(instanceRoot);
  if (fs.realpathSync(process.cwd()) !== root)
    throw new Error('model_config_instance_mismatch');
  const { loadModelGatewayConfig } =
    await import('@skoobi/providers/model-gateway');
  const configured = loadModelGatewayConfig().codex;
  if (!configured?.enabled || !configured.model)
    throw new Error('model_config_unavailable');
  const manifest = JSON.parse(
    readBoundedRegularFileNoFollowSync(
      path.join(root, 'runtime/codex-toolchain.json'),
      { maxBytes: 32 * 1024, oversize: 'reject', requireSingleLink: true },
    ).buffer.toString('utf8'),
  );
  if (
    manifest.schemaVersion !== 1 ||
    !/^\d+\.\d+\.\d+$/.test(manifest.version) ||
    manifest.destination !== `node_modules/.skoobi-codex-${manifest.version}` ||
    manifest.binary !==
      'node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex' ||
    manifest.launcher !== 'node_modules/.bin/codex' ||
    manifest.platform !== process.platform ||
    manifest.arch !== process.arch ||
    !/^[a-f0-9]{64}$/.test(manifest.binarySha256)
  )
    throw new Error('model_toolchain_unavailable');
  const prefix = path.join(root, manifest.destination);
  // An ambiguous PATH command cannot silently select another installed version.
  if (
    !configured.command.includes('/') ||
    fs.realpathSync(path.resolve(root, configured.command)) !==
      fs.realpathSync(path.join(prefix, manifest.launcher))
  )
    throw new Error('model_toolchain_mismatch');
  const executable = path.join(prefix, manifest.binary);
  const bytes = readBoundedRegularFileNoFollowSync(executable, {
    maxBytes: 384 * 1024 * 1024,
    oversize: 'reject',
    requireSingleLink: true,
  }).buffer;
  if (
    crypto.createHash('sha256').update(bytes).digest('hex') !==
    manifest.binarySha256
  )
    throw new Error('model_toolchain_mismatch');
  const used = codexAccountUsedPercentAcrossHomes({
    dataDir: path.join(root, 'data'),
  });
  const serviceTier =
    configured.serviceTier === 'priority' &&
    (used === null || used < (configured.serviceTierMaxUsedPercent ?? 80))
      ? 'priority'
      : undefined;
  return {
    executable,
    version: manifest.version,
    codex: {
      model: configured.model,
      reasoningEffort: configured.reasoningEffort,
      serviceTier,
      authJsonPath,
      prompt,
    },
  };
}

export function prepareArtifactJobCodex(
  workspace: string,
  config: ArtifactJobCodexConfig,
  readPaths: string[] = [],
): ArtifactJobCodexLaunch {
  if (
    !/^[a-zA-Z0-9._-]{1,100}$/.test(config.model) ||
    config.prompt.length < 1 ||
    config.prompt.length > 32_768 ||
    (config.reasoningEffort &&
      !/^[a-z_]{1,20}$/.test(config.reasoningEffort)) ||
    (config.serviceTier && !/^[a-z_]{1,20}$/.test(config.serviceTier))
  )
    throw new Error('model_config_invalid');
  const home = path.join(workspace, 'home', '.codex');
  fs.mkdirSync(home, { mode: 0o700 });
  const lines = [
    `model = ${JSON.stringify(config.model)}`,
    'cli_auth_credentials_store = "file"',
    'web_search = "disabled"',
    'check_for_update_on_startup = false',
    'project_doc_max_bytes = 0',
    'project_root_markers = []',
    ...artifactCodexPermissionConfiguration(workspace, home, readPaths),
    '[features]',
    ...ARTIFACT_DISABLED_FEATURES.map((name) => `${name} = false`),
    // Some model tool catalogs route exec/apply_patch through functions.exec
    // even with code_mode=false. The local V8 host brokers those existing
    // sandboxed tools; it does not grant filesystem, network or MCP access.
    'code_mode_host = true',
    'skip_host_skill_discovery = true',
    '[history]',
    'persistence = "none"',
  ];
  if (config.reasoningEffort)
    lines.unshift(
      `model_reasoning_effort = ${JSON.stringify(config.reasoningEffort)}`,
    );
  if (config.serviceTier)
    lines.unshift(`service_tier = ${JSON.stringify(config.serviceTier)}`);
  const encoded = lines.join('\n') + '\n';
  const configPath = path.join(home, 'config.toml');
  fs.writeFileSync(configPath, encoded, {
    flag: 'wx',
    mode: 0o600,
  });
  return {
    args: [
      '--disable',
      'apps',
      '--disable',
      'plugins',
      'exec',
      '--strict-config',
      '--ignore-rules',
      '-c',
      'approval_policy="never"',
      '--cd',
      workspace,
      '--skip-git-repo-check',
      '--ephemeral',
      '--json',
      '-',
    ],
    env: { CODEX_HOME: home },
    input: `You are a delegated artifact producer. Your local commands use an enforced task-only permission profile; credentials and host files are denied, and commands have no network access. Read inputs/; write the requested deliverable under output/. Other apps, MCP bridges, personal memory and approval escalation are unavailable. Do not seek permissions or modify the runtime configuration. Complete the specified artifact task.\n\n${config.prompt}`,
    permissionsProfile: ARTIFACT_CODEX_PERMISSION_PROFILE,
    toolProfileSha256: crypto
      .createHash('sha256')
      .update(encoded)
      .digest('hex'),
    seedAuth: () => {
      if (
        fs.realpathSync(home) !== home ||
        fs.readFileSync(configPath, 'utf8') !== encoded
      )
        throw new Error('model_tool_profile_changed');
      const auth = readBoundedRegularFileNoFollowSync(config.authJsonPath, {
        maxBytes: 128 * 1024,
        oversize: 'reject',
        requireSingleLink: true,
      }).buffer;
      const value = JSON.parse(auth.toString('utf8'));
      if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new Error('model_auth_invalid');
      fs.writeFileSync(path.join(home, 'auth.json'), auth, {
        flag: 'wx',
        mode: 0o600,
      });
    },
  };
}

/** Small CONNECT-only proxy; it never supplies credentials or forwards plain HTTP. */
export async function startArtifactModelProxy(): Promise<{
  port: number;
  close: () => Promise<void>;
}> {
  let closed = false;
  const sockets = new Set<net.Socket>();
  const server = http.createServer(
    { maxHeaderSize: 8192 },
    (_request, response) => {
      response.writeHead(403);
      response.end();
    },
  );
  server.maxConnections = 16;
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    socket.setTimeout(120_000, () => socket.destroy());
  });
  server.on('connect', async (request, client, head) => {
    const match =
      /^(chatgpt\.com|api\.openai\.com|auth\.openai\.com):443$/.exec(
        request.url || '',
      );
    if (!match || head.length > 16 * 1024 || sockets.size > 16) {
      client.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }
    let addresses: Array<{ address: string; family: number }>;
    let lookupTimer: NodeJS.Timeout | undefined;
    try {
      addresses = await Promise.race([
        dns.lookup(match[1], { all: true, verbatim: true }),
        new Promise<never>((_resolve, reject) => {
          lookupTimer = setTimeout(
            () => reject(new Error('dns_timeout')),
            3000,
          );
        }),
      ]);
    } catch {
      client.destroy();
      return;
    } finally {
      if (lookupTimer) clearTimeout(lookupTimer);
    }
    if (
      closed ||
      client.destroyed ||
      !addresses.length ||
      !addresses.every((address) => publicArtifactModelAddress(address.address))
    ) {
      client.destroy();
      return;
    }
    const target =
      addresses.find((address) => address.family === 4) || addresses[0];
    // Connect to this checked address, never resolve the hostname again.
    const upstream = net.createConnection({
      host: target.address,
      port: 443,
      family: target.family,
    });
    sockets.add(upstream);
    const deadline = setTimeout(() => upstream.destroy(), 10_000);
    upstream.once('connect', () => {
      clearTimeout(deadline);
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      client.pipe(upstream);
      upstream.pipe(client);
    });
    upstream.setTimeout(120_000, () => upstream.destroy());
    upstream.once('close', () => {
      clearTimeout(deadline);
      sockets.delete(upstream);
      client.destroy();
    });
    upstream.on('error', () => client.destroy());
    client.once('close', () => upstream.destroy());
    client.on('error', () => upstream.destroy());
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return {
    port: (server.address() as net.AddressInfo).port,
    close: async () => {
      closed = true;
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

export function publicArtifactModelAddress(address: string): boolean {
  if (net.isIP(address) === 4) {
    const [a, b, c] = address.split('.').map(Number);
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 168 || b === 0 || (b === 88 && c === 99))) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113)
    );
  }
  // Only global unicast 2000::/3; no mapped IPv4, local, scoped or documentation addresses.
  if (net.isIP(address) !== 6 || address.includes('.') || address.includes('%'))
    return false;
  const [first, second] = address
    .split(':')
    .map((part) => parseInt(part || '0', 16));
  return (
    first >= 0x2000 &&
    first <= 0x3fff &&
    first !== 0x2002 &&
    !(first === 0x2001 && (second < 0x200 || second === 0xdb8)) &&
    !(first === 0x3fff && second < 0x1000)
  );
}
