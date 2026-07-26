// Русификация сырых данных Скуби для панели: типы событий, статусы,
// относительное время, строки лога. Чистые функции — покрыты юнит-тестами.

export type HumanEvent = {
  at: number;
  time: string;
  icon: string;
  text: string;
};

const EVENT_ICONS: Record<string, string> = {
  telegram_inbound_message: 'message',
  telegram_outbound_message: 'check',
  runtime_selected: 'cpu',
  session_finished: 'flag',
  skill_selected: 'sparkles',
  quota_checked: 'coin',
  quota_charged: 'coin',
  quota_degraded_mode_used: 'coin',
  model_gateway_live_response: 'bolt',
  error: 'alert',
  provider_failover_attempt: 'refresh',
  provider_failover_used: 'refresh',
  provider_failover_exhausted: 'alert',
  provider_circuit_opened: 'alert',
  provider_circuit_half_open: 'refresh',
  whatsapp_observer_error: 'alert',
  whatsapp_media_error: 'alert',
};

// Движки/пути ответа — по-русски (находка ревью: сырые идентификаторы
// codex_full_agent/claude_sdk на экране).
const RUNTIME_RU: Record<string, string> = {
  skoobi_live: 'быстрый ответ',
  codex_full_agent: 'полный агент Codex',
  codex_reserve: 'резерв Codex',
  claude_sdk: 'агент Claude',
  sandbox: 'агент в песочнице',
  container: 'агент в контейнере',
};

// Известные виды ошибок (payload.kind у type='error') — по-русски.
const ERROR_KIND_RU: Record<string, string> = {
  skoobi_live_model_failed: 'Движок быстрого ответа не справился',
  agent_run_failed: 'Агент не справился с задачей',
  task_run_failed: 'Задача по расписанию упала',
  whatsapp_transport_failed: 'WhatsApp временно недоступен',
  whatsapp_observer_failed: 'Синхронизация WhatsApp временно не сработала',
  whatsapp_observer_store_failed:
    'Не удалось сохранить обновление WhatsApp локально',
  whatsapp_observer_media_failed:
    'Не удалось локально обработать медиа WhatsApp',
  whatsapp_media_processing_failed:
    'Не удалось локально обработать медиа WhatsApp',
  whatsapp_media_enrichment_failed:
    'Не удалось локально обработать медиа WhatsApp',
};

const FAILOVER_REASON_RU: Record<string, string> = {
  timeout: 'не ответил вовремя, сработал резервный путь',
  http_error: 'ошибка соединения, сработал резервный путь',
  empty_response: 'пустой ответ, сработал резервный путь',
};

function payloadOf(payloadJson: string | null | undefined): any {
  if (!payloadJson) return {};
  try {
    return JSON.parse(payloadJson) || {};
  } catch {
    return {};
  }
}

