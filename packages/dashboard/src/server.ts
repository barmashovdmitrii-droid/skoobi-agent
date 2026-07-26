import { timingSafeEqual } from 'crypto';
import fs from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';

import { logger } from '@skoobi/shared/logger';

import { loadDashboardConfig, type DashboardConfig } from './config.js';
import {
  collectChatMessages,
  collectChats,
  collectLogTail,
  collectMainChat,
  collectModules,
  collectOverviewNumbers,
  collectRecentErrors,
  collectRecentEvents,
  collectServices,
  collectTasks,
} from './collectors.js';
import { runAction } from './actions.js';
import {
  collectDialogMessagePage,
  decodeDialogMessageAnchor,
  DialogHistoryInputError,
  searchDialogs,
  type DialogMessagePage,
  type DialogSearchOptions,
  type DialogSearchResult,
} from './dialog-history.js';
import {
  collectGoogleOverview,
  verifyGoogleCalendar,
  verifyGoogleWorkspace,
  type CalendarVerify,
  type GoogleOverview,
  type WorkspaceVerify,
} from './google.js';
import {
  listDashboardMediaForMessages,
  serveDashboardMedia,
  type DashboardMediaDescriptor,
} from './media.js';
import {
  collectWhatsAppStatus,
  type WhatsAppStatus,
} from './whatsapp-status.js';

const GOOGLE_VERIFY_COOLDOWN_MS = 30_000;
const GOOGLE_VERIFY_MAX_WAITERS = 4;

class GoogleVerifyRateLimitError extends Error {
  constructor(readonly retryAfterSeconds: number) {
    super('Google verification is rate-limited');
  }
}

type DashboardGoogleDeps = {
  collectOverview: () => GoogleOverview;
  verifyWorkspace: () => Promise<WorkspaceVerify>;
  verifyCalendar: () => Promise<CalendarVerify>;
  now: () => number;
};

type DashboardDialogDeps = {
  collectChats: typeof collectChats;
  collectMessagePage: (
    jid: string,
    options: { limit?: number; cursor?: string; anchor?: string },
  ) => DialogMessagePage;
  search: (
    query: string,
    limit?: number,
    options?: DialogSearchOptions,
  ) => DialogSearchResult[];
  listMedia: (
    jid: string,
    messageIds: readonly string[],
  ) => Promise<Map<string, DashboardMediaDescriptor[]>>;
  serveMedia: typeof serveDashboardMedia;
  collectWhatsAppStatus: () => WhatsAppStatus;
};

// Статика — только эти три файла, отдаются по точному имени. Никаких путей
// из запроса в файловую систему.
const WEB_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'web',
);
const STATIC_FILES: Record<string, { file: string; type: string }> = {
  '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/styles.css': { file: 'styles.css', type: 'text/css; charset=utf-8' },
  '/app.js': { file: 'app.js', type: 'text/javascript; charset=utf-8' },
};

export function tokenMatches(
  expected: string | null,
  provided: string | null | undefined,
): boolean {
  if (!expected || !provided) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(String(provided));
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function isDashboardChatJid(jid: string): boolean {
  return (
    /^tg:\d{1,20}$/.test(jid) ||
    /^\d{5,20}(?::\d{1,5})?@s\.whatsapp\.net$/.test(jid) ||
    /^\d{5,20}(?:-\d{1,20})?@g\.us$/.test(jid) ||
    /^\d{5,20}@lid$/.test(jid)
  );
}

function tokenFromRequest(req: http.IncomingMessage): string | null {
  const auth = req.headers.authorization;
  if (auth && auth.startsWith('Bearer ')) return auth.slice(7).trim();
  const cookies = String(req.headers.cookie || '');
  const m = cookies.match(/(?:^|;\s*)skoobi_dash=([^;]+)/);
  if (!m) return null;
  // Кривая percent-последовательность в куке — это «нет токена» (401),
  // а не 500 на каждый запрос (находка ревью).
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return null;
  }
}

function sendJson(res: http.ServerResponse, code: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(payload);
}

async function readBody(req: http.IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 64 * 1024) throw new Error('body too large');
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString('utf-8');
  return raw ? JSON.parse(raw) : {};
}

