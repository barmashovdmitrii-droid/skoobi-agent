import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { CalendarAdapter } from './calendar-adapter.js';
import {
  GoogleWorkspaceClient,
  GoogleWorkspaceClientError,
  convertBasicMarkdownToDocs,
  googleAppsScriptFilesDigest,
  loadGoogleWorkspaceHostConfig,
  type GoogleWorkspaceHostConfig,
} from './google-workspace-client.js';

vi.mock('./env.js', () => ({
  readEnvFile: vi.fn(() => ({})),
}));

const BASE_CONFIG: GoogleWorkspaceHostConfig = {
  enabled: true,
  clientId: 'client-id.apps.googleusercontent.com',
  clientSecret: 'client-secret-value',
  refreshToken: 'refresh-token-value',
  scopes: [
    'https://www.googleapis.com/auth/drive',
    'https://www.googleapis.com/auth/spreadsheets',
  ],
  defaultScriptId: 'default-script-id',
  requestTimeoutMs: 250,
  maxResponseBytes: 2 * 1024 * 1024,
};

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function tokenResponse(): Response {
  return jsonResponse({ access_token: 'host-access-token', expires_in: 3600 });
}

function urlOf(input: string | URL | Request): string {
  return typeof input === 'string'
    ? input
    : input instanceof URL
      ? input.toString()
      : input.url;
}

function withToken(
  handler: (
    url: string,
    init: RequestInit | undefined,
  ) => Response | Promise<Response>,
) {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = urlOf(input);
    if (url === 'https://oauth2.googleapis.com/token') return tokenResponse();
    return handler(url, init);
  });
}

