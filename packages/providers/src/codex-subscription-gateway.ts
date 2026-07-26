import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';
import { execFile, spawn } from 'child_process';

import { SKOOBI_TRUTHFULNESS_PROMPT } from './truthfulness.js';
import type {
  CanonicalMessage,
  ModelGateway,
  ModelRequest,
  ModelResponse,
  ModelRole,
} from './model-gateway.js';

export type CodexSubscriptionConfig = {
  enabled: boolean;
  command: string;
  model: string;
  fallbackModel: string;
  allowModelDowngrade: boolean;
  reasoningEffort: CodexReasoningEffort | '';
  webSearchEnabled: boolean;
  timeoutMs: number;
  maxStdoutBytes: number;
  maxStderrBytes: number;
  maxFinalAnswerChars: number;
  scratchRoot: string;
  roles: Partial<Record<ModelRole, string>>;
};

export type CodexReasoningEffort =
  | 'none'
  | 'minimal'
  | 'low'
  | 'medium'
  | 'high'
  | 'xhigh';

export type CodexCliStatus = {
  command: string;
  present: boolean;
  version?: string;
  loginActive: boolean;
  loginStatus?: string;
};

export type CodexExecInput = {
  command: string;
  args: string[];
  stdin: string;
  cwd: string;
  timeoutMs: number;
  maxStdoutBytes: number;
  maxStderrBytes: number;
};

export type CodexExecResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
};

export type CodexProcessRunner = {
  execFile(
    command: string,
    args: string[],
    timeoutMs: number,
  ): Promise<{ stdout: string; stderr: string }>;
  run(input: CodexExecInput): Promise<CodexExecResult>;
};

export class CodexSubscriptionUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CodexSubscriptionUnavailableError';
  }
}

export class CodexSubscriptionRuntimeError extends Error {
  readonly classification:
    | 'auth'
    | 'rate_limit'
    | 'transient'
    | 'model_unavailable'
    | 'empty_output'
    | 'unknown';
  readonly requestedModel?: string;
  readonly effectiveModel?: string;
  readonly modelDowngradeUsed?: boolean;
  readonly modelDowngradeReason?: string;

  constructor(
    message: string,
    classification:
      | 'auth'
      | 'rate_limit'
      | 'transient'
      | 'model_unavailable'
      | 'empty_output'
      | 'unknown',
    metadata: {
      requestedModel?: string;
      effectiveModel?: string;
      modelDowngradeUsed?: boolean;
      modelDowngradeReason?: string;
    } = {},
  ) {
    super(message);
    this.name = 'CodexSubscriptionRuntimeError';
    this.classification = classification;
    this.requestedModel = metadata.requestedModel;
    this.effectiveModel = metadata.effectiveModel;
    this.modelDowngradeUsed = metadata.modelDowngradeUsed;
    this.modelDowngradeReason = metadata.modelDowngradeReason;
  }
}

const DEFAULT_CONFIG: CodexSubscriptionConfig = {
  enabled: false,
  command: 'codex',
  model: 'gpt-5.6-sol',
  fallbackModel: 'gpt-5.6-terra',
  allowModelDowngrade: false,
  reasoningEffort: '',
  webSearchEnabled: false,
  timeoutMs: 90_000,
  maxStdoutBytes: 262_144,
  maxStderrBytes: 65_536,
  maxFinalAnswerChars: 8_000,
  scratchRoot: path.join(process.cwd(), 'tmp', 'skoobi-codex-runs'),
  roles: {},
};

const MAX_CODEX_IMAGE_ATTACHMENTS = 3;
const MAX_CODEX_IMAGE_BYTES = 15 * 1024 * 1024;
const CODEX_IMAGE_EXTENSIONS = new Set([
  '.jpg',
  '.jpeg',
  '.png',
  '.webp',
  '.gif',
]);

function execFilePromise(
  command: string,
  args: string[],
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      {
        timeout: timeoutMs,
        maxBuffer: 64 * 1024,
        env: process.env,
      },
      (err, stdout, stderr) => {
        if (err) {
          reject(err);
          return;
        }
        resolve({ stdout: String(stdout || ''), stderr: String(stderr || '') });
      },
    );
  });
}

