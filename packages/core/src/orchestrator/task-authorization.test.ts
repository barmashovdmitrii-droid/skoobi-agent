import { afterEach, describe, expect, it } from 'vitest';

import {
  _clearTaskAuthorizationState,
  authorizeTaskOperationRequest,
  consumeTaskOperationGrant,
  registerTaskAuthorizationCapability,
  revokeTaskAuthorizationCapability,
} from './task-authorization.js';
import {
  resignTaskAuthorizationRequestForTest,
  signedTaskAuthorizationRequestForTest,
} from './task-authorization.test-helpers.js';

const ownerIdentity = {
  channel: 'telegram' as const,
  chat_id: '-100123',
  telegram_user_id: '100000001',
  identity_id: 'telegram_user_100000001',
  is_owner_sender: true,
  telegram_message_origin: 'direct' as const,
};

function ownerCapability(): string {
  const capability = registerTaskAuthorizationCapability({
    groupFolder: 'telegram_main',
    isMain: true,
    credentialProxyTier: 'owner',
    senderIdentity: ownerIdentity,
    homogeneousOwnerBatch: true,
  });
  expect(capability).toBeTruthy();
  return capability!;
}

it.each(['forwarded', 'quoted', undefined] as const)(
  'does not mint an owner task capability for %s or legacy provenance',
  (origin) => {
    expect(
      registerTaskAuthorizationCapability({
        groupFolder: 'telegram_main',
        isMain: true,
        credentialProxyTier: 'owner',
        senderIdentity: {
          ...ownerIdentity,
          telegram_message_origin: origin,
        },
        homogeneousOwnerBatch: true,
      }),
    ).toBeNull();
  },
);

function signedRequest(
  capability: string,
  envelope: Record<string, unknown>,
  requestId = 'request_task_1234',
) {
  return signedTaskAuthorizationRequestForTest(capability, envelope, requestId);
}

function scheduleEnvelope(): Record<string, unknown> {
  return {
    type: 'schedule_task',
    taskId: 'task-owner-1',
    prompt: 'Owner-authored reminder',
    schedule_type: 'once',
    schedule_value: '2027-01-01T09:00:00',
    context_mode: 'isolated',
    targetJid: 'tg:-100123',
    calendar_event: true,
  };
}

afterEach(() => _clearTaskAuthorizationState());

