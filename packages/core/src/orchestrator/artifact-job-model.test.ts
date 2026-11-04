import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import dns from 'node:dns/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  prepareArtifactJobCodex,
  publicArtifactModelAddress,
  startArtifactModelProxy,
} from './artifact-job-model.js';

afterEach(() => vi.restoreAllMocks());
async function request(port: number, text: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    let response = '';
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('proxy timeout'));
    }, 2000);
    socket.on('connect', () => socket.write(text));
    socket.on('data', (chunk) => (response += chunk));
    socket.on('error', reject);
    socket.on('close', () => {
      clearTimeout(timer);
      resolve(response);
    });
  });
}
describe('artifact model service capability', () => {
  it('rejects private, local, mapped and reserved addresses', () => {
    for (const ip of [
      '127.0.0.1',
      '10.1.2.3',
      '169.254.1.1',
      '172.16.1.1',
      '192.168.1.1',
      '100.64.1.1',
      '198.18.1.1',
      '192.0.2.1',
      '203.0.113.1',
      '224.0.0.1',
      '::1',
      '::ffff:127.0.0.1',
      'fc00::1',
      'fe80::1',
      '2001:db8::1',
      'bad',
    ])
      expect(publicArtifactModelAddress(ip), ip).toBe(false);
    expect(publicArtifactModelAddress('1.1.1.1')).toBe(true);
    expect(publicArtifactModelAddress('2606:4700::1111')).toBe(true);
  });
  it('denies plain HTTP and malformed/foreign CONNECT before DNS', async () => {
    const lookup = vi.spyOn(dns, 'lookup');
    const proxy = await startArtifactModelProxy();
    try {
      for (const target of [
        'example.com:443',
        'chatgpt.com:80',
        'chatgpt.com:443#x',
        'user@chatgpt.com:443',
        'chatgpt.com.:443',
        '[::1]:443',
        'chatgpt.com:443/path',
      ])
        expect(
          await request(
            proxy.port,
            `CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`,
          ),
        ).toMatch(/HTTP\/1\.1 40[03]/);
      expect(
        await request(
          proxy.port,
          'GET http://chatgpt.com/ HTTP/1.1\r\nHost: chatgpt.com\r\nConnection: close\r\n\r\n',
        ),
      ).toContain('403');
      expect(lookup).not.toHaveBeenCalled();
    } finally {
      await proxy.close();
    }
  });
  it('fails closed when an approved name resolves to any private address', async () => {
    vi.spyOn(dns, 'lookup').mockResolvedValue([
      { address: '1.1.1.1', family: 4 },
      { address: '127.0.0.1', family: 4 },
    ] as never);
    const proxy = await startArtifactModelProxy();
    try {
      expect(
        await request(
          proxy.port,
          'CONNECT chatgpt.com:443 HTTP/1.1\r\nHost: chatgpt.com:443\r\n\r\n',
        ),
      ).not.toContain('200');
    } finally {
      await proxy.close();
    }
  });
  it('closes outstanding clients and prevents a delayed DNS result opening a tunnel', async () => {
    let resolveLookup!: (value: never) => void;
    vi.spyOn(dns, 'lookup').mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveLookup = resolve;
        }) as never,
    );
    const proxy = await startArtifactModelProxy();
    const pending = request(
      proxy.port,
      'CONNECT chatgpt.com:443 HTTP/1.1\r\nHost: chatgpt.com:443\r\n\r\n',
    );
    await vi.waitFor(() => expect(resolveLookup).toBeDefined());
    await proxy.close();
    resolveLookup([{ address: '1.1.1.1', family: 4 }] as never);
    expect(await pending).not.toContain('200');
  });
  it('copies only minimal private auth/config and keeps the configured model', () => {
    const tmp = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'artifact-codex-config-')),
    );
    try {
      fs.mkdirSync(path.join(tmp, 'home'));
      const auth = path.join(tmp, 'auth.json');
      fs.writeFileSync(
        auth,
        JSON.stringify({ auth_mode: 'fixture', tokens: { synthetic: true } }),
      );
      const launch = prepareArtifactJobCodex(tmp, {
        model: 'configured-model',
        reasoningEffort: 'high',
        serviceTier: 'priority',
        authJsonPath: auth,
        prompt: 'Create output/artifact.zip from the synthetic inputs.',
      });
      const codexHome = launch.env.CODEX_HOME;
      expect(fs.existsSync(path.join(codexHome, 'auth.json'))).toBe(false);
      launch.seedAuth();
      expect(fs.readdirSync(codexHome).sort()).toEqual([
        'auth.json',
        'config.toml',
      ]);
      const config = fs.readFileSync(
        path.join(codexHome, 'config.toml'),
        'utf8',
      );
      expect(config).toContain('model = "configured-model"');
      expect(config).toContain('web_search = "disabled"');
      expect(config).toContain('default_permissions = "artifact-tools"');
      expect(config).toContain(`${JSON.stringify(codexHome)} = "deny"`);
      expect(config).toContain('approval_policy = "never"');
      expect(config).toContain('view_image = false');
      expect(config).toContain('code_mode_host = false');
      expect(config).toContain('hooks = false');
      expect(config).toContain(
        '[permissions.artifact-tools.network]\nenabled = false',
      );
      expect(config).not.toContain('mcp_servers');
      expect(fs.statSync(path.join(codexHome, 'auth.json')).mode & 0o777).toBe(
        0o600,
      );
      expect(launch.args).toContain('--ephemeral');
      expect(launch.args).toContain('--strict-config');
      expect(launch.args).toContain('--ignore-rules');
      expect(launch.args).not.toContain(
        '--dangerously-bypass-approvals-and-sandbox',
      );
      expect(launch.args).not.toContain('--sandbox');
      expect(launch.input).toContain('synthetic inputs');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
