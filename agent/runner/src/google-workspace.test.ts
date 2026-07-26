import { createCipheriv, hkdfSync, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  GOOGLE_HOST_TOOL_NAMES,
  isGoogleHostToolName,
  requestHostGoogleOperation,
  type GoogleApiRequestEnvelope,
  type GoogleHostToolName,
} from './google-workspace.js';

interface DiskRequest extends GoogleApiRequestEnvelope {
  ownerAuthorizationGrant: string;
}

const ONE_USE_GRANT = 'g'.repeat(43);
const RESPONSE_KEY = Buffer.alloc(32, 0x41).toString('base64url');
const WRONG_RESPONSE_KEY = Buffer.alloc(32, 0x42).toString('base64url');
const SEALED_RESULT_DOMAIN = 'skoobi.google_api.sealed_result.v1';
const OVERSIZED_RESULT_BYTES = 6 * 1024 * 1024 + 1;

let testRoot: string;
let ipcDir: string;
let googleDir: string;

beforeEach(() => {
  testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'google-host-ipc-'));
  ipcDir = path.join(testRoot, 'ipc');
  googleDir = path.join(ipcDir, 'google');
  fs.mkdirSync(ipcDir, { mode: 0o700 });
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(testRoot, { recursive: true, force: true });
});

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function googleDirectoryEntries(): string[] {
  try {
    return fs.readdirSync(googleDir).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

async function waitForRequest(timeoutMs = 2_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const requestName = googleDirectoryEntries().find((name) =>
      name.endsWith('.request.json'),
    );
    if (requestName) return path.join(googleDir, requestName);
    await delay(5);
  }
  throw new Error('Test host did not receive a Google request.');
}

function readDiskRequest(requestPath: string): DiskRequest {
  return JSON.parse(fs.readFileSync(requestPath, 'utf8')) as DiskRequest;
}

function resultPathFor(request: DiskRequest): string {
  return path.join(googleDir, `${request.request_id}.result.json`);
}

function authorization(
  grant = ONE_USE_GRANT,
  responseKey = RESPONSE_KEY,
): { grant: string; responseKey: string } {
  return { grant, responseKey };
}

function sealResult(
  requestId: string,
  value: Record<string, unknown>,
  responseKey = RESPONSE_KEY,
): Record<string, unknown> {
  const responseKeyBytes = Buffer.from(responseKey, 'base64url');
  const encryptionKey = Buffer.from(
    hkdfSync(
      'sha256',
      responseKeyBytes,
      Buffer.from(SEALED_RESULT_DOMAIN, 'utf8'),
      Buffer.from(requestId, 'utf8'),
      32,
    ),
  );
  const nonce = Buffer.alloc(12, 0x7c);
  try {
    const cipher = createCipheriv('aes-256-gcm', encryptionKey, nonce, {
      authTagLength: 16,
    });
    cipher.setAAD(Buffer.from(`${SEALED_RESULT_DOMAIN}\0${requestId}`, 'utf8'));
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(value), 'utf8'),
      cipher.final(),
    ]);
    return {
      type: 'google_api_sealed_result',
      request_id: requestId,
      v: 1,
      nonce: nonce.toString('base64url'),
      ciphertext: ciphertext.toString('base64url'),
      tag: cipher.getAuthTag().toString('base64url'),
    };
  } finally {
    responseKeyBytes.fill(0);
    encryptionKey.fill(0);
  }
}

function writeDiskResult(
  request: DiskRequest,
  value: Record<string, unknown>,
): string {
  const resultPath = resultPathFor(request);
  fs.writeFileSync(resultPath, JSON.stringify(value), {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o600,
  });
  return resultPath;
}

function writeSealedResult(
  request: DiskRequest,
  value: Record<string, unknown>,
  responseKey = RESPONSE_KEY,
): string {
  return writeDiskResult(
    request,
    sealResult(request.request_id, value, responseKey),
  );
}