function expectClientError(
  code: GoogleWorkspaceClientError['code'],
): (error: unknown) => boolean {
  return (error) => {
    expect(error).toBeInstanceOf(GoogleWorkspaceClientError);
    expect((error as GoogleWorkspaceClientError).code).toBe(code);
    return true;
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('host-only Google Workspace config', () => {
  it('loads a refresh token from one bounded 0600 regular file', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skoobi-google-token-'));
    const tokenPath = path.join(root, 'refresh-token');
    fs.writeFileSync(tokenPath, 'token-from-file\n', { mode: 0o600 });
    try {
      const config = loadGoogleWorkspaceHostConfig({
        SKOOBI_GOOGLE_WORKSPACE_ENABLED: 'true',
        SKOOBI_GOOGLE_WORKSPACE_OAUTH_CLIENT_ID: 'cid',
        SKOOBI_GOOGLE_WORKSPACE_OAUTH_CLIENT_SECRET: 'csecret',
        SKOOBI_GOOGLE_WORKSPACE_REFRESH_TOKEN: 'must-not-win',
        SKOOBI_GOOGLE_WORKSPACE_REFRESH_TOKEN_FILE: tokenPath,
      });
      expect(config.refreshToken).toBe('token-from-file');
      expect(JSON.stringify(config)).not.toContain('must-not-win');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects permissive, symlinked, and oversized refresh-token files without echoing token data', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skoobi-google-token-'));
    const unsafe = path.join(root, 'unsafe');
    const link = path.join(root, 'link');
    const large = path.join(root, 'large');
    fs.writeFileSync(unsafe, 'VERY_SECRET_TOKEN', { mode: 0o644 });
    fs.symlinkSync(unsafe, link);
    fs.writeFileSync(large, 'x'.repeat(16 * 1024 + 1), { mode: 0o600 });
    try {
      for (const file of [unsafe, link, large]) {
        let caught: unknown;
        try {
          loadGoogleWorkspaceHostConfig({
            SKOOBI_GOOGLE_WORKSPACE_REFRESH_TOKEN_FILE: file,
          });
        } catch (error) {
          caught = error;
        }
        expect(caught).toBeInstanceOf(GoogleWorkspaceClientError);
        expect(String((caught as Error).message)).not.toContain(
          'VERY_SECRET_TOKEN',
        );
        expect(String((caught as Error).message)).not.toContain(file);
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects a refresh-token inode whose metadata changes during the read', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skoobi-google-race-'));
    const tokenPath = path.join(root, 'refresh-token');
    fs.writeFileSync(tokenPath, 'refresh-token-value', { mode: 0o600 });
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
    try {
      expect(() =>
        loadGoogleWorkspaceHostConfig({
          SKOOBI_GOOGLE_WORKSPACE_REFRESH_TOKEN_FILE: tokenPath,
        }),
      ).toThrow(/unsafe or unreadable/i);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('bounded host fetch and status verification', () => {
  it('aborts a stalled fetch at the configured deadline', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(
      async (_input: string | URL | Request, init?: RequestInit) =>
        await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('aborted', 'AbortError'));
          });
        }),
    );
    const client = new GoogleWorkspaceClient(
      { ...BASE_CONFIG, requestTimeoutMs: 50 },
      { fetch: fetchMock },
    );
    const rejection = expect(client.status(true)).rejects.toSatisfy(
      expectClientError('timeout'),
    );
    await vi.advanceTimersByTimeAsync(51);
    await rejection;
  });

  it('rejects a streamed response above the byte cap', async () => {
    const fetchMock = withToken(() =>
      jsonResponse({ user: { emailAddress: 'x'.repeat(400) } }),
    );
    const client = new GoogleWorkspaceClient(
      { ...BASE_CONFIG, maxResponseBytes: 128 },
      { fetch: fetchMock },
    );
    await expect(client.status(true)).rejects.toSatisfy(
      expectClientError('response_too_large'),
    );
  });

  it('verifies Drive and an injected Calendar adapter without exposing credentials', async () => {
    const calendarAdapter: CalendarAdapter = {
      config: {
        enabled: true,
        calendarId: 'calendar@example.com',
        scope: 'calendar.readonly',
        timeZone: 'Asia/Almaty',
        eventDurationMinutes: 15,
        reminderMinutes: 0,
      },
      createReminderEvent: vi.fn(),
      listEvents: vi.fn(async () => []),
      deleteEvent: vi.fn(),
    };
    const fetchMock = withToken(() =>
      jsonResponse({
        user: { emailAddress: 'owner@example.com', displayName: 'Owner' },
      }),
    );
    const client = new GoogleWorkspaceClient(BASE_CONFIG, {
      fetch: fetchMock,
      calendarAdapter,
    });
    const status = await client.status(true);

    expect(status).toMatchObject({
      ready: true,
      drive_verified: true,
      account: 'owner@example.com',
      calendar_configured: true,
      calendar_verified: true,
    });
    const serialized = JSON.stringify(status);
    expect(serialized).not.toContain(BASE_CONFIG.clientSecret);
    expect(serialized).not.toContain(BASE_CONFIG.refreshToken);
  });

  it('exposes a broker-safe bound executor', async () => {
    const client = new GoogleWorkspaceClient(BASE_CONFIG, {
      fetch: withToken(() => jsonResponse({})),
    });
    const execute = client.execute;
    const status = await execute({
      type: 'google_api',
      tool: 'google_workspace_status',
      args: { verify: false },
    });
    expect(status).toMatchObject({ ready: true });
  });

  it('bounds and redacts upstream error text', async () => {
    const leaked = `${BASE_CONFIG.clientSecret} ${BASE_CONFIG.refreshToken} host-access-token`;
    const fetchMock = withToken(() =>
      jsonResponse(
        {
          error: {
            status: 'INTERNAL',
            message: `client_secret=${leaked} ${'z'.repeat(5000)}`,
          },
        },
        500,
      ),
    );
    const client = new GoogleWorkspaceClient(BASE_CONFIG, { fetch: fetchMock });
    let caught: unknown;
    try {
      await client.status(true);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(GoogleWorkspaceClientError);
    const message = String((caught as Error).message);
    expect(message.length).toBeLessThan(900);
    expect(message).not.toContain(BASE_CONFIG.clientSecret);
    expect(message).not.toContain(BASE_CONFIG.refreshToken);
    expect(message).not.toContain('host-access-token');
  });

  it('redacts even a short configured secret reflected by upstream', async () => {
    const client = new GoogleWorkspaceClient(
      { ...BASE_CONFIG, clientSecret: 'abc' },
      {
        fetch: withToken(() =>
          jsonResponse(
            { error: { message: 'provider reflected abc verbatim' } },
            500,
          ),
        ),
      },
    );
    await expect(client.status(true)).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(GoogleWorkspaceClientError);
      expect(String((error as Error).message)).not.toContain('abc');
      return true;
    });
  });
});

