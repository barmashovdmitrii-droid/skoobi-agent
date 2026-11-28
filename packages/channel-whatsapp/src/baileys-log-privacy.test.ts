import { createRequire } from 'module';

import { describe, expect, it, vi } from 'vitest';

import {
  createBaileysPrivateConsoleMethod,
  isBaileysPrivateConsoleStack,
  isBaileysStreamErrorLogCall,
  summarizeBaileysDisconnect,
  summarizeBaileysLogCall,
} from './baileys-log-privacy.js';

describe('Baileys direct-console privacy guard', () => {
  it('recognizes Baileys and libsignal caller paths across path styles', () => {
    expect(
      isBaileysPrivateConsoleStack(
        'at SessionRecord.closeSession (/app/node_modules/libsignal/src/session_record.js:273:17)',
      ),
    ).toBe(true);
    expect(
      isBaileysPrivateConsoleStack(
        'at receive (C:\\app\\node_modules\\@whiskeysockets\\baileys\\lib\\Socket\\messages-recv.js:1:1)',
      ),
    ).toBe(true);
    expect(
      isBaileysPrivateConsoleStack(
        'at application (/app/packages/channel-whatsapp/src/whatsapp.ts:1:1)',
      ),
    ).toBe(false);
    expect(
      isBaileysPrivateConsoleStack(
        [
          'Error',
          'at guarded (/app/packages/channel-whatsapp/src/baileys-log-privacy.ts:1:1)',
          'at authCallback (/app/packages/channel-whatsapp/src/whatsapp-auth.ts:1:1)',
          'at emit (/app/node_modules/@whiskeysockets/baileys/lib/Utils/event-buffer.js:1:1)',
        ].join('\n'),
      ),
    ).toBe(false);
  });

  it('suppresses the real libsignal SessionEntry/base-key console payload', () => {
    const sink = vi.fn();
    const originalInfo = console.info;
    console.info = createBaileysPrivateConsoleMethod(sink);
    try {
      const require = createRequire(import.meta.url);
      const SessionRecord = require('libsignal/src/session_record.js') as {
        new (): {
          closeSession(session: unknown): void;
        };
        createEntry(): {
          indexInfo: {
            baseKey: Buffer;
            closed: number;
          };
        };
      };
      const record = new SessionRecord();
      const session = SessionRecord.createEntry();
      session.indexInfo = {
        baseKey: Buffer.from('PRIVATE_BASE_KEY_BYTES'),
        closed: -1,
      };

      record.closeSession(session);

      expect(sink).not.toHaveBeenCalled();
    } finally {
      console.info = originalInfo;
    }
  });

  it('does not suppress an ordinary application console call', () => {
    const sink = vi.fn();
    const guarded = createBaileysPrivateConsoleMethod(
      sink,
      () =>
        'at application (/app/packages/channel-whatsapp/src/whatsapp.ts:1:1)',
    );

    guarded('ordinary application status');

    expect(sink).toHaveBeenCalledWith('ordinary application status');
  });
});

describe('summarizeBaileysLogCall', () => {
  it('keeps the message text and the error name and code, never the objects', () => {
    // J03: a stream error passes only its reason tag and short code, never
    // the nodes themselves (see the dedicated test below).
    expect(
      summarizeBaileysLogCall([
        { reasonNode: { attrs: { code: '515' } }, fullErrorNode: { tag: 'stream:error' } },
        'stream errored out',
      ]),
    ).toEqual({ baileysMessage: 'stream errored out', streamErrorCode: 515 });
    // Phone numbers and LIDs interpolated without a JID suffix are masked;
    // full JIDs become the stable peer label of redactString.
    const masked = summarizeBaileysLogCall([
      'Invalid LID-PN mapping: 123456789012345, 15551234567 for 15551234567@s.whatsapp.net',
    ]);
    expect(masked.baileysMessage).not.toMatch(/\d{6,}/);
    expect(masked.baileysMessage).toContain('Invalid LID-PN mapping: <n>, <n> for <whatsapp-peer:');
    // A Boom-style error: name and output.statusCode; its message never.
    const boom = Object.assign(new Error('Connection Closed by 15551234567'), {
      output: { statusCode: 428 },
    });
    expect(summarizeBaileysLogCall([{ err: boom }, 'error in socket end handler'])).toEqual({
      baileysMessage: 'error in socket end handler',
      errorName: 'Error',
      statusCode: 428,
    });
    expect(summarizeBaileysLogCall([{ error: new RangeError('x') }])).toEqual({
      errorName: 'RangeError',
    });
    expect(summarizeBaileysLogCall([{ e: 'not an error', statusCode: 'no' }])).toEqual({});
    expect(summarizeBaileysLogCall([])).toEqual({});
    expect(summarizeBaileysLogCall(['x'.repeat(500)]).baileysMessage).toHaveLength(160);
  });
});

