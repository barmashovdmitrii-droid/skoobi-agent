import fs from 'fs';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  BonsaiLocalImageGateway,
  ComfyLocalImageGateway,
  createImageGateway,
  ImageGatewayError,
  type ImageGatewayCommandRunner,
  PollinationsImageGateway,
  cleanImagePrompt,
  loadImageGatewayConfig,
} from './image-gateway.js';

const tempRoots: string[] = [];
const originalEnvFile = process.env.CLAUDECLAW_ENV_FILE;

function tempRoot(): string {
  const root = fs.mkdtempSync(
    path.join(process.env.TMPDIR || '/tmp', 'image-gateway-test-'),
  );
  tempRoots.push(root);
  return root;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
  if (originalEnvFile === undefined) delete process.env.CLAUDECLAW_ENV_FILE;
  else process.env.CLAUDECLAW_ENV_FILE = originalEnvFile;
});

beforeEach(() => {
  process.env.CLAUDECLAW_ENV_FILE = path.join(
    process.env.TMPDIR || '/tmp',
    'skoobi-image-gateway-test-empty.env',
  );
});

// A valid 8-byte PNG signature. The gateway now sniffs magic bytes (#52), so a
// "good" image response must carry a real raster signature, not placeholder
// bytes.
const PNG_SIGNATURE = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

function imageResponse(bytes = PNG_SIGNATURE): Response {
  return {
    ok: true,
    status: 200,
    headers: new Headers({ 'content-type': 'image/png' }),
    arrayBuffer: async () => bytes.buffer.slice(0, bytes.byteLength),
  } as Response;
}

// A response that advertises an oversized body via Content-Length. The body
// itself must never be read: arrayBuffer/getReader are spies that prove the
// gateway short-circuits before pulling a single byte.
function oversizedContentLengthResponse(declaredBytes: number): {
  response: Response;
  arrayBuffer: ReturnType<typeof vi.fn>;
  getReader: ReturnType<typeof vi.fn>;
} {
  const arrayBuffer = vi.fn(async () => new Uint8Array(declaredBytes).buffer);
  const getReader = vi.fn();
  const response = {
    ok: true,
    status: 200,
    headers: new Headers({
      'content-type': 'image/png',
      'content-length': String(declaredBytes),
    }),
    arrayBuffer,
    // body exposes getReader so we can also assert streaming is never started.
    body: { getReader } as unknown as ReadableStream<Uint8Array>,
  } as unknown as Response;
  return { response, arrayBuffer, getReader };
}

// A chunked response with NO Content-Length whose stream yields more than the
// cap. Tracks how many chunks were pulled and whether the reader was cancelled,
// so a test can prove the gateway stops reading once the cap is crossed.
function streamingResponse(chunks: Uint8Array[]): {
  response: Response;
  state: { reads: number; cancelled: boolean };
} {
  const state = { reads: 0, cancelled: false };
  let index = 0;
  const getReader = () => ({
    read: async () => {
      state.reads += 1;
      if (index >= chunks.length) return { done: true, value: undefined };
      const value = chunks[index];
      index += 1;
      return { done: false, value };
    },
    cancel: async () => {
      state.cancelled = true;
    },
  });
  const response = {
    ok: true,
    status: 200,
    // No content-length header on purpose (chunked transfer).
    headers: new Headers({ 'content-type': 'image/png' }),
    arrayBuffer: async () => {
      throw new Error('arrayBuffer must not be used for a streamed body');
    },
    body: { getReader } as unknown as ReadableStream<Uint8Array>,
  } as unknown as Response;
  return { response, state };
}

