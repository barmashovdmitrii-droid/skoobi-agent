import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  stateRoot: `/tmp/skoobi-dashboard-google-${process.pid}`,
  readEnvFile: vi.fn(() => ({}) as Record<string, string>),
  loggerWarn: vi.fn(),
}));

vi.mock('@skoobi/shared/env', () => ({ readEnvFile: mocks.readEnvFile }));
vi.mock('@skoobi/shared/logger', () => ({
  logger: { warn: mocks.loggerWarn },
}));
vi.mock('./config.js', () => ({ STATE_ROOT: mocks.stateRoot }));
vi.mock('./db.js', () => ({ readDb: vi.fn(), writeDb: vi.fn() }));

import {
  collectGoogleOverview,
  humanScopes,
  parseCrmTopic,
  verifyGoogleCalendar,
  verifyGoogleWorkspace,
} from './google.js';

const WS_ENV = {
  SKOOBI_GOOGLE_WORKSPACE_ENABLED: 'true',
  SKOOBI_GOOGLE_WORKSPACE_OAUTH_CLIENT_ID: 'cid',
  SKOOBI_GOOGLE_WORKSPACE_OAUTH_CLIENT_SECRET: 'csec',
  SKOOBI_GOOGLE_WORKSPACE_REFRESH_TOKEN: 'refresh-secret-value',
};

const tempDirs = new Set<string>();

// Самодостаточный SA-ключ: настоящая RSA-пара, никакой зависимости от машины.
function makeSaKeyFile(): string {
  const { privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
  });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dash-google-'));
  tempDirs.add(dir);
  const file = path.join(dir, 'sa.json');
  fs.writeFileSync(
    file,
    JSON.stringify({
      type: 'service_account',
      client_email: 'robot@example.iam.gserviceaccount.com',
      private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    }),
    { mode: 0o600 },
  );
  return file;
}

function makeTokenFile(content = 'refresh-from-file', mode = 0o600): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dash-google-token-'));
  tempDirs.add(dir);
  const file = path.join(dir, 'refresh-token');
  fs.writeFileSync(file, content, { mode });
  return file;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  mocks.readEnvFile.mockReset();
  mocks.readEnvFile.mockReturnValue({});
  mocks.loggerWarn.mockReset();
  fs.rmSync(mocks.stateRoot, { recursive: true, force: true });
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
  tempDirs.clear();
});

describe('humanScopes', () => {
  it('переводит известные скоупы и мягко режет неизвестные', () => {
    expect(
      humanScopes(
        'https://www.googleapis.com/auth/drive,https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/script.projects',
      ),
    ).toEqual(['Диск', 'Таблицы', 'Скрипты (Apps Script)']);
    expect(
      humanScopes(
        'https://www.googleapis.com/auth/spreadsheets.readonly https://www.googleapis.com/auth/script.projects.readonly',
      ),
    ).toEqual(['Таблицы (только чтение)', 'Скрипты (только чтение)']);
    expect(
      humanScopes('https://www.googleapis.com/auth/calendar.events'),
    ).toEqual(['calendar.events']);
    expect(humanScopes(undefined)).toEqual([]);
  });
});

describe('parseCrmTopic', () => {
  it('вытаскивает название и id из строки памяти Скуби', () => {
    const topic = [
      '## Рабочая CRM-таблица владельца (записано 2026-07-09)',
      '- **«PUBLIC FIXTURE»** — spreadsheetId: `public-fixture-spreadsheet-id-0001`',
    ].join('\n');
    expect(parseCrmTopic(topic)).toEqual({
      title: 'PUBLIC FIXTURE',
      spreadsheetId: 'public-fixture-spreadsheet-id-0001',
      url: [
        'https://docs.google.com/spreadsheets/d',
        'public-fixture-spreadsheet-id-0001',
        'edit',
      ].join('/'),
    });
  });

  it('без id — null, без названия — generic заголовок', () => {
    expect(parseCrmTopic('просто текст без таблицы')).toBeNull();
    const parsed = parseCrmTopic(
      'таблица тут: spreadsheetId: `public-fixture-spreadsheet-id-0001`',
    );
    expect(parsed?.title).toBe('CRM-таблица');
  });
});

