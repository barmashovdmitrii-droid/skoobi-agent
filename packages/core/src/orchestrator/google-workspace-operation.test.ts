import { describe, expect, it } from 'vitest';

import {
  GOOGLE_WORKSPACE_DEFAULT_MAX_RESULTS,
  GOOGLE_WORKSPACE_DESTRUCTIVE_TOOLS,
  GOOGLE_WORKSPACE_MAX_CELL_STRING_CHARS,
  GOOGLE_WORKSPACE_MAX_ID_CHARS,
  GOOGLE_WORKSPACE_MAX_MARKDOWN_BYTES,
  GOOGLE_WORKSPACE_MAX_QUERY_CHARS,
  GOOGLE_WORKSPACE_MAX_RANGE_CHARS,
  GOOGLE_WORKSPACE_MAX_RESULTS,
  GOOGLE_WORKSPACE_MAX_SOURCE_BYTES,
  GOOGLE_WORKSPACE_MAX_TITLE_CHARS,
  GOOGLE_WORKSPACE_MAX_VALUE_CELLS,
  GOOGLE_WORKSPACE_MAX_VALUE_COLUMNS,
  GOOGLE_WORKSPACE_MAX_VALUE_ROWS,
  GOOGLE_WORKSPACE_MAX_VALUES_BYTES,
  GOOGLE_WORKSPACE_READ_TOOLS,
  GOOGLE_WORKSPACE_TOOL_CLASSIFICATION,
  GOOGLE_WORKSPACE_TOOL_NAMES,
  GOOGLE_WORKSPACE_WRITE_TOOLS,
  canonicalGoogleWorkspaceEnvelopeJson,
  canonicalGoogleWorkspaceEnvelopeObject,
  googleWorkspaceOperationFingerprint,
  googleWorkspaceToolClassification,
  parseGoogleWorkspaceOperation,
  sha256Hex,
  type GoogleWorkspaceOperation,
} from './google-workspace-operation.js';

const DIGEST = 'a'.repeat(64);
const GROUP_CALENDAR_ID = ['team#ops', '@', 'group.calendar.google.com'].join(
  '',
);

function envelope(tool: string, args: unknown, requestId?: string): unknown {
  return {
    type: 'google_api',
    ...(requestId === undefined ? {} : { request_id: requestId }),
    tool,
    args,
  };
}

function parseOk(raw: unknown): GoogleWorkspaceOperation {
  const result = parseGoogleWorkspaceOperation(raw);
  if (!result.ok) throw new Error(result.error);
  return result.value;
}

function parseError(raw: unknown): string {
  const result = parseGoogleWorkspaceOperation(raw);
  if (result.ok) throw new Error('operation unexpectedly parsed');
  return result.error;
}

describe('Google Workspace tool classification', () => {
  it('classifies every known tool and keeps destructive tools inside writes', () => {
    expect(Object.keys(GOOGLE_WORKSPACE_TOOL_CLASSIFICATION).sort()).toEqual(
      [...GOOGLE_WORKSPACE_TOOL_NAMES].sort(),
    );
    for (const tool of GOOGLE_WORKSPACE_TOOL_NAMES) {
      expect(googleWorkspaceToolClassification(tool)).toBe(
        GOOGLE_WORKSPACE_TOOL_CLASSIFICATION[tool],
      );
      const classification = GOOGLE_WORKSPACE_TOOL_CLASSIFICATION[tool];
      expect(GOOGLE_WORKSPACE_READ_TOOLS.has(tool)).toBe(
        classification === 'read',
      );
      expect(GOOGLE_WORKSPACE_WRITE_TOOLS.has(tool)).toBe(
        classification !== 'read',
      );
      expect(GOOGLE_WORKSPACE_DESTRUCTIVE_TOOLS.has(tool)).toBe(
        classification === 'destructive',
      );
    }
    for (const tool of GOOGLE_WORKSPACE_DESTRUCTIVE_TOOLS) {
      expect(GOOGLE_WORKSPACE_WRITE_TOOLS.has(tool)).toBe(true);
    }
  });
});