function appendLimited(
  current: string,
  chunk: Buffer | string,
  maxBytes: number,
): { value: string; exceeded: boolean } {
  const next = current + String(chunk);
  if (Buffer.byteLength(next, 'utf8') <= maxBytes) {
    return { value: next, exceeded: false };
  }
  return {
    value: next.slice(0, Math.max(0, maxBytes)),
    exceeded: true,
  };
}

export const defaultCodexProcessRunner: CodexProcessRunner = {
  execFile: execFilePromise,
  run(input) {
    return new Promise((resolve, reject) => {
      const child = spawn(input.command, input.args, {
        cwd: input.cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: process.env,
      });
      let stdout = '';
      let stderr = '';
      let finished = false;
      let timedOut = false;
      const timeout = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
      }, input.timeoutMs);

      child.stdout.on('data', (chunk) => {
        const next = appendLimited(stdout, chunk, input.maxStdoutBytes);
        stdout = next.value;
        if (next.exceeded) {
          child.kill('SIGTERM');
        }
      });
      child.stderr.on('data', (chunk) => {
        const next = appendLimited(stderr, chunk, input.maxStderrBytes);
        stderr = next.value;
        if (next.exceeded) {
          child.kill('SIGTERM');
        }
      });
      child.on('error', (err) => {
        if (finished) return;
        finished = true;
        clearTimeout(timeout);
        reject(err);
      });
      child.on('close', (exitCode) => {
        if (finished) return;
        finished = true;
        clearTimeout(timeout);
        resolve({ exitCode, stdout, stderr, timedOut });
      });
      // Guard the child's stdin Writable: the codex child can exit before it
      // finishes reading stdin (SIGTERM from the byte-limit guards above, the
      // timeout, a spawn/arg rejection, or a fast model error). Writing to /
      // ending a pipe whose read end is gone emits an asynchronous 'error'
      // (EPIPE/ECONNRESET) on this SEPARATE Writable stream — child.on('error')
      // only covers ChildProcess spawn errors, NOT this. An unhandled stream
      // error becomes an uncaughtException, and the global handler in logger.ts
      // calls process.exit(1), taking down the ENTIRE multi-tenant orchestrator
      // for all tenants. Swallow it; the close/timeout paths already resolve the
      // run. Mirrors sandbox-runner.ts stdin guard.
      child.stdin.on('error', () => {
        // Child likely exited early; nothing to recover, just don't crash.
      });
      try {
        child.stdin.end(input.stdin);
      } catch {
        // Synchronous write failures (e.g. already-destroyed stream) are
        // non-fatal here; the close/timeout/error paths drive resolution.
      }
    });
  },
};

function cleanText(value: string): string {
  return value.replace(/\r\n/g, '\n').trim();
}

function truncateText(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return value.slice(0, Math.max(0, maxChars));
}

function redactSecrets(text: string): string {
  return text
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, 'sk-[REDACTED]')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(/(authorization\s*[:=]\s*)[^\s]+/gi, '$1[REDACTED]')
    .replace(/(access[_-]?token\s*[:=]\s*)[^\s]+/gi, '$1[REDACTED]')
    .replace(/(refresh[_-]?token\s*[:=]\s*)[^\s]+/gi, '$1[REDACTED]');
}

