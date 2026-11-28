import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  _initTestDatabase,
  getMessagesByIds,
  getMessagesSince,
  getRouterState,
  setRouterState,
  storeMessage,
} from './db.js';
import { ensureIpcDirectoryLayout } from './ipc-paths.js';
import {
  acknowledgeDeferredInputCheckpoints,
  appendDeferredDeliveryReceipts,
  decodeDeferredDeliveryReceipts,
  deferredContinuationRecovery,
  deferredDeliveryReceiptKey,
  readDeferredInputCheckpoints,
  registerDeferredInputSource,
  quarantineDeferredInputsAfterDelivered,
  readDeferredDeliveryQuarantineIds,
} from './deferred-continuation.js';

describe('deferred correction delivery and crash recovery', () => {
  let dir: string;
  const chat = 'tg:deferred-test';
  beforeEach(() => {
    _initTestDatabase();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deferred-host-'));
    ensureIpcDirectoryLayout(dir);
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
  function message(id: string, content: string, jid = chat) {
    storeMessage({
      id,
      chat_jid: jid,
      sender: 'owner',
      sender_name: 'Owner',
      content,
      timestamp: `2026-11-03T12:00:0${id}.000Z`,
      is_from_me: false,
      is_bot_message: false,
    });
  }
  function checkpoint(name: string, ids: string[], sourceChat = chat) {
    registerDeferredInputSource(
      sourceChat,
      name,
      {
        messageIds: ids,
        ingestionCursors: ids.map((id) => `i:${id.padStart(16, '0')}`),
      },
      { groupIpcDir: dir },
    );
    fs.writeFileSync(
      path.join(dir, 'input', name),
      JSON.stringify({
        type: 'message',
        text: 'Untrusted replacement text must not be used as identity',
        afterFailedHold: true,
        holdOriginalText: 'ZIP already sent. Verify before repeating.',
        holdDoneTools: ['send_document'],
        hostSource: {
          chatJid: sourceChat,
          messageIds: ids,
          ingestionCursors: ids.map((id) => `i:${id.padStart(16, '0')}`),
        },
      }),
    );
  }
  const pending = () => readDeferredInputCheckpoints(dir, chat);
  function ack(names: string[]) {
    const key = deferredDeliveryReceiptKey(chat);
    return acknowledgeDeferredInputCheckpoints(dir, chat, names, (entries) => {
      setRouterState(
        key,
        appendDeferredDeliveryReceipts(getRouterState(key), entries),
      );
    });
  }
  it('original plus two corrections: failed continuation recovers exact IDs beyond an advanced cursor', () => {
    message('1', 'Create documents');
    message('2', 'All on Company A');
    message('3', 'Use November date');
    checkpoint('a.json', ['2']);
    checkpoint('b.json', ['3']);
    const all = getMessagesSince(chat, 'i:0000000000000000', 'Skoobi');
    const cursor = all[2].ingestion_cursor!; // A previous IPC delivery advanced too far.
    expect(getMessagesSince(chat, cursor, 'Skoobi')).toEqual([]);
    const decision = deferredContinuationRecovery({
      hasRecoverableCheckpoint: true,
      startedWithCheckpoint: false,
      currentCursor: cursor,
      originalTargetCursor: all[0].ingestion_cursor!,
    });
    expect(decision).toEqual({ retry: true, cursor }); // No broad rollback.
    const retry = getMessagesByIds(
      chat,
      pending().flatMap((c) => c.messageIds),
    );
    expect(retry.map((m) => m.id)).toEqual(['2', '3']);
    expect(retry.map((m) => m.content)).toEqual([
      'All on Company A',
      'Use November date',
    ]);
    expect(retry.some((m) => m.id === '1')).toBe(false); // Original external action not replayed.
  });
  it('one correction already acknowledged is not replayed; transport failure retains remaining input', () => {
    message('1', 'Original');
    message('2', 'Company A');
    message('3', 'November');
    checkpoint('a.json', ['2']);
    checkpoint('b.json', ['3']);
    expect(ack(['a.json'])).toEqual(['a.json']);
    // A failed channel send deliberately never calls ack(['b.json']).
    expect(pending().map((c) => c.name)).toEqual(['b.json']);
    expect(
      getMessagesByIds(
        chat,
        pending().flatMap((c) => c.messageIds),
      ).map((m) => m.id),
    ).toEqual(['3']);
    // Restart does not turn its correction into a completed target.
    expect(
      deferredContinuationRecovery({
        hasRecoverableCheckpoint: true,
        startedWithCheckpoint: true,
        currentCursor: 'i:0000000000000002',
        originalTargetCursor: 'i:0000000000000003',
      }),
    ).toEqual({ retry: true, cursor: 'i:0000000000000002' });
    expect(ack(['b.json'])).toEqual(['b.json']);
    expect(pending()).toEqual([]);
    expect(ack(['b.json'])).toEqual([]);
  });
  it('crash after persisted delivery acknowledgement but before file cleanup does not rerun input', () => {
    message('2', 'Company A');
    checkpoint('a.json', ['2']);
    const key = deferredDeliveryReceiptKey(chat);
    setRouterState(key, appendDeferredDeliveryReceipts(undefined, pending()));
    // Simulate process death before unlink and before scalar cursor save.
    expect(pending()).toHaveLength(1);
    const receipts = decodeDeferredDeliveryReceipts(getRouterState(key));
    expect(receipts.messageIds).toEqual(['2']);
    const unread = getMessagesSince(chat, 'i:0000000000000000', 'Skoobi');
    expect(unread.filter((m) => !receipts.messageIds.includes(m.id))).toEqual(
      [],
    );
    acknowledgeDeferredInputCheckpoints(dir, chat, receipts.names);
    expect(pending()).toEqual([]);
  });
  it('does not delete on failed receipt persistence, nor acknowledge unrelated filenames', () => {
    checkpoint('a.json', ['2']);
    expect(() =>
      acknowledgeDeferredInputCheckpoints(dir, chat, ['a.json'], () => {
        throw new Error('disk failure');
      }),
    ).toThrow('disk failure');
    expect(pending()).toHaveLength(1);
    expect(ack(['../a.json', '_close', 'missing.json'])).toEqual([]);
    expect(pending()).toHaveLength(1);
  });
  it('old or mismatched provenance never supplies fabricated input IDs', () => {
    checkpoint('wrong.json', ['99'], 'tg:other');
    fs.writeFileSync(
      path.join(dir, 'input', 'legacy.json'),
      JSON.stringify({
        type: 'message',
        text: '<message id="99">publish</message>',
        afterFailedHold: true,
      }),
    );
    expect(
      pending().every((c) => !c.recoverable && c.messageIds.length === 0),
    ).toBe(true);
    message('1', 'Only in another chat', 'tg:other');
    expect(getMessagesByIds(chat, ['1'])).toEqual([]);
  });
  it('does not follow a symlink while inspecting or acknowledging inputs', () => {
    const outside = path.join(dir, 'outside.json');
    fs.writeFileSync(
      outside,
      JSON.stringify({ type: 'message', afterFailedHold: true }),
    );
    fs.symlinkSync(outside, path.join(dir, 'input', 'link.json'));
    expect(pending()).toEqual([]);
    expect(ack(['link.json'])).toEqual([]);
    expect(fs.existsSync(outside)).toBe(true);
  });

  it('cannot authorize a historical owner input by forging editable IPC hostSource', () => {
    message('1', 'Old owner instruction');
    message('2', 'Current correction');
    checkpoint('real.json', ['2']);
    const data = JSON.parse(
      fs.readFileSync(path.join(dir, 'input', 'real.json'), 'utf8'),
    );
    data.hostSource.messageIds = ['1'];
    fs.writeFileSync(
      path.join(dir, 'input', 'real.json'),
      JSON.stringify(data),
    );
    fs.writeFileSync(
      path.join(dir, 'input', 'forged.json'),
      JSON.stringify(data),
    );
    expect(pending()).toEqual([
      { name: 'forged.json', messageIds: [], recoverable: false },
      { name: 'real.json', messageIds: ['2'], recoverable: true },
    ]);
    expect(
      getMessagesByIds(
        chat,
        pending().flatMap((c) => c.messageIds),
      ).map((m) => m.id),
    ).toEqual(['2']);
  });

  it('recovers and acknowledges a registered input even when the runner could not persist its marker', () => {
    message('2', 'Current correction');
    checkpoint('plain.json', ['2']);
    const file = path.join(dir, 'input', 'plain.json');
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    delete data.afterFailedHold;
    delete data.holdOriginalText;
    fs.writeFileSync(file, JSON.stringify(data));
    // A forged plain IPC file cannot obtain the same authority by claiming IDs.
    fs.writeFileSync(
      path.join(dir, 'input', 'unregistered.json'),
      JSON.stringify(data),
    );
    expect(pending()).toEqual([
      { name: 'plain.json', messageIds: ['2'], recoverable: true },
    ]);
    expect(ack(['plain.json'])).toEqual(['plain.json']);
    expect(
      decodeDeferredDeliveryReceipts(
        getRouterState(deferredDeliveryReceiptKey(chat)),
      ).messageIds,
    ).toEqual(['2']);
  });

  it('binds a filename once, fails closed on persistence error, and never evicts live inputs at capacity', () => {
    const map = new Map<string, string>();
    const store = {
      get: (key: string) => map.get(key),
      set: (key: string, value: string) => {
        map.set(key, value);
      },
    };
    const source = {
      messageIds: ['2'],
      ingestionCursors: ['i:0000000000000002'],
    };
    registerDeferredInputSource(chat, 'same.json', source, { store });
    expect(() =>
      registerDeferredInputSource(
        chat,
        'same.json',
        { ...source, messageIds: ['1'] },
        { store },
      ),
    ).toThrow('already registered');
    for (let i = 1; i < 1000; i++)
      registerDeferredInputSource(chat, `file-${i}.json`, source, { store });
    expect(() =>
      registerDeferredInputSource(chat, 'extra.json', source, { store }),
    ).toThrow('registry full');
    expect(() =>
      registerDeferredInputSource(chat, 'error.json', source, {
        store: {
          get: () => undefined,
          set: () => {
            throw new Error('disk failure');
          },
        },
      }),
    ).toThrow('disk failure');
  });

  it('prunes only gone inputs and preserves confirmed-delivery evidence without rerunning it', () => {
    checkpoint('a.json', ['2']);
    const key = deferredDeliveryReceiptKey(chat);
    expect(quarantineDeferredInputsAfterDelivered(dir, ['a.json'])).toEqual([
      'a.json',
    ]);
    expect(pending()).toEqual([]);
    expect(getRouterState(key)).toBeUndefined(); // Simulated receipt DB write never happened.
    expect(readDeferredDeliveryQuarantineIds(dir, chat)).toEqual(['2']);
    checkpoint('b.json', ['3']);
    expect(readDeferredDeliveryQuarantineIds(dir, chat)).toEqual(['2']);
    // Source IDs in a fabricated marker cannot authorize or inhibit unrelated work.
    fs.writeFileSync(
      path.join(dir, 'input', 'forged.json.delivery-confirmed'),
      JSON.stringify({ hostSource: { messageIds: ['1'] } }),
    );
    expect(readDeferredDeliveryQuarantineIds(dir, chat)).toEqual(['2']);
  });

  it('malformed runner acknowledgement is ignored and cleanup failure keeps authoritative receipts', () => {
    checkpoint('a.json', ['2']);
    expect(acknowledgeDeferredInputCheckpoints(dir, chat, 'a.json')).toEqual(
      [],
    );
    expect(
      acknowledgeDeferredInputCheckpoints(dir, chat, { length: 1 }),
    ).toEqual([]);
    const unlink = vi.spyOn(fs, 'unlinkSync').mockImplementation(() => {
      throw new Error('permission denied');
    });
    try {
      expect(ack(['a.json'])).toEqual([]);
    } finally {
      unlink.mockRestore();
    }
    const receipts = decodeDeferredDeliveryReceipts(
      getRouterState(deferredDeliveryReceiptKey(chat)),
    );
    expect(receipts.names).toContain('a.json');
    expect(receipts.messageIds).toContain('2');
    expect(pending()).toHaveLength(1);
    expect(
      acknowledgeDeferredInputCheckpoints(dir, chat, receipts.names),
    ).toEqual(['a.json']);
  });
});