describe('parseGoogleWorkspaceOperation valid envelopes', () => {
  it.each([
    ['google_workspace_status', {}, { verify: false }],
    [
      'google_drive_list_files',
      {},
      {
        type: 'any',
        rootOnly: false,
        maxResults: GOOGLE_WORKSPACE_DEFAULT_MAX_RESULTS,
      },
    ],
    [
      'google_drive_list_files',
      {
        query: 'План',
        contentQuery: 'лошадка',
        type: 'doc',
        folderId: 'folder_123-ABC',
        rootOnly: false,
        maxResults: 100,
      },
      {
        query: 'План',
        contentQuery: 'лошадка',
        type: 'doc',
        folderId: 'folder_123-ABC',
        rootOnly: false,
        maxResults: 100,
      },
    ],
    [
      'google_drive_list_files',
      { rootOnly: true },
      {
        type: 'any',
        rootOnly: true,
        maxResults: GOOGLE_WORKSPACE_DEFAULT_MAX_RESULTS,
      },
    ],
    [
      'gmail_search_threads',
      {},
      { maxResults: GOOGLE_WORKSPACE_DEFAULT_MAX_RESULTS },
    ],
    [
      'gmail_search_threads',
      { query: 'from:ivan@example.com newer_than:30d', maxResults: 10 },
      { query: 'from:ivan@example.com newer_than:30d', maxResults: 10 },
    ],
    [
      'gmail_get_thread',
      { threadId: '18f0abc123def456' },
      { threadId: '18f0abc123def456' },
    ],
    [
      'google_sheets_create',
      { title: 'Отчёт', folderId: 'folder-1' },
      { title: 'Отчёт', folderId: 'folder-1' },
    ],
    [
      'google_docs_create',
      {
        title: 'План',
        contentMarkdown: '# План\n- пункт',
        folderId: 'folder-1',
      },
      {
        title: 'План',
        contentMarkdown: '# План\n- пункт',
        folderId: 'folder-1',
      },
    ],
    [
      'google_docs_read',
      { documentId: 'doc_123-ABC' },
      { documentId: 'doc_123-ABC' },
    ],
    [
      'google_docs_replace_content',
      {
        documentId: 'doc-1',
        contentMarkdown: '',
        expectedRevisionId: 'revision-7',
      },
      {
        documentId: 'doc-1',
        contentMarkdown: '',
        expectedRevisionId: 'revision-7',
      },
    ],
    [
      'google_sheets_get_values',
      { spreadsheetId: 'sheet-1', range: "'Лист 1'!A1:D50" },
      { spreadsheetId: 'sheet-1', range: "'Лист 1'!A1:D50" },
    ],
    [
      'google_sheets_append_values',
      {
        spreadsheetId: 'sheet-1',
        range: 'Лист1!A1:C1000',
        values: [
          ['x', 1, true],
          [null, -0, 'text'],
        ],
        expectedDigest: DIGEST,
      },
      {
        spreadsheetId: 'sheet-1',
        range: 'Лист1!A1:C1000',
        values: [
          ['x', 1, true],
          [null, 0, 'text'],
        ],
        expectedDigest: DIGEST,
      },
    ],
    [
      'google_sheets_update_values',
      {
        spreadsheetId: 'sheet-1',
        range: 'Лист1!A1:C2',
        values: [
          ['x', 1, true],
          [null, -0, '=SUM(A1:B1)'],
        ],
        inputMode: 'user_entered',
        expectedDigest: DIGEST,
      },
      {
        spreadsheetId: 'sheet-1',
        range: 'Лист1!A1:C2',
        values: [
          ['x', 1, true],
          [null, 0, '=SUM(A1:B1)'],
        ],
        inputMode: 'user_entered',
        expectedDigest: DIGEST,
      },
    ],
    [
      'google_apps_script_get_content',
      { scriptId: 'script-1' },
      { scriptId: 'script-1' },
    ],
    [
      'google_apps_script_update_file',
      {
        scriptId: 'script-1',
        fileName: 'Код',
        source: 'function run() {}',
        newFileType: 'SERVER_JS',
        expectedDigest: DIGEST,
      },
      {
        scriptId: 'script-1',
        fileName: 'Код',
        source: 'function run() {}',
        newFileType: 'SERVER_JS',
        expectedDigest: DIGEST,
      },
    ],
    [
      'google_calendar_list_events',
      {
        calendarId: GROUP_CALENDAR_ID,
        timeMin: '2026-07-11T00:00:00+05:00',
        timeMax: '2026-07-12T00:00:00+05:00',
        query: 'встреча',
      },
      {
        calendarId: GROUP_CALENDAR_ID,
        timeMin: '2026-07-11T00:00:00+05:00',
        timeMax: '2026-07-12T00:00:00+05:00',
        query: 'встреча',
        maxResults: GOOGLE_WORKSPACE_DEFAULT_MAX_RESULTS,
      },
    ],
  ] as const)('parses and canonicalizes %s', (tool, args, expectedArgs) => {
    const parsed = parseOk(envelope(tool, args, 'request_123'));
    expect(parsed).toEqual({
      type: 'google_api',
      request_id: 'request_123',
      tool,
      args: expectedArgs,
    });
  });

  it('normalizes explicit empty optional create markdown to absence', () => {
    expect(
      parseOk(
        envelope('google_docs_create', {
          title: 'Blank',
          contentMarkdown: '',
        }),
      ).args,
    ).toEqual({ title: 'Blank' });
  });
});

