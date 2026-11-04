import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CodexTurnResult } from './codex-exec.js';
import {
  acceptFinalizeHoldAnswer,
  answerAfterFinalizeHold,
  FINALIZE_HOLD_FALLBACK_NOTE,
  FINALIZE_HOLD_UNCHANGED_MARKER,
  FINALIZE_CONTINUATION_MAX_DRAFT_CHARS,
  finalizeHoldFallbackNote,
  isPingMessage,
  joinIpcInputWithHoldNote,
  markFailedHoldInput,
  peekIpcInputFiles,
  pipedMessageBodies,
  planFinalizeHold,
  runFinalizeHold,
  takeIpcInputFiles,
  type IpcInputFile,
} from './finalize-hold.js';

const THREAD = '01a0000-test-thread';
const START = 1_000_000;
function batch(...bodies: string[]): string {
  return (
    '<messages>\n' +
    bodies
      .map(
        (body) =>
          `<message sender="Тест" time="13:25">${body.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</message>`,
      )
      .join('\n') +
    '\n</messages>'
  );
}
function file(name: string, ...bodies: string[]): IpcInputFile {
  return { name, text: batch(...bodies), mtimeMs: START + 1000 };
}
function turn(over: Partial<CodexTurnResult> = {}): CodexTurnResult {
  return {
    status: 'success',
    text: 'Советую механику Wave: она проще.',
    threadId: THREAD,
    modelUsed: 'gpt-test',
    ...over,
  };
}
const baseInput = {
  result: turn(),
  threadId: THREAD,
  threadOk: true,
  contextFill: 0.4,
  turnStartedAt: START,
  turnDeadlineAt: START + 600_000,
};
function setup(pending: IpcInputFile[]) {
  const takePending = vi.fn();
  const markFailed = vi.fn();
  // A tripwire: production must never enter the old full-tools hold.
  const runHoldTurn = vi.fn(async () => {
    throw new Error('auxiliary hold must not run');
  });
  return {
    takePending,
    markFailed,
    runHoldTurn,
    deps: {
      peekPending: () => pending,
      takePending,
      markFailed,
      runHoldTurn,
      log: () => {},
      now: () => START + 200_000,
    },
  };
}

describe('pending message interpretation', () => {
  it('reads escaped messages and recognizes a transcribed ping', () => {
    expect(pipedMessageBodies(batch('x < y', 'да & нет'))).toEqual([
      'x < y',
      'да & нет',
    ]);
    expect(isPingMessage('[Voice: Скуби, ну как?]')).toBe(true);
    expect(isPingMessage('ну как, а заказчика поменяй на Company A')).toBe(
      false,
    );
  });
  it('a ping requires a real nonempty answer; mixed batches continue', () => {
    const plan = (text: string | null, pending: IpcInputFile[]) =>
      planFinalizeHold({
        text,
        pending,
        image: false,
        sideEffectTools: [],
        threadOk: true,
        contextFill: 0.99,
        remainingMs: 1,
      });
    expect(plan('Готово: результат приложен.', [file('1.json', 'Ау')])).toEqual(
      { action: 'ping' },
    );
    expect(plan(null, [file('1.json', 'Ау')])).toEqual({
      action: 'defer',
      reason: 'pending-followup',
    });
    expect(
      plan('Старый ответ', [file('1.json', 'Ау', 'Все на Company A')]),
    ).toEqual({ action: 'defer', reason: 'pending-followup' });
  });
});

