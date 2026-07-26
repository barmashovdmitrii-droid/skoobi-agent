import { createHash, randomUUID } from 'crypto';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

import { readEnvFile } from '@skoobi/shared';

// STATE_ROOT here has always been the service working directory (the
// orchestrator config exports process.cwd()); keep the same semantics
// without dragging core config into the providers brick.
const STATE_ROOT = process.cwd();

export type ImageGatewayProvider =
  | 'pollinations'
  | 'bonsai_mlx'
  | 'comfyui_local';

export interface ImageGatewayConfig {
  enabled: boolean;
  provider: ImageGatewayProvider;
  baseUrl: string;
  apiKey?: string;
  model: string;
  width: number;
  height: number;
  timeoutMs: number;
  maxPromptChars: number;
  maxBytes: number;
  outputRoot: string;
  bonsaiDemoDir: string;
  bonsaiPython: string;
  bonsaiModel: string;
  bonsaiSteps: number;
  bonsaiSeed?: number;
  bonsaiDeveloperDir: string;
  bonsaiMaxOutputBytes: number;
  comfyBaseUrl: string;
  comfyWorkflowPath: string;
  comfyModel: string;
  comfySteps: number;
  comfySeed?: number;
  comfyNegativePrompt: string;
  comfyPollIntervalMs: number;
}

export interface ImageGenerationResult {
  provider: ImageGatewayProvider;
  model: string;
  promptHash: string;
  filePath: string;
  contentType: string;
  bytes: number;
  width: number;
  height: number;
  generatedAt: string;
}

export class ImageGatewayError extends Error {
  readonly classification:
    | 'disabled'
    | 'timeout'
    | 'unavailable'
    | 'provider_error'
    | 'empty_output'
    | 'invalid_output'
    | 'runtime_error';

  constructor(
    message: string,
    classification: ImageGatewayError['classification'],
  ) {
    super(message);
    this.name = 'ImageGatewayError';
    this.classification = classification;
  }
}

type FetchLike = typeof fetch;

export interface ImageGateway {
  readonly provider: ImageGatewayProvider;
  generate(input: {
    prompt: string;
    outputDir?: string;
    sessionId?: string;
  }): Promise<ImageGenerationResult>;
}

export interface ImageGatewayCommandRunnerInput {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  maxOutputBytes: number;
}

export interface ImageGatewayCommandRunnerResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
}

export type ImageGatewayCommandRunner = (
  input: ImageGatewayCommandRunnerInput,
) => Promise<ImageGatewayCommandRunnerResult>;

/**
 * Finding #53: the local providers (bonsai_mlx / comfyui_local) must serialize
 * GPU work, but the underlying serial queue was an UNBOUNDED, process-global
 * promise chain shared across every tenant. One tenant queuing slow/never-
 * finishing generations could pile up an arbitrarily long backlog, making every
 * other tenant wait through multiples of the full per-job timeout (a cross-
 * tenant noisy-neighbor availability hit).
 *
 * A SerialJobQueue keeps the single-flight serialization (one job runs at a
 * time) but BOUNDS how many jobs may be in-flight-or-waiting. When the queue is
 * already at capacity a new job fast-fails with a "busy, try later" error
 * instead of being enqueued behind the backlog, so a flood degrades to quick
 * rejections rather than blocking all tenants for the full timeout.
 */
class SerialJobQueue {
  private tail: Promise<void> = Promise.resolve();
  // Count of jobs currently running or waiting for the lock.
  private depth = 0;

  constructor(private readonly maxDepth: number) {}

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.depth >= this.maxDepth) {
      throw new ImageGatewayError(
        'Local image generation is busy; please try again shortly',
        'unavailable',
      );
    }
    this.depth += 1;
    const previous = this.tail;
    let release: () => void = () => {};
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.tail = previous.catch(() => undefined).then(() => current);
    try {
      await previous.catch(() => undefined);
      return await task();
    } finally {
      this.depth -= 1;
      release();
    }
  }
}

// Bound the cross-tenant backlog for each local provider. Default keeps a small
// number of queued jobs (one running + a few waiting) and rejects beyond that.
const LOCAL_IMAGE_QUEUE_MAX_DEPTH = clampInteger(
  Number(process.env.SKOOBI_IMAGE_LOCAL_QUEUE_MAX_DEPTH ?? 8),
  1,
  64,
);

const bonsaiQueue = new SerialJobQueue(LOCAL_IMAGE_QUEUE_MAX_DEPTH);
const comfyQueue = new SerialJobQueue(LOCAL_IMAGE_QUEUE_MAX_DEPTH);

function runBonsaiExclusive<T>(task: () => Promise<T>): Promise<T> {
  return bonsaiQueue.run(task);
}

function runComfyExclusive<T>(task: () => Promise<T>): Promise<T> {
  return comfyQueue.run(task);
}

