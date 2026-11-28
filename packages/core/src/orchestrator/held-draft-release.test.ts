/**
 * W03 (разбор недели): готовый ответ держится не дольше 90 с и не
 * теряется, если продолжение сорвалось. Сценарии: итог трижды
 * ушёл в продолжение (~20 мин ожидания); продолжение прервалось сразу,
 * черновик не дошёл; вопрос в черновике, ответ уже в новых
 * сообщениях; обычное короткое удержание (один ответ, C12).
 */
import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  HELD_DRAFT_FAILURE_PREFIX,
  HELD_DRAFT_NOTICE_TEXT,
  HELD_DRAFT_TIMEOUT_PREFIX,
  HELD_DRAFT_FINAL_ADDENDUM_PREFIX,
  HELD_DRAFT_FINAL_REVISED_PREFIX,
  HELD_DRAFT_FINAL_SAME_TEXT,
  HELD_DRAFT_LINKS_DEAD_NOTE,
  HELD_DRAFT_LINKS_DROPPED_NOTE,
  HELD_DRAFT_LINKS_LATER_NOTE,
  HELD_DRAFT_LINKS_FAILURE_PREFIX,
  HeldDraftRelease,
  trimRepeatOfReleasedDraft,
  withdrawOwedLinksPromise,
  parseHeldDraftCheckpoint,
  releasableHeldDraft,
} from './held-draft-release.js';
import { STATE_ROOT } from './config.js';
import { heldDraftReleaseConfig } from './live-mode.js';

const REPORT =
  'Доделал и установил обновление на Mac Studio: служба перезапущена, проверка прошла, журнал чистый.';
const STALE_QUESTION = 'Счёт оформлять на ТОО «Пример» или на ИП?';

function controller(
  options: {
    cancelled?: () => boolean;
    ipcDeliveries?: () => number;
    linkCheckedFinal?: boolean;
  } = {},
) {
  const sent: Array<{ kind: 'draft' | 'notice'; text: string; reason?: string }> = [];
  /** heldDraft handed to deliverDraft: the bookkeeping mark (null — not all of it went). */
  const marks: Array<string | null> = [];
  let deliverOk = true;
  const release = new HeldDraftRelease({
    now: () => Date.now(),
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (timer) => clearTimeout(timer as NodeJS.Timeout),
    cancelled: options.cancelled ?? (() => false),
    ...(options.ipcDeliveries ? { ipcDeliveries: options.ipcDeliveries } : {}),
    ...(options.linkCheckedFinal ? { linkCheckedFinal: true } : {}),
    deliverDraft: async (text, reason, heldDraft) => {
      sent.push({ kind: 'draft', text, reason });
      marks.push(heldDraft);
      return deliverOk;
    },
    deliverNotice: async (text) => {
      sent.push({ kind: 'notice', text });
      return true;
    },
  });
  return {
    release,
    sent,
    marks,
    failDelivery: () => {
      deliverOk = false;
    },
  };
}

const held = (draftText?: string, reason = 'correction_pending') => ({
  reason,
  continuations: 1,
  pendingMessages: 1,
  readyDraftHeld: true,
  ...(draftText ? { draftText } : {}),
});

afterEach(() => {
  vi.useRealTimers();
});

describe('what part of a held draft may go out early', () => {
  it('a report without a question goes whole', () => {
    expect(releasableHeldDraft(REPORT)).toEqual({ text: REPORT, questionRemoved: false });
  });

  it('a trailing question is cut: the new messages may already answer it', () => {
    const draft = `${REPORT}\n\nУточни пару моментов:\n1. Ставить на MacBook тоже?\n2. Перезагрузить сейчас?`;
    expect(releasableHeldDraft(draft)).toEqual({ text: REPORT, questionRemoved: true });
  });

  it('a draft that is only the stale question is not sent', () => {
    expect(releasableHeldDraft(STALE_QUESTION)).toBeNull();
    expect(releasableHeldDraft(`Готово.\n\n${STALE_QUESTION}`)).toBeNull();
  });

  it('service markers and links to files on this Mac are left to the final', () => {
    expect(releasableHeldDraft('БЕЗ_ИЗМЕНЕНИЙ')).toBeNull();
    expect(releasableHeldDraft(`${REPORT}\n[Отчёт](/Users/example/report.pdf)`)).toBeNull();
    expect(releasableHeldDraft('')).toBeNull();
    expect(releasableHeldDraft(undefined)).toBeNull();
  });

  it('the checkpoint parser keeps only validated fields', () => {
    expect(parseHeldDraftCheckpoint(held(REPORT))).toEqual({
      reason: 'correction_pending',
      draftText: REPORT,
    });
    expect(parseHeldDraftCheckpoint({ ...held(REPORT), readyDraftHeld: false })).toBeNull();
    expect(parseHeldDraftCheckpoint({ ...held(REPORT), reason: 'other' })).toBeNull();
    expect(parseHeldDraftCheckpoint(held('x'.repeat(30_000)))).toEqual({
      reason: 'correction_pending',
    });
  });
});