describe('Drive operations', () => {
  it('keeps My Drive root listing separate from explicit all-files listing', async () => {
    const observed: string[] = [];
    const client = new GoogleWorkspaceClient(BASE_CONFIG, {
      fetch: withToken((url) => {
        observed.push(url);
        return jsonResponse({ files: [] });
      }),
    });

    await client.driveListFiles({ rootOnly: true });
    await client.driveListFiles({});

    const rootUrl = new URL(observed[0]);
    expect(rootUrl.searchParams.get('q')).toContain("'root' in parents");
    expect(rootUrl.searchParams.has('supportsAllDrives')).toBe(false);
    expect(rootUrl.searchParams.has('includeItemsFromAllDrives')).toBe(false);

    const allFilesUrl = new URL(observed[1]);
    expect(allFilesUrl.searchParams.get('q')).not.toContain(
      "'root' in parents",
    );
    expect(allFilesUrl.searchParams.get('supportsAllDrives')).toBe('true');
    expect(allFilesUrl.searchParams.get('includeItemsFromAllDrives')).toBe(
      'true',
    );

    await expect(
      client.driveListFiles({ rootOnly: true, folderId: 'folder-1' }),
    ).rejects.toThrow(/rootOnly and folderId/);
  });

  it('escapes list queries and creates files with strict metadata only', async () => {
    const observed: Array<{ url: string; init?: RequestInit }> = [];
    const fetchMock = withToken((url, init) => {
      observed.push({ url, init });
      if (init?.method === 'POST') {
        return jsonResponse({
          id: 'sheet-created',
          name: 'CRM',
          webViewLink:
            'https://docs.google.com/spreadsheets/d/sheet-created/edit',
        });
      }
      return jsonResponse({
        files: [
          {
            id: 'doc-1',
            name: "O'Brien",
            mimeType: 'application/vnd.google-apps.document',
            parents: ['folder-1'],
          },
        ],
      });
    });
    const client = new GoogleWorkspaceClient(BASE_CONFIG, { fetch: fetchMock });

    const listed = await client.driveListFiles({
      query: "O'Brien\\North",
      type: 'doc',
      folderId: 'folder-1',
      maxResults: 5,
    });
    const created = await client.driveCreateFile({
      kind: 'sheet',
      title: 'CRM',
      folderId: 'folder-1',
    });

    expect(listed.files[0]?.id).toBe('doc-1');
    const queryUrl = new URL(observed[0].url);
    const driveQuery = queryUrl.searchParams.get('q') || '';
    expect(driveQuery).toContain("name contains 'O\\'Brien\\\\North'");
    expect(created.id).toBe('sheet-created');
    const createBody = JSON.parse(String(observed[1].init?.body));
    expect(createBody).toEqual({
      name: 'CRM',
      mimeType: 'application/vnd.google-apps.spreadsheet',
      parents: ['folder-1'],
    });
  });

  it('marks post-create initialization failures as duplicate-unsafe', async () => {
    const fetchMock = withToken((url, init) => {
      if (
        url.startsWith('https://www.googleapis.com/drive/v3/files?') &&
        init?.method === 'POST'
      ) {
        return jsonResponse({ id: 'doc-created', name: 'Plan' });
      }
      throw new Error('metadata network failure');
    });
    const client = new GoogleWorkspaceClient(BASE_CONFIG, { fetch: fetchMock });
    let caught: unknown;
    try {
      await client.driveCreateFile({
        kind: 'doc',
        title: 'Plan',
        contentMarkdown: '# Plan',
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(GoogleWorkspaceClientError);
    expect((caught as GoogleWorkspaceClientError).outcomeUncertain).toBe(true);
  });
});

describe('Google Docs guarded Markdown operations', () => {
  it('converts only a basic inert Markdown subset', () => {
    const converted = convertBasicMarkdownToDocs(
      '# Heading\n- **bold** [safe label](https://attacker.example/)',
    );
    expect(converted.text).toBe('Heading\nbold safe label\n');
    expect(converted.text).not.toContain('https://attacker.example');
    expect(converted.requests).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ updateParagraphStyle: expect.any(Object) }),
        expect.objectContaining({ createParagraphBullets: expect.any(Object) }),
        expect.objectContaining({ updateTextStyle: expect.any(Object) }),
      ]),
    );
  });

  it('exports Markdown only when the surrounding revision is stable', async () => {
    let metadataReads = 0;
    const fetchMock = withToken((url) => {
      if (url.includes('/export?')) return new Response('# Report\n');
      if (url.includes('docs.googleapis.com/v1/documents/')) {
        metadataReads += 1;
        return jsonResponse({
          documentId: 'doc-1',
          title: 'Report',
          revisionId: 'revision-1',
          body: { content: [{ endIndex: 20 }] },
        });
      }
      throw new Error(`unexpected URL: ${url}`);
    });
    const client = new GoogleWorkspaceClient(BASE_CONFIG, { fetch: fetchMock });
    const result = await client.docsRead('doc-1');

    expect(metadataReads).toBe(2);
    expect(result).toMatchObject({
      documentId: 'doc-1',
      title: 'Report',
      revisionId: 'revision-1',
      markdown: '# Report\n',
    });
    expect(result.digest).toMatch(/^[a-f0-9]{64}$/);
  });

  it('replaces through batchUpdate with requiredRevisionId and no Markdown links', async () => {
    let batchBody: Record<string, unknown> | undefined;
    const fetchMock = withToken((url, init) => {
      if (url.endsWith(':batchUpdate')) {
        batchBody = JSON.parse(String(init?.body));
        return jsonResponse({
          writeControl: { targetRevisionId: 'revision-2' },
        });
      }
      if (url.includes('docs.googleapis.com/v1/documents/')) {
        return jsonResponse({
          documentId: 'doc-1',
          title: 'Report',
          revisionId: 'revision-1',
          body: { content: [{ endIndex: 25 }] },
        });
      }
      throw new Error(`unexpected URL: ${url}`);
    });
    const client = new GoogleWorkspaceClient(BASE_CONFIG, { fetch: fetchMock });
    const result = await client.docsReplaceContent({
      documentId: 'doc-1',
      contentMarkdown: '# New\n**safe** [label](https://attacker.example)',
      expectedRevisionId: 'revision-1',
    });

    expect(result.revisionId).toBe('revision-2');
    expect(batchBody?.writeControl).toEqual({
      requiredRevisionId: 'revision-1',
    });
    const requests = batchBody?.requests as Array<Record<string, unknown>>;
    expect(requests[0]).toHaveProperty('deleteContentRange');
    const insert = requests.find((request) => 'insertText' in request) as {
      insertText: { text: string };
    };
    expect(insert.insertText.text).toContain('New\nsafe label');
    expect(insert.insertText.text).not.toContain('attacker.example');
  });

  it('refuses both a stale preflight revision and an API revision race', async () => {
    let batchCalls = 0;
    const staleFetch = withToken((url) => {
      if (url.endsWith(':batchUpdate')) batchCalls += 1;
      return jsonResponse({
        documentId: 'doc-1',
        revisionId: 'revision-new',
        body: { content: [{ endIndex: 3 }] },
      });
    });
    const staleClient = new GoogleWorkspaceClient(BASE_CONFIG, {
      fetch: staleFetch,
    });
    await expect(
      staleClient.docsReplaceContent({
        documentId: 'doc-1',
        contentMarkdown: 'replacement',
        expectedRevisionId: 'revision-old',
      }),
    ).rejects.toSatisfy(expectClientError('conflict'));
    expect(batchCalls).toBe(0);

    const raceFetch = withToken((url) => {
      if (url.endsWith(':batchUpdate')) {
        return jsonResponse(
          {
            error: {
              status: 'ABORTED',
              message: 'required revision no longer matches',
            },
          },
          409,
        );
      }
      return jsonResponse({
        documentId: 'doc-1',
        revisionId: 'revision-1',
        body: { content: [{ endIndex: 3 }] },
      });
    });
    const raceClient = new GoogleWorkspaceClient(BASE_CONFIG, {
      fetch: raceFetch,
    });
    await expect(
      raceClient.docsReplaceContent({
        documentId: 'doc-1',
        contentMarkdown: 'replacement',
        expectedRevisionId: 'revision-1',
      }),
    ).rejects.toSatisfy(expectClientError('conflict'));
  });
});