describe('strict envelope and identifier validation', () => {
  it('rejects non-objects, wrong type, unknown tools, missing args, and unknown fields', () => {
    expect(parseError(null)).toMatch(/expected an object/);
    expect(
      parseError({ type: 'other', tool: 'google_workspace_status', args: {} }),
    ).toMatch(/operation\.type/);
    expect(parseError(envelope('google_unknown', {}))).toMatch(/unknown/);
    expect(
      parseError({ type: 'google_api', tool: 'google_workspace_status' }),
    ).toMatch(/args.*required/);
    expect(
      parseError({
        type: 'google_api',
        tool: 'google_workspace_status',
        args: {},
        owner: true,
      }),
    ).toMatch(/operation\.owner: unknown field/);
    expect(
      parseError(
        envelope('google_workspace_status', { verify: false, token: 'x' }),
      ),
    ).toMatch(/operation\.args\.token: unknown field/);
    expect(
      parseError(envelope('google_workspace_status', new Date('2026-01-01'))),
    ).toMatch(/plain object/);
  });

  it('validates optional request ids without making them mandatory', () => {
    expect(
      parseOk(envelope('google_workspace_status', {})).request_id,
    ).toBeUndefined();
    expect(
      parseError(envelope('google_workspace_status', {}, 'short')),
    ).toMatch(/request_id/);
    expect(
      parseError(
        envelope('google_workspace_status', {}, `req_${'x'.repeat(125)}`),
      ),
    ).toMatch(/request_id/);
    expect(
      parseError(envelope('google_workspace_status', {}, 'request.bad')),
    ).toMatch(/request_id/);
  });

  it('accepts a 256-char resource id and rejects empty, oversized, or path-like ids', () => {
    const maxId = 'a'.repeat(GOOGLE_WORKSPACE_MAX_ID_CHARS);
    expect(
      parseOk(envelope('google_docs_read', { documentId: maxId })).args,
    ).toEqual({ documentId: maxId });
    for (const documentId of [
      '',
      ' doc-1',
      'doc/1',
      '../doc',
      'a'.repeat(GOOGLE_WORKSPACE_MAX_ID_CHARS + 1),
    ]) {
      expect(parseError(envelope('google_docs_read', { documentId }))).toMatch(
        /documentId/,
      );
    }
    expect(
      parseOk(
        envelope('gmail_get_thread', {
          threadId: '18f0abc123def456',
        }),
      ).args,
    ).toEqual({ threadId: '18f0abc123def456' });
    expect(
      parseError(envelope('gmail_get_thread', { threadId: '../thread' })),
    ).toMatch(/threadId/);
  });

  it('rejects unsafe calendar ids while allowing email and group-calendar ids', () => {
    for (const id of ['owner@example.com', GROUP_CALENDAR_ID]) {
      expect(
        parseOk(
          envelope('google_calendar_list_events', {
            calendarId: id,
            timeMin: '2026-07-11T00:00:00Z',
            timeMax: '2026-07-12T00:00:00Z',
          }),
        ).args,
      ).toMatchObject({ calendarId: id });
    }
    expect(
      parseError(
        envelope('google_calendar_list_events', {
          calendarId: '../../calendar',
          timeMin: '2026-07-11T00:00:00Z',
          timeMax: '2026-07-12T00:00:00Z',
        }),
      ),
    ).toMatch(/calendarId/);
  });

  it('keeps My Drive root scope distinct from folder scope', () => {
    expect(
      parseError(
        envelope('google_drive_list_files', {
          rootOnly: true,
          folderId: 'folder-1',
        }),
      ),
    ).toMatch(/rootOnly and folderId/);
    expect(
      parseError(envelope('google_drive_list_files', { rootOnly: 'yes' })),
    ).toMatch(/rootOnly/);
  });
});

