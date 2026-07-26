/**
 * Google-сервисы для панели: Workspace (Drive/Sheets/Apps Script) и Календарь.
 *
 * Обзор (collectGoogleOverview) — синхронный и без сети: только .env, файлы
 * и БД, безопасно дергать при каждом рендере вкладки. Живые проверки
 * (verifyGoogleWorkspace / verifyGoogleCalendar) ходят в Google API и
 * запускаются только по явной кнопке «Проверить» (?verify=1).
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import { readEnvFile } from '@skoobi/shared/env';
import { logger } from '@skoobi/shared/logger';

import { STATE_ROOT } from './config.js';
import { readDb } from './db.js';

// ── Типы ────────────────────────────────────────────────────────────────────

export type GoogleWorkspaceOverview = {
  enabled: boolean;
  configured: boolean; // все креды на месте
  missing: string[]; // каких env не хватает (без значений)
  scopesHuman: string[]; // «Диск», «Таблицы», «Скрипты (Apps Script)»
  defaultScriptId: string | null;
  crm: { title: string; spreadsheetId: string; url: string } | null;
};

export type GoogleCalendarOverview = {
  enabled: boolean;
  configured: boolean;
  calendarId: string | null;
  timezone: string | null;
  keyFileFound: boolean;
  mirroredTasks: number; // задач с зеркалом в календаре (calendar_event_links)
};

export type GoogleOverview = {
  workspace: GoogleWorkspaceOverview;
  calendar: GoogleCalendarOverview;
};

export type WorkspaceVerify =
  | { ok: true; account: string; accountName: string }
  | { ok: false; error: string };

export type CalendarVerify =
  | { ok: true; upcoming: Array<{ when: string; title: string }> }
  | { ok: false; error: string };

// ── Обзор (без сети) ────────────────────────────────────────────────────────

const SCOPE_RU: Record<string, string> = {
  'https://www.googleapis.com/auth/drive': 'Диск',
  'https://www.googleapis.com/auth/spreadsheets': 'Таблицы',
  'https://www.googleapis.com/auth/spreadsheets.readonly':
    'Таблицы (только чтение)',
  'https://www.googleapis.com/auth/script.projects': 'Скрипты (Apps Script)',
  'https://www.googleapis.com/auth/script.projects.readonly':
    'Скрипты (только чтение)',
};

const GOOGLE_VERIFY_TIMEOUT_MS = 10_000;
const GOOGLE_VERIFY_MAX_RESPONSE_BYTES = 256 * 1024;
const MAX_CRM_TOPIC_BYTES = 256 * 1024;
const MAX_SERVICE_ACCOUNT_FILE_BYTES = 64 * 1024;
const MAX_REFRESH_TOKEN_FILE_BYTES = 16 * 1024;
const CALENDAR_VERIFY_SCOPE =
  'https://www.googleapis.com/auth/calendar.events.readonly';
const DEFAULT_GOOGLE_CALENDAR_TIMEZONE = 'Asia/Almaty';
const GOOGLE_CALENDAR_ID_RE = /^[A-Za-z0-9.!#$%&'*+=?^_`{|}~@-]{1,256}$/;

type SafeFileOptions = {
  maxBytes: number;
  exactMode?: number;
};

function openSafeRegularFile(
  filePath: string,
  options: SafeFileOptions,
): { fd: number; stat: fs.Stats } {
  const flags =
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK;
  const fd = fs.openSync(filePath, flags);
  try {
    const stat = fs.fstatSync(fd);
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      stat.size <= 0 ||
      stat.size > options.maxBytes ||
      (options.exactMode !== undefined &&
        (stat.mode & 0o777) !== options.exactMode)
    ) {
      throw new Error('unsafe file metadata');
    }
    return { fd, stat };
  } catch (err) {
    fs.closeSync(fd);
    throw err;
  }
}

/**
 * Read one already-opened inode with a hard byte ceiling. O_NOFOLLOW rejects a
 * final symlink, O_NONBLOCK prevents FIFO hangs, nlink=1 rejects hard-link
 * aliases, and the final fstat detects replace/grow/truncate races.
 */
function readSafeRegularFile(
  filePath: string,
  options: SafeFileOptions,
): Buffer {
  const { fd, stat: before } = openSafeRegularFile(filePath, options);
  try {
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
      (options.exactMode !== undefined &&
        (after.mode & 0o777) !== options.exactMode)
    ) {
      throw new Error('file changed while reading');
    }
    return buffer;
  } finally {
    fs.closeSync(fd);
  }
}

