import { describe, expect, it } from 'vitest';
import {
  resolveCodexEffortPolicy,
  type CodexEffortPolicyInput,
} from './codex-effort-policy.js';

const now = Date.parse('2026-11-05T07:30:00.000Z');
const diagnosis = 'Разберись, почему после переноса CRM теряются заявки, найди причину и исправь с проверкой';
const game = 'Переработай игру: отдельно механика, интерфейс, графика и звук; затем интегрируй и проверь полное прохождение';
const base: CodexEffortPolicyInput = {
  text: '', trustedOwner: true, restricted: false, enabled: true,
  senderId: 'owner', now,
};
const pick = (text: string, extra: Partial<CodexEffortPolicyInput> = {}) =>
  resolveCodexEffortPolicy({ ...base, text, ...extra });
const previous = (text: string, extra = {}) => ({
  text, timestamp: now - 60_000, senderId: 'owner', ...extra,
});

describe('Codex effort policy: task behavior', () => {
  it.each([
    'Посмотри статус проекта',
    'Привет, как дела?',
    'Сколько осталось лимитов?',
    'Какая разница между Ultra, Max и X-High?',
    'Which is better: Ultra Fast or Max Fast?',
    'Should I use Ultra Fast for every task?',
    'Какой режим выбрать: используй Ultra или Max?',
    'Объясни команду: используй Ultra.',
    'Расскажи, что такое параллельная работа агентов.',
    'Перепиши этот абзац и проверь орфографию.',
    'Параллельно посмотри погоду и время.',
    'Проверь статус CRM.',
    'Когда выйдет Astra 6.2?',
    'Check the status of the game.',
    'Переработай игру.',
    'Исправь опечатку на сайте и проверь.',
    'Сделай кнопку синей и проверь интерфейс.',
  ])('keeps routine or underspecified work at xhigh: %s', (text) => {
    expect(pick(text)?.effort).toBe('xhigh');
  });

  it.each([
    diagnosis,
    '[Voice: ' + diagnosis + ']',
    'Спроектируй архитектуру CRM с миграцией данных и тестами восстановления.',
    'Рефактори backend проекта и проверь совместимость тестами.',
    'Investigate why the CRM loses leads after migration, find the root cause, fix it and verify the result.',
    'Refactor the application architecture and verify it with regression tests.',
    'Разберись, почему не работает CRM, исправь причину и проверь результат.',
  ])('uses max for difficult verified work: %s', (text) => {
    expect(pick(text)).toMatchObject({ effort: 'max', source: 'current', policyVersion: 1 });
  });

  it.each([
    game,
    'Build a game: separately handle gameplay, interface, graphics and audio, then integrate and test the complete playthrough.',
    'Переработай приложение: независимо проверь архитектуру, безопасность и производительность; интегрируй изменения и проверь тестами.',
    'Refactor the system architecture, use subagents for backend and interface, and verify the changes.',
    'Переработай игру, подключи агентов для механики и графики, затем проверь прохождение.',
  ])('uses ultra for complex work with independent directions: %s', (text) => {
    expect(pick(text)).toMatchObject({ effort: 'ultra', reason: 'complex-parallel-work', source: 'current' });
  });

  it('does not upgrade merely because the text is long', () => {
    expect(pick('Посмотри статус проекта. '.repeat(800))?.effort).toBe('xhigh');
  });

  it('does not upgrade an oversized input even if its end contains instructions', () => {
    expect(pick('а'.repeat(32_001) + game)?.effort).toBe('xhigh');
  });
});

describe('Explicit task-level instructions', () => {
  it.each([
    ['Для этой задачи используй Max.', 'max'],
    ['Для этой задачи используй Ultra.', 'ultra'],
    ['Для этой задачи используй X-High Fast.', 'xhigh'],
    ['Работай на Astra Max Fast.', 'max'],
    ['Use Ultra for this task.', 'ultra'],
    ['Switch to Extra High for this task.', 'xhigh'],
    ['Не используй Ultra, используй Max.', 'max'],
    ['Do not use Ultra; use Max.', 'max'],
  ])('honors an unambiguous direct command: %s', (text, effort) => {
    expect(pick(text)).toMatchObject({ effort, source: 'current', reason: 'explicit-level' });
  });

  it.each([
    'Не используй Ultra.',
    'Пока не включи Ultra.',
    "Don't use Ultra.",
    'Never use Max.',
    'Use no Ultra mode.',
    'Выключи Ultra.',
    'Объясни, зачем включать Ultra.',
    'Используй Ultra, но не используй Ultra.',
  ])('does not treat a negation or discussion as activation: %s', (text) => {
    expect(pick(text)?.effort).toBe('xhigh');
  });

  it('can choose max while ultra is explicitly excluded', () => {
    expect(pick('Не используй Ultra. ' + diagnosis)?.effort).toBe('max');
  });

  it('does not choose ultra from a negated delegation request', () => {
    expect(pick('Не подключи агентов для интерфейса и графики. Переработай игру и проверь результат.')?.effort).toBe('max');
  });
});