// Страницы до входа не могут подключить /styles.css (статика за токеном) —
// стиль инлайном, в той же палитре и с тёмной темой, что и сама панель.
const AUTH_PAGE_STYLE = `<style>
:root{--bg:#f6f5f0;--card:#fff;--text:#1c1c1a;--muted:#6b6a64;--border:#e3e1d8;--accent:#378add}
@media (prefers-color-scheme:dark){:root{--bg:#191917;--card:#232320;--text:#ecece6;--muted:#a3a29a;--border:#38372f}}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
  font-family:-apple-system,"Segoe UI",Roboto,sans-serif;background:var(--bg);color:var(--text);line-height:1.55}
.card{background:var(--card);border:1px solid var(--border);border-radius:14px;
  padding:26px 28px;max-width:400px;width:calc(100% - 32px);margin:24px auto}
.paw{font-size:30px}
h2{margin:6px 0 10px;font-size:18px}
p{margin:0 0 14px;font-size:13.5px;color:var(--muted)}
code{background:var(--bg);border:1px solid var(--border);border-radius:5px;padding:1px 5px;font-size:12px}
input{width:100%;padding:10px 12px;font-size:15px;border:1px solid var(--border);
  border-radius:8px;background:var(--bg);color:var(--text)}
button{margin-top:12px;padding:10px 18px;font-size:14.5px;border:1px solid var(--border);
  border-radius:8px;background:var(--accent);color:#fff;cursor:pointer;width:100%}
</style>`;

const NO_TOKEN_PAGE = `<!doctype html><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Скуби · локальный интерфейс</title>${AUTH_PAGE_STYLE}
<body><div class="card"><span class="paw">🐾</span>
<h2>Интерфейс не настроен</h2>
<p>В <code>.env</code> инстанса нет ключа <code>SKOOBI_DASHBOARD_TOKEN</code>
(минимум 16 символов). Добавь его и перезапусти панель — без токена данные
не отдаются.</p></div></body>`;

const LOGIN_PAGE = `<!doctype html><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Скуби · вход</title>${AUTH_PAGE_STYLE}
<body><div class="card"><span class="paw">🐾</span>
<h2>Войти к Скуби</h2>
<p>Введи токен доступа (лежит в <code>.env</code> инстанса, ключ
<code>SKOOBI_DASHBOARD_TOKEN</code>).</p>
<form method="post" action="/login">
<input type="password" name="token" autofocus aria-label="токен доступа">
<button>Войти</button>
</form></div></body>`;