describe('text, content, result-count, and time caps', () => {
  it('enforces query, range, and title character limits', () => {
    expect(
      parseOk(
        envelope('google_drive_list_files', {
          query: 'q'.repeat(GOOGLE_WORKSPACE_MAX_QUERY_CHARS),
        }),
      ).args,
    ).toMatchObject({ query: 'q'.repeat(GOOGLE_WORKSPACE_MAX_QUERY_CHARS) });
    expect(
      parseError(
        envelope('google_drive_list_files', {
          query: 'q'.repeat(GOOGLE_WORKSPACE_MAX_QUERY_CHARS + 1),
        }),
      ),
    ).toMatch(/query/);

    expect(
      parseOk(
        envelope('google_sheets_get_values', {
          spreadsheetId: 'sheet-1',
          range: 'R'.repeat(GOOGLE_WORKSPACE_MAX_RANGE_CHARS),
        }),
      ).args,
    ).toMatchObject({ range: 'R'.repeat(GOOGLE_WORKSPACE_MAX_RANGE_CHARS) });
    expect(
      parseError(
        envelope('google_sheets_get_values', {
          spreadsheetId: 'sheet-1',
          range: 'R'.repeat(GOOGLE_WORKSPACE_MAX_RANGE_CHARS + 1),
        }),
      ),
    ).toMatch(/range/);

    expect(
      parseOk(
        envelope('google_sheets_create', {
          title: 'T'.repeat(GOOGLE_WORKSPACE_MAX_TITLE_CHARS),
        }),
      ).args,
    ).toMatchObject({ title: 'T'.repeat(GOOGLE_WORKSPACE_MAX_TITLE_CHARS) });
    expect(
      parseError(
        envelope('google_sheets_create', {
          title: 'T'.repeat(GOOGLE_WORKSPACE_MAX_TITLE_CHARS + 1),
        }),
      ),
    ).toMatch(/title/);
  });

  it('measures Markdown and source caps in UTF-8 bytes', () => {
    const exactMarkdown = 'é'.repeat(GOOGLE_WORKSPACE_MAX_MARKDOWN_BYTES / 2);
    expect(
      parseOk(
        envelope('google_docs_create', {
          title: 'Boundary',
          contentMarkdown: exactMarkdown,
        }),
      ).args,
    ).toMatchObject({ contentMarkdown: exactMarkdown });
    expect(
      parseError(
        envelope('google_docs_create', {
          title: 'Too large',
          contentMarkdown: `${exactMarkdown}é`,
        }),
      ),
    ).toMatch(/UTF-8 bytes/);

    const exactSource = 'x'.repeat(GOOGLE_WORKSPACE_MAX_SOURCE_BYTES);
    expect(
      parseOk(
        envelope('google_apps_script_update_file', {
          scriptId: 'script-1',
          fileName: 'Code',
          source: exactSource,
          expectedDigest: DIGEST,
        }),
      ).args,
    ).toMatchObject({ source: exactSource });
    expect(
      parseError(
        envelope('google_apps_script_update_file', {
          scriptId: 'script-1',
          fileName: 'Code',
          source: `${exactSource}x`,
          expectedDigest: DIGEST,
        }),
      ),
    ).toMatch(/UTF-8 bytes/);
  });

  it('bounds maxResults to integers from 1 through 100', () => {
    for (const maxResults of [1, GOOGLE_WORKSPACE_MAX_RESULTS]) {
      expect(
        parseOk(envelope('google_drive_list_files', { maxResults })).args,
      ).toMatchObject({ maxResults });
      expect(
        parseOk(envelope('gmail_search_threads', { maxResults })).args,
      ).toMatchObject({ maxResults });
    }
    for (const maxResults of [0, 1.5, GOOGLE_WORKSPACE_MAX_RESULTS + 1]) {
      expect(
        parseError(envelope('google_drive_list_files', { maxResults })),
      ).toMatch(/maxResults/);
      expect(
        parseError(envelope('gmail_search_threads', { maxResults })),
      ).toMatch(/maxResults/);
    }
  });

  it('requires bounded RFC3339 calendar windows in chronological order', () => {
    for (const [timeMin, timeMax] of [
      ['2026-07-11', '2026-07-12T00:00:00Z'],
      ['2026-07-11T00:00:00', '2026-07-12T00:00:00Z'],
      ['2026-02-31T00:00:00Z', '2026-03-12T00:00:00Z'],
      ['2026-07-11T24:00:00Z', '2026-07-12T01:00:00Z'],
      ['not-a-date', '2026-07-12T00:00:00Z'],
      ['2026-07-12T00:00:00Z', '2026-07-11T00:00:00Z'],
      ['2026-07-11T00:00:00Z', '2026-07-11T00:00:00Z'],
    ]) {
      expect(
        parseError(
          envelope('google_calendar_list_events', {
            calendarId: 'owner@example.com',
            timeMin,
            timeMax,
          }),
        ),
      ).toMatch(/timeMin|timeMax/);
    }
  });
});