describe('task operation authorization', () => {
  it('keeps the capability secret off disk and binds a one-use grant to the exact envelope', () => {
    const capability = ownerCapability();
    const [, secret] = capability.split('.');
    const envelope = scheduleEnvelope();
    const request = signedRequest(capability, envelope);

    expect(JSON.stringify(request)).not.toContain(secret);
    expect(JSON.stringify(request)).not.toContain(envelope.prompt);
    expect(request).not.toHaveProperty('capability');
    expect(request).not.toHaveProperty('envelope');
    expect(request.sealed_envelope).toMatchObject({
      v: 1,
      alg: 'A256GCM',
    });

    const response = authorizeTaskOperationRequest(request, 'telegram_main');
    expect(response).toMatchObject({ ok: true });
    const consumed = consumeTaskOperationGrant(
      { ...envelope, ownerAuthorizationGrant: response.grant },
      'telegram_main',
    );
    expect(consumed).toEqual({
      creatorAuthorization: 'owner_sender',
      creatorIdentityId: 'telegram_user_100000001',
      creatorSenderId: '100000001',
    });
    expect(
      consumeTaskOperationGrant(
        { ...envelope, ownerAuthorizationGrant: response.grant },
        'telegram_main',
      ),
    ).toBeNull();
  });

  it('rejects forged, tampered, replayed, cross-group, and non-owner proofs', () => {
    const capability = ownerCapability();
    const envelope = scheduleEnvelope();

    const forged = signedRequest(capability, envelope, 'request_forged_1');
    forged.proof = Buffer.alloc(32, 7).toString('base64url');
    expect(
      authorizeTaskOperationRequest(forged, 'telegram_main'),
    ).toMatchObject({ ok: false, error: 'invalid_proof' });

    const tampered = signedRequest(capability, envelope, 'request_tampered_1');
    const originalLast = tampered.sealed_envelope.ciphertext.slice(-1);
    tampered.sealed_envelope = {
      ...tampered.sealed_envelope,
      ciphertext: `${tampered.sealed_envelope.ciphertext.slice(0, -1)}${originalLast === 'A' ? 'B' : 'A'}`,
    };
    expect(
      authorizeTaskOperationRequest(tampered, 'telegram_main'),
    ).toMatchObject({ ok: false, error: 'invalid_proof' });

    const valid = signedRequest(capability, envelope, 'request_replay_1');
    expect(authorizeTaskOperationRequest(valid, 'telegram_main').ok).toBe(true);
    expect(authorizeTaskOperationRequest(valid, 'telegram_main')).toMatchObject(
      { ok: false, error: 'replayed_request_id' },
    );

    const crossGroup = signedRequest(
      capability,
      envelope,
      'request_cross_group_1',
    );
    expect(
      authorizeTaskOperationRequest(crossGroup, 'other_group'),
    ).toMatchObject({ ok: false, error: 'capability_group_mismatch' });

    expect(
      registerTaskAuthorizationCapability({
        groupFolder: 'telegram_main',
        isMain: true,
        credentialProxyTier: 'guest',
        senderIdentity: { ...ownerIdentity, is_owner_sender: false },
        homogeneousOwnerBatch: true,
      }),
    ).toBeNull();
  });

  it('rejects plaintext fallback, invalid GCM tags, and outer-field rebinding', () => {
    const capability = ownerCapability();
    const [capabilityId] = capability.split('.');
    const envelope = scheduleEnvelope();
    const plaintextRequest: Record<string, unknown> = {
      type: 'task_authorize',
      request_id: 'request_plaintext_1',
      action: envelope.type,
      envelope,
      capability_id: capabilityId,
    };
    plaintextRequest.proof = resignTaskAuthorizationRequestForTest(
      capability,
      plaintextRequest,
    );
    expect(
      authorizeTaskOperationRequest(plaintextRequest, 'telegram_main'),
    ).toMatchObject({
      ok: false,
      error: 'plaintext_envelope_not_allowed',
    });

    const invalidTag = signedRequest(
      capability,
      envelope,
      'request_invalid_tag_1',
    );
    invalidTag.sealed_envelope = {
      ...invalidTag.sealed_envelope,
      tag: Buffer.alloc(16, 0x7a).toString('base64url'),
    };
    invalidTag.proof = resignTaskAuthorizationRequestForTest(
      capability,
      invalidTag as unknown as Record<string, unknown>,
    );
    expect(
      authorizeTaskOperationRequest(invalidTag, 'telegram_main'),
    ).toMatchObject({ ok: false, error: 'invalid_sealed_envelope' });

    const rebound = signedRequest(
      capability,
      envelope,
      'request_rebound_action_1',
    );
    rebound.action = 'message';
    rebound.proof = resignTaskAuthorizationRequestForTest(
      capability,
      rebound as unknown as Record<string, unknown>,
    );
    expect(
      authorizeTaskOperationRequest(rebound, 'telegram_main'),
    ).toMatchObject({ ok: false, error: 'invalid_sealed_envelope' });
  });

  it('burns a presented operation grant even when the envelope is changed', () => {
    const capability = ownerCapability();
    const envelope = scheduleEnvelope();
    const response = authorizeTaskOperationRequest(
      signedRequest(capability, envelope),
      'telegram_main',
    );
    expect(response.ok).toBe(true);

    expect(
      consumeTaskOperationGrant(
        {
          ...envelope,
          prompt: 'tampered',
          ownerAuthorizationGrant: response.grant,
        },
        'telegram_main',
      ),
    ).toBeNull();
    expect(
      consumeTaskOperationGrant(
        { ...envelope, ownerAuthorizationGrant: response.grant },
        'telegram_main',
      ),
    ).toBeNull();
  });

  it('does not let an absent update field collide with an injected empty prompt', () => {
    const capability = ownerCapability();
    const envelope = {
      type: 'update_task',
      taskId: 'task-owner-1',
      schedule_value: '2027-02-01T09:00:00',
    };
    const response = authorizeTaskOperationRequest(
      signedRequest(capability, envelope, 'request_update_collision'),
      'telegram_main',
    );
    expect(response.ok).toBe(true);

    expect(
      consumeTaskOperationGrant(
        {
          ...envelope,
          prompt: '',
          ownerAuthorizationGrant: response.grant,
        },
        'telegram_main',
      ),
    ).toBeNull();
    expect(
      consumeTaskOperationGrant(
        { ...envelope, ownerAuthorizationGrant: response.grant },
        'telegram_main',
      ),
    ).toBeNull();
  });

  it('binds task IDs byte-for-byte instead of trimming into a different lookup', () => {
    const capability = ownerCapability();
    const envelope = {
      type: 'pause_task',
      taskId: ' task-owner-1 ',
    };
    const response = authorizeTaskOperationRequest(
      signedRequest(capability, envelope, 'request_task_id_whitespace'),
      'telegram_main',
    );
    expect(response.ok).toBe(true);
    expect(
      consumeTaskOperationGrant(
        {
          ...envelope,
          taskId: 'task-owner-1',
          ownerAuthorizationGrant: response.grant,
        },
        'telegram_main',
      ),
    ).toBeNull();
  });

  it('distinguishes absent requiresTrigger from injected null', () => {
    const capability = ownerCapability();
    const envelope = {
      type: 'register_group',
      jid: 'tg:-100999',
      name: 'New group',
      folder: 'telegram_new-group',
      trigger: '@Skoobi',
    };
    const response = authorizeTaskOperationRequest(
      signedRequest(capability, envelope, 'request_register_collision'),
      'telegram_main',
    );
    expect(response.ok).toBe(true);
    expect(
      consumeTaskOperationGrant(
        {
          ...envelope,
          requiresTrigger: null,
          ownerAuthorizationGrant: response.grant,
        },
        'telegram_main',
      ),
    ).toBeNull();
  });

  it('invalidates already-minted operation grants when the run capability is revoked', () => {
    const capability = ownerCapability();
    const envelope = scheduleEnvelope();
    const response = authorizeTaskOperationRequest(
      signedRequest(capability, envelope, 'request_revoke_outstanding'),
      'telegram_main',
    );
    expect(response.ok).toBe(true);

    revokeTaskAuthorizationCapability(capability);
    expect(
      consumeTaskOperationGrant(
        { ...envelope, ownerAuthorizationGrant: response.grant },
        'telegram_main',
      ),
    ).toBeNull();
  });
});