describe('ImageGateway config', () => {
  it('loads safe Pollinations defaults without requiring secrets', () => {
    const config = loadImageGatewayConfig({
      provider: 'pollinations',
      outputRoot: tempRoot(),
    });

    expect(config.enabled).toBe(true);
    expect(config.provider).toBe('pollinations');
    expect(config.baseUrl).toBe('https://image.pollinations.ai/prompt');
    expect(config.model).toBe('flux');
    expect(config.width).toBe(1024);
    expect(config.height).toBe(1024);
    expect(config.apiKey).toBe('');
  });

  it('bounds prompt text before sending it to an image provider', () => {
    expect(cleanImagePrompt('  кот\n\nв космосе  ', 200)).toBe('кот в космосе');
    expect(cleanImagePrompt('a'.repeat(200), 40)).toHaveLength(40);
  });

  it('loads local Bonsai MLX provider config without API keys', () => {
    const root = tempRoot();
    const config = loadImageGatewayConfig({
      enabled: true,
      provider: 'bonsai_mlx',
      outputRoot: root,
      bonsaiDemoDir: path.join(root, 'Bonsai-Image-Demo'),
      bonsaiPython: path.join(root, 'Bonsai-Image-Demo/.venv/bin/python'),
      width: 512,
      height: 512,
      bonsaiSteps: 4,
    });

    expect(config.provider).toBe('bonsai_mlx');
    expect(config.apiKey).toBe('');
    expect(config.bonsaiModel).toBe('binary-mlx');
    expect(config.bonsaiSteps).toBe(4);
    expect(config.width).toBe(512);
    expect(config.height).toBe(512);
  });

  it('loads local ComfyUI provider config without API keys', () => {
    const root = tempRoot();
    const config = loadImageGatewayConfig({
      enabled: true,
      provider: 'comfyui_local',
      outputRoot: root,
      comfyBaseUrl: 'http://127.0.0.1:8188/',
      comfyWorkflowPath: path.join(root, 'workflow.json'),
      comfyModel: 'flux2-klein-4b',
      width: 1024,
      height: 1024,
      comfySteps: 4,
    });

    expect(config.provider).toBe('comfyui_local');
    expect(config.apiKey).toBe('');
    expect(config.comfyBaseUrl).toBe('http://127.0.0.1:8188');
    expect(config.comfyModel).toBe('flux2-klein-4b');
    expect(config.comfySteps).toBe(4);
  });
});

