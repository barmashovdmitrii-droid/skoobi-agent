import { createHash } from 'crypto';

export const GOOGLE_WORKSPACE_TOOL_NAMES = [
  'google_workspace_status',
  'google_drive_list_files',
  'google_sheets_create',
  'google_docs_create',
  'google_docs_read',
  'google_docs_replace_content',
  'google_sheets_get_values',
  'google_sheets_append_values',
  'google_sheets_update_values',
  'google_apps_script_get_content',
  'google_apps_script_update_file',
  'google_calendar_list_events',
  'gmail_search_threads',
  'gmail_get_thread',
] as const;

export type GoogleWorkspaceTool = (typeof GOOGLE_WORKSPACE_TOOL_NAMES)[number];

export type GoogleWorkspaceToolClassification =
  | 'read'
  | 'write'
  | 'destructive';

export const GOOGLE_WORKSPACE_TOOL_CLASSIFICATION: Readonly<
  Record<GoogleWorkspaceTool, GoogleWorkspaceToolClassification>
> = Object.freeze({
  google_workspace_status: 'read',
  google_drive_list_files: 'read',
  google_sheets_create: 'write',
  google_docs_create: 'write',
  google_docs_read: 'read',
  google_docs_replace_content: 'destructive',
  google_sheets_get_values: 'read',
  google_sheets_append_values: 'write',
  google_sheets_update_values: 'destructive',
  google_apps_script_get_content: 'read',
  google_apps_script_update_file: 'destructive',
  google_calendar_list_events: 'read',
  gmail_search_threads: 'read',
  gmail_get_thread: 'read',
});

export const GOOGLE_WORKSPACE_READ_TOOLS: ReadonlySet<GoogleWorkspaceTool> =
  new Set(
    GOOGLE_WORKSPACE_TOOL_NAMES.filter(
      (tool) => GOOGLE_WORKSPACE_TOOL_CLASSIFICATION[tool] === 'read',
    ),
  );

/** Every mutating tool, including the destructive subset. */
export const GOOGLE_WORKSPACE_WRITE_TOOLS: ReadonlySet<GoogleWorkspaceTool> =
  new Set(
    GOOGLE_WORKSPACE_TOOL_NAMES.filter(
      (tool) => GOOGLE_WORKSPACE_TOOL_CLASSIFICATION[tool] !== 'read',
    ),
  );

export const GOOGLE_WORKSPACE_DESTRUCTIVE_TOOLS: ReadonlySet<GoogleWorkspaceTool> =
  new Set(
    GOOGLE_WORKSPACE_TOOL_NAMES.filter(
      (tool) => GOOGLE_WORKSPACE_TOOL_CLASSIFICATION[tool] === 'destructive',
    ),
  );

export const GOOGLE_WORKSPACE_MAX_ID_CHARS = 256;
export const GOOGLE_WORKSPACE_MAX_QUERY_CHARS = 512;
export const GOOGLE_WORKSPACE_MAX_RANGE_CHARS = 512;
export const GOOGLE_WORKSPACE_MAX_TITLE_CHARS = 256;
export const GOOGLE_WORKSPACE_MAX_MARKDOWN_BYTES = 512 * 1024;
export const GOOGLE_WORKSPACE_MAX_SOURCE_BYTES = 1024 * 1024;
export const GOOGLE_WORKSPACE_MAX_VALUE_ROWS = 500;
export const GOOGLE_WORKSPACE_MAX_VALUE_COLUMNS = 100;
export const GOOGLE_WORKSPACE_MAX_VALUE_CELLS = 10_000;
export const GOOGLE_WORKSPACE_MAX_VALUES_BYTES = 1024 * 1024;
export const GOOGLE_WORKSPACE_MAX_CELL_STRING_CHARS = 32_767;
export const GOOGLE_WORKSPACE_MAX_RESULTS = 100;
export const GOOGLE_WORKSPACE_DEFAULT_MAX_RESULTS = 25;

export type Sha256Hex = string & { readonly __sha256Hex: unique symbol };
export type SheetCell = string | number | boolean | null;
export type GoogleDriveFileType = 'sheet' | 'doc' | 'folder' | 'any';
export type GoogleSheetsInputMode = 'raw' | 'user_entered';
export type GoogleAppsScriptFileType = 'SERVER_JS' | 'HTML' | 'JSON';

