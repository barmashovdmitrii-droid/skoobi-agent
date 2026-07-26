import { createHash } from 'crypto';
import fs from 'fs';

import type {
  CalendarAdapter,
  CalendarEventRecord,
  ListCalendarEventsInput,
} from './calendar-adapter.js';
import { readEnvFile } from './env.js';
import type {
  GoogleWorkspaceOperation,
  Sha256Hex,
  SheetCell,
} from './google-workspace-operation.js';

const GOOGLE_WORKSPACE_ENV_KEYS = [
  'SKOOBI_GOOGLE_WORKSPACE_ENABLED',
  'SKOOBI_GOOGLE_WORKSPACE_OAUTH_CLIENT_ID',
  'SKOOBI_GOOGLE_WORKSPACE_OAUTH_CLIENT_SECRET',
  'SKOOBI_GOOGLE_WORKSPACE_REFRESH_TOKEN',
  'SKOOBI_GOOGLE_WORKSPACE_REFRESH_TOKEN_FILE',
  'SKOOBI_GOOGLE_WORKSPACE_SCOPES',
  'SKOOBI_GOOGLE_WORKSPACE_DEFAULT_SCRIPT_ID',
  'SKOOBI_GOOGLE_WORKSPACE_REQUEST_TIMEOUT_MS',
  'SKOOBI_GOOGLE_WORKSPACE_MAX_RESPONSE_BYTES',
] as const;

export const DEFAULT_GOOGLE_WORKSPACE_REQUEST_TIMEOUT_MS = 20_000;
export const DEFAULT_GOOGLE_WORKSPACE_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
export const MAX_GOOGLE_DOC_MARKDOWN_BYTES = 1024 * 1024;
export const MAX_GOOGLE_SHEET_VALUE_BYTES = 1024 * 1024;
export const MAX_GOOGLE_SHEET_CELLS = 10_000;
export const MAX_GOOGLE_APPS_SCRIPT_SOURCE_BYTES = 1024 * 1024;

const MAX_ERROR_DETAIL_CHARS = 768;
const MAX_TOKEN_RESPONSE_BYTES = 64 * 1024;
const MAX_REFRESH_TOKEN_FILE_BYTES = 16 * 1024;
const MAX_DRIVE_RESULTS = 100;
const MAX_CALENDAR_RESULTS = 100;
const MAX_GMAIL_RESULTS = 25;
const MAX_GMAIL_THREAD_MESSAGES = 100;
const MAX_GMAIL_MIME_DEPTH = 16;
const MAX_GMAIL_MIME_PARTS = 256;
const MAX_GMAIL_MESSAGE_BODY_BYTES = 64 * 1024;
const MAX_GMAIL_THREAD_BODY_BYTES = 256 * 1024;
const MAX_GMAIL_DECODED_PART_BYTES = 2 * 1024 * 1024;
const MAX_GMAIL_SNIPPET_CHARS = 512;
const MAX_GMAIL_HEADER_CHARS = 4096;
const MAX_SHEET_ROWS = 1_000;
const MAX_SHEET_COLUMNS = 100;
const MAX_SCRIPT_FILES = 256;

const GOOGLE_ID_RE = /^[A-Za-z0-9_-]{1,256}$/;
const SHA256_RE = /^[a-f0-9]{64}$/;

const DRIVE_TYPE_MIME = {
  sheet: 'application/vnd.google-apps.spreadsheet',
  doc: 'application/vnd.google-apps.document',
  folder: 'application/vnd.google-apps.folder',
} as const;

type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface GoogleWorkspaceHostConfig {
  enabled: boolean;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  scopes: string[];
  defaultScriptId: string;
  requestTimeoutMs: number;
  maxResponseBytes: number;
}

export type GoogleWorkspaceClientErrorCode =
  | 'disabled'
  | 'invalid_input'
  | 'timeout'
  | 'network_error'
  | 'response_too_large'
  | 'invalid_response'
  | 'http_error'
  | 'conflict'
  | 'unavailable';

/**
 * A deliberately low-detail error safe to return across the host/runner IPC
 * boundary. It never contains request headers or bodies, and every upstream
 * detail is redacted and bounded before it reaches `message`.
 */
export class GoogleWorkspaceClientError extends Error {
  readonly code: GoogleWorkspaceClientErrorCode;
  readonly status?: number;
  readonly outcomeUncertain: boolean;

  constructor(
    code: GoogleWorkspaceClientErrorCode,
    message: string,
    options: { status?: number; outcomeUncertain?: boolean } = {},
  ) {
    super(message);
    this.name = 'GoogleWorkspaceClientError';
    this.code = code;
    this.status = options.status;
    this.outcomeUncertain = options.outcomeUncertain === true;
  }
}

export interface DriveFileRecord {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime: string | null;
  webViewLink: string | null;
  parents: string[];
}

export interface DriveListFilesInput {
  query?: string;
  contentQuery?: string;
  type?: 'sheet' | 'doc' | 'folder' | 'any';
  folderId?: string;
  rootOnly?: boolean;
  maxResults?: number;
}

export interface DriveListFilesResult {
  files: DriveFileRecord[];
}

export interface DriveCreateFileInput {
  kind: 'sheet' | 'doc';
  title: string;
  contentMarkdown?: string;
  folderId?: string;
}

export interface DriveCreateFileResult {
  id: string;
  url: string;
  name: string;
  revisionId?: string;
}

export interface GoogleDocsReadResult {
  documentId: string;
  title: string;
  markdown: string;
  revisionId: string;
  digest: Sha256Hex;
}

export interface GoogleDocsReplaceInput {
  documentId: string;
  contentMarkdown: string;
  expectedRevisionId?: string;
  expectedDigest?: Sha256Hex | string;
}

export interface GoogleDocsReplaceResult {
  documentId: string;
  previousRevisionId: string;
  revisionId: string | null;
  digest: Sha256Hex;
  requestCount: number;
}

export interface GoogleSheetsGetInput {
  spreadsheetId: string;
  range: string;
}

export interface GoogleSheetsGetResult {
  spreadsheetId: string;
  range: string;
  majorDimension: 'ROWS';
  values: SheetCell[][];
  digest: Sha256Hex;
}

export interface GoogleSheetsUpdateInput extends GoogleSheetsGetInput {
  values: SheetCell[][];
  inputMode?: 'raw' | 'user_entered';
  expectedDigest: Sha256Hex | string;
}

export interface GoogleSheetsUpdateResult {
  spreadsheetId: string;
  range: string;
  inputMode: 'raw' | 'user_entered';
  previousDigest: Sha256Hex;
  updatedRange: string | null;
  updatedRows: number | null;
  updatedColumns: number | null;
  updatedCells: number | null;
}

export interface GoogleSheetsAppendInput extends GoogleSheetsGetInput {
  values: SheetCell[][];
  expectedDigest: Sha256Hex | string;
}

export interface GoogleSheetsAppendResult {
  spreadsheetId: string;
  range: string;
  inputMode: 'raw';
  previousDigest: Sha256Hex;
  updatedRange: string | null;
  updatedRows: number | null;
  updatedColumns: number | null;
  updatedCells: number | null;
}

export type AppsScriptFileType = 'SERVER_JS' | 'HTML' | 'JSON';

export interface AppsScriptFile {
  name: string;
  type: AppsScriptFileType;
  source: string;
}

export interface GoogleAppsScriptGetResult {
  scriptId: string;
  files: AppsScriptFile[];
  digest: Sha256Hex;
}

export interface GoogleAppsScriptUpdateInput {
  scriptId: string;
  fileName: string;
  source: string;
  newFileType?: AppsScriptFileType;
  expectedDigest: Sha256Hex | string;
}

export interface GoogleAppsScriptUpdateResult {
  scriptId: string;
  updated: string;
  fileCount: number;
  created: boolean;
  previousDigest: Sha256Hex;
  digest: Sha256Hex;
}

export interface GmailSearchThreadsInput {
  query?: string;
  maxResults?: number;
}

export interface GmailThreadSummary {
  threadId: string;
  snippet: string;
}

export interface GmailSearchThreadsResult {
  threads: GmailThreadSummary[];
  resultSizeEstimate: number | null;
  hasMore: boolean;
}

export interface GmailGetThreadInput {
  threadId: string;
}

export interface GmailMessageRecord {
  messageId: string;
  receivedAt: string | null;
  date: string;
  from: string;
  to: string;
  cc: string;
  subject: string;
  snippet: string;
  labelIds: string[];
  bodyText: string;
  bodyTruncated: boolean;
  hasAttachments: boolean;
}

export interface GmailGetThreadResult {
  threadId: string;
  messages: GmailMessageRecord[];
  omittedMessageCount: number;
  bodyTruncated: boolean;
}

export interface GoogleWorkspaceStatusResult {
  enabled: boolean;
  ready: boolean;
  client_id_set: boolean;
  client_secret_set: boolean;
  refresh_token_set: boolean;
  configured_scopes: string[];
  default_script_id_set: boolean;
  calendar_configured: boolean;
  /** Live OAuth + Drive-about check only; other API scopes are not implied. */
  drive_verified?: boolean;
  account?: string;
  account_name?: string;
  calendar_verified?: boolean;
  reason?: string;
}