describe('Google Sheets digest and formula controls', () => {
  const RANGE = 'Sheet1!A1:B1';
  const CURRENT_VALUES = [['old', 1]];

  it('uses RAW by default, even for formula-looking strings', async () => {
    let updateUrl = '';
    let updateBody: unknown;
    const fetchMock = withToken((url, init) => {
      if (init?.method === 'PUT') {
        updateUrl = url;
        updateBody = JSON.parse(String(init.body));
        return jsonResponse({
          updatedRange: RANGE,
          updatedRows: 1,
          updatedColumns: 2,
          updatedCells: 2,
        });
      }
      return jsonResponse({ range: RANGE, values: CURRENT_VALUES });
    });
    const client = new GoogleWorkspaceClient(BASE_CONFIG, { fetch: fetchMock });
    const before = await client.sheetsGetValues({
      spreadsheetId: 'sheet-1',
      range: RANGE,
    });
    const result = await client.sheetsUpdateValues({
      spreadsheetId: 'sheet-1',
      range: RANGE,
      values: [['=IMPORTXML("https://attacker.example")', 2]],
      expectedDigest: before.digest,
    });

    expect(new URL(updateUrl).searchParams.get('valueInputOption')).toBe('RAW');
    expect(updateBody).toMatchObject({
      majorDimension: 'ROWS',
      values: [['=IMPORTXML("https://attacker.example")', 2]],
    });
    expect(result.inputMode).toBe('raw');
  });

  it('uses USER_ENTERED only when the validated operation opts in explicitly', async () => {
    let updateUrl = '';
    const fetchMock = withToken((url, init) => {
      if (init?.method === 'PUT') {
        updateUrl = url;
        return jsonResponse({ updatedRange: RANGE });
      }
      return jsonResponse({ range: RANGE, values: CURRENT_VALUES });
    });
    const client = new GoogleWorkspaceClient(BASE_CONFIG, { fetch: fetchMock });
    const before = await client.sheetsGetValues({
      spreadsheetId: 'sheet-1',
      range: RANGE,
    });
    await client.sheetsUpdateValues({
      spreadsheetId: 'sheet-1',
      range: RANGE,
      values: [['=1+1']],
      inputMode: 'user_entered',
      expectedDigest: before.digest,
    });

    expect(new URL(updateUrl).searchParams.get('valueInputOption')).toBe(
      'USER_ENTERED',
    );
  });

  it('does not issue an update when the expected range digest is stale', async () => {
    let putCalls = 0;
    const fetchMock = withToken((_url, init) => {
      if (init?.method === 'PUT') putCalls += 1;
      return jsonResponse({ range: RANGE, values: CURRENT_VALUES });
    });
    const client = new GoogleWorkspaceClient(BASE_CONFIG, { fetch: fetchMock });
    await expect(
      client.sheetsUpdateValues({
        spreadsheetId: 'sheet-1',
        range: RANGE,
        values: [['new']],
        expectedDigest: '0'.repeat(64),
      }),
    ).rejects.toSatisfy(expectClientError('conflict'));
    expect(putCalls).toBe(0);
  });

  it('appends with INSERT_ROWS and never sends a range overwrite', async () => {
    const range = 'Sheet1!A1:B1000';
    let appendUrl = '';
    let appendBody: unknown;
    const fetchMock = withToken((url, init) => {
      if (init?.method === 'POST') {
        appendUrl = url;
        appendBody = JSON.parse(String(init.body));
        return jsonResponse({
          tableRange: 'Sheet1!A1:B2',
          updates: {
            updatedRange: 'Sheet1!A3:B3',
            updatedRows: 1,
            updatedColumns: 2,
            updatedCells: 2,
          },
        });
      }
      return jsonResponse({ range, values: CURRENT_VALUES });
    });
    const client = new GoogleWorkspaceClient(BASE_CONFIG, { fetch: fetchMock });
    const before = await client.sheetsGetValues({
      spreadsheetId: 'sheet-1',
      range,
    });
    const result = await client.sheetsAppendValues({
      spreadsheetId: 'sheet-1',
      range,
      values: [['24.07.2026', '=not-a-formula-in-raw-mode']],
      expectedDigest: before.digest,
    });

    const url = new URL(appendUrl);
    expect(url.pathname).toContain('/values/Sheet1!A1%3AB1000:append');
    expect(url.searchParams.get('insertDataOption')).toBe('INSERT_ROWS');
    expect(url.searchParams.get('valueInputOption')).toBe('RAW');
    expect(appendBody).toEqual({
      range,
      majorDimension: 'ROWS',
      values: [['24.07.2026', '=not-a-formula-in-raw-mode']],
    });
    expect(result).toMatchObject({
      previousDigest: before.digest,
      updatedRange: 'Sheet1!A3:B3',
      updatedRows: 1,
      updatedCells: 2,
    });
    expect(
      fetchMock.mock.calls.some(([, init]) => init?.method === 'PUT'),
    ).toBe(false);
  });

  it('refuses stale or over-wide appends before any side effect', async () => {
    const range = 'Sheet1!A1:B1000';
    let postCalls = 0;
    const fetchMock = withToken((_url, init) => {
      if (init?.method === 'POST') postCalls += 1;
      return jsonResponse({ range, values: CURRENT_VALUES });
    });
    const client = new GoogleWorkspaceClient(BASE_CONFIG, { fetch: fetchMock });

    await expect(
      client.sheetsAppendValues({
        spreadsheetId: 'sheet-1',
        range,
        values: [['new']],
        expectedDigest: '0'.repeat(64),
      }),
    ).rejects.toSatisfy(expectClientError('conflict'));
    await expect(
      client.sheetsAppendValues({
        spreadsheetId: 'sheet-1',
        range,
        values: [['one', 'two', 'outside-authorized-width']],
        expectedDigest: '0'.repeat(64),
      }),
    ).rejects.toSatisfy(expectClientError('invalid_input'));
    expect(postCalls).toBe(0);
  });

  it('binds the fresh-read digest to the exact spreadsheet id', async () => {
    const range = 'Sheet1!A1:B1000';
    let postCalls = 0;
    const fetchMock = withToken((_url, init) => {
      if (init?.method === 'POST') {
        postCalls += 1;
        return jsonResponse({});
      }
      return jsonResponse({ range, values: CURRENT_VALUES });
    });
    const client = new GoogleWorkspaceClient(BASE_CONFIG, { fetch: fetchMock });
    const sheetA = await client.sheetsGetValues({
      spreadsheetId: 'sheet-a',
      range,
    });

    await expect(
      client.sheetsAppendValues({
        spreadsheetId: 'sheet-b',
        range,
        values: [['new', 2]],
        expectedDigest: sheetA.digest,
      }),
    ).rejects.toSatisfy(expectClientError('conflict'));
    expect(postCalls).toBe(0);
  });

  it('treats an incomplete append response as an uncertain outcome, not success', async () => {
    const range = 'Sheet1!A1:B1000';
    let postCalls = 0;
    const fetchMock = withToken((_url, init) => {
      if (init?.method === 'POST') {
        postCalls += 1;
        return jsonResponse({});
      }
      return jsonResponse({ range, values: CURRENT_VALUES });
    });
    const client = new GoogleWorkspaceClient(BASE_CONFIG, { fetch: fetchMock });
    const before = await client.sheetsGetValues({
      spreadsheetId: 'sheet-1',
      range,
    });

    try {
      await client.sheetsAppendValues({
        spreadsheetId: 'sheet-1',
        range,
        values: [['new', 2]],
        expectedDigest: before.digest,
      });
      throw new Error('expected append response validation to fail');
    } catch (error) {
      expect(error).toMatchObject({
        code: 'invalid_response',
        outcomeUncertain: true,
      });
    }
    expect(postCalls).toBe(1);
  });
});

