/**
 * Container runtime abstraction for ClaudeClaw.
 * All runtime-specific logic lives here so swapping runtimes means changing one file.
 */
import { execSync } from 'child_process';
import { randomBytes } from 'crypto';
import fs from 'fs';
import os from 'os';

import { readEnvFile } from '../orchestrator/env.js';
import { logger } from '../orchestrator/logger.js';

const envFileVars = readEnvFile(['CREDENTIAL_PROXY_HOST']);

/**
 * Per-process shared secret authenticating the container -> credential-proxy
 * channel. Generated once at module load and never persisted. It doubles as the
 * PLACEHOLDER credential the container's SDK sends: container-runner.ts injects
 * this value (as x-api-key or Bearer token), and the credential proxy refuses to
 * forward the real Anthropic credential upstream unless the incoming caller
 * credential matches this secret (timing-safe). An unauthenticated caller that
 * reaches the proxy therefore gets a 403 and never the real key/token.
 */
export const CREDENTIAL_PROXY_CLIENT_SECRET = randomBytes(32).toString('hex');

/**
 * Host-only HMAC key for tenant/owner proxy identity capabilities. Unlike the
 * placeholder API credential above, this value is never passed into a
 * container; each container receives only its own signed identity token.
 */
export const CREDENTIAL_PROXY_IDENTITY_SIGNING_SECRET =
  randomBytes(32).toString('hex');

/** The container runtime binary name. */
export const CONTAINER_RUNTIME_BIN = 'container';

/** Hostname containers use to reach the host machine. */
export const CONTAINER_HOST_GATEWAY =
  CONTAINER_RUNTIME_BIN === 'container'
    ? '192.168.64.1'
    : 'host.docker.internal';

/**
 * Address the credential proxy binds to.
 * Apple Container (macOS): bind to the bridge gateway IP (192.168.64.1) so only
 *   the container VM can reach it — NOT 0.0.0.0, which would expose the
 *   credential-injecting proxy to the whole LAN.
 * Docker Desktop (macOS): 127.0.0.1 — the VM routes host.docker.internal to loopback.
 * Docker (Linux): bind to the docker0 bridge IP so only containers can reach it,
 *   falling back to loopback if the interface isn't found.
 */
export const PROXY_BIND_HOST =
  process.env.CREDENTIAL_PROXY_HOST ||
  envFileVars.CREDENTIAL_PROXY_HOST ||
  detectProxyBindHost();

function detectProxyBindHost(): string {
  // Apple Container uses a bridged network. The credential proxy injects the
  // REAL Anthropic key/OAuth token, so binding 0.0.0.0 here would expose it to
  // the whole LAN (only the per-process shared secret would stand between a LAN
  // attacker and the credential). Bind instead to the bridge gateway IP that the
  // container already targets to reach the host (CONTAINER_HOST_GATEWAY =
  // 192.168.64.1), so the proxy is reachable from the container VM but not the
  // wider LAN — mirroring the docker0-bridge approach used on Linux below.
  // CREDENTIAL_PROXY_HOST remains an explicit override if a wider bind is needed.
  if (os.platform() === 'darwin' && CONTAINER_RUNTIME_BIN === 'container')
    return CONTAINER_HOST_GATEWAY;
  if (os.platform() === 'darwin') return '127.0.0.1';

  // WSL uses Docker Desktop (same VM routing as macOS) — loopback is correct.
  // Check /proc filesystem, not env vars — WSL_DISTRO_NAME isn't set under systemd.
  if (fs.existsSync('/proc/sys/fs/binfmt_misc/WSLInterop')) return '127.0.0.1';

  // Bare-metal Linux: bind to the docker0 bridge IP instead of 0.0.0.0
  const ifaces = os.networkInterfaces();
  const docker0 = ifaces['docker0'];
  if (docker0) {
    const ipv4 = docker0.find((a) => a.family === 'IPv4');
    if (ipv4) return ipv4.address;
  }
  // No docker0 bridge found: DO NOT fall back to 0.0.0.0 — the credential proxy
  // injects real Anthropic credentials, so a 0.0.0.0 bind exposes credentialed
  // upstream access to the whole LAN. Default to loopback; set
  // CREDENTIAL_PROXY_HOST explicitly (and firewall it) if a wider bind is needed.
  return '127.0.0.1';
}

/** CLI args needed for the container to resolve the host gateway. */
export function hostGatewayArgs(): string[] {
  // On Linux, host.docker.internal isn't built-in — add it explicitly
  if (os.platform() === 'linux') {
    return ['--add-host=host.docker.internal:host-gateway'];
  }
  return [];
}

/** Returns CLI args for a readonly bind mount. */
export function readonlyMountArgs(
  hostPath: string,
  containerPath: string,
): string[] {
  return [
    '--mount',
    `type=bind,source=${hostPath},target=${containerPath},readonly`,
  ];
}

/** Returns the shell command to stop a container by name. */
export function stopContainer(name: string): string {
  return `${CONTAINER_RUNTIME_BIN} stop ${name}`;
}

/** Ensure the container runtime is running, starting it if needed. */
export function ensureContainerRuntimeRunning(): void {
  try {
    execSync(`${CONTAINER_RUNTIME_BIN} system status`, { stdio: 'pipe' });
    logger.debug('Container runtime already running');
  } catch {
    logger.info('Starting container runtime...');
    try {
      execSync(`${CONTAINER_RUNTIME_BIN} system start`, {
        stdio: 'pipe',
        timeout: 30000,
      });
      logger.info('Container runtime started');
    } catch (err) {
      logger.error({ err }, 'Failed to start container runtime');
      console.error(
        '\n╔════════════════════════════════════════════════════════════════╗',
      );
      console.error(
        '║  FATAL: Container runtime failed to start                      ║',
      );
      console.error(
        '║                                                                ║',
      );
      console.error(
        '║  Agents cannot run without a container runtime. To fix:        ║',
      );
      console.error(
        '║  1. Ensure Apple Container is installed                        ║',
      );
      console.error(
        '║  2. Run: container system start                                ║',
      );
      console.error(
        '║  3. Restart ClaudeClaw                                           ║',
      );
      console.error(
        '╚════════════════════════════════════════════════════════════════╝\n',
      );
      throw new Error('Container runtime is required but failed to start');
    }
  }
}

/** Kill orphaned ClaudeClaw containers from previous runs. */
export function cleanupOrphans(): void {
  try {
    const output = execSync(`${CONTAINER_RUNTIME_BIN} ls --format json`, {
      stdio: ['pipe', 'pipe', 'pipe'],
      encoding: 'utf-8',
    });
    const containers: { status: string; configuration: { id: string } }[] =
      JSON.parse(output || '[]');
    const orphans = containers
      .filter(
        (c) =>
          c.status === 'running' && c.configuration.id.startsWith('claudeclaw-'),
      )
      .map((c) => c.configuration.id);
    for (const name of orphans) {
      try {
        execSync(stopContainer(name), { stdio: 'pipe' });
      } catch {
        /* already stopped */
      }
    }
    if (orphans.length > 0) {
      logger.info(
        { count: orphans.length, names: orphans },
        'Stopped orphaned containers',
      );
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to clean up orphaned containers');
  }
}
