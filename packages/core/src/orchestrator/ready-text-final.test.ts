import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ContainerOutput } from '../runtimes/container-runner.js';
import type { OutboundEnvelope } from './types.js';

const original = 'Перенеси встречу на вторник';
const answer = 'Работа закончена. Встреча перенесена на вторник.';
const corrected = 'Встреча перенесена на четверг.';
const unrelated = 'Другой ответ.';
const correction = 'Поправка, перенеси её на четверг.';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

function fixture(id: number) {
  const owner = String(id);
  const peer = String(id + 1);
  const chat = 'tg:' + owner;
  const other = 'tg:' + peer;
  vi.stubEnv('OWNER_TELEGRAM_USER_IDS', owner + ',' + peer);
  vi.stubEnv('OWNER_TELEGRAM_CHAT_IDS', owner + ',' + peer);
  vi.stubEnv('SKOOBI_SANDBOX_CODEX_PRIMARY', 'true');
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 403 })));
  const group = (chatId: string) => ({ name: 'Delivery recovery fixture ' + chatId, folder: 'ready-owner-' + chatId,
    isMain: true, trigger: '', requiresTrigger: false, added_at: '2026-01-01T00:00:00.000Z',
    runtime: 'sandbox' as const, agentConfig: { fullAccess: true } });
  const groups = { [chat]: group(owner), [other]: group(peer) };
  const events = {
    sends: [] as { jid: string; text: string }[],
    prompts: [] as string[],
    results: [answer] as string[],
    ackLost: true,
    exitAfterFinal: false,
    hook: undefined as undefined | ((envelope: OutboundEnvelope) => void),
    beforeOutput: undefined as undefined | (() => void),
  };
  const channel = { name: 'telegram', ownsJid: (jid: string) => jid in groups,
    isConnected: () => true, setTyping: vi.fn(async () => {}),
    sendMessage: vi.fn(async (jid: string, text: string) => {
      events.sends.push({ jid, text });
      if (text === answer && events.ackLost) throw new Error('connection interrupted after write');
    }) };
  const boot = async () => {
    vi.resetModules();
    const db = await import('./db.js');
    const loop = await import('./message-loop.js');
    const runtime = await import('../runtimes/sandbox-runner.js');
    const {createMessageRouter} = await import('./outbound-router.js');
    const {getExtensionDbSchema} = await import('./extensions.js');
    db.initDatabase(getExtensionDbSchema());
    for (const [jid, g] of Object.entries(groups)) db.setRegisteredGroup(jid, g);
    loop._loadStateForTest();
    loop._setChannelsForTest([channel as never]);
    const router = createMessageRouter([channel as never]);
    router.addPreHook(async envelope => {
      await Promise.resolve();
      events.hook?.(envelope);
      return { action: 'continue' };
    });
    vi.spyOn(runtime, 'runSandboxAgent').mockImplementation(async (_group, input, _proc, output) => {
      events.prompts.push(input.prompt);
      const result: ContainerOutput = { status: 'success', result: events.results.shift() ?? unrelated,
        sideEffected: true, sideEffectTools: ['fixture_action'] };
      events.beforeOutput?.();
      await output!(result);
      return events.exitAfterFinal ? { ...result, status: 'error', error: 'runner exited after final' } : result;
    });
    const { createTelegramSenderIdentity, loadOwnerAllowlistFromEnv } = await import('@skoobi/shared/telegram-identity');
    const add = (msgId: string, content: string, jid = chat,
      origin: 'direct' | 'forwarded' = 'direct') => {
      const chatId = jid.slice(3);
      const identity = createTelegramSenderIdentity({ chatId, fromId: chatId, ownerAllowlist: loadOwnerAllowlistFromEnv() });
      db.storeMessage({ id: msgId, content, chat_jid: jid, sender: chatId, sender_name: 'Owner',
        timestamp: new Date().toISOString(), sender_identity: { ...identity, telegram_message_origin: origin } });
    };
    return { step: (jid = chat) => loop.processGroupMessages(jid, router), add, db,
      startupQueue: () => {
        const enqueue = vi.spyOn(loop._queueForTest(), 'enqueueMessageCheck').mockReturnValue(true);
        loop._recoverPendingMessagesForTest();
        const queued = enqueue.mock.calls.map(([jid]) => jid);
        enqueue.mockRestore();
        return queued;
      },
    };
  };
  const start = async () => {
    const first = await boot();
    first.add('work', original);
    await first.step();
    expect(events.prompts).toHaveLength(1);
    expect(events.sends.filter(m => m.text === answer)).toHaveLength(1);
    return boot();
  };
  return { owner, chat, other, boot, start, events };
}