describe('optimistic write guards', () => {
  it('requires revision or digest for Docs replacement', () => {
    const base = { documentId: 'doc-1', contentMarkdown: 'new' };
    expect(parseError(envelope('google_docs_replace_content', base))).toMatch(
      /expectedRevisionId or expectedDigest is required/,
    );
    expect(
      parseOk(
        envelope('google_docs_replace_content', {
          ...base,
          expectedDigest: DIGEST,
        }),
      ).args,
    ).toMatchObject({ expectedDigest: DIGEST });
    expect(
      parseOk(
        envelope('google_docs_replace_content', {
          ...base,
          expectedRevisionId: 'revision-1',
          expectedDigest: DIGEST,
        }),
      ).args,
    ).toMatchObject({
      expectedRevisionId: 'revision-1',
      expectedDigest: DIGEST,
    });
  });

  it('requires a lowercase SHA-256 digest for Sheets writes and Apps Script updates', () => {
    const sheetBase = {
      spreadsheetId: 'sheet-1',
      range: 'A1',
      values: [['x']],
      inputMode: 'raw',
    };
    expect(
      parseError(envelope('google_sheets_update_values', sheetBase)),
    ).toMatch(/expectedDigest/);
    expect(
      parseError(
        envelope('google_sheets_update_values', {
          ...sheetBase,
          expectedDigest: DIGEST.toUpperCase(),
        }),
      ),
    ).toMatch(/SHA-256/);
    expect(
      parseError(
        envelope('google_sheets_append_values', {
          spreadsheetId: sheetBase.spreadsheetId,
          range: sheetBase.range,
          values: sheetBase.values,
        }),
      ),
    ).toMatch(/expectedDigest/);

    const scriptBase = {
      scriptId: 'script-1',
      fileName: 'Code',
      source: '',
    };
    expect(
      parseError(envelope('google_apps_script_update_file', scriptBase)),
    ).toMatch(/expectedDigest/);
    expect(
      parseError(
        envelope('google_apps_script_update_file', {
          ...scriptBase,
          expectedDigest: '0'.repeat(63),
        }),
      ),
    ).toMatch(/SHA-256/);
  });

  it('requires an explicit Sheets input mode', () => {
    const base = {
      spreadsheetId: 'sheet-1',
      range: 'A1',
      values: [['x']],
      expectedDigest: DIGEST,
    };
    expect(parseError(envelope('google_sheets_update_values', base))).toMatch(
      /inputMode/,
    );
    expect(
      parseError(
        envelope('google_sheets_update_values', {
          ...base,
          inputMode: 'USER_ENTERED',
        }),
      ),
    ).toMatch(/inputMode/);
    for (const inputMode of ['raw', 'user_entered']) {
      expect(
        parseOk(
          envelope('google_sheets_update_values', {
            ...base,
            inputMode,
          }),
        ).args,
      ).toMatchObject({ inputMode });
    }
    expect(
      parseError(
        envelope('google_sheets_append_values', {
          ...base,
          inputMode: 'raw',
        }),
      ),
    ).toMatch(/unknown field/);
    expect(
      parseOk(envelope('google_sheets_append_values', base)).args,
    ).not.toHaveProperty('inputMode');
  });
});