describe('held draft timer and failures', () => {
  it('C12 stays: a continuation that answers within 90 s gives one answer', async () => {
    vi.useFakeTimers();
    const { release, sent } = controller();
    release.onCheckpoint(held(REPORT));
    await vi.advanceTimersByTimeAsync(60_000);
    await release.beforeOutput({ status: 'success', hasText: true, closesHeldBatch: true });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(sent).toEqual([]);
  });

  it('the ready report goes out at 90 s with a note, the final follows', async () => {
    vi.useFakeTimers();
    const { release, sent } = controller();
    release.onCheckpoint(held(REPORT));
    await vi.advanceTimersByTimeAsync(89_000);
    expect(sent).toEqual([]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(sent).toEqual([
      { kind: 'draft', reason: 'hold-timeout', text: `${HELD_DRAFT_TIMEOUT_PREFIX}\n\n${REPORT}` },
    ]);
    // The continuation still fails later: the draft is not sent twice and the
    // usual «прервалось» notice stays (releasedOnFailure is false).
    await release.beforeOutput({ status: 'error', hasText: false, closesHeldBatch: false });
    expect(sent).toHaveLength(1);
    expect(release.releasedOnFailure).toBe(false);
  });

  it('the continuation stops at once — the draft goes out once, instead of nothing', async () => {
    vi.useFakeTimers();
    const { release, sent } = controller();
    release.onCheckpoint(held(REPORT, 'continuation_interrupted'));
    await release.beforeOutput({ status: 'error', hasText: false, closesHeldBatch: false });
    await release.beforeOutput({ status: 'error', hasText: false, closesHeldBatch: false });
    await vi.advanceTimersByTimeAsync(600_000);
    expect(sent).toEqual([
      { kind: 'draft', reason: 'continuation-failed', text: `${HELD_DRAFT_FAILURE_PREFIX}\n\n${REPORT}` },
    ]);
    expect(release.releasedOnFailure).toBe(true);
  });

  it('a failed continuation releases the held draft before the error is handled', async () => {
    vi.useFakeTimers();
    const { release, sent } = controller();
    release.onCheckpoint(held(REPORT));
    await vi.advanceTimersByTimeAsync(10_000);
    release.onCheckpoint(held(REPORT, 'continuation_budget_exhausted'));
    await release.beforeOutput({ status: 'error', hasText: false, closesHeldBatch: false });
    expect(sent.map((entry) => entry.reason)).toEqual(['continuation-failed']);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(sent).toHaveLength(1);
  });

  it('an empty final of the continuation does not swallow the ready answer', async () => {
    vi.useFakeTimers();
    const { release, sent } = controller();
    release.onCheckpoint(held(REPORT));
    // A text-less frame that does not retire the batch is not the end.
    await release.beforeOutput({ status: 'success', hasText: false, closesHeldBatch: false });
    expect(sent).toEqual([]);
    await release.beforeOutput({ status: 'success', hasText: false, closesHeldBatch: true });
    expect(sent.map((entry) => entry.reason)).toEqual(['continuation-empty']);
  });

  it('after «стоп» nothing goes out', async () => {
    vi.useFakeTimers();
    let stopped = false;
    const { release, sent } = controller({ cancelled: () => stopped });
    release.onCheckpoint(held(REPORT));
    stopped = true;
    await vi.advanceTimersByTimeAsync(120_000);
    await release.beforeOutput({ status: 'error', hasText: false, closesHeldBatch: false });
    expect(sent).toEqual([]);
  });

  it('a question-only draft is held; the short notice comes only after a minute', async () => {
    vi.useFakeTimers();
    const { release, sent } = controller();
    release.onCheckpoint(held(STALE_QUESTION));
    await vi.advanceTimersByTimeAsync(59_000);
    expect(sent).toEqual([]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(sent).toEqual([{ kind: 'notice', text: HELD_DRAFT_NOTICE_TEXT }]);
    await vi.advanceTimersByTimeAsync(600_000);
    await release.beforeOutput({ status: 'error', hasText: false, closesHeldBatch: false });
    // Never the stale question, not even on a failure.
    expect(sent.filter((entry) => entry.kind === 'draft')).toEqual([]);
  });

  it('a hold that ends within a minute sends no notice at all', async () => {
    vi.useFakeTimers();
    const { release, sent } = controller();
    release.onCheckpoint(held(STALE_QUESTION));
    await vi.advanceTimersByTimeAsync(6_000);
    await release.beforeOutput({ status: 'success', hasText: true, closesHeldBatch: true });
    await vi.advanceTimersByTimeAsync(600_000);
    expect(sent).toEqual([]);
  });

  it('a final arriving while the timed release is on its way waits for it', async () => {
    vi.useFakeTimers();
    const order: string[] = [];
    let finishSend: () => void = () => undefined;
    const release = new HeldDraftRelease({
      now: () => Date.now(),
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (timer) => clearTimeout(timer as NodeJS.Timeout),
      cancelled: () => false,
      deliverDraft: () =>
        new Promise<boolean>((resolve) => {
          finishSend = () => {
            order.push('draft');
            resolve(true);
          };
        }),
      deliverNotice: async () => true,
    });
    release.onCheckpoint(held(REPORT));
    await vi.advanceTimersByTimeAsync(90_000);
    const final = release
      .beforeOutput({ status: 'success', hasText: true, closesHeldBatch: true })
      .then(() => order.push('final'));
    await vi.advanceTimersByTimeAsync(1);
    expect(order).toEqual([]);
    finishSend();
    await final;
    expect(order).toEqual(['draft', 'final']);
  });

  it('an undelivered timed release may still go out on a failure', async () => {
    vi.useFakeTimers();
    const { release, sent, failDelivery } = controller();
    failDelivery();
    release.onCheckpoint(held(REPORT));
    await vi.advanceTimersByTimeAsync(90_000);
    await release.beforeOutput({ status: 'error', hasText: false, closesHeldBatch: false });
    expect(sent.map((entry) => entry.reason)).toEqual(['hold-timeout', 'continuation-failed']);
  });

  it('a hold without a sendable draft: the final within a minute cancels the notice', async () => {
    vi.useFakeTimers();
    const { release, sent } = controller();
    // An image turn, a draft over 24k or an old runner: no draftText.
    release.onCheckpoint(held());
    await vi.advanceTimersByTimeAsync(50_000);
    await release.beforeOutput({ status: 'success', hasText: true, closesHeldBatch: true });
    await vi.advanceTimersByTimeAsync(600_000);
    expect(sent).toEqual([]);
    // The same after a failure: the usual failure handling speaks, not
    // «пока удержан».
    const second = controller();
    second.release.onCheckpoint(held());
    await vi.advanceTimersByTimeAsync(30_000);
    await second.release.beforeOutput({ status: 'error', hasText: false, closesHeldBatch: false });
    await vi.advanceTimersByTimeAsync(600_000);
    expect(second.sent).toEqual([]);
  });

  it('a second continuation does not restart the 90 s: the newer draft goes at 90 s from the first hold', async () => {
    vi.useFakeTimers();
    const { release, sent } = controller();
    release.onCheckpoint(held(REPORT));
    await vi.advanceTimersByTimeAsync(80_000);
    const newer = `${REPORT} Плюс поправил настройки по твоему уточнению.`;
    release.onCheckpoint(held(newer));
    await vi.advanceTimersByTimeAsync(9_000);
    expect(sent).toEqual([]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(sent).toEqual([
      { kind: 'draft', reason: 'hold-timeout', text: `${HELD_DRAFT_TIMEOUT_PREFIX}\n\n${newer}` },
    ]);
    // After a draft went out, a newer hold gets its own 90 s.
    const latest = `${newer} И ещё одно.`;
    release.onCheckpoint(held(latest));
    await vi.advanceTimersByTimeAsync(89_000);
    expect(sent).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(sent).toHaveLength(2);
  });

  it('the «пока удержан» notice goes once per hold, counted from the first hold', async () => {
    vi.useFakeTimers();
    const { release, sent } = controller();
    release.onCheckpoint(held(STALE_QUESTION));
    await vi.advanceTimersByTimeAsync(40_000);
    release.onCheckpoint(held(`Готово.\n\n${STALE_QUESTION}`));
    await vi.advanceTimersByTimeAsync(20_000);
    expect(sent).toEqual([{ kind: 'notice', text: HELD_DRAFT_NOTICE_TEXT }]);
    release.onCheckpoint(held(STALE_QUESTION));
    await vi.advanceTimersByTimeAsync(600_000);
    expect(sent).toHaveLength(1);
  });

  it('an empty final after the continuation answered by send_message drops the older draft', async () => {
    vi.useFakeTimers();
    let ipc = 1; // the first turn of the run already sent one
    const { release, sent } = controller({ ipcDeliveries: () => ipc });
    release.onCheckpoint(held(REPORT));
    ipc += 1; // the continuation's send_message
    await release.beforeOutput({ status: 'success', hasText: false, closesHeldBatch: true });
    await vi.advanceTimersByTimeAsync(600_000);
    expect(sent).toEqual([]);
    // An earlier send_message (before the hold) does not count: the empty
    // final still releases the ready answer.
    const other = controller({ ipcDeliveries: () => 1 });
    other.release.onCheckpoint(held(REPORT));
    await other.release.beforeOutput({ status: 'success', hasText: false, closesHeldBatch: true });
    expect(other.sent.map((entry) => entry.reason)).toEqual(['continuation-empty']);
  });

  it('with the link check on, a draft with web links goes at 90 s without its unchecked links (L1); on a failure it goes whole', async () => {
    vi.useFakeTimers();
    const linked = `${REPORT}\nПодробности: https://example.com/release-notes`;
    const { release, sent } = controller({ linkCheckedFinal: true });
    release.onCheckpoint(held(linked));
    await vi.advanceTimersByTimeAsync(89_000);
    expect(sent).toEqual([]);
    await vi.advanceTimersByTimeAsync(1_000);
    // Until L1 it waited for the checked final however long that took; now
    // the text goes at 90 s and the unchecked links come with the final.
    expect(sent).toEqual([{
      kind: 'draft',
      reason: 'hold-timeout',
      text: `${HELD_DRAFT_TIMEOUT_PREFIX}\n\n${REPORT}\n\n${HELD_DRAFT_LINKS_LATER_NOTE}`,
    }]);
    // A draft that is mostly links has nothing to send early: the notice.
    const mostlyLinks = controller({ linkCheckedFinal: true });
    mostlyLinks.release.onCheckpoint(held('Ссылки:\nhttps://example.com/a\nhttps://example.com/b'));
    await vi.advanceTimersByTimeAsync(120_000);
    expect(mostlyLinks.sent).toEqual([{ kind: 'notice', text: HELD_DRAFT_NOTICE_TEXT }]);
    await release.beforeOutput({ status: 'error', hasText: false, closesHeldBatch: false });
    // The timed release already went out: no second copy of the text on the
    // failure, only the links it promised (review r1111, L1a).
    expect(sent).toHaveLength(2);
    expect(sent[1]).toEqual({
      kind: 'draft',
      reason: 'continuation-failed',
      text: `${HELD_DRAFT_LINKS_FAILURE_PREFIX}\n\nПодробности: https://example.com/release-notes`,
    });
    const failing = controller({ linkCheckedFinal: true });
    failing.release.onCheckpoint(held(linked));
    await failing.release.beforeOutput({ status: 'error', hasText: false, closesHeldBatch: false });
    expect(failing.sent.at(-1)).toEqual({
      kind: 'draft',
      reason: 'continuation-failed',
      text: `${HELD_DRAFT_FAILURE_PREFIX}\n\n${linked}`,
    });
    // Without the link check the timer sends it as before.
    const plain = controller();
    plain.release.onCheckpoint(held(linked));
    await vi.advanceTimersByTimeAsync(90_000);
    expect(plain.sent.map((entry) => entry.reason)).toEqual(['hold-timeout']);
    expect(releasableHeldDraft(linked, { allowWebLinks: false })).toEqual({
      text: `${REPORT}\n\n${HELD_DRAFT_LINKS_LATER_NOTE}`,
      questionRemoved: false,
    });
    expect(releasableHeldDraft(REPORT, { allowWebLinks: false })).not.toBeNull();
  });

  it('L1a: links held back on the timer are not lost when the continuation fails', async () => {
    vi.useFakeTimers();
    // Сценарий ревью r1111: варианты со ссылками, уточнение во время хода,
    // через 90 с черновик ушёл без ссылок, а продолжение сорвалось.
    const intro =
      'Нашёл три подходящих варианта квартиры в центре города, все в пределах бюджета и рядом с морем.';
    const links = [
      'Вариант 1: https://example.com/a/show/111',
      'Вариант 2: https://example.com/a/show/222',
      'Вариант 3: https://example.com/a/show/333',
    ];
    const draft = [intro, ...links].join('\n');
    const failing = controller({ linkCheckedFinal: true });
    failing.release.onCheckpoint(held(draft));
    await vi.advanceTimersByTimeAsync(90_000);
    expect(failing.sent).toEqual([{
      kind: 'draft',
      reason: 'hold-timeout',
      text: `${HELD_DRAFT_TIMEOUT_PREFIX}\n\n${intro}\n\n${HELD_DRAFT_LINKS_LATER_NOTE}`,
    }]);
    // Not all of the draft went out: the stop notice may still show it whole.
    expect(failing.marks).toEqual([null]);
    await failing.release.beforeOutput({ status: 'error', hasText: false, closesHeldBatch: false });
    expect(failing.sent[1]).toEqual({
      kind: 'draft',
      reason: 'continuation-failed',
      text: `${HELD_DRAFT_LINKS_FAILURE_PREFIX}\n\n${links.join('\n')}`,
    });
    // Now the person has all of it: the mark is the draft as handed over.
    expect(failing.marks).toEqual([null, draft]);
    // The failure template is not added on top: the links' line says «прервалось».
    expect(failing.release.releasedOnFailure).toBe(true);
    await failing.release.beforeOutput({ status: 'error', hasText: false, closesHeldBatch: false });
    expect(failing.sent).toHaveLength(2);

    // An empty final (nothing sent by send_message) owes them as well.
    const empty = controller({ linkCheckedFinal: true });
    empty.release.onCheckpoint(held(draft));
    await vi.advanceTimersByTimeAsync(90_000);
    await empty.release.beforeOutput({ status: 'success', hasText: false, closesHeldBatch: true });
    expect(empty.sent.map((entry) => entry.reason)).toEqual(['hold-timeout', 'continuation-empty']);
    expect(empty.sent[1].text).toBe(`${HELD_DRAFT_LINKS_FAILURE_PREFIX}\n\n${links.join('\n')}`);

    // The checked final keeps the promise itself: nothing extra.
    const answered = controller({ linkCheckedFinal: true });
    answered.release.onCheckpoint(held(draft));
    await vi.advanceTimersByTimeAsync(90_000);
    await answered.release.beforeOutput({ status: 'success', hasText: true, closesHeldBatch: true });
    await answered.release.beforeOutput({ status: 'error', hasText: false, closesHeldBatch: false });
    expect(answered.sent).toHaveLength(1);

    // After «стоп» nothing goes out, the links neither.
    let stopped = false;
    const stop = controller({ linkCheckedFinal: true, cancelled: () => stopped });
    stop.release.onCheckpoint(held(draft));
    await vi.advanceTimersByTimeAsync(90_000);
    stopped = true;
    await stop.release.beforeOutput({ status: 'error', hasText: false, closesHeldBatch: false });
    expect(stop.sent).toHaveLength(1);

    // A newer draft released whole on the failure carries its own links.
    const newer = controller({ linkCheckedFinal: true });
    newer.release.onCheckpoint(held(draft));
    await vi.advanceTimersByTimeAsync(90_000);
    const updated = `${intro}\nВариант 4: https://example.com/a/show/444`;
    newer.release.onCheckpoint(held(updated));
    await newer.release.beforeOutput({ status: 'error', hasText: false, closesHeldBatch: false });
    expect(newer.sent.map((entry) => entry.text)).toEqual([
      `${HELD_DRAFT_TIMEOUT_PREFIX}\n\n${intro}\n\n${HELD_DRAFT_LINKS_LATER_NOTE}`,
      `${HELD_DRAFT_FAILURE_PREFIX}\n\n${updated}`,
    ]);
    expect(newer.marks).toEqual([null, updated]);
  });

  it('a draft without links released on the timer is marked as shown whole', async () => {
    vi.useFakeTimers();
    const { release, marks } = controller({ linkCheckedFinal: true });
    release.onCheckpoint(held(REPORT));
    await vi.advanceTimersByTimeAsync(90_000);
    expect(marks).toEqual([REPORT]);
    await release.beforeOutput({ status: 'error', hasText: false, closesHeldBatch: false });
    expect(marks).toEqual([REPORT]);
  });

  it('old: on a failure a linked draft goes whole', async () => {
    vi.useFakeTimers();
    const linked = `${REPORT}\nПодробности: https://example.com/release-notes`;
    const { release, sent } = controller({ linkCheckedFinal: true });
    release.onCheckpoint(held(linked));
    await release.beforeOutput({ status: 'error', hasText: false, closesHeldBatch: false });
    expect(sent.at(-1)).toEqual({
      kind: 'draft',
      reason: 'continuation-failed',
      text: `${HELD_DRAFT_FAILURE_PREFIX}\n\n${linked}`,
    });
  });

  it('dispose stops a pending timer', async () => {
    vi.useFakeTimers();
    const { release, sent } = controller();
    release.onCheckpoint(held(REPORT));
    release.dispose();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(sent).toEqual([]);
  });
});

describe('held draft settings', () => {
  it('90 s by default, tunable without a rebuild, switched off by a file', () => {
    const key = 'SKOOBI_FINALIZE_HOLD_RELEASE_MS';
    const previous = process.env[key];
    const killSwitch = path.join(STATE_ROOT, 'store', 'held-draft-release.disabled');
    try {
      delete process.env[key];
      expect(heldDraftReleaseConfig()).toEqual({ enabled: true, releaseAfterMs: 90_000 });
      process.env[key] = '180000';
      expect(heldDraftReleaseConfig().releaseAfterMs).toBe(180_000);
      process.env[key] = '5';
      expect(heldDraftReleaseConfig().releaseAfterMs).toBe(30_000);
      process.env[key] = 'soon';
      expect(heldDraftReleaseConfig().releaseAfterMs).toBe(90_000);
      fs.mkdirSync(path.dirname(killSwitch), { recursive: true });
      fs.writeFileSync(killSwitch, '');
      expect(heldDraftReleaseConfig().enabled).toBe(false);
    } finally {
      fs.rmSync(killSwitch, { force: true });
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    }
  });
});

describe('W03 in the real dispatcher', () => {
  it('an interrupted continuation delivers the held draft once, before the failure notice', async () => {
    const keys = ['SKOOBI_SANDBOX_CODEX_PRIMARY', 'SKOOBI_FINALIZE_HOLD_GROUPS', 'SKOOBI_PROGRESS_MESSAGES_GROUPS'] as const;
    const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
    const chatJid = 'tg:100000001';
    const folder = 'held-draft-integration';
    process.env.SKOOBI_SANDBOX_CODEX_PRIMARY = 'true';
    process.env.SKOOBI_FINALIZE_HOLD_GROUPS = folder;
    process.env.SKOOBI_PROGRESS_MESSAGES_GROUPS = folder;
    try {
      const db = await import('./db.js');
      const runtime = await import('../runtimes/sandbox-runner.js');
      const loop = await import('./message-loop.js');
      const group = {
        name: 'Owner', folder, trigger: '@test', added_at: '2026-01-01T00:00:00Z',
        requiresTrigger: false, isMain: true, runtime: 'sandbox' as const,
        agentConfig: { fullAccess: true },
      };
      const channel = {
        name: 'held-draft-test', ownsJid: (jid: string) => jid === chatJid,
        isConnected: () => true, setTyping: vi.fn(async () => undefined),
        sendMessage: vi.fn(async () => undefined),
      };
      const routed: string[] = [];
      const router = {
        send: vi.fn(async (_jid: string, text: string) => { routed.push(text); }),
        route: vi.fn(async (envelope: { text: string }) => {
          routed.push(envelope.text);
          return envelope.text;
        }),
      };
      const error = 'codex continuation interrupted; pending user messages remain on disk';
      const runner = vi.fn(async (_group: unknown, input: { finalizeHold?: boolean }, _onProcess: unknown,
        onOutput?: (output: Record<string, unknown>) => Promise<void>) => {
        expect(input.finalizeHold).toBe(true);
        const checkpoint = { continuations: 1, pendingMessages: 1, readyDraftHeld: true, draftText: REPORT };
        await onOutput?.({ status: 'heartbeat', result: null, finalizeHoldCheckpoint: { ...checkpoint, reason: 'continuation_interrupted' } });
        await onOutput?.({ status: 'error', result: null, error });
        return { status: 'error' as const, result: null, error };
      });
      db.initDatabase();
      db.setRegisteredGroup(chatJid, group);
      db.storeMessage({
        id: '28040', chat_jid: chatJid, sender: '100000001', sender_name: 'Owner',
        content: 'Проверь Скуби на ноутбуке', timestamp: new Date(Date.now() - 2_000).toISOString(),
        sender_identity: {
          channel: 'telegram', chat_id: '100000001', telegram_user_id: '100000001',
          identity_id: 'telegram:100000001', bot_id: 'test', is_owner_sender: true,
          telegram_message_origin: 'direct',
        },
      });
      loop._setRegisteredGroups({ [chatJid]: group });
      loop._setChannelsForTest([channel as never]);
      vi.spyOn(runtime, 'runSandboxAgent').mockImplementation(runner as never);
      await loop.processGroupMessages(chatJid, router as never);
      expect(runner).toHaveBeenCalledTimes(1);
      const drafts = routed.filter((text) => text.startsWith(HELD_DRAFT_FAILURE_PREFIX));
      expect(drafts).toEqual([`${HELD_DRAFT_FAILURE_PREFIX}\n\n${REPORT}`]);
      expect(routed.indexOf(drafts[0])).toBe(0);
      // A later stop of the same batch (W05 parked notice) will not show it again.
      expect(db.getRouterState(`fast_fail_draft_sent:v1:${chatJid}`)).toBe(
        createHash('sha256').update(REPORT).digest('hex').slice(0, 16),
      );
    } finally {
      for (const key of keys) {
        if (previous[key] === undefined) delete process.env[key];
        else process.env[key] = previous[key];
      }
      vi.restoreAllMocks();
    }
  }, 30_000);
});

describe('L2 in the real dispatcher', () => {
  it('итог, повторивший выпущенный по таймеру черновик, уходит одной строкой', async () => {
    const keys = ['SKOOBI_SANDBOX_CODEX_PRIMARY', 'SKOOBI_FINALIZE_HOLD_GROUPS', 'SKOOBI_PROGRESS_MESSAGES_GROUPS'] as const;
    const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
    const chatJid = 'tg:100000002';
    const folder = 'held-draft-final-trim';
    process.env.SKOOBI_SANDBOX_CODEX_PRIMARY = 'true';
    process.env.SKOOBI_FINALIZE_HOLD_GROUPS = folder;
    process.env.SKOOBI_PROGRESS_MESSAGES_GROUPS = folder;
    try {
      const db = await import('./db.js');
      const runtime = await import('../runtimes/sandbox-runner.js');
      const loop = await import('./message-loop.js');
      const group = {
        name: 'Owner', folder, trigger: '@test', added_at: '2026-01-01T00:00:00Z',
        requiresTrigger: false, isMain: true, runtime: 'sandbox' as const,
        agentConfig: { fullAccess: true },
      };
      const channel = {
        name: 'held-draft-trim-test', ownsJid: (jid: string) => jid === chatJid,
        isConnected: () => true, setTyping: vi.fn(async () => undefined),
        sendMessage: vi.fn(async () => undefined),
      };
      const routed: string[] = [];
      const router = {
        send: vi.fn(async (_jid: string, text: string) => { routed.push(text); }),
        route: vi.fn(async (envelope: { text: string }) => {
          routed.push(envelope.text);
          return envelope.text;
        }),
      };
      const runner = vi.fn(async (_group: unknown, _input: unknown, _onProcess: unknown,
        onOutput?: (output: Record<string, unknown>) => Promise<void>) => {
        const checkpoint = { continuations: 1, pendingMessages: 1, readyDraftHeld: true, draftText: REPORT };
        await onOutput?.({ status: 'heartbeat', result: null, finalizeHoldCheckpoint: { ...checkpoint, reason: 'correction_pending' } });
        // The continuation takes longer than the release window.
        await vi.advanceTimersByTimeAsync(91_000);
        await onOutput?.({ status: 'success', result: `${REPORT}\n`, finalizedInputFiles: ['owner-correction.json'] });
        return { status: 'success' as const, result: null };
      });
      db.initDatabase();
      db.setRegisteredGroup(chatJid, group);
      db.storeMessage({
        id: '28041', chat_jid: chatJid, sender: '100000002', sender_name: 'Owner',
        content: 'Обнови Studio', timestamp: new Date(Date.now() - 2_000).toISOString(),
        sender_identity: {
          channel: 'telegram', chat_id: '100000002', telegram_user_id: '100000002',
          identity_id: 'telegram:100000002', bot_id: 'test', is_owner_sender: true,
          telegram_message_origin: 'direct',
        },
      });
      loop._setRegisteredGroups({ [chatJid]: group });
      loop._setChannelsForTest([channel as never]);
      vi.spyOn(runtime, 'runSandboxAgent').mockImplementation(runner as never);
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      await loop.processGroupMessages(chatJid, router as never);
      vi.useRealTimers();
      expect(runner).toHaveBeenCalledTimes(1);
      expect(routed).toEqual([
        `${HELD_DRAFT_TIMEOUT_PREFIX}\n\n${REPORT}`,
        HELD_DRAFT_FINAL_SAME_TEXT,
      ]);
    } finally {
      vi.useRealTimers();
      for (const key of keys) {
        if (previous[key] === undefined) delete process.env[key];
        else process.env[key] = previous[key];
      }
      vi.restoreAllMocks();
    }
  }, 30_000);
});

describe('L1a in the real dispatcher', () => {
  it('ссылки, придержанные по таймеру, приходят после сбоя продолжения; стоп-уведомление до того черновик не прячет', async () => {
    const keys = [
      'SKOOBI_SANDBOX_CODEX_PRIMARY',
      'SKOOBI_FINALIZE_HOLD_GROUPS',
      'SKOOBI_PROGRESS_MESSAGES_GROUPS',
      'SKOOBI_LINK_CHECK_GROUPS',
    ] as const;
    const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
    const chatJid = 'tg:100000003';
    const folder = 'held-draft-links-owed';
    process.env.SKOOBI_SANDBOX_CODEX_PRIMARY = 'true';
    process.env.SKOOBI_FINALIZE_HOLD_GROUPS = folder;
    process.env.SKOOBI_PROGRESS_MESSAGES_GROUPS = folder;
    process.env.SKOOBI_LINK_CHECK_GROUPS = folder;
    const intro =
      'Нашёл три подходящих варианта квартиры в центре города, все в пределах бюджета и рядом с морем.';
    const links = [
      'Вариант 1: https://example.com/a/show/111',
      'Вариант 2: https://example.com/a/show/222',
      'Вариант 3: https://example.com/a/show/333',
    ];
    const draft = [intro, ...links].join('\n');
    const draftKey = `fast_fail_draft_sent:v1:${chatJid}`;
    try {
      const db = await import('./db.js');
      const runtime = await import('../runtimes/sandbox-runner.js');
      const loop = await import('./message-loop.js');
      const group = {
        name: 'Owner', folder, trigger: '@test', added_at: '2026-01-01T00:00:00Z',
        requiresTrigger: false, isMain: true, runtime: 'sandbox' as const,
        agentConfig: { fullAccess: true },
      };
      const channel = {
        name: 'held-draft-links-test', ownsJid: (jid: string) => jid === chatJid,
        isConnected: () => true, setTyping: vi.fn(async () => undefined),
        sendMessage: vi.fn(async () => undefined),
      };
      const routed: string[] = [];
      const router = {
        send: vi.fn(async (_jid: string, text: string) => { routed.push(text); }),
        route: vi.fn(async (envelope: { text: string }) => {
          routed.push(envelope.text);
          return envelope.text;
        }),
      };
      let markAfterTimer: string | undefined = 'unset';
      const error = 'codex continuation interrupted; pending user messages remain on disk';
      const runner = vi.fn(async (_group: unknown, input: { linkCheck?: unknown }, _onProcess: unknown,
        onOutput?: (output: Record<string, unknown>) => Promise<void>) => {
        expect(input.linkCheck).toBeTruthy();
        const checkpoint = { continuations: 1, pendingMessages: 1, readyDraftHeld: true, draftText: draft };
        await onOutput?.({ status: 'heartbeat', result: null, finalizeHoldCheckpoint: { ...checkpoint, reason: 'correction_pending' } });
        await vi.advanceTimersByTimeAsync(91_000);
        markAfterTimer = db.getRouterState(draftKey);
        await onOutput?.({ status: 'error', result: null, error });
        return { status: 'error' as const, result: null, error };
      });
      db.initDatabase();
      db.setRegisteredGroup(chatJid, group);
      db.storeMessage({
        id: '28042', chat_jid: chatJid, sender: '100000003', sender_name: 'Owner',
        content: 'Подбери квартиры в центре города со ссылками', timestamp: new Date(Date.now() - 2_000).toISOString(),
        sender_identity: {
          channel: 'telegram', chat_id: '100000003', telegram_user_id: '100000003',
          identity_id: 'telegram:100000003', bot_id: 'test', is_owner_sender: true,
          telegram_message_origin: 'direct',
        },
      });
      loop._setRegisteredGroups({ [chatJid]: group });
      loop._setChannelsForTest([channel as never]);
      vi.spyOn(runtime, 'runSandboxAgent').mockImplementation(runner as never);
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      await loop.processGroupMessages(chatJid, router as never);
      vi.useRealTimers();
      expect(runner).toHaveBeenCalledTimes(1);
      expect(routed[0]).toBe(
        `${HELD_DRAFT_TIMEOUT_PREFIX}\n\n${intro}\n\n${HELD_DRAFT_LINKS_LATER_NOTE}`,
      );
      // Only part of the draft went on the timer: a stop then would still
      // show it whole (W05), so no mark yet.
      expect(markAfterTimer).toBeUndefined();
      expect(routed[1]).toBe(`${HELD_DRAFT_LINKS_FAILURE_PREFIX}\n\n${links.join('\n')}`);
      expect(routed.filter((text) => text.includes('example.com/a/show/111'))).toHaveLength(1);
      // Now all of it went out: the stop notice will not repeat it.
      expect(db.getRouterState(draftKey)).toBe(
        createHash('sha256').update(draft).digest('hex').slice(0, 16),
      );
    } finally {
      vi.useRealTimers();
      for (const key of keys) {
        if (previous[key] === undefined) delete process.env[key];
        else process.env[key] = previous[key];
      }
      vi.restoreAllMocks();
    }
  }, 30_000);
});

describe('итог после выпуска черновика по таймеру не повторяет его (L2)', () => {
  const DRAFT = [
    'Проверил сборку на Mac Studio.',
    '',
    '- служба перезапущена;',
    '- проверка прошла;',
    '- журнал чистый, ошибок за час нет.',
  ].join('\n');

  it('итог, почти равный черновику, сводится к одной строке', () => {
    const final = [
      'Проверил сборку на Mac Studio.',
      '',
      '- служба перезапущена;',
      '- проверка прошла;',
      '- журнал чистый, ошибок за час нет!',
    ].join('\n');
    expect(trimRepeatOfReleasedDraft(final, DRAFT)).toEqual({
      text: HELD_DRAFT_FINAL_SAME_TEXT,
      trimmed: true,
    });
  });

  it('из итога остаётся только новое, с пометкой', () => {
    const final = [
      'Проверил сборку на Mac Studio.',
      '',
      '- служба перезапущена;',
      '- проверка прошла;',
      '- журнал чистый, ошибок за час нет.',
      '',
      'По твоему уточнению: обновил и MacBook, там тоже всё прошло.',
    ].join('\n');
    expect(trimRepeatOfReleasedDraft(final, DRAFT)).toEqual({
      text: `${HELD_DRAFT_FINAL_ADDENDUM_PREFIX}\n\nПо твоему уточнению: обновил и MacBook, там тоже всё прошло.`,
      trimmed: true,
    });
  });

  it('по-настоящему новый итог уходит целиком', () => {
    const final = [
      'Учёл уточнение: Studio не трогал, обновление поставил только на MacBook.',
      'Служба на MacBook перезапущена, проверка прошла.',
      '- журнал чистый, ошибок за час нет.',
    ].join('\n');
    expect(trimRepeatOfReleasedDraft(final, DRAFT)).toEqual({ text: final, trimmed: false });
  });

  it('служебная пометка <internal> не считается новым: нет пустого «изменения и дополнения:» (L2, ревью r1111)', () => {
    const draft = [
      'Проверил отчёт за октябрь: выручка 4,2 млн, расходы 3,1 млн.',
      'Главная статья расходов — реклама, 1,4 млн.',
      'Советую урезать рекламу во втором филиале: там самая дорогая заявка.',
    ].join('\n');
    const same = trimRepeatOfReleasedDraft(
      `<internal>учёл поправку про второй филиал, ответ тот же</internal>\n${draft}`,
      draft,
    );
    expect(same).toEqual({ text: HELD_DRAFT_FINAL_SAME_TEXT, trimmed: true });
    // Многострочная пометка внутри итога — тоже не дополнение.
    const multiline = trimRepeatOfReleasedDraft(
      `${draft}\n<internal>\nпроверил ещё раз\nвсё сходится\n</internal>`,
      draft,
    );
    expect(multiline).toEqual({ text: HELD_DRAFT_FINAL_SAME_TEXT, trimmed: true });
    // Настоящее дополнение остаётся, пометка — нет.
    const addendum = trimRepeatOfReleasedDraft(
      `<internal>учёл поправку</internal>\n${draft}\nВо втором филиале заявка дороже на 30 %.`,
      draft,
    );
    expect(addendum).toEqual({
      text: `${HELD_DRAFT_FINAL_ADDENDUM_PREFIX}\n\nВо втором филиале заявка дороже на 30 %.`,
      trimmed: true,
    });
    // Итог, который почти весь новый, уходит как был (пометку вырежет отправка).
    const fresh = `<internal>x</internal>\nСовсем другой ответ про ноябрь: выручка 5 млн, расходы 2 млн.`;
    expect(trimRepeatOfReleasedDraft(fresh, draft)).toEqual({ text: fresh, trimmed: false });
  });

  it('контроллер отдаёт показанный по таймеру черновик только итогу этого удержания', async () => {
    vi.useFakeTimers();
    const { release } = controller();
    release.onCheckpoint(held(REPORT));
    await vi.advanceTimersByTimeAsync(90_000);
    await release.beforeOutput({ status: 'success', hasText: true, closesHeldBatch: true });
    expect(release.takeShownDraftForFinal()).toBe(REPORT);
    // Один раз.
    expect(release.takeShownDraftForFinal()).toBeUndefined();
    // Удержание без выпуска по таймеру — нечего сравнивать.
    release.onCheckpoint(held(REPORT));
    await vi.advanceTimersByTimeAsync(30_000);
    await release.beforeOutput({ status: 'success', hasText: true, closesHeldBatch: true });
    expect(release.takeShownDraftForFinal()).toBeUndefined();
  });

  it('черновик, выпущенный из-за сбоя, с итогом не сравнивается (итога нет)', async () => {
    vi.useFakeTimers();
    const { release } = controller();
    release.onCheckpoint(held(REPORT));
    await release.beforeOutput({ status: 'error', hasText: false, closesHeldBatch: false });
    expect(release.takeShownDraftForFinal()).toBeUndefined();
  });
});

// Review r1111 (turn-1): a correction that narrows the answer («без варианта
// 3») made the final a subset of the draft; L2 then said «ответ выше остаётся
// в силе» — with the option the person had excluded — and the corrected
// answer never came.
describe('итог, из которого уточнение убрало строки черновика, уходит целиком (turn-1)', () => {
  const OPTIONS = [
    'Подобрал варианты поставщика:',
    '1. Альфа — доставка со склада А, 3 дня, 120 000 ₸.',
    '2. Бета — доставка со склада Б, 4 дня, 115 000 ₸.',
    '3. Гамма — доставка со склада В, 2 дня, 110 000 ₸.',
    'Советую Гамму: быстрее и дешевле всех.',
  ];
  const DRAFT = OPTIONS.join('\n');

  it('итог без одного варианта — целиком, с пометкой «исправленный ответ»', () => {
    const final = OPTIONS.filter((line) => !line.startsWith('3.')).join('\n');
    expect(trimRepeatOfReleasedDraft(final, DRAFT)).toEqual({
      text: `${HELD_DRAFT_FINAL_REVISED_PREFIX}\n\n${final}`,
      trimmed: true,
    });
  });

  it('итог без строки-рекомендации не сводится к «в силе»', () => {
    const final = OPTIONS.slice(0, 4).join('\n');
    const result = trimRepeatOfReleasedDraft(final, DRAFT);
    expect(result.text).not.toBe(HELD_DRAFT_FINAL_SAME_TEXT);
    expect(result.text).toBe(`${HELD_DRAFT_FINAL_REVISED_PREFIX}\n\n${final}`);
  });

  it('длинный список без одного пункта (10 из 11) — тоже целиком', () => {
    const items = Array.from({ length: 11 }, (_, i) => `${i + 1}. Курс номер ${i + 1}: онлайн, 8 недель, с сертификатом.`);
    const final = items.filter((_, i) => i !== 6).join('\n');
    const result = trimRepeatOfReleasedDraft(final, items.join('\n'));
    expect(result.text.startsWith(HELD_DRAFT_FINAL_REVISED_PREFIX)).toBe(true);
    expect(result.text).toContain('11. Курс номер 11');
  });

  it('пометка «ссылки пришлю» из черновика пропавшей строкой не считается: итог со ссылкой — дополнение', () => {
    const shown = releasableHeldDraft(`${DRAFT}\nСсылка: https://example.com/gamma`, { allowWebLinks: false })!.text;
    expect(shown.endsWith(HELD_DRAFT_LINKS_LATER_NOTE)).toBe(true);
    const final = `${DRAFT}\nСсылка: https://example.com/gamma`;
    expect(trimRepeatOfReleasedDraft(final, shown)).toEqual({
      text: `${HELD_DRAFT_FINAL_ADDENDUM_PREFIX}\n\nСсылка: https://example.com/gamma`,
      trimmed: true,
    });
  });
});

// Review r1111 (turn-4): the timed draft promised «Ссылки пришлю в итоговом
// ответе», the link check removed every dead link, and the final collapsed to
// «ответ выше остаётся в силе» — the promise was neither kept nor withdrawn.
describe('обещанные ссылки, которых нет в итоге, снимаются словами (turn-4)', () => {
  it('итог без ссылок получает честную строку; со ссылкой — не меняется', () => {
    expect(withdrawOwedLinksPromise(HELD_DRAFT_FINAL_SAME_TEXT, { linksWereDead: true })).toBe(
      `${HELD_DRAFT_FINAL_SAME_TEXT}\n\n${HELD_DRAFT_LINKS_DEAD_NOTE}`,
    );
    // «Ссылки:» осталось без ссылок: ни голого заголовка, ни пустого «дополнения:».
    expect(withdrawOwedLinksPromise(`${HELD_DRAFT_FINAL_ADDENDUM_PREFIX}\n\nСсылки:`, { linksWereDead: true })).toBe(
      `${HELD_DRAFT_FINAL_SAME_TEXT}\n\n${HELD_DRAFT_LINKS_DEAD_NOTE}`,
    );
    expect(withdrawOwedLinksPromise(`${HELD_DRAFT_FINAL_ADDENDUM_PREFIX}\n\n1. Курс А\n2. Курс Б`, { linksWereDead: false })).toBe(
      `${HELD_DRAFT_FINAL_ADDENDUM_PREFIX}\n\n1. Курс А\n2. Курс Б\n\n${HELD_DRAFT_LINKS_DROPPED_NOTE}`,
    );
    const withLink = `${HELD_DRAFT_FINAL_ADDENDUM_PREFIX}\n\nКурс А: https://example.com/a`;
    expect(withdrawOwedLinksPromise(withLink, { linksWereDead: true })).toBe(withLink);
  });

  it('контроллер сообщает итогу об обещанных ссылках один раз и только после выпуска со ссылками', async () => {
    vi.useFakeTimers();
    const linked = `${REPORT}\nСсылки:\nhttps://example.com/a\nhttps://example.com/b`;
    const { release } = controller({ linkCheckedFinal: true });
    release.onCheckpoint(held(linked));
    await vi.advanceTimersByTimeAsync(90_000);
    await release.beforeOutput({ status: 'success', hasText: true, closesHeldBatch: true });
    expect(release.takeShownDraftForFinal()).toBe(`${REPORT}\n\n${HELD_DRAFT_LINKS_LATER_NOTE}`);
    expect(release.takeLinksPromisedForFinal()).toBe(true);
    expect(release.takeLinksPromisedForFinal()).toBe(false);
    // Выпуск без придержанных ссылок ничего не обещал.
    const plain = controller({ linkCheckedFinal: true });
    plain.release.onCheckpoint(held(REPORT));
    await vi.advanceTimersByTimeAsync(90_000);
    await plain.release.beforeOutput({ status: 'success', hasText: true, closesHeldBatch: true });
    expect(plain.release.takeLinksPromisedForFinal()).toBe(false);
  });
});

/** The real dispatcher with one held draft and one final (turn-1, turn-4). */
async function dispatchHeldDraftAndFinal(options: {
  chatJid: string;
  folder: string;
  draft: string;
  final: string;
  linkCheck?: Record<string, unknown>;
}): Promise<string[]> {
  const keys = [
    'SKOOBI_SANDBOX_CODEX_PRIMARY',
    'SKOOBI_FINALIZE_HOLD_GROUPS',
    'SKOOBI_PROGRESS_MESSAGES_GROUPS',
    'SKOOBI_LINK_CHECK_GROUPS',
  ] as const;
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  const { chatJid, folder } = options;
  process.env.SKOOBI_SANDBOX_CODEX_PRIMARY = 'true';
  process.env.SKOOBI_FINALIZE_HOLD_GROUPS = folder;
  process.env.SKOOBI_PROGRESS_MESSAGES_GROUPS = folder;
  if (options.linkCheck) process.env.SKOOBI_LINK_CHECK_GROUPS = folder;
  else delete process.env.SKOOBI_LINK_CHECK_GROUPS;
  const userId = chatJid.replace(/^tg:/, '');
  try {
    const db = await import('./db.js');
    const runtime = await import('../runtimes/sandbox-runner.js');
    const loop = await import('./message-loop.js');
    const group = {
      name: 'Owner', folder, trigger: '@test', added_at: '2026-01-01T00:00:00Z',
      requiresTrigger: false, isMain: true, runtime: 'sandbox' as const,
      agentConfig: { fullAccess: true },
    };
    const channel = {
      name: `held-draft-${folder}`, ownsJid: (jid: string) => jid === chatJid,
      isConnected: () => true, setTyping: vi.fn(async () => undefined),
      sendMessage: vi.fn(async () => undefined),
    };
    const routed: string[] = [];
    const router = {
      send: vi.fn(async (_jid: string, text: string) => { routed.push(text); }),
      route: vi.fn(async (envelope: { text: string }) => {
        routed.push(envelope.text);
        return envelope.text;
      }),
    };
    const runner = vi.fn(async (_group: unknown, _input: unknown, _onProcess: unknown,
      onOutput?: (output: Record<string, unknown>) => Promise<void>) => {
      const checkpoint = { continuations: 1, pendingMessages: 1, readyDraftHeld: true, draftText: options.draft };
      await onOutput?.({ status: 'heartbeat', result: null, finalizeHoldCheckpoint: { ...checkpoint, reason: 'correction_pending' } });
      await vi.advanceTimersByTimeAsync(91_000);
      await onOutput?.({
        status: 'success', result: options.final, finalizedInputFiles: ['owner-correction.json'],
        ...(options.linkCheck ? { linkCheck: options.linkCheck } : {}),
      });
      return { status: 'success' as const, result: null };
    });
    db.initDatabase();
    db.setRegisteredGroup(chatJid, group);
    db.storeMessage({
      id: `${userId}-1`, chat_jid: chatJid, sender: userId, sender_name: 'Owner',
      content: 'Подбери варианты', timestamp: new Date(Date.now() - 2_000).toISOString(),
      sender_identity: {
        channel: 'telegram', chat_id: userId, telegram_user_id: userId,
        identity_id: `telegram:${userId}`, bot_id: 'test', is_owner_sender: true,
        telegram_message_origin: 'direct',
      },
    });
    loop._setRegisteredGroups({ [chatJid]: group });
    loop._setChannelsForTest([channel as never]);
    vi.spyOn(runtime, 'runSandboxAgent').mockImplementation(runner as never);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    await loop.processGroupMessages(chatJid, router as never);
    vi.useRealTimers();
    expect(runner).toHaveBeenCalledTimes(1);
    return routed;
  } finally {
    vi.useRealTimers();
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
    vi.restoreAllMocks();
  }
}

describe('turn-1 и turn-4 в настоящем диспетчере', () => {
  it('turn-1: суженный уточнением итог приходит целиком, а не «в силе»', async () => {
    const draft = [
      'Подобрал варианты поставщика:',
      '1. Альфа — доставка со склада А, 3 дня, 120 000 ₸.',
      '2. Бета — доставка со склада Б, 4 дня, 115 000 ₸.',
      '3. Гамма — доставка со склада В, 2 дня, 110 000 ₸.',
      'Советую Гамму: быстрее и дешевле всех.',
    ].join('\n');
    const final = [
      'Подобрал варианты поставщика:',
      '1. Альфа — доставка со склада А, 3 дня, 120 000 ₸.',
      '2. Бета — доставка со склада Б, 4 дня, 115 000 ₸.',
    ].join('\n');
    const routed = await dispatchHeldDraftAndFinal({ chatJid: 'tg:100123', folder: 'held-draft-narrowed', draft, final });
    expect(routed).toEqual([
      `${HELD_DRAFT_TIMEOUT_PREFIX}\n\n${draft}`,
      `${HELD_DRAFT_FINAL_REVISED_PREFIX}\n\n${final}`,
    ]);
  }, 30_000);

  it('turn-4: обещанные ссылки, убранные проверкой, честно сняты в итоге', async () => {
    const intro = 'Нашёл два подходящих курса по бухгалтерии рядом с домом, оба вечерние и в пределах бюджета.';
    const draft = [intro, 'Ссылки:', 'https://example.com/course-a', 'https://example.com/course-b'].join('\n');
    const routed = await dispatchHeldDraftAndFinal({
      chatJid: 'tg:100777', folder: 'held-draft-links-dead', draft, final: intro,
      linkCheck: { mode: 'fix', found: 2, checked: 2, ok: 0, dead: 2, unknown: 0, skipped: 0, truncated: 0 },
    });
    expect(routed).toEqual([
      `${HELD_DRAFT_TIMEOUT_PREFIX}\n\n${intro}\n\n${HELD_DRAFT_LINKS_LATER_NOTE}`,
      `${HELD_DRAFT_FINAL_SAME_TEXT}\n\n${HELD_DRAFT_LINKS_DEAD_NOTE}`,
    ]);
  }, 30_000);
});