function boolFrom(value: unknown, fallback: boolean): boolean {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

function numberFrom(value: unknown, fallback: number): number {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function stringFrom(value: unknown, fallback = ''): string {
  if (value === undefined || value === null || value === '') return fallback;
  return String(value);
}

function clampInteger(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

function optionalInteger(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : undefined;
}

function normalizeBaseUrl(value: string): string {
  return value.replace(/\/+$/, '');
}

export function hashImagePrompt(prompt: string): string {
  return createHash('sha256').update(prompt).digest('hex');
}

export function cleanImagePrompt(prompt: string, maxChars: number): string {
  return prompt.replace(/\s+/g, ' ').trim().slice(0, maxChars).trim();
}

/**
 * Finding #52: confirm a downloaded body is a real, supported RASTER image by
 * sniffing its magic bytes, rather than trusting the provider's Content-Type
 * header. A hostile/MITM'd provider could claim any `image/*` Content-Type
 * (e.g. `image/svg+xml`) and have a scriptable/non-raster payload persisted and
 * forwarded as a tenant "photo". By deriving the format from the bytes we both
 * reject mismatched payloads (including SVG, which has no fixed binary magic and
 * therefore never matches) and pick the file extension / stored content-type
 * from the verified format instead of attacker-controlled headers.
 *
 * Returns null when the leading bytes do not match a supported raster signature.
 */
function sniffRasterImage(
  bytes: Buffer,
): { contentType: string; ext: string } | null {
  // JPEG: FF D8 FF
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { contentType: 'image/jpeg', ext: '.jpg' };
  }
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return { contentType: 'image/png', ext: '.png' };
  }
  // GIF: "GIF87a" / "GIF89a"
  if (
    bytes.length >= 6 &&
    bytes[0] === 0x47 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x38 &&
    (bytes[4] === 0x37 || bytes[4] === 0x39) &&
    bytes[5] === 0x61
  ) {
    return { contentType: 'image/gif', ext: '.gif' };
  }
  // WebP: "RIFF" .... "WEBP"
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return { contentType: 'image/webp', ext: '.webp' };
  }
  return null;
}

/**
 * Read a fetch Response body into a Buffer without ever buffering more than
 * `maxBytes`. The upstream providers (Pollinations over the public internet,
 * the local ComfyUI /view endpoint) are untrusted relative to this
 * multi-tenant host, so a hostile/compromised/MITM'd response must not be able
 * to exhaust process memory via `response.arrayBuffer()`.
 *
 * Mirrors the webhook server's body cap: reject up-front when the declared
 * Content-Length already exceeds the cap (so no body bytes are pulled), then
 * enforce the cap as bytes arrive in case Content-Length lied or was absent
 * (chunked transfer), cancelling the stream the moment the cap is crossed.
 */
async function readResponseBodyWithCap(
  response: Response,
  maxBytes: number,
  oversizedMessage: string,
): Promise<Buffer> {
  const oversized = () =>
    new ImageGatewayError(oversizedMessage, 'invalid_output');

  // Up-front rejection: if the provider advertises an oversized body, throw
  // before touching the body so `arrayBuffer()`/streaming never runs and no
  // bytes are read.
  const contentLengthHeader = response.headers.get('content-length');
  if (contentLengthHeader !== null && contentLengthHeader.trim() !== '') {
    const declared = Number(contentLengthHeader);
    if (Number.isFinite(declared) && declared > maxBytes) {
      throw oversized();
    }
  }

  const body = response.body as
    | ReadableStream<Uint8Array>
    | null
    | undefined;
  // Some runtimes / test doubles only expose arrayBuffer(); fall back to it but
  // still enforce the cap after reading.
  if (!body || typeof body.getReader !== 'function') {
    const buffered = Buffer.from(await response.arrayBuffer());
    if (buffered.length > maxBytes) throw oversized();
    return buffered;
  }

  const reader = body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      const chunk = Buffer.from(value);
      total += chunk.length;
      if (total > maxBytes) throw oversized();
      chunks.push(chunk);
    }
  } finally {
    // Best-effort: stop pulling bytes from a hostile/oversized stream. Must not
    // mask the original error (e.g. the oversized throw above).
    try {
      await reader.cancel();
    } catch {
      /* ignore */
    }
  }
  return Buffer.concat(chunks, total);
}