describe('PollinationsImageGateway', () => {
  it('downloads an image to a tenant-scoped output directory', async () => {
    const outputDir = tempRoot();
    const fetchImpl = vi.fn().mockResolvedValue(imageResponse());
    const gateway = new PollinationsImageGateway(
      {
        enabled: true,
        outputRoot: outputDir,
        model: 'flux',
        width: 768,
        height: 768,
        timeoutMs: 1000,
      },
      fetchImpl as unknown as typeof fetch,
    );

    const result = await gateway.generate({
      prompt: 'чёрный пёс в стиле стикера',
      outputDir,
      sessionId: 'tg_chat_test',
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const requestUrl = new URL(fetchImpl.mock.calls[0][0]);
    expect(requestUrl.origin).toBe('https://image.pollinations.ai');
    expect(requestUrl.pathname).toContain('/prompt/');
    expect(requestUrl.searchParams.get('model')).toBe('flux');
    expect(requestUrl.searchParams.get('width')).toBe('768');
    expect(requestUrl.searchParams.get('height')).toBe('768');
    expect(requestUrl.searchParams.has('key')).toBe(false);
    expect(result.provider).toBe('pollinations');
    expect(result.model).toBe('flux');
    expect(result.contentType).toBe('image/png');
    expect(result.filePath.startsWith(outputDir)).toBe(true);
    expect(path.basename(result.filePath)).toContain('tg_chat_test');
    expect(fs.existsSync(result.filePath)).toBe(true);
    expect(fs.statSync(result.filePath).size).toBe(8);
  });

  it('classifies non-image provider responses as invalid output', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      arrayBuffer: async () => new Uint8Array([123]).buffer,
    } as Response);
    const gateway = new PollinationsImageGateway(
      {
        enabled: true,
        outputRoot: tempRoot(),
      },
      fetchImpl as unknown as typeof fetch,
    );

    await expect(gateway.generate({ prompt: 'кот' })).rejects.toMatchObject({
      name: 'ImageGatewayError',
      classification: 'invalid_output',
    } satisfies Partial<ImageGatewayError>);
  });

  it('does not log or require a provider key for basic public usage', async () => {
    const outputDir = tempRoot();
    const fetchImpl = vi.fn().mockResolvedValue(imageResponse());
    const gateway = new PollinationsImageGateway(
      {
        enabled: true,
        outputRoot: outputDir,
        apiKey: '',
      },
      fetchImpl as unknown as typeof fetch,
    );

    await gateway.generate({ prompt: 'robot bee' });

    expect(fetchImpl.mock.calls[0][0]).not.toContain('key=');
  });

  it('sends the provider API key as an Authorization header, never in the URL (#51)', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(imageResponse());
    const gateway = new PollinationsImageGateway(
      {
        enabled: true,
        outputRoot: tempRoot(),
        apiKey: 'super-secret-pollinations-key',
      },
      fetchImpl as unknown as typeof fetch,
    );

    await gateway.generate({ prompt: 'кот' });

    // The credential must NOT appear in the request URL (query string), where
    // it could leak into CDN/proxy/access logs.
    const requestUrl = String(fetchImpl.mock.calls[0][0]);
    expect(requestUrl).not.toContain('key=');
    expect(requestUrl).not.toContain('super-secret-pollinations-key');

    // It must travel in an Authorization: Bearer header instead.
    const init = fetchImpl.mock.calls[0][1] as RequestInit;
    const headers = new Headers(init.headers);
    expect(headers.get('authorization')).toBe(
      'Bearer super-secret-pollinations-key',
    );
  });

  it('rejects a non-raster payload that merely claims an image/* content-type (#52)', async () => {
    // SVG is text, advertised as image/svg+xml; it has no raster magic bytes and
    // must be rejected rather than persisted with a .jpg extension.
    const svg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
    );
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'image/svg+xml' }),
      arrayBuffer: async () =>
        svg.buffer.slice(svg.byteOffset, svg.byteOffset + svg.byteLength),
    } as Response);
    const gateway = new PollinationsImageGateway(
      { enabled: true, outputRoot: tempRoot() },
      fetchImpl as unknown as typeof fetch,
    );

    await expect(gateway.generate({ prompt: 'кот' })).rejects.toMatchObject({
      name: 'ImageGatewayError',
      classification: 'invalid_output',
    } satisfies Partial<ImageGatewayError>);
  });

  it('derives extension and content type from sniffed JPEG bytes, not the header (#52)', async () => {
    const outputDir = tempRoot();
    // Real JPEG magic (FF D8 FF) but a lying header claiming PNG.
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'image/png' }),
      arrayBuffer: async () => jpeg.buffer.slice(0, jpeg.byteLength),
    } as Response);
    const gateway = new PollinationsImageGateway(
      { enabled: true, outputRoot: outputDir },
      fetchImpl as unknown as typeof fetch,
    );

    const result = await gateway.generate({ prompt: 'кот' });

    expect(result.contentType).toBe('image/jpeg');
    expect(result.filePath.endsWith('.jpg')).toBe(true);
  });

  it('does not follow provider redirects (SSRF guard)', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(imageResponse());
    const gateway = new PollinationsImageGateway(
      { enabled: true, outputRoot: tempRoot() },
      fetchImpl as unknown as typeof fetch,
    );

    await gateway.generate({ prompt: 'кот' });

    // A compromised/MITM'd Pollinations response must not be able to 302 us to
    // an internal target — the fetch must opt out of redirect-following.
    const init = fetchImpl.mock.calls[0][1] as RequestInit;
    expect(init.redirect).toBe('manual');
  });

  it('rejects up-front on an oversized Content-Length without reading the body', async () => {
    // maxBytes is clamped to a 64 KiB floor; declare well above it.
    const { response, arrayBuffer, getReader } =
      oversizedContentLengthResponse(70_000);
    const fetchImpl = vi.fn().mockResolvedValue(response);
    const gateway = new PollinationsImageGateway(
      { enabled: true, outputRoot: tempRoot(), maxBytes: 64 * 1024 },
      fetchImpl as unknown as typeof fetch,
    );

    await expect(gateway.generate({ prompt: 'кот' })).rejects.toMatchObject({
      name: 'ImageGatewayError',
      classification: 'invalid_output',
    } satisfies Partial<ImageGatewayError>);

    // The whole point: the oversized body is never materialized. Neither
    // arrayBuffer() nor the stream reader is touched, so pulledBytes stays 0.
    expect(arrayBuffer).not.toHaveBeenCalled();
    expect(getReader).not.toHaveBeenCalled();
  });

  it('caps a chunked (no Content-Length) body and stops reading once exceeded', async () => {
    // 64 KiB cap; three 32 KiB chunks => exceeds after the 3rd is read.
    const { response, state } = streamingResponse([
      new Uint8Array(32 * 1024),
      new Uint8Array(32 * 1024),
      new Uint8Array(32 * 1024),
      new Uint8Array(32 * 1024),
    ]);
    const fetchImpl = vi.fn().mockResolvedValue(response);
    const gateway = new PollinationsImageGateway(
      { enabled: true, outputRoot: tempRoot(), maxBytes: 64 * 1024 },
      fetchImpl as unknown as typeof fetch,
    );

    await expect(gateway.generate({ prompt: 'кот' })).rejects.toMatchObject({
      name: 'ImageGatewayError',
      classification: 'invalid_output',
    } satisfies Partial<ImageGatewayError>);

    // Stopped after crossing the cap: only the 3 chunks needed to exceed it
    // were pulled (not the 4th), and the stream was cancelled to stop the flood.
    expect(state.reads).toBe(3);
    expect(state.cancelled).toBe(true);
  });
});

