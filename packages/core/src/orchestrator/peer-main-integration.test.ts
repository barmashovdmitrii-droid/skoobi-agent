import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  attachPeerInboxToMessageLoop,
  outboundEnvelopeAdvancesChatCursor,
} from './message-loop.js';
import { createMessageRouter } from './outbound-router.js';
import { GroupQueue } from './group-queue.js';
import { DATA_DIR } from './config.js';
import { ensureMemoryStateSchema } from './memory-state-store.js';
import { currentPeerScopeRevisionHash } from './peer-context.js';
import {
  writePeerInboxEvent,
  peerInboxPromptContext,
  type PeerBridgeConfig,
  type PeerInboxEvent,
} from './peer-inbox.js';
import type { Channel, RegisteredGroup } from './types.js';
import type { ChildProcess } from 'node:child_process';

describe('peer integration with actual main queue and channel router', () => {
  let root: string,
    db: Database.Database,
    config: PeerBridgeConfig,
    queue: GroupQueue,
    finish: (value: boolean) => void;
  const folder = 'peer_fixture_main';
  beforeEach(() => {
    root = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'peer-main-')),
    );
    fs.chmodSync(root, 0o700);
    fs.writeFileSync(path.join(root, 'key'), Buffer.alloc(32, 2), {
      mode: 0o600,
    });
    config = {
      schema: 1,
      root,
      projectRoot: root,
      ownerGroupFolder: folder,
      ownerJid: 'tg:fixture',
      identityId: 'fixture-user',
      tenantId: 'fixture-tenant',
      networkId: 'fixture-network',
      signingKeyPath: path.join(root, 'key'),
    };
    db = new Database(':memory:');
    ensureMemoryStateSchema(db);
    queue = new GroupQueue();
    finish = () => {};
  });
  afterEach(async () => {
    finish(true);
    await queue.shutdown();
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(path.join(DATA_DIR, 'ipc', folder), {
      recursive: true,
      force: true,
    });
  });
  const result = (): PeerInboxEvent => ({
    schema: 1,
    eventId: 'fixture-event',
    jobId: 'fixture-job',
    revision: 1,
    parentTaskId: 'fixture-parent',
    projectKey: null,
    receivedAt: new Date().toISOString(),
    resultReceivedAt: new Date().toISOString(),
    eventKind: 'result',
    notify: true,
    resultState: 'succeeded',
    resultHash: 'a'.repeat(64),
    contextHash: 'b'.repeat(64),
    contextValidity: {
      scopeRevisionHash: currentPeerScopeRevisionHash(
        db,
        { ...config, chatJid: config.ownerJid },
        null,
      ),
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
    },
    verification: { status: 'passed', summary: 'Known criteria checked' },
    summary: 'The delegated result is received',
    artifacts: [],
  });
  it('delivers via the real router, updates a live stdin, then survives restart with no cursor or user-row fabrication', async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const channel = {
      name: 'fixture',
      ownsJid: (jid: string) => jid === config.ownerJid,
      isConnected: () => true,
      sendMessage: send,
    } as unknown as Channel;
    const router = createMessageRouter([channel]);
    const observed: unknown[] = [];
    router.addPostHook((envelope) => {
      expect(outboundEnvelopeAdvancesChatCursor(envelope)).toBe(false);
      observed.push(envelope);
    });
    fs.mkdirSync(path.join(DATA_DIR, 'ipc', folder, 'input'), {
      recursive: true,
      mode: 0o700,
    });
    const gate = new Promise<boolean>((resolve) => {
      finish = resolve;
    });
    queue.setProcessMessagesFn(async (jid) => {
      queue.registerProcess(jid, {} as ChildProcess, 'fixture', folder);
      return gate;
    });
    queue.enqueueMessageCheck(config.ownerJid);
    const group = { folder, isMain: true } as RegisteredGroup;
    const deps = {
      db,
      router,
      queue,
      instanceRoot: root,
      groups: () => ({ [config.ownerJid]: group }),
      tenantIdForChat: () => config.tenantId,
      connected: () => true,
    };
    const tick = attachPeerInboxToMessageLoop(config, deps);
    writePeerInboxEvent(config, result());
    await tick();
    expect(send).toHaveBeenCalledTimes(1);
    expect(observed).toHaveLength(1);
    const inputFiles = fs
      .readdirSync(path.join(DATA_DIR, 'ipc', folder, 'input'))
      .filter((name) => name.endsWith('.json'));
    expect(inputFiles).toHaveLength(1);
    const input = JSON.parse(
      fs.readFileSync(
        path.join(DATA_DIR, 'ipc', folder, 'input', inputFiles[0]),
        'utf8',
      ),
    );
    expect(input.type).toBe('message');
    expect(input.text).toContain('authority="data_only"');
    expect(input.hostSource).toBeUndefined();
    expect(input.text).toContain('The delegated result is received');
    finish(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await attachPeerInboxToMessageLoop(config, deps)();
    expect(send).toHaveBeenCalledTimes(1);
    expect(peerInboxPromptContext(db, config.ownerJid, config)).toContain(
      'The delegated result is received',
    );
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE name='messages'").get(),
    ).toBeUndefined();
  });
  it('refuses a changed main registration before touching its result queue', async () => {
    const router = createMessageRouter([]);
    writePeerInboxEvent(config, result());
    await attachPeerInboxToMessageLoop(config, {
      db,
      router,
      queue,
      instanceRoot: root,
      groups: () => ({
        [config.ownerJid]: { folder, isMain: false } as RegisteredGroup,
      }),
      tenantIdForChat: () => config.tenantId,
      connected: () => true,
    })();
    expect(fs.readdirSync(path.join(root, 'inbox'))).toHaveLength(1);
    expect(peerInboxPromptContext(db, config.ownerJid, config)).toBe('');
  });
  it('rejects a private bridge configuration belonging to a different instance', () => {
    const other=fs.mkdtempSync(path.join(root,'other-instance-'));
    expect(()=>attachPeerInboxToMessageLoop(config,{
      db,router:createMessageRouter([]),queue,instanceRoot:other,
      groups:()=>({[config.ownerJid]:{folder,isMain:true} as RegisteredGroup}),
      tenantIdForChat:()=>config.tenantId,connected:()=>true,
    })).toThrow('another instance');
  });
});