export function loadImageGatewayConfig(
  overrides: Partial<ImageGatewayConfig> = {},
): ImageGatewayConfig {
  const env = readEnvFile([
    'SKOOBI_IMAGE_GENERATION_ENABLED',
    'SKOOBI_IMAGE_GENERATION_PROVIDER',
    'SKOOBI_IMAGE_GENERATION_BASE_URL',
    'SKOOBI_IMAGE_GENERATION_API_KEY',
    'SKOOBI_IMAGE_GENERATION_MODEL',
    'SKOOBI_IMAGE_GENERATION_WIDTH',
    'SKOOBI_IMAGE_GENERATION_HEIGHT',
    'SKOOBI_IMAGE_GENERATION_TIMEOUT_MS',
    'SKOOBI_IMAGE_GENERATION_MAX_PROMPT_CHARS',
    'SKOOBI_IMAGE_GENERATION_MAX_BYTES',
    'SKOOBI_IMAGE_GENERATION_OUTPUT_ROOT',
    'SKOOBI_BONSAI_DEMO_DIR',
    'SKOOBI_BONSAI_PYTHON',
    'SKOOBI_BONSAI_MODEL',
    'SKOOBI_BONSAI_STEPS',
    'SKOOBI_BONSAI_SEED',
    'SKOOBI_BONSAI_DEVELOPER_DIR',
    'SKOOBI_BONSAI_MAX_OUTPUT_BYTES',
    'SKOOBI_COMFYUI_BASE_URL',
    'SKOOBI_COMFYUI_WORKFLOW_PATH',
    'SKOOBI_COMFYUI_MODEL',
    'SKOOBI_COMFYUI_STEPS',
    'SKOOBI_COMFYUI_SEED',
    'SKOOBI_COMFYUI_NEGATIVE_PROMPT',
    'SKOOBI_COMFYUI_POLL_INTERVAL_MS',
    'POLLINATIONS_API_KEY',
  ]);

  const provider = stringFrom(
    overrides.provider ??
      env.SKOOBI_IMAGE_GENERATION_PROVIDER ??
      process.env.SKOOBI_IMAGE_GENERATION_PROVIDER,
    'pollinations',
  ) as ImageGatewayProvider;
  if (
    provider !== 'pollinations' &&
    provider !== 'bonsai_mlx' &&
    provider !== 'comfyui_local'
  ) {
    throw new ImageGatewayError(
      `Unsupported ImageGateway provider: ${provider}`,
      'disabled',
    );
  }

  return {
    enabled: boolFrom(
      overrides.enabled ??
        env.SKOOBI_IMAGE_GENERATION_ENABLED ??
        process.env.SKOOBI_IMAGE_GENERATION_ENABLED,
      true,
    ),
    provider,
    baseUrl: normalizeBaseUrl(
      stringFrom(
        overrides.baseUrl ??
          env.SKOOBI_IMAGE_GENERATION_BASE_URL ??
          process.env.SKOOBI_IMAGE_GENERATION_BASE_URL,
        'https://image.pollinations.ai/prompt',
      ),
    ),
    apiKey: stringFrom(
      overrides.apiKey ??
        env.SKOOBI_IMAGE_GENERATION_API_KEY ??
        env.POLLINATIONS_API_KEY ??
        process.env.SKOOBI_IMAGE_GENERATION_API_KEY ??
        process.env.POLLINATIONS_API_KEY,
    ),
    model: stringFrom(
      overrides.model ??
        env.SKOOBI_IMAGE_GENERATION_MODEL ??
        process.env.SKOOBI_IMAGE_GENERATION_MODEL,
      'flux',
    ),
    width: clampInteger(
      numberFrom(
        overrides.width ??
          env.SKOOBI_IMAGE_GENERATION_WIDTH ??
          process.env.SKOOBI_IMAGE_GENERATION_WIDTH,
        1024,
      ),
      256,
      1280,
    ),
    height: clampInteger(
      numberFrom(
        overrides.height ??
          env.SKOOBI_IMAGE_GENERATION_HEIGHT ??
          process.env.SKOOBI_IMAGE_GENERATION_HEIGHT,
        1024,
      ),
      256,
      1280,
    ),
    timeoutMs: clampInteger(
      numberFrom(
        overrides.timeoutMs ??
          env.SKOOBI_IMAGE_GENERATION_TIMEOUT_MS ??
          process.env.SKOOBI_IMAGE_GENERATION_TIMEOUT_MS,
        120_000,
      ),
      1,
      300_000,
    ),
    maxPromptChars: clampInteger(
      numberFrom(
        overrides.maxPromptChars ??
          env.SKOOBI_IMAGE_GENERATION_MAX_PROMPT_CHARS ??
          process.env.SKOOBI_IMAGE_GENERATION_MAX_PROMPT_CHARS,
        1000,
      ),
      80,
      3000,
    ),
    maxBytes: clampInteger(
      numberFrom(
        overrides.maxBytes ??
          env.SKOOBI_IMAGE_GENERATION_MAX_BYTES ??
          process.env.SKOOBI_IMAGE_GENERATION_MAX_BYTES,
        12 * 1024 * 1024,
      ),
      64 * 1024,
      32 * 1024 * 1024,
    ),
    outputRoot: path.resolve(
      stringFrom(
        overrides.outputRoot ??
          env.SKOOBI_IMAGE_GENERATION_OUTPUT_ROOT ??
          process.env.SKOOBI_IMAGE_GENERATION_OUTPUT_ROOT,
        path.join(STATE_ROOT, 'tmp', 'skoobi-generated-images'),
      ),
    ),
    bonsaiDemoDir: path.resolve(
      stringFrom(
        overrides.bonsaiDemoDir ??
          env.SKOOBI_BONSAI_DEMO_DIR ??
          process.env.SKOOBI_BONSAI_DEMO_DIR,
        '',
      ) || '.',
    ),
    bonsaiPython: stringFrom(
      overrides.bonsaiPython ??
        env.SKOOBI_BONSAI_PYTHON ??
        process.env.SKOOBI_BONSAI_PYTHON,
      '',
    ),
    bonsaiModel: stringFrom(
      overrides.bonsaiModel ??
        env.SKOOBI_BONSAI_MODEL ??
        process.env.SKOOBI_BONSAI_MODEL,
      'binary-mlx',
    ),
    bonsaiSteps: clampInteger(
      numberFrom(
        overrides.bonsaiSteps ??
          env.SKOOBI_BONSAI_STEPS ??
          process.env.SKOOBI_BONSAI_STEPS,
        4,
      ),
      1,
      16,
    ),
    bonsaiSeed: optionalInteger(
      overrides.bonsaiSeed ??
        env.SKOOBI_BONSAI_SEED ??
        process.env.SKOOBI_BONSAI_SEED,
    ),
    bonsaiDeveloperDir: stringFrom(
      overrides.bonsaiDeveloperDir ??
        env.SKOOBI_BONSAI_DEVELOPER_DIR ??
        process.env.SKOOBI_BONSAI_DEVELOPER_DIR,
      '/Applications/Xcode.app/Contents/Developer',
    ),
    bonsaiMaxOutputBytes: clampInteger(
      numberFrom(
        overrides.bonsaiMaxOutputBytes ??
          env.SKOOBI_BONSAI_MAX_OUTPUT_BYTES ??
          process.env.SKOOBI_BONSAI_MAX_OUTPUT_BYTES,
        128 * 1024,
      ),
      1024,
      2 * 1024 * 1024,
    ),
    comfyBaseUrl: normalizeBaseUrl(
      stringFrom(
        overrides.comfyBaseUrl ??
          env.SKOOBI_COMFYUI_BASE_URL ??
          process.env.SKOOBI_COMFYUI_BASE_URL,
        'http://127.0.0.1:8188',
      ),
    ),
    comfyWorkflowPath: path.resolve(
      stringFrom(
        overrides.comfyWorkflowPath ??
          env.SKOOBI_COMFYUI_WORKFLOW_PATH ??
          process.env.SKOOBI_COMFYUI_WORKFLOW_PATH,
        '',
      ) || '.',
    ),
    comfyModel: stringFrom(
      overrides.comfyModel ??
        env.SKOOBI_COMFYUI_MODEL ??
        process.env.SKOOBI_COMFYUI_MODEL,
      'flux2-klein-4b',
    ),
    comfySteps: clampInteger(
      numberFrom(
        overrides.comfySteps ??
          env.SKOOBI_COMFYUI_STEPS ??
          process.env.SKOOBI_COMFYUI_STEPS,
        4,
      ),
      1,
      80,
    ),
    comfySeed: optionalInteger(
      overrides.comfySeed ??
        env.SKOOBI_COMFYUI_SEED ??
        process.env.SKOOBI_COMFYUI_SEED,
    ),
    comfyNegativePrompt: stringFrom(
      overrides.comfyNegativePrompt ??
        env.SKOOBI_COMFYUI_NEGATIVE_PROMPT ??
        process.env.SKOOBI_COMFYUI_NEGATIVE_PROMPT,
      '',
    ),
    comfyPollIntervalMs: clampInteger(
      numberFrom(
        overrides.comfyPollIntervalMs ??
          env.SKOOBI_COMFYUI_POLL_INTERVAL_MS ??
          process.env.SKOOBI_COMFYUI_POLL_INTERVAL_MS,
        1000,
      ),
      100,
      10_000,
    ),
  };
}

