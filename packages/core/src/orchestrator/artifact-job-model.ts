import fs from 'node:fs';
import crypto from 'node:crypto';
import { codexAccountUsedPercentAcrossHomes } from './codex-accounting.js';
import path from 'node:path';
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
): { args: string[]; env: Record<string, string>; input: string } {
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
  const lines = [
    `model = ${JSON.stringify(config.model)}`,
    'cli_auth_credentials_store = "file"',
    'web_search = "disabled"',
    'check_for_update_on_startup = false',
    'project_doc_max_bytes = 0',
    'project_root_markers = []',
    '[features]',
    'apps = false',
    'plugins = false',
    '[history]',
    'persistence = "none"',
  ];
  if (config.reasoningEffort)
    lines.unshift(
      `model_reasoning_effort = ${JSON.stringify(config.reasoningEffort)}`,
    );
  if (config.serviceTier)
    lines.unshift(`service_tier = ${JSON.stringify(config.serviceTier)}`);
  fs.writeFileSync(path.join(home, 'config.toml'), lines.join('\n') + '\n', {
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
      '--dangerously-bypass-approvals-and-sandbox',
      '--skip-git-repo-check',
      '--ephemeral',
      '--json',
      '-',
    ],
    env: { CODEX_HOME: home },
    input: `You are running inside an externally enforced artifact-job sandbox. All subprocesses inherit it. Read inputs/; write the requested deliverable under output/. Host authority, other apps, MCP bridges and network destinations beyond the model service are unavailable. Do not seek permissions or modify system configuration. Complete the specified artifact task.\n\n${config.prompt}`,
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
