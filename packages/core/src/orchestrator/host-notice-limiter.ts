/**
 * Одно и то же служебное сообщение хоста — в чат не чаще раза в 15 минут.
 *
 * Однажды за 10 минут в один чат ушло 45 служебных сообщений: 34 раза «Продолжение
 * с твоими уточнениями прервалось…», 6 раз «⏳ Думаю дольше обычного…» и 5 раз
 * «⚠️ Не получилось обработать…» (разбор недели, W05). Ограничитель
 * стоит там, где эти сообщения рождаются, а не в outbound-router: от ответа
 * роутера зависят курсор и учёт доставки, и роутер не отличает служебную
 * фразу от законного одинакового ответа модели или напоминания. Ответы модели
 * и напоминания он не трогает.
 *
 * Ключ — (чат, вид сообщения). Отметка пишется ДО отправки и хранится в
 * router_state, поэтому переживает перезапуск службы.
 * Настоящий ответ модели в этот чат снимает все отметки чата.
 */
import { createHash } from 'crypto';

export const HOST_NOTICE_WINDOW_MS = 15 * 60 * 1000;

export type HostNoticeKind =
  | 'retry_scheduled'
  | 'retries_exhausted'
  | 'deferred_interrupted'
  | 'provider_exhausted'
  | 'policy_hold'
  | 'fast_fail_parked';

export interface HostNoticeStore {
  get: (key: string) => string | undefined;
  set: (key: string, value: string) => void;
}

const storeKey = (chatJid: string): string => `host_notice_limiter:v1:${chatJid}`;

function readSent(store: HostNoticeStore, chatJid: string): Record<string, number> {
  const raw = store.get(storeKey(chatJid));
  if (!raw) return {};
  const parsed: unknown = JSON.parse(raw);
  const out: Record<string, number> = {};
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    for (const [kind, at] of Object.entries(parsed)) {
      if (typeof at === 'number' && Number.isFinite(at)) out[kind] = at;
    }
  }
  return out;
}

/**
 * Можно ли сейчас отправить служебное сообщение этого вида в этот чат.
 * true — можно, и отправка уже отмечена; false — такое же ушло недавно.
 * Сломанное хранилище не глушит честные сообщения: тогда ответ true.
 */
export function claimHostNotice(
  store: HostNoticeStore,
  chatJid: string,
  kind: HostNoticeKind,
  nowMs = Date.now(),
  windowMs = HOST_NOTICE_WINDOW_MS,
): boolean {
  let sent: Record<string, number>;
  try {
    sent = readSent(store, chatJid);
  } catch {
    sent = {};
  }
  const last = sent[kind];
  if (last !== undefined && nowMs - last >= 0 && nowMs - last < windowMs) {
    return false;
  }
  // Старые отметки (старше окна) выбрасываются, чтобы запись не росла.
  const kept: Record<string, number> = {};
  for (const [otherKind, at] of Object.entries(sent)) {
    if (nowMs - at >= 0 && nowMs - at < windowMs) kept[otherKind] = at;
  }
  kept[kind] = nowMs;
  try {
    store.set(storeKey(chatJid), JSON.stringify(kept));
  } catch {
    /* отметка не сохранилась — сообщение всё равно уходит */
  }
  return true;
}

/** Сколько разных отказов по строкам одного вида — в чат за окно (W06). */
export const ROW_NOTICES_PER_WINDOW = 3;

/**
 * То же для сообщения про определённые строки чата (W06: «Не запускаю
 * сообщение «…»» про строку из панели). Ключ — вид плюс набор id строк:
 * отказ про НОВУЮ строку не глушится тем, что минуту назад был отказ про
 * другую (ревью r1108: вторая строка панели за 15 минут молча выбрасывалась).
 * Тот же набор строк повторно отказа не получает. Чтобы что-то, пишущее через
 * панель в ответ на отказы, не устроило петлю, разных таких отказов в окно —
 * не больше ROW_NOTICES_PER_WINDOW.
 */
export function claimHostNoticeForRows(
  store: HostNoticeStore,
  chatJid: string,
  kind: HostNoticeKind,
  rowIds: readonly string[],
  nowMs = Date.now(),
  windowMs = HOST_NOTICE_WINDOW_MS,
  maxPerWindow = ROW_NOTICES_PER_WINDOW,
): boolean {
  let sent: Record<string, number>;
  try {
    sent = readSent(store, chatJid);
  } catch {
    sent = {};
  }
  const fresh = (at: number) => nowMs - at >= 0 && nowMs - at < windowMs;
  const ids = [...new Set(rowIds)].sort();
  const key = `${kind}:${createHash('sha256')
    .update(JSON.stringify(ids))
    .digest('hex')
    .slice(0, 16)}`;
  const last = sent[key];
  if (last !== undefined && fresh(last)) return false;
  const sameKind = Object.entries(sent).filter(
    ([otherKey, at]) => otherKey.startsWith(`${kind}:`) && fresh(at),
  ).length;
  if (sameKind >= maxPerWindow) return false;
  const kept: Record<string, number> = {};
  for (const [otherKey, at] of Object.entries(sent)) {
    if (fresh(at)) kept[otherKey] = at;
  }
  kept[key] = nowMs;
  try {
    store.set(storeKey(chatJid), JSON.stringify(kept));
  } catch {
    /* отметка не сохранилась — сообщение всё равно уходит */
  }
  return true;
}

/** Настоящий ответ модели дошёл до чата: прежние отметки больше не действуют. */
export function resetHostNotices(store: HostNoticeStore, chatJid: string): void {
  try {
    const raw = store.get(storeKey(chatJid));
    if (!raw || raw === '{}') return;
    store.set(storeKey(chatJid), '{}');
  } catch {
    /* не критично: отметки истекут сами через окно */
  }
}