function buildPollinationsUrl(
  config: ImageGatewayConfig,
  prompt: string,
): string {
  const encodedPrompt = encodeURIComponent(prompt);
  const base = config.baseUrl;
  const pathname = new URL(base).pathname.replace(/\/+$/, '');
  const url = new URL(
    base.includes('gen.pollinations.ai')
      ? `${base}/image/${encodedPrompt}`
      : pathname.endsWith('/prompt')
        ? `${base}/${encodedPrompt}`
        : `${base}/prompt/${encodedPrompt}`,
  );
  url.searchParams.set('model', config.model);
  url.searchParams.set('width', String(config.width));
  url.searchParams.set('height', String(config.height));
  url.searchParams.set('nologo', 'true');
  // Finding #51: do NOT put the API key in the query string. A credential in a
  // URL can leak into upstream/CDN/proxy access logs and trace output and is
  // not covered by object-field log redaction. The key is sent via an
  // `Authorization: Bearer` header instead (see pollinationsAuthHeaders).
  return url.toString();
}

/**
 * Build the request headers for a Pollinations call. The configured API key is
 * passed as an `Authorization: Bearer` header (Pollinations' supported
 * authenticated contract) rather than as a `?key=` query param, so the
 * credential never appears in the request URL string.
 */
function pollinationsAuthHeaders(
  config: ImageGatewayConfig,
): Record<string, string> {
  if (config.apiKey) {
    return { authorization: `Bearer ${config.apiKey}` };
  }
  return {};
}

export class PollinationsImageGateway implements ImageGateway {
  readonly provider: ImageGatewayProvider;
  private readonly config: ImageGatewayConfig;
  private readonly fetchImpl: FetchLike;

  constructor(
    config: Partial<ImageGatewayConfig> = {},
    fetchImpl: FetchLike = fetch,
  ) {
    this.config = loadImageGatewayConfig({
      ...config,
      provider: 'pollinations',
    });
    this.provider = this.config.provider;
    this.fetchImpl = fetchImpl;
  }