export interface GoogleWorkspaceStatusArgs {
  verify: boolean;
}

export interface GoogleDriveListFilesArgs {
  query?: string;
  contentQuery?: string;
  type: GoogleDriveFileType;
  folderId?: string;
  /** Restrict the search to direct children of the current user's My Drive root. */
  rootOnly: boolean;
  maxResults: number;
}

export interface GoogleSheetsCreateArgs {
  title: string;
  folderId?: string;
}

export interface GoogleDocsCreateArgs {
  title: string;
  contentMarkdown?: string;
  folderId?: string;
}

export interface GoogleDocsReadArgs {
  documentId: string;
}

export interface GoogleDocsReplaceContentArgs {
  documentId: string;
  contentMarkdown: string;
  /** Google revision id when the provider exposes one. */
  expectedRevisionId?: string;
  /** SHA-256 of the exact content read before this destructive replacement. */
  expectedDigest?: Sha256Hex;
}

export interface GoogleSheetsGetValuesArgs {
  spreadsheetId: string;
  range: string;
}

export interface GoogleSheetsUpdateValuesArgs {
  spreadsheetId: string;
  range: string;
  values: SheetCell[][];
  inputMode: GoogleSheetsInputMode;
  /** SHA-256 of the canonical values observed in the target range. */
  expectedDigest: Sha256Hex;
}

export interface GoogleSheetsAppendValuesArgs {
  spreadsheetId: string;
  /**
   * Exact A1 table range used both for the fresh read and as the provider's
   * append-table boundary. Existing cells are never overwritten.
   */
  range: string;
  values: SheetCell[][];
  /** SHA-256 of the canonical table values observed immediately beforehand. */
  expectedDigest: Sha256Hex;
}

export interface GoogleAppsScriptGetContentArgs {
  scriptId: string;
}

export interface GoogleAppsScriptUpdateFileArgs {
  scriptId: string;
  fileName: string;
  source: string;
  newFileType?: GoogleAppsScriptFileType;
  /** SHA-256 of the canonical project/file state read before the update. */
  expectedDigest: Sha256Hex;
}

export interface GoogleCalendarListEventsArgs {
  calendarId: string;
  timeMin: string;
  timeMax: string;
  query?: string;
  maxResults: number;
}

export interface GmailSearchThreadsArgs {
  query?: string;
  maxResults: number;
}

export interface GmailGetThreadArgs {
  threadId: string;
}

export interface GoogleWorkspaceArgsByTool {
  google_workspace_status: GoogleWorkspaceStatusArgs;
  google_drive_list_files: GoogleDriveListFilesArgs;
  google_sheets_create: GoogleSheetsCreateArgs;
  google_docs_create: GoogleDocsCreateArgs;
  google_docs_read: GoogleDocsReadArgs;
  google_docs_replace_content: GoogleDocsReplaceContentArgs;
  google_sheets_get_values: GoogleSheetsGetValuesArgs;
  google_sheets_append_values: GoogleSheetsAppendValuesArgs;
  google_sheets_update_values: GoogleSheetsUpdateValuesArgs;
  google_apps_script_get_content: GoogleAppsScriptGetContentArgs;
  google_apps_script_update_file: GoogleAppsScriptUpdateFileArgs;
  google_calendar_list_events: GoogleCalendarListEventsArgs;
  gmail_search_threads: GmailSearchThreadsArgs;
  gmail_get_thread: GmailGetThreadArgs;
}

export type GoogleWorkspaceOperation<
  T extends GoogleWorkspaceTool = GoogleWorkspaceTool,
> = {
  [K in T]: {
    type: 'google_api';
    request_id?: string;
    tool: K;
    args: GoogleWorkspaceArgsByTool[K];
  };
}[T];

export type GoogleWorkspaceOperationParseResult =
  | { ok: true; value: GoogleWorkspaceOperation }
  | { ok: false; error: string };