describe('deterministic final continuation', () => {
  it('without pending messages releases exactly the original answer', async () => {
    const { deps, runHoldTurn, takePending, markFailed } = setup([]);
    expect(await runFinalizeHold(baseInput, deps)).toEqual({
      text: baseInput.result.text,
      absorbed: 0,
      failed: [],
      seen: [],
    });
    expect(runHoldTurn).not.toHaveBeenCalled();
    expect(takePending).not.toHaveBeenCalled();
    expect(markFailed).not.toHaveBeenCalled();
  });

  it('does not send the Company A-or-Company B question after the owner already answered', async () => {
    const pending = [file('1.json', 'Все на компанию А')];
    const original = 'Какого заказчика оставляем — COMPANY A или Company B?';
    const { deps, takePending, markFailed, runHoldTurn } = setup(pending);
    const out = await runFinalizeHold(
      { ...baseInput, result: turn({ text: original }) },
      deps,
    );
    expect(out).toMatchObject({
      text: null,
      deferred: true,
      absorbed: 0,
      failed: pending,
      seen: pending,
      report: {
        outcome: 'skipped',
        reason: 'pending-followup',
        newerMessages: 1,
      },
    });
    expect(markFailed).toHaveBeenCalledWith(pending, [], original);
    expect(takePending).not.toHaveBeenCalled();
    expect(runHoldTurn).not.toHaveBeenCalled();
  });

  it('a playthrough confirmation after send_document is preserved and the old question withheld', async () => {
    const pending = [file('1.json', 'да и я и другой человек прошли')];
    const original = 'ZIP отправлен. Прошёл ли игру кто-нибудь другой?';
    const { deps, markFailed, runHoldTurn } = setup(pending);
    const out = await runFinalizeHold(
      {
        ...baseInput,
        result: turn({ text: original, sideEffectTools: ['send_document'] }),
      },
      deps,
    );
    expect(out.text).toBeNull();
    expect(out.absorbed).toBe(0);
    expect(markFailed).toHaveBeenCalledWith(
      pending,
      ['send_document'],
      original,
    );
    expect(runHoldTurn).not.toHaveBeenCalled();
    const note = finalizeHoldFallbackNote(['send_document'], original);
    expect(note).toContain('не повторяй уже отправленные файлы');
    expect(note).toContain('Перед повтором проверь фактический результат');
    expect(note).toContain(original);
  });

  it.each([
    [
      'long voice',
      file(
        '1.json',
        '[Voice: Все документы на Company A. ' +
          'Это уточнение к текущей работе. '.repeat(20) +
          ']',
      ),
    ],
    [
      'attachment',
      file(
        '1.json',
        '[Document: Исправленный акт.pdf. File: received/act.pdf]',
      ),
    ],
    [
      'cancellation',
      file('1.json', 'Стоп. Ничего не публикуй и больше не отправляй.'),
    ],
    ['new objective', file('1.json', 'Отложи игру, теперь проверь договор.')],
  ])(
    '%s receives an ordinary turn without being swallowed or guessed',
    async (_name, pendingFile) => {
      const { deps, takePending, runHoldTurn } = setup([pendingFile]);
      const out = await runFinalizeHold(baseInput, deps);
      expect(out).toMatchObject({
        text: null,
        deferred: true,
        absorbed: 0,
        failed: [pendingFile],
      });
      expect(takePending).not.toHaveBeenCalled();
      expect(runHoldTurn).not.toHaveBeenCalled();
    },
  );

  it.each([
    { contextFill: 0.99 },
    { threadOk: false, threadId: undefined },
    { turnDeadlineAt: START + 200_001 },
    { result: turn({ text: null }) },
    {
      result: turn({
        imageArtifacts: [{ callId: 'i', savedPath: '/tmp/image.png' }],
      }),
    },
  ])(
    'does not release stale output on an old hold exclusion: %o',
    async (over) => {
      const pending = [file('1.json', 'В 11, а не в 10')];
      const { deps, runHoldTurn } = setup(pending);
      const out = await runFinalizeHold({ ...baseInput, ...over }, deps);
      expect(out.text).toBeNull();
      expect(out.deferred).toBe(true);
      expect(out.absorbed).toBe(0);
      expect(runHoldTurn).not.toHaveBeenCalled();
    },
  );

  it('does not incur the former 180-second hold timeout or execute its tools', async () => {
    const { deps, runHoldTurn } = setup([file('1.json', 'Все на Company A')]);
    const now = vi.fn(() => START + 200_000);
    const out = await runFinalizeHold(baseInput, { ...deps, now });
    expect(out.deferred).toBe(true);
    expect(runHoldTurn).not.toHaveBeenCalled();
    expect(out.report?.holdMs).toBeUndefined();
  });

  it('only pure pings are acknowledged by a ready final', async () => {
    const pending = [file('1.json', '[Voice: Скуби, ну как?]')];
    const { deps, takePending, markFailed } = setup(pending);
    const out = await runFinalizeHold(baseInput, deps);
    expect(out).toMatchObject({
      text: baseInput.result.text,
      absorbed: 1,
      failed: [],
      report: { outcome: 'ping' },
    });
    expect(takePending).toHaveBeenCalledWith(pending);
    expect(markFailed).not.toHaveBeenCalled();
  });
});