describe('Sheets value matrix limits', () => {
  function update(values: unknown): unknown {
    return envelope('google_sheets_update_values', {
      spreadsheetId: 'sheet-1',
      range: 'A1',
      values,
      inputMode: 'raw',
      expectedDigest: DIGEST,
    });
  }

  it('accepts exactly 10k cells and clones the input matrix', () => {
    const values = Array.from(
      { length: GOOGLE_WORKSPACE_MAX_VALUE_CELLS / 100 },
      () => Array.from({ length: 100 }, () => 'x'),
    );
    const parsed = parseOk(update(values));
    expect((parsed.args as { values: unknown[][] }).values.flat()).toHaveLength(
      GOOGLE_WORKSPACE_MAX_VALUE_CELLS,
    );
    values[0][0] = 'mutated-after-parse';
    expect((parsed.args as { values: unknown[][] }).values[0][0]).toBe('x');
  });

  it('rejects empty matrices/rows and row, column, and total-cell overflow', () => {
    expect(parseError(update([]))).toMatch(/non-empty array of rows/);
    expect(parseError(update([[]]))).toMatch(/non-empty array of cells/);
    expect(
      parseError(
        update(
          Array.from({ length: GOOGLE_WORKSPACE_MAX_VALUE_ROWS + 1 }, () => [
            'x',
          ]),
        ),
      ),
    ).toMatch(/rows/);
    expect(
      parseError(
        update([
          Array.from(
            { length: GOOGLE_WORKSPACE_MAX_VALUE_COLUMNS + 1 },
            () => 'x',
          ),
        ]),
      ),
    ).toMatch(/columns/);
    expect(
      parseError(
        update(
          Array.from({ length: 101 }, () =>
            Array.from({ length: 100 }, () => 'x'),
          ),
        ),
      ),
    ).toMatch(/cells/);
  });

  it('rejects invalid cells and overlong strings', () => {
    for (const cell of [NaN, Infinity, -Infinity, undefined, {}, []]) {
      expect(parseError(update([[cell]]))).toMatch(/values\[0\]\[0\]/);
    }
    expect(
      parseOk(update([['x'.repeat(GOOGLE_WORKSPACE_MAX_CELL_STRING_CHARS)]]))
        .tool,
    ).toBe('google_sheets_update_values');
    expect(
      parseError(
        update([['x'.repeat(GOOGLE_WORKSPACE_MAX_CELL_STRING_CHARS + 1)]]),
      ),
    ).toMatch(/string must be at most/);
  });

  it('enforces the aggregate canonical JSON byte cap', () => {
    const values = Array.from({ length: 33 }, () => [
      'x'.repeat(GOOGLE_WORKSPACE_MAX_CELL_STRING_CHARS),
    ]);
    expect(Buffer.byteLength(JSON.stringify(values), 'utf8')).toBeGreaterThan(
      GOOGLE_WORKSPACE_MAX_VALUES_BYTES,
    );
    expect(parseError(update(values))).toMatch(/canonical values/);
  });
});