function safeChatName(value: string | null | undefined): string {
  const clean = String(value || '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
  return clean || 'этот чат';
}

function humanizeErrorKind(kind: string): string | null {
  if (ERROR_KIND_RU[kind]) return ERROR_KIND_RU[kind];
  if (/voice_delivery_failed$/i.test(kind)) {
    return 'Не удалось доставить голосовой ответ';
  }
  if (/delivery_failed$/i.test(kind)) {
    return 'Не удалось доставить ответ';
  }
  if (
    /whatsapp/i.test(kind) &&
    /(observer|sync)/i.test(kind) &&
    /(fail|error|unavailable)/i.test(kind)
  ) {
    return 'Синхронизация WhatsApp временно не сработала';
  }
  if (
    /whatsapp/i.test(kind) &&
    /(media|image|video|audio|voice|document)/i.test(kind) &&
    /(fail|error|unavailable)/i.test(kind)
  ) {
    return 'Не удалось локально обработать медиа WhatsApp';
  }
  return null;
}

export function humanizeEvent(input: {
  type: string;
  created_at: number;
  chat_id?: string | null;
  payload_json?: string | null;
  chatName?: string | null;
}): HumanEvent {
  // В интерфейсе показываем только понятное имя. Сырые chat_id/JID могут
  // содержать номер телефона и не должны становиться пользовательским текстом.
  const who = safeChatName(input.chatName);
  const payload = payloadOf(input.payload_json);
  let text: string;
  switch (input.type) {
    case 'telegram_inbound_message':
      text = `Сообщение от ${who}`;
      break;
    case 'telegram_outbound_message':
      text = `Ответ доставлен: ${who}`;
      break;
    case 'runtime_selected': {
      const rt = String(payload.runtime || payload.provider || '');
      const rtRu = RUNTIME_RU[rt] || (rt ? `«${rt}»` : '');
      text = rtRu
        ? `Отвечает ${rtRu}: ${who}`
        : `Выбран способ ответа для ${who}`;
      break;
    }
    case 'session_finished':
      text = `Разговор с ${who} завершён`;
      break;
    case 'skill_selected':
      text = payload.skill
        ? `Навык «${payload.skill}» для ${who}`
        : `Выбран навык для ${who}`;
      break;
    case 'quota_charged':
      text = `Списаны кредиты: ${who}`;
      break;
    case 'quota_degraded_mode_used':
      text = `Экономный режим (квота исчерпана): ${who}`;
      break;
    case 'error': {
      const kind = String(payload.kind || '').slice(0, 80);
      const kindRu = humanizeErrorKind(kind);
      if (kindRu) {
        const reason = String(payload.failover_reason || '');
        const reasonRu = reason
          ? FAILOVER_REASON_RU[reason] ||
            'возникла ошибка, сработал резервный путь'
          : '';
        text = `${kindRu}: ${who}${reasonRu ? ` — ${reasonRu}` : ''}`;
      } else {
        // message/name/stack и неизвестный kind могут содержать путь, URL,
        // идентификатор или секрет. Для панели достаточно безопасной формулировки.
        text = `Ошибка в работе: ${who}`;
      }
      break;
    }
    case 'whatsapp_observer_error':
      text = `Синхронизация WhatsApp временно не сработала: ${who}`;
      break;
    case 'whatsapp_media_error':
      text = `Не удалось локально обработать медиа WhatsApp: ${who}`;
      break;
    case 'provider_failover_attempt':
      text = payload.guest_memory_runtime_required
        ? `Переключение на полный агент (память): ${who}`
        : `Переключение движка: ${who}`;
      break;
    case 'provider_failover_used':
      text = `Сработал резервный путь: ${who}`;
      break;
    case 'provider_failover_exhausted':
      text = `Резервные пути исчерпаны: ${who}`;
      break;
    case 'provider_circuit_opened':
      text = 'Движок временно отключён (много сбоев подряд)';
      break;
    case 'provider_circuit_half_open':
      text = 'Пробуем движок снова после сбоев';
      break;
    case 'session_started':
      text = `Разговор с ${who} начат`;
      break;
    case 'quota_blocked':
      text = `Запрос остановлен квотой: ${who}`;
      break;
    case 'payment_created':
      text = `Создан счёт на оплату: ${who}`;
      break;
    case 'payment_confirmed':
      text = `Оплата подтверждена: ${who}`;
      break;
    default:
      // Неизвестный тип может содержать внутренний идентификатор. Технические
      // подробности остаются в локальном журнале, но не на главном экране.
      text = `Служебное событие: ${who}`;
  }
  return {
    at: input.created_at,
    time: formatTimeShort(input.created_at),
    icon: EVENT_ICONS[input.type] || 'dot',
    text,
  };
}

export function formatTimeShort(epochMs: number): string {
  const d = new Date(epochMs);
  if (Number.isNaN(d.getTime())) return '';
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  if (sameDay) return hm;
  return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')} ${hm}`;
}

export function formatAgo(epochMs: number, now = Date.now()): string {
  const diff = Math.max(0, now - epochMs);
  const min = Math.floor(diff / 60_000);
  if (min < 1) return 'только что';
  if (min < 60) return `${min} мин назад`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} ч ${min % 60} м назад`;
  const d = Math.floor(h / 24);
  return `${d} дн назад`;
}

export function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} сек`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} мин ${s % 60} с`;
  const h = Math.floor(m / 60);
  return `${h} ч ${m % 60} м`;
}

// Статусы задач планировщика.
export function humanizeTaskStatus(status: string | null): string {
  switch (status) {
    case 'active':
      return 'активна';
    case 'paused':
      return 'на паузе';
    case 'completed':
      return 'завершена';
    default:
      return status || '—';
  }
}

export function humanizeSchedule(
  scheduleType: string,
  scheduleValue: string,
): string {
  if (scheduleType === 'once') {
    const d = new Date(scheduleValue);
    return Number.isNaN(d.getTime())
      ? 'один раз'
      : `один раз, ${formatTimeShort(d.getTime())}`;
  }
  if (scheduleType === 'interval') {
    const ms = Number(scheduleValue);
    return Number.isFinite(ms) && ms > 0
      ? `каждые ${formatDuration(ms)}`
      : 'по интервалу';
  }
  if (scheduleType === 'cron') return humanizeCron(scheduleValue);
  return scheduleType;
}

// Частые cron-шаблоны — по-русски (принцип панели: без жаргона на экране);
// всё нераспознанное остаётся «по расписанию (сырое выражение)».
const CRON_WEEKDAYS = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];

export function humanizeCron(value: string): string {
  const fallback = `по расписанию (${value})`;
  const parts = value.trim().split(/\s+/);
  if (parts.length !== 5) return fallback;
  const [min, hour, dom, mon, dow] = parts;
  const two = (n: string) => n.padStart(2, '0');
  const isNum = (s: string) => /^\d+$/.test(s);

  // */N * * * * — каждые N минут
  const everyN = min.match(/^\*\/(\d+)$/);
  if (everyN && hour === '*' && dom === '*' && mon === '*' && dow === '*') {
    return `каждые ${Number(everyN[1])} мин`;
  }
  // M * * * * — каждый час
  if (isNum(min) && hour === '*' && dom === '*' && mon === '*' && dow === '*') {
    return min === '0' ? 'каждый час' : `каждый час в :${two(min)}`;
  }
  if (!isNum(min) || !isNum(hour) || dom !== '*' || mon !== '*') {
    return fallback;
  }
  const at = `${two(hour)}:${two(min)}`;
  // M H * * * — ежедневно
  if (dow === '*') return `ежедневно в ${at}`;
  // M H * * 1-5 — по будням
  if (dow === '1-5') return `по будням в ${at}`;
  // M H * * D[,D…] — по дням недели (0/7 = воскресенье)
  if (/^[0-7](,[0-7])*$/.test(dow)) {
    const days = dow
      .split(',')
      .map((d) => CRON_WEEKDAYS[Number(d) % 7])
      .join(', ');
    return `по ${days} в ${at}`;
  }
  return fallback;
}

// Строка pino-pretty лога → {time, level, text}. ANSI-коды срезаются.
// Формат: «[18:15:49.641] INFO (19699): Telegram message sent».
const ANSI_RE = /\x1b\[[0-9;]*m/g;
const LOG_LINE_RE =
  /^\[(\d{2}:\d{2}:\d{2})[.\d]*\]\s+(\w+)\s+\((\d+)\):\s*(.*)$/;

export type LogLine = {
  time: string;
  level: string;
  pid: number;
  text: string;
};

export function parseLogLine(raw: string): LogLine | null {
  const clean = raw.replace(ANSI_RE, '');
  const m = clean.match(LOG_LINE_RE);
  if (!m) return null;
  return {
    time: m[1],
    level: m[2].toUpperCase(),
    pid: Number(m[3]),
    text: m[4].trim(),
  };
}

export function formatCredits(n: number): string {
  if (!Number.isFinite(n)) return '0';
  if (Math.abs(n) >= 1_000_000)
    return `${(n / 1_000_000).toFixed(1).replace('.', ',')} млн`;
  if (Math.abs(n) >= 1_000)
    return `${(n / 1_000).toFixed(1).replace('.', ',')} тыс.`;
  return String(Math.round(n));
}