  async generate(input: {
    prompt: string;
    outputDir?: string;
    sessionId?: string;
  }): Promise<ImageGenerationResult> {
    if (!this.config.enabled) {
      throw new ImageGatewayError('ImageGateway is disabled', 'disabled');
    }

    const prompt = cleanImagePrompt(input.prompt, this.config.maxPromptChars);
    if (!prompt) {
      throw new ImageGatewayError(
        'Image generation prompt is empty',
        'empty_output',
      );
    }

    const outputDir = path.resolve(input.outputDir || this.config.outputRoot);
    fs.mkdirSync(outputDir, { recursive: true, mode: 0o700 });

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);
    let response: Awaited<ReturnType<FetchLike>>;
    try {
      response = await this.fetchImpl(
        buildPollinationsUrl(this.config, prompt),
        {
          method: 'GET',
          // Credential travels in an Authorization header, not the URL (#51).
          headers: pollinationsAuthHeaders(this.config),
          signal: controller.signal,
          // Do not follow redirects: the third-party provider must not be able
          // to 302-redirect us to an internal target (loopback ComfyUI,
          // link-local metadata, etc.). A redirect surfaces as a non-ok
          // response below and is rejected as a provider_error.
          redirect: 'manual',
        },
      );
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new ImageGatewayError('Image generation timed out', 'timeout');
      }
      throw new ImageGatewayError(
        'Image generation request failed',
        'runtime_error',
      );
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      throw new ImageGatewayError(
        `Image provider returned HTTP ${response.status}`,
        'provider_error',
      );
    }

    const contentType = response.headers.get('content-type') || 'image/jpeg';
    if (!contentType.toLowerCase().startsWith('image/')) {
      throw new ImageGatewayError(
        'Image provider did not return an image',
        'invalid_output',
      );
    }

    const bytes = await readResponseBodyWithCap(
      response,
      this.config.maxBytes,
      'Image provider returned an oversized image',
    );
    if (bytes.length === 0) {
      throw new ImageGatewayError(
        'Image provider returned an empty image',
        'empty_output',
      );
    }

    // Finding #52: trust the bytes, not the Content-Type header. Reject (e.g.)
    // SVG / HTML-ish payloads that merely claim an `image/*` Content-Type, and
    // derive the extension + stored content type from the sniffed raster format.
    const sniffed = sniffRasterImage(bytes);
    if (!sniffed) {
      throw new ImageGatewayError(
        'Image provider did not return a supported raster image',
        'invalid_output',
      );
    }

    const promptHash = hashImagePrompt(prompt);
    const ext = sniffed.ext;
    const sessionSlug = (input.sessionId || 'image')
      .replace(/[^a-zA-Z0-9_-]+/g, '-')
      .slice(0, 64);
    const filePath = path.join(
      outputDir,
      `${sessionSlug}-${Date.now()}-${randomUUID()}${ext}`,
    );
    fs.writeFileSync(filePath, bytes, { mode: 0o600 });

    return {
      provider: this.config.provider,
      model: this.config.model,
      promptHash,
      filePath,
      contentType: sniffed.contentType,
      bytes: bytes.length,
      width: this.config.width,
      height: this.config.height,
      generatedAt: new Date().toISOString(),
    };
  }
}

type ComfyImageRef = {
  filename: string;
  subfolder?: string;
  type?: string;
};

function replaceComfyWorkflowPlaceholders(
  value: unknown,
  replacements: Record<string, string | number>,
): unknown {
  if (Array.isArray(value)) {
    return value.map((item) =>
      replaceComfyWorkflowPlaceholders(item, replacements),
    );
  }
  if (value && typeof value === 'object') {
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      output[key] = replaceComfyWorkflowPlaceholders(item, replacements);
    }
    return output;
  }
  if (typeof value !== 'string') return value;
  const exact = replacements[value];
  if (exact !== undefined) return exact;
  return Object.entries(replacements).reduce(
    (text, [token, replacement]) => text.replaceAll(token, String(replacement)),
    value,
  );
}

function extractComfyImages(
  history: unknown,
  promptId: string,
): ComfyImageRef[] {
  const root =
    history &&
    typeof history === 'object' &&
    promptId in history &&
    (history as Record<string, unknown>)[promptId]
      ? (history as Record<string, unknown>)[promptId]
      : history;
  const outputs =
    root && typeof root === 'object'
      ? (root as Record<string, unknown>).outputs
      : undefined;
  if (!outputs || typeof outputs !== 'object') return [];

  const images: ComfyImageRef[] = [];
  for (const output of Object.values(outputs)) {
    if (!output || typeof output !== 'object') continue;
    const maybeImages = (output as Record<string, unknown>).images;
    if (!Array.isArray(maybeImages)) continue;
    for (const image of maybeImages) {
      if (!image || typeof image !== 'object') continue;
      const filename = (image as Record<string, unknown>).filename;
      if (typeof filename !== 'string' || !filename) continue;
      images.push({
        filename,
        subfolder:
          typeof (image as Record<string, unknown>).subfolder === 'string'
            ? ((image as Record<string, unknown>).subfolder as string)
            : undefined,
        type:
          typeof (image as Record<string, unknown>).type === 'string'
            ? ((image as Record<string, unknown>).type as string)
            : undefined,
      });
    }
  }
  return images;
}