interface GoogleDocumentMetadata {
  documentId: string;
  title: string;
  revisionId: string;
  endIndex: number;
}

interface BoundedFetchResult {
  ok: boolean;
  status: number;
  text: string;
}

interface RequestOptions {
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
  maxResponseBytes?: number;
  sideEffect?: boolean;
}

export interface GoogleWorkspaceClientDependencies {
  fetch?: FetchLike;
  calendarAdapter?: CalendarAdapter | null;
  now?: () => number;
}

function parseBoundedPositiveInt(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const parsed = Number.parseInt(value || '', 10);
  if (!Number.isFinite(parsed) || parsed < minimum) return fallback;
  return Math.min(Math.trunc(parsed), maximum);
}

function readSecureRefreshTokenFile(filePath: string): string {
  const flags =
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK;
  let fd: number | null = null;
  try {
    fd = fs.openSync(filePath, flags);
    const before = fs.fstatSync(fd);
    if (
      !before.isFile() ||
      before.nlink !== 1 ||
      before.size <= 0 ||
      before.size > MAX_REFRESH_TOKEN_FILE_BYTES ||
      (before.mode & 0o077) !== 0
    ) {
      throw new Error('unsafe refresh-token file metadata');
    }
    const buffer = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < buffer.length) {
      const count = fs.readSync(
        fd,
        buffer,
        offset,
        buffer.length - offset,
        null,
      );
      if (count <= 0) break;
      offset += count;
    }
    const probe = Buffer.allocUnsafe(1);
    const extra = fs.readSync(fd, probe, 0, 1, null);
    const after = fs.fstatSync(fd);
    if (
      offset !== before.size ||
      extra !== 0 ||
      !after.isFile() ||
      after.nlink !== 1 ||
      after.size !== before.size ||
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.mode !== before.mode ||
      after.uid !== before.uid ||
      after.gid !== before.gid ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs ||
      (after.mode & 0o077) !== 0
    ) {
      throw new Error('refresh-token file changed while reading');
    }
    const token = buffer.toString('utf8').trim();
    if (
      !token ||
      byteLength(token) > MAX_REFRESH_TOKEN_FILE_BYTES ||
      /\s/.test(token)
    ) {
      throw new Error('invalid refresh-token file contents');
    }
    return token;
  } catch {
    // Do not echo the path, file contents, or the underlying OS error across a
    // config/status boundary. Operators can inspect the host file directly.
    throw new GoogleWorkspaceClientError(
      'invalid_input',
      'Google Workspace refresh-token file is unsafe or unreadable.',
    );
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // Best effort close after a failed bounded read.
      }
    }
  }
}

/** Host-only config loader. Secrets are read here, never in agent/runner. */
export function loadGoogleWorkspaceHostConfig(
  env: Record<string, string | undefined> = process.env,
): GoogleWorkspaceHostConfig {
  const fileEnv = readEnvFile([...GOOGLE_WORKSPACE_ENV_KEYS]);
  const get = (key: (typeof GOOGLE_WORKSPACE_ENV_KEYS)[number]) =>
    env[key] || fileEnv[key] || '';
  const refreshTokenFile = get('SKOOBI_GOOGLE_WORKSPACE_REFRESH_TOKEN_FILE');
  const refreshToken = refreshTokenFile
    ? readSecureRefreshTokenFile(refreshTokenFile)
    : get('SKOOBI_GOOGLE_WORKSPACE_REFRESH_TOKEN');
  return {
    enabled: /^(1|true|yes|on)$/i.test(get('SKOOBI_GOOGLE_WORKSPACE_ENABLED')),
    clientId: get('SKOOBI_GOOGLE_WORKSPACE_OAUTH_CLIENT_ID'),
    clientSecret: get('SKOOBI_GOOGLE_WORKSPACE_OAUTH_CLIENT_SECRET'),
    refreshToken,
    scopes: get('SKOOBI_GOOGLE_WORKSPACE_SCOPES')
      .split(/[\s,]+/)
      .map((scope) => scope.trim())
      .filter(Boolean),
    defaultScriptId: get('SKOOBI_GOOGLE_WORKSPACE_DEFAULT_SCRIPT_ID'),
    requestTimeoutMs: parseBoundedPositiveInt(
      get('SKOOBI_GOOGLE_WORKSPACE_REQUEST_TIMEOUT_MS'),
      DEFAULT_GOOGLE_WORKSPACE_REQUEST_TIMEOUT_MS,
      100,
      120_000,
    ),
    maxResponseBytes: parseBoundedPositiveInt(
      get('SKOOBI_GOOGLE_WORKSPACE_MAX_RESPONSE_BYTES'),
      DEFAULT_GOOGLE_WORKSPACE_MAX_RESPONSE_BYTES,
      1024,
      16 * 1024 * 1024,
    ),
  };
}

export function googleWorkspaceHostUnavailableReason(
  config: GoogleWorkspaceHostConfig,
): string | null {
  if (!config.enabled) return 'Google Workspace integration is disabled.';
  const missing: string[] = [];
  if (!config.clientId) missing.push('OAuth client ID');
  if (!config.clientSecret) missing.push('OAuth client secret');
  if (!config.refreshToken) missing.push('OAuth refresh token');
  return missing.length > 0
    ? `Google Workspace integration is missing: ${missing.join(', ')}.`
    : null;
}

function failInput(message: string): never {
  throw new GoogleWorkspaceClientError('invalid_input', message);
}

function boundedString(
  value: unknown,
  label: string,
  maxChars: number,
  allowEmpty = false,
): string {
  if (typeof value !== 'string') failInput(`${label} must be a string.`);
  if ((!allowEmpty && value.trim().length === 0) || value.length > maxChars) {
    failInput(`${label} is empty or exceeds ${maxChars} characters.`);
  }
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) {
    failInput(`${label} contains unsupported control characters.`);
  }
  return value;
}

function googleId(value: unknown, label: string): string {
  const result = boundedString(value, label, 256);
  if (!GOOGLE_ID_RE.test(result)) failInput(`${label} is malformed.`);
  return result;
}

function sha256Digest(value: unknown, label: string): Sha256Hex {
  const result = boundedString(value, label, 64).toLowerCase();
  if (!SHA256_RE.test(result)) failInput(`${label} must be a SHA-256 digest.`);
  return result as Sha256Hex;
}

function jsonDigest(value: unknown): Sha256Hex {
  return createHash('sha256')
    .update(JSON.stringify(value))
    .digest('hex') as Sha256Hex;
}

export function googleDocumentMarkdownDigest(markdown: string): Sha256Hex {
  return createHash('sha256').update(markdown).digest('hex') as Sha256Hex;
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function redactErrorText(
  raw: string,
  config: GoogleWorkspaceHostConfig,
  additionalSecrets: string[] = [],
): string {
  let text = String(raw || '')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/Bearer\s+[A-Za-z0-9._~-]+/gi, 'Bearer [REDACTED]')
    .replace(
      /((?:access|refresh|id)_token|client_secret)\s*[=:]\s*["']?[^\s,"'}]+/gi,
      '$1=[REDACTED]',
    );
  const exactSecrets = [
    config.clientSecret,
    config.refreshToken,
    ...additionalSecrets,
    ...(config.clientId.length >= 4 ? [config.clientId] : []),
  ];
  for (const secret of exactSecrets) {
    if (secret) {
      for (const representation of [secret, encodeURIComponent(secret)]) {
        text = text.split(representation).join('[REDACTED]');
      }
    }
  }
  text = text.replace(/\s+/g, ' ').trim();
  return text.slice(0, MAX_ERROR_DETAIL_CHARS);
}

async function readResponseBodyBounded(
  response: Response,
  maxBytes: number,
): Promise<string> {
  const declared = response.headers.get('content-length');
  if (declared && Number(declared) > maxBytes) {
    try {
      await response.body?.cancel();
    } catch {
      // Best effort: the caller is already rejecting the oversized response.
    }
    throw new GoogleWorkspaceClientError(
      'response_too_large',
      `Google response exceeds the ${maxBytes}-byte limit.`,
      { status: response.status },
    );
  }
  if (!response.body) return '';

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        try {
          await reader.cancel();
        } catch {
          // Best effort cancellation after the hard cap fired.
        }
        throw new GoogleWorkspaceClientError(
          'response_too_large',
          `Google response exceeds the ${maxBytes}-byte limit.`,
          { status: response.status },
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(
    chunks.map((chunk) => Buffer.from(chunk)),
    total,
  ).toString('utf8');
}

/** Escape a string embedded in a single-quoted Drive query literal. */
export function escapeGoogleDriveQueryLiteral(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

interface InlineStyle {
  start: number;
  end: number;
  kind: 'bold' | 'italic';
}

function renderInlineMarkdown(value: string): {
  text: string;
  styles: InlineStyle[];
} {
  let text = '';
  const styles: InlineStyle[] = [];
  let cursor = 0;
  const appendStyled = (content: string, kind: InlineStyle['kind']): void => {
    const start = text.length;
    text += content;
    if (content.length > 0) styles.push({ start, end: text.length, kind });
  };

  while (cursor < value.length) {
    if (value[cursor] === '\\' && cursor + 1 < value.length) {
      text += value[cursor + 1];
      cursor += 2;
      continue;
    }
    const image = /^!\[([^\]\n]{0,512})\]\([^\)\n]{1,2048}\)/.exec(
      value.slice(cursor),
    );
    if (image) {
      text += image[1];
      cursor += image[0].length;
      continue;
    }
    const link = /^\[([^\]\n]{1,1024})\]\([^\)\n]{1,2048}\)/.exec(
      value.slice(cursor),
    );
    if (link) {
      // Keep only the user-visible label. Creating active links from imported
      // untrusted Markdown would add a second, surprising navigation surface.
      text += link[1];
      cursor += link[0].length;
      continue;
    }
    const pair = value.startsWith('**', cursor)
      ? '**'
      : value.startsWith('__', cursor)
        ? '__'
        : null;
    if (pair) {
      const end = value.indexOf(pair, cursor + 2);
      if (end > cursor + 2) {
        appendStyled(value.slice(cursor + 2, end), 'bold');
        cursor = end + 2;
        continue;
      }
    }
    if (value[cursor] === '*' || value[cursor] === '_') {
      const marker = value[cursor];
      const end = value.indexOf(marker, cursor + 1);
      if (end > cursor + 1) {
        appendStyled(value.slice(cursor + 1, end), 'italic');
        cursor = end + 1;
        continue;
      }
    }
    if (value[cursor] === '`') {
      const end = value.indexOf('`', cursor + 1);
      if (end > cursor + 1) {
        // Inline code stays plain text. Deliberately do not create smart chips,
        // links, formulas, or other executable/interactive Docs structures.
        text += value.slice(cursor + 1, end);
        cursor = end + 1;
        continue;
      }
    }
    text += value[cursor];
    cursor += 1;
  }
  return { text, styles };
}

