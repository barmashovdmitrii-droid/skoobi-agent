import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  hkdfSync,
  randomBytes,
} from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createSqliteGoogleMutationJournal,
  processGoogleWorkspaceRequest,
  sealGoogleApiResultEnvelope,
  sweepStaleGoogleResultFiles,
  type GoogleMutationJournal,
} from './google-workspace-broker.js';
import { GoogleWorkspaceClientError } from './google-workspace-client.js';
import { _initTestDatabase } from './db.js';
import {
  _clearTaskAuthorizationState,
  authorizeTaskOperationRequest,
  registerTaskAuthorizationCapability,
} from './task-authorization.js';

const DOCUMENT_ID = 'public-fixture-document-id-0001';

const ownerIdentity = {
  channel: 'telegram' as const,
  chat_id: '1',
  telegram_user_id: '1',
  identity_id: 'owner-1',
  is_owner_sender: true,
  telegram_message_origin: 'direct' as const,
};

function capabilityFor(
  allowedTools: any[],
  overrides: Record<string, unknown> = {},
): string {
  const capability = registerTaskAuthorizationCapability({
    groupFolder: 'telegram_main',
    isMain: true,
    credentialProxyTier: 'owner',
    senderIdentity: ownerIdentity,
    homogeneousOwnerBatch: true,
    googleOperationPolicy: {
      intentId: 'b'.repeat(64),
      allowedTools,
      allowedDocumentIds: [DOCUMENT_ID],
      allowedSpreadsheetIds: [],
      allowedScriptIds: [],
      allowedFolderIds: [],
      allowedCalendarIds: [],
      allowedSheetRanges: [],
      allowedSheetTargets: [],
      allowedSheetAppendTargets: [],
      allowedScriptFileNames: [],
      confirmedDocumentReplaceIds: [],
      confirmedSheetUpdateIds: [],
      confirmedSheetUpdateTargets: [],
      confirmedScriptUpdateIds: [],
      confirmedScriptUpdateTargets: [],
      allowedDriveSearchTargets: [],
      allowedCalendarQueries: [],
      allowedCalendarTargets: [],
      allowedCreateTargets: [
        { tool: 'google_docs_create', root: true },
        { tool: 'google_sheets_create', root: true },
      ],
      rootCreateTools: ['google_docs_create', 'google_sheets_create'],
      allowStatusVerify: false,
      allowDriveSearch: false,
      allowUnfilteredDriveList: false,
      allowRootCreate: true,
      allowUserEnteredValues: false,
      ...overrides,
    } as any,
  });
  expect(capability).toBeTruthy();
  return capability!;
}

function authorize(
  capability: string,
  envelope: Record<string, unknown>,
  authRequestId: string,
): string {
  const [capabilityId, secret] = capability.split('.');
  const action = String(envelope.type);
  const key = createHmac('sha256', Buffer.from(secret, 'base64url'))
    .update('skoobi.task_authorization.envelope.key.v1')
    .update('\0')
    .update(capabilityId)
    .digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(
    Buffer.from(
      JSON.stringify([
        'skoobi.task_authorization.envelope.aad.v1',
        capabilityId,
        authRequestId,
        action,
      ]),
    ),
  );
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(envelope), 'utf8'),
    cipher.final(),
  ]);
  const sealedEnvelope = {
    v: 1,
    alg: 'A256GCM',
    iv: iv.toString('base64url'),
    ciphertext: ciphertext.toString('base64url'),
    tag: cipher.getAuthTag().toString('base64url'),
  };
  const payload = {
    type: 'task_authorize',
    request_id: authRequestId,
    action,
    sealed_envelope: sealedEnvelope,
  };
  const response = authorizeTaskOperationRequest(
    {
      ...payload,
      capability_id: capabilityId,
      proof: createHmac('sha256', secret)
        .update(JSON.stringify(payload))
        .digest('base64url'),
    },
    'telegram_main',
  );
  expect(response.ok).toBe(true);
  return response.grant!;
}