function extractComfyError(history: unknown, promptId: string): string | null {
  const root =
    history &&
    typeof history === 'object' &&
    promptId in history &&
    (history as Record<string, unknown>)[promptId]
      ? (history as Record<string, unknown>)[promptId]
      : history;
  const status =
    root && typeof root === 'object'
      ? (root as Record<string, unknown>).status
      : undefined;
  if (!status || typeof status !== 'object') return null;
  const statusStr = (status as Record<string, unknown>).status_str;
  if (statusStr !== 'error') return null;
  const messages = (status as Record<string, unknown>).messages;
  if (!Array.isArray(messages)) return 'ComfyUI generation failed';
  for (const message of messages) {
    if (!Array.isArray(message) || message[0] !== 'execution_error') continue;
    const payload = message[1];
    if (!payload || typeof payload !== 'object') continue;
    const exceptionMessage = (payload as Record<string, unknown>)
      .exception_message;
    if (typeof exceptionMessage === 'string' && exceptionMessage.trim()) {
      return exceptionMessage.trim().slice(0, 500);
    }
  }
  return 'ComfyUI generation failed';
}

export class ComfyLocalImageGateway implements ImageGateway {
  readonly provider: ImageGatewayProvider = 'comfyui_local';
  private readonly config: ImageGatewayConfig;
  private readonly fetchImpl: FetchLike;

  constructor(
    config: Partial<ImageGatewayConfig> = {},
    fetchImpl: FetchLike = fetch,
  ) {
    this.config = loadImageGatewayConfig({
      ...config,
      provider: 'comfyui_local',
    });
    this.fetchImpl = fetchImpl;
  }

  private async fetchWithTimeout(
    url: string,
    init: RequestInit = {},
  ): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);
    try {
      return await this.fetchImpl(url, {
        ...init,
        signal: controller.signal,
        // Never follow redirects to a different host: a compromised/MITM'd
        // ComfyUI response must not be able to redirect us to another internal
        // service. Redirects surface as non-ok responses at each call site.
        redirect: 'manual',
      });
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new ImageGatewayError('ComfyUI request timed out', 'timeout');
      }
      throw new ImageGatewayError(
        'ComfyUI is unavailable or did not accept the request',
        'unavailable',
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  private loadWorkflow(prompt: string): unknown {
    if (!fs.existsSync(this.config.comfyWorkflowPath)) {
      throw new ImageGatewayError(
        'ComfyUI workflow is not configured',
        'unavailable',
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(
        fs.readFileSync(this.config.comfyWorkflowPath, 'utf-8'),
      );
    } catch {
      throw new ImageGatewayError(
        'ComfyUI workflow JSON is invalid',
        'invalid_output',
      );
    }
    return replaceComfyWorkflowPlaceholders(parsed, {
      __SKOOBI_PROMPT__: prompt,
      __SKOOBI_NEGATIVE_PROMPT__: this.config.comfyNegativePrompt,
      __SKOOBI_WIDTH__: this.config.width,
      __SKOOBI_HEIGHT__: this.config.height,
      __SKOOBI_STEPS__: this.config.comfySteps,
      __SKOOBI_SEED__:
        this.config.comfySeed ?? Math.floor(Math.random() * 1_000_000_000_000),
    });
  }

  private async queuePrompt(workflow: unknown): Promise<string> {
    const response = await this.fetchWithTimeout(
      `${this.config.comfyBaseUrl}/prompt`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          prompt: workflow,
          client_id: `skoobi-${randomUUID()}`,
        }),
      },
    );
    if (!response.ok) {
      throw new ImageGatewayError(
        `ComfyUI returned HTTP ${response.status} while queuing prompt`,
        'provider_error',
      );
    }
    const payload = (await response.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    const promptId = payload?.prompt_id;
    if (typeof promptId !== 'string' || !promptId) {
      throw new ImageGatewayError(
        'ComfyUI did not return a prompt_id',
        'provider_error',
      );
    }
    return promptId;
  }

  private async waitForImage(promptId: string): Promise<ComfyImageRef> {
    const deadline = Date.now() + this.config.timeoutMs;
    while (Date.now() < deadline) {
      const response = await this.fetchWithTimeout(
        `${this.config.comfyBaseUrl}/history/${encodeURIComponent(promptId)}`,
        { method: 'GET' },
      );
      if (!response.ok) {
        throw new ImageGatewayError(
          `ComfyUI returned HTTP ${response.status} while reading history`,
          'provider_error',
        );
      }
      const history = await response.json().catch(() => null);
      const error = extractComfyError(history, promptId);
      if (error) {
        throw new ImageGatewayError(
          `ComfyUI generation failed: ${error}`,
          'provider_error',
        );
      }
      const image = extractComfyImages(history, promptId)[0];
      if (image) return image;
      await new Promise((resolve) =>
        setTimeout(resolve, this.config.comfyPollIntervalMs),
      );
    }
    throw new ImageGatewayError('ComfyUI generation timed out', 'timeout');
  }

  private async downloadImage(image: ComfyImageRef): Promise<{
    bytes: Buffer;
    contentType: string;
  }> {
    const url = new URL(`${this.config.comfyBaseUrl}/view`);
    url.searchParams.set('filename', image.filename);
    if (image.subfolder) url.searchParams.set('subfolder', image.subfolder);
    url.searchParams.set('type', image.type || 'output');
    const response = await this.fetchWithTimeout(url.toString(), {
      method: 'GET',
    });
    if (!response.ok) {
      throw new ImageGatewayError(
        `ComfyUI returned HTTP ${response.status} while downloading image`,
        'provider_error',
      );
    }
    const contentType = response.headers.get('content-type') || 'image/png';
    if (!contentType.toLowerCase().startsWith('image/')) {
      throw new ImageGatewayError(
        'ComfyUI did not return an image',
        'invalid_output',
      );
    }
    const bytes = await readResponseBodyWithCap(
      response,
      this.config.maxBytes,
      'ComfyUI returned an oversized image',
    );
    if (bytes.length === 0) {
      throw new ImageGatewayError(
        'ComfyUI returned an empty image',
        'empty_output',
      );
    }
    return { bytes, contentType };
  }

  async generate(input: {
    prompt: string;
    outputDir?: string;
    sessionId?: string;
  }): Promise<ImageGenerationResult> {
    if (!this.config.enabled) {
      throw new ImageGatewayError('ImageGateway is disabled', 'disabled');
    }

    const prompt = cleanImagePrompt(input.prompt, this.config.maxPromptChars);
    if (!prompt) {
      throw new ImageGatewayError(
        'Image generation prompt is empty',
        'empty_output',
      );
    }

    const outputDir = path.resolve(input.outputDir || this.config.outputRoot);
    fs.mkdirSync(outputDir, { recursive: true, mode: 0o700 });
    const promptHash = hashImagePrompt(prompt);
    const sessionSlug = (input.sessionId || 'image')
      .replace(/[^a-zA-Z0-9_-]+/g, '-')
      .slice(0, 64);

    return await runComfyExclusive(async () => {
      const workflow = this.loadWorkflow(prompt);
      const promptId = await this.queuePrompt(workflow);
      const image = await this.waitForImage(promptId);
      const { bytes } = await this.downloadImage(image);
      // Finding #52: confirm the downloaded body is a real raster image by its
      // magic bytes (not the ComfyUI Content-Type header), and derive the
      // extension + content type from the verified format.
      const sniffed = sniffRasterImage(bytes);
      if (!sniffed) {
        throw new ImageGatewayError(
          'ComfyUI did not return a supported raster image',
          'invalid_output',
        );
      }
      const ext = sniffed.ext;
      const filePath = path.join(
        outputDir,
        `${sessionSlug}-${Date.now()}-${randomUUID()}${ext}`,
      );
      ensureInside(outputDir, filePath);
      fs.writeFileSync(filePath, bytes, { mode: 0o600 });

      return {
        provider: this.provider,
        model: `${this.config.comfyModel}:${this.config.comfySteps}steps`,
        promptHash,
        filePath,
        contentType: sniffed.contentType,
        bytes: bytes.length,
        width: this.config.width,
        height: this.config.height,
        generatedAt: new Date().toISOString(),
      };
    });
  }
}