export function createDashboardServer(
  config: DashboardConfig = loadDashboardConfig(),
  overrides: Partial<DashboardGoogleDeps & DashboardDialogDeps> = {},
): http.Server {
  const {
    collectChats: collectDashboardChats = collectChats,
    collectMessagePage = collectDialogMessagePage,
    search = searchDialogs,
    listMedia = listDashboardMediaForMessages,
    serveMedia = serveDashboardMedia,
    collectWhatsAppStatus: whatsappStatus = collectWhatsAppStatus,
    ...googleOverrides
  } = overrides;
  const google: DashboardGoogleDeps = {
    collectOverview: collectGoogleOverview,
    verifyWorkspace: verifyGoogleWorkspace,
    verifyCalendar: verifyGoogleCalendar,
    now: Date.now,
    ...googleOverrides,
  };
  let googleVerifyInFlight: Promise<{
    workspace: WorkspaceVerify;
    calendar: CalendarVerify;
  }> | null = null;
  let googleVerifyWaiters = 0;
  let googleVerifyLastStartedAt = Number.NEGATIVE_INFINITY;

  const runGoogleVerify = async (
    overview: GoogleOverview,
  ): Promise<{ workspace: WorkspaceVerify; calendar: CalendarVerify }> => {
    const now = google.now();
    if (googleVerifyInFlight) {
      if (googleVerifyWaiters >= GOOGLE_VERIFY_MAX_WAITERS) {
        throw new GoogleVerifyRateLimitError(1);
      }
      googleVerifyWaiters += 1;
      try {
        return await googleVerifyInFlight;
      } finally {
        googleVerifyWaiters -= 1;
      }
    }
    const elapsed = now - googleVerifyLastStartedAt;
    if (elapsed >= 0 && elapsed < GOOGLE_VERIFY_COOLDOWN_MS) {
      throw new GoogleVerifyRateLimitError(
        Math.max(1, Math.ceil((GOOGLE_VERIFY_COOLDOWN_MS - elapsed) / 1000)),
      );
    }
    googleVerifyLastStartedAt = now;
    const operation = Promise.all([
      overview.workspace.enabled
        ? google.verifyWorkspace()
        : Promise.resolve<WorkspaceVerify>({
            ok: false,
            error: 'Google Workspace выключен',
          }),
      overview.calendar.enabled
        ? google.verifyCalendar()
        : Promise.resolve<CalendarVerify>({
            ok: false,
            error: 'Google Calendar выключен',
          }),
    ]).then(([workspace, calendar]) => ({ workspace, calendar }));
    googleVerifyInFlight = operation;
    try {
      return await operation;
    } finally {
      if (googleVerifyInFlight === operation) {
        googleVerifyInFlight = null;
      }
    }
  };

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', `http://${req.headers.host}`);

      if (!config.token) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(NO_TOKEN_PAGE);
        return;
      }

      // Вход: форма кладёт токен в куку (HttpOnly, SameSite=Strict).
      if (req.method === 'POST' && url.pathname === '/login') {
        const raw = await new Promise<string>((resolve, reject) => {
          let data = '';
          req.on('data', (c) => {
            data += c;
            if (data.length > 4096) reject(new Error('too large'));
          });
          req.on('end', () => resolve(data));
          req.on('error', reject);
        });
        // x-www-form-urlencoded: сначала '+'→пробел, ПОТОМ percent-decode —
        // иначе токен с '+' внутри портится (находка ревью). Битые
        // percent-последовательности = неверный токен, а не 500.
        let token = '';
        try {
          token = decodeURIComponent(
            ((raw.match(/(?:^|&)token=([^&]*)/) || [])[1] || '').replace(
              /\+/g,
              ' ',
            ),
          );
        } catch {
          token = '';
        }
        if (!tokenMatches(config.token, token.trim())) {
          res.writeHead(401, { 'content-type': 'text/html; charset=utf-8' });
          res.end(
            LOGIN_PAGE.replace(
              '</h2>',
              '</h2><p style="color:#a32d2d">Токен не подошёл.</p>',
            ),
          );
          return;
        }
        res.writeHead(302, {
          'set-cookie': `skoobi_dash=${encodeURIComponent(token.trim())}; HttpOnly; SameSite=Strict; Path=/`,
          location: '/',
        });
        res.end();
        return;
      }

      const authed = tokenMatches(config.token, tokenFromRequest(req));

      if (url.pathname.startsWith('/api/')) {
        if (!authed) {
          sendJson(res, 401, { error: 'нужен токен' });
          return;
        }
        if (
          (req.method === 'GET' || req.method === 'HEAD') &&
          url.pathname === '/api/dialog-media'
        ) {
          const jid = url.searchParams.get('jid') || '';
          const anchor = url.searchParams.get('anchor') || '';
          const mediaId = url.searchParams.get('mediaId') || '';
          if (!isDashboardChatJid(jid) || !anchor || !mediaId) {
            sendJson(res, 400, { error: 'некорректное медиа' });
            return;
          }
          let messageId: string;
          try {
            messageId = decodeDialogMessageAnchor(jid, anchor).id;
          } catch (err) {
            if (err instanceof DialogHistoryInputError) {
              sendJson(res, 400, { error: 'некорректное медиа' });
              return;
            }
            throw err;
          }
          const result = await serveMedia(req, res, {
            jid,
            messageId,
            mediaId,
          });
          if (result === 'not-found') {
            if (req.method === 'HEAD') {
              res.writeHead(404, { 'cache-control': 'no-store' });
              res.end();
            } else {
              sendJson(res, 404, { error: 'медиа больше не хранится' });
            }
          }
          return;
        }
        if (req.method === 'GET') {
          switch (url.pathname) {
            case '/api/overview': {
              const [services] = await Promise.all([collectServices()]);
              sendJson(res, 200, {
                services,
                numbers: collectOverviewNumbers(),
                events: collectRecentEvents(12),
                // Те же ошибки, что считает бейдж «ошибок за сутки» —
                // чтобы цифра всегда была кликабельно-объяснимой.
                errors: collectRecentErrors(5),
              });
              return;
            }
            case '/api/chat': {
              const main = collectMainChat();
              sendJson(res, 200, {
                chat: main,
                messages: main ? collectChatMessages(main.jid, 60, 6000) : [],
              });
              return;
            }
            case '/api/chats':
              sendJson(res, 200, { chats: collectDashboardChats() });
              return;
            case '/api/chat-messages': {
              const jid = url.searchParams.get('jid') || '';
              if (!isDashboardChatJid(jid)) {
                sendJson(res, 400, { error: 'некорректный чат' });
                return;
              }
              const hasCursor = url.searchParams.has('cursor');
              const hasAnchor = url.searchParams.has('anchor');
              if (hasCursor && hasAnchor) {
                sendJson(res, 400, {
                  error:
                    'курсор и точку поиска нельзя использовать одновременно',
                });
                return;
              }
              const rawLimit = url.searchParams.get('limit');
              if (rawLimit !== null && !/^\d+$/u.test(rawLimit)) {
                sendJson(res, 400, { error: 'некорректный лимит' });
                return;
              }
              const parsedLimit =
                rawLimit === null ? undefined : Number(rawLimit);
              if (parsedLimit !== undefined && parsedLimit < 1) {
                sendJson(res, 400, { error: 'некорректный лимит' });
                return;
              }
              const cursor = hasCursor
                ? url.searchParams.get('cursor') || undefined
                : undefined;
              const anchor = hasAnchor
                ? url.searchParams.get('anchor') || undefined
                : undefined;
              if ((hasCursor && !cursor) || (hasAnchor && !anchor)) {
                sendJson(res, 400, { error: 'некорректный курсор' });
                return;
              }
              try {
                const page = collectMessagePage(jid, {
                  limit:
                    parsedLimit === undefined
                      ? undefined
                      : Math.min(parsedLimit, 100),
                  cursor,
                  anchor,
                });
                const idsByAnchor = new Map<string, string>();
                for (const message of page.messages) {
                  try {
                    idsByAnchor.set(
                      message.anchor,
                      decodeDialogMessageAnchor(jid, message.anchor).id,
                    );
                  } catch {
                    // A malformed injected/legacy row remains readable but has
                    // no file controls. The local path is never guessed.
                  }
                }
                const mediaByMessage = await listMedia(jid, [
                  ...new Set(idsByAnchor.values()),
                ]);
                sendJson(res, 200, {
                  ...page,
                  messages: page.messages.map((message) => ({
                    ...message,
                    media:
                      mediaByMessage.get(
                        idsByAnchor.get(message.anchor) || '',
                      ) || [],
                  })),
                });
              } catch (err) {
                if (err instanceof DialogHistoryInputError) {
                  sendJson(res, 400, { error: err.message });
                  return;
                }
                throw err;
              }
              return;
            }
            case '/api/dialog-search': {
              const rawFilter = url.searchParams.get('filter');
              const filter = rawFilter === null ? 'all' : rawFilter;
              if (
                ![
                  'all',
                  'telegram',
                  'whatsapp',
                  'media',
                  'active',
                  'important',
                ].includes(filter)
              ) {
                sendJson(res, 400, { error: 'некорректный фильтр' });
                return;
              }
              const query = (url.searchParams.get('q') || '').trim();
              const queryLength = Array.from(query).length;
              if (queryLength < 2 || queryLength > 200) {
                sendJson(res, 400, {
                  error: 'поисковый запрос должен быть от 2 до 200 символов',
                });
                return;
              }
              const rawLimit = url.searchParams.get('limit');
              if (rawLimit !== null && !/^\d+$/u.test(rawLimit)) {
                sendJson(res, 400, { error: 'некорректный лимит' });
                return;
              }
              const parsedLimit =
                rawLimit === null ? undefined : Number(rawLimit);
              if (parsedLimit !== undefined && parsedLimit < 1) {
                sendJson(res, 400, { error: 'некорректный лимит' });
                return;
              }
              let searchOptions: DialogSearchOptions | undefined;
              if (filter === 'telegram' || filter === 'whatsapp') {
                searchOptions = { channel: filter };
              } else if (filter === 'media') {
                searchOptions = { mediaOnly: true };
              } else if (filter === 'active' || filter === 'important') {
                const chats = collectDashboardChats();
                searchOptions = {
                  allowedJids: chats
                    .filter((chat) =>
                      filter === 'active'
                        ? chat.messages24h > 0
                        : chat.pinned || chat.needsReply,
                    )
                    .map((chat) => chat.jid),
                };
              }
              try {
                sendJson(res, 200, {
                  results: search(
                    query,
                    parsedLimit === undefined
                      ? undefined
                      : Math.min(parsedLimit, 80),
                    searchOptions,
                  ),
                });
              } catch (err) {
                if (err instanceof DialogHistoryInputError) {
                  sendJson(res, 400, { error: err.message });
                  return;
                }
                throw err;
              }
              return;
            }
            case '/api/whatsapp-status':
              sendJson(res, 200, whatsappStatus());
              return;
            case '/api/tasks':
              sendJson(res, 200, { tasks: collectTasks() });
              return;
            case '/api/log':
              sendJson(res, 200, {
                lines: collectLogTail({
                  onlyErrors: url.searchParams.get('errors') === '1',
                  query: url.searchParams.get('q') || '',
                }),
              });
              return;
            case '/api/modules':
              sendJson(res, 200, { modules: collectModules() });
              return;
            case '/api/google': {
              // GET is side-effect free: it never mints OAuth tokens or calls
              // Google, even if a legacy caller appends ?verify=1.
              const overview = google.collectOverview();
              sendJson(res, 200, overview);
              return;
            }
            default:
              sendJson(res, 404, { error: 'нет такого адреса' });
              return;
          }
        }
        if (req.method === 'POST' && url.pathname === '/api/google/verify') {
          const expectedOrigin = `http://${req.headers.host || ''}`;
          if (req.headers.origin !== expectedOrigin) {
            sendJson(res, 403, { error: 'проверка источника не пройдена' });
            return;
          }
          let body: unknown;
          try {
            body = await readBody(req);
          } catch {
            sendJson(res, 400, { error: 'некорректный запрос' });
            return;
          }
          if (
            !body ||
            typeof body !== 'object' ||
            Array.isArray(body) ||
            Object.keys(body as Record<string, unknown>).length !== 0
          ) {
            sendJson(res, 400, { error: 'некорректный запрос' });
            return;
          }
          const overview = google.collectOverview();
          let verify: { workspace: WorkspaceVerify; calendar: CalendarVerify };
          try {
            verify = await runGoogleVerify(overview);
          } catch (err) {
            if (err instanceof GoogleVerifyRateLimitError) {
              res.setHeader('retry-after', String(err.retryAfterSeconds));
              sendJson(res, 429, {
                error: 'проверку можно повторить чуть позже',
              });
              return;
            }
            throw err;
          }
          sendJson(res, 200, { ...overview, verify });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/action') {
          // Кривое тело — это 400 «некорректный запрос», а не 500 (ревью).
          let body: any;
          try {
            body = await readBody(req);
          } catch {
            sendJson(res, 400, { ok: false, message: 'Некорректный запрос' });
            return;
          }
          if (!body || typeof body !== 'object') {
            sendJson(res, 400, { ok: false, message: 'Некорректный запрос' });
            return;
          }
          const result = await runAction({
            type: String(body.type || ''),
            params:
              body.params && typeof body.params === 'object' ? body.params : {},
          });
          sendJson(res, result.ok ? 200 : 400, result);
          return;
        }
        sendJson(res, 405, { error: 'метод не поддерживается' });
        return;
      }

      // Статика: без токена показываем страницу входа.
      const entry = STATIC_FILES[url.pathname];
      if (!entry) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('нет такой страницы');
        return;
      }
      if (!authed) {
        res.writeHead(401, { 'content-type': 'text/html; charset=utf-8' });
        res.end(LOGIN_PAGE);
        return;
      }
      // Читаем ДО writeHead (упавший readFileSync не должен резать сокет
      // после отправленных заголовков) + CSP-страховка: только свои скрипты
      // и стили, никаких внешних источников (находки ревью).
      const content = fs.readFileSync(path.join(WEB_DIR, entry.file));
      res.writeHead(200, {
        'content-type': entry.type,
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        'content-security-policy':
          "default-src 'self'; img-src 'self' data:; media-src 'self'; object-src 'none'; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'",
      });
      res.end(content);
    } catch (err) {
      logger.warn({ err }, 'dashboard: request failed');
      sendJson(res, 500, { error: 'внутренняя ошибка панели' });
    }
  });
  return server;
}

export function startDashboard(): void {
  const config = loadDashboardConfig();
  // БД панель открывает сама (см. db.ts): read-only для экранов, rw для
  // действий. initDatabase() ядра здесь НЕ вызывается — его миграции и
  // бэкфиллы принадлежат боту, второй процесс их гонять не должен
  // (находка ревью).
  const server = createDashboardServer(config);
  server.listen(config.port, config.host, () => {
    logger.info(
      { port: config.port, host: config.host, hasToken: Boolean(config.token) },
      'Skoobi dashboard listening',
    );
  });
}
