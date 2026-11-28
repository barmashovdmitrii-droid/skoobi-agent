import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { expect, it } from 'vitest';
import { prepareArtifactJobCodex } from './artifact-job-model.js';

type Item = Record<string, unknown>;
type Request = { input?: Item[]; tools?: Item[] };
const manifestPath = path.resolve('runtime/codex-toolchain.json');
const manifest = fs.existsSync(manifestPath)
  ? JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  : null;
const binary = manifest
  ? path.resolve(manifest.destination, manifest.binary)
  : '';
const quote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;

function run(
  args: string[],
  cwd: string,
  env: Record<string, string>,
  input = '',
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, {
      cwd,
      env,
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '',
      stderr = '',
      failed = false;
    const stop = () => {
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL');
      } catch {}
    };
    const timer = setTimeout(() => {
      failed = true;
      stop();
    }, 20_000);
    const collect = (chunk: Buffer, isError: boolean) => {
      if (isError) stderr += chunk.toString();
      else stdout += chunk.toString();
      if (stdout.length + stderr.length > 2 * 1024 * 1024) {
        failed = true;
        stop();
      }
    };
    child.stdout.on('data', (c: Buffer) => collect(c, false));
    child.stderr.on('data', (c: Buffer) => collect(c, true));
    child.stdin.on('error', () => {});
    child.on('error', (error) => {
      clearTimeout(timer);
      stop();
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      stop();
      if (failed) reject(new Error('bounded native fixture failed'));
      else resolve({ code, stdout, stderr });
    });
    child.stdin.end(input);
  });
}

function advertised(items: Item[], prefix = ''): string[] {
  return items.flatMap((item) =>
    item.type === 'namespace'
      ? advertised(item.tools as Item[], `${item.name}.`)
      : [`${prefix}${item.name}`],
  );
}

function outputJson(output: unknown): Record<string, unknown> {
  if (!Array.isArray(output)) throw new Error('missing exec output');
  for (const item of [...output].reverse()) {
    if (item?.type !== 'input_text') continue;
    try {
      return JSON.parse(item.text);
    } catch {}
  }
  throw new Error('missing structured exec output');
}

