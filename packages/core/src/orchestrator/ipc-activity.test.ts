/**
 * Integration: the IPC watcher must feed CONFIRMED deliveries into the
 * run-activity bridge (notifyRunIpcActivity), keyed by the SOURCE group
 * folder — that signal is what keeps an output-silent sandbox run alive past
 * runSandboxAgent's no-output/progress deadlines for runs that report
 * exclusively through IPC deliveries.
 *
 * Unauthorized attempts, pre-hook-dropped envelopes (route → null) and failed
 * sends (ok=false) are NOT deliveries and must not produce a liveness signal.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';

// Isolate the watcher's scan root from the real data/ dir (and from any other
// test file): everything below uses a throwaway DATA_DIR under /tmp. Other
// config constants pass through unchanged.
const TEST_DATA_DIR = '/tmp/claudeclaw-ipc-activity-test';
vi.mock('./config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./config.js')>()),
  DATA_DIR: '/tmp/claudeclaw-ipc-activity-test',
  GROUPS_DIR: '/tmp/claudeclaw-ipc-activity-test/groups',
}));

import { _initTestDatabase, getRecentConversationMessages } from './db.js';
import { getEventsForTenant } from './event-store.js';
import {
  ipcDocumentHistoryPlaceholder,
  ipcPhotoHistoryPlaceholder,
  ipcVoiceHistoryPlaceholder,
  startIpcWatcher,
  IpcDeps,
} from './ipc.js';
import { logger } from './logger.js';
import { onRunIpcActivity, RunIpcActivityKind } from './run-activity.js';
import { recentChatFileSend } from './chat-file-sends.js';
import {
  _clearTaskAuthorizationState,
  authorizeTaskOperationRequest,
  registerTaskAuthorizationCapability,
} from './task-authorization.js';
import { signedTaskAuthorizationRequestForTest } from './task-authorization.test-helpers.js';
import { defaultWhatsappTenantId } from './tenant-registry.js';
import { MessageRouter, RegisteredGroup } from './types.js';

const MAIN_FOLDER = 'ipc-act-main';
const GUEST_FOLDER = 'ipc-act-guest';
const SYMLINK_CATEGORY_FOLDER = 'ipc-act-symlink-category';
const SYMLINK_ROOT_FOLDER = 'ipc-act-symlink-root';
const IPC_BASE = path.join(TEST_DATA_DIR, 'ipc');
const TEST_GROUPS_DIR = path.join(TEST_DATA_DIR, 'groups');

const GROUPS: Record<string, RegisteredGroup> = {
  'main@g.us': {
    name: 'Main',
    folder: MAIN_FOLDER,
    trigger: 'always',
    added_at: '2026-06-10T00:00:00.000Z',
    isMain: true,
  },
  'guest@g.us': {
    name: 'Guest',
    folder: GUEST_FOLDER,
    trigger: '@bot',
    added_at: '2026-06-10T00:00:00.000Z',
  },
  'other@g.us': {
    name: 'Other',
    folder: 'ipc-act-other',
    trigger: '@bot',
    added_at: '2026-06-10T00:00:00.000Z',
  },
  'symlink-category@g.us': {
    name: 'Symlink category guest',
    folder: SYMLINK_CATEGORY_FOLDER,
    trigger: '@bot',
    added_at: '2026-07-11T00:00:00.000Z',
  },
  'symlink-root@g.us': {
    name: 'Symlink root guest',
    folder: SYMLINK_ROOT_FOLDER,
    trigger: '@bot',
    added_at: '2026-07-11T00:00:00.000Z',
  },
};

// route(): null = dropped/no user-visible text (NOT a delivery);
// sendPhoto()/sendDocument(): caption 'fail' and sendVoice(): text 'fail'
// simulate a failed channel send (ok=false).
const observedStagedPaths: string[] = [];
const router: MessageRouter = {
  route: async (envelope) =>
    envelope.text === 'DROP_ME' ? null : envelope.text,
  send: async () => {},
  sendPhoto: async (_jid, filePath, caption) => {
    if (filePath.includes('ipc-staging')) observedStagedPaths.push(filePath);
    return caption !== 'fail';
  },
  sendDocument: async (_jid, filePath, caption) => {
    if (filePath.includes('ipc-staging')) observedStagedPaths.push(filePath);
    if (caption === 'throw') throw new Error('simulated channel failure');
    return caption !== 'fail';
  },
  sendVoice: async (_jid, text) => text !== 'fail',
  addPreHook: () => {},
  addPostHook: () => {},
};

const deps: IpcDeps = {
  router,
  registeredGroups: () => GROUPS,
  registerGroup: () => {},
  syncGroups: async () => {},
  getAvailableGroups: () => [],
  writeGroupsSnapshot: () => {},
};

function writeEnvelope(
  folder: string,
  name: string,
  data: Record<string, unknown>,
): void {
  const dir = path.join(IPC_BASE, folder, 'messages');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), JSON.stringify(data));
}

let ownerRequestSequence = 0;
function ownerEnvelope(
  envelope: Record<string, unknown>,
): Record<string, unknown> {
  const capability = registerTaskAuthorizationCapability({
    groupFolder: MAIN_FOLDER,
    isMain: true,
    credentialProxyTier: 'owner',
    homogeneousOwnerBatch: true,
    senderIdentity: {
      channel: 'telegram',
      chat_id: '100000001',
      telegram_user_id: '100000001',
      identity_id: 'telegram_user_100000001',
      is_owner_sender: true,
      telegram_message_origin: 'direct',
    },
  });
  if (!capability) throw new Error('owner capability unavailable');
  const requestId = `ipc_activity_owner_${++ownerRequestSequence}`;
  const response = authorizeTaskOperationRequest(
    signedTaskAuthorizationRequestForTest(capability, envelope, requestId),
    MAIN_FOLDER,
  );
  if (!response.ok || !response.grant) {
    throw new Error(`owner grant unavailable: ${response.error}`);
  }
  return { ...envelope, ownerAuthorizationGrant: response.grant };
}

// The watcher pass is a chain of awaits over immediately-resolving promises;
// fake timers leave microtasks live, so a bounded number of microtask yields
// deterministically drains one full pass.
async function flushWatcherPass(): Promise<void> {
  for (let i = 0; i < 200; i++) await Promise.resolve();
}

describe('IPC watcher → run-activity liveness notifications', () => {
  const mainEvents: RunIpcActivityKind[] = [];
  const guestEvents: RunIpcActivityKind[] = [];
  const symlinkCategoryEvents: RunIpcActivityKind[] = [];
  const symlinkRootEvents: RunIpcActivityKind[] = [];
  const unsubscribers: Array<() => void> = [];
  let tmpDir: string;

  beforeAll(() => {
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
    fs.mkdirSync(IPC_BASE, { recursive: true });
    _clearTaskAuthorizationState();
    ownerRequestSequence = 0;
    _initTestDatabase();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ipc-act-files-'));
    unsubscribers.push(
      onRunIpcActivity(MAIN_FOLDER, (kind) => mainEvents.push(kind)),
      onRunIpcActivity(GUEST_FOLDER, (kind) => guestEvents.push(kind)),
      onRunIpcActivity(SYMLINK_CATEGORY_FOLDER, (kind) =>
        symlinkCategoryEvents.push(kind),
      ),
      onRunIpcActivity(SYMLINK_ROOT_FOLDER, (kind) =>
        symlinkRootEvents.push(kind),
      ),
    );
    vi.useFakeTimers();
  });

  afterAll(() => {
    vi.useRealTimers();
    for (const unsubscribe of unsubscribers) unsubscribe();
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('signals confirmed deliveries by source folder; blocked/dropped/failed sends stay silent', async () => {
    const photoPath = path.join(tmpDir, 'report.png');
    fs.writeFileSync(photoPath, 'png-bytes');

    // Pass 1 (runs immediately on start): a confirmed text delivery from the
    // main folder; an UNAUTHORIZED guest send into another group's chat.
    writeEnvelope(
      MAIN_FOLDER,
      'm1.json',
      ownerEnvelope({
        type: 'message',
        chatJid: 'main@g.us',
        text: 'hello',
      }),
    );
    writeEnvelope(GUEST_FOLDER, 'g1.json', {
      type: 'message',
      chatJid: 'other@g.us',
      text: 'sneaky cross-group send',
    });

    // Stable legacy attacks planted before the hardened runtime starts:
    // neither a category symlink nor a whole-group symlink may make the host
    // route/delete an external JSON file.
    const outsideCategory = path.join(tmpDir, 'outside-category');
    fs.mkdirSync(outsideCategory);
    const outsideCategoryEnvelope = path.join(outsideCategory, 'outside.json');
    fs.writeFileSync(
      outsideCategoryEnvelope,
      JSON.stringify({
        type: 'message',
        chatJid: 'symlink-category@g.us',
        text: 'MUST_NOT_ROUTE_CATEGORY_LINK',
      }),
    );
    const symlinkCategoryRoot = path.join(IPC_BASE, SYMLINK_CATEGORY_FOLDER);
    fs.mkdirSync(symlinkCategoryRoot);
    fs.symlinkSync(outsideCategory, path.join(symlinkCategoryRoot, 'messages'));

    const outsideGroupRoot = path.join(tmpDir, 'outside-group-root');
    fs.mkdirSync(path.join(outsideGroupRoot, 'messages'), { recursive: true });
    const outsideRootEnvelope = path.join(
      outsideGroupRoot,
      'messages',
      'outside.json',
    );
    fs.writeFileSync(
      outsideRootEnvelope,
      JSON.stringify({
        type: 'message',
        chatJid: 'symlink-root@g.us',
        text: 'MUST_NOT_ROUTE_ROOT_LINK',
      }),
    );
    fs.symlinkSync(outsideGroupRoot, path.join(IPC_BASE, SYMLINK_ROOT_FOLDER));

    startIpcWatcher(deps);
    await flushWatcherPass();

    expect(mainEvents).toEqual(['message']);
    expect(guestEvents).toEqual([]);
    expect(symlinkCategoryEvents).toEqual([]);
    expect(symlinkRootEvents).toEqual([]);
    expect(fs.existsSync(outsideCategoryEnvelope)).toBe(true);
    expect(fs.existsSync(outsideRootEnvelope)).toBe(true);

    // Pass 2: a pre-hook-dropped text (route → null) and a failed photo send
    // (ok=false) are not deliveries — no liveness signal for either.
    writeEnvelope(
      MAIN_FOLDER,
      'm2.json',
      ownerEnvelope({
        type: 'message',
        chatJid: 'main@g.us',
        text: 'DROP_ME',
      }),
    );
    writeEnvelope(
      MAIN_FOLDER,
      'm3.json',
      ownerEnvelope({
        type: 'photo',
        chatJid: 'main@g.us',
        filePath: photoPath,
        caption: 'fail',
      }),
    );
    vi.advanceTimersByTime(1000);
    await flushWatcherPass();

    expect(mainEvents).toEqual(['message']);

    // Pass 3: confirmed photo / document / voice deliveries all signal.
    writeEnvelope(
      MAIN_FOLDER,
      'm4.json',
      ownerEnvelope({
        type: 'photo',
        chatJid: 'main@g.us',
        filePath: photoPath,
        caption: 'site walkthrough step 4',
      }),
    );
    writeEnvelope(
      MAIN_FOLDER,
      'm5.json',
      ownerEnvelope({
        type: 'document',
        chatJid: 'main@g.us',
        filePath: photoPath,
      }),
    );
    writeEnvelope(
      MAIN_FOLDER,
      'm6.json',
      ownerEnvelope({
        type: 'voice',
        chatJid: 'main@g.us',
        text: 'voice progress note',
      }),
    );
    vi.advanceTimersByTime(1000);
    await flushWatcherPass();

    expect(mainEvents.slice(1).sort()).toEqual(['document', 'photo', 'voice']);
    expect(guestEvents).toEqual([]);

    // Pass 4: guest files are copied to host-only staging for the awaited
    // channel call, then deleted immediately on both success and throw. This
    // bounds disk use even if a guest repeatedly queues near-50MB documents.
    const guestOutputDir = path.join(TEST_GROUPS_DIR, GUEST_FOLDER, 'out');
    fs.mkdirSync(guestOutputDir, { recursive: true });
    const guestPhoto = path.join(guestOutputDir, 'guest-photo.png');
    const guestDocument = path.join(guestOutputDir, 'guest-report.pdf');
    fs.writeFileSync(guestPhoto, 'guest-photo');
    fs.writeFileSync(guestDocument, 'guest-document');
    writeEnvelope(GUEST_FOLDER, 'g2.json', {
      type: 'photo',
      chatJid: 'guest@g.us',
      filePath: guestPhoto,
    });
    writeEnvelope(GUEST_FOLDER, 'g3.json', {
      type: 'document',
      chatJid: 'guest@g.us',
      filePath: guestDocument,
      caption: 'throw',
    });
    vi.advanceTimersByTime(1000);
    await flushWatcherPass();

    expect(observedStagedPaths).toHaveLength(2);
    for (const stagedPath of observedStagedPaths) {
      expect(fs.existsSync(stagedPath)).toBe(false);
    }

    // All envelope files were consumed by the watcher.
    expect(
      fs.readdirSync(path.join(IPC_BASE, MAIN_FOLDER, 'messages')),
    ).toEqual([]);
  });


  // deliveries were never written to messages, so the dashboard chat, the
  // bot's recent_conversation_context and chat_history saw «no answer» after
  // a voice-only turn. Same rule as the text branch: ok=true → storeBotReply
  // with a placeholder; a failed send stores nothing; text is not duplicated.
  it('подтверждённые голос/фото/документ попадают в историю чата плейсхолдерами; срыв отправки — нет', async () => {
    const before = getRecentConversationMessages('main@g.us', '', 100);
    const beforeContents = before.map((m) => m.content);
    // Passes 1–3 above: the text send is stored once (no duplicate from the
    // media branches), the three confirmed media sends are stored, and the
    // failed photo send (caption 'fail', ok=false) is not.
    expect(beforeContents.filter((c) => c === 'hello')).toHaveLength(1);
    expect(beforeContents).toContain(
      '[Photo: report.png] site walkthrough step 4',
    );
    expect(beforeContents).toContain('[Document: report.png]');
    expect(beforeContents).toContain('[Voice: voice progress note]');
    expect(beforeContents).not.toContain('[Photo: report.png] fail');
    expect(before.every((m) => Boolean(m.is_bot_message))).toBe(true);

    const chartPath = path.join(tmpDir, 'график.png');
    const estimatePath = path.join(tmpDir, 'смета.pdf');
    fs.writeFileSync(chartPath, 'png-bytes');
    fs.writeFileSync(estimatePath, 'pdf-bytes');
    writeEnvelope(
      MAIN_FOLDER,
      'm7.json',
      ownerEnvelope({
        type: 'voice',
        chatJid: 'main@g.us',
        text: '  Отчёт готов, смотри документ.  ',
      }),
    );
    writeEnvelope(
      MAIN_FOLDER,
      'm8.json',
      ownerEnvelope({
        type: 'photo',
        chatJid: 'main@g.us',
        filePath: chartPath,
        caption: 'график продаж',
      }),
    );
    writeEnvelope(
      MAIN_FOLDER,
      'm9.json',
      ownerEnvelope({
        type: 'document',
        chatJid: 'main@g.us',
        filePath: estimatePath,
        caption: 'смета на октябрь',
      }),
    );
    vi.advanceTimersByTime(1000);
    await flushWatcherPass();

    const after = getRecentConversationMessages('main@g.us', '', 100);
    const added = after.slice(before.length);
    expect(added).toHaveLength(3);
    expect(added.every((m) => Boolean(m.is_bot_message))).toBe(true);
    // One pass under fake timers shares a timestamp, so compare as a set.
    expect(added.map((m) => m.content).sort()).toEqual(
      [
        '[Voice: Отчёт готов, смотри документ.]',
        '[Photo: график.png] график продаж',
        '[Document: смета.pdf] смета на октябрь',
      ].sort(),
    );
    expect(mainEvents.slice(-3).sort()).toEqual(['document', 'photo', 'voice']);
    // C38: the final answer that links one of these files must not attach it
    // a second time — the watcher notes every confirmed file send.
    expect(recentChatFileSend(MAIN_FOLDER, fs.realpathSync(chartPath))).toBe(
      'sent',
    );
    expect(recentChatFileSend(MAIN_FOLDER, fs.realpathSync(estimatePath))).toBe(
      'sent',
    );
  });


  // turn as answered as soon as the envelope is written, so a channel refusal
  // (send → false) used to leave only an INFO line with ok=false — the user
  // got no answer and neither the dashboard's error badge nor the event store
  // saw anything. Now: WARN + an `error` event (kind ipc_delivery_failed);
  // still not a delivery (no liveness signal, nothing in the chat history).
  it('срыв доставки голоса/фото/документа — WARN и событие error ipc_delivery_failed', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const tenantId = defaultWhatsappTenantId('main');
    const errorEvents = () =>
      getEventsForTenant(tenantId).filter((event) => event.type === 'error');
    const errorsBefore = errorEvents().length;
    const historyBefore = getRecentConversationMessages('main@g.us', '', 100)
      .length;
    const livenessBefore = mainEvents.length;
    try {
      const failPhoto = path.join(tmpDir, 'fail-photo.png');
      const failDocument = path.join(tmpDir, 'fail-doc.pdf');
      fs.writeFileSync(failPhoto, 'png-bytes');
      fs.writeFileSync(failDocument, 'pdf-bytes');
      writeEnvelope(
        MAIN_FOLDER,
        'm10.json',
        ownerEnvelope({ type: 'voice', chatJid: 'main@g.us', text: 'fail' }),
      );
      writeEnvelope(
        MAIN_FOLDER,
        'm11.json',
        ownerEnvelope({
          type: 'photo',
          chatJid: 'main@g.us',
          filePath: failPhoto,
          caption: 'fail',
        }),
      );
      writeEnvelope(
        MAIN_FOLDER,
        'm12.json',
        ownerEnvelope({
          type: 'document',
          chatJid: 'main@g.us',
          filePath: failDocument,
          caption: 'fail',
        }),
      );
      vi.advanceTimersByTime(1000);
      await flushWatcherPass();

      const added = errorEvents().slice(errorsBefore);
      const payloads = added.map(
        (event) => JSON.parse(event.payload_json) as Record<string, unknown>,
      );
      expect(payloads.map((payload) => payload.medium).sort()).toEqual([
        'document',
        'photo',
        'voice',
      ]);
      for (const payload of payloads) {
        expect(payload).toMatchObject({
          kind: 'ipc_delivery_failed',
          chat_jid: 'main@g.us',
          sourceGroup: MAIN_FOLDER,
          reason: 'channel_send_failed',
        });
      }
      expect(added.every((event) => event.actor === 'system')).toBe(true);

      const warned = warnSpy.mock.calls.map((call) => String(call[1]));
      expect(warned).toEqual(
        expect.arrayContaining([
          'IPC voice delivery failed',
          'IPC photo delivery failed',
          'IPC document delivery failed',
        ]),
      );
      const warnedFields = warnSpy.mock.calls.map((call) => call[0]);
      expect(warnedFields).toContainEqual(
        expect.objectContaining({
          chatJid: 'main@g.us',
          sourceGroup: MAIN_FOLDER,
          medium: 'voice',
          reason: 'channel_send_failed',
        }),
      );

      // Not a delivery: no liveness signal, no history placeholder, and the
      // envelopes were consumed rather than parked in errors/.
      expect(mainEvents).toHaveLength(livenessBefore);
      expect(getRecentConversationMessages('main@g.us', '', 100)).toHaveLength(
        historyBefore,
      );
      expect(
        fs.readdirSync(path.join(IPC_BASE, MAIN_FOLDER, 'messages')),
      ).toEqual([]);
      // A refused file is not «already sent»: a later link may attach it.
      expect(
        recentChatFileSend(MAIN_FOLDER, fs.realpathSync(failDocument)),
      ).toBeNull();
      expect(
        recentChatFileSend(MAIN_FOLDER, fs.realpathSync(failPhoto)),
      ).toBeNull();
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe('IPC delivery history placeholders', () => {
  // The prefixes must stay the inbound ones ('[Voice: …]', '[Photo…]',
  // '[Document: …]'): chat_history's BOT_KIND_SQL, cleanBotContent and the
  // dashboard's message_kind all key on them.
  it('voice keeps the spoken text, trimmed', () => {
    expect(ipcVoiceHistoryPlaceholder(' Привет, это Скуби. ')).toBe(
      '[Voice: Привет, это Скуби.]',
    );
  });

  it('photo names the agent-side file and keeps an optional caption', () => {
    expect(
      ipcPhotoHistoryPlaceholder('/workspace/group/out/chart.png', ' подпись '),
    ).toBe('[Photo: chart.png] подпись');
    expect(ipcPhotoHistoryPlaceholder('/tmp/out/chart.png')).toBe(
      '[Photo: chart.png]',
    );
    expect(ipcPhotoHistoryPlaceholder('/tmp/out/chart.png', '   ')).toBe(
      '[Photo: chart.png]',
    );
  });

  it('document names the file and keeps an optional caption', () => {
    expect(
      ipcDocumentHistoryPlaceholder('/tmp/out/Смета.2026.pdf', 'смета'),
    ).toBe('[Document: Смета.2026.pdf] смета');
    expect(ipcDocumentHistoryPlaceholder('/tmp/out/Смета.2026.pdf')).toBe(
      '[Document: Смета.2026.pdf]',
    );
  });
});