function trimProcessOutput(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value);
  if (bytes.length <= maxBytes) return value;
  return bytes.subarray(0, maxBytes).toString('utf-8');
}

function runCommand(
  input: ImageGatewayCommandRunnerInput,
): Promise<ImageGatewayCommandRunnerResult> {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const child = spawn(input.command, input.args, {
      cwd: input.cwd,
      env: input.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const append = (target: 'stdout' | 'stderr', chunk: Buffer) => {
      if (target === 'stdout') {
        stdout = trimProcessOutput(
          stdout + chunk.toString(),
          input.maxOutputBytes,
        );
      } else {
        stderr = trimProcessOutput(
          stderr + chunk.toString(),
          input.maxOutputBytes,
        );
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => {
        if (!child.killed) child.kill('SIGKILL');
      }, 2500).unref();
    }, input.timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => append('stdout', chunk));
    child.stderr.on('data', (chunk: Buffer) => append('stderr', chunk));
    child.on('error', () => {
      clearTimeout(timer);
      resolve({
        code: null,
        signal: null,
        stdout,
        stderr,
        durationMs: Date.now() - startedAt,
        timedOut,
      });
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({
        code,
        signal,
        stdout,
        stderr,
        durationMs: Date.now() - startedAt,
        timedOut,
      });
    });
  });
}

function ensureInside(parent: string, child: string): void {
  const relative = path.relative(parent, child);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new ImageGatewayError(
      'Generated image path escaped output directory',
      'invalid_output',
    );
  }
}

function bonsaiProcessEnv(developerDir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of [
    'PATH',
    'HOME',
    'TMPDIR',
    'LANG',
    'LC_ALL',
    'HF_HOME',
    'HF_HUB_CACHE',
    'HF_XET_CACHE',
    'HF_XET_HIGH_PERFORMANCE',
    'PYTORCH_ENABLE_MPS_FALLBACK',
  ]) {
    const value = process.env[key];
    if (value) env[key] = value;
  }
  if (developerDir) env.DEVELOPER_DIR = developerDir;
  return env;
}