// No model inference: the pinned native CLI talks only to this loopback Responses
// fixture. Using a known model catalog is essential: fallback metadata omits the
// advertised functions.exec route and would miss the actual regression.
it.runIf(process.platform === 'darwin' && fs.existsSync(binary))(
  'executes advertised model tools while retaining file, network and capability denials',
  async () => {
    const root = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'advertised-tools-')),
    );
    const shared = fs.mkdtempSync('/private/tmp/advertised-canary-');
    const workspace = path.join(root, 'work space');
    fs.mkdirSync(workspace, { mode: 0o700 });
    for (const dir of ['home', 'inputs', 'output', 'scratch'])
      fs.mkdirSync(path.join(workspace, dir), { mode: 0o700 });
    const synthetic = JSON.stringify({
      OPENAI_API_KEY: 'synthetic-not-a-real-key',
    });
    const authSource = path.join(root, 'synthetic-auth.json');
    const outside = path.join(shared, 'synthetic-canary');
    fs.writeFileSync(authSource, synthetic, { mode: 0o600 });
    fs.writeFileSync(outside, 'synthetic-outside-file', { mode: 0o600 });
    let networkContacts = 0;
    const network = net.createServer((client) => {
      networkContacts++;
      client.destroy();
    });
    let provider: http.Server | undefined;
    try {
      expect(
        crypto
          .createHash('sha256')
          .update(fs.readFileSync(binary))
          .digest('hex'),
      ).toBe(manifest.binarySha256);
      const launch = prepareArtifactJobCodex(
        workspace,
        {
          model: 'gpt-6.1-sol',
          authJsonPath: authSource,
          prompt:
            'Synthetic local tool routing test; follow the fixture calls only.',
        },
        [
          fs.realpathSync(binary),
          path.dirname(fs.realpathSync(binary)),
          fs.realpathSync(process.execPath),
        ],
      );
      launch.seedAuth(); // Synthetic bytes only; no account or user auth is read.
      const home = launch.env.CODEX_HOME;
      const auth = path.join(home, 'auth.json');
      const config = path.join(home, 'config.toml');
      const configBefore = fs.readFileSync(config);
      await new Promise<void>((resolve) =>
        network.listen(0, '127.0.0.1', resolve),
      );
      const port = (network.address() as net.AddressInfo).port;
      const probe = `const fs=require('fs'),net=require('net');
const result={};for(const p of process.argv.slice(1)){try{fs.readFileSync(p);result[p]='READ'}catch(e){result[p]=e.code}}
fs.writeFileSync('output/shell.txt','allowed-shell');
const s=net.createConnection({host:'127.0.0.1',port:${port}});let finished=false;
const finish=value=>{if(finished)return;finished=true;result.network=value;s.destroy();console.log(JSON.stringify(result))};
s.on('connect',()=>finish('CONNECTED'));s.on('error',e=>finish(e.code));setTimeout(()=>finish('TIMEOUT'),1000).unref();`;
      const command = [
        fs.realpathSync(process.execPath),
        '-e',
        probe,
        auth,
        outside,
        authSource,
      ]
        .map(quote)
        .join(' ');
      const patch = (target: string, before: string) =>
        `*** Begin Patch\n*** Update File: ${target}\n@@\n-${before}\n+changed\n*** End Patch`;
      const code = [
        `text(await tools.exec_command(${JSON.stringify({ cmd: command, workdir: workspace, max_output_tokens: 1500 })}));`,
        `text(await tools.apply_patch(${JSON.stringify(patch(auth, synthetic))}));`,
        `text(await tools.apply_patch(${JSON.stringify(patch(outside, 'synthetic-outside-file'))}));`,
        `text(await tools.apply_patch(${JSON.stringify(`*** Begin Patch\n*** Add File: ${workspace}/output/patch.txt\n+allowed-patch\n*** End Patch`)}));`,
        `const result={tools:ALL_TOOLS.map(x=>x.name),globals:{},imports:{}};
for(const n of ['process','require','fetch','WebSocket'])result.globals[n]=typeof globalThis[n];
for(const n of ['node:fs','node:child_process','node:net',${JSON.stringify(`file://${auth}`)}]){try{await import(n);result.imports[n]='IMPORTED'}catch(e){result.imports[n]=String(e)}}
result.resources=await tools.list_mcp_resources({});
result.hidden={spawn:typeof tools.spawn_agent,image:typeof tools.view_image,browser:typeof tools.browser_use};text(result);`,
      ];
      const calls: Item[] = code.map((input, i) => ({
        type: 'custom_tool_call',
        id: `tool_${i}`,
        call_id: `call_${i}`,
        name: 'exec',
        input,
      }));
      calls.push({
        type: 'function_call',
        id: 'spawn',
        call_id: 'spawn',
        name: 'spawn_agent',
        arguments: JSON.stringify({
          task_name: 'synthetic_child',
          message: 'Reply Done without tools.',
        }),
      });
      calls.push({
        type: 'custom_tool_call',
        id: 'escalation',
        call_id: 'escalation',
        name: 'exec',
        input: `text(await tools.exec_command(${JSON.stringify({ cmd: `cat ${quote(auth)}`, sandbox_permissions: 'require_escalated', justification: 'Synthetic denial probe', max_output_tokens: 100 })}));`,
      });
      const requests: Request[] = [];
      const fixtureErrors: string[] = [];
      provider = http.createServer(async (request, response) => {
        try {
          if (request.method !== 'POST' || request.url !== '/v1/responses')
            throw new Error('unexpected fixture endpoint');
          let body = '';
          for await (const chunk of request) {
            body += chunk.toString();
            if (body.length > 2 * 1024 * 1024)
              throw new Error('fixture request too large');
          }
          requests.push(JSON.parse(body));
          const index = requests.length - 1;
          if (index > calls.length)
            throw new Error('unexpected extra model request');
          const item = calls[index] || {
            type: 'message',
            id: 'done',
            role: 'assistant',
            status: 'completed',
            content: [{ type: 'output_text', text: 'Fixture complete.' }],
          };
          const reply = {
            id: `response_${index}`,
            object: 'response',
            model: 'gpt-6.1-sol',
            created_at: 0,
            status: 'in_progress',
            output: [],
          };
          response.writeHead(200, {
            'Content-Type': 'text/event-stream',
            Connection: 'close',
          });
          for (const event of [
            { type: 'response.created', response: reply },
            { type: 'response.output_item.added', output_index: 0, item },
            { type: 'response.output_item.done', output_index: 0, item },
            {
              type: 'response.completed',
              response: {
                ...reply,
                status: 'completed',
                output: [item],
                usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
              },
            },
          ])
            response.write(`data: ${JSON.stringify(event)}\n\n`);
          response.end();
        } catch (error) {
          fixtureErrors.push(String(error));
          response.writeHead(500);
          response.end();
        }
      });
      await new Promise<void>((resolve) =>
        provider!.listen(0, '127.0.0.1', resolve),
      );
      const providerPort = (provider.address() as net.AddressInfo).port;
      const env = {
        PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`,
        HOME: path.join(workspace, 'home'),
        TMPDIR: path.join(workspace, 'scratch'),
        OPENSSL_CONF: '/dev/null',
        SSL_CERT_FILE: '/etc/ssl/cert.pem',
        LANG: 'en_US.UTF-8',
        ...launch.env,
        FIXTURE_KEY: 'synthetic-local-fixture-only',
      };
      // Listing configuration does not connect to MCP servers. Stop before any
      // resource call if system-level configuration introduced a real server.
      const mcp = await run(['mcp', 'list', '--json'], workspace, env);
      expect(mcp.code).toBe(0);
      expect(JSON.parse(mcp.stdout)).toEqual([]);
      const overrides = {
        model_provider: 'fixture',
        'features.enable_request_compression': false,
        'features.api_key_model_discovery': false,
        'features.api_key_cyber_access_programs': false,
        'model_providers.fixture.name': 'Loopback synthetic fixture',
        'model_providers.fixture.base_url': `http://127.0.0.1:${providerPort}/v1`,
        'model_providers.fixture.wire_api': 'responses',
        'model_providers.fixture.requires_openai_auth': false,
        'model_providers.fixture.env_key': 'FIXTURE_KEY',
        'model_providers.fixture.request_max_retries': 0,
        'model_providers.fixture.stream_max_retries': 0,
      };
      const args = [
        ...launch.args.slice(0, -1),
        ...Object.entries(overrides).flatMap(([key, value]) => [
          '-c',
          `${key}=${JSON.stringify(value)}`,
        ]),
        '-',
      ];
      const result = await run(args, workspace, env, launch.input);
      expect(result.code, result.stderr).toBe(0);
      expect(fixtureErrors).toEqual([]);
      expect(requests).toHaveLength(calls.length + 1);
      const catalog = [
        ...(requests[0].tools || []),
        ...(requests[0].input || [])
          .filter((item) => item.type === 'additional_tools')
          .flatMap((item) => item.tools as Item[]),
      ];
      expect(advertised(catalog)).toContain('functions.exec');
      const outputs = new Map(
        (requests.at(-1)!.input || [])
          .filter(
            (item) =>
              item.type === 'custom_tool_call_output' ||
              item.type === 'function_call_output',
          )
          .map((item) => [item.call_id, item.output]),
      );
      const shell = outputJson(outputs.get('call_0'));
      expect(shell.exit_code, JSON.stringify(shell)).toBe(0);
      expect(JSON.parse(shell.output as string)).toEqual({
        [auth]: 'EPERM',
        [outside]: 'EPERM',
        [authSource]: 'EPERM',
        network: 'EPERM',
      });
      expect(networkContacts).toBe(0);
      expect(JSON.stringify(outputs.get('call_1'))).toContain(
        'Operation not permitted',
      );
      expect(JSON.stringify(outputs.get('call_2'))).toContain(
        'Operation not permitted',
      );
      expect(
        fs.readFileSync(path.join(workspace, 'output/shell.txt'), 'utf8'),
      ).toBe('allowed-shell');
      expect(
        fs.readFileSync(path.join(workspace, 'output/patch.txt'), 'utf8'),
      ).toBe('allowed-patch\n');
      expect(fs.readFileSync(auth, 'utf8')).toBe(synthetic);
      expect(fs.readFileSync(authSource, 'utf8')).toBe(synthetic);
      expect(fs.readFileSync(outside, 'utf8')).toBe('synthetic-outside-file');
      expect(fs.readFileSync(config)).toEqual(configBefore);
      const discovery = outputJson(outputs.get('call_4'));
      expect(Object.values(discovery.globals as object)).toEqual(
        Array(4).fill('undefined'),
      );
      expect(Object.values(discovery.imports as object)).toEqual(
        Array(4).fill('unsupported import in exec'),
      );
      expect(JSON.parse(discovery.resources as string)).toEqual({
        resources: [],
      });
      expect(discovery.hidden).toEqual({
        spawn: 'undefined',
        image: 'undefined',
        browser: 'undefined',
      });
      expect((discovery.tools as string[]).slice().sort()).toEqual([
        'apply_patch',
        'clock__curr_time',
        'create_goal',
        'exec_command',
        'get_goal',
        'list_mcp_resource_templates',
        'list_mcp_resources',
        'read_mcp_resource',
        'update_goal',
        'write_stdin',
      ]);
      expect(outputs.get('spawn')).toBe('unsupported call: spawn_agent');
      expect(JSON.stringify(outputs.get('escalation'))).toContain(
        'approval policy is Never; reject command',
      );
    } finally {
      network.close();
      if (provider) {
        provider.closeAllConnections();
        await new Promise<void>((resolve) => provider!.close(() => resolve()));
      }
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(shared, { recursive: true, force: true });
    }
  },
  30_000,
);