function stateContainedRegularFile(configuredPath: string): string {
  const raw = configuredPath.trim();
  if (
    !raw ||
    raw.includes('\0') ||
    raw.includes('\\') ||
    raw.split('/').includes('..')
  ) {
    throw new Error('unsafe state file path');
  }

  const lexicalRoot = path.resolve(STATE_ROOT);
  const requestedPath = path.isAbsolute(raw)
    ? path.resolve(raw)
    : path.resolve(lexicalRoot, raw);
  const relative = path.relative(lexicalRoot, requestedPath);
  if (
    !relative ||
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error('state file is outside STATE_ROOT');
  }

  const realRoot = fs.realpathSync.native(lexicalRoot);
  const parentRelative = path.dirname(relative);
  let checkedParent = realRoot;
  if (parentRelative !== '.') {
    for (const component of parentRelative.split(path.sep)) {
      checkedParent = path.join(checkedParent, component);
      const stat = fs.lstatSync(checkedParent);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new Error('unsafe state file parent');
      }
    }
  }

  const realParent = fs.realpathSync.native(checkedParent);
  const realParentRelative = path.relative(realRoot, realParent);
  if (
    realParentRelative === '..' ||
    realParentRelative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(realParentRelative)
  ) {
    throw new Error('state file parent escaped STATE_ROOT');
  }
  return path.join(realParent, path.basename(relative));
}