function memoryJournal(): GoogleMutationJournal {
  const rows = new Map<
    string,
    {
      operationFingerprint: string;
      status: string;
      result?: unknown;
      error?: string;
    }
  >();
  const key = (intentId: string, operationKey: string) =>
    `${intentId}:${operationKey}`;
  return {
    begin(input) {
      const id = key(input.intentId, input.operationKey);
      const row = rows.get(id);
      if (!row) {
        rows.set(id, {
          operationFingerprint: input.operationFingerprint,
          status: 'started',
        });
        return { state: 'new' };
      }
      if (row.operationFingerprint !== input.operationFingerprint) {
        return { state: 'blocked', status: 'payload_mismatch' };
      }
      return row.status === 'succeeded'
        ? { state: 'succeeded', result: row.result }
        : { state: 'blocked', status: row.status };
    },
    succeed(input) {
      const id = key(input.intentId, input.operationKey);
      const row = rows.get(id);
      if (!row) throw new Error('mutation journal row is missing');
      rows.set(id, {
        operationFingerprint: row.operationFingerprint,
        status: 'succeeded',
        result: input.result,
      });
    },
    unknown(input) {
      const id = key(input.intentId, input.operationKey);
      const row = rows.get(id);
      if (!row) throw new Error('mutation journal row is missing');
      rows.set(id, {
        operationFingerprint: row.operationFingerprint,
        status: 'unknown',
        error: input.error,
      });
    },
    release(input) {
      rows.delete(key(input.intentId, input.operationKey));
    },
  };
}

afterEach(() => _clearTaskAuthorizationState());