export interface BasicMarkdownDocsConversion {
  text: string;
  requests: Array<Record<string, unknown>>;
}

/**
 * Convert a deliberately small Markdown subset to plain Docs text plus style
 * requests. Unsupported Markdown remains inert text; raw HTML and link targets
 * are never interpreted by the client.
 */
export function convertBasicMarkdownToDocs(
  markdown: string,
): BasicMarkdownDocsConversion {
  boundedString(
    markdown,
    'contentMarkdown',
    MAX_GOOGLE_DOC_MARKDOWN_BYTES,
    true,
  );
  if (byteLength(markdown) > MAX_GOOGLE_DOC_MARKDOWN_BYTES) {
    failInput(
      `contentMarkdown exceeds ${MAX_GOOGLE_DOC_MARKDOWN_BYTES} UTF-8 bytes.`,
    );
  }
  const normalized = markdown.replace(/\r\n?/g, '\n').replace(/\u0000/g, '');
  if (!normalized) return { text: '', requests: [] };

  const lines = normalized.replace(/\n+$/g, '').split('\n');
  let text = '';
  const textStyles: InlineStyle[] = [];
  const paragraphRequests: Array<Record<string, unknown>> = [];

  for (const rawLine of lines) {
    const lineStart = text.length;
    const heading = /^(#{1,6})\s+(.+)$/.exec(rawLine);
    const unordered = /^\s*[-*+]\s+(.+)$/.exec(rawLine);
    const ordered = /^\s*\d+[.)]\s+(.+)$/.exec(rawLine);
    const visible = heading?.[2] ?? unordered?.[1] ?? ordered?.[1] ?? rawLine;
    const inline = renderInlineMarkdown(visible);
    text += inline.text;
    for (const style of inline.styles) {
      textStyles.push({
        start: lineStart + style.start,
        end: lineStart + style.end,
        kind: style.kind,
      });
    }
    text += '\n';
    const paragraphRange = {
      startIndex: 1 + lineStart,
      endIndex: 1 + text.length,
    };
    if (heading) {
      paragraphRequests.push({
        updateParagraphStyle: {
          range: paragraphRange,
          paragraphStyle: {
            namedStyleType: `HEADING_${heading[1].length}`,
          },
          fields: 'namedStyleType',
        },
      });
    } else if (unordered || ordered) {
      paragraphRequests.push({
        createParagraphBullets: {
          range: paragraphRange,
          bulletPreset: unordered
            ? 'BULLET_DISC_CIRCLE_SQUARE'
            : 'NUMBERED_DECIMAL_NESTED',
        },
      });
    }
  }

  const styleRequests = textStyles
    .filter((style) => style.end > style.start)
    .map((style) => ({
      updateTextStyle: {
        range: {
          startIndex: 1 + style.start,
          endIndex: 1 + style.end,
        },
        textStyle: { [style.kind]: true },
        fields: style.kind,
      },
    }));
  return { text, requests: [...paragraphRequests, ...styleRequests] };
}

function normalizeSheetValues(raw: unknown): SheetCell[][] {
  if (!Array.isArray(raw)) return [];
  const rows: SheetCell[][] = [];
  let cells = 0;
  if (raw.length > MAX_SHEET_ROWS)
    failInput('Sheet response has too many rows.');
  for (const rawRow of raw) {
    if (!Array.isArray(rawRow) || rawRow.length > MAX_SHEET_COLUMNS) {
      failInput('Sheet values must be a bounded two-dimensional array.');
    }
    const row: SheetCell[] = [];
    for (const rawCell of rawRow) {
      if (
        rawCell !== null &&
        typeof rawCell !== 'string' &&
        typeof rawCell !== 'number' &&
        typeof rawCell !== 'boolean'
      ) {
        failInput('Sheet values contain an unsupported cell type.');
      }
      if (typeof rawCell === 'number' && !Number.isFinite(rawCell)) {
        failInput('Sheet values contain a non-finite number.');
      }
      if (typeof rawCell === 'string' && rawCell.length > 50_000) {
        failInput('A Sheet cell exceeds the 50000-character limit.');
      }
      row.push(rawCell as SheetCell);
      cells += 1;
      if (cells > MAX_GOOGLE_SHEET_CELLS) {
        failInput(`Sheet values exceed ${MAX_GOOGLE_SHEET_CELLS} cells.`);
      }
    }
    rows.push(row);
  }
  if (byteLength(JSON.stringify(rows)) > MAX_GOOGLE_SHEET_VALUE_BYTES) {
    failInput(`Sheet values exceed ${MAX_GOOGLE_SHEET_VALUE_BYTES} bytes.`);
  }
  return rows;
}

function sheetRangeColumnCount(range: string): number {
  const rangePart = range.slice(range.lastIndexOf('!') + 1);
  const [start, end = start] = rangePart.split(':', 2);
  const columnNumber = (cell: string): number => {
    const match = /^\$?([A-Za-z]{1,3})(?:\$?[1-9]\d{0,6})?$/.exec(cell);
    if (!match) failInput('Sheet append range must be exact A1 notation.');
    let result = 0;
    for (const char of match[1].toUpperCase()) {
      result = result * 26 + char.charCodeAt(0) - 64;
    }
    return result;
  };
  const first = columnNumber(start);
  const last = columnNumber(end);
  if (last < first) failInput('Sheet append range columns are reversed.');
  return last - first + 1;
}

export function googleSheetValuesDigest(
  spreadsheetId: string,
  range: string,
  values: SheetCell[][],
): Sha256Hex {
  return jsonDigest({
    spreadsheetId,
    range,
    majorDimension: 'ROWS',
    values,
  });
}

function normalizeAppsScriptFiles(raw: unknown): AppsScriptFile[] {
  if (!Array.isArray(raw) || raw.length > MAX_SCRIPT_FILES) {
    throw new GoogleWorkspaceClientError(
      'invalid_response',
      'Google Apps Script returned an invalid file list.',
    );
  }
  const seen = new Set<string>();
  const files = raw.map((entry): AppsScriptFile => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new GoogleWorkspaceClientError(
        'invalid_response',
        'Google Apps Script returned an invalid file.',
      );
    }
    const record = entry as Record<string, unknown>;
    const name = boundedString(record.name, 'Apps Script file name', 256);
    if (/[/\\]/.test(name) || seen.has(name)) {
      throw new GoogleWorkspaceClientError(
        'invalid_response',
        'Google Apps Script returned duplicate or malformed file names.',
      );
    }
    seen.add(name);
    if (
      record.type !== 'SERVER_JS' &&
      record.type !== 'HTML' &&
      record.type !== 'JSON'
    ) {
      throw new GoogleWorkspaceClientError(
        'invalid_response',
        'Google Apps Script returned an unsupported file type.',
      );
    }
    const source = boundedString(
      record.source ?? '',
      'Apps Script source',
      MAX_GOOGLE_APPS_SCRIPT_SOURCE_BYTES,
      true,
    );
    if (byteLength(source) > MAX_GOOGLE_APPS_SCRIPT_SOURCE_BYTES) {
      throw new GoogleWorkspaceClientError(
        'invalid_response',
        'Google Apps Script source exceeds the configured limit.',
      );
    }
    return { name, type: record.type, source };
  });
  return files.sort((left, right) =>
    left.name === right.name
      ? left.type.localeCompare(right.type)
      : left.name.localeCompare(right.name),
  );
}

export function googleAppsScriptFilesDigest(
  files: AppsScriptFile[],
): Sha256Hex {
  return jsonDigest(files);
}

interface GmailMimeCollection {
  partsSeen: number;
  truncated: boolean;
  hasAttachments: boolean;
  plain: string[];
  html: string[];
}

