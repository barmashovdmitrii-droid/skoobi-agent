import { createRequire } from 'module';

import { describe, expect, it, vi } from 'vitest';

import {
  createBaileysPrivateConsoleMethod,
  isBaileysPrivateConsoleStack,
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