const TOOL_NAME_SET = new Set<string>(GOOGLE_WORKSPACE_TOOL_NAMES);
const CONTROL_CHAR_RE = /[\u0000-\u001f\u007f]/;
const RESOURCE_ID_RE = /^[A-Za-z0-9_-]+$/;
const CALENDAR_ID_RE = /^[A-Za-z0-9._@#-]+$/;
const REQUEST_ID_RE = /^[A-Za-z0-9_-]{8,128}$/;
const SHA256_HEX_RE = /^[a-f0-9]{64}$/;
const RFC3339_INSTANT_RE =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|([+-])(\d{2}):(\d{2}))$/;

class OperationParseFailure extends Error {}

function fail(path: string, message: string): never {
  throw new OperationParseFailure(`${path}: ${message}`);
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function strictRecord(
  value: unknown,
  path: string,
  allowedKeys: readonly string[],
): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(path, 'expected an object');
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    fail(path, 'expected a plain object');
  }
  const record = value as Record<string, unknown>;
  const allowed = new Set(allowedKeys);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) fail(`${path}.${key}`, 'unknown field');
  }
  return record;
}

function requiredString(
  record: Record<string, unknown>,
  key: string,
  path: string,
): string {
  if (!hasOwn(record, key) || typeof record[key] !== 'string') {
    fail(`${path}.${key}`, 'expected a string');
  }
  return record[key] as string;
}

function optionalString(
  record: Record<string, unknown>,
  key: string,
  path: string,
): string | undefined {
  if (!hasOwn(record, key)) return undefined;
  if (typeof record[key] !== 'string') {
    fail(`${path}.${key}`, 'expected a string');
  }
  return record[key] as string;
}

function boundedText(
  value: string,
  path: string,
  maxChars: number,
  options: { allowEmpty?: boolean; trim?: boolean } = {},
): string {
  const trim = options.trim !== false;
  const canonical = trim ? value.trim() : value;
  if (trim && canonical !== value) {
    fail(path, 'leading or trailing whitespace is not allowed');
  }
  if (!options.allowEmpty && canonical.length === 0) {
    fail(path, 'must not be empty');
  }
  if (canonical.length > maxChars) {
    fail(path, `must be at most ${maxChars} characters`);
  }
  if (CONTROL_CHAR_RE.test(canonical)) {
    fail(path, 'control characters are not allowed');
  }
  return canonical;
}

function boundedBytes(value: string, path: string, maxBytes: number): string {
  if (Buffer.byteLength(value, 'utf8') > maxBytes) {
    fail(path, `must be at most ${maxBytes} UTF-8 bytes`);
  }
  return value;
}

function resourceId(value: string, path: string): string {
  const canonical = boundedText(value, path, GOOGLE_WORKSPACE_MAX_ID_CHARS);
  if (!RESOURCE_ID_RE.test(canonical)) {
    fail(path, 'contains unsafe identifier characters');
  }
  return canonical;
}

function calendarId(value: string, path: string): string {
  const canonical = boundedText(value, path, GOOGLE_WORKSPACE_MAX_ID_CHARS);
  if (!CALENDAR_ID_RE.test(canonical)) {
    fail(path, 'contains unsafe calendar identifier characters');
  }
  return canonical;
}

function sha256Digest(value: string, path: string): Sha256Hex {
  if (!SHA256_HEX_RE.test(value)) {
    fail(path, 'expected a lowercase 64-character SHA-256 hex digest');
  }
  return value as Sha256Hex;
}

function optionalResourceId(
  record: Record<string, unknown>,
  key: string,
  path: string,
): string | undefined {
  const value = optionalString(record, key, path);
  return value === undefined ? undefined : resourceId(value, `${path}.${key}`);
}

function optionalQuery(
  record: Record<string, unknown>,
  key: string,
  path: string,
): string | undefined {
  const value = optionalString(record, key, path);
  return value === undefined
    ? undefined
    : boundedText(value, `${path}.${key}`, GOOGLE_WORKSPACE_MAX_QUERY_CHARS);
}

function maxResults(record: Record<string, unknown>, path: string): number {
  if (!hasOwn(record, 'maxResults')) {
    return GOOGLE_WORKSPACE_DEFAULT_MAX_RESULTS;
  }
  const value = record.maxResults;
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > GOOGLE_WORKSPACE_MAX_RESULTS
  ) {
    fail(
      `${path}.maxResults`,
      `expected an integer from 1 to ${GOOGLE_WORKSPACE_MAX_RESULTS}`,
    );
  }
  return value;
}