describe('processGoogleWorkspaceRequest', () => {
  it('sweeps stale results and symlinks without touching their targets', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'google-sweep-'));
    const stale = path.join(root, 'stale.result.json');
    const recent = path.join(root, 'recent.result.json');
    const outside = path.join(root, 'outside.txt');
    const link = path.join(root, 'link.result.json');
    try {
      fs.writeFileSync(stale, 'stale');
      fs.writeFileSync(recent, 'recent');
      fs.writeFileSync(outside, 'outside must remain');
      fs.symlinkSync(outside, link);
      const now = Date.now();
      fs.utimesSync(stale, new Date(now - 10_000), new Date(now - 10_000));
      expect(sweepStaleGoogleResultFiles(root, now, 5_000)).toBe(2);
      expect(fs.existsSync(stale)).toBe(false);
      expect(fs.existsSync(link)).toBe(false);
      expect(fs.readFileSync(outside, 'utf8')).toBe('outside must remain');
      expect(fs.readFileSync(recent, 'utf8')).toBe('recent');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('seals disk results with the runner-compatible authenticated contract', () => {
    const requestId = 'google_sealed_1234';
    const responseKeyBytes = Buffer.alloc(32, 0x5a);
    const responseKey = responseKeyBytes.toString('base64url');
    const inner = {
      type: 'google_api_result' as const,
      request_id: requestId,
      ok: true,
      result: { markdown: 'owner confidential content' },
    };
    const sealed = sealGoogleApiResultEnvelope(inner, responseKey);
    expect(Object.keys(sealed).sort()).toEqual(
      ['ciphertext', 'nonce', 'request_id', 'tag', 'type', 'v'].sort(),
    );
    expect(JSON.stringify(sealed)).not.toContain('owner confidential content');

    const domain = 'skoobi.google_api.sealed_result.v1';
    const key = Buffer.from(
      hkdfSync(
        'sha256',
        responseKeyBytes,
        Buffer.from(domain),
        Buffer.from(requestId),
        32,
      ),
    );
    const decipher = createDecipheriv(
      'aes-256-gcm',
      key,
      Buffer.from(sealed.nonce, 'base64url'),
    );
    decipher.setAAD(Buffer.from(`${domain}\0${requestId}`));
    decipher.setAuthTag(Buffer.from(sealed.tag, 'base64url'));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(sealed.ciphertext, 'base64url')),
      decipher.final(),
    ]);
    expect(JSON.parse(plaintext.toString('utf8'))).toEqual(inner);
  });

  it('never calls the host executor without an exact owner grant', async () => {
    const execute = vi.fn();
    const result = await processGoogleWorkspaceRequest({
      raw: {
        type: 'google_api',
        request_id: 'google_read_1234',
        tool: 'google_docs_read',
        args: { documentId: DOCUMENT_ID },
      },
      sourceGroup: 'telegram_main',
      execute,
      journal: memoryJournal(),
    });
    expect(result.ok).toBe(false);
    expect(execute).not.toHaveBeenCalled();
  });

  it('executes an exact read once and marks external content untrusted', async () => {
    const envelope = {
      type: 'google_api',
      request_id: 'google_read_1234',
      tool: 'google_docs_read',
      args: { documentId: DOCUMENT_ID },
    };
    const grant = authorize(
      capabilityFor(['google_docs_read']),
      envelope,
      'authorize_google_read_1',
    );
    const execute = vi.fn(async () => ({ text: 'external instructions' }));
    const result = await processGoogleWorkspaceRequest({
      raw: { ...envelope, ownerAuthorizationGrant: grant },
      sourceGroup: 'telegram_main',
      execute,
      journal: memoryJournal(),
    });
    expect(result.ok).toBe(true);
    expect(result.result).toMatchObject({
      external_untrusted_data: true,
      data: { text: 'external instructions' },
    });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('returns a cached write result for the exact operation across provider fallback', async () => {
    const envelope = {
      type: 'google_api',
      request_id: 'google_create_1234',
      tool: 'google_docs_create',
      args: { title: 'Plan' },
    };
    const journal = memoryJournal();
    const execute = vi.fn(async () => ({ id: 'created-1' }));
    const firstGrant = authorize(
      capabilityFor(['google_docs_create']),
      envelope,
      'authorize_google_create_1',
    );
    const first = await processGoogleWorkspaceRequest({
      raw: { ...envelope, ownerAuthorizationGrant: firstGrant },
      sourceGroup: 'telegram_main',
      execute,
      journal,
    });
    expect(first).toMatchObject({ ok: true, result: { id: 'created-1' } });

    const fallbackEnvelope = {
      ...envelope,
      request_id: 'google_create_5678',
    };
    const fallbackGrant = authorize(
      capabilityFor(['google_docs_create']),
      fallbackEnvelope,
      'authorize_google_create_2',
    );
    const fallback = await processGoogleWorkspaceRequest({
      raw: { ...fallbackEnvelope, ownerAuthorizationGrant: fallbackGrant },
      sourceGroup: 'telegram_main',
      execute,
      journal,
    });
    expect(fallback).toMatchObject({
      ok: true,
      result: { id: 'created-1' },
    });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('dedupes an append retry and rejects changed rows in the same owner intent', async () => {
    const spreadsheetId = 'public-fixture-spreadsheet-id-0001';
    const range = "'Sheet1'!A1:G1000";
    const digest = 'd'.repeat(64);
    const policy = {
      allowedSpreadsheetIds: [spreadsheetId],
      allowedSheetRanges: [range],
      allowedSheetTargets: [{ spreadsheetId, range }],
      allowedSheetAppendTargets: [
        {
          label: 'ledger',
          spreadsheetId,
          range,
          columnCount: 7,
          maxRowsPerCall: 1,
        },
      ],
    };
    const journal = memoryJournal();
    const execute = vi.fn(async () => ({ updatedRange: "'Sheet1'!A3:G3" }));
    const run = async (
      requestId: string,
      authorizationRequestId: string,
      values: unknown[][],
    ) => {
      const envelope = {
        type: 'google_api',
        request_id: requestId,
        tool: 'google_sheets_append_values',
        args: {
          spreadsheetId,
          range,
          values,
          expectedDigest: digest,
        },
      };
      const grant = authorize(
        capabilityFor(['google_sheets_append_values'], policy),
        envelope,
        authorizationRequestId,
      );
      return processGoogleWorkspaceRequest({
        raw: { ...envelope, ownerAuthorizationGrant: grant },
        sourceGroup: 'telegram_main',
        execute,
        journal,
      });
    };

    expect(
      await run('google_append_first_1234', 'authorize_google_append_1', [
        ['24.07.2026', '10:00', '14:00', 4, 1500, 6000, 'С коллегой'],
      ]),
    ).toMatchObject({
      ok: true,
      result: { updatedRange: "'Sheet1'!A3:G3" },
    });
    expect(
      await run('google_append_retry_1234', 'authorize_google_append_2', [
        ['24.07.2026', '10:00', '14:00', 4, 1500, 6000, 'С коллегой'],
      ]),
    ).toMatchObject({
      ok: true,
      result: { updatedRange: "'Sheet1'!A3:G3" },
    });
    expect(execute).toHaveBeenCalledTimes(1);

    const changed = await run(
      'google_append_changed_1234',
      'authorize_google_append_3',
      [['24.07.2026', '11:00', '14:00', 3, 1500, 4500, 'С коллегой']],
    );
    expect(changed).toMatchObject({ ok: false });
    expect(changed.error).toContain('payload_mismatch');
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('executes distinct named create targets once each while deduping exact retries', async () => {
    const allowedCreateTargets = [
      { tool: 'google_docs_create', title: 'Plan', root: true },
      { tool: 'google_docs_create', title: 'Budget', root: true },
    ];
    const journal = memoryJournal();
    const execute = vi.fn(async (operation: any) => ({
      id: `created-${operation.args.title.toLowerCase()}`,
    }));
    const run = async (
      title: string,
      requestId: string,
      authorizationRequestId: string,
      contentMarkdown?: string,
    ) => {
      const envelope = {
        type: 'google_api',
        request_id: requestId,
        tool: 'google_docs_create',
        args: {
          title,
          ...(contentMarkdown === undefined ? {} : { contentMarkdown }),
        },
      };
      const grant = authorize(
        capabilityFor(['google_docs_create'], { allowedCreateTargets }),
        envelope,
        authorizationRequestId,
      );
      return processGoogleWorkspaceRequest({
        raw: { ...envelope, ownerAuthorizationGrant: grant },
        sourceGroup: 'telegram_main',
        execute,
        journal,
      });
    };

    expect(
      await run('Plan', 'google_named_plan_1234', 'authorize_named_plan_1'),
    ).toMatchObject({ ok: true, result: { id: 'created-plan' } });
    expect(
      await run(
        'Budget',
        'google_named_budget_1234',
        'authorize_named_budget_1',
      ),
    ).toMatchObject({ ok: true, result: { id: 'created-budget' } });
    expect(execute).toHaveBeenCalledTimes(2);

    expect(
      await run('Plan', 'google_named_plan_5678', 'authorize_named_plan_2'),
    ).toMatchObject({ ok: true, result: { id: 'created-plan' } });
    expect(execute).toHaveBeenCalledTimes(2);

    const changed = await run(
      'Plan',
      'google_named_plan_9999',
      'authorize_named_plan_3',
      '# changed payload',
    );
    expect(changed).toMatchObject({ ok: false });
    expect(changed.error).toContain('payload_mismatch');
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('blocks a different payload in the same mutation slot instead of returning cached success', async () => {
    const envelope = {
      type: 'google_api',
      request_id: 'google_create_1234',
      tool: 'google_docs_create',
      args: { title: 'Plan' },
    };
    const journal = memoryJournal();
    const execute = vi.fn(async () => ({ id: 'created-1' }));
    const firstGrant = authorize(
      capabilityFor(['google_docs_create']),
      envelope,
      'authorize_google_create_payload_1',
    );
    expect(
      await processGoogleWorkspaceRequest({
        raw: { ...envelope, ownerAuthorizationGrant: firstGrant },
        sourceGroup: 'telegram_main',
        execute,
        journal,
      }),
    ).toMatchObject({ ok: true, result: { id: 'created-1' } });

    const changedEnvelope = {
      ...envelope,
      request_id: 'google_create_5678',
      args: { title: 'Plan v2' },
    };
    const changedGrant = authorize(
      capabilityFor(['google_docs_create']),
      changedEnvelope,
      'authorize_google_create_payload_2',
    );
    const changed = await processGoogleWorkspaceRequest({
      raw: { ...changedEnvelope, ownerAuthorizationGrant: changedGrant },
      sourceGroup: 'telegram_main',
      execute,
      journal,
    });
    expect(changed).toMatchObject({ ok: false });
    expect(changed.error).toContain('payload_mismatch');
    expect(changed.result).toBeUndefined();
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('enforces exact fingerprints in the SQLite mutation journal', () => {
    _initTestDatabase();
    const journal = createSqliteGoogleMutationJournal();
    const slot = {
      intentId: 'c'.repeat(64),
      operationKey: 'd'.repeat(64),
      operationFingerprint: 'e'.repeat(64),
      groupFolder: 'telegram_main',
      tool: 'google_docs_create',
    };
    expect(journal.begin(slot)).toEqual({ state: 'new' });
    journal.succeed({
      intentId: slot.intentId,
      operationKey: slot.operationKey,
      result: { id: 'created-1' },
    });
    expect(journal.begin(slot)).toEqual({
      state: 'succeeded',
      result: { id: 'created-1' },
    });
    expect(
      journal.begin({
        ...slot,
        operationFingerprint: 'f'.repeat(64),
      }),
    ).toEqual({ state: 'blocked', status: 'payload_mismatch' });
  });

  it('releases a mutation slot after a definite preflight rejection', async () => {
    const envelope = {
      type: 'google_api',
      request_id: 'google_create_1234',
      tool: 'google_docs_create',
      args: { title: 'Plan' },
    };
    const journal = memoryJournal();
    const execute = vi
      .fn()
      .mockRejectedValueOnce(
        new GoogleWorkspaceClientError(
          'conflict',
          'Definite optimistic-concurrency rejection.',
        ),
      )
      .mockResolvedValueOnce({ id: 'created-after-retry' });
    const firstGrant = authorize(
      capabilityFor(['google_docs_create']),
      envelope,
      'authorize_google_conflict_1',
    );
    expect(
      await processGoogleWorkspaceRequest({
        raw: { ...envelope, ownerAuthorizationGrant: firstGrant },
        sourceGroup: 'telegram_main',
        execute,
        journal,
      }),
    ).toMatchObject({ ok: false });

    const retryEnvelope = { ...envelope, request_id: 'google_create_7777' };
    const retryGrant = authorize(
      capabilityFor(['google_docs_create']),
      retryEnvelope,
      'authorize_google_conflict_2',
    );
    expect(
      await processGoogleWorkspaceRequest({
        raw: { ...retryEnvelope, ownerAuthorizationGrant: retryGrant },
        sourceGroup: 'telegram_main',
        execute,
        journal,
      }),
    ).toMatchObject({ ok: true, result: { id: 'created-after-retry' } });
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('does not automatically retry an ambiguous failed mutation', async () => {
    const envelope = {
      type: 'google_api',
      request_id: 'google_create_1234',
      tool: 'google_docs_create',
      args: { title: 'Plan' },
    };
    const journal = memoryJournal();
    const execute = vi.fn(async () => {
      throw new Error('network outcome unknown');
    });
    const firstGrant = authorize(
      capabilityFor(['google_docs_create']),
      envelope,
      'authorize_google_unknown_1',
    );
    expect(
      await processGoogleWorkspaceRequest({
        raw: { ...envelope, ownerAuthorizationGrant: firstGrant },
        sourceGroup: 'telegram_main',
        execute,
        journal,
      }),
    ).toMatchObject({ ok: false });

    const retryEnvelope = { ...envelope, request_id: 'google_create_9999' };
    const retryGrant = authorize(
      capabilityFor(['google_docs_create']),
      retryEnvelope,
      'authorize_google_unknown_2',
    );
    const retry = await processGoogleWorkspaceRequest({
      raw: { ...retryEnvelope, ownerAuthorizationGrant: retryGrant },
      sourceGroup: 'telegram_main',
      execute,
      journal,
    });
    expect(retry.error).toContain('was not repeated');
    expect(execute).toHaveBeenCalledTimes(1);
  });
});