function safeRegularFileAvailable(
  filePath: string,
  options: SafeFileOptions,
): boolean {
  let fd: number | null = null;
  try {
    const opened = openSafeRegularFile(filePath, options);
    fd = opened.fd;
    return true;
  } catch {
    return false;
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

async function boundedJson<T>(response: Response): Promise<T> {
  const length = Number(response.headers?.get?.('content-length') || 0);
  if (Number.isFinite(length) && length > GOOGLE_VERIFY_MAX_RESPONSE_BYTES) {
    throw new Error('Google response is too large');
  }
  if (response.body?.getReader) {
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > GOOGLE_VERIFY_MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error('Google response is too large');
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return JSON.parse(new TextDecoder().decode(bytes) || '{}') as T;
  }
  // Unit-test response doubles expose json() without a real body. Production
  // Response objects always take the bounded streaming branch above.
  return (await response.json()) as T;
}

async function boundedJsonOrEmpty<T extends object>(
  response: Response,
): Promise<Partial<T>> {
  try {
    return await boundedJson<T>(response);
  } catch {
    return {};
  }
}

const googleVerifySignal = () => AbortSignal.timeout(GOOGLE_VERIFY_TIMEOUT_MS);

export function humanScopes(raw: string | undefined): string[] {
  return (raw || '')
    .split(/[,\s]+/)
    .filter(Boolean)
    .map(
      (s) => SCOPE_RU[s] || s.replace('https://www.googleapis.com/auth/', ''),
    );
}

/** Parse the optional legacy CRM topic configured by the host owner. */
export function parseCrmTopic(
  text: string,
): { title: string; spreadsheetId: string; url: string } | null {
  const id = text.match(/spreadsheetId:\s*`([A-Za-z0-9_-]{20,256})`/)?.[1];
  if (!id) return null;
  const title = (
    text.match(/\*\*«([^»]{1,200})»\*\*[^\n]*spreadsheetId/)?.[1] ||
    'CRM-таблица'
  ).slice(0, 200);
  return {
    title,
    spreadsheetId: id,
    url: `https://docs.google.com/spreadsheets/d/${id}/edit`,
  };
}

function readConfiguredEnv(keys: string[]): Record<string, string | undefined> {
  const file = readEnvFile(keys);
  return Object.fromEntries(
    keys.map((key) => [key, process.env[key] ?? file[key]]),
  );
}

function readWorkspaceEnv(): Record<string, string | undefined> {
  return readConfiguredEnv([
    'SKOOBI_GOOGLE_WORKSPACE_ENABLED',
    'SKOOBI_GOOGLE_WORKSPACE_OAUTH_CLIENT_ID',
    'SKOOBI_GOOGLE_WORKSPACE_OAUTH_CLIENT_SECRET',
    'SKOOBI_GOOGLE_WORKSPACE_REFRESH_TOKEN',
    'SKOOBI_GOOGLE_WORKSPACE_REFRESH_TOKEN_FILE',
    'SKOOBI_GOOGLE_WORKSPACE_SCOPES',
    'SKOOBI_GOOGLE_WORKSPACE_DEFAULT_SCRIPT_ID',
    'SKOOBI_GOOGLE_WORKSPACE_DEFAULT_SPREADSHEET_ID',
    'SKOOBI_GOOGLE_WORKSPACE_LEGACY_CRM_TOPIC_FILE',
  ]);
}

function workspaceRefreshToken(
  env: Record<string, string | undefined>,
): string {
  const file = env.SKOOBI_GOOGLE_WORKSPACE_REFRESH_TOKEN_FILE || '';
  if (file) {
    try {
      const token = readSafeRegularFile(file, {
        maxBytes: MAX_REFRESH_TOKEN_FILE_BYTES,
        exactMode: 0o600,
      })
        .toString('utf8')
        .trim();
      return token && !/\s/.test(token) ? token : '';
    } catch {
      // A configured token file is authoritative and fail-closed. Never fall
      // back to a stale inline token when the file is unsafe or unreadable.
      return '';
    }
  }
  return env.SKOOBI_GOOGLE_WORKSPACE_REFRESH_TOKEN || '';
}

function readCalendarEnv(): Record<string, string | undefined> {
  return readConfiguredEnv([
    'SKOOBI_GOOGLE_CALENDAR_ENABLED',
    'SKOOBI_GOOGLE_CALENDAR_ID',
    'SKOOBI_GOOGLE_CALENDAR_KEY_FILE',
    'SKOOBI_GOOGLE_CALENDAR_SCOPE',
    'SKOOBI_GOOGLE_CALENDAR_TIMEZONE',
    'GOOGLE_APPLICATION_CREDENTIALS',
  ]);
}

const on = (v: string | undefined) =>
  ['1', 'true', 'yes', 'on'].includes(String(v || '').toLowerCase());

function resolvedCalendarConfig(cal: Record<string, string | undefined>) {
  const keyFile =
    cal.SKOOBI_GOOGLE_CALENDAR_KEY_FILE ||
    cal.GOOGLE_APPLICATION_CREDENTIALS ||
    '';
  const explicitEnabled = cal.SKOOBI_GOOGLE_CALENDAR_ENABLED;
  const rawCalendarId = String(cal.SKOOBI_GOOGLE_CALENDAR_ID || '').trim();
  const calendarId = GOOGLE_CALENDAR_ID_RE.test(rawCalendarId)
    ? rawCalendarId
    : '';
  const requestedEnabled =
    explicitEnabled === undefined || explicitEnabled === ''
      ? Boolean(keyFile)
      : on(explicitEnabled);
  return {
    enabled: requestedEnabled && Boolean(calendarId),
    keyFile,
    calendarId,
    timezone:
      cal.SKOOBI_GOOGLE_CALENDAR_TIMEZONE || DEFAULT_GOOGLE_CALENDAR_TIMEZONE,
  };
}

export function collectGoogleOverview(): GoogleOverview {
  const ws = readWorkspaceEnv();
  const refreshToken = workspaceRefreshToken(ws);
  const missing = [
    ['SKOOBI_GOOGLE_WORKSPACE_OAUTH_CLIENT_ID', 'Client ID'],
    ['SKOOBI_GOOGLE_WORKSPACE_OAUTH_CLIENT_SECRET', 'Client secret'],
  ]
    .filter(([key]) => !ws[key])
    .map(([, label]) => label);
  if (!refreshToken) missing.push('Refresh token');

  let crm: GoogleWorkspaceOverview['crm'] = null;
  const configuredSpreadsheetId =
    ws.SKOOBI_GOOGLE_WORKSPACE_DEFAULT_SPREADSHEET_ID || '';
  if (/^[A-Za-z0-9_-]{20,256}$/.test(configuredSpreadsheetId)) {
    crm = {
      title: 'Основная Google-таблица',
      spreadsheetId: configuredSpreadsheetId,
      url: `https://docs.google.com/spreadsheets/d/${configuredSpreadsheetId}/edit`,
    };
  } else if (ws.SKOOBI_GOOGLE_WORKSPACE_LEGACY_CRM_TOPIC_FILE) {
    try {
      const legacyFile = stateContainedRegularFile(
        ws.SKOOBI_GOOGLE_WORKSPACE_LEGACY_CRM_TOPIC_FILE,
      );
      crm = parseCrmTopic(
        readSafeRegularFile(legacyFile, {
          maxBytes: MAX_CRM_TOPIC_BYTES,
        }).toString('utf8'),
      );
    } catch {
      /* Explicit legacy file is unsafe/unreadable — CRM remains unset. */
    }
  }

  const cal = readCalendarEnv();
  const calendarConfig = resolvedCalendarConfig(cal);
  const keyFile = calendarConfig.keyFile;
  let keyFileFound = false;
  if (keyFile) {
    keyFileFound = safeRegularFileAvailable(keyFile, {
      maxBytes: MAX_SERVICE_ACCOUNT_FILE_BYTES,
      exactMode: 0o600,
    });
  }

  let mirroredTasks = 0;
  try {
    const row = readDb()
      .prepare('SELECT COUNT(DISTINCT task_id) AS n FROM calendar_event_links')
      .get() as { n: number };
    mirroredTasks = row?.n ?? 0;
  } catch {
    /* нет таблицы/БД — просто 0 */
  }

  return {
    workspace: {
      enabled: on(ws.SKOOBI_GOOGLE_WORKSPACE_ENABLED),
      configured:
        on(ws.SKOOBI_GOOGLE_WORKSPACE_ENABLED) && missing.length === 0,
      missing,
      scopesHuman: humanScopes(ws.SKOOBI_GOOGLE_WORKSPACE_SCOPES),
      defaultScriptId: ws.SKOOBI_GOOGLE_WORKSPACE_DEFAULT_SCRIPT_ID || null,
      crm,
    },
    calendar: {
      enabled: calendarConfig.enabled,
      configured:
        calendarConfig.enabled &&
        Boolean(calendarConfig.calendarId) &&
        keyFileFound,
      calendarId: calendarConfig.calendarId || null,
      timezone: calendarConfig.timezone,
      keyFileFound,
      mirroredTasks,
    },
  };
}

// ── Живые проверки ──────────────────────────────────────────────────────────

/** OAuth + Drive only: confirms the account, not every configured API scope. */
export async function verifyGoogleWorkspace(
  // Тестовый шов: юнит-тесты не должны зависеть от .env конкретной машины.
  envOverride?: Record<string, string | undefined>,
): Promise<WorkspaceVerify> {
  const ws = envOverride ?? readWorkspaceEnv();
  if (!on(ws.SKOOBI_GOOGLE_WORKSPACE_ENABLED)) {
    return { ok: false, error: 'Google Workspace выключен' };
  }
  const refreshToken = workspaceRefreshToken(ws);
  if (
    !ws.SKOOBI_GOOGLE_WORKSPACE_OAUTH_CLIENT_ID ||
    !ws.SKOOBI_GOOGLE_WORKSPACE_OAUTH_CLIENT_SECRET ||
    !refreshToken
  ) {
    return {
      ok: false,
      error: 'Google Workspace не настроен: проверь OAuth-креды',
    };
  }
  try {
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      signal: googleVerifySignal(),
      body: new URLSearchParams({
        client_id: ws.SKOOBI_GOOGLE_WORKSPACE_OAUTH_CLIENT_ID,
        client_secret: ws.SKOOBI_GOOGLE_WORKSPACE_OAUTH_CLIENT_SECRET,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
      }),
    });
    const tok = await boundedJsonOrEmpty<{
      access_token?: string;
      error?: string;
      error_description?: string;
    }>(tokenRes);
    if (!tokenRes.ok || !tok.access_token) {
      return {
        ok: false,
        error: `Google не принял OAuth-доступ (HTTP ${tokenRes.status})`,
      };
    }
    const aboutRes = await fetch(
      'https://www.googleapis.com/drive/v3/about?fields=user(displayName,emailAddress)',
      {
        headers: { Authorization: `Bearer ${tok.access_token}` },
        signal: googleVerifySignal(),
      },
    );
    const about = await boundedJsonOrEmpty<{
      user?: { displayName?: string; emailAddress?: string };
    }>(aboutRes);
    if (!aboutRes.ok || !about.user) {
      return { ok: false, error: `Drive API ответил ${aboutRes.status}` };
    }
    return {
      ok: true,
      account: about.user.emailAddress || 'неизвестно',
      accountName: about.user.displayName || '',
    };
  } catch (err) {
    logger.warn(
      {
        component: 'google_workspace_verify',
        errorType: err instanceof Error ? err.name : typeof err,
      },
      'dashboard: google workspace verify failed',
    );
    return { ok: false, error: 'Сеть/Google недоступны — попробуй ещё раз' };
  }
}