function invalidGmailResponse(message: string): never {
  throw new GoogleWorkspaceClientError(
    'invalid_response',
    `Gmail returned ${message}.`,
  );
}

function gmailProviderText(
  value: unknown,
  maxChars: number,
  allowNewlines = false,
): string {
  if (typeof value !== 'string') return '';
  const controls = allowNewlines
    ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g
    : /[\u0000-\u001f\u007f]/g;
  return value.replace(/\r\n?/g, '\n').replace(controls, '').slice(0, maxChars);
}

function gmailHeader(headers: unknown, wantedName: string): string {
  if (!Array.isArray(headers)) return '';
  const wanted = wantedName.toLowerCase();
  for (const entry of headers.slice(0, 256)) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    if (
      typeof record.name === 'string' &&
      record.name.toLowerCase() === wanted
    ) {
      return gmailProviderText(record.value, MAX_GMAIL_HEADER_CHARS);
    }
  }
  return '';
}

function gmailPartCharset(headers: unknown): string | null {
  const contentType = gmailHeader(headers, 'content-type');
  const match =
    /(?:^|;)\s*charset\s*=\s*(?:"([^"]+)"|'([^']+)'|([^;\s]+))/i.exec(
      contentType,
    );
  const charset = (match?.[1] || match?.[2] || match?.[3] || '').trim();
  return /^[A-Za-z0-9._-]{1,40}$/.test(charset) ? charset : null;
}

function decodeGmailBodyData(data: unknown, charset: string | null): string {
  if (typeof data !== 'string') return '';
  const unpadded = data.replace(/=+$/g, '');
  if (
    !/^[A-Za-z0-9_-]*={0,2}$/.test(data) ||
    data.length - unpadded.length > 2 ||
    unpadded.length > Math.ceil((MAX_GMAIL_DECODED_PART_BYTES * 4) / 3)
  ) {
    invalidGmailResponse('malformed message body data');
  }
  const decoded = Buffer.from(unpadded, 'base64url');
  if (
    decoded.length > MAX_GMAIL_DECODED_PART_BYTES ||
    decoded.toString('base64url') !== unpadded
  ) {
    invalidGmailResponse('malformed message body data');
  }
  try {
    try {
      return new TextDecoder(charset || 'utf-8').decode(decoded);
    } catch {
      return new TextDecoder('utf-8').decode(decoded);
    }
  } finally {
    decoded.fill(0);
  }
}