describe('durable continuation checkpoint', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0))
      fs.rmSync(dir, { recursive: true, force: true });
  });
  function makeDir() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'finalize-handoff-'));
    dirs.push(dir);
    return dir;
  }
  function put(dir: string, name: string, text: string) {
    fs.writeFileSync(
      path.join(dir, name),
      JSON.stringify({ type: 'message', text }),
    );
    fs.utimesSync(path.join(dir, name), new Date(START), new Date(START));
  }
  it('a _close/restart retains inputs, original result and calls without claiming delivery', async () => {
    const dir = makeDir();
    put(dir, '1.json', batch('В 11. Больше файл не отправляй.'));
    const original =
      'Учебная программа готова, файл уже отправлен. Во сколько заниматься?';
    fs.writeFileSync(path.join(dir, '_close'), '');
    const out = await runFinalizeHold(
      {
        ...baseInput,
        result: turn({ text: original, sideEffectTools: ['send_document'] }),
      },
      {
        peekPending: () => peekIpcInputFiles(dir),
        takePending: (files) => takeIpcInputFiles(dir, files),
        markFailed: (files, tools, draft) =>
          markFailedHoldInput(dir, files, () => {}, tools, draft),
        log: () => {},
      },
    );
    expect(out.absorbed).toBe(0);
    expect(fs.readdirSync(dir).sort()).toEqual(['1.json', '_close']);
    const reloaded = peekIpcInputFiles(dir);
    expect(reloaded[0]).toMatchObject({
      text: batch('В 11. Больше файл не отправляй.'),
      afterFailedHold: true,
      holdDoneTools: ['send_document'],
      holdOriginalText: original,
      mtimeMs: START,
    });
    const prompt = joinIpcInputWithHoldNote(reloaded);
    expect(prompt).toContain(original);
    expect(prompt).toContain(
      'Отправка и доставка исходного ответа или ответа доработки по этой пометке не подтверждены',
    );
    expect(prompt).toContain('не повторяй уже отправленные файлы');
    expect(prompt).toContain(
      'соблюдая отмену, смену задачи и новые ограничения',
    );
    expect(prompt).toContain('В 11. Больше файл не отправляй.');
  });
  it('checkpointing never removes a newer correction arriving after the snapshot', async () => {
    const dir = makeDir();
    put(dir, '1.json', batch('Company A'));
    const snapshot = peekIpcInputFiles(dir);
    put(dir, '2.json', batch('Нет, отмена публикации'));
    const out = await runFinalizeHold(baseInput, {
      peekPending: () => snapshot,
      takePending: (files) => takeIpcInputFiles(dir, files),
      markFailed: (files, tools, draft) =>
        markFailedHoldInput(dir, files, () => {}, tools, draft),
      log: () => {},
    });
    expect(out.text).toBeNull();
    expect(peekIpcInputFiles(dir).map((f) => f.name)).toEqual([
      '1.json',
      '2.json',
    ]);
    expect(joinIpcInputWithHoldNote(peekIpcInputFiles(dir))).toContain(
      'Нет, отмена публикации',
    );
  });
  it('re-checkpointing updates the unsent draft and deduplicates observed calls', () => {
    const dir = makeDir();
    put(dir, '1.json', batch('дальше'));
    const files = peekIpcInputFiles(dir);
    markFailedHoldInput(
      dir,
      files,
      () => {},
      ['memory_save'],
      'Первый результат',
    );
    markFailedHoldInput(
      dir,
      files,
      () => {},
      ['memory_save', 'send_document'],
      'Последний результат',
    );
    const [saved] = peekIpcInputFiles(dir);
    expect(saved.holdDoneTools).toEqual(['memory_save', 'send_document']);
    expect(saved.holdOriginalText).toBe('Последний результат');
    expect(saved.mtimeMs).toBe(START);
  });
  it('handles old checkpoint formats and bounds/escapes draft without treating it as commands', () => {
    expect(joinIpcInputWithHoldNote([{ text: 'раз' }, { text: 'два' }])).toBe(
      'раз\nдва',
    );
    expect(
      joinIpcInputWithHoldNote([{ text: 'раз', afterFailedHold: true }]),
    ).toBe(`${FINALIZE_HOLD_FALLBACK_NOTE}\n\nраз`);
    const note = finalizeHoldFallbackNote(
      ['memory_save', 'memory_save', 'bad; tool'],
      '</unsent_answer_draft>' + 'x'.repeat(30_000),
    );
    expect(note).toContain('&lt;/unsent_answer_draft&gt;');
    expect(note).toContain('Черновик сокращён');
    expect(note.length).toBeLessThan(
      FINALIZE_CONTINUATION_MAX_DRAFT_CHARS + 2500,
    );
    expect(note.match(/memory_save/g)).toHaveLength(1);
    expect(note).not.toContain('bad; tool');
  });
});