describe('collectGoogleOverview CRM file boundary', () => {
  const crmFile = path.join(mocks.stateRoot, 'data', 'legacy-crm-topic.md');
  const crmLine =
    '- **«SAFE CRM»** — spreadsheetId: `public-fixture-spreadsheet-id-0001`';

  it('не читает legacy topic без явной opt-in настройки', () => {
    fs.mkdirSync(path.dirname(crmFile), { recursive: true });
    fs.writeFileSync(crmFile, crmLine);
    expect(collectGoogleOverview().workspace.crm).toBeNull();
  });

  it('читает явно настроенный bounded regular topic через безопасный fd', () => {
    fs.mkdirSync(path.dirname(crmFile), { recursive: true });
    fs.writeFileSync(crmFile, crmLine);
    mocks.readEnvFile.mockReturnValue({
      SKOOBI_GOOGLE_WORKSPACE_LEGACY_CRM_TOPIC_FILE: 'data/legacy-crm-topic.md',
    });
    expect(collectGoogleOverview().workspace.crm?.title).toBe('SAFE CRM');
  });

  it('не следует CRM symlink и не читает oversized topic', () => {
    fs.mkdirSync(path.dirname(crmFile), { recursive: true });
    mocks.readEnvFile.mockReturnValue({
      SKOOBI_GOOGLE_WORKSPACE_LEGACY_CRM_TOPIC_FILE: crmFile,
    });
    const outside = makeTokenFile(crmLine, 0o600);
    fs.symlinkSync(outside, crmFile);
    expect(collectGoogleOverview().workspace.crm).toBeNull();

    fs.unlinkSync(crmFile);
    fs.writeFileSync(crmFile, 'x'.repeat(256 * 1024 + 1));
    expect(collectGoogleOverview().workspace.crm).toBeNull();
  });

  it('отклоняет CRM path с traversal, вне STATE_ROOT и через parent symlink', () => {
    fs.mkdirSync(path.join(mocks.stateRoot, 'data'), { recursive: true });
    fs.writeFileSync(crmFile, crmLine);
    const outsideDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'dash-google-outside-'),
    );
    tempDirs.add(outsideDir);
    const outsideFile = path.join(outsideDir, 'legacy-crm-topic.md');
    fs.writeFileSync(outsideFile, crmLine);

    for (const configuredFile of [
      `${mocks.stateRoot}/data/../data/legacy-crm-topic.md`,
      outsideFile,
    ]) {
      mocks.readEnvFile.mockReturnValue({
        SKOOBI_GOOGLE_WORKSPACE_LEGACY_CRM_TOPIC_FILE: configuredFile,
      });
      expect(collectGoogleOverview().workspace.crm).toBeNull();
    }

    const realParent = path.join(mocks.stateRoot, 'real-parent');
    fs.mkdirSync(realParent);
    fs.writeFileSync(path.join(realParent, 'legacy-crm-topic.md'), crmLine);
    const linkedParent = path.join(mocks.stateRoot, 'linked-parent');
    fs.symlinkSync(realParent, linkedParent);
    mocks.readEnvFile.mockReturnValue({
      SKOOBI_GOOGLE_WORKSPACE_LEGACY_CRM_TOPIC_FILE: path.join(
        linkedParent,
        'legacy-crm-topic.md',
      ),
    });
    expect(collectGoogleOverview().workspace.crm).toBeNull();
  });

  it('не включает Calendar только из-за GOOGLE_APPLICATION_CREDENTIALS', () => {
    const keyFile = makeSaKeyFile();
    vi.stubEnv('SKOOBI_GOOGLE_CALENDAR_ENABLED', '');
    vi.stubEnv('GOOGLE_APPLICATION_CREDENTIALS', keyFile);

    expect(collectGoogleOverview().calendar).toMatchObject({
      enabled: false,
      configured: false,
      keyFileFound: true,
      calendarId: null,
    });
  });

  it('отклоняет invalid Calendar ID без приватного fallback', () => {
    const keyFile = makeSaKeyFile();
    vi.stubEnv('SKOOBI_GOOGLE_CALENDAR_ENABLED', 'true');
    vi.stubEnv('GOOGLE_APPLICATION_CREDENTIALS', keyFile);
    vi.stubEnv('SKOOBI_GOOGLE_CALENDAR_ID', 'https://calendar.invalid/id');

    expect(collectGoogleOverview().calendar).toMatchObject({
      enabled: false,
      configured: false,
      keyFileFound: true,
      calendarId: null,
    });
  });

  it('совпадает с runtime: process env приоритетен, explicit primary разрешён', () => {
    const keyFile = makeSaKeyFile();
    mocks.readEnvFile.mockReturnValue({
      SKOOBI_GOOGLE_WORKSPACE_ENABLED: 'false',
    });
    vi.stubEnv('SKOOBI_GOOGLE_WORKSPACE_ENABLED', 'true');
    vi.stubEnv('SKOOBI_GOOGLE_WORKSPACE_OAUTH_CLIENT_ID', 'process-client');
    vi.stubEnv('SKOOBI_GOOGLE_WORKSPACE_OAUTH_CLIENT_SECRET', 'process-secret');
    vi.stubEnv('SKOOBI_GOOGLE_WORKSPACE_REFRESH_TOKEN', 'process-refresh');
    vi.stubEnv('SKOOBI_GOOGLE_CALENDAR_ENABLED', '');
    vi.stubEnv('GOOGLE_APPLICATION_CREDENTIALS', keyFile);
    vi.stubEnv('SKOOBI_GOOGLE_CALENDAR_ID', 'primary');

    const overview = collectGoogleOverview();
    expect(overview.workspace).toMatchObject({
      enabled: true,
      configured: true,
    });
    expect(overview.calendar).toMatchObject({
      enabled: true,
      configured: true,
      keyFileFound: true,
      calendarId: 'primary',
      timezone: 'Asia/Almaty',
    });
  });

  it('не отклоняет explicit Calendar ID с допустимым plus alias', () => {
    const keyFile = makeSaKeyFile();
    vi.stubEnv('SKOOBI_GOOGLE_CALENDAR_ENABLED', 'true');
    vi.stubEnv('GOOGLE_APPLICATION_CREDENTIALS', keyFile);
    vi.stubEnv('SKOOBI_GOOGLE_CALENDAR_ID', 'owner+reminders@example.com');

    expect(collectGoogleOverview().calendar).toMatchObject({
      enabled: true,
      configured: true,
      keyFileFound: true,
      calendarId: 'owner+reminders@example.com',
    });
  });
});