/** Access token сервисного аккаунта календаря (RS256 JWT grant, node crypto). */
async function calendarAccessToken(
  keyFile: string,
  scope: string,
): Promise<string> {
  const sa = JSON.parse(
    readSafeRegularFile(keyFile, {
      maxBytes: MAX_SERVICE_ACCOUNT_FILE_BYTES,
      exactMode: 0o600,
    }).toString('utf8'),
  ) as { type?: unknown; client_email?: unknown; private_key?: unknown };
  if (
    sa.type !== 'service_account' ||
    typeof sa.client_email !== 'string' ||
    !sa.client_email ||
    sa.client_email.length > 512 ||
    typeof sa.private_key !== 'string' ||
    !sa.private_key ||
    sa.private_key.length > MAX_SERVICE_ACCOUNT_FILE_BYTES
  ) {
    throw new Error('invalid service-account key');
  }
  const b64 = (data: string | Buffer) =>
    Buffer.from(data).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const header = b64(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64(
    JSON.stringify({
      iss: sa.client_email,
      scope,
      aud: 'https://oauth2.googleapis.com/token',
      iat: now,
      exp: now + 600,
    }),
  );
  const signature = crypto
    .createSign('RSA-SHA256')
    .update(`${header}.${claims}`)
    .sign(sa.private_key);
  const jwt = `${header}.${claims}.${b64(signature)}`;
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    signal: googleVerifySignal(),
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  });
  const tok = await boundedJsonOrEmpty<{
    access_token?: string;
    error?: string;
  }>(res);
  if (!res.ok || !tok.access_token) {
    throw new Error(`calendar OAuth failed with HTTP ${res.status}`);
  }
  return tok.access_token;
}