function redactSensitivePaths(text: string): string {
  return text
    .replace(/\bstore\/messages\.db\b/g, '[REDACTED_STORE_DB]')
    .replace(/\bgroups\/[^\s"'`]+/g, '[REDACTED_GROUP_PATH]')
    .replace(/(^|[\s"'`])\.env\b/g, '$1[REDACTED_ENV_PATH]')
    .replace(/~\/\.ssh\b[^\s"'`]*/g, '[REDACTED_SSH_PATH]')
    .replace(/~\/\.codex\b[^\s"'`]*/g, '[REDACTED_CODEX_PATH]')
    .replace(/~\/\.claude\b[^\s"'`]*/g, '[REDACTED_CLAUDE_PATH]')
    .replace(/\/Users\/[^\s"'`]+\/\.ssh\b[^\s"'`]*/g, '[REDACTED_SSH_PATH]')
    .replace(/\/Users\/[^\s"'`]+\/\.codex\b[^\s"'`]*/g, '[REDACTED_CODEX_PATH]')
    .replace(
      /\/Users\/[^\s"'`]+\/\.claude\b[^\s"'`]*/g,
      '[REDACTED_CLAUDE_PATH]',
    );
}

function redactToolHints(text: string): string {
  return text.replace(
    /— use Read tool to inspect visual context/gi,
    '— attached as image context when available',
  );
}

function isSafeRole(
  message: CanonicalMessage,
): message is CanonicalMessage & { role: 'system' | 'user' | 'assistant' } {
  return (
    message.role === 'system' ||
    message.role === 'user' ||
    message.role === 'assistant'
  );
}

export function buildCodexPrompt(
  request: ModelRequest,
  attachedImageCount = Math.min(
    MAX_CODEX_IMAGE_ATTACHMENTS,
    request.metadata.image_paths?.length ?? 0,
  ),
  options: { webSearchEnabled?: boolean } = {},
): string {
  const webSearchContextProvided =
    request.metadata.web_search_context_provided === true;
  const messages = request.messages
    .filter(isSafeRole)
    .map((message) => {
      const content = redactToolHints(redactSensitivePaths(message.content));
      return `${message.role.toUpperCase()}:\n${content.trim()}`;
    })
    .join('\n\n');
  const truthfulnessPrompt = messages.includes('<skoobi_truthfulness>')
    ? ''
    : SKOOBI_TRUTHFULNESS_PROMPT;

  return [
    'You are Skoobi running an experimental Codex subscription adapter.',
    'The current provider for this response is Codex, not Claude or Anthropic.',
    'Do not claim a current Claude/Anthropic outage, limit, quota or subscription problem unless the prompt includes verified evidence for this turn.',
    'Answer as plain text only.',
    truthfulnessPrompt,
    options.webSearchEnabled && !webSearchContextProvided
      ? 'Native web_search is enabled for current public facts, business contacts, prices, news, and weather; cite sources when available, never invent contacts, and use no shell/files/plugins/MCP.'
      : 'Do not use tools, shell commands, filesystem access, network access, or hidden capabilities.',
    'Do not ask for secrets. Do not mention internal runtime paths.',
    attachedImageCount > 0
      ? `Image attachments: ${attachedImageCount} safe copied tenant media image(s) are attached via codex --image. Use them as visual context; do not request filesystem access.`
      : '',
    '',
    messages,
  ]
    .filter((line) => line !== '')
    .join('\n')
    .trim();
}

export function safeSessionSlug(sessionId: string): string {
  return sessionId.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 80) || 'session';
}

export function codexExecArgs(input: {
  scratchDir: string;
  finalPath: string;
  model: string;
  reasoningEffort?: CodexReasoningEffort | '';
  imagePaths?: string[];
  enableWebSearch?: boolean;
}): string[] {
  return [
    '--disable',
    'plugins',
    '--ask-for-approval',
    'never',
    ...(input.reasoningEffort
      ? ['-c', `model_reasoning_effort="${input.reasoningEffort}"`]
      : []),
    ...(input.enableWebSearch ? ['--search'] : []),
    'exec',
    '--cd',
    input.scratchDir,
    '--sandbox',
    'read-only',
    '--json',
    '--output-last-message',
    input.finalPath,
    '--skip-git-repo-check',
    '--ephemeral',
    '--ignore-user-config',
    '--ignore-rules',
    '--color',
    'never',
    ...(input.model ? ['--model', input.model] : []),
    ...(input.imagePaths || []).flatMap((imagePath) => ['--image', imagePath]),
    '-',
  ];
}

function pathIsInside(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return (
    Boolean(relative) &&
    !relative.startsWith('..') &&
    !path.isAbsolute(relative)
  );
}

function isSensitiveSourcePath(realPath: string): boolean {
  const normalized = realPath.split(path.sep).join('/');
  const home = process.env.HOME ? path.resolve(process.env.HOME) : '';
  const homeNormalized = home.split(path.sep).join('/');
  return (
    path.basename(realPath) === '.env' ||
    normalized.endsWith('/store/messages.db') ||
    normalized.includes('/.ssh/') ||
    normalized.endsWith('/.ssh') ||
    normalized.includes('/.codex/') ||
    normalized.endsWith('/.codex') ||
    normalized.includes('/.claude/') ||
    normalized.endsWith('/.claude') ||
    (homeNormalized
      ? normalized.startsWith(`${homeNormalized}/.ssh/`) ||
        normalized.startsWith(`${homeNormalized}/.codex/`) ||
        normalized.startsWith(`${homeNormalized}/.claude/`)
      : false)
  );
}

function safeImageExtension(filePath: string): string | null {
  const ext = path.extname(filePath).toLowerCase();
  return CODEX_IMAGE_EXTENSIONS.has(ext) ? ext : null;
}

function prepareCodexImageAttachments(input: {
  sourcePaths: string[];
  scratchDir: string;
}): string[] {
  const requested = input.sourcePaths
    .filter((sourcePath) => typeof sourcePath === 'string')
    .map((sourcePath) => sourcePath.trim())
    .filter(Boolean);
  if (requested.length === 0) return [];

  const imagesDir = path.join(input.scratchDir, 'images');
  const copied: string[] = [];
  const seen = new Set<string>();

  for (const sourcePath of requested) {
    if (sourcePath.includes('\0') || !path.isAbsolute(sourcePath)) {
      continue;
    }
    const sourceExt = safeImageExtension(sourcePath);
    if (!sourceExt) continue;

    try {
      const realSource = fs.realpathSync(sourcePath);
      if (seen.has(realSource)) continue;
      seen.add(realSource);

      const realExt = safeImageExtension(realSource);
      if (!realExt || isSensitiveSourcePath(realSource)) continue;

      const stat = fs.statSync(realSource);
      if (
        !stat.isFile() ||
        stat.size <= 0 ||
        stat.size > MAX_CODEX_IMAGE_BYTES
      ) {
        continue;
      }

      fs.mkdirSync(imagesDir, { recursive: true, mode: 0o700 });
      const destination = path.join(
        imagesDir,
        `image-${String(copied.length + 1).padStart(2, '0')}${realExt}`,
      );
      fs.copyFileSync(realSource, destination);
      fs.chmodSync(destination, 0o600);

      const realDestination = fs.realpathSync(destination);
      const realImagesDir = fs.realpathSync(imagesDir);
      if (!pathIsInside(realDestination, realImagesDir)) {
        fs.rmSync(destination, { force: true });
        continue;
      }

      copied.push(realDestination);
      if (copied.length >= MAX_CODEX_IMAGE_ATTACHMENTS) break;
    } catch {
      continue;
    }
  }

  return copied;
}

function classifyCodexFailure(
  result: CodexExecResult,
  requestedModel?: string,
): CodexSubscriptionRuntimeError {
  // Classify on stderr only, not stdout. With codex --json the model's own
  // generated answer (driven by untrusted tenant/guest input) streams to
  // stdout; the codex CLI writes operational diagnostics (auth/rate-limit/
  // HTTP status) to stderr. Matching against stdout let a guest steer the
  // failure reason by making the model emit phrases like 'rate limit' or
  // 'unauthorized' (telemetry poisoning). stderr is not tenant-controlled.
  const diagnostics = String(result.stderr).toLowerCase();
  const metadata = { requestedModel, effectiveModel: requestedModel };
  if (result.timedOut) {
    return new CodexSubscriptionRuntimeError(
      'Codex CLI timed out',
      'transient',
      metadata,
    );
  }
  if (
    diagnostics.includes('login') ||
    diagnostics.includes('not authenticated') ||
    diagnostics.includes('unauthorized') ||
    diagnostics.includes('permission denied')
  ) {
    return new CodexSubscriptionRuntimeError(
      'Codex CLI auth failed',
      'auth',
      metadata,
    );
  }
  if (diagnostics.includes('rate_limit') || diagnostics.includes('rate limit')) {
    return new CodexSubscriptionRuntimeError(
      'Codex CLI rate limited',
      'rate_limit',
      metadata,
    );
  }
  if (
    diagnostics.includes('model_not_found') ||
    diagnostics.includes('model not found') ||
    diagnostics.includes('unknown model') ||
    diagnostics.includes('not supported') ||
    diagnostics.includes('model unavailable') ||
    diagnostics.includes('model is unavailable') ||
    diagnostics.includes('model not available')
  ) {
    return new CodexSubscriptionRuntimeError(
      'Codex model unavailable',
      'model_unavailable',
      metadata,
    );
  }
  if (
    diagnostics.includes('timeout') ||
    diagnostics.includes('temporarily unavailable') ||
    // Match an explicit 5xx HTTP status (500-599) rather than the over-broad
    // ' 5' substring, which spuriously matched innocuous text like 'took 5
    // seconds', '$5', or '5 items'.
    /\b5\d{2}\b/.test(diagnostics)
  ) {
    return new CodexSubscriptionRuntimeError(
      'Codex CLI transient failure',
      'transient',
      metadata,
    );
  }
  return new CodexSubscriptionRuntimeError(
    'Codex CLI failed',
    'unknown',
    metadata,
  );
}

export async function checkCodexCliStatus(
  config: Partial<CodexSubscriptionConfig> = {},
  runner: CodexProcessRunner = defaultCodexProcessRunner,
): Promise<CodexCliStatus> {
  const command = config.command || DEFAULT_CONFIG.command;
  try {
    const version = await runner.execFile(command, ['--version'], 5_000);
    let loginStatus = '';
    let loginActive = false;
    try {
      const login = await runner.execFile(command, ['login', 'status'], 5_000);
      loginStatus = cleanText(login.stdout || login.stderr);
      loginActive = /logged in/i.test(loginStatus);
    } catch {
      loginActive = false;
    }
    return {
      command,
      present: true,
      version: cleanText(version.stdout || version.stderr),
      loginActive,
      loginStatus,
    };
  } catch {
    return { command, present: false, loginActive: false };
  }
}

export class CodexSubscriptionModelGateway implements ModelGateway {
  private readonly config: CodexSubscriptionConfig;
  private readonly runner: CodexProcessRunner;

  constructor(
    config: Partial<CodexSubscriptionConfig> = {},
    runner: CodexProcessRunner = defaultCodexProcessRunner,
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.config.roles = { ...DEFAULT_CONFIG.roles, ...(config.roles || {}) };
    this.config.scratchRoot = path.resolve(this.config.scratchRoot);
    this.runner = runner;
  }

  private modelForRequest(request: ModelRequest): string {
    const roleRoute = this.config.roles[request.model_role];
    if (roleRoute && !roleRoute.startsWith('skoobi-')) return roleRoute;
    return this.config.model;
  }

  private async runAttempt(input: {
    request: ModelRequest;
    scratchDir: string;
    finalPath: string;
    model: string;
  }): Promise<string> {
    const requestedImagePaths = input.request.metadata.image_paths || [];
    const imagePaths = prepareCodexImageAttachments({
      sourcePaths: requestedImagePaths,
      scratchDir: input.scratchDir,
    });
    if (requestedImagePaths.length > 0 && imagePaths.length === 0) {
      throw new CodexSubscriptionRuntimeError(
        'Codex image attachments unavailable',
        'transient',
        {
          requestedModel: input.model,
          effectiveModel: input.model,
        },
      );
    }

    const enableWebSearch =
      this.config.webSearchEnabled &&
      input.request.metadata.web_search_context_provided !== true;
    const prompt = buildCodexPrompt(input.request, imagePaths.length, {
      webSearchEnabled: enableWebSearch,
    });
    const args = codexExecArgs({
      scratchDir: input.scratchDir,
      finalPath: input.finalPath,
      model: input.model,
      reasoningEffort: this.config.reasoningEffort,
      imagePaths,
      enableWebSearch,
    });
    const result = await this.runner.run({
      command: this.config.command,
      args,
      stdin: prompt,
      cwd: input.scratchDir,
      timeoutMs: this.config.timeoutMs,
      maxStdoutBytes: this.config.maxStdoutBytes,
      maxStderrBytes: this.config.maxStderrBytes,
    });

    if (result.exitCode !== 0 || result.timedOut) {
      throw classifyCodexFailure(
        {
          ...result,
          stdout: redactSecrets(result.stdout),
          stderr: redactSecrets(result.stderr),
        },
        input.model,
      );
    }

    const finalText = fs.existsSync(input.finalPath)
      ? cleanText(fs.readFileSync(input.finalPath, 'utf8'))
      : '';
    if (!finalText) {
      throw new CodexSubscriptionRuntimeError(
        'Codex CLI returned an empty final answer',
        'empty_output',
        {
          requestedModel: input.model,
          effectiveModel: input.model,
        },
      );
    }

    return finalText;
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    if (!this.config.enabled) {
      throw new CodexSubscriptionUnavailableError(
        'Codex subscription runtime is disabled',
      );
    }

    const status = await checkCodexCliStatus(this.config, this.runner);
    if (!status.present) {
      throw new CodexSubscriptionUnavailableError('Codex CLI is not installed');
    }
    if (!status.loginActive) {
      throw new CodexSubscriptionUnavailableError('Codex CLI is not logged in');
    }

    const scratchDir = path.join(
      this.config.scratchRoot,
      `${safeSessionSlug(request.session_id)}-${randomUUID()}`,
    );
    fs.mkdirSync(scratchDir, { recursive: true, mode: 0o700 });

    try {
      const finalPath = path.join(scratchDir, 'final.txt');
      let finalText = '';
      const requestedModel = this.modelForRequest(request);
      let effectiveModel = requestedModel;
      let modelDowngradeUsed = false;
      let modelDowngradeReason: string | undefined;

      try {
        finalText = await this.runAttempt({
          request,
          scratchDir,
          finalPath,
          model: requestedModel,
        });
      } catch (err) {
        if (
          err instanceof CodexSubscriptionRuntimeError &&
          err.classification === 'model_unavailable' &&
          this.config.allowModelDowngrade &&
          this.config.fallbackModel &&
          this.config.fallbackModel !== this.config.model
        ) {
          const fallbackFinalPath = path.join(scratchDir, 'final-fallback.txt');
          effectiveModel = this.config.fallbackModel;
          modelDowngradeUsed = true;
          modelDowngradeReason = 'codex_model_unavailable';
          finalText = await this.runAttempt({
            request,
            scratchDir,
            finalPath: fallbackFinalPath,
            model: this.config.fallbackModel,
          });
        } else {
          throw err;
        }
      }

      return {
        text: truncateText(finalText, this.config.maxFinalAnswerChars),
        tool_calls: [],
        usage: {
          input_tokens: null,
          output_tokens: null,
          cost_usd: null,
          provider_model: 'codex-subscription',
          provider: 'codex_cli',
          usage_source: 'unavailable_or_estimated',
          requested_model: requestedModel,
          effective_model: effectiveModel,
          reasoning_effort: this.config.reasoningEffort || undefined,
          web_search_enabled:
            this.config.webSearchEnabled &&
            request.metadata.web_search_context_provided !== true,
          model_downgrade_used: modelDowngradeUsed,
          model_downgrade_reason: modelDowngradeReason,
        },
      };
    } finally {
      try {
        fs.rmSync(scratchDir, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup only; scratch contains no secrets or tenant files.
      }
    }
  }
}

export function createCodexSubscriptionModelGateway(
  config: Partial<CodexSubscriptionConfig> = {},
  runner?: CodexProcessRunner,
): ModelGateway {
  return new CodexSubscriptionModelGateway(config, runner);
}
