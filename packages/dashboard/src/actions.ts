import { execFile } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { promisify } from 'util';

import { logger } from '@skoobi/shared/logger';

import { writeDb } from './db.js';

import { ACCESS_CONTROL_FILE, ACTIONS_LOG_FILE, ENV_FILE } from './config.js';
import { collectMainChat, readAccessControl } from './collectors.js';
import {
  DIALOG_STATE_FILE,
  setDialogAlias,
  setDialogLink,
  setDialogPinned,
} from './dialog-state.js';
import { resolveMainServiceLabel } from './service-label.js';

const execFileAsync = promisify(execFile);
type LaunchctlExecutor = (
  file: string,
  args: string[],
  options: { timeout: number },
) => Promise<unknown>;
const defaultLaunchctlExecutor = execFileAsync as LaunchctlExecutor;

// ЕДИНСТВЕННЫЙ источник правды о том, что панель умеет менять. Всё, чего нет
// в этих таблицах, — не действие. Никакого «выполнить команду» здесь не
// появится ни под каким предлогом.
// env-тумблеры: только эти ключи, только true/false.
const ENV_TOGGLES: Record<string, string> = {
  image_generation: 'SKOOBI_IMAGE_GENERATION_ENABLED',
  payments: 'SKOOBI_PAYMENT_ENABLED',
  guest_live: 'SKOOBI_TELEGRAM_GUEST_LIVE_ENABLED',
};

export type ActionRequest = {
  type: string;
  params: Record<string, unknown>;
};

export type ActionResult = {
  ok: boolean;
  message: string;
};

function audit(entry: Record<string, unknown>): void {
  try {
    fs.mkdirSync(path.dirname(ACTIONS_LOG_FILE), { recursive: true });
    fs.appendFileSync(
      ACTIONS_LOG_FILE,
      JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n',
    );
  } catch (err) {
    logger.warn({ err }, 'dashboard: audit write failed');
  }
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

// Ошибки исполнения — по-русски (находка ревью: сырой англ. err.message в
// тостах). Типовые случаи переводим, хвост оригинала оставляем для разбора.
export function humanizeActionError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  if (/ETIMEDOUT|timed? ?out/i.test(raw))
    return 'Не получилось: команда не ответила вовремя. Попробуй ещё раз.';
  if (/ENOENT/.test(raw))
    return 'Не получилось: нужный файл не найден (подробности в журнале панели).';
  if (/EACCES|EPERM/.test(raw))
    return 'Не получилось: нет прав на это действие (подробности в журнале панели).';
  if (/Command failed/i.test(raw))
    return 'Не получилось: команда завершилась с ошибкой (подробности в журнале панели).';
  if (/SQLITE_BUSY/i.test(raw))
    return 'Не получилось: база занята ботом, попробуй через пару секунд.';
  if (/EIO|ENOSPC|EROFS|ENOTDIR|EISDIR/i.test(raw))
    return 'Не получилось сохранить локальные настройки (подробности в журнале панели).';
  return 'Не получилось выполнить действие. Подробности есть в журнале панели.';
}

// Атомарная правка .env: KEY=true/false. Бэкап с таймстампом, tmp+rename.
export function setEnvToggle(
  envKey: string,
  value: boolean,
  envFile = ENV_FILE,
): void {
  const raw = fs.readFileSync(envFile, 'utf-8');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  fs.copyFileSync(envFile, `${envFile}.bak-dashboard-${stamp}`);
  const line = `${envKey}=${value ? 'true' : 'false'}`;
  const re = new RegExp(`^${envKey}=.*$`, 'm');
  const next = re.test(raw)
    ? raw.replace(re, line)
    : raw.replace(/\n?$/, `\n${line}\n`);
  const tmp = `${envFile}.tmp-dashboard`;
  fs.writeFileSync(tmp, next, { mode: 0o600 });
  fs.renameSync(tmp, envFile);
}

// Чат со Скуби: панель вкладывает сообщение владельца в тот же конвейер,
// что и Telegram, — INSERT в messages (ядро поллит таблицу, getNewMessages;
// тем же способом работает telegram-delivery-smoke). Ответ Скуби идёт обычным
// путём: доставляется в Telegram и записывается в messages — вкладка «Чат»
// его дочитает. sender_name помечает источник («владелец (панель)»).
const PANEL_SENDER_NAME = 'Owner (dashboard)';

function readRouterValueMs(
  db: import('better-sqlite3').Database,
  key: string,
): number {
  try {
    const row = db
      .prepare('SELECT value FROM router_state WHERE key = ?')
      .get(key) as { value?: string } | undefined;
    if (!row?.value) return 0;
    const raw = JSON.parse(row.value);
    if (typeof raw === 'string') return Date.parse(raw) || 0;
    if (raw && typeof raw === 'object') {
      return Math.max(
        0,
        ...Object.values(raw).map((v) => Date.parse(String(v)) || 0),
      );
    }
    return 0;
  } catch {
    return 0;
  }
}