/** Календарь: SA-токен → ближайшие события (подтверждает доступ end-to-end). */
export async function verifyGoogleCalendar(
  // Тестовый шов: юнит-тесты не должны зависеть от .env конкретной машины.
  envOverride?: Record<string, string | undefined>,
): Promise<CalendarVerify> {
  const cal = envOverride ?? readCalendarEnv();
  const calendarConfig = resolvedCalendarConfig(cal);
  if (!calendarConfig.enabled) {
    return { ok: false, error: 'Google Calendar выключен' };
  }
  const keyFile = calendarConfig.keyFile;
  const calendarId = calendarConfig.calendarId;
  if (
    !calendarId ||
    !keyFile ||
    !safeRegularFileAvailable(keyFile, {
      maxBytes: MAX_SERVICE_ACCOUNT_FILE_BYTES,
      exactMode: 0o600,
    })
  ) {
    return {
      ok: false,
      error: 'Календарь не настроен: проверь id и защищённый ключ-файл',
    };
  }
  try {
    const token = await calendarAccessToken(keyFile, CALENDAR_VERIFY_SCOPE);
    const params = new URLSearchParams({
      timeMin: new Date().toISOString(),
      maxResults: '3',
      singleEvents: 'true',
      orderBy: 'startTime',
      fields: 'items(summary,start)',
    });
    const res = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events?${params}`,
      {
        headers: { Authorization: `Bearer ${token}` },
        signal: googleVerifySignal(),
      },
    );
    const body = await boundedJsonOrEmpty<{
      items?: Array<{
        summary?: string;
        start?: { dateTime?: string; date?: string };
      }>;
    }>(res);
    if (!res.ok) {
      return { ok: false, error: `Calendar API ответил ${res.status}` };
    }
    const tz = calendarConfig.timezone;
    const upcoming = (body.items || []).map((ev) => {
      const startRaw = ev.start?.dateTime || ev.start?.date || '';
      let when = startRaw;
      try {
        when = new Date(startRaw).toLocaleString('ru-RU', {
          timeZone: tz,
          day: 'numeric',
          month: 'short',
          hour: '2-digit',
          minute: '2-digit',
        });
      } catch {
        /* оставляем сырой ISO — лучше, чем упасть */
      }
      return { when, title: ev.summary || 'без названия' };
    });
    return { ok: true, upcoming };
  } catch (err) {
    logger.warn(
      {
        component: 'google_calendar_verify',
        errorType: err instanceof Error ? err.name : typeof err,
      },
      'dashboard: google calendar verify failed',
    );
    return {
      ok: false,
      error:
        'Проверка календаря не удалась — проверь настройки и попробуй ещё раз',
    };
  }
}