describe('verifyGoogleWorkspace', () => {
  it('выключенный Workspace не читает сеть даже при оставшихся кредах', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const result = await verifyGoogleWorkspace({
      ...WS_ENV,
      SKOOBI_GOOGLE_WORKSPACE_ENABLED: 'false',
    });
    expect(result).toEqual({ ok: false, error: 'Google Workspace выключен' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('без кредов — понятная ошибка, без сети', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const result = await verifyGoogleWorkspace({});
    expect(result.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('возвращает bounded generic ошибку для отозванного token', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 400,
        json: async () => ({
          error: 'invalid_grant',
          error_description: 'Token has been expired or revoked.',
        }),
      })),
    );
    const result = await verifyGoogleWorkspace(WS_ENV);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('Google не принял OAuth-доступ (HTTP 400)');
      expect(result.error).not.toContain('Token has been expired');
    }
  });

  it('успешный путь возвращает аккаунт из Drive about', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (String(url).startsWith('https://oauth2.googleapis.com/token')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({ access_token: 'at', expires_in: 3600 }),
          };
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({
            user: { emailAddress: 'owner@example.com', displayName: 'Owner' },
          }),
        };
      }),
    );
    const result = await verifyGoogleWorkspace(WS_ENV);
    expect(result).toEqual({
      ok: true,
      account: 'owner@example.com',
      accountName: 'Owner',
    });
  });

  it('fail-closed отклоняет symlink, hardlink, permissive и oversized token files', async () => {
    const target = makeTokenFile();
    const symlink = `${target}.symlink`;
    fs.symlinkSync(target, symlink);
    const hardlink = `${target}.hardlink`;
    fs.linkSync(target, hardlink);
    const permissive = makeTokenFile('refresh-permissive', 0o644);
    const oversized = makeTokenFile('x'.repeat(16 * 1024 + 1), 0o600);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    for (const tokenFile of [symlink, hardlink, permissive, oversized]) {
      const result = await verifyGoogleWorkspace({
        ...WS_ENV,
        // A configured file is authoritative: unsafe file must never fall back
        // to this otherwise-valid inline bearer.
        SKOOBI_GOOGLE_WORKSPACE_REFRESH_TOKEN: 'inline-must-not-win',
        SKOOBI_GOOGLE_WORKSPACE_REFRESH_TOKEN_FILE: tokenFile,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).not.toContain(tokenFile);
        expect(result.error).not.toContain('inline-must-not-win');
      }
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fail-closed отклоняет замену pathname во время чтения token file', async () => {
    const tokenFile = makeTokenFile('stable-refresh-token');
    const moved = `${tokenFile}.opened-inode`;
    const originalReadSync = fs.readSync;
    let swapped = false;
    vi.spyOn(fs, 'readSync').mockImplementation(((
      fd: number,
      buffer: NodeJS.ArrayBufferView,
      offset: number,
      length: number,
      position: number | null,
    ) => {
      if (!swapped) {
        swapped = true;
        fs.renameSync(tokenFile, moved);
        fs.writeFileSync(tokenFile, 'attacker-replacement', { mode: 0o600 });
      }
      return originalReadSync(fd, buffer, offset, length, position);
    }) as typeof fs.readSync);

    let submittedRefreshToken = '';
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (String(url).startsWith('https://oauth2.googleapis.com/token')) {
          submittedRefreshToken =
            new URLSearchParams(String(init?.body)).get('refresh_token') || '';
          return {
            ok: true,
            status: 200,
            json: async () => ({ access_token: 'at' }),
          };
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({
            user: { emailAddress: 'owner@example.com', displayName: 'Owner' },
          }),
        };
      }),
    );
    const result = await verifyGoogleWorkspace({
      ...WS_ENV,
      SKOOBI_GOOGLE_WORKSPACE_REFRESH_TOKEN: undefined,
      SKOOBI_GOOGLE_WORKSPACE_REFRESH_TOKEN_FILE: tokenFile,
    });
    expect(result.ok).toBe(false);
    expect(submittedRefreshToken).toBe('');
    expect(submittedRefreshToken).not.toBe('attacker-replacement');
  });

  it('fail-closed отклоняет same-inode metadata race token file', async () => {
    const tokenFile = makeTokenFile('stable-refresh-token');
    const originalFstat = fs.fstatSync.bind(fs);
    let calls = 0;
    vi.spyOn(fs, 'fstatSync').mockImplementation(((fd: number) => {
      const stat = originalFstat(fd);
      calls += 1;
      if (calls === 2) {
        Object.defineProperty(stat, 'ctimeMs', {
          value: stat.ctimeMs + 1,
        });
      }
      return stat;
    }) as typeof fs.fstatSync);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const result = await verifyGoogleWorkspace({
      ...WS_ENV,
      SKOOBI_GOOGLE_WORKSPACE_REFRESH_TOKEN: undefined,
      SKOOBI_GOOGLE_WORKSPACE_REFRESH_TOKEN_FILE: tokenFile,
    });
    expect(result.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('обрывает stalled fetch и логирует только безопасный тип ошибки', async () => {
    const controller = new AbortController();
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal);
    const fetchMock = vi.fn(
      async (_url: string, init?: RequestInit) =>
        await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(
              new DOMException('secret-bearing network detail', 'AbortError'),
            );
          });
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const pending = verifyGoogleWorkspace(WS_ENV);
    controller.abort();
    const result = await pending;

    expect(result).toEqual({
      ok: false,
      error: 'Сеть/Google недоступны — попробуй ещё раз',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(mocks.loggerWarn.mock.calls)).not.toContain(
      'secret-bearing network detail',
    );
    expect(JSON.stringify(mocks.loggerWarn.mock.calls)).not.toContain('csec');
    expect(JSON.stringify(mocks.loggerWarn.mock.calls)).not.toContain(
      'refresh-secret-value',
    );
  });

  it('останавливает streaming response выше 256 KiB', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ access_token: 'x'.repeat(256 * 1024 + 1) }),
          { status: 200 },
        ),
    );
    vi.stubGlobal('fetch', fetchMock);
    const result = await verifyGoogleWorkspace(WS_ENV);
    expect(result).toEqual({
      ok: false,
      error: 'Google не принял OAuth-доступ (HTTP 200)',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('verifyGoogleCalendar', () => {
  it('выключенный Calendar не делает fetch и не подписывает JWT', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const result = await verifyGoogleCalendar({
      SKOOBI_GOOGLE_CALENDAR_ENABLED: 'false',
      SKOOBI_GOOGLE_CALENDAR_ID: 'owner@example.com',
      SKOOBI_GOOGLE_CALENDAR_KEY_FILE: '/must/not/be/read.json',
    });
    expect(result).toEqual({ ok: false, error: 'Google Calendar выключен' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('успешный путь: auto-enable через credentials и explicit primary', async () => {
    const calEnv = {
      GOOGLE_APPLICATION_CREDENTIALS: makeSaKeyFile(),
      SKOOBI_GOOGLE_CALENDAR_ID: 'primary',
      SKOOBI_GOOGLE_CALENDAR_TIMEZONE: 'Asia/Almaty',
    };
    let requestedScope = '';
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (String(url).startsWith('https://oauth2.googleapis.com/token')) {
          const assertion =
            new URLSearchParams(String(init?.body)).get('assertion') || '';
          const claims = JSON.parse(
            Buffer.from(assertion.split('.')[1] || '', 'base64url').toString(
              'utf8',
            ),
          ) as { scope?: string };
          requestedScope = claims.scope || '';
          return {
            ok: true,
            status: 200,
            json: async () => ({ access_token: 'sa-at' }),
          };
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({
            items: [
              {
                summary: 'Напоминание: позвонить',
                start: { dateTime: '2026-07-10T09:00:00+05:00' },
              },
            ],
          }),
        };
      }),
    );
    const result = await verifyGoogleCalendar(calEnv);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.upcoming).toHaveLength(1);
      expect(result.upcoming[0].title).toBe('Напоминание: позвонить');
      expect(result.upcoming[0].when).toMatch(/10/);
    }
    expect(requestedScope).toBe(
      'https://www.googleapis.com/auth/calendar.events.readonly',
    );
  });

  it('без explicit calendar ID не делает fetch даже при безопасном key file', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const result = await verifyGoogleCalendar({
      GOOGLE_APPLICATION_CREDENTIALS: makeSaKeyFile(),
    });

    expect(result).toEqual({ ok: false, error: 'Google Calendar выключен' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('ошибка Calendar API не роняет ручку', async () => {
    const calEnv = {
      SKOOBI_GOOGLE_CALENDAR_ENABLED: 'true',
      SKOOBI_GOOGLE_CALENDAR_ID: 'owner@example.com',
      SKOOBI_GOOGLE_CALENDAR_KEY_FILE: makeSaKeyFile(),
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (String(url).startsWith('https://oauth2.googleapis.com/token')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({ access_token: 'sa-at' }),
          };
        }
        return { ok: false, status: 404, json: async () => ({}) };
      }),
    );
    const result = await verifyGoogleCalendar(calEnv);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('404');
    }
  });

  it('без ключ-файла — понятная ошибка, без сети', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const result = await verifyGoogleCalendar({
      SKOOBI_GOOGLE_CALENDAR_ENABLED: 'true',
      SKOOBI_GOOGLE_CALENDAR_ID: 'owner@example.com',
      SKOOBI_GOOGLE_CALENDAR_KEY_FILE: '/nonexistent/sa.json',
    });
    expect(result.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('отклоняет symlink, hardlink, permissive и oversized Calendar key до fetch', async () => {
    const target = makeSaKeyFile();
    const symlink = `${target}.symlink`;
    fs.symlinkSync(target, symlink);
    const hardlink = `${target}.hardlink`;
    fs.linkSync(target, hardlink);
    const permissive = makeSaKeyFile();
    fs.chmodSync(permissive, 0o644);
    const oversized = makeTokenFile('x'.repeat(64 * 1024 + 1), 0o600);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    for (const keyFile of [symlink, hardlink, permissive, oversized]) {
      const result = await verifyGoogleCalendar({
        SKOOBI_GOOGLE_CALENDAR_ENABLED: 'true',
        SKOOBI_GOOGLE_CALENDAR_ID: 'owner@example.com',
        SKOOBI_GOOGLE_CALENDAR_KEY_FILE: keyFile,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).not.toContain(keyFile);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('не возвращает path/JSON/OpenSSL detail из ошибки key parsing', async () => {
    const keyFile = makeTokenFile('{"private_key":"TOP_SECRET"}', 0o600);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const result = await verifyGoogleCalendar({
      SKOOBI_GOOGLE_CALENDAR_ENABLED: 'true',
      SKOOBI_GOOGLE_CALENDAR_ID: 'owner@example.com',
      SKOOBI_GOOGLE_CALENDAR_KEY_FILE: keyFile,
    });
    expect(result).toEqual({
      ok: false,
      error:
        'Проверка календаря не удалась — проверь настройки и попробуй ещё раз',
    });
    const logged = JSON.stringify(mocks.loggerWarn.mock.calls);
    expect(logged).not.toContain(keyFile);
    expect(logged).not.toContain('TOP_SECRET');
  });
});