describe('BonsaiLocalImageGateway', () => {
  function makeDemo(root: string): { demoDir: string; python: string } {
    const demoDir = path.join(root, 'Bonsai-Image-Demo');
    const scriptsDir = path.join(demoDir, 'scripts');
    const binDir = path.join(demoDir, '.venv', 'bin');
    fs.mkdirSync(scriptsDir, { recursive: true });
    fs.mkdirSync(binDir, { recursive: true });
    const script = path.join(scriptsDir, 'generate.py');
    const python = path.join(binDir, 'python');
    fs.writeFileSync(script, '# fake generate.py\n');
    fs.writeFileSync(python, '# fake python\n');
    return { demoDir, python };
  }

  it('runs Bonsai in its demo directory and copies a PNG from scratch output', async () => {
    const root = tempRoot();
    const outputDir = path.join(root, 'tenant', 'generated', 'images');
    const { demoDir, python } = makeDemo(root);
    const calls: Parameters<ImageGatewayCommandRunner>[0][] = [];
    const runner: ImageGatewayCommandRunner = async (input) => {
      calls.push(input);
      const output = input.args[input.args.indexOf('--output') + 1];
      fs.mkdirSync(path.dirname(output), { recursive: true });
      fs.writeFileSync(output, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      return {
        code: 0,
        signal: null,
        stdout: '',
        stderr: '',
        durationMs: 25,
        timedOut: false,
      };
    };
    const gateway = new BonsaiLocalImageGateway(
      {
        enabled: true,
        outputRoot: path.join(root, 'tmp', 'images'),
        bonsaiDemoDir: demoDir,
        bonsaiPython: python,
        model: 'bonsai-image-binary-4B-mlx-1bit',
        width: 512,
        height: 512,
        timeoutMs: 1000,
        bonsaiSteps: 4,
      },
      runner,
    );

    const result = await gateway.generate({
      prompt: 'чёрный пёс в стиле стикера',
      outputDir,
      sessionId: 'tg_chat_test',
    });

    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call.command).toBe(python);
    expect(call.cwd).toBe(demoDir);
    expect(call.args).toContain(path.join(demoDir, 'scripts', 'generate.py'));
    expect(call.args).toContain('--model');
    expect(call.args).toContain('binary-mlx');
    expect(call.args).toContain('--size');
    expect(call.args).toContain('512x512');
    expect(call.args).toContain('--steps');
    expect(call.args).toContain('4');
    expect(call.args.join('\n')).not.toContain(outputDir);
    expect(result.provider).toBe('bonsai_mlx');
    expect(result.contentType).toBe('image/png');
    expect(result.model).toBe('binary-mlx:4steps');
    expect(result.filePath.startsWith(outputDir)).toBe(true);
    expect(fs.existsSync(result.filePath)).toBe(true);
    expect(fs.statSync(result.filePath).size).toBe(4);
  });

  it('passes a minimal process environment without bot/provider secrets', async () => {
    const root = tempRoot();
    const { demoDir, python } = makeDemo(root);
    const oldToken = process.env.TELEGRAM_BOT_TOKEN;
    const oldApiKey = process.env.OPENAI_API_KEY;
    process.env.TELEGRAM_BOT_TOKEN = 'secret-telegram-token';
    process.env.OPENAI_API_KEY = 'secret-openai-key';
    try {
      let capturedEnv: NodeJS.ProcessEnv = {};
      const runner: ImageGatewayCommandRunner = async (input) => {
        capturedEnv = input.env;
        const output = input.args[input.args.indexOf('--output') + 1];
        fs.mkdirSync(path.dirname(output), { recursive: true });
        fs.writeFileSync(output, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
        return {
          code: 0,
          signal: null,
          stdout: '',
          stderr: '',
          durationMs: 25,
          timedOut: false,
        };
      };
      const gateway = new BonsaiLocalImageGateway(
        {
          enabled: true,
          outputRoot: path.join(root, 'tmp'),
          bonsaiDemoDir: demoDir,
          bonsaiPython: python,
          bonsaiDeveloperDir: '/Applications/Xcode.app/Contents/Developer',
        },
        runner,
      );

      await gateway.generate({
        prompt: 'кот',
        outputDir: path.join(root, 'out'),
      });

      expect(capturedEnv.DEVELOPER_DIR).toBe(
        '/Applications/Xcode.app/Contents/Developer',
      );
      expect(capturedEnv.TELEGRAM_BOT_TOKEN).toBeUndefined();
      expect(capturedEnv.OPENAI_API_KEY).toBeUndefined();
    } finally {
      if (oldToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
      else process.env.TELEGRAM_BOT_TOKEN = oldToken;
      if (oldApiKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = oldApiKey;
    }
  });

  it('serializes Bonsai generations to avoid concurrent local MLX runs', async () => {
    const root = tempRoot();
    const { demoDir, python } = makeDemo(root);
    let active = 0;
    let maxActive = 0;
    const runner: ImageGatewayCommandRunner = async (input) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 20));
      const output = input.args[input.args.indexOf('--output') + 1];
      fs.mkdirSync(path.dirname(output), { recursive: true });
      fs.writeFileSync(output, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      active -= 1;
      return {
        code: 0,
        signal: null,
        stdout: '',
        stderr: '',
        durationMs: 20,
        timedOut: false,
      };
    };
    const gateway = new BonsaiLocalImageGateway(
      {
        enabled: true,
        outputRoot: path.join(root, 'tmp'),
        bonsaiDemoDir: demoDir,
        bonsaiPython: python,
      },
      runner,
    );

    await Promise.all([
      gateway.generate({ prompt: 'кот 1', outputDir: path.join(root, 'out') }),
      gateway.generate({ prompt: 'кот 2', outputDir: path.join(root, 'out') }),
    ]);

    expect(maxActive).toBe(1);
  });

  it('fast-fails an oversized cross-tenant local queue backlog as busy (#53)', async () => {
    const root = tempRoot();
    const { demoDir, python } = makeDemo(root);

    // The runner blocks until released so the queue stays saturated while we
    // pile on more jobs than the bounded depth allows.
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runner: ImageGatewayCommandRunner = async (input) => {
      await gate;
      const output = input.args[input.args.indexOf('--output') + 1];
      fs.mkdirSync(path.dirname(output), { recursive: true });
      fs.writeFileSync(output, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      return {
        code: 0,
        signal: null,
        stdout: '',
        stderr: '',
        durationMs: 1,
        timedOut: false,
      };
    };
    const gateway = new BonsaiLocalImageGateway(
      {
        enabled: true,
        outputRoot: path.join(root, 'tmp'),
        bonsaiDemoDir: demoDir,
        bonsaiPython: python,
      },
      runner,
    );

    // Fire far more concurrent generations than the bounded queue depth
    // (default 8). The overflow is rejected synchronously (at queue-admission
    // time) as 'unavailable' instead of waiting behind the whole backlog. The
    // depth cap is evaluated when each generate() call is invoked, so all
    // rejections are decided here, before the gate is released.
    const attempts = Array.from({ length: 40 }, (_unused, i) =>
      gateway.generate({ prompt: `кот ${i}`, outputDir: path.join(root, 'out') }),
    );

    // Release the gate so the admitted (queued) jobs can drain; then collect.
    release();
    const settled = await Promise.allSettled(attempts);

    const busy = settled.filter(
      (r) =>
        r.status === 'rejected' &&
        (r.reason as ImageGatewayError)?.name === 'ImageGatewayError' &&
        (r.reason as ImageGatewayError)?.classification === 'unavailable',
    );
    // Some attempts beyond the depth bound were rejected as busy rather than
    // serialized behind the entire backlog.
    expect(busy.length).toBeGreaterThan(0);
  });

  it('classifies missing Bonsai demo as unavailable', async () => {
    const root = tempRoot();
    const gateway = new BonsaiLocalImageGateway({
      enabled: true,
      outputRoot: path.join(root, 'tmp'),
      bonsaiDemoDir: path.join(root, 'missing-demo'),
      bonsaiPython: path.join(root, 'missing-python'),
    });

    await expect(gateway.generate({ prompt: 'кот' })).rejects.toMatchObject({
      name: 'ImageGatewayError',
      classification: 'unavailable',
    } satisfies Partial<ImageGatewayError>);
  });

  it('fails safely on Bonsai timeout', async () => {
    const root = tempRoot();
    const { demoDir, python } = makeDemo(root);
    const runner: ImageGatewayCommandRunner = async () => ({
      code: null,
      signal: 'SIGTERM',
      stdout: '',
      stderr: '',
      durationMs: 1000,
      timedOut: true,
    });
    const gateway = new BonsaiLocalImageGateway(
      {
        enabled: true,
        outputRoot: path.join(root, 'tmp'),
        bonsaiDemoDir: demoDir,
        bonsaiPython: python,
        timeoutMs: 10,
      },
      runner,
    );

    await expect(gateway.generate({ prompt: 'кот' })).rejects.toMatchObject({
      name: 'ImageGatewayError',
      classification: 'timeout',
    } satisfies Partial<ImageGatewayError>);
  });

  it('createImageGateway selects Bonsai provider from config', () => {
    const root = tempRoot();
    const gateway = createImageGateway({
      enabled: true,
      provider: 'bonsai_mlx',
      outputRoot: root,
      bonsaiDemoDir: path.join(root, 'demo'),
    });

    expect(gateway.provider).toBe('bonsai_mlx');
  });
});

describe('ComfyLocalImageGateway', () => {
  function writeWorkflow(root: string): string {
    const workflowPath = path.join(root, 'workflow.json');
    fs.writeFileSync(
      workflowPath,
      JSON.stringify({
        '1': {
          class_type: 'CLIPTextEncode',
          inputs: {
            text: '__SKOOBI_PROMPT__',
          },
        },
        '2': {
          class_type: 'EmptyLatentImage',
          inputs: {
            width: '__SKOOBI_WIDTH__',
            height: '__SKOOBI_HEIGHT__',
          },
        },
        '3': {
          class_type: 'KSampler',
          inputs: {
            seed: '__SKOOBI_SEED__',
            steps: '__SKOOBI_STEPS__',
          },
        },
      }),
    );
    return workflowPath;
  }

  it('queues a placeholder workflow, polls history, and downloads the output image', async () => {
    const root = tempRoot();
    const outputDir = path.join(root, 'tenant', 'generated', 'images');
    const workflowPath = writeWorkflow(root);
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      const parsed = new URL(String(url));
      if (parsed.pathname === '/prompt') {
        const body = JSON.parse(String(init?.body));
        expect(body.prompt['1'].inputs.text).toBe('чёрный пёс');
        expect(body.prompt['2'].inputs.width).toBe(768);
        expect(body.prompt['2'].inputs.height).toBe(512);
        expect(body.prompt['3'].inputs.steps).toBe(4);
        return new Response(JSON.stringify({ prompt_id: 'prompt-1' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (parsed.pathname === '/history/prompt-1') {
        return new Response(
          JSON.stringify({
            'prompt-1': {
              outputs: {
                '9': {
                  images: [
                    {
                      filename: 'ComfyUI_00001_.png',
                      subfolder: '',
                      type: 'output',
                    },
                  ],
                },
              },
            },
          }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        );
      }
      if (parsed.pathname === '/view') {
        expect(parsed.searchParams.get('filename')).toBe('ComfyUI_00001_.png');
        return imageResponse();
      }
      return new Response('not found', { status: 404 });
    });

    const gateway = new ComfyLocalImageGateway(
      {
        enabled: true,
        outputRoot: path.join(root, 'tmp'),
        comfyBaseUrl: 'http://127.0.0.1:8188',
        comfyWorkflowPath: workflowPath,
        comfyModel: 'flux2-klein-4b',
        width: 768,
        height: 512,
        comfySteps: 4,
        timeoutMs: 1000,
        comfyPollIntervalMs: 10,
      },
      fetchImpl as unknown as typeof fetch,
    );

    const result = await gateway.generate({
      prompt: 'чёрный пёс',
      outputDir,
      sessionId: 'tg_chat_test',
    });

    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(calls[0].url).toBe('http://127.0.0.1:8188/prompt');
    expect(result.provider).toBe('comfyui_local');
    expect(result.model).toBe('flux2-klein-4b:4steps');
    expect(result.contentType).toBe('image/png');
    expect(result.filePath.startsWith(outputDir)).toBe(true);
    expect(fs.existsSync(result.filePath)).toBe(true);
    expect(fs.statSync(result.filePath).size).toBe(8);
  });

  it('classifies a missing workflow as unavailable', async () => {
    const root = tempRoot();
    const gateway = new ComfyLocalImageGateway({
      enabled: true,
      outputRoot: path.join(root, 'tmp'),
      comfyWorkflowPath: path.join(root, 'missing.json'),
    });

    await expect(gateway.generate({ prompt: 'кот' })).rejects.toMatchObject({
      name: 'ImageGatewayError',
      classification: 'unavailable',
    } satisfies Partial<ImageGatewayError>);
  });

  it('classifies ComfyUI execution errors without waiting for timeout', async () => {
    const root = tempRoot();
    const workflowPath = writeWorkflow(root);
    const fetchImpl = vi.fn(async (url: string | URL) => {
      const parsed = new URL(String(url));
      if (parsed.pathname === '/prompt') {
        return new Response(JSON.stringify({ prompt_id: 'prompt-err' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (parsed.pathname === '/history/prompt-err') {
        return new Response(
          JSON.stringify({
            'prompt-err': {
              status: {
                status_str: 'error',
                completed: false,
                messages: [
                  [
                    'execution_error',
                    {
                      exception_message:
                        'Trying to convert Float8_e4m3fn to the MPS backend',
                    },
                  ],
                ],
              },
              outputs: {},
            },
          }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        );
      }
      return new Response('not found', { status: 404 });
    });
    const gateway = new ComfyLocalImageGateway(
      {
        enabled: true,
        outputRoot: path.join(root, 'tmp'),
        comfyWorkflowPath: workflowPath,
        timeoutMs: 1000,
        comfyPollIntervalMs: 100,
      },
      fetchImpl as unknown as typeof fetch,
    );

    await expect(gateway.generate({ prompt: 'кот' })).rejects.toMatchObject({
      name: 'ImageGatewayError',
      classification: 'provider_error',
      message: expect.stringContaining('Float8_e4m3fn'),
    } satisfies Partial<ImageGatewayError>);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('does not follow ComfyUI redirects and caps the downloaded image (SSRF + DoS guards)', async () => {
    const root = tempRoot();
    const workflowPath = writeWorkflow(root);
    let viewArrayBufferCalled = false;
    const fetchImpl = vi.fn(async (url: string | URL) => {
      const parsed = new URL(String(url));
      if (parsed.pathname === '/prompt') {
        return new Response(JSON.stringify({ prompt_id: 'prompt-1' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (parsed.pathname === '/history/prompt-1') {
        return new Response(
          JSON.stringify({
            'prompt-1': {
              outputs: {
                '9': {
                  images: [
                    { filename: 'ComfyUI_00001_.png', subfolder: '', type: 'output' },
                  ],
                },
              },
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (parsed.pathname === '/view') {
        // Advertise an oversized body via Content-Length; the gateway must
        // reject before reading it.
        return {
          ok: true,
          status: 200,
          headers: new Headers({
            'content-type': 'image/png',
            'content-length': '70000',
          }),
          arrayBuffer: async () => {
            viewArrayBufferCalled = true;
            return new Uint8Array(70_000).buffer;
          },
        } as unknown as Response;
      }
      return new Response('not found', { status: 404 });
    });

    const gateway = new ComfyLocalImageGateway(
      {
        enabled: true,
        outputRoot: path.join(root, 'tmp'),
        comfyWorkflowPath: workflowPath,
        maxBytes: 64 * 1024,
        timeoutMs: 1000,
        comfyPollIntervalMs: 10,
      },
      fetchImpl as unknown as typeof fetch,
    );

    await expect(gateway.generate({ prompt: 'кот' })).rejects.toMatchObject({
      name: 'ImageGatewayError',
      classification: 'invalid_output',
    } satisfies Partial<ImageGatewayError>);

    // Oversized /view body is rejected up-front, never materialized.
    expect(viewArrayBufferCalled).toBe(false);
    // Every ComfyUI fetch opted out of redirect-following.
    for (const call of fetchImpl.mock.calls) {
      const init = (call as unknown[])[1] as RequestInit;
      expect(init.redirect).toBe('manual');
    }
  });

  it('createImageGateway selects ComfyUI provider from config', () => {
    const root = tempRoot();
    const gateway = createImageGateway({
      enabled: true,
      provider: 'comfyui_local',
      outputRoot: root,
      comfyWorkflowPath: path.join(root, 'workflow.json'),
    });

    expect(gateway.provider).toBe('comfyui_local');
  });
});