export function sendChatMessage(input: {
  text: string;
  mainChat: { jid: string; name: string } | null;
}): ActionResult {
  const text = String(input.text || '').trim();
  if (!text) return { ok: false, message: 'Пустое сообщение' };
  if (text.length > 4000) {
    return { ok: false, message: 'Слишком длинно (максимум 4000 символов)' };
  }
  const main = input.mainChat;
  if (!main) return { ok: false, message: 'Главный чат не найден' };

  const db = writeDb();
  // Курсор бота двигается по timestamp — вставляем строго поверх максимума
  // (та же защита, что у delivery-smoke: будущий курсор >60с = отказ).
  const lastMessage =
    (
      db.prepare('SELECT MAX(timestamp) AS ts FROM messages').get() as {
        ts?: string | null;
      }
    )?.ts || '';
  const maxSeen = Math.max(
    0,
    Date.parse(lastMessage) || 0,
    readRouterValueMs(db, 'last_timestamp'),
    readRouterValueMs(db, 'last_agent_timestamp'),
  );
  const now = Date.now();
  if (maxSeen > now + 60_000) {
    return {
      ok: false,
      message: 'Часы БД впереди на минуту+ — не рискую, сообщение не вложено',
    };
  }
  const timestamp = new Date(Math.max(now, maxSeen + 20)).toISOString();
  const id = `panel-${now}-${Math.random().toString(36).slice(2, 8)}`;

  db.prepare(
    `INSERT INTO chats (jid, name, last_message_time, channel, is_group)
     VALUES (?, ?, ?, 'telegram', 0)
     ON CONFLICT(jid) DO UPDATE SET last_message_time = excluded.last_message_time`,
  ).run(main.jid, main.name, timestamp);
  db.prepare(
    `INSERT INTO messages
       (id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message)
     VALUES (?, ?, ?, ?, ?, ?, 0, 0)`,
  ).run(
    id,
    main.jid,
    main.jid.replace(/^tg:/, ''),
    PANEL_SENDER_NAME,
    text,
    timestamp,
  );
  return {
    ok: true,
    message: 'Отправлено Скуби — ответ появится здесь и в Telegram',
  };
}

async function kickstart(
  unitKey: string,
  executeLaunchctl: LaunchctlExecutor,
): Promise<ActionResult> {
  if (unitKey !== 'main') {
    return { ok: false, message: 'Неизвестная служба' };
  }
  let label: string;
  try {
    label = resolveMainServiceLabel();
  } catch {
    return { ok: false, message: 'Некорректно настроена служба Скуби' };
  }
  const uid = typeof process.getuid === 'function' ? process.getuid() : 501;
  await executeLaunchctl(
    'launchctl',
    ['kickstart', '-k', `gui/${uid}/${label}`],
    {
      timeout: 10_000,
    },
  );
  return { ok: true, message: 'Служба перезапущена' };
}