describe('Apps Script normalized compare-and-update', () => {
  const RAW_FILES = [
    {
      name: 'Code',
      type: 'SERVER_JS',
      source: 'function old() {}',
      lastModifyUser: { email: 'must-not-be-written-back@example.com' },
      updateTime: '2026-07-11T00:00:00Z',
    },
    {
      name: 'appsscript',
      type: 'JSON',
      source: '{}',
      createTime: '2026-07-10T00:00:00Z',
    },
  ];

  it('hashes normalized files and PUTs only name/type/source', async () => {
    let putBody: { files: Array<Record<string, unknown>> } | undefined;
    const fetchMock = withToken((_url, init) => {
      if (init?.method === 'PUT') {
        putBody = JSON.parse(String(init.body));
        return jsonResponse({});
      }
      return jsonResponse({ scriptId: 'script-1', files: RAW_FILES });
    });
    const client = new GoogleWorkspaceClient(BASE_CONFIG, { fetch: fetchMock });
    const before = await client.appsScriptGetContent('script-1');
    const result = await client.appsScriptUpdateFile({
      scriptId: 'script-1',
      fileName: 'Code',
      source: 'function updated() {}',
      expectedDigest: before.digest,
    });

    expect(before.files[0]).toEqual({
      name: 'appsscript',
      type: 'JSON',
      source: '{}',
    });
    expect(result.previousDigest).toBe(before.digest);
    expect(putBody?.files).toHaveLength(2);
    for (const file of putBody?.files || []) {
      expect(Object.keys(file).sort()).toEqual(['name', 'source', 'type']);
      expect(JSON.stringify(file)).not.toContain('lastModifyUser');
      expect(JSON.stringify(file)).not.toContain('updateTime');
    }
    expect(result.digest).toBe(
      googleAppsScriptFilesDigest(
        (putBody?.files || []) as Array<{
          name: string;
          type: 'SERVER_JS' | 'HTML' | 'JSON';
          source: string;
        }>,
      ),
    );
  });

  it('refuses a stale project digest before updateContent', async () => {
    let putCalls = 0;
    const fetchMock = withToken((_url, init) => {
      if (init?.method === 'PUT') putCalls += 1;
      return jsonResponse({ scriptId: 'script-1', files: RAW_FILES });
    });
    const client = new GoogleWorkspaceClient(BASE_CONFIG, { fetch: fetchMock });
    await expect(
      client.appsScriptUpdateFile({
        scriptId: 'script-1',
        fileName: 'Code',
        source: 'function attacker() {}',
        expectedDigest: 'f'.repeat(64),
      }),
    ).rejects.toSatisfy(expectClientError('conflict'));
    expect(putCalls).toBe(0);
  });
});