export class BonsaiLocalImageGateway implements ImageGateway {
  readonly provider: ImageGatewayProvider = 'bonsai_mlx';
  private readonly config: ImageGatewayConfig;
  private readonly runner: ImageGatewayCommandRunner;

  constructor(
    config: Partial<ImageGatewayConfig> = {},
    runner: ImageGatewayCommandRunner = runCommand,
  ) {
    this.config = loadImageGatewayConfig({
      ...config,
      provider: 'bonsai_mlx',
    });
    this.runner = runner;
  }

  async generate(input: {
    prompt: string;
    outputDir?: string;
    sessionId?: string;
  }): Promise<ImageGenerationResult> {
    if (!this.config.enabled) {
      throw new ImageGatewayError('ImageGateway is disabled', 'disabled');
    }

    const prompt = cleanImagePrompt(input.prompt, this.config.maxPromptChars);
    if (!prompt) {
      throw new ImageGatewayError(
        'Image generation prompt is empty',
        'empty_output',
      );
    }

    const demoDir = path.resolve(this.config.bonsaiDemoDir);
    const scriptPath = path.join(demoDir, 'scripts', 'generate.py');
    if (!fs.existsSync(scriptPath)) {
      throw new ImageGatewayError(
        'Bonsai Image Demo is not configured',
        'unavailable',
      );
    }

    const python =
      this.config.bonsaiPython || path.join(demoDir, '.venv', 'bin', 'python');
    if (!fs.existsSync(python)) {
      throw new ImageGatewayError(
        'Bonsai Python environment is not configured',
        'unavailable',
      );
    }

    const outputDir = path.resolve(input.outputDir || this.config.outputRoot);
    fs.mkdirSync(outputDir, { recursive: true, mode: 0o700 });

    const promptHash = hashImagePrompt(prompt);
    const sessionSlug = (input.sessionId || 'image')
      .replace(/[^a-zA-Z0-9_-]+/g, '-')
      .slice(0, 64);
    const scratchRoot = path.join(
      this.config.outputRoot,
      'bonsai-runs',
      `${sessionSlug}-${Date.now()}-${randomUUID()}`,
    );
    fs.mkdirSync(scratchRoot, { recursive: true, mode: 0o700 });
    const scratchOutput = path.join(scratchRoot, 'image.png');
    const finalPath = path.join(
      outputDir,
      `${sessionSlug}-${Date.now()}-${randomUUID()}.png`,
    );
    ensureInside(outputDir, finalPath);

    const args = [
      scriptPath,
      '--model',
      this.config.bonsaiModel,
      '--prompt',
      prompt,
      '--size',
      `${this.config.width}x${this.config.height}`,
      '--steps',
      String(this.config.bonsaiSteps),
      '--output',
      scratchOutput,
    ];
    if (this.config.bonsaiSeed !== undefined) {
      args.push('--seed', String(this.config.bonsaiSeed));
    }

    try {
      const result = await runBonsaiExclusive(() =>
        this.runner({
          command: python,
          args,
          cwd: demoDir,
          env: bonsaiProcessEnv(this.config.bonsaiDeveloperDir),
          timeoutMs: this.config.timeoutMs,
          maxOutputBytes: this.config.bonsaiMaxOutputBytes,
        }),
      );

      if (result.timedOut) {
        throw new ImageGatewayError('Bonsai generation timed out', 'timeout');
      }
      if (result.code !== 0) {
        throw new ImageGatewayError(
          'Bonsai generation process failed',
          'provider_error',
        );
      }
      if (!fs.existsSync(scratchOutput)) {
        throw new ImageGatewayError(
          'Bonsai did not create an image',
          'empty_output',
        );
      }

      const stat = fs.statSync(scratchOutput);
      if (stat.size === 0) {
        throw new ImageGatewayError(
          'Bonsai created an empty image',
          'empty_output',
        );
      }
      if (stat.size > this.config.maxBytes) {
        throw new ImageGatewayError(
          'Bonsai created an oversized image',
          'invalid_output',
        );
      }

      fs.copyFileSync(scratchOutput, finalPath);
      fs.chmodSync(finalPath, 0o600);

      return {
        provider: this.provider,
        model: `${this.config.bonsaiModel}:${this.config.bonsaiSteps}steps`,
        promptHash,
        filePath: finalPath,
        contentType: 'image/png',
        bytes: stat.size,
        width: this.config.width,
        height: this.config.height,
        generatedAt: new Date().toISOString(),
      };
    } finally {
      fs.rmSync(scratchRoot, { recursive: true, force: true });
    }
  }
}

export function createImageGateway(
  overrides: Partial<ImageGatewayConfig> = {},
): ImageGateway {
  const config = loadImageGatewayConfig(overrides);
  if (config.provider === 'comfyui_local') {
    return new ComfyLocalImageGateway(config);
  }
  if (config.provider === 'bonsai_mlx') {
    return new BonsaiLocalImageGateway(config);
  }
  return new PollinationsImageGateway(config);
}
