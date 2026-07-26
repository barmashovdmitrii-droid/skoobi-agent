import { createHash, randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';

// Same semantics as the old orchestrator STATE_ROOT (= service cwd).
const STATE_ROOT = process.cwd();
import {
  checkCodexCliStatus,
  codexExecArgs,
  defaultCodexProcessRunner,
  safeSessionSlug,
  type CodexReasoningEffort,
  type CodexProcessRunner,
} from './codex-subscription-gateway.js';
import { readEnvFile } from '@skoobi/shared';
import { escapeXml } from '@skoobi/shared';

export type SearchGatewayProvider = 'codex_cli';

export type SearchGatewayConfig = {
  enabled: boolean;
  provider: SearchGatewayProvider;
  command: string;
  model: string;
  reasoningEffort: CodexReasoningEffort | '';
  timeoutMs: number;
  maxResults: number;
  maxSnippetChars: number;
  maxQueryChars: number;
  scratchRoot: string;
};

export type SearchResult = {
  title: string;
  url: string;
  snippet: string;
  source?: string;
};

export type SearchGatewayResponse = {
  query: string;
  provider: SearchGatewayProvider;
  results: SearchResult[];
  generatedAt: string;
};

export class SearchGatewayError extends Error {
  readonly classification:
    | 'unavailable'
    | 'auth_error'
    | 'timeout'
    | 'empty_output'
    | 'runtime_error';

  constructor(
    message: string,
    classification: SearchGatewayError['classification'],
  ) {
    super(message);
    this.name = 'SearchGatewayError';
    this.classification = classification;
  }
}

function boolFrom(value: unknown, fallback: boolean): boolean {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

function reasoningEffortFrom(value: unknown): CodexReasoningEffort | '' {
  const normalized = stringFrom(value).toLowerCase();
  if (
    normalized === 'none' ||
    normalized === 'minimal' ||
    normalized === 'low' ||
    normalized === 'medium' ||
    normalized === 'high' ||
    normalized === 'xhigh'
  ) {
    return normalized;
  }
  return '';
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

function hashText(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function unescapeXml(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function stripMediaPlaceholder(content: string): string {
  const trimmed = content.trim();
  const media = trimmed.match(
    /^\[(?:Voice|Audio|Video note)[^\]:]*(?::|Transcript:)\s*([\s\S]*?)\]?$/i,
  );
  return (media?.[1] || trimmed).trim();
}

function cleanForSearch(value: string, maxChars: number): string {
  return stripMediaPlaceholder(unescapeXml(value))
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxChars)
    .trim();
}

export function extractSearchQueryFromPrompt(
  prompt: string,
  maxChars = 400,
): string {
  const messages = [
    ...prompt.matchAll(/<message\b[^>]*>([\s\S]*?)<\/message>/gi),
  ]
    .map((match) => cleanForSearch(match[1], maxChars))
    .filter(Boolean);
  const query = messages.at(-1) || cleanForSearch(prompt, maxChars);
  return query || 'current public information';
}

function stripCodeFence(value: string): string {
  const trimmed = value.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return (fenced?.[1] || trimmed).trim();
}

function parseJsonObject(value: string): unknown {
  const clean = stripCodeFence(value);
  try {
    return JSON.parse(clean);
  } catch {
    const start = clean.indexOf('{');
    const end = clean.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(clean.slice(start, end + 1));
      } catch {
        // Fall through to the canonical SearchGateway error below.
      }
    }
    throw new SearchGatewayError(
      'SearchGateway returned invalid JSON',
      'runtime_error',
    );
  }
}

function normalizeUrl(value: unknown): string {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  try {
    const url = new URL(trimmed);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
    return url.toString();
  } catch {
    return '';
  }
}

function truncate(value: unknown, maxChars: number): string {
  if (typeof value !== 'string') return '';
  return value.replace(/\s+/g, ' ').trim().slice(0, maxChars).trim();
}

export function normalizeSearchResponse(
  value: unknown,
  input: {
    query: string;
    provider: SearchGatewayProvider;
    maxResults: number;
    maxSnippetChars: number;
  },
): SearchGatewayResponse {
  const rawResults =
    value &&
    typeof value === 'object' &&
    Array.isArray((value as Record<string, unknown>).results)
      ? ((value as Record<string, unknown>).results as unknown[])
      : [];
  const seen = new Set<string>();
  const results: SearchResult[] = [];
  for (const item of rawResults) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    const url = normalizeUrl(record.url);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    const title = truncate(record.title, 140) || new URL(url).hostname;
    const snippet = truncate(record.snippet, input.maxSnippetChars);
    const source = truncate(record.source, 80) || new URL(url).hostname;
    results.push({ title, url, snippet, source });
    if (results.length >= input.maxResults) break;
  }

  if (results.length === 0) {
    throw new SearchGatewayError(
      'SearchGateway returned no usable results',
      'empty_output',
    );
  }

  return {
    query: input.query,
    provider: input.provider,
    results,
    generatedAt: new Date().toISOString(),
  };
}