export async function runAction(
  req: ActionRequest,
  deps: {
    accessControlFile?: string;
    dialogStateFile?: string;
    launchctlExecutor?: LaunchctlExecutor;
  } = {},
): Promise<ActionResult> {
  const aclFile = deps.accessControlFile ?? ACCESS_CONTROL_FILE;
  const dialogStateFile = deps.dialogStateFile ?? DIALOG_STATE_FILE;
  let result: ActionResult;
  try {
    switch (req.type) {
      case 'restart_service': {
        result = await kickstart(
          str(req.params.unit),
          deps.launchctlExecutor ?? defaultLaunchctlExecutor,
        );
        break;
      }

      case 'chat_send': {
        result = sendChatMessage({
          text: str(req.params.text),
          mainChat: collectMainChat(),
        });
        break;
      }

      case 'module_toggle': {
        const moduleId = str(req.params.module);
        const envKey = ENV_TOGGLES[moduleId];
        if (!envKey) {
          result = { ok: false, message: 'Такого тумблера нет' };
          break;
        }
        const value = req.params.value === true;
        setEnvToggle(envKey, value);
        result = {
          ok: true,
          message: `Настройка сохранена (${value ? 'вкл' : 'выкл'}). Применится после перезапуска Скуби.`,
        };
        break;
      }

      case 'chat_pause': {
        const jid = str(req.params.jid);
        if (!/^tg:\d{1,20}$/.test(jid)) {
          result = { ok: false, message: 'Некорректный чат' };
          break;
        }
        const value = req.params.value === true;
        // Для ЗАПИСИ файл читаем строго: существующий, но битый JSON — это
        // сигнал остановиться, а не перезаписать весь блок-лист одним чатом
        // (находка ревью). Отсутствие файла — нормально (пустой список).
        let acl: Record<string, any>;
        try {
          acl = fs.existsSync(aclFile)
            ? JSON.parse(fs.readFileSync(aclFile, 'utf-8')) || {}
            : {};
        } catch {
          result = {
            ok: false,
            message:
              'Файл настроек доступа повреждён — не трогаю его. Посмотри data/telegram-access-control.json',
          };
          break;
        }
        if (value) {
          const prior = acl[jid] || {};
          if (prior.status && prior.status !== 'paused') {
            // Чат в особом статусе (например, бан) — пауза его не перекрывает.
            result = {
              ok: false,
              message: `У чата особый статус («${prior.status}») — управляй им не с панели`,
            };
            break;
          }
          acl[jid] = {
            ...prior,
            status: 'paused',
            reason: 'пауза с панели',
            updatedAt: new Date().toISOString(),
          };
        } else if (acl[jid]) {
          if (acl[jid].status && acl[jid].status !== 'paused') {
            // Снимаем ТОЛЬКО паузу; бан и прочие статусы панель не снимает
            // (находка ревью: молчаливый разбан).
            result = {
              ok: false,
              message: `Чат не на паузе, а в статусе «${acl[jid].status}» — панель его не снимает`,
            };
            break;
          }
          delete acl[jid].status;
          delete acl[jid].reason;
          acl[jid].updatedAt = new Date().toISOString();
        }
        const tmp = `${aclFile}.tmp-dashboard`;
        fs.writeFileSync(tmp, JSON.stringify(acl, null, 2), { mode: 0o600 });
        fs.renameSync(tmp, aclFile);
        result = {
          ok: true,
          message: value ? 'Чат поставлен на паузу' : 'Чат снова активен',
        };
        break;
      }

      case 'dialog_pin': {
        setDialogPinned(
          str(req.params.jid),
          req.params.value === true,
          dialogStateFile,
        );
        result = {
          ok: true,
          message:
            req.params.value === true ? 'Диалог закреплён' : 'Диалог откреплён',
        };
        break;
      }

      case 'dialog_alias': {
        setDialogAlias(
          str(req.params.jid),
          str(req.params.value),
          dialogStateFile,
        );
        result = {
          ok: true,
          message: str(req.params.value).trim()
            ? 'Имя контакта сохранено локально'
            : 'Локальное имя удалено',
        };
        break;
      }

      case 'dialog_link': {
        setDialogLink(
          str(req.params.jid),
          str(req.params.targetJid),
          req.params.value === true,
          dialogStateFile,
        );
        result = {
          ok: true,
          message:
            req.params.value === true
              ? 'Диалоги связаны'
              : 'Связь диалогов удалена',
        };
        break;
      }

      case 'task_pause': {
        const id = str(req.params.id);
        if (!/^[\w.-]{1,80}$/.test(id)) {
          result = { ok: false, message: 'Некорректная задача' };
          break;
        }
        const value = req.params.value === true;
        const info = writeDb()
          .prepare(
            `UPDATE scheduled_tasks SET status = ? WHERE id = ? AND status != 'completed'`,
          )
          .run(value ? 'paused' : 'active', id);
        result =
          info.changes > 0
            ? {
                ok: true,
                message: value ? 'Задача на паузе' : 'Задача включена',
              }
            : { ok: false, message: 'Задача не найдена (или уже завершена)' };
        break;
      }

      case 'task_run_now': {
        const id = str(req.params.id);
        if (!/^[\w.-]{1,80}$/.test(id)) {
          result = { ok: false, message: 'Некорректная задача' };
          break;
        }
        // «Сейчас» не снимает паузу молча (находка ревью): паузная задача
        // осталась бы активной и после разового запуска.
        const info = writeDb()
          .prepare(
            `UPDATE scheduled_tasks SET next_run = ? WHERE id = ? AND status = 'active'`,
          )
          .run(new Date().toISOString(), id);
        result =
          info.changes > 0
            ? { ok: true, message: 'Запустится в ближайшую минуту' }
            : {
                ok: false,
                message:
                  'Задача не найдена или на паузе (сначала включи её кнопкой ▶)',
              };
        break;
      }

      case 'task_delete': {
        const id = str(req.params.id);
        if (!/^[\w.-]{1,80}$/.test(id)) {
          result = { ok: false, message: 'Некорректная задача' };
          break;
        }
        const db = writeDb();
        // Одна транзакция: обрыв посреди четырёх DELETE не должен оставить
        // задачу без run-логов, но живой (находка ревью).
        const deleteTaskTx = db.transaction((taskId: string) => {
          db.prepare('DELETE FROM task_run_logs WHERE task_id = ?').run(taskId);
          db.prepare('DELETE FROM task_leases WHERE task_id = ?').run(taskId);
          db.prepare('DELETE FROM calendar_event_links WHERE task_id = ?').run(
            taskId,
          );
          return db
            .prepare('DELETE FROM scheduled_tasks WHERE id = ?')
            .run(taskId).changes;
        });
        result =
          deleteTaskTx(id) > 0
            ? { ok: true, message: 'Задача удалена' }
            : { ok: false, message: 'Задача не найдена' };
        break;
      }

      default:
        result = { ok: false, message: 'Неизвестное действие' };
    }
  } catch (err) {
    logger.warn({ err, action: req.type }, 'dashboard: action failed');
    result = { ok: false, message: humanizeActionError(err) };
  }
  audit({
    action: req.type,
    // Локальные имена и связи могут содержать личные данные. В журнале
    // фиксируем сам факт изменения, но не значения и не идентификаторы чатов.
    params: req.type.startsWith('dialog_')
      ? { changed: true, value: req.params.value === true }
      : req.params,
    ok: result.ok,
    message: result.message,
    host: os.hostname(),
  });
  return result;
}