describe('ready final through persisted SQLite state, processGroupMessages and the outbound router', () => {
  it('claims each new request once across ambiguous sends, restarts and a later confirmed voice request', async () => {
    const f = fixture(721801);
    const restarted = await f.start();
    await restarted.step();
    restarted.add('status', 'Ну что?');
    await restarted.step();
    await restarted.step();
    expect(f.events.sends.filter(m => m.text === answer)).toHaveLength(2);
    f.events.ackLost = false;
    restarted.add('request', 'Пришли готовый ответ');
    await restarted.step();
    const again = await f.boot();
    again.add('repeat', '[Voice: Пришли готовый ответ]');
    await again.step();
    await again.step();
    expect(f.events.prompts).toHaveLength(1);
    expect(f.events.sends.filter(m => m.text === answer)).toHaveLength(4);
  });

  it('processes a mixed correction and status as new input with evidence of completed work', async () => {
    const f = fixture(721811);
    const restarted = await f.start();
    restarted.add('status', 'Ну что?');
    restarted.add('fix', correction);
    f.events.results.push(corrected);
    await restarted.step();
    await (await f.boot()).step();
    expect(f.events.prompts).toHaveLength(2);
    expect(f.events.prompts[1]).toContain('<completed_prior_work>');
    expect(f.events.prompts[1]).toContain(answer);
    expect(f.events.prompts[1]).toContain(correction);
    const current = f.events.prompts[1].match(/<messages>[\s\S]*?<\/messages>/g)?.at(-1);
    expect(current).toContain(correction);
    expect(current).not.toContain(original);
    expect(f.events.sends.filter(m => m.text === answer)).toHaveLength(1);
    expect(f.events.sends.filter(m => m.text === corrected)).toHaveLength(1);
  });

  it('honours a stop after cold restart including a later explicit request', async () => {
    const f = fixture(721821);
    const restarted = await f.start();
    restarted.add('stop', 'Стоп');
    await restarted.step();
    expect(f.events.prompts).toHaveLength(1);
    const again = await f.boot();
    again.add('resend', 'Пришли готовый ответ');
    await again.step();
    expect(f.events.sends.filter(m => m.text === answer)).toHaveLength(1);
    expect(f.events.prompts.slice(1).join('')).not.toContain(answer);
  });

  it('isolates two direct authorised profiles across restart and refuses a forwarded request', async () => {
    const f = fixture(721831);
    const restarted = await f.start();
    restarted.add('different', 'Пришли готовый ответ', f.other);
    await restarted.step(f.other);
    expect(f.events.prompts).toHaveLength(2);
    expect(f.events.prompts[1]).not.toContain(answer);
    expect(f.events.sends.filter(m => m.jid === f.other).some(m => m.text === answer)).toBe(false);
    restarted.add('forward', 'Пришли готовый ответ', f.chat, 'forwarded');
    await restarted.step();
    expect(f.events.sends.filter(m => m.text === answer)).toHaveLength(1);
    expect(f.events.prompts.slice(1).join('')).not.toContain(answer);
  });

  it('drops replay when correction arrives inside asynchronous outbound middleware', async () => {
    const f = fixture(721841);
    const restarted = await f.start();
    restarted.add('request', 'Пришли готовый ответ');
    f.events.hook = envelope => {
      if (envelope.meta?.kind === 'requested_saved_final') {
        restarted.add('late', correction);
        f.events.hook = undefined;
      }
    };
    await restarted.step();
    expect(f.events.sends.filter(m => m.text === answer)).toHaveLength(1);
    expect(f.events.prompts).toHaveLength(1);
    f.events.results.push(corrected);
    await (await f.boot()).step();
    expect(f.events.sends.some(m => m.text === corrected)).toBe(true);
    expect(f.events.prompts).toHaveLength(2);
    expect(f.events.prompts[1]).toContain('<completed_prior_work>');
  });

  it('rechecks ownership immediately before the initial send after hooks', async () => {
    const f = fixture(721851);
    const first = await f.boot();
    f.events.hook = envelope => {
      if (envelope.text === answer) {
        vi.stubEnv('OWNER_TELEGRAM_CHAT_IDS', '999001');
        vi.stubEnv('OWNER_TELEGRAM_USER_IDS', '999001');
      }
    };
    first.add('work', original);
    await first.step();
    expect(f.events.sends.some(m => m.text === answer)).toBe(false);
    await (await f.boot()).step();
    expect(f.events.prompts).toHaveLength(1);
  });
  it('sends a staged text only once when the process died before its first transport claim', async () => {
    const f = fixture(721861);
    const first = await f.boot();
    const key = 'ready_text_final:' + JSON.stringify([f.chat, 'ready-owner-' + f.owner]);
    const originalSet = first.db.setRouterState;
    let blocked = false;
    vi.spyOn(first.db, 'setRouterState').mockImplementation((k, v) => {
      if (k === key && JSON.parse(v).unattempted !== true && !blocked) {
        blocked = true;
        throw new Error('simulated crash before transport claim');
      }
      originalSet(k, v);
    });
    first.add('work', original);
    await first.step();
    expect(blocked).toBe(true);
    expect(f.events.sends.filter(m => m.text === answer)).toHaveLength(0);
    const restarted = await f.boot();
    expect(restarted.startupQueue()).toContain(f.chat);
    await restarted.step();
    const afterLostAck = await f.boot();
    expect(afterLostAck.startupQueue()).not.toContain(f.chat);
    await afterLostAck.step();
    expect(f.events.prompts).toHaveLength(1);
    expect(f.events.sends.filter(m => m.text === answer)).toHaveLength(1);
  });

  it('imports a ready legacy timeout scoped to its exact owner and never repeats its work', async () => {
    const f = fixture(721871);
    const first = await f.boot();
    first.add('work', original);
    const source = first.db.getMessagesByIds(f.chat, ['work'])[0];
    const {resolveGroupIpcPath} = await import('./group-folder.js');
    const {ensureIpcDirectoryLayout} = await import('./ipc-paths.js');
    const t = await import('./timeout-continuation.js');
    const groupIpcDir = resolveGroupIpcPath('ready-owner-' + f.owner);
    ensureIpcDirectoryLayout(groupIpcDir);
    const store = {get: first.db.getRouterState, set: first.db.setRouterState};
    const job = t.stageTimeoutContinuation({ groupIpcDir, chatJid: f.chat, messageIds: [source.id],
      ingestionCursors: [source.ingestion_cursor!], directTrustedOwner: true, cancelled: false,
      capTimeout: true, sideEffectTools: ['fixture_action'], store })!;
    expect(t.claimTimeoutContinuation(store, job.requestKey)).toBe(true);
    t.cacheTimeoutContinuationDelivery(store, job.requestKey, answer, [job.fileName],
      {cursor: source.ingestion_cursor!, messageIds: [source.id]});
    const restarted = await f.boot();
    await restarted.step();
    expect(f.events.sends.some(m => m.text === answer)).toBe(false);
    restarted.add('request', 'Пришли готовый ответ');
    await restarted.step();
    await (await f.boot()).step();
    expect(f.events.sends.filter(m => m.text === answer)).toHaveLength(1);
    expect(f.events.prompts).toHaveLength(0);
  });

  it('holds delivery when authority changes while the model is producing a final', async () => {
    const f = fixture(721881);
    const first = await f.boot();
    f.events.beforeOutput = () => {
      vi.stubEnv('OWNER_TELEGRAM_CHAT_IDS', '999001');
      vi.stubEnv('OWNER_TELEGRAM_USER_IDS', '999001');
    };
    first.add('work', original);
    await first.step();
    await (await f.boot()).step();
    expect(f.events.sends.some(m => m.text === answer)).toBe(false);
    expect(f.events.prompts).toHaveLength(1);
  });

  it('erases expired text even for an idle profile and retains the source execution cursor', async () => {
    const f = fixture(721891);
    const restarted = await f.start();
    const key = 'ready_text_final:' + JSON.stringify([f.chat, 'ready-owner-' + f.owner]);
    const r = JSON.parse(restarted.db.getRouterState(key)!);
    r.savedAt -= 8 * 86400000;
    restarted.db.setRouterState(key, JSON.stringify(r));
    await restarted.step(f.other);
    expect(JSON.parse(restarted.db.getRouterState(key)!)).toMatchObject({ sourceCursor:r.sourceCursor, text:'' });
    await (await f.boot()).step();
    expect(f.events.prompts).toHaveLength(1);
    expect(f.events.sends.filter(m => m.text === answer)).toHaveLength(1);
  });

  it('never selects another runner when the first exits in error after producing a completed result', async () => {
    const f = fixture(721901);
    f.events.exitAfterFinal = true;
    const restarted = await f.start();
    restarted.add('resend', 'Пришли готовый ответ');
    f.events.ackLost = false;
    await restarted.step();
    expect(f.events.prompts).toHaveLength(1);
    expect(f.events.sends.filter(m => m.text === answer)).toHaveLength(2);
  });

  it('keeps the requesting ping pending when a voice arrives inside an outbound hook', async () => {
    const f = fixture(721911);
    const restarted = await f.start();
    const {createMediaIntakeStore, earliestMediaIntakeCursor} = await import('./media-intake-store.js');
    const scope = { botId: 'telegram_default', tenantId: 'owner-fixture', chatJid: f.chat, groupFolder: 'ready-owner-' + f.owner };
    const source = restarted.db.getMessagesByIds(f.chat, ['work'])[0];
    const adapter = createMediaIntakeStore(restarted.db.getDb(), {botId: scope.botId,
      resolveScope: () => scope, isAdmitted: () => true, canProcess: () => true,
      writeMessage: (_db, msg) => restarted.db.storeMessage(msg) });
    restarted.add('status', 'Ну что?');
    let accepted: string | undefined;
    f.events.hook = envelope => {
      if (envelope.meta?.kind !== 'requested_saved_final') return;
      const result = adapter.accept({message: {...source, id:'audio-fix', telegram_update_id:'9010'},
        media: {kind:'voice',fileId:'file',fileUniqueId:'unique',declaredBytes:21},isGroup:false});
      accepted = result.kind;
      f.events.hook = undefined;
    };
    await restarted.step();
    expect(accepted).toBe('accepted');
    expect(earliestMediaIntakeCursor(restarted.db.getDb(), f.chat)).toBeTruthy();
    const key = 'ready_text_final:' + JSON.stringify([f.chat, 'ready-owner-' + f.owner]);
    const record = JSON.parse(restarted.db.getRouterState(key)!);
    expect(record.attemptedThrough).toBe(record.sourceCursor);
    await (await f.boot()).step();
    expect(f.events.prompts).toHaveLength(1);
    expect(f.events.sends.filter(m => m.text === answer)).toHaveLength(1);
  });

  it('preserves every character of an accepted result larger than one MiB', async () => {
    const {readyTextFinalJournal} = await import('./ready-text-final.js');
    const f = fixture(721921);
    const first = await f.boot();
    first.add('work', original);
    const source = first.db.getMessagesByIds(f.chat, ['work']);
    const get = first.db.getRouterState;
    const set = first.db.setRouterState;
    const text = 'x'.repeat(1024 * 1024 + 1) + 'Конец.';
    readyTextFinalJournal({get, set}, f.chat, 'large-fixture').stage('principal', source, text);
    const restarted = await f.boot();
    const saved = readyTextFinalJournal({get:restarted.db.getRouterState, set:restarted.db.setRouterState}, f.chat, 'large-fixture').read();
    expect(saved?.text).toBe(text);
  });

});