function optionalMarkdown(
  record: Record<string, unknown>,
  key: string,
  path: string,
): string | undefined {
  const value = optionalString(record, key, path);
  if (value === undefined || value === '') return undefined;
  return boundedBytes(
    value,
    `${path}.${key}`,
    GOOGLE_WORKSPACE_MAX_MARKDOWN_BYTES,
  );
}

function requiredMarkdown(
  record: Record<string, unknown>,
  key: string,
  path: string,
): string {
  return boundedBytes(
    requiredString(record, key, path),
    `${path}.${key}`,
    GOOGLE_WORKSPACE_MAX_MARKDOWN_BYTES,
  );
}

function parseValues(value: unknown, path: string): SheetCell[][] {
  if (!Array.isArray(value) || value.length === 0) {
    fail(path, 'expected a non-empty array of rows');
  }
  if (value.length > GOOGLE_WORKSPACE_MAX_VALUE_ROWS) {
    fail(path, `must have at most ${GOOGLE_WORKSPACE_MAX_VALUE_ROWS} rows`);
  }
  let cellCount = 0;
  const rows: SheetCell[][] = value.map((rawRow, rowIndex) => {
    const rowPath = `${path}[${rowIndex}]`;
    if (!Array.isArray(rawRow) || rawRow.length === 0) {
      fail(rowPath, 'expected a non-empty array of cells');
    }
    if (rawRow.length > GOOGLE_WORKSPACE_MAX_VALUE_COLUMNS) {
      fail(
        rowPath,
        `must have at most ${GOOGLE_WORKSPACE_MAX_VALUE_COLUMNS} columns`,
      );
    }
    cellCount += rawRow.length;
    if (cellCount > GOOGLE_WORKSPACE_MAX_VALUE_CELLS) {
      fail(path, `must have at most ${GOOGLE_WORKSPACE_MAX_VALUE_CELLS} cells`);
    }
    return rawRow.map((cell, columnIndex): SheetCell => {
      const cellPath = `${rowPath}[${columnIndex}]`;
      if (cell === null || typeof cell === 'boolean') return cell;
      if (typeof cell === 'number') {
        if (!Number.isFinite(cell)) fail(cellPath, 'number must be finite');
        return Object.is(cell, -0) ? 0 : cell;
      }
      if (typeof cell === 'string') {
        if (cell.length > GOOGLE_WORKSPACE_MAX_CELL_STRING_CHARS) {
          fail(
            cellPath,
            `string must be at most ${GOOGLE_WORKSPACE_MAX_CELL_STRING_CHARS} characters`,
          );
        }
        return cell;
      }
      fail(cellPath, 'expected string, finite number, boolean, or null');
    });
  });
  if (
    Buffer.byteLength(JSON.stringify(rows), 'utf8') >
    GOOGLE_WORKSPACE_MAX_VALUES_BYTES
  ) {
    fail(
      path,
      `canonical values must be at most ${GOOGLE_WORKSPACE_MAX_VALUES_BYTES} UTF-8 bytes`,
    );
  }
  return rows;
}