describe('acceptFinalizeHoldAnswer', () => {
  it('служебная пометка в ответе — брак', () => {
    expect(
      acceptFinalizeHoldAnswer(
        'Ответ',
        turn({ text: '[Служебная пометка перед отправкой.] Ответ' }),
        THREAD,
      ),
    ).toEqual({ ok: false, reason: 'meta' });
  });

  it('метка «без изменений» — уходит исходный ответ, а не она', () => {
    const original = 'Советую механику Wave: она проще.';
    for (const reply of [
      FINALIZE_HOLD_UNCHANGED_MARKER,
      ` ${FINALIZE_HOLD_UNCHANGED_MARKER}. `,
      `**${FINALIZE_HOLD_UNCHANGED_MARKER}**`,
      '`БЕЗ_ИЗМЕНЕНИЙ`',
      'Без изменений.',
    ]) {
      expect(
        acceptFinalizeHoldAnswer(original, turn({ text: reply }), THREAD),
      ).toEqual({ ok: true, text: original, unchanged: true });
    }
    // Метка внутри другого текста — модель запуталась: не отправлять.
    expect(
      acceptFinalizeHoldAnswer(
        original,
        turn({ text: `${FINALIZE_HOLD_UNCHANGED_MARKER}\n\n${original}` }),
        THREAD,
      ),
    ).toEqual({ ok: false, reason: 'meta' });
  });

  it('короткий ответ, ссылающийся на неотправленный, — брак, уходит исходный', () => {
    const original = 'Разбор вариантов. '.repeat(22).trim();
    expect(original.length).toBeGreaterThan(150);
    expect(original.length).toBeLessThan(600);
    for (const reply of [
      'Это ничего не меняет — ответ выше в силе.',
      'Учёл. Всё, что я написал выше, актуально.',
      'Тогда автомат, остальное см. выше.',
      'Рекомендация остаётся в силе.',
    ]) {
      expect(
        acceptFinalizeHoldAnswer(original, turn({ text: reply }), THREAD),
      ).toEqual({ ok: false, reason: 'back-reference' });
    }
    // Короткий настоящий итог проходит.
    expect(
      acceptFinalizeHoldAnswer(
        original,
        turn({ text: 'Тогда только автомат: Wave исключаем.' }),
        THREAD,
      ),
    ).toEqual({ ok: true, text: 'Тогда только автомат: Wave исключаем.' });
    // Полный итог не короче исходного может говорить «выше» сам по себе.
    const full = `${original} Если бюджет выше — смотри Ray.`;
    expect(
      acceptFinalizeHoldAnswer(original, turn({ text: full }), THREAD),
    ).toEqual({ ok: true, text: full });
  });

  it('полный итог со словами «в силе», «ничего не меняет», «без изменений» — не ссылка на ответ выше', () => {
    const original = 'Сравнение пяти вариантов. '.repeat(80).trim();
    expect(original.length).toBeGreaterThan(1900);
    const body = 'Берём автомат: Vision или Air Blade, расчёт ниже. '.repeat(
      28,
    );
    for (const phrase of [
      'Гарантия продавца остаётся в силе 12 месяцев.',
      'Это ничего не меняет в расчёте бюджета.',
      'Цена без изменений: 14 млн.',
    ]) {
      const text = `${body}${phrase}`;
      expect(text.length).toBeLessThan(original.length);
      expect(
        acceptFinalizeHoldAnswer(original, turn({ text }), THREAD),
      ).toEqual({ ok: true, text });
    }
    // Ссылка «остальное в силе» и в длинном итоге — ссылка в пустоту.
    const pointing = `${body}Остальное в силе.`;
    expect(
      acceptFinalizeHoldAnswer(original, turn({ text: pointing }), THREAD),
    ).toEqual({ ok: false, reason: 'back-reference' });
  });

  it('уточнение сузило вопрос: полный ответ короче четверти исходного проходит, огрызок — нет', () => {
    const original = 'Пять вариантов скутеров, сравнение. '.repeat(70).trim();
    expect(original.length).toBeGreaterThan(2400);
    const focused =
      'Только автомат: Honda Vision 110 и Air Blade 125. Vision дешевле и легче, ' +
      'для города хватает; Air Blade мощнее, с ним спокойнее на трассе. ' +
      'По бюджету: Vision укладывается с запасом, Air Blade — впритык. ' +
      'Если ездить вдвоём или за город — Air Blade, иначе Vision. ' +
      'Обслуживание у обоих недорогое, запчасти есть. Берём Air Blade, если бюджет позволяет. '.repeat(
        2,
      );
    expect(focused.length).toBeGreaterThan(300);
    expect(focused.length).toBeLessThan(original.length * 0.25);
    expect(
      acceptFinalizeHoldAnswer(original, turn({ text: focused }), THREAD),
    ).toEqual({ ok: true, text: focused });
    expect(
      acceptFinalizeHoldAnswer(
        original,
        turn({ text: 'Учёл: тогда автомат — Vision или Air Blade.' }),
        THREAD,
      ),
    ).toEqual({ ok: false, reason: 'too-short' });
  });

  it('короткий исходный ответ может стать коротким', () => {
    expect(
      acceptFinalizeHoldAnswer('Да.', turn({ text: 'Нет.' }), THREAD),
    ).toEqual({ ok: true, text: 'Нет.' });
  });
});