function decodeBasicHtmlEntities(value: string): string {
  const named: Record<string, string> = {
    amp: '&',
    apos: "'",
    gt: '>',
    lt: '<',
    nbsp: ' ',
    quot: '"',
  };
  return value.replace(
    /&(?:#(\d{1,7})|#x([0-9a-f]{1,6})|([a-z]{2,10}));/gi,
    (match, decimal: string, hexadecimal: string, entity: string) => {
      if (entity) return named[entity.toLowerCase()] ?? match;
      const codePoint = Number.parseInt(
        decimal || hexadecimal,
        hexadecimal ? 16 : 10,
      );
      return Number.isSafeInteger(codePoint) &&
        codePoint > 0 &&
        codePoint <= 0x10ffff &&
        !(codePoint >= 0xd800 && codePoint <= 0xdfff)
        ? String.fromCodePoint(codePoint)
        : '';
    },
  );
}

function normalizeGmailBodyText(value: string): string {
  return value
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function gmailHtmlToText(html: string): string {
  const withoutActiveRegions = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(
      /<(?:script|style|head|svg|noscript)\b[^>]*>[\s\S]*?<\/(?:script|style|head|svg|noscript)\s*>/gi,
      ' ',
    )
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(
      /<\/?(?:address|article|aside|blockquote|div|footer|h[1-6]|header|hr|li|main|nav|ol|p|pre|section|table|tr|ul)\b[^>]*>/gi,
      '\n',
    )
    .replace(/<[^>]*>/g, ' ');
  return normalizeGmailBodyText(
    decodeBasicHtmlEntities(withoutActiveRegions).replace(/[ \t]{2,}/g, ' '),
  );
}

function truncateUtf8(
  value: string,
  maxBytes: number,
): { value: string; truncated: boolean } {
  const encoded = Buffer.from(value, 'utf8');
  if (encoded.length <= maxBytes) return { value, truncated: false };
  if (maxBytes <= 0) return { value: '', truncated: value.length > 0 };
  for (let end = Math.min(maxBytes, encoded.length); end > 0; end -= 1) {
    try {
      return {
        value: new TextDecoder('utf-8', { fatal: true }).decode(
          encoded.subarray(0, end),
        ),
        truncated: true,
      };
    } catch {
      // At most three bytes can belong to a partial trailing UTF-8 sequence.
    }
  }
  return { value: '', truncated: true };
}

function collectGmailMimeText(
  rawPart: unknown,
  depth: number,
  state: GmailMimeCollection,
): void {
  if (depth > MAX_GMAIL_MIME_DEPTH || state.partsSeen >= MAX_GMAIL_MIME_PARTS) {
    state.truncated = true;
    return;
  }
  if (!rawPart || typeof rawPart !== 'object' || Array.isArray(rawPart)) {
    invalidGmailResponse('a malformed MIME part');
  }
  state.partsSeen += 1;
  const part = rawPart as Record<string, unknown>;
  const headers = part.headers;
  const filename = gmailProviderText(part.filename, 512).trim();
  const contentDisposition = gmailHeader(headers, 'content-disposition');
  const body =
    part.body && typeof part.body === 'object' && !Array.isArray(part.body)
      ? (part.body as Record<string, unknown>)
      : null;
  const mimeType = gmailProviderText(part.mimeType, 128).toLowerCase();
  const explicitAttachment =
    Boolean(filename) ||
    /(?:^|;)\s*attachment(?:\s*;|$)/i.test(contentDisposition);
  const externalBody = typeof body?.attachmentId === 'string';
  state.hasAttachments ||=
    explicitAttachment ||
    (externalBody &&
      mimeType !== '' &&
      mimeType !== 'text/plain' &&
      mimeType !== 'text/html');
  if (explicitAttachment) return;
  if (externalBody) {
    // Gmail may externalize a large inline text body behind attachmentId.
    // The read-only connector deliberately never downloads attachment data,
    // but it must report that the visible body is incomplete.
    if (
      mimeType === '' ||
      mimeType === 'text/plain' ||
      mimeType === 'text/html'
    ) {
      state.truncated = true;
    }
    return;
  }

  if (Array.isArray(part.parts) && part.parts.length > 0) {
    for (const child of part.parts) {
      collectGmailMimeText(child, depth + 1, state);
    }
    return;
  }
  if (part.parts !== undefined && !Array.isArray(part.parts)) {
    invalidGmailResponse('a malformed MIME tree');
  }
  if (
    typeof body?.data !== 'string' ||
    (mimeType !== 'text/html' && mimeType !== 'text/plain' && mimeType !== '')
  ) {
    return;
  }
  const decoded = decodeGmailBodyData(body.data, gmailPartCharset(headers));
  if (mimeType === 'text/html') {
    state.html.push(decoded);
  } else if (mimeType === 'text/plain' || mimeType === '') {
    state.plain.push(decoded);
  }
}

function extractGmailBody(payload: unknown): {
  bodyText: string;
  bodyTruncated: boolean;
  hasAttachments: boolean;
} {
  const state: GmailMimeCollection = {
    partsSeen: 0,
    truncated: false,
    hasAttachments: false,
    plain: [],
    html: [],
  };
  if (payload !== undefined && payload !== null) {
    collectGmailMimeText(payload, 0, state);
  }
  const plain = state.plain
    .map((text) => normalizeGmailBodyText(text))
    .filter(Boolean);
  const selected =
    plain.length > 0 ? plain : state.html.map((html) => gmailHtmlToText(html));
  const normalized = normalizeGmailBodyText(selected.join('\n\n'));
  const bounded = truncateUtf8(normalized, MAX_GMAIL_MESSAGE_BODY_BYTES);
  return {
    bodyText: bounded.value,
    bodyTruncated: state.truncated || bounded.truncated,
    hasAttachments: state.hasAttachments,
  };
}

function gmailReceivedAt(value: unknown): string | null {
  if (typeof value !== 'string' || !/^\d{1,16}$/.test(value)) return null;
  const milliseconds = Number(value);
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) return null;
  try {
    return new Date(milliseconds).toISOString();
  } catch {
    return null;
  }
}

export class GoogleWorkspaceClient {
  readonly config: GoogleWorkspaceHostConfig;

  private readonly fetchImpl: FetchLike;
  private readonly calendarAdapter: CalendarAdapter | null;
  private readonly now: () => number;
  private cachedAccessToken: { token: string; expiresAt: number } | null = null;

  constructor(
    config: GoogleWorkspaceHostConfig = loadGoogleWorkspaceHostConfig(),
    dependencies: GoogleWorkspaceClientDependencies = {},
  ) {
    this.config = config;
    this.fetchImpl = dependencies.fetch ?? globalThis.fetch.bind(globalThis);
    this.calendarAdapter = dependencies.calendarAdapter ?? null;
    this.now = dependencies.now ?? Date.now;
  }

  private assertReady(): void {
    const reason = googleWorkspaceHostUnavailableReason(this.config);
    if (reason) throw new GoogleWorkspaceClientError('disabled', reason);
  }

  private async fetchBounded(
    label: string,
    url: string,
    init: RequestInit,
    maxBytes: number,
    sideEffect = false,
  ): Promise<BoundedFetchResult> {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      this.config.requestTimeoutMs,
    );
    timeout.unref?.();
    try {
      const response = await this.fetchImpl(url, {
        ...init,
        signal: controller.signal,
      });
      const text = await readResponseBodyBounded(response, maxBytes);
      return { ok: response.ok, status: response.status, text };
    } catch (err) {
      if (err instanceof GoogleWorkspaceClientError) {
        if (sideEffect && !err.outcomeUncertain) {
          throw new GoogleWorkspaceClientError(err.code, err.message, {
            status: err.status,
            outcomeUncertain: true,
          });
        }
        throw err;
      }
      if (controller.signal.aborted) {
        throw new GoogleWorkspaceClientError(
          'timeout',
          `${label} timed out after ${this.config.requestTimeoutMs} ms.`,
          { outcomeUncertain: sideEffect },
        );
      }
      const detail = redactErrorText(
        err instanceof Error ? err.message : String(err),
        this.config,
        this.cachedAccessToken ? [this.cachedAccessToken.token] : [],
      );
      throw new GoogleWorkspaceClientError(
        'network_error',
        `${label} failed at the network boundary${detail ? `: ${detail}` : '.'}`,
        { outcomeUncertain: sideEffect },
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  private parseJson<T>(label: string, text: string): T {
    try {
      return JSON.parse(text || '{}') as T;
    } catch {
      throw new GoogleWorkspaceClientError(
        'invalid_response',
        `${label} returned malformed JSON.`,
      );
    }
  }

  private httpError(
    label: string,
    response: BoundedFetchResult,
    sideEffect = false,
  ): never {
    let upstreamStatus = '';
    let upstreamMessage = '';
    try {
      const parsed = JSON.parse(response.text || '{}') as {
        error?: { status?: unknown; message?: unknown } | string;
      };
      if (parsed.error && typeof parsed.error === 'object') {
        upstreamStatus =
          typeof parsed.error.status === 'string' ? parsed.error.status : '';
        upstreamMessage =
          typeof parsed.error.message === 'string' ? parsed.error.message : '';
      } else if (typeof parsed.error === 'string') {
        upstreamMessage = parsed.error;
      }
    } catch {
      upstreamMessage = response.text;
    }
    const detail = redactErrorText(
      [upstreamStatus, upstreamMessage].filter(Boolean).join(': '),
      this.config,
      this.cachedAccessToken ? [this.cachedAccessToken.token] : [],
    );
    const conflict =
      response.status === 409 ||
      upstreamStatus === 'ABORTED' ||
      upstreamStatus === 'FAILED_PRECONDITION';
    throw new GoogleWorkspaceClientError(
      conflict ? 'conflict' : 'http_error',
      `${label} failed (HTTP ${response.status})${detail ? `: ${detail}` : '.'}`,
      {
        status: response.status,
        // A conflict or ordinary 4xx response is a definite rejection. A
        // timeout/rate-limit/server response after a mutating request may have
        // arrived after Google committed it, so the broker must not retry.
        outcomeUncertain:
          sideEffect &&
          !conflict &&
          (response.status === 408 ||
            response.status === 429 ||
            response.status >= 500),
      },
    );
  }

  private async accessToken(): Promise<string> {
    this.assertReady();
    if (
      this.cachedAccessToken &&
      this.now() < this.cachedAccessToken.expiresAt
    ) {
      return this.cachedAccessToken.token;
    }
    const response = await this.fetchBounded(
      'Google OAuth token refresh',
      'https://oauth2.googleapis.com/token',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: this.config.clientId,
          client_secret: this.config.clientSecret,
          refresh_token: this.config.refreshToken,
          grant_type: 'refresh_token',
        }),
      },
      Math.min(this.config.maxResponseBytes, MAX_TOKEN_RESPONSE_BYTES),
    );
    if (!response.ok) this.httpError('Google OAuth token refresh', response);
    const parsed = this.parseJson<{
      access_token?: unknown;
      expires_in?: unknown;
    }>('Google OAuth token refresh', response.text);
    if (
      typeof parsed.access_token !== 'string' ||
      parsed.access_token.length < 8 ||
      parsed.access_token.length > 16 * 1024
    ) {
      throw new GoogleWorkspaceClientError(
        'invalid_response',
        'Google OAuth token refresh returned no usable access token.',
      );
    }
    const expiresIn =
      typeof parsed.expires_in === 'number' &&
      Number.isFinite(parsed.expires_in)
        ? Math.max(60, Math.trunc(parsed.expires_in))
        : 3600;
    this.cachedAccessToken = {
      token: parsed.access_token,
      expiresAt: this.now() + Math.max(60, expiresIn - 60) * 1000,
    };
    return parsed.access_token;
  }

  private async requestJson<T>(
    label: string,
    url: string,
    options: RequestOptions = {},
  ): Promise<T> {
    const token = await this.accessToken();
    const response = await this.fetchBounded(
      label,
      url,
      {
        method: options.method || 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
          ...(options.body === undefined
            ? {}
            : { 'Content-Type': 'application/json' }),
          ...options.headers,
        },
        body:
          options.body === undefined ? undefined : JSON.stringify(options.body),
      },
      options.maxResponseBytes ?? this.config.maxResponseBytes,
      options.sideEffect,
    );
    if (!response.ok) {
      this.httpError(label, response, options.sideEffect === true);
    }
    try {
      return this.parseJson<T>(label, response.text);
    } catch (err) {
      if (options.sideEffect && err instanceof GoogleWorkspaceClientError) {
        throw new GoogleWorkspaceClientError(err.code, err.message, {
          status: err.status,
          outcomeUncertain: true,
        });
      }
      throw err;
    }
  }

  private async requestText(
    label: string,
    url: string,
    options: RequestOptions = {},
  ): Promise<string> {
    const token = await this.accessToken();
    const response = await this.fetchBounded(
      label,
      url,
      {
        method: options.method || 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
          ...options.headers,
        },
      },
      options.maxResponseBytes ?? this.config.maxResponseBytes,
      options.sideEffect,
    );
    if (!response.ok) {
      this.httpError(label, response, options.sideEffect === true);
    }
    return response.text;
  }

  private async documentMetadata(
    documentId: string,
  ): Promise<GoogleDocumentMetadata> {
    const id = googleId(documentId, 'documentId');
    const params = new URLSearchParams({
      fields: 'documentId,title,revisionId,body.content.endIndex',
    });
    const raw = await this.requestJson<{
      documentId?: unknown;
      title?: unknown;
      revisionId?: unknown;
      body?: { content?: Array<{ endIndex?: unknown }> };
    }>(
      'Google Docs metadata read',
      `https://docs.googleapis.com/v1/documents/${encodeURIComponent(id)}?${params}`,
    );
    if (typeof raw.revisionId !== 'string' || !raw.revisionId) {
      throw new GoogleWorkspaceClientError(
        'invalid_response',
        'Google Docs returned no revision ID.',
      );
    }
    const endIndex = Math.max(
      2,
      ...(raw.body?.content || []).map((entry) =>
        typeof entry.endIndex === 'number' && Number.isFinite(entry.endIndex)
          ? Math.trunc(entry.endIndex)
          : 2,
      ),
    );
    return {
      documentId:
        typeof raw.documentId === 'string' && raw.documentId
          ? raw.documentId
          : id,
      title: typeof raw.title === 'string' ? raw.title : '',
      revisionId: raw.revisionId,
      endIndex,
    };
  }

  async status(verify = false): Promise<GoogleWorkspaceStatusResult> {
    const reason = googleWorkspaceHostUnavailableReason(this.config);
    const status: GoogleWorkspaceStatusResult = {
      enabled: this.config.enabled,
      ready: reason === null,
      client_id_set: Boolean(this.config.clientId),
      client_secret_set: Boolean(this.config.clientSecret),
      refresh_token_set: Boolean(this.config.refreshToken),
      configured_scopes: [...this.config.scopes],
      default_script_id_set: Boolean(this.config.defaultScriptId),
      calendar_configured: Boolean(this.calendarAdapter),
      ...(reason ? { reason } : {}),
    };
    if (!verify || reason) return status;

    const about = await this.requestJson<{
      user?: { displayName?: unknown; emailAddress?: unknown };
    }>(
      'Google Workspace verification',
      'https://www.googleapis.com/drive/v3/about?fields=user(displayName,emailAddress)',
    );
    status.drive_verified = true;
    status.account =
      typeof about.user?.emailAddress === 'string'
        ? about.user.emailAddress
        : 'unknown';
    status.account_name =
      typeof about.user?.displayName === 'string' ? about.user.displayName : '';
    if (this.calendarAdapter) {
      try {
        await this.calendarAdapter.listEvents({ maxResults: 1 });
        status.calendar_verified = true;
      } catch {
        status.calendar_verified = false;
      }
    }
    return status;
  }

  async driveListFiles(
    input: DriveListFilesInput,
  ): Promise<DriveListFilesResult> {
    const clauses = ['trashed = false'];
    if (input.rootOnly !== undefined && typeof input.rootOnly !== 'boolean') {
      failInput('rootOnly must be a boolean.');
    }
    const rootOnly = input.rootOnly === true;
    if (input.query !== undefined) {
      const query = boundedString(input.query, 'query', 512);
      clauses.push(`name contains '${escapeGoogleDriveQueryLiteral(query)}'`);
    }
    if (input.contentQuery !== undefined) {
      const query = boundedString(input.contentQuery, 'contentQuery', 512);
      clauses.push(
        `fullText contains '${escapeGoogleDriveQueryLiteral(query)}'`,
      );
    }
    const type = input.type ?? 'any';
    if (type !== 'any') {
      const mime = DRIVE_TYPE_MIME[type];
      if (!mime) failInput('Drive file type is invalid.');
      clauses.push(`mimeType = '${mime}'`);
    }
    if (input.folderId) {
      if (rootOnly) {
        failInput('rootOnly and folderId cannot be combined.');
      }
      const folderId = googleId(input.folderId, 'folderId');
      clauses.push(`'${escapeGoogleDriveQueryLiteral(folderId)}' in parents`);
    }
    if (rootOnly) clauses.push("'root' in parents");
    if (
      input.maxResults !== undefined &&
      (!Number.isFinite(input.maxResults) || input.maxResults <= 0)
    ) {
      failInput('maxResults must be a positive finite number.');
    }
    const maxResults = Math.min(
      MAX_DRIVE_RESULTS,
      Math.max(1, Math.trunc(input.maxResults ?? 25)),
    );
    const params = new URLSearchParams({
      q: clauses.join(' and '),
      pageSize: String(maxResults),
      fields: 'files(id,name,mimeType,modifiedTime,webViewLink,parents)',
      orderBy: 'modifiedTime desc',
      ...(rootOnly
        ? {}
        : {
            supportsAllDrives: 'true',
            includeItemsFromAllDrives: 'true',
          }),
    });
    const raw = await this.requestJson<{
      files?: Array<Record<string, unknown>>;
    }>(
      'Google Drive file list',
      `https://www.googleapis.com/drive/v3/files?${params}`,
    );
    const files = Array.isArray(raw.files) ? raw.files : [];
    return {
      files: files.slice(0, maxResults).flatMap((file) => {
        if (
          typeof file.id !== 'string' ||
          typeof file.name !== 'string' ||
          typeof file.mimeType !== 'string'
        ) {
          return [];
        }
        return [
          {
            id: file.id,
            name: file.name,
            mimeType: file.mimeType,
            modifiedTime:
              typeof file.modifiedTime === 'string' ? file.modifiedTime : null,
            webViewLink:
              typeof file.webViewLink === 'string' ? file.webViewLink : null,
            parents: Array.isArray(file.parents)
              ? file.parents.filter(
                  (parent): parent is string => typeof parent === 'string',
                )
              : [],
          },
        ];
      }),
    };
  }

  async driveCreateFile(
    input: DriveCreateFileInput,
  ): Promise<DriveCreateFileResult> {
    if (input.kind !== 'sheet' && input.kind !== 'doc') {
      failInput('Drive create kind must be sheet or doc.');
    }
    const title = boundedString(input.title, 'title', 256);
    const folderId = input.folderId
      ? googleId(input.folderId, 'folderId')
      : undefined;
    if (input.contentMarkdown !== undefined) {
      boundedString(
        input.contentMarkdown,
        'contentMarkdown',
        MAX_GOOGLE_DOC_MARKDOWN_BYTES,
        true,
      );
      if (input.kind !== 'doc') {
        failInput('Initial Markdown content is supported only for Docs.');
      }
    }
    const created = await this.requestJson<{
      id?: unknown;
      name?: unknown;
      webViewLink?: unknown;
    }>(
      'Google Drive file create',
      'https://www.googleapis.com/drive/v3/files?fields=id,name,webViewLink',
      {
        method: 'POST',
        body: {
          name: title,
          mimeType: DRIVE_TYPE_MIME[input.kind],
          ...(folderId ? { parents: [folderId] } : {}),
        },
        sideEffect: true,
      },
    );
    if (typeof created.id !== 'string' || !GOOGLE_ID_RE.test(created.id)) {
      throw new GoogleWorkspaceClientError(
        'invalid_response',
        'Google Drive create returned no usable file ID.',
        { outcomeUncertain: true },
      );
    }
    let revisionId: string | undefined;
    try {
      if (input.kind === 'doc' && input.contentMarkdown) {
        const metadata = await this.documentMetadata(created.id);
        const replaced = await this.docsReplaceContent({
          documentId: created.id,
          contentMarkdown: input.contentMarkdown,
          expectedRevisionId: metadata.revisionId,
        });
        revisionId = replaced.revisionId ?? metadata.revisionId;
      }
    } catch (err) {
      // The Drive create already succeeded. Even a definite failure while
      // applying optional initial content must block provider fallback from
      // creating a second document with the same owner intent.
      if (err instanceof GoogleWorkspaceClientError) {
        throw new GoogleWorkspaceClientError(err.code, err.message, {
          status: err.status,
          outcomeUncertain: true,
        });
      }
      throw new GoogleWorkspaceClientError(
        'unavailable',
        'Google file was created, but initial content could not be confirmed.',
        { outcomeUncertain: true },
      );
    }
    return {
      id: created.id,
      name: typeof created.name === 'string' ? created.name : title,
      url:
        typeof created.webViewLink === 'string'
          ? created.webViewLink
          : input.kind === 'sheet'
            ? `https://docs.google.com/spreadsheets/d/${created.id}/edit`
            : `https://docs.google.com/document/d/${created.id}/edit`,
      ...(revisionId ? { revisionId } : {}),
    };
  }

  async docsRead(documentId: string): Promise<GoogleDocsReadResult> {
    const id = googleId(documentId, 'documentId');
    const before = await this.documentMetadata(id);
    const markdown = await this.requestText(
      'Google Docs Markdown export',
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}/export?mimeType=${encodeURIComponent('text/markdown')}`,
      { maxResponseBytes: MAX_GOOGLE_DOC_MARKDOWN_BYTES },
    );
    const after = await this.documentMetadata(id);
    if (before.revisionId !== after.revisionId) {
      throw new GoogleWorkspaceClientError(
        'conflict',
        'Google Doc changed while it was being read; retry from a fresh read.',
      );
    }
    return {
      documentId: id,
      title: after.title,
      markdown,
      revisionId: after.revisionId,
      digest: googleDocumentMarkdownDigest(markdown),
    };
  }

  async docsReplaceContent(
    input: GoogleDocsReplaceInput,
  ): Promise<GoogleDocsReplaceResult> {
    const documentId = googleId(input.documentId, 'documentId');
    const markdown = boundedString(
      input.contentMarkdown,
      'contentMarkdown',
      MAX_GOOGLE_DOC_MARKDOWN_BYTES,
      true,
    );
    if (byteLength(markdown) > MAX_GOOGLE_DOC_MARKDOWN_BYTES) {
      failInput(
        `contentMarkdown exceeds ${MAX_GOOGLE_DOC_MARKDOWN_BYTES} UTF-8 bytes.`,
      );
    }
    const expectedRevision = input.expectedRevisionId
      ? boundedString(input.expectedRevisionId, 'expectedRevisionId', 256)
      : null;
    const expectedDigest = input.expectedDigest
      ? sha256Digest(input.expectedDigest, 'expectedDigest')
      : null;
    if (!expectedRevision && !expectedDigest) {
      failInput('Docs replacement requires an expected revision or digest.');
    }

    let metadata: GoogleDocumentMetadata;
    if (expectedDigest) {
      const current = await this.docsRead(documentId);
      if (current.digest !== expectedDigest) {
        throw new GoogleWorkspaceClientError(
          'conflict',
          'Google Doc content changed since it was read; replacement refused.',
        );
      }
      if (expectedRevision && current.revisionId !== expectedRevision) {
        throw new GoogleWorkspaceClientError(
          'conflict',
          'Google Doc revision changed since it was read; replacement refused.',
        );
      }
      metadata = await this.documentMetadata(documentId);
      if (metadata.revisionId !== current.revisionId) {
        throw new GoogleWorkspaceClientError(
          'conflict',
          'Google Doc changed immediately before replacement; replacement refused.',
        );
      }
    } else {
      metadata = await this.documentMetadata(documentId);
      if (metadata.revisionId !== expectedRevision) {
        throw new GoogleWorkspaceClientError(
          'conflict',
          'Google Doc revision changed since it was read; replacement refused.',
        );
      }
    }

    const conversion = convertBasicMarkdownToDocs(markdown);
    const requests: Array<Record<string, unknown>> = [];
    if (metadata.endIndex > 2) {
      requests.push({
        deleteContentRange: {
          range: { startIndex: 1, endIndex: metadata.endIndex - 1 },
        },
      });
    }
    if (conversion.text) {
      requests.push({
        insertText: { location: { index: 1 }, text: conversion.text },
      });
      requests.push(...conversion.requests);
    }

    let revisionId: string | null = metadata.revisionId;
    if (requests.length > 0) {
      const response = await this.requestJson<{
        writeControl?: {
          requiredRevisionId?: unknown;
          targetRevisionId?: unknown;
        };
      }>(
        'Google Docs guarded replacement',
        `https://docs.googleapis.com/v1/documents/${encodeURIComponent(documentId)}:batchUpdate`,
        {
          method: 'POST',
          body: {
            requests,
            writeControl: { requiredRevisionId: metadata.revisionId },
          },
          sideEffect: true,
        },
      );
      revisionId =
        typeof response.writeControl?.targetRevisionId === 'string'
          ? response.writeControl.targetRevisionId
          : typeof response.writeControl?.requiredRevisionId === 'string'
            ? response.writeControl.requiredRevisionId
            : null;
    }
    return {
      documentId,
      previousRevisionId: metadata.revisionId,
      revisionId,
      digest: googleDocumentMarkdownDigest(markdown),
      requestCount: requests.length,
    };
  }

  async sheetsGetValues(
    input: GoogleSheetsGetInput,
  ): Promise<GoogleSheetsGetResult> {
    const spreadsheetId = googleId(input.spreadsheetId, 'spreadsheetId');
    const range = boundedString(input.range, 'range', 512);
    const params = new URLSearchParams({
      majorDimension: 'ROWS',
      valueRenderOption: 'UNFORMATTED_VALUE',
      dateTimeRenderOption: 'SERIAL_NUMBER',
    });
    const raw = await this.requestJson<{
      range?: unknown;
      values?: unknown;
    }>(
      'Google Sheets values read',
      `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}?${params}`,
    );
    const returnedRange =
      typeof raw.range === 'string' && raw.range ? raw.range : range;
    const values = normalizeSheetValues(raw.values);
    return {
      spreadsheetId,
      range: returnedRange,
      majorDimension: 'ROWS',
      values,
      digest: googleSheetValuesDigest(spreadsheetId, returnedRange, values),
    };
  }

  async sheetsUpdateValues(
    input: GoogleSheetsUpdateInput,
  ): Promise<GoogleSheetsUpdateResult> {
    const spreadsheetId = googleId(input.spreadsheetId, 'spreadsheetId');
    const range = boundedString(input.range, 'range', 512);
    const expectedDigest = sha256Digest(input.expectedDigest, 'expectedDigest');
    const values = normalizeSheetValues(input.values);
    const inputMode = input.inputMode ?? 'raw';
    if (inputMode !== 'raw' && inputMode !== 'user_entered') {
      failInput('inputMode must be raw or user_entered.');
    }
    const current = await this.sheetsGetValues({ spreadsheetId, range });
    if (current.digest !== expectedDigest) {
      throw new GoogleWorkspaceClientError(
        'conflict',
        'Google Sheet range changed since it was read; update refused.',
      );
    }
    const params = new URLSearchParams({
      valueInputOption: inputMode === 'user_entered' ? 'USER_ENTERED' : 'RAW',
    });
    const response = await this.requestJson<{
      updatedRange?: unknown;
      updatedRows?: unknown;
      updatedColumns?: unknown;
      updatedCells?: unknown;
    }>(
      'Google Sheets guarded values update',
      `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}?${params}`,
      {
        method: 'PUT',
        body: { range, majorDimension: 'ROWS', values },
        sideEffect: true,
      },
    );
    const finiteNumber = (value: unknown): number | null =>
      typeof value === 'number' && Number.isFinite(value)
        ? Math.trunc(value)
        : null;
    return {
      spreadsheetId,
      range,
      inputMode,
      previousDigest: current.digest,
      updatedRange:
        typeof response.updatedRange === 'string'
          ? response.updatedRange
          : null,
      updatedRows: finiteNumber(response.updatedRows),
      updatedColumns: finiteNumber(response.updatedColumns),
      updatedCells: finiteNumber(response.updatedCells),
    };
  }

  async sheetsAppendValues(
    input: GoogleSheetsAppendInput,
  ): Promise<GoogleSheetsAppendResult> {
    const spreadsheetId = googleId(input.spreadsheetId, 'spreadsheetId');
    const range = boundedString(input.range, 'range', 512);
    const expectedDigest = sha256Digest(input.expectedDigest, 'expectedDigest');
    const values = normalizeSheetValues(input.values);
    if (values.length === 0 || values.some((row) => row.length === 0)) {
      failInput('Sheet append values must contain at least one cell per row.');
    }
    const allowedColumns = sheetRangeColumnCount(range);
    if (values.some((row) => row.length > allowedColumns)) {
      failInput('Sheet append row exceeds the authorized range width.');
    }
    const current = await this.sheetsGetValues({ spreadsheetId, range });
    if (current.digest !== expectedDigest) {
      throw new GoogleWorkspaceClientError(
        'conflict',
        'Google Sheet table changed since it was read; append refused.',
      );
    }
    const params = new URLSearchParams({
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      includeValuesInResponse: 'false',
    });
    const response = await this.requestJson<{
      tableRange?: unknown;
      updates?: {
        updatedRange?: unknown;
        updatedRows?: unknown;
        updatedColumns?: unknown;
        updatedCells?: unknown;
      };
    }>(
      'Google Sheets append values',
      `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}:append?${params}`,
      {
        method: 'POST',
        body: { range, majorDimension: 'ROWS', values },
        sideEffect: true,
      },
    );
    const expectedRows = values.length;
    const expectedColumns = Math.max(...values.map((row) => row.length));
    const expectedCells = values.reduce((sum, row) => sum + row.length, 0);
    const updatedRange = response.updates?.updatedRange;
    const updatedRows = response.updates?.updatedRows;
    const updatedColumns = response.updates?.updatedColumns;
    const updatedCells = response.updates?.updatedCells;
    if (
      typeof updatedRange !== 'string' ||
      updatedRange.length === 0 ||
      updatedRange.length > 512 ||
      typeof updatedRows !== 'number' ||
      !Number.isInteger(updatedRows) ||
      updatedRows !== expectedRows ||
      typeof updatedColumns !== 'number' ||
      !Number.isInteger(updatedColumns) ||
      updatedColumns !== expectedColumns ||
      typeof updatedCells !== 'number' ||
      !Number.isInteger(updatedCells) ||
      updatedCells !== expectedCells
    ) {
      throw new GoogleWorkspaceClientError(
        'invalid_response',
        'Google Sheets append returned an unconfirmed result.',
        { outcomeUncertain: true },
      );
    }
    return {
      spreadsheetId,
      range,
      inputMode: 'raw',
      previousDigest: current.digest,
      updatedRange,
      updatedRows,
      updatedColumns,
      updatedCells,
    };
  }

  async appsScriptGetContent(
    scriptId: string,
  ): Promise<GoogleAppsScriptGetResult> {
    const id = googleId(scriptId, 'scriptId');
    const raw = await this.requestJson<{
      scriptId?: unknown;
      files?: unknown;
    }>(
      'Google Apps Script content read',
      `https://script.googleapis.com/v1/projects/${encodeURIComponent(id)}/content`,
    );
    const files = normalizeAppsScriptFiles(raw.files ?? []);
    return {
      scriptId:
        typeof raw.scriptId === 'string' && GOOGLE_ID_RE.test(raw.scriptId)
          ? raw.scriptId
          : id,
      files,
      digest: googleAppsScriptFilesDigest(files),
    };
  }

  async appsScriptUpdateFile(
    input: GoogleAppsScriptUpdateInput,
  ): Promise<GoogleAppsScriptUpdateResult> {
    const scriptId = googleId(input.scriptId, 'scriptId');
    const fileName = boundedString(input.fileName, 'fileName', 256);
    if (/[/\\]/.test(fileName)) failInput('fileName cannot contain slashes.');
    const source = boundedString(
      input.source,
      'source',
      MAX_GOOGLE_APPS_SCRIPT_SOURCE_BYTES,
      true,
    );
    if (byteLength(source) > MAX_GOOGLE_APPS_SCRIPT_SOURCE_BYTES) {
      failInput(`source exceeds ${MAX_GOOGLE_APPS_SCRIPT_SOURCE_BYTES} bytes.`);
    }
    const expectedDigest = sha256Digest(input.expectedDigest, 'expectedDigest');
    const current = await this.appsScriptGetContent(scriptId);
    if (current.digest !== expectedDigest) {
      throw new GoogleWorkspaceClientError(
        'conflict',
        'Apps Script project changed since it was read; update refused.',
      );
    }
    const files = current.files.map((file) => ({ ...file }));
    const target = files.find((file) => file.name === fileName);
    let created = false;
    if (target) {
      if (input.newFileType && input.newFileType !== target.type) {
        failInput('newFileType cannot change the type of an existing file.');
      }
      target.source = source;
    } else {
      if (
        input.newFileType !== 'SERVER_JS' &&
        input.newFileType !== 'HTML' &&
        input.newFileType !== 'JSON'
      ) {
        failInput('newFileType is required when creating an Apps Script file.');
      }
      files.push({ name: fileName, type: input.newFileType, source });
      created = true;
    }
    const normalized = normalizeAppsScriptFiles(files);
    await this.requestJson<Record<string, unknown>>(
      'Google Apps Script guarded update',
      `https://script.googleapis.com/v1/projects/${encodeURIComponent(scriptId)}/content`,
      {
        method: 'PUT',
        // Strict serialization: never reflect read-only metadata returned by
        // getContent back into updateContent.
        body: {
          files: normalized.map(({ name, type, source: fileSource }) => ({
            name,
            type,
            source: fileSource,
          })),
        },
        sideEffect: true,
      },
    );
    return {
      scriptId,
      updated: fileName,
      fileCount: normalized.length,
      created,
      previousDigest: current.digest,
      digest: googleAppsScriptFilesDigest(normalized),
    };
  }

  async gmailSearchThreads(
    input: GmailSearchThreadsInput,
  ): Promise<GmailSearchThreadsResult> {
    const query =
      input.query === undefined
        ? undefined
        : boundedString(input.query, 'query', 512);
    if (
      input.maxResults !== undefined &&
      (!Number.isFinite(input.maxResults) || input.maxResults <= 0)
    ) {
      failInput('maxResults must be a positive finite number.');
    }
    const maxResults = Math.min(
      MAX_GMAIL_RESULTS,
      Math.max(1, Math.trunc(input.maxResults ?? 10)),
    );
    const params = new URLSearchParams({
      maxResults: String(maxResults),
      includeSpamTrash: 'false',
      fields: 'threads(id,snippet),nextPageToken,resultSizeEstimate',
      ...(query === undefined ? {} : { q: query }),
    });
    const raw = await this.requestJson<{
      threads?: unknown;
      nextPageToken?: unknown;
      resultSizeEstimate?: unknown;
    }>(
      'Gmail thread search',
      `https://gmail.googleapis.com/gmail/v1/users/me/threads?${params}`,
    );
    if (raw.threads !== undefined && !Array.isArray(raw.threads)) {
      invalidGmailResponse('a malformed thread list');
    }
    const seen = new Set<string>();
    const threads = (Array.isArray(raw.threads) ? raw.threads : [])
      .slice(0, maxResults)
      .map((entry): GmailThreadSummary => {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
          invalidGmailResponse('a malformed thread summary');
        }
        const record = entry as Record<string, unknown>;
        if (typeof record.id !== 'string' || !GOOGLE_ID_RE.test(record.id)) {
          invalidGmailResponse('a malformed thread ID');
        }
        if (seen.has(record.id)) {
          invalidGmailResponse('duplicate thread IDs');
        }
        seen.add(record.id);
        return {
          threadId: record.id,
          snippet: gmailProviderText(
            record.snippet,
            MAX_GMAIL_SNIPPET_CHARS,
            true,
          ),
        };
      });
    const estimate = raw.resultSizeEstimate;
    return {
      threads,
      resultSizeEstimate:
        typeof estimate === 'number' &&
        Number.isSafeInteger(estimate) &&
        estimate >= 0
          ? estimate
          : null,
      hasMore:
        typeof raw.nextPageToken === 'string' && raw.nextPageToken.length > 0,
    };
  }

  async gmailGetThread(
    input: GmailGetThreadInput,
  ): Promise<GmailGetThreadResult> {
    const threadId = googleId(input.threadId, 'threadId');
    const params = new URLSearchParams({
      format: 'full',
      fields: 'id,messages(id,threadId,labelIds,snippet,internalDate,payload)',
    });
    const raw = await this.requestJson<{
      id?: unknown;
      messages?: unknown;
    }>(
      'Gmail thread read',
      `https://gmail.googleapis.com/gmail/v1/users/me/threads/${encodeURIComponent(threadId)}?${params}`,
    );
    if (raw.id !== undefined && raw.id !== threadId) {
      invalidGmailResponse('a mismatched thread ID');
    }
    if (!Array.isArray(raw.messages)) {
      invalidGmailResponse('a malformed message list');
    }
    const omittedMessageCount = Math.max(
      0,
      raw.messages.length - MAX_GMAIL_THREAD_MESSAGES,
    );
    const selected = raw.messages.slice(-MAX_GMAIL_THREAD_MESSAGES);
    let remainingThreadBodyBytes = MAX_GMAIL_THREAD_BODY_BYTES;
    let bodyTruncated = omittedMessageCount > 0;
    const seen = new Set<string>();
    const messages = selected.map((entry): GmailMessageRecord => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        invalidGmailResponse('a malformed message');
      }
      const record = entry as Record<string, unknown>;
      if (typeof record.id !== 'string' || !GOOGLE_ID_RE.test(record.id)) {
        invalidGmailResponse('a malformed message ID');
      }
      if (seen.has(record.id)) invalidGmailResponse('duplicate message IDs');
      seen.add(record.id);
      if (record.threadId !== undefined && record.threadId !== threadId) {
        invalidGmailResponse('a message from another thread');
      }
      const payload =
        record.payload &&
        typeof record.payload === 'object' &&
        !Array.isArray(record.payload)
          ? (record.payload as Record<string, unknown>)
          : undefined;
      const extracted = extractGmailBody(payload);
      const threadBounded = truncateUtf8(
        extracted.bodyText,
        remainingThreadBodyBytes,
      );
      remainingThreadBodyBytes -= byteLength(threadBounded.value);
      const messageBodyTruncated =
        extracted.bodyTruncated || threadBounded.truncated;
      bodyTruncated ||= messageBodyTruncated;
      const labelIds = Array.isArray(record.labelIds)
        ? [
            ...new Set(
              record.labelIds
                .slice(0, 100)
                .map((label) => gmailProviderText(label, 256))
                .filter(Boolean),
            ),
          ]
        : [];
      return {
        messageId: record.id,
        receivedAt: gmailReceivedAt(record.internalDate),
        date: gmailHeader(payload?.headers, 'date'),
        from: gmailHeader(payload?.headers, 'from'),
        to: gmailHeader(payload?.headers, 'to'),
        cc: gmailHeader(payload?.headers, 'cc'),
        subject: gmailHeader(payload?.headers, 'subject'),
        snippet: gmailProviderText(
          record.snippet,
          MAX_GMAIL_SNIPPET_CHARS,
          true,
        ),
        labelIds,
        bodyText: threadBounded.value,
        bodyTruncated: messageBodyTruncated,
        hasAttachments: extracted.hasAttachments,
      };
    });
    return {
      threadId,
      messages,
      omittedMessageCount,
      bodyTruncated,
    };
  }

  async calendarListEvents(
    input: ListCalendarEventsInput,
  ): Promise<CalendarEventRecord[]> {
    if (!this.calendarAdapter) {
      throw new GoogleWorkspaceClientError(
        'unavailable',
        'Google Calendar adapter is not configured.',
      );
    }
    const calendarId = input.calendarId
      ? boundedString(input.calendarId, 'calendarId', 512)
      : undefined;
    const timeMin = input.timeMin
      ? boundedString(input.timeMin, 'timeMin', 64)
      : undefined;
    const timeMax = input.timeMax
      ? boundedString(input.timeMax, 'timeMax', 64)
      : undefined;
    const query = input.query
      ? boundedString(input.query, 'query', 512)
      : undefined;
    if (
      input.maxResults !== undefined &&
      (!Number.isFinite(input.maxResults) || input.maxResults <= 0)
    ) {
      failInput('maxResults must be a positive finite number.');
    }
    const maxResults = Math.min(
      MAX_CALENDAR_RESULTS,
      Math.max(1, Math.trunc(input.maxResults ?? 25)),
    );
    try {
      return await this.calendarAdapter.listEvents({
        calendarId,
        timeMin,
        timeMax,
        query,
        maxResults,
      });
    } catch {
      throw new GoogleWorkspaceClientError(
        'http_error',
        'Google Calendar list failed.',
      );
    }
  }

  /**
   * Dispatch a host-validated operation without ever exposing OAuth to it.
   * Arrow binding lets the broker safely receive `client.execute` directly.
   */
  readonly execute = async (
    operation: GoogleWorkspaceOperation,
  ): Promise<unknown> => {
    switch (operation.tool) {
      case 'google_workspace_status':
        return this.status(operation.args.verify);
      case 'google_drive_list_files':
        return this.driveListFiles(operation.args);
      case 'google_sheets_create':
        return this.driveCreateFile({
          kind: 'sheet',
          title: operation.args.title,
          folderId: operation.args.folderId,
        });
      case 'google_docs_create':
        return this.driveCreateFile({
          kind: 'doc',
          title: operation.args.title,
          contentMarkdown: operation.args.contentMarkdown,
          folderId: operation.args.folderId,
        });
      case 'google_docs_read':
        return this.docsRead(operation.args.documentId);
      case 'google_docs_replace_content':
        return this.docsReplaceContent(operation.args);
      case 'google_sheets_get_values':
        return this.sheetsGetValues(operation.args);
      case 'google_sheets_append_values':
        return this.sheetsAppendValues(operation.args);
      case 'google_sheets_update_values':
        return this.sheetsUpdateValues(operation.args);
      case 'google_apps_script_get_content':
        return this.appsScriptGetContent(operation.args.scriptId);
      case 'google_apps_script_update_file':
        return this.appsScriptUpdateFile(operation.args);
      case 'google_calendar_list_events':
        return this.calendarListEvents(operation.args);
      case 'gmail_search_threads':
        return this.gmailSearchThreads(operation.args);
      case 'gmail_get_thread':
        return this.gmailGetThread(operation.args);
    }
  };
}