function parseRfc3339Instant(value: string, path: string): string {
  const match = RFC3339_INSTANT_RE.exec(value);
  if (!match) {
    fail(path, 'expected an RFC3339 timestamp with an explicit timezone');
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = match[8] === undefined ? 0 : Number(match[8]);
  const offsetMinute = match[9] === undefined ? 0 : Number(match[9]);
  const daysInMonth =
    year >= 1 && month >= 1 && month <= 12
      ? new Date(Date.UTC(year, month, 0)).getUTCDate()
      : 0;
  if (
    day < 1 ||
    day > daysInMonth ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    offsetHour > 23 ||
    offsetMinute > 59 ||
    !Number.isFinite(Date.parse(value))
  ) {
    fail(path, 'expected a valid RFC3339 calendar instant');
  }
  return value;
}

function parseArgs(
  tool: GoogleWorkspaceTool,
  raw: unknown,
): GoogleWorkspaceArgsByTool[GoogleWorkspaceTool] {
  const path = 'operation.args';
  switch (tool) {
    case 'google_workspace_status': {
      const record = strictRecord(raw, path, ['verify']);
      if (hasOwn(record, 'verify') && typeof record.verify !== 'boolean') {
        fail(`${path}.verify`, 'expected a boolean');
      }
      return { verify: record.verify === true };
    }

    case 'google_drive_list_files': {
      const record = strictRecord(raw, path, [
        'query',
        'contentQuery',
        'type',
        'folderId',
        'rootOnly',
        'maxResults',
      ]);
      let type: GoogleDriveFileType = 'any';
      if (hasOwn(record, 'type')) {
        if (
          record.type !== 'sheet' &&
          record.type !== 'doc' &&
          record.type !== 'folder' &&
          record.type !== 'any'
        ) {
          fail(`${path}.type`, 'expected sheet, doc, folder, or any');
        }
        type = record.type;
      }
      const query = optionalQuery(record, 'query', path);
      const contentQuery = optionalQuery(record, 'contentQuery', path);
      const folderId = optionalResourceId(record, 'folderId', path);
      if (hasOwn(record, 'rootOnly') && typeof record.rootOnly !== 'boolean') {
        fail(`${path}.rootOnly`, 'expected a boolean');
      }
      const rootOnly = record.rootOnly === true;
      if (rootOnly && folderId !== undefined) {
        fail(path, 'rootOnly and folderId cannot be combined');
      }
      return {
        ...(query === undefined ? {} : { query }),
        ...(contentQuery === undefined ? {} : { contentQuery }),
        type,
        ...(folderId === undefined ? {} : { folderId }),
        rootOnly,
        maxResults: maxResults(record, path),
      };
    }

    case 'google_sheets_create': {
      const record = strictRecord(raw, path, ['title', 'folderId']);
      const folderId = optionalResourceId(record, 'folderId', path);
      return {
        title: boundedText(
          requiredString(record, 'title', path),
          `${path}.title`,
          GOOGLE_WORKSPACE_MAX_TITLE_CHARS,
        ),
        ...(folderId === undefined ? {} : { folderId }),
      };
    }

    case 'google_docs_create': {
      const record = strictRecord(raw, path, [
        'title',
        'contentMarkdown',
        'folderId',
      ]);
      const contentMarkdown = optionalMarkdown(record, 'contentMarkdown', path);
      const folderId = optionalResourceId(record, 'folderId', path);
      return {
        title: boundedText(
          requiredString(record, 'title', path),
          `${path}.title`,
          GOOGLE_WORKSPACE_MAX_TITLE_CHARS,
        ),
        ...(contentMarkdown === undefined ? {} : { contentMarkdown }),
        ...(folderId === undefined ? {} : { folderId }),
      };
    }

    case 'google_docs_read': {
      const record = strictRecord(raw, path, ['documentId']);
      return {
        documentId: resourceId(
          requiredString(record, 'documentId', path),
          `${path}.documentId`,
        ),
      };
    }

    case 'google_docs_replace_content': {
      const record = strictRecord(raw, path, [
        'documentId',
        'contentMarkdown',
        'expectedRevisionId',
        'expectedDigest',
      ]);
      const expectedRevisionId = optionalResourceId(
        record,
        'expectedRevisionId',
        path,
      );
      const expectedDigestRaw = optionalString(record, 'expectedDigest', path);
      const expectedDigest =
        expectedDigestRaw === undefined
          ? undefined
          : sha256Digest(expectedDigestRaw, `${path}.expectedDigest`);
      if (expectedRevisionId === undefined && expectedDigest === undefined) {
        fail(
          path,
          'expectedRevisionId or expectedDigest is required for destructive replacement',
        );
      }
      return {
        documentId: resourceId(
          requiredString(record, 'documentId', path),
          `${path}.documentId`,
        ),
        contentMarkdown: requiredMarkdown(record, 'contentMarkdown', path),
        ...(expectedRevisionId === undefined ? {} : { expectedRevisionId }),
        ...(expectedDigest === undefined ? {} : { expectedDigest }),
      };
    }

    case 'google_sheets_get_values': {
      const record = strictRecord(raw, path, ['spreadsheetId', 'range']);
      return {
        spreadsheetId: resourceId(
          requiredString(record, 'spreadsheetId', path),
          `${path}.spreadsheetId`,
        ),
        range: boundedText(
          requiredString(record, 'range', path),
          `${path}.range`,
          GOOGLE_WORKSPACE_MAX_RANGE_CHARS,
        ),
      };
    }

    case 'google_sheets_update_values': {
      const record = strictRecord(raw, path, [
        'spreadsheetId',
        'range',
        'values',
        'inputMode',
        'expectedDigest',
      ]);
      if (record.inputMode !== 'raw' && record.inputMode !== 'user_entered') {
        fail(`${path}.inputMode`, 'expected raw or user_entered');
      }
      return {
        spreadsheetId: resourceId(
          requiredString(record, 'spreadsheetId', path),
          `${path}.spreadsheetId`,
        ),
        range: boundedText(
          requiredString(record, 'range', path),
          `${path}.range`,
          GOOGLE_WORKSPACE_MAX_RANGE_CHARS,
        ),
        values: parseValues(record.values, `${path}.values`),
        inputMode: record.inputMode,
        expectedDigest: sha256Digest(
          requiredString(record, 'expectedDigest', path),
          `${path}.expectedDigest`,
        ),
      };
    }

    case 'google_sheets_append_values': {
      const record = strictRecord(raw, path, [
        'spreadsheetId',
        'range',
        'values',
        'expectedDigest',
      ]);
      return {
        spreadsheetId: resourceId(
          requiredString(record, 'spreadsheetId', path),
          `${path}.spreadsheetId`,
        ),
        range: boundedText(
          requiredString(record, 'range', path),
          `${path}.range`,
          GOOGLE_WORKSPACE_MAX_RANGE_CHARS,
        ),
        values: parseValues(record.values, `${path}.values`),
        expectedDigest: sha256Digest(
          requiredString(record, 'expectedDigest', path),
          `${path}.expectedDigest`,
        ),
      };
    }

    case 'google_apps_script_get_content': {
      const record = strictRecord(raw, path, ['scriptId']);
      return {
        scriptId: resourceId(
          requiredString(record, 'scriptId', path),
          `${path}.scriptId`,
        ),
      };
    }

    case 'google_apps_script_update_file': {
      const record = strictRecord(raw, path, [
        'scriptId',
        'fileName',
        'source',
        'newFileType',
        'expectedDigest',
      ]);
      const fileName = boundedText(
        requiredString(record, 'fileName', path),
        `${path}.fileName`,
        GOOGLE_WORKSPACE_MAX_TITLE_CHARS,
      );
      if (
        fileName === '.' ||
        fileName === '..' ||
        fileName.includes('/') ||
        fileName.includes('\\')
      ) {
        fail(`${path}.fileName`, 'path-like file names are not allowed');
      }
      let newFileType: GoogleAppsScriptFileType | undefined;
      if (hasOwn(record, 'newFileType')) {
        if (
          record.newFileType !== 'SERVER_JS' &&
          record.newFileType !== 'HTML' &&
          record.newFileType !== 'JSON'
        ) {
          fail(`${path}.newFileType`, 'expected SERVER_JS, HTML, or JSON');
        }
        newFileType = record.newFileType;
      }
      return {
        scriptId: resourceId(
          requiredString(record, 'scriptId', path),
          `${path}.scriptId`,
        ),
        fileName,
        source: boundedBytes(
          requiredString(record, 'source', path),
          `${path}.source`,
          GOOGLE_WORKSPACE_MAX_SOURCE_BYTES,
        ),
        ...(newFileType === undefined ? {} : { newFileType }),
        expectedDigest: sha256Digest(
          requiredString(record, 'expectedDigest', path),
          `${path}.expectedDigest`,
        ),
      };
    }

    case 'google_calendar_list_events': {
      const record = strictRecord(raw, path, [
        'calendarId',
        'timeMin',
        'timeMax',
        'query',
        'maxResults',
      ]);
      const timeMin = parseRfc3339Instant(
        requiredString(record, 'timeMin', path),
        `${path}.timeMin`,
      );
      const timeMax = parseRfc3339Instant(
        requiredString(record, 'timeMax', path),
        `${path}.timeMax`,
      );
      if (Date.parse(timeMax) <= Date.parse(timeMin)) {
        fail(`${path}.timeMax`, 'must be later than timeMin');
      }
      const query = optionalQuery(record, 'query', path);
      return {
        calendarId: calendarId(
          requiredString(record, 'calendarId', path),
          `${path}.calendarId`,
        ),
        timeMin,
        timeMax,
        ...(query === undefined ? {} : { query }),
        maxResults: maxResults(record, path),
      };
    }

    case 'gmail_search_threads': {
      const record = strictRecord(raw, path, ['query', 'maxResults']);
      const query = optionalQuery(record, 'query', path);
      return {
        ...(query === undefined ? {} : { query }),
        maxResults: maxResults(record, path),
      };
    }

    case 'gmail_get_thread': {
      const record = strictRecord(raw, path, ['threadId']);
      return {
        threadId: resourceId(
          requiredString(record, 'threadId', path),
          `${path}.threadId`,
        ),
      };
    }
  }
}

export function googleWorkspaceToolClassification(
  tool: GoogleWorkspaceTool,
): GoogleWorkspaceToolClassification {
  return GOOGLE_WORKSPACE_TOOL_CLASSIFICATION[tool];
}

export function parseGoogleWorkspaceOperation(
  raw: unknown,
): GoogleWorkspaceOperationParseResult {
  try {
    const record = strictRecord(raw, 'operation', [
      'type',
      'request_id',
      'tool',
      'args',
    ]);
    if (record.type !== 'google_api') {
      fail('operation.type', 'expected google_api');
    }
    let requestId: string | undefined;
    if (hasOwn(record, 'request_id')) {
      if (
        typeof record.request_id !== 'string' ||
        !REQUEST_ID_RE.test(record.request_id)
      ) {
        fail(
          'operation.request_id',
          'expected 8-128 URL-safe identifier characters',
        );
      }
      requestId = record.request_id;
    }
    if (typeof record.tool !== 'string' || !TOOL_NAME_SET.has(record.tool)) {
      fail('operation.tool', 'unknown Google Workspace tool');
    }
    if (!hasOwn(record, 'args')) fail('operation.args', 'field is required');
    const tool = record.tool as GoogleWorkspaceTool;
    const args = parseArgs(tool, record.args);
    return {
      ok: true,
      value: {
        type: 'google_api',
        ...(requestId === undefined ? {} : { request_id: requestId }),
        tool,
        args,
      } as GoogleWorkspaceOperation,
    };
  } catch (err) {
    return {
      ok: false,
      error:
        err instanceof OperationParseFailure
          ? err.message
          : 'operation: invalid Google Workspace operation',
    };
  }
}

/**
 * Return a freshly validated object whose property order is canonical. This is
 * suitable for exact-envelope capability binding and includes `request_id`.
 */
export function canonicalGoogleWorkspaceEnvelopeObject(
  raw: GoogleWorkspaceOperation,
): GoogleWorkspaceOperation {
  const parsed = parseGoogleWorkspaceOperation(raw);
  if (!parsed.ok) throw new TypeError(parsed.error);
  return parsed.value;
}

export function canonicalGoogleWorkspaceEnvelopeJson(
  raw: GoogleWorkspaceOperation,
): string {
  return JSON.stringify(canonicalGoogleWorkspaceEnvelopeObject(raw));
}

export function sha256Hex(value: string | Buffer): Sha256Hex {
  return createHash('sha256').update(value).digest('hex') as Sha256Hex;
}

/**
 * Stable idempotency/audit fingerprint. `request_id` is deliberately excluded:
 * retries of the same exact tool/resource/payload describe one operation.
 */
export function googleWorkspaceOperationFingerprint(
  raw: GoogleWorkspaceOperation,
): Sha256Hex {
  const canonical = canonicalGoogleWorkspaceEnvelopeObject(raw);
  const operation = {
    type: canonical.type,
    tool: canonical.tool,
    args: canonical.args,
  };
  return sha256Hex(JSON.stringify(operation));
}