describe('Google operation authorization', () => {
  const documentId = 'public-fixture-document-id-0001';
  const basePolicy = {
    intentId: 'a'.repeat(64),
    allowedTools: ['google_docs_read'] as const,
    allowedDocumentIds: [documentId],
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
    allowedCreateTargets: [],
    rootCreateTools: [],
    allowStatusVerify: false,
    allowDriveSearch: false,
    allowUnfilteredDriveList: false,
    allowRootCreate: false,
    allowUserEnteredValues: false,
  };

  function googleCapability(
    policy: Parameters<
      typeof registerTaskAuthorizationCapability
    >[0]['googleOperationPolicy'] = basePolicy as any,
  ): string {
    const capability = registerTaskAuthorizationCapability({
      groupFolder: 'telegram_main',
      isMain: true,
      credentialProxyTier: 'owner',
      senderIdentity: ownerIdentity,
      homogeneousOwnerBatch: true,
      googleOperationPolicy: policy,
    });
    expect(capability).toBeTruthy();
    return capability!;
  }

  function docsReadEnvelope(id = documentId): Record<string, unknown> {
    return {
      type: 'google_api',
      request_id: 'google_request_1234',
      tool: 'google_docs_read',
      args: { documentId: id },
    };
  }

  it('denies Google RPC without a host-derived turn policy', () => {
    const request = signedRequest(ownerCapability(), docsReadEnvelope());
    expect(
      authorizeTaskOperationRequest(request, 'telegram_main'),
    ).toMatchObject({ ok: false, error: 'google_policy_unavailable' });
  });

  it('binds an exact resource and returns trusted journal metadata on consume', () => {
    const envelope = docsReadEnvelope();
    const response = authorizeTaskOperationRequest(
      signedRequest(googleCapability(), envelope),
      'telegram_main',
    );
    expect(response.ok).toBe(true);
    const consumed = consumeTaskOperationGrant(
      { ...envelope, ownerAuthorizationGrant: response.grant },
      'telegram_main',
    );
    expect(consumed).toMatchObject({
      creatorAuthorization: 'owner_sender',
      googleIntentId: 'a'.repeat(64),
      googleTool: 'google_docs_read',
      googleOperationKey: expect.stringMatching(/^[a-f0-9]{64}$/),
      googleResponseKey: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
    });
  });

  it('rejects resources outside policy but permits bounded exact repeated reads', () => {
    const capability = googleCapability();
    expect(
      authorizeTaskOperationRequest(
        signedRequest(
          capability,
          docsReadEnvelope('1DifferentDocumentResourceId123456'),
          'google_wrong_resource_1',
        ),
        'telegram_main',
      ),
    ).toMatchObject({
      ok: false,
      error: 'google_resource_not_allowed_for_turn',
    });

    const envelope = docsReadEnvelope();
    expect(
      authorizeTaskOperationRequest(
        signedRequest(capability, envelope, 'google_first_slot_1'),
        'telegram_main',
      ).ok,
    ).toBe(true);
    expect(
      authorizeTaskOperationRequest(
        signedRequest(capability, envelope, 'google_second_slot_1'),
        'telegram_main',
      ).ok,
    ).toBe(true);
  });

  it('authorizes Gmail reads only when the owner-turn allowlist includes them', () => {
    const gmailPolicy = {
      ...basePolicy,
      allowedTools: ['gmail_search_threads', 'gmail_get_thread'],
    } as any;
    const capability = googleCapability(gmailPolicy);
    const search = {
      type: 'google_api',
      request_id: 'gmail_search_request_1',
      tool: 'gmail_search_threads',
      args: { query: 'from:ivan@example.com', maxResults: 10 },
    };
    const get = {
      type: 'google_api',
      request_id: 'gmail_thread_request_1',
      tool: 'gmail_get_thread',
      args: { threadId: '18f0abc123def456' },
    };
    expect(
      authorizeTaskOperationRequest(
        signedRequest(capability, search, 'authorize_gmail_search_1'),
        'telegram_main',
      ).ok,
    ).toBe(true);
    expect(
      authorizeTaskOperationRequest(
        signedRequest(capability, get, 'authorize_gmail_thread_1'),
        'telegram_main',
      ).ok,
    ).toBe(true);

    const searchOnly = googleCapability({
      ...basePolicy,
      allowedTools: ['gmail_search_threads'],
    } as any);
    expect(
      authorizeTaskOperationRequest(
        signedRequest(searchOnly, get, 'authorize_gmail_denied_1'),
        'telegram_main',
      ),
    ).toMatchObject({
      ok: false,
      error: 'google_tool_not_allowed_for_turn',
    });
  });

  it('burns a grant presented with a changed resource', () => {
    const envelope = docsReadEnvelope();
    const response = authorizeTaskOperationRequest(
      signedRequest(googleCapability(), envelope),
      'telegram_main',
    );
    expect(
      consumeTaskOperationGrant(
        {
          ...docsReadEnvelope('1DifferentDocumentResourceId123456'),
          ownerAuthorizationGrant: response.grant,
        },
        'telegram_main',
      ),
    ).toBeNull();
    expect(
      consumeTaskOperationGrant(
        { ...envelope, ownerAuthorizationGrant: response.grant },
        'telegram_main',
      ),
    ).toBeNull();
  });

  it('requires confirmation for whole-doc replacement', () => {
    const envelope = {
      type: 'google_api',
      request_id: 'google_replace_1234',
      tool: 'google_docs_replace_content',
      args: {
        documentId,
        contentMarkdown: '# replacement',
        expectedRevisionId: 'revision-1',
      },
    };
    const capability = googleCapability({
      ...basePolicy,
      allowedTools: ['google_docs_replace_content'],
    } as any);
    expect(
      authorizeTaskOperationRequest(
        signedRequest(capability, envelope),
        'telegram_main',
      ),
    ).toMatchObject({
      ok: false,
      error: 'google_destructive_confirmation_required',
    });
  });

  it('accepts a confirmed replacement only for its exact document', () => {
    const envelope = {
      type: 'google_api',
      request_id: 'google_replace_5678',
      tool: 'google_docs_replace_content',
      args: {
        documentId,
        contentMarkdown: '# replacement',
        expectedRevisionId: 'revision-1',
      },
    };
    const capability = googleCapability({
      ...basePolicy,
      allowedTools: ['google_docs_replace_content'],
      confirmedDocumentReplaceIds: [documentId],
    } as any);
    expect(
      authorizeTaskOperationRequest(
        signedRequest(capability, envelope),
        'telegram_main',
      ).ok,
    ).toBe(true);
  });

  it('binds Drive filters to exact owner queries instead of text substrings', () => {
    const drivePolicy = {
      ...basePolicy,
      allowedTools: ['google_drive_list_files'],
      allowedDriveSearchTargets: [
        {
          nameQuery: 'Budget',
          type: 'any',
          rootOnly: false,
          unfiltered: false,
        },
      ],
      allowDriveSearch: true,
    } as any;
    const envelope = (query?: string) => ({
      type: 'google_api',
      request_id: 'google_drive_query_1234',
      tool: 'google_drive_list_files',
      args: query === undefined ? {} : { query },
    });

    expect(
      authorizeTaskOperationRequest(
        signedRequest(
          googleCapability(drivePolicy),
          envelope('budget'),
          'authorize_drive_exact_1',
        ),
        'telegram_main',
      ).ok,
    ).toBe(true);
    for (const [requestId, query] of [
      ['authorize_drive_substring_1', 'go'],
      ['authorize_drive_arbitrary_1', 'Budget forecast'],
      ['authorize_drive_omitted_1', undefined],
    ] as const) {
      expect(
        authorizeTaskOperationRequest(
          signedRequest(
            googleCapability(drivePolicy),
            envelope(query),
            requestId,
          ),
          'telegram_main',
        ),
      ).toMatchObject({
        ok: false,
        error: 'google_resource_not_allowed_for_turn',
      });
    }

    expect(
      authorizeTaskOperationRequest(
        signedRequest(
          googleCapability(drivePolicy),
          {
            ...envelope(),
            args: { contentQuery: 'Budget' },
          },
          'authorize_drive_content_substitution_1',
        ),
        'telegram_main',
      ),
    ).toMatchObject({
      ok: false,
      error: 'google_resource_not_allowed_for_turn',
    });

    const typedPolicy = {
      ...drivePolicy,
      allowedDriveSearchTargets: [
        {
          nameQuery: 'Budget',
          type: 'sheet',
          rootOnly: false,
          unfiltered: false,
        },
      ],
    } as any;
    expect(
      authorizeTaskOperationRequest(
        signedRequest(
          googleCapability(typedPolicy),
          { ...envelope('Budget'), args: { query: 'Budget', type: 'doc' } },
          'authorize_drive_wrong_type_1',
        ),
        'telegram_main',
      ),
    ).toMatchObject({
      ok: false,
      error: 'google_resource_not_allowed_for_turn',
    });
    expect(
      authorizeTaskOperationRequest(
        signedRequest(
          googleCapability(typedPolicy),
          { ...envelope('Budget'), args: { query: 'Budget', type: 'sheet' } },
          'authorize_drive_exact_type_1',
        ),
        'telegram_main',
      ).ok,
    ).toBe(true);
  });

  it('does not substitute an all-files Drive grant for a My Drive root grant', () => {
    const rootPolicy = {
      ...basePolicy,
      allowedTools: ['google_drive_list_files'],
      allowedDriveSearchTargets: [
        { type: 'any', rootOnly: true, unfiltered: false },
      ],
      allowDriveSearch: true,
    } as any;
    const envelope = (rootOnly = false) => ({
      type: 'google_api',
      request_id: 'google_drive_root_1234',
      tool: 'google_drive_list_files',
      args: { rootOnly },
    });
    expect(
      authorizeTaskOperationRequest(
        signedRequest(
          googleCapability(rootPolicy),
          envelope(true),
          'authorize_drive_root_exact_1',
        ),
        'telegram_main',
      ).ok,
    ).toBe(true);
    expect(
      authorizeTaskOperationRequest(
        signedRequest(
          googleCapability(rootPolicy),
          envelope(false),
          'authorize_drive_root_widen_1',
        ),
        'telegram_main',
      ),
    ).toMatchObject({
      ok: false,
      error: 'google_resource_not_allowed_for_turn',
    });

    const allFilesPolicy = {
      ...rootPolicy,
      allowedDriveSearchTargets: [
        { type: 'any', rootOnly: false, unfiltered: true },
      ],
      allowUnfilteredDriveList: true,
    } as any;
    expect(
      authorizeTaskOperationRequest(
        signedRequest(
          googleCapability(allFilesPolicy),
          envelope(true),
          'authorize_drive_all_to_root_1',
        ),
        'telegram_main',
      ),
    ).toMatchObject({
      ok: false,
      error: 'google_resource_not_allowed_for_turn',
    });
  });

  it('assigns stable distinct mutation slots to explicitly named creates', () => {
    const createPolicy = {
      ...basePolicy,
      allowedTools: ['google_docs_create'],
      allowedCreateTargets: [
        {
          tool: 'google_docs_create',
          title: 'Plan',
          root: true,
        },
        {
          tool: 'google_docs_create',
          title: 'Budget',
          root: true,
        },
      ],
      rootCreateTools: ['google_docs_create'],
      allowRootCreate: true,
    } as any;
    const capability = googleCapability(createPolicy);
    const consumeCreate = (
      title: string,
      operationRequestId: string,
      authorizationRequestId: string,
    ) => {
      const operation = {
        type: 'google_api',
        request_id: operationRequestId,
        tool: 'google_docs_create',
        args: { title },
      };
      const response = authorizeTaskOperationRequest(
        signedRequest(capability, operation, authorizationRequestId),
        'telegram_main',
      );
      expect(response.ok).toBe(true);
      return consumeTaskOperationGrant(
        { ...operation, ownerAuthorizationGrant: response.grant },
        'telegram_main',
      )?.googleOperationKey;
    };

    const plan = consumeCreate(
      'Plan',
      'google_create_plan_1234',
      'authorize_create_plan_1',
    );
    const planRetry = consumeCreate(
      'Plan',
      'google_create_plan_5678',
      'authorize_create_plan_2',
    );
    const budget = consumeCreate(
      'Budget',
      'google_create_budget_1234',
      'authorize_create_budget_1',
    );
    expect(plan).toMatch(/^[a-f0-9]{64}$/);
    expect(planRetry).toBe(plan);
    expect(budget).toMatch(/^[a-f0-9]{64}$/);
    expect(budget).not.toBe(plan);

    const unauthorized = {
      type: 'google_api',
      request_id: 'google_create_other_1234',
      tool: 'google_docs_create',
      args: { title: 'Other' },
    };
    expect(
      authorizeTaskOperationRequest(
        signedRequest(capability, unauthorized, 'authorize_create_other_1'),
        'telegram_main',
      ),
    ).toMatchObject({
      ok: false,
      error: 'google_resource_not_allowed_for_turn',
    });
  });

  it('bounds Calendar reads to the current owner window and exact query', () => {
    const calendarPolicy = {
      ...basePolicy,
      allowedTools: ['google_calendar_list_events'],
      allowedCalendarIds: ['primary'],
      allowedCalendarTargets: [{ calendarId: 'primary' }],
      calendarEarliestTime: '2026-07-10T00:00:00.000Z',
      calendarLatestTime: '2026-08-11T00:00:00.000Z',
    } as any;
    const envelope = (timeMin: string, timeMax: string, query?: string) => ({
      type: 'google_api',
      request_id: 'google_calendar_query_1234',
      tool: 'google_calendar_list_events',
      args: {
        calendarId: 'primary',
        timeMin,
        timeMax,
        ...(query === undefined ? {} : { query }),
      },
    });
    const current = envelope(
      '2026-07-11T00:00:00.000Z',
      '2026-07-12T00:00:00.000Z',
    );
    expect(
      authorizeTaskOperationRequest(
        signedRequest(
          googleCapability(calendarPolicy),
          current,
          'authorize_calendar_current_1',
        ),
        'telegram_main',
      ).ok,
    ).toBe(true);
    expect(
      authorizeTaskOperationRequest(
        signedRequest(
          googleCapability(calendarPolicy),
          envelope('1999-01-01T00:00:00.000Z', '1999-01-02T00:00:00.000Z'),
          'authorize_calendar_history_1',
        ),
        'telegram_main',
      ),
    ).toMatchObject({
      ok: false,
      error: 'google_resource_not_allowed_for_turn',
    });
    expect(
      authorizeTaskOperationRequest(
        signedRequest(
          googleCapability(calendarPolicy),
          envelope(
            '2026-07-11T00:00:00.000Z',
            '2026-07-12T00:00:00.000Z',
            'private',
          ),
          'authorize_calendar_query_1',
        ),
        'telegram_main',
      ),
    ).toMatchObject({
      ok: false,
      error: 'google_resource_not_allowed_for_turn',
    });

    const filteredPolicy = {
      ...calendarPolicy,
      allowedCalendarQueries: ['Quarterly'],
      allowedCalendarTargets: [{ calendarId: 'primary', query: 'Quarterly' }],
    } as any;
    expect(
      authorizeTaskOperationRequest(
        signedRequest(
          googleCapability(filteredPolicy),
          { ...current, args: { ...current.args, query: 'quarterly' } },
          'authorize_calendar_exact_query_1',
        ),
        'telegram_main',
      ).ok,
    ).toBe(true);
    expect(
      authorizeTaskOperationRequest(
        signedRequest(
          googleCapability(filteredPolicy),
          current,
          'authorize_calendar_omit_query_1',
        ),
        'telegram_main',
      ),
    ).toMatchObject({
      ok: false,
      error: 'google_resource_not_allowed_for_turn',
    });

    const pairedPolicy = {
      ...calendarPolicy,
      allowedCalendarIds: ['work@example.com', 'personal@example.com'],
      allowedCalendarQueries: ['Plan', 'Budget'],
      allowedCalendarTargets: [
        { calendarId: 'work@example.com', query: 'Plan' },
        { calendarId: 'personal@example.com', query: 'Budget' },
      ],
    } as any;
    const pairedEnvelope = (calendarId: string, query: string) => ({
      ...current,
      args: { ...current.args, calendarId, query },
    });
    for (const [requestId, calendarId, query] of [
      ['authorize_calendar_pair_work_1', 'work@example.com', 'Plan'],
      ['authorize_calendar_pair_personal_1', 'personal@example.com', 'Budget'],
    ] as const) {
      expect(
        authorizeTaskOperationRequest(
          signedRequest(
            googleCapability(pairedPolicy),
            pairedEnvelope(calendarId, query),
            requestId,
          ),
          'telegram_main',
        ).ok,
      ).toBe(true);
    }
    for (const [requestId, calendarId, query] of [
      ['authorize_calendar_cross_work_1', 'work@example.com', 'Budget'],
      ['authorize_calendar_cross_personal_1', 'personal@example.com', 'Plan'],
    ] as const) {
      expect(
        authorizeTaskOperationRequest(
          signedRequest(
            googleCapability(pairedPolicy),
            pairedEnvelope(calendarId, query),
            requestId,
          ),
          'telegram_main',
        ),
      ).toMatchObject({
        ok: false,
        error: 'google_resource_not_allowed_for_turn',
      });
    }
  });

  it('denies non-atomic Sheet and Apps Script writes even with forged policy authority', () => {
    const spreadsheetId = 'public-fixture-spreadsheet-id-0001';
    const scriptId = '1AppsScriptResourceId123456789012';
    const digest = 'd'.repeat(64);
    const attempts = [
      {
        policy: {
          ...basePolicy,
          allowedTools: ['google_sheets_update_values'],
          allowedSheetTargets: [{ spreadsheetId, range: 'Sheet1!A1' }],
          confirmedSheetUpdateTargets: [{ spreadsheetId, range: 'Sheet1!A1' }],
        },
        envelope: {
          type: 'google_api',
          request_id: 'google_sheet_write_1234',
          tool: 'google_sheets_update_values',
          args: {
            spreadsheetId,
            range: 'Sheet1!A1',
            values: [['blocked']],
            inputMode: 'raw',
            expectedDigest: digest,
          },
        },
      },
      {
        policy: {
          ...basePolicy,
          allowedTools: ['google_apps_script_update_file'],
          confirmedScriptUpdateTargets: [{ scriptId, fileName: 'Code' }],
        },
        envelope: {
          type: 'google_api',
          request_id: 'google_script_write_1234',
          tool: 'google_apps_script_update_file',
          args: {
            scriptId,
            fileName: 'Code',
            source: 'function run() {}',
            expectedDigest: digest,
          },
        },
      },
    ];

    for (const [index, attempt] of attempts.entries()) {
      expect(
        authorizeTaskOperationRequest(
          signedRequest(
            googleCapability(attempt.policy as any),
            attempt.envelope,
            `authorize_non_atomic_write_${index}`,
          ),
          'telegram_main',
        ),
      ).toMatchObject({
        ok: false,
        error: 'google_atomic_precondition_unavailable',
      });
    }
  });

  it('allows only append-only Sheet writes bound to the exact target and formula policy', () => {
    const spreadsheetId = 'public-fixture-spreadsheet-id-0001';
    const range = "'Sheet1'!A1:G1000";
    const digest = 'd'.repeat(64);
    const appendPolicy = {
      ...basePolicy,
      allowedTools: ['google_sheets_get_values', 'google_sheets_append_values'],
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
    } as any;
    const appendEnvelope = {
      type: 'google_api',
      request_id: 'google_sheet_append_1234',
      tool: 'google_sheets_append_values',
      args: {
        spreadsheetId,
        range,
        values: [['24.07.2026', '10:00', '14:00', 4, 1500, 6000, 'С коллегой']],
        expectedDigest: digest,
      },
    };
    const response = authorizeTaskOperationRequest(
      signedRequest(
        googleCapability(appendPolicy),
        appendEnvelope,
        'authorize_sheet_append_1',
      ),
      'telegram_main',
    );
    expect(response.ok).toBe(true);
    expect(
      consumeTaskOperationGrant(
        { ...appendEnvelope, ownerAuthorizationGrant: response.grant },
        'telegram_main',
      ),
    ).toMatchObject({
      googleTool: 'google_sheets_append_values',
      googleIntentId: basePolicy.intentId,
    });

    expect(
      authorizeTaskOperationRequest(
        signedRequest(
          googleCapability(appendPolicy),
          {
            ...appendEnvelope,
            request_id: 'google_sheet_append_wrong_range',
            args: { ...appendEnvelope.args, range: "'Sheet1'!A1:H1000" },
          },
          'authorize_sheet_append_2',
        ),
        'telegram_main',
      ),
    ).toMatchObject({
      ok: false,
      error: 'google_resource_not_allowed_for_turn',
    });

    expect(
      authorizeTaskOperationRequest(
        signedRequest(
          googleCapability(appendPolicy),
          {
            ...appendEnvelope,
            request_id: 'google_sheet_append_null_cell',
            args: {
              ...appendEnvelope.args,
              values: [['24.07.2026', '10:00', '14:00', 4, 1500, 6000, null]],
            },
          },
          'authorize_sheet_append_5',
        ),
        'telegram_main',
      ),
    ).toMatchObject({
      ok: false,
      error: 'google_resource_not_allowed_for_turn',
    });

    expect(
      authorizeTaskOperationRequest(
        signedRequest(
          googleCapability(appendPolicy),
          {
            ...appendEnvelope,
            request_id: 'google_sheet_append_formula',
            args: { ...appendEnvelope.args, inputMode: 'user_entered' },
          },
          'authorize_sheet_append_3',
        ),
        'telegram_main',
      ),
    ).toMatchObject({
      ok: false,
      error: 'invalid_google_operation',
    });

    expect(
      authorizeTaskOperationRequest(
        signedRequest(
          googleCapability(appendPolicy),
          {
            ...appendEnvelope,
            request_id: 'google_sheet_append_partial_row',
            args: {
              ...appendEnvelope.args,
              values: [['24.07.2026', '10:00']],
            },
          },
          'authorize_sheet_append_4',
        ),
        'telegram_main',
      ),
    ).toMatchObject({
      ok: false,
      error: 'google_resource_not_allowed_for_turn',
    });

    expect(
      authorizeTaskOperationRequest(
        signedRequest(
          googleCapability(appendPolicy),
          {
            ...appendEnvelope,
            request_id: 'google_sheet_append_bulk_rows',
            args: {
              ...appendEnvelope.args,
              values: [
                appendEnvelope.args.values[0],
                appendEnvelope.args.values[0],
              ],
            },
          },
          'authorize_sheet_append_6',
        ),
        'telegram_main',
      ),
    ).toMatchObject({
      ok: false,
      error: 'google_resource_not_allowed_for_turn',
    });
  });
});