describe('ответ после доработки (порядок с проверкой ссылок)', () => {
  it('проверка ссылок получает итоговый текст и инструменты обоих ходов', () => {
    const answer = answerAfterFinalizeHold(
      turn({ sideEffectTools: ['memory_save'] }),
      {
        text: 'Итог с https://example.test/a',
        holdResult: turn({
          text: 'Итог с https://example.test/a',
          sideEffectTools: ['send_message'],
        }),
        absorbed: 1,
        failed: [],
        seen: [],
      },
    );
    expect(answer.text).toBe('Итог с https://example.test/a');
    expect(answer.sideEffectTools).toEqual(['memory_save', 'send_message']);
    expect(answer.linkFixBlockedReason).toBeUndefined();
  });

  it('после сорвавшейся доработки исправление ссылок не запускается', () => {
    const answer = answerAfterFinalizeHold(turn(), {
      text: turn().text,
      holdResult: turn({ status: 'error', text: null }),
      absorbed: 0,
      failed: [file('1.json', 'Да нужен автомат')],
      seen: [],
    });
    expect(answer.text).toBe(turn().text);
    expect(answer.linkFixBlockedReason).toBe('finalize-hold');
  });

  it('без доработки — ровно поля самого хода', () => {
    const answer = answerAfterFinalizeHold(
      turn({
        imageArtifacts: [{ callId: 'c1', savedPath: '/tmp/a.png' }],
        imageGenerationCompleted: true,
        imageGenerationCallIds: ['c1'],
      }),
      undefined,
    );
    expect(answer.text).toBe(turn().text);
    expect(answer.imageArtifacts).toEqual([
      { callId: 'c1', savedPath: '/tmp/a.png' },
    ]);
    expect(answer.imageGenerationCompleted).toBe(true);
    expect(answer.imageGenerationCallIds).toEqual(['c1']);
  });
});