// Untrusted search fields (title/url/source/snippet) are attacker-controlled:
// a malicious page can emit a literal `</web_search_results>` to escape the
// context boundary, or inject `<...>` markup for prompt injection. Strip any
// literal close tag first (tolerating internal whitespace), then XML-escape so
// no `<`/`>`/`&`/`"` survives into the prompt.
function sanitizeSearchField(value: string): string {
  const withoutCloseTag = value.replace(
    /<\s*\/\s*web_search_results\s*>/gi,
    '',
  );
  return escapeXml(withoutCloseTag);
}

export function formatSearchContextForPrompt(
  response: SearchGatewayResponse,
): string {
  const lines = [
    '<web_search_results provider="' +
      sanitizeSearchField(response.provider) +
      '" query_hash="' +
      hashText(response.query).slice(0, 16) +
      '">',
    'Use these host-provided public web search results. Do not invent missing contacts. Cite URLs when helpful.',
  ];
  response.results.forEach((result, index) => {
    const title = sanitizeSearchField(result.title);
    const url = sanitizeSearchField(result.url);
    const source = sanitizeSearchField(result.source || 'unknown');
    const snippet = sanitizeSearchField(result.snippet || '(no snippet)');
    lines.push(
      `[${index + 1}] ${title}\nURL: ${url}\nSource: ${source}\nSnippet: ${snippet}`,
    );
  });
  lines.push('</web_search_results>');
  return lines.join('\n');
}

export function loadSearchGatewayConfig(
  overrides: Partial<SearchGatewayConfig> = {},
): SearchGatewayConfig {
  const env = readEnvFile([
    'SKOOBI_SEARCH_GATEWAY_ENABLED',
    'SKOOBI_SEARCH_GATEWAY_PROVIDER',
    'SKOOBI_SEARCH_GATEWAY_COMMAND',
    'SKOOBI_SEARCH_GATEWAY_MODEL',
    'SKOOBI_SEARCH_GATEWAY_REASONING_EFFORT',
    'SKOOBI_SEARCH_GATEWAY_TIMEOUT_MS',
    'SKOOBI_SEARCH_GATEWAY_MAX_RESULTS',
    'SKOOBI_SEARCH_GATEWAY_MAX_SNIPPET_CHARS',
    'SKOOBI_SEARCH_GATEWAY_MAX_QUERY_CHARS',
    'SKOOBI_SEARCH_GATEWAY_SCRATCH_ROOT',
    'SKOOBI_CODEX_COMMAND',
    'SKOOBI_CODEX_MODEL',
    'SKOOBI_CODEX_REASONING_EFFORT',
  ]);
  return {
    enabled: boolFrom(
      overrides.enabled ??
        env.SKOOBI_SEARCH_GATEWAY_ENABLED ??
        process.env.SKOOBI_SEARCH_GATEWAY_ENABLED,
      true,
    ),
    provider: 'codex_cli',
    command: stringFrom(
      overrides.command ??
        env.SKOOBI_SEARCH_GATEWAY_COMMAND ??
        process.env.SKOOBI_SEARCH_GATEWAY_COMMAND,
      stringFrom(
        env.SKOOBI_CODEX_COMMAND ?? process.env.SKOOBI_CODEX_COMMAND,
        'codex',
      ),
    ),
    model: stringFrom(
      overrides.model ??
        env.SKOOBI_SEARCH_GATEWAY_MODEL ??
        process.env.SKOOBI_SEARCH_GATEWAY_MODEL,
      stringFrom(
        env.SKOOBI_CODEX_MODEL ?? process.env.SKOOBI_CODEX_MODEL,
        'gpt-5.6-sol',
      ),
    ),
    reasoningEffort: reasoningEffortFrom(
      overrides.reasoningEffort ??
        env.SKOOBI_SEARCH_GATEWAY_REASONING_EFFORT ??
        process.env.SKOOBI_SEARCH_GATEWAY_REASONING_EFFORT ??
        env.SKOOBI_CODEX_REASONING_EFFORT ??
        process.env.SKOOBI_CODEX_REASONING_EFFORT,
    ),
    timeoutMs: Math.max(
      1,
      Math.trunc(
        numberFrom(
          overrides.timeoutMs ??
            env.SKOOBI_SEARCH_GATEWAY_TIMEOUT_MS ??
            process.env.SKOOBI_SEARCH_GATEWAY_TIMEOUT_MS,
          45_000,
        ),
      ),
    ),
    maxResults: Math.max(
      1,
      Math.min(
        12,
        Math.trunc(
          numberFrom(
            overrides.maxResults ??
              env.SKOOBI_SEARCH_GATEWAY_MAX_RESULTS ??
              process.env.SKOOBI_SEARCH_GATEWAY_MAX_RESULTS,
            8,
          ),
        ),
      ),
    ),
    maxSnippetChars: Math.max(
      80,
      Math.min(
        600,
        Math.trunc(
          numberFrom(
            overrides.maxSnippetChars ??
              env.SKOOBI_SEARCH_GATEWAY_MAX_SNIPPET_CHARS ??
              process.env.SKOOBI_SEARCH_GATEWAY_MAX_SNIPPET_CHARS,
            240,
          ),
        ),
      ),
    ),
    maxQueryChars: Math.max(
      80,
      Math.min(
        1000,
        Math.trunc(
          numberFrom(
            overrides.maxQueryChars ??
              env.SKOOBI_SEARCH_GATEWAY_MAX_QUERY_CHARS ??
              process.env.SKOOBI_SEARCH_GATEWAY_MAX_QUERY_CHARS,
            400,
          ),
        ),
      ),
    ),
    scratchRoot: path.resolve(
      stringFrom(
        overrides.scratchRoot ??
          env.SKOOBI_SEARCH_GATEWAY_SCRATCH_ROOT ??
          process.env.SKOOBI_SEARCH_GATEWAY_SCRATCH_ROOT,
        path.join(STATE_ROOT, 'tmp', 'skoobi-search-runs'),
      ),
    ),
  };
}