describe('Gmail read-only operations', () => {
  const THREAD_ID = '18f0abc123def456';
  const MESSAGE_ID = '18f0abc123def457';
  const bodyData = (value: string) => Buffer.from(value).toString('base64url');

  it('passes Gmail search syntax safely and caps one-page results', async () => {
    let observedUrl = '';
    const fetchMock = withToken((url) => {
      observedUrl = url;
      return jsonResponse({
        threads: [{ id: THREAD_ID, snippet: 'Последнее\u0000 письмо' }],
        nextPageToken: 'next-page',
        resultSizeEstimate: 41,
        ignored: 'must not cross the broker',
      });
    });
    const client = new GoogleWorkspaceClient(BASE_CONFIG, { fetch: fetchMock });
    const result = await client.gmailSearchThreads({
      query: 'from:ivan@example.com newer_than:30d',
      maxResults: 999,
    });

    const url = new URL(observedUrl);
    expect(url.pathname).toBe('/gmail/v1/users/me/threads');
    expect(url.searchParams.get('q')).toBe(
      'from:ivan@example.com newer_than:30d',
    );
    expect(url.searchParams.get('maxResults')).toBe('25');
    expect(url.searchParams.get('includeSpamTrash')).toBe('false');
    expect(result).toEqual({
      threads: [{ threadId: THREAD_ID, snippet: 'Последнее письмо' }],
      resultSizeEstimate: 41,
      hasMore: true,
    });
    expect(JSON.stringify(result)).not.toContain('must not cross');
  });

  it('reads whitelisted headers and plain text without downloading attachments', async () => {
    const observedUrls: string[] = [];
    const fetchMock = withToken((url) => {
      observedUrls.push(url);
      return jsonResponse({
        id: THREAD_ID,
        messages: [
          {
            id: MESSAGE_ID,
            threadId: THREAD_ID,
            internalDate: '1784246400000',
            labelIds: ['INBOX', 'UNREAD'],
            snippet: 'Привет, Иван!',
            payload: {
              mimeType: 'multipart/mixed',
              headers: [
                { name: 'From', value: 'Sender <sender@example.com>' },
                { name: 'To', value: 'Owner <owner@example.com>' },
                { name: 'Cc', value: 'copy@example.com' },
                { name: 'Subject', value: 'Тестовое письмо' },
                { name: 'Date', value: 'Thu, 16 Jul 2026 12:00:00 +0500' },
                { name: 'X-Secret', value: 'must-not-cross' },
              ],
              parts: [
                {
                  mimeType: 'multipart/alternative',
                  parts: [
                    {
                      mimeType: 'text/plain',
                      headers: [
                        {
                          name: 'Content-Type',
                          value: 'text/plain; charset=utf-8',
                        },
                      ],
                      body: { data: bodyData('Привет, Иван!') },
                    },
                    {
                      mimeType: 'text/html',
                      body: {
                        data: bodyData(
                          '<p>HTML duplicate</p><script>evil()</script>',
                        ),
                      },
                    },
                  ],
                },
                {
                  mimeType: 'text/plain',
                  filename: 'secret.txt',
                  headers: [
                    { name: 'Content-Disposition', value: 'attachment' },
                  ],
                  body: { data: bodyData('attachment secret') },
                },
              ],
            },
          },
        ],
      });
    });
    const client = new GoogleWorkspaceClient(BASE_CONFIG, { fetch: fetchMock });
    const result = await client.gmailGetThread({ threadId: THREAD_ID });

    expect(observedUrls).toHaveLength(1);
    expect(new URL(observedUrls[0]).searchParams.get('format')).toBe('full');
    expect(result).toMatchObject({
      threadId: THREAD_ID,
      omittedMessageCount: 0,
      bodyTruncated: false,
      messages: [
        {
          messageId: MESSAGE_ID,
          from: 'Sender <sender@example.com>',
          to: 'Owner <owner@example.com>',
          cc: 'copy@example.com',
          subject: 'Тестовое письмо',
          date: 'Thu, 16 Jul 2026 12:00:00 +0500',
          labelIds: ['INBOX', 'UNREAD'],
          bodyText: 'Привет, Иван!',
          bodyTruncated: false,
          hasAttachments: true,
        },
      ],
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('HTML duplicate');
    expect(serialized).not.toContain('attachment secret');
    expect(serialized).not.toContain('must-not-cross');
  });

  it('marks externalized inline text as truncated without fetching attachment data', async () => {
    const observedUrls: string[] = [];
    const fetchMock = withToken((url) => {
      observedUrls.push(url);
      return jsonResponse({
        id: THREAD_ID,
        messages: [
          {
            id: MESSAGE_ID,
            threadId: THREAD_ID,
            payload: {
              mimeType: 'text/plain',
              body: { attachmentId: 'external-text', size: 1_000_000 },
            },
          },
          {
            id: `${MESSAGE_ID}b`,
            threadId: THREAD_ID,
            payload: {
              body: { attachmentId: 'external-unknown-text', size: 1_000_000 },
            },
          },
          {
            id: `${MESSAGE_ID}c`,
            threadId: THREAD_ID,
            payload: {
              mimeType: 'application/octet-stream',
              body: { data: 'not+base64' },
            },
          },
        ],
      });
    });
    const client = new GoogleWorkspaceClient(BASE_CONFIG, { fetch: fetchMock });
    const result = await client.gmailGetThread({ threadId: THREAD_ID });

    expect(observedUrls).toHaveLength(1);
    expect(result.bodyTruncated).toBe(true);
    expect(result.messages).toHaveLength(3);
    expect(result.messages.slice(0, 2)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          bodyText: '',
          bodyTruncated: true,
          hasAttachments: false,
        }),
        expect.objectContaining({
          bodyText: '',
          bodyTruncated: true,
          hasAttachments: false,
        }),
      ]),
    );
    expect(result.messages[2]).toMatchObject({
      bodyText: '',
      bodyTruncated: false,
      hasAttachments: false,
    });
  });

  it('turns HTML-only mail into inert text and rejects malformed body data', async () => {
    const html =
      '<head>hidden</head><p>Hello <a href="https://attacker.example">world</a></p><script>evil()</script>';
    const htmlClient = new GoogleWorkspaceClient(BASE_CONFIG, {
      fetch: withToken(() =>
        jsonResponse({
          id: THREAD_ID,
          messages: [
            {
              id: MESSAGE_ID,
              threadId: THREAD_ID,
              payload: {
                mimeType: 'text/html',
                body: { data: bodyData(html) },
              },
            },
          ],
        }),
      ),
    });
    const htmlResult = await htmlClient.gmailGetThread({
      threadId: THREAD_ID,
    });
    expect(htmlResult.messages[0].bodyText).toBe('Hello world');
    expect(htmlResult.messages[0].bodyText).not.toContain('attacker.example');
    expect(htmlResult.messages[0].bodyText).not.toContain('evil');

    const malformedClient = new GoogleWorkspaceClient(BASE_CONFIG, {
      fetch: withToken(() =>
        jsonResponse({
          id: THREAD_ID,
          messages: [
            {
              id: MESSAGE_ID,
              threadId: THREAD_ID,
              payload: {
                mimeType: 'text/plain',
                body: { data: 'not+base64' },
              },
            },
          ],
        }),
      ),
    });
    await expect(
      malformedClient.gmailGetThread({ threadId: THREAD_ID }),
    ).rejects.toSatisfy(expectClientError('invalid_response'));
  });
});

describe('Calendar adapter dispatch', () => {
  it('caps calendar results before calling the injected adapter', async () => {
    const listEvents = vi.fn(async () => []);
    const calendarAdapter: CalendarAdapter = {
      config: {
        enabled: true,
        calendarId: 'calendar@example.com',
        scope: 'calendar.readonly',
        timeZone: 'Asia/Almaty',
        eventDurationMinutes: 15,
        reminderMinutes: 0,
      },
      createReminderEvent: vi.fn(),
      listEvents,
      deleteEvent: vi.fn(),
    };
    const client = new GoogleWorkspaceClient(BASE_CONFIG, {
      fetch: withToken(() => jsonResponse({})),
      calendarAdapter,
    });
    await client.calendarListEvents({
      calendarId: 'calendar@example.com',
      timeMin: '2026-07-11T00:00:00Z',
      timeMax: '2026-07-12T00:00:00Z',
      maxResults: 1000,
    });
    expect(listEvents).toHaveBeenCalledWith(
      expect.objectContaining({ maxResults: 100 }),
    );
  });
});