// J03 (r1111): every 50 minutes WhatsApp closes the stream with reason 500 —
// the Baileys default when the stream:error node carries no known code. The
// node was dropped whole, so the actual reason never reached the log. Only
// the reason tag, a letters-only type and a short numeric code may pass.
describe('Baileys stream error reason', () => {
  const peer = '1555' + '0000001';

  it('passes the reason tag and code of a stream error, never the nodes', () => {
    const reasonNode = {
      tag: 'xml-not-well-formed',
      attrs: { jid: `${peer}@s.whatsapp.net` },
      content: [{ tag: 'item', attrs: { id: peer } }],
    };
    const fullErrorNode = {
      tag: 'stream:error',
      attrs: { code: '503', from: `${peer}@s.whatsapp.net` },
      content: [reasonNode],
    };
    const summary = summarizeBaileysLogCall([
      { reasonNode, fullErrorNode },
      'stream errored out',
    ]);
    expect(summary).toEqual({
      baileysMessage: 'stream errored out',
      streamErrorTag: 'xml-not-well-formed',
      streamErrorCode: 503,
    });
    expect(JSON.stringify(summary)).not.toContain(peer);
  });

  it('passes a letters-only conflict type', () => {
    expect(
      summarizeBaileysLogCall([
        {
          reasonNode: { tag: 'conflict', attrs: { type: 'replaced' } },
          fullErrorNode: { tag: 'stream:error', attrs: {} },
        },
        'stream errored out',
      ]),
    ).toEqual({
      baileysMessage: 'stream errored out',
      streamErrorTag: 'conflict',
      streamErrorType: 'replaced',
    });
  });

  it('drops tag, type and code values that could carry a number or id', () => {
    const summary = summarizeBaileysLogCall([
      {
        reasonNode: {
          tag: `${peer}@s.whatsapp.net`,
          attrs: { type: `device_${peer}`, code: peer },
        },
        fullErrorNode: { tag: 'stream:error', attrs: { code: '12345' } },
      },
      'stream errored out',
    ]);
    expect(summary).toEqual({ baileysMessage: 'stream errored out' });
    expect(
      summarizeBaileysLogCall([
        { reasonNode: { tag: 'a'.repeat(80) }, fullErrorNode: 'not a node' },
        'stream errored out',
      ]),
    ).toEqual({ baileysMessage: 'stream errored out' });
  });

  it('recognizes the Baileys stream error call', () => {
    expect(
      isBaileysStreamErrorLogCall([
        { reasonNode: undefined, fullErrorNode: { tag: 'stream:error' } },
        'stream errored out',
      ]),
    ).toBe(true);
    expect(isBaileysStreamErrorLogCall(['stream errored out'])).toBe(true);
    expect(
      isBaileysStreamErrorLogCall([{ err: new Error('x') }, 'error in validating connection']),
    ).toBe(false);
    expect(isBaileysStreamErrorLogCall([])).toBe(false);
  });

  it('reads the reason tag of the disconnect error, never its data', () => {
    // Boom built by Baileys: data is the reason node (or the whole node).
    const streamBoom = Object.assign(new Error('Stream Errored (conflict)'), {
      output: { statusCode: 500 },
      data: {
        tag: 'conflict',
        attrs: { type: 'replaced', jid: `${peer}@s.whatsapp.net` },
      },
    });
    expect(summarizeBaileysDisconnect(streamBoom)).toEqual({
      streamErrorTag: 'conflict',
      streamErrorType: 'replaced',
    });
    // CB:failure: data is node.attrs — no tag, nothing to report.
    expect(
      summarizeBaileysDisconnect(
        Object.assign(new Error('Connection Failure'), {
          output: { statusCode: 401 },
          data: { reason: '401', location: `${peer}` },
        }),
      ),
    ).toEqual({});
    expect(
      summarizeBaileysDisconnect({
        output: { statusCode: 500 },
        data: { tag: `${peer}@lid`, attrs: {} },
      }),
    ).toEqual({});
    expect(summarizeBaileysDisconnect(undefined)).toEqual({});
    expect(summarizeBaileysDisconnect(new Error('Connection Closed'))).toEqual({});
  });
});