function buildSearchPrompt(input: {
  query: string;
  maxResults: number;
}): string {
  return [
    'You are Skoobi SearchGateway.',
    'Use only native web_search. Do not use shell, filesystem, plugins, MCP, cookies, or hidden tools.',
    'Return ONLY valid compact JSON with this shape:',
    '{"query":"...","results":[{"title":"...","url":"https://...","snippet":"...","source":"..."}]}',
    `Return up to ${input.maxResults} useful public results. Prefer official company sites, maps/directories, and pages likely to contain current public contacts. Never invent phone numbers, addresses, emails, or websites.`,
    '',
    `Query: ${input.query}`,
  ].join('\n');
}

export class CodexSearchGateway {
  private readonly config: SearchGatewayConfig;
  private readonly runner: CodexProcessRunner;

  constructor(
    config: Partial<SearchGatewayConfig> = {},
    runner: CodexProcessRunner = defaultCodexProcessRunner,
  ) {
    this.config = loadSearchGatewayConfig(config);
    this.runner = runner;
  }

  async search(input: {
    query: string;
    sessionId?: string;
  }): Promise<SearchGatewayResponse> {
    if (!this.config.enabled) {
      throw new SearchGatewayError('SearchGateway is disabled', 'unavailable');
    }

    const query = cleanForSearch(input.query, this.config.maxQueryChars);
    if (!query) {
      throw new SearchGatewayError(
        'SearchGateway query is empty',
        'empty_output',
      );
    }

    const status = await checkCodexCliStatus(
      {
        command: this.config.command,
      },
      this.runner,
    );
    if (!status.present) {
      throw new SearchGatewayError('Codex CLI is not installed', 'unavailable');
    }
    if (!status.loginActive) {
      throw new SearchGatewayError('Codex CLI is not logged in', 'auth_error');
    }

    const scratchDir = path.join(
      this.config.scratchRoot,
      `${safeSessionSlug(input.sessionId || 'search')}-${randomUUID()}`,
    );
    fs.mkdirSync(scratchDir, { recursive: true, mode: 0o700 });
    try {
      const finalPath = path.join(scratchDir, 'search.json');
      const result = await this.runner.run({
        command: this.config.command,
        args: codexExecArgs({
          scratchDir,
          finalPath,
          model: this.config.model,
          reasoningEffort: this.config.reasoningEffort,
          enableWebSearch: true,
        }),
        stdin: buildSearchPrompt({
          query,
          maxResults: this.config.maxResults,
        }),
        cwd: scratchDir,
        timeoutMs: this.config.timeoutMs,
        maxStdoutBytes: 128 * 1024,
        maxStderrBytes: 32 * 1024,
      });

      if (result.timedOut) {
        throw new SearchGatewayError('SearchGateway timed out', 'timeout');
      }
      if (result.exitCode !== 0) {
        throw new SearchGatewayError(
          `SearchGateway failed with exit code ${result.exitCode}`,
          'runtime_error',
        );
      }
      const finalText = fs.existsSync(finalPath)
        ? fs.readFileSync(finalPath, 'utf8')
        : result.stdout;
      if (!finalText.trim()) {
        throw new SearchGatewayError(
          'SearchGateway returned empty output',
          'empty_output',
        );
      }
      return normalizeSearchResponse(parseJsonObject(finalText), {
        query,
        provider: this.config.provider,
        maxResults: this.config.maxResults,
        maxSnippetChars: this.config.maxSnippetChars,
      });
    } finally {
      fs.rmSync(scratchDir, { recursive: true, force: true });
    }
  }
}

export function createSearchGateway(
  config: Partial<SearchGatewayConfig> = {},
  runner?: CodexProcessRunner,
): CodexSearchGateway {
  return new CodexSearchGateway(config, runner);
}