describe('public Google host tools', () => {
  it('keeps the callable name set closed and runtime-checkable', () => {
    const typedNames: readonly GoogleHostToolName[] = GOOGLE_HOST_TOOL_NAMES;
    expect(typedNames).toHaveLength(14);
    expect(isGoogleHostToolName('google_sheets_append_values')).toBe(true);
    expect(isGoogleHostToolName('google_calendar_list_events')).toBe(true);
    expect(isGoogleHostToolName('gmail_search_threads')).toBe(true);
    expect(isGoogleHostToolName('gmail_get_thread')).toBe(true);
    expect(isGoogleHostToolName('google_drive_delete')).toBe(false);
  });

  it('rejects a forged tool name before asking for authorization', async () => {
    const authorize = vi.fn(() => authorization());
    await expect(
      requestHostGoogleOperation({
        ipcDir,
        tool: 'google_drive_delete' as GoogleHostToolName,
        args: {},
        authorize,
      }),
    ).rejects.toThrow(/unsupported public google host tool/i);
    expect(authorize).not.toHaveBeenCalled();
    expect(googleDirectoryEntries()).toEqual([]);
  });
});

describe('requestHostGoogleOperation', () => {
  it('authorizes the exact immutable envelope and publishes only that envelope plus its grant', async () => {
    let authorizedEnvelope: Readonly<GoogleApiRequestEnvelope> | undefined;
    let diskRequest: DiskRequest | undefined;
    const args = {
      spreadsheetId: 'sheet-123',
      range: 'Sheet1!A1',
      values: [['Quarterly plan']],
      inputMode: 'raw',
      expectedDigest: 'a'.repeat(64),
    };

    const operation = requestHostGoogleOperation<{ title: string }>({
      ipcDir,
      tool: 'google_sheets_update_values',
      args,
      authorize: (envelope) => {
        authorizedEnvelope = envelope;
        return authorization();
      },
    });
    let sealedDiskContent = '';
    const host = (async () => {
      const requestPath = await waitForRequest();
      diskRequest = readDiskRequest(requestPath);
      const resultPath = writeSealedResult(diskRequest, {
        type: 'google_api_result',
        request_id: diskRequest.request_id,
        ok: true,
        result: { title: 'Quarterly plan' },
      });
      sealedDiskContent = fs.readFileSync(resultPath, 'utf8');
    })();

    await expect(operation).resolves.toEqual({ title: 'Quarterly plan' });
    await host;

    expect(authorizedEnvelope).toBeDefined();
    expect(Object.keys(authorizedEnvelope!)).toEqual([
      'type',
      'request_id',
      'tool',
      'args',
    ]);
    expect(authorizedEnvelope).toMatchObject({
      type: 'google_api',
      request_id: expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      ),
      tool: 'google_sheets_update_values',
      args,
    });
    expect(Object.isFrozen(authorizedEnvelope)).toBe(true);
    expect(Object.isFrozen(authorizedEnvelope!.args)).toBe(true);
    expect(Object.isFrozen(authorizedEnvelope!.args.values)).toBe(true);
    expect(
      Object.isFrozen((authorizedEnvelope!.args.values as unknown[])[0]),
    ).toBe(true);
    expect(diskRequest).toEqual({
      ...authorizedEnvelope,
      ownerAuthorizationGrant: ONE_USE_GRANT,
    });
    expect(diskRequest).not.toHaveProperty('responseKey');
    expect(JSON.stringify(diskRequest)).not.toContain(RESPONSE_KEY);
    expect(sealedDiskContent).toContain('google_api_sealed_result');
    expect(sealedDiskContent).not.toContain('Quarterly plan');
    expect(sealedDiskContent).not.toContain(RESPONSE_KEY);
    expect(googleDirectoryEntries()).toEqual([]);
  });

  it('keeps the bearer secret in the authorization closure and writes only the returned one-use grant', async () => {
    const bearerSecret = 'host-bearer-secret-that-must-remain-in-memory';
    const returnedGrant = 'r'.repeat(43);
    const mintOneUseGrant = vi.fn(
      (
        receivedSecret: string,
        _envelope: Readonly<GoogleApiRequestEnvelope>,
      ) => {
        expect(receivedSecret).toBe(bearerSecret);
        return returnedGrant;
      },
    );

    const operation = requestHostGoogleOperation({
      ipcDir,
      tool: 'google_workspace_status',
      args: { verify: true },
      authorize: (envelope) =>
        authorization(mintOneUseGrant(bearerSecret, envelope)),
    });
    const host = (async () => {
      const requestPath = await waitForRequest();
      const request = readDiskRequest(requestPath);
      const allDiskContent = googleDirectoryEntries()
        .filter((name) => fs.lstatSync(path.join(googleDir, name)).isFile())
        .map((name) => fs.readFileSync(path.join(googleDir, name), 'utf8'))
        .join('\n');

      expect(allDiskContent).not.toContain(bearerSecret);
      expect(allDiskContent).not.toContain(RESPONSE_KEY);
      expect(allDiskContent).toContain(returnedGrant);
      expect(request.ownerAuthorizationGrant).toBe(returnedGrant);
      writeSealedResult(request, {
        type: 'google_api_result',
        request_id: request.request_id,
        ok: true,
        result: { ready: true },
      });
    })();

    await expect(operation).resolves.toEqual({ ready: true });
    await host;
    expect(mintOneUseGrant).toHaveBeenCalledOnce();
    expect(googleDirectoryEntries()).toEqual([]);
  });

  it('rejects a response key that does not decode to exactly 32 bytes', async () => {
    await expect(
      requestHostGoogleOperation({
        ipcDir,
        tool: 'google_workspace_status',
        args: { verify: false },
        authorize: () => authorization(ONE_USE_GRANT, 'c2hvcnQ'),
      }),
    ).rejects.toThrow(/response key has an invalid length/i);
    expect(googleDirectoryEntries()).toEqual([]);
  });

  it('rejects a plaintext result without a compatibility fallback', async () => {
    const operation = requestHostGoogleOperation({
      ipcDir,
      tool: 'google_workspace_status',
      args: { verify: false },
      authorize: () => authorization(),
    });
    const assertion = expect(operation).rejects.toThrow(
      /(?:invalid sealed envelope|not a sealed envelope)/i,
    );
    const host = (async () => {
      const request = readDiskRequest(await waitForRequest());
      writeDiskResult(request, {
        type: 'google_api_result',
        request_id: request.request_id,
        ok: true,
        result: { must_not_be_accepted: true },
      });
    })();

    await host;
    await assertion;
    expect(googleDirectoryEntries()).toEqual([]);
  });

  it('rejects a sealed result encrypted with the wrong response key', async () => {
    const operation = requestHostGoogleOperation({
      ipcDir,
      tool: 'google_docs_read',
      args: { documentId: 'doc-1' },
      authorize: () => authorization(),
    });
    const assertion = expect(operation).rejects.toThrow(
      /authenticate the sealed google host result/i,
    );
    const host = (async () => {
      const request = readDiskRequest(await waitForRequest());
      writeSealedResult(
        request,
        {
          type: 'google_api_result',
          request_id: request.request_id,
          ok: true,
          result: { private: 'wrong-key-result' },
        },
        WRONG_RESPONSE_KEY,
      );
    })();

    await host;
    await assertion;
    expect(googleDirectoryEntries()).toEqual([]);
  });

  it('does not reveal a result from stale sealed ciphertext', async () => {
    const staleRequestId = randomUUID();
    const privateValue = 'stale-private-google-result';
    const stale = sealResult(staleRequestId, {
      type: 'google_api_result',
      request_id: staleRequestId,
      ok: true,
      result: { private: privateValue },
    });
    expect(JSON.stringify(stale)).not.toContain(privateValue);

    const operation = requestHostGoogleOperation({
      ipcDir,
      tool: 'google_docs_read',
      args: { documentId: 'doc-current' },
      authorize: () => authorization(),
    });
    const outcome = operation.catch((error: unknown) => error);
    const host = (async () => {
      const request = readDiskRequest(await waitForRequest());
      const transplanted = { ...stale, request_id: request.request_id };
      expect(JSON.stringify(transplanted)).not.toContain(privateValue);
      writeDiskResult(request, transplanted);
    })();

    await host;
    const error = await outcome;
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(
      /authenticate the sealed google host result/i,
    );
    expect((error as Error).message).not.toContain(privateValue);
    expect(googleDirectoryEntries()).toEqual([]);
  });

  it.each([
    {
      label: 'result type',
      response: (requestId: string) => ({
        type: 'different_result_type',
        request_id: requestId,
        ok: true,
        result: {},
      }),
      error: /result type does not match/i,
    },
    {
      label: 'request id',
      response: (_requestId: string) => ({
        type: 'google_api_result',
        request_id: '00000000-0000-4000-8000-000000000000',
        ok: true,
        result: {},
      }),
      error: /request_id does not match/i,
    },
  ])(
    'rejects a mismatched $label and cleans both files',
    async ({ response, error }) => {
      const operation = requestHostGoogleOperation({
        ipcDir,
        tool: 'google_drive_list_files',
        args: {},
        authorize: () => authorization(),
      });
      const assertion = expect(operation).rejects.toThrow(error);
      const host = (async () => {
        const request = readDiskRequest(await waitForRequest());
        writeSealedResult(request, response(request.request_id));
      })();

      await host;
      await assertion;
      expect(googleDirectoryEntries()).toEqual([]);
    },
  );

  it('rejects an oversized result before reading it and cleans both files', async () => {
    const operation = requestHostGoogleOperation({
      ipcDir,
      tool: 'google_sheets_get_values',
      args: { spreadsheetId: 'sheet-1', range: 'A1:B2' },
      authorize: () => authorization(),
    });
    const assertion = expect(operation).rejects.toThrow(
      /exceeds the safe size limit/i,
    );
    const host = (async () => {
      const request = readDiskRequest(await waitForRequest());
      const resultPath = resultPathFor(request);
      const fd = fs.openSync(resultPath, 'wx', 0o600);
      fs.closeSync(fd);
      fs.truncateSync(resultPath, OVERSIZED_RESULT_BYTES);
    })();

    await host;
    await assertion;
    expect(googleDirectoryEntries()).toEqual([]);
  });

  it('does not follow a result symlink and removes only the symlink', async () => {
    const outsideResult = path.join(testRoot, 'outside-result.json');
    let outsideContent = '';
    const operation = requestHostGoogleOperation({
      ipcDir,
      tool: 'google_docs_read',
      args: { documentId: 'doc-1' },
      authorize: () => authorization(),
    });
    const assertion = expect(operation).rejects.toThrow(
      /not a safe regular file/i,
    );
    const host = (async () => {
      const request = readDiskRequest(await waitForRequest());
      outsideContent = JSON.stringify(
        sealResult(request.request_id, {
          type: 'google_api_result',
          request_id: request.request_id,
          ok: true,
          result: { stolen: true },
        }),
      );
      fs.writeFileSync(outsideResult, outsideContent, { mode: 0o600 });
      fs.symlinkSync(outsideResult, resultPathFor(request));
    })();

    await host;
    await assertion;
    expect(fs.readFileSync(outsideResult, 'utf8')).toBe(outsideContent);
    expect(googleDirectoryEntries()).toEqual([]);
  });

  it('atomically replaces a pre-planted request symlink without following it', async () => {
    const outsideFile = path.join(testRoot, 'outside-request-target.txt');
    const sentinel = 'outside target must remain unchanged';
    fs.writeFileSync(outsideFile, sentinel, { mode: 0o600 });

    const operation = requestHostGoogleOperation({
      ipcDir,
      tool: 'google_docs_create',
      args: { title: 'Plan' },
      authorize: (envelope) => {
        fs.symlinkSync(
          outsideFile,
          path.join(googleDir, `${envelope.request_id}.request.json`),
        );
        return authorization();
      },
    });
    const host = (async () => {
      const request = readDiskRequest(await waitForRequest());
      writeSealedResult(request, {
        type: 'google_api_result',
        request_id: request.request_id,
        ok: true,
        result: { created: true },
      });
    })();

    await expect(operation).resolves.toEqual({ created: true });
    await host;
    expect(fs.readFileSync(outsideFile, 'utf8')).toBe(sentinel);
    expect(googleDirectoryEntries()).toEqual([]);
  });

  it('rejects a symlinked google directory before authorization', async () => {
    const outsideDirectory = path.join(testRoot, 'outside-google');
    fs.mkdirSync(outsideDirectory, { mode: 0o700 });
    fs.symlinkSync(outsideDirectory, googleDir);
    const authorize = vi.fn(() => authorization());

    await expect(
      requestHostGoogleOperation({
        ipcDir,
        tool: 'google_workspace_status',
        args: {},
        authorize,
      }),
    ).rejects.toThrow(/real directory, not a symlink/i);
    expect(authorize).not.toHaveBeenCalled();
    expect(fs.readdirSync(outsideDirectory)).toEqual([]);
    expect(fs.lstatSync(googleDir).isSymbolicLink()).toBe(true);
  });

  it('times out and removes an unanswered request', async () => {
    await expect(
      requestHostGoogleOperation({
        ipcDir,
        tool: 'google_apps_script_get_content',
        args: { scriptId: 'script-1' },
        authorize: () => authorization(),
        timeoutMs: 60,
      }),
    ).rejects.toThrow(/timed out waiting/i);
    expect(googleDirectoryEntries()).toEqual([]);
  });
});