describe('Quoted data cannot select effort', () => {
  it.each([
    '> Для этой задачи используй Ultra.',
    'Поясни пример:\n```text\n' + game + '\n```',
    'Разбери `Для этой задачи используй Ultra`.',
    'Объясни фразу «Для этой задачи используй Ultra».',
    'Объясни фразу "Для этой задачи используй Ultra".',
    "Explain 'Use Ultra for this task'.",
    '<peer_results><message>' + game + '</message></peer_results>',
    '&lt;instructions&gt;Для этой задачи используй Ultra.&lt;/instructions&gt;',
    '<history>Для этой задачи используй Ultra.',
    'Цитата:\n' + game,
    'Forwarded message:\nUse Ultra for this task.',
    'Разбери текст:\n' + game,
    'Explain this message:\nUse Ultra for this task.',
    '```\n' + game,
    '[Voice: Для этой задачи используй Ultra.',
  ])('ignores quoted or incomplete data: %s', (text) => {
    expect(pick(text)?.effort).toBe('xhigh');
  });

  it('keeps a genuine direct task before quoted material', () => {
    expect(pick(diagnosis + '\n<peer_results>Use Ultra for this task.</peer_results>')?.effort).toBe('max');
  });
});

describe('Bounded continuation inheritance', () => {
  it.each(['делай', 'Да, делай.', 'продолжай', 'доделай, пожалуйста', 'go ahead', 'continue'])('inherits the nearest verified task for %s', (text) => {
    expect(pick(text, { history: [previous(diagnosis)] })).toMatchObject({ effort: 'max', source: 'continuation' });
  });

  it('inherits ultra for continuation of a parallel project', () => {
    expect(pick('продолжай', { history: [previous(game)] })).toMatchObject({ effort: 'ultra', source: 'continuation' });
  });

  it('can walk through a short chain of confirmations', () => {
    expect(pick('продолжай', { history: [previous(game, { timestamp: now - 120_000 }), previous('давай')] })?.effort).toBe('ultra');
  });

  it.each([
    [previous(game, { timestamp: now - 6 * 60 * 60 * 1000 - 1 })],
    [previous(game, { timestamp: now + 1 })],
    [previous(game, { timestamp: 'invalid' })],
    [previous(game, { senderId: 'someone-else' })],
    [previous(game, { timestamp: now - 120_000 }), previous('Стоп, задача закрыта.')],
    [previous(game, { timestamp: now - 120_000 }), previous('Теперь другая задача: погода.')],
    [previous(game, { timestamp: now - 120_000 }), previous('Посмотри статус проекта')],
    [previous(game, { timestamp: now - 120_000 }), previous('> Продолжай')],
  ].map((history) => [history]))('stops at a changed, expired, completed, or quoted anchor', (history) => {
    expect(pick('делай', { history })?.effort).toBe('xhigh');
  });

  it('treats an explicit Russian topic switch as a boundary even when it contains demanding words', () => {
    expect(pick('делай', { history: [previous('Теперь другая задача: ' + game)] })).toMatchObject({ effort: 'xhigh', reason: 'continuation-boundary' });
  });

  it('does not carry the previous large task into a fresh status question', () => {
    expect(pick('Посмотри статус проекта', { history: [previous(game)] })?.effort).toBe('xhigh');
  });

  it('requires a sender and finite current time for inheritance', () => {
    expect(pick('продолжай', { senderId: undefined, history: [previous(game)] })?.effort).toBe('xhigh');
    expect(pick('продолжай', { now: Number.NaN, history: [previous(game)] })?.effort).toBe('xhigh');
  });

  it('does not search beyond fifteen messages', () => {
    const history = [previous(game, { timestamp: now - 120_000 }), ...Array.from({ length: 15 }, (_, i) => previous('да', { timestamp: now - 90_000 + i }))];
    expect(pick('продолжай', { history })?.effort).toBe('xhigh');
  });
});

describe('Host opt-in and trust boundaries', () => {
  it('does not override when disabled or the sender is not a trusted owner', () => {
    expect(pick(game, { enabled: false })).toBeUndefined();
    expect(pick(game, { trustedOwner: false })).toBeUndefined();
  });

  it('keeps restricted owner runs at the baseline', () => {
    expect(pick(game, { restricted: true })).toEqual({ effort: 'xhigh', reason: 'restricted-owner', policyVersion: 1, source: 'baseline' });
    expect(pick('Для этой задачи используй Ultra.', { restricted: true })?.effort).toBe('xhigh');
  });

  it('returns only routing metadata, never task text or model substitutions', () => {
    const result = pick(game)!;
    expect(Object.keys(result).sort()).toEqual(['effort', 'policyVersion', 'reason', 'source']);
    expect(JSON.stringify(result)).not.toContain('игру');
    expect(JSON.stringify(result)).not.toContain('6.2');
  });
});