describe('canonicalization and fingerprints', () => {
  it('is independent from input key order and includes request_id in envelope JSON', () => {
    const first = parseOk({
      args: { maxResults: 25, type: 'doc', query: 'plan' },
      tool: 'google_drive_list_files',
      request_id: 'request_first',
      type: 'google_api',
    });
    const second = parseOk({
      type: 'google_api',
      request_id: 'request_first',
      tool: 'google_drive_list_files',
      args: { query: 'plan', type: 'doc', maxResults: 25 },
    });
    expect(canonicalGoogleWorkspaceEnvelopeObject(first)).toEqual(second);
    expect(canonicalGoogleWorkspaceEnvelopeJson(first)).toBe(
      canonicalGoogleWorkspaceEnvelopeJson(second),
    );
    expect(canonicalGoogleWorkspaceEnvelopeJson(first)).toContain(
      '"request_id":"request_first"',
    );
  });

  it('excludes request_id from the operation fingerprint but binds tool/resource/payload', () => {
    const one = parseOk(
      envelope(
        'google_sheets_get_values',
        { spreadsheetId: 'sheet-1', range: 'A1:B2' },
        'request_one',
      ),
    );
    const sameOperation = parseOk(
      envelope(
        'google_sheets_get_values',
        { spreadsheetId: 'sheet-1', range: 'A1:B2' },
        'request_two',
      ),
    );
    const otherResource = parseOk(
      envelope(
        'google_sheets_get_values',
        { spreadsheetId: 'sheet-2', range: 'A1:B2' },
        'request_one',
      ),
    );
    const otherRange = parseOk(
      envelope(
        'google_sheets_get_values',
        { spreadsheetId: 'sheet-1', range: 'C1:D2' },
        'request_one',
      ),
    );
    expect(googleWorkspaceOperationFingerprint(one)).toBe(
      googleWorkspaceOperationFingerprint(sameOperation),
    );
    expect(googleWorkspaceOperationFingerprint(one)).not.toBe(
      googleWorkspaceOperationFingerprint(otherResource),
    );
    expect(googleWorkspaceOperationFingerprint(one)).not.toBe(
      googleWorkspaceOperationFingerprint(otherRange),
    );
    expect(googleWorkspaceOperationFingerprint(one)).toMatch(/^[a-f0-9]{64}$/);
  });

  it('provides a standard lowercase SHA-256 helper', () => {
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    expect(sha256Hex(Buffer.from('abc'))).toBe(sha256Hex('abc'));
  });

  it('revalidates typed-looking objects passed to canonical helpers', () => {
    expect(() =>
      canonicalGoogleWorkspaceEnvelopeObject({
        type: 'google_api',
        tool: 'google_docs_read',
        args: { documentId: '../escape' },
      } as GoogleWorkspaceOperation),
    ).toThrow(/documentId/);
  });
});
