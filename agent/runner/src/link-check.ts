/**
 * Проверка ссылок в финальном ответе перед отправкой (#10).
 *
 * Links from model memory or search snippets can be stale. Validate them
 * with bounded, injectable I/O before the runner emits its success frame.
 *
 * Что считается «мёртвой» ссылкой — только то, что точно не откроется:
 * 404/410, подтверждённые GET; домен, которого нет в DNS (два независимых
 * резолвера + канарейка, что сеть вообще есть); отказ в соединении при живой
 * сети и без прокси. Всё остальное — 401/403/429/5xx, TLS, таймауты,
 * антибот — «неизвестно» и ответ не трогает: ложная пометка хуже пропуска.
 *
 * В журнал уходят только хосты, без путей: в путях бывают приватные id.
 */

import { createHash, randomUUID } from 'crypto';
import dns from 'dns';
import fs from 'fs';
import net from 'net';
import path from 'path';

export type LinkCheckMode = 'shadow' | 'mark' | 'fix';

export const LINK_CHECK_MODES: readonly LinkCheckMode[] = [
  'shadow',
  'mark',
  'fix',
];

/** Уникальных ссылок на ответ, которые проверяются; остальные — truncated. */
export const MAX_LINKS = 12;
export const CONCURRENCY = 6;
/** Больше двух запросов на один хост сразу — и антибот начинает резать. */
export const PER_HOST = 2;
export const DNS_TIMEOUT_MS = 3_000;
export const HEAD_TIMEOUT_MS = 6_000;
export const GET_TIMEOUT_MS = 8_000;
export const PER_LINK_CAP_MS = 10_000;
/** Вся проверка ответа — не дольше этого, ответ ждёт её. */
export const CHECK_TOTAL_MS = 15_000;
/** Повторная проверка новых ссылок из исправленного ответа. */
export const RECHECK_TOTAL_MS = 10_000;
export const MAX_REDIRECTS = 5;
/**
 * Столько редиректов подряд на тот же host+path (меняется только query) —
 * антибот-петля живого магазина (Ozon: 307 → ?__rr=1 → ?__rr=2 … без конца),
 * дальше не ходим: ссылка жива, а каждый хоп стоит ~0,26 с.
 */
export const REDIRECT_LOOP_HOPS = 2;
/** Потолок хода-исправления. */
export const FIX_TURN_MAX_MS = 240_000;
/** Меньше этого остатка бюджета хода — исправление не запускается. */
export const FIX_MIN_REMAINING_MS = 60_000;
/** Запас до конца бюджета хода, который исправление не трогает. */
export const FIX_SAFETY_MS = 30_000;
/**
 * Тред почти полон: ход-исправление почти наверняка запустит сжатие контекста
 * (22–131 с без единого события), поэтому только пометка.
 */
export const FIX_MAX_CONTEXT_FILL = 0.85;
export const DEAD_MARK = ' (⚠️ ссылка не открылась)';

const BROWSER_HEADERS: Record<string, string> = {
  'user-agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
  accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'accept-language': 'ru,en;q=0.8',
};

// ── Поиск ссылок ────────────────────────────────────────────────────────────

/** Те же границы кода, что режет telegram.ts перед отправкой. */
const CODE_RE = /(```[\s\S]*?```|`[^`\n]*`)/g;
/** router.formatOutbound вырезает это до отправки. */
const INTERNAL_RE = /<internal>[\s\S]*?<\/internal>/g;
/**
 * Скобки внутри адреса — парные (`…/wiki/Foo_(bar)`): telegram.ts перед
 * отправкой кодирует их в %28/%29, и пользователь получает ровно этот адрес.
 */
const MARKDOWN_LINK_RE =
  /\[([^\]\n]{0,500})\]\((https?:\/\/[^\s()]*(?:\([^\s()]*\)[^\s()]*)*)\)/gi;
const BARE_URL_RE = /https?:\/\/[^\s<>"'`[\]]+/gi;
const TRAILING_PUNCTUATION = /[.,;:!?…»”’"*]$/;

export interface FoundLink {
  /** Как написано в ответе. */
  url: string;
  /** Без #fragment, через WHATWG URL — ключ для дедупликации. */
  normalized: string;
  kind: 'markdown' | 'bare';
  start: number;
  end: number;
  /** Куда вставлять пометку: после «)» у markdown, после самой ссылки у голой. */
  markAt: number;
}

type Range = readonly [number, number];

function rangesOf(re: RegExp, text: string): Range[] {
  const out: Range[] = [];
  for (const m of text.matchAll(new RegExp(re.source, re.flags))) {
    if (m.index === undefined) continue;
    out.push([m.index, m.index + m[0].length]);
  }
  return out;
}

function overlaps(ranges: readonly Range[], start: number, end: number) {
  return ranges.some(([a, b]) => start < b && end > a);
}

/** Голая ссылка без хвостовой пунктуации и без непарной «)». «_» не трогаем. */
function trimBareUrl(raw: string): string {
  let url = raw;
  for (;;) {
    if (TRAILING_PUNCTUATION.test(url)) {
      url = url.slice(0, -1);
      continue;
    }
    if (url.endsWith(')')) {
      const open = url.split('(').length - 1;
      const close = url.split(')').length - 1;
      if (close > open) {
        url = url.slice(0, -1);
        continue;
      }
    }
    return url;
  }
}

export function normalizeLinkUrl(raw: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  if (!parsed.hostname) return null;
  parsed.hash = '';
  return parsed.href;
}

/**
 * Все http(s)-ссылки ответа по порядку, каждое вхождение отдельно. Код
 * (`…`, ```…```) и <internal>…</internal> не трогаются: там ссылки — это
 * содержимое (эндпоинт API в примере запроса отдаёт 404 на GET и мёртвым не
 * является), а internal до пользователя не доходит вовсе.
 */
export function extractLinks(text: string): FoundLink[] {
  const protectedRanges = [
    ...rangesOf(CODE_RE, text),
    ...rangesOf(INTERNAL_RE, text),
  ];
  const links: FoundLink[] = [];
  const markdownSpans: Range[] = [];
  for (const m of text.matchAll(new RegExp(MARKDOWN_LINK_RE.source, 'gi'))) {
    if (m.index === undefined) continue;
    const start = m.index;
    const end = start + m[0].length;
    markdownSpans.push([start, end]);
    if (overlaps(protectedRanges, start, end)) continue;
    const url = m[2];
    const normalized = normalizeLinkUrl(url);
    if (!normalized) continue;
    links.push({ url, normalized, kind: 'markdown', start, end, markAt: end });
  }
  for (const m of text.matchAll(new RegExp(BARE_URL_RE.source, 'gi'))) {
    if (m.index === undefined) continue;
    const start = m.index;
    const url = trimBareUrl(m[0]);
    const end = start + url.length;
    if (url.length <= 'https://'.length) continue;
    if (overlaps(markdownSpans, start, end)) continue;
    if (overlaps(protectedRanges, start, end)) continue;
    const normalized = normalizeLinkUrl(url);
    if (!normalized) continue;
    links.push({ url, normalized, kind: 'bare', start, end, markAt: end });
  }
  return links.sort((a, b) => a.start - b.start);
}

// ── Что не проверяется ──────────────────────────────────────────────────────

const PRIVATE_V4: ReadonlyArray<readonly [string, number]> = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
];
const PRIVATE_V6: ReadonlyArray<readonly [string, number]> = [
  ['::', 128],
  ['::1', 128],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
];

let privateBlockList: net.BlockList | undefined;
function blockList(): net.BlockList {
  if (!privateBlockList) {
    const list = new net.BlockList();
    for (const [address, prefix] of PRIVATE_V4) {
      list.addSubnet(address, prefix, 'ipv4');
    }
    for (const [address, prefix] of PRIVATE_V6) {
      list.addSubnet(address, prefix, 'ipv6');
    }
    privateBlockList = list;
  }
  return privateBlockList;
}

/** Локальный, частный или служебный адрес — туда проверка не ходит. */
export function isPrivateAddress(address: string): boolean {
  const bare = address.replace(/^\[|\]$/g, '');
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(bare);
  if (mapped) return isPrivateAddress(mapped[1]);
  const family = net.isIP(bare);
  if (family === 4) return blockList().check(bare, 'ipv4');
  if (family === 6) return blockList().check(bare, 'ipv6');
  // Не адрес вовсе — считать «частным», чтобы никуда не ходить.
  return true;
}

function isPrivateHostname(
  hostname: string,
  isBlockedAddress: (address: string) => boolean = isPrivateAddress,
): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  const literal = host.replace(/^\[|\]$/g, '');
  if (net.isIP(literal)) return isBlockedAddress(literal);
  if (!host.includes('.')) return true;
  return /(^|\.)(localhost|local|lan|internal|home\.arpa|ts\.net)$/.test(host);
}

/** Всегда отвечают 200, даже на несуществующее имя: проверка ничего не скажет. */
function isUnverifiableHost(hostname: string): boolean {
  return /(^|\.)(t\.me|telegram\.me|telegram\.dog)$/i.test(hostname);
}

/**
 * Ключ запроса, по которому GET может что-то «использовать»: токен, подпись,
 * код, почта получателя. Ключ приводится к snake_case (confirmationToken →
 * confirmation_token) и проверяется целиком, по окончанию и по «сильным»
 * корням: Devise шлёт ?confirmation_token= / ?unlock_token= /
 * ?reset_password_token=, вход по ссылке — ?login_token=, рассылки — ?e=,
 * ?t=, ?h=. Лишний пропуск стоит одной непроверенной ссылки, лишняя проба —
 * чужого подтверждённого аккаунта.
 */
const SENSITIVE_QUERY_KEY_WHOLE = /^(t|e|h|tk|x_amz_\w+|x_goog_\w+)$/;
const SENSITIVE_QUERY_KEY_END =
  /(token|code|key|sig|signature|hash|otp|nonce|ticket|auth|jwt|session|sess|sid|password|passwd|pass|pwd|secret|magic|state|email|mail|phone|confirm|confirmation|verify|verification|invite|invitation|hmac|credentials?)$/;
const SENSITIVE_QUERY_KEY_ROOT =
  /token|jwt|passw|secret|signature|session|nonce|hmac|credential|confirm|verif|magic/;
/**
 * Слово пути подтверждения, входа по ссылке, приглашения, отписки, оплаты или
 * клика рассылки — на границе слова, а не только целым сегментом:
 * /users/confirmation, /confirm-email/<tok>, /auth/magic-link/<tok>,
 * /track/click. Путь заранее разбит по camelCase (/emailConfirm).
 */
const SENSITIVE_PATH_WORD =
  /(^|[/_.-])(confirm\w*|verif\w*|activat\w*|unlock|reset|password|magic|login|log-in|signin|sign-in|invite|invitations?|join|oauth\w*|authori[sz]e|callback|unsubscribe|unsub\w*|opt-?out|pay|payments?|checkout|click|clicks)(?=[/_.-]|$)/i;
/**
 * Корни тех же слов где угодно в пути, в том числе слитно:
 * /emailverification/<ток>, notion.so/loginwithemail, /resetpassword.
 * «signin» — не перед «g»: designing, assigning — это статьи, а не вход.
 */
const SENSITIVE_PATH_ROOT =
  /verif|confirm|magic|login|log[-_]in(?![a-z])|signin(?!g)|sign[-_]in(?![a-z])|unsubscrib|activat|invit|resetpass|reset[-_]pass|password/i;
/**
 * Каталоги, где непрозрачный id в адресе — публичный id трека или видео:
 * GET ничего не «использует», а выдуманный моделью id — ровно та битая
 * ссылка, ради которой проверка и есть.
 */
const PUBLIC_ID_HOST = /(^|\.)(open\.spotify\.com|youtube\.com|youtu\.be)$/i;
const UUID_LIKE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** JWT в пути или значении: заголовок и тело, оба base64url от «{"». */
const JWT_LIKE = /eyJ[\w-]{8,}\.eyJ[\w-]{8,}/;
/**
 * Трекеры кликов рассылок и «безопасные ссылки» почты: проба засчитала бы
 * клик (а где-то и подтверждение) за владельца. Список нарочно короткий —
 * только явные сервисы, плюс хосты, чья первая метка click/track/trk/email.
 */
const CLICK_TRACKER_HOST =
  /(^|\.)(list-manage\.com|mailchi\.mp|sendgrid\.net|mandrillapp\.com|mjt\.lu|pstmrk\.it|sparkpostmail\.com|hubspotlinks\.com|rs6\.net|safelinks\.protection\.outlook\.com|urldefense\.com)$/i;
const CLICK_TRACKER_LABEL = /^(click|clicks|track|tracking|trk|email)\./i;
const TEMPLATE_URL = /\{[^}]*\}|%7B|<[^>]*>|\/:[a-z_]+/i;

function splitCamelCase(value: string, separator: string): string {
  return value.replace(/([a-z0-9])([A-Z])/g, `$1${separator}$2`);
}

function isSensitiveQueryKey(key: string): boolean {
  const words = splitCamelCase(key, '_')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return (
    SENSITIVE_QUERY_KEY_WHOLE.test(words) ||
    SENSITIVE_QUERY_KEY_END.test(words) ||
    SENSITIVE_QUERY_KEY_ROOT.test(words)
  );
}

function isClickTrackerHost(hostname: string): boolean {
  return (
    CLICK_TRACKER_HOST.test(hostname) || CLICK_TRACKER_LABEL.test(hostname)
  );
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** Переходы буква↔цифра внутри куска (через «-» и «_» не считаются). */
function letterDigitSwitches(run: string): number {
  return (run.match(/[A-Za-z](?=\d)|\d(?=[A-Za-z])/g) ?? []).length;
}

/**
 * Похоже на случайный токен, а не на слаг: буквы и цифры вперемешку (не
 * меньше minSwitches переходов) или GUID. Слаг из двух и больше слов
 * (iphone-15-128gb-chernyi-113137790, some-title-3f2b9c1e7a4d) — не токен.
 */
function isOpaqueToken(
  run: string,
  minLength: number,
  minSwitches: number,
): boolean {
  if (UUID_LIKE.test(run)) return true;
  if (run.length < minLength || !/[A-Za-z]/.test(run) || !/\d/.test(run)) {
    return false;
  }
  const words = run
    .split(/[-_]+/)
    .filter((chunk) => /^[A-Za-z]{3,}$/.test(chunk));
  if (words.length >= 2) return false;
  return letterDigitSwitches(run) >= minSwitches;
}

function tokenRuns(value: string): string[] {
  return value.match(/[A-Za-z0-9_-]+/g) ?? [];
}

/**
 * Непрозрачный токен в пути или в значении параметра: от 16 знаков
 * [A-Za-z0-9_-] с буквами и цифрами вперемешку или GUID (DocuSign
 * EmailStart.aspx?a=<guid>&er=<guid>), а сразу после однобуквенного сегмента
 * (/v/, /r/, /l/, /j/ — короткие ссылки входа и приглашений) — уже от 8.
 */
function hasOpaqueToken(parsed: URL): boolean {
  if (PUBLIC_ID_HOST.test(parsed.hostname)) return false;
  const segments = parsed.pathname.split('/').map(safeDecode);
  for (let i = 0; i < segments.length; i += 1) {
    const afterLetter = i > 0 && /^[A-Za-z]$/.test(segments[i - 1]);
    for (const run of tokenRuns(segments[i])) {
      if (isOpaqueToken(run, 16, 3)) return true;
      if (afterLetter && isOpaqueToken(run, 8, 2)) return true;
    }
  }
  for (const value of parsed.searchParams.values()) {
    for (const run of tokenRuns(value)) {
      if (isOpaqueToken(run, 16, 3)) return true;
    }
  }
  return false;
}

/**
 * Ссылки, которые уже были в промптах прогона: сообщения пользователя,
 * recent_conversation_context, каждый следующий ход того же прогона.
 */
export interface PromptLinkIndex {
  text: string;
  keys: Set<string>;
}

function promptKey(normalized: string): string {
  return normalized.endsWith('/') ? normalized.slice(0, -1) : normalized;
}

/** Ссылки, которые уже есть в промпте хода (сообщение пользователя, контекст). */
export function indexPromptLinks(promptText: string): PromptLinkIndex {
  const keys = new Set<string>();
  for (const m of promptText.matchAll(new RegExp(BARE_URL_RE.source, 'gi'))) {
    const normalized = normalizeLinkUrl(trimBareUrl(m[0]));
    if (normalized) keys.add(promptKey(normalized));
  }
  return { text: promptText, keys };
}

/**
 * Добавить в индекс ссылки ещё одного промпта прогона. Следующий ход получает
 * только новое сообщение, а ссылку из прошлого модель может повторить — она
 * всё равно пришла от пользователя.
 */
export function addPromptLinks(
  index: PromptLinkIndex,
  promptText: string,
): PromptLinkIndex {
  if (!promptText) return index;
  const added = indexPromptLinks(promptText);
  return {
    text: index.text ? `${index.text}\n${promptText}` : promptText,
    keys: new Set([...index.keys, ...added.keys]),
  };
}

/**
 * Почему ссылку не проверяем (null — проверяем). Пропуск никогда не делает
 * ссылку «мёртвой».
 *
 * - частные и локальные хосты: проверка не должна стучаться во внутреннюю сеть
 *   по адресу, который придумала модель;
 * - t.me и родня: отвечают 200 на всё;
 * - трекеры кликов рассылок: проба — это клик за владельца;
 * - ссылки с токенами, подписями, кодами, непрозрачными токенами в пути или
 *   параметрах и пути подтверждения/входа/приглашения/отписки/оплаты (и
 *   слитно: /emailverification, /loginwithemail): даже GET по такой может
 *   что-то «использовать»;
 * - шаблоны ({id}, :id) — это не адрес;
 * - ссылка из промпта: её прислал пользователь или она пришла из контекста —
 *   ни «исправлять», ни дёргать её не нам.
 */
export function linkSkipReason(
  url: string,
  prompt: string | PromptLinkIndex,
): string | null {
  const normalized = normalizeLinkUrl(url);
  if (!normalized) return 'invalid';
  const parsed = new URL(normalized);
  if (isPrivateHostname(parsed.hostname)) return 'private-host';
  if (isUnverifiableHost(parsed.hostname)) return 'unverifiable';
  if (isClickTrackerHost(parsed.hostname)) return 'tracker';
  if (TEMPLATE_URL.test(url.replace(/^https?:\/\//i, ''))) return 'template';
  if (parsed.username || parsed.password) return 'sensitive';
  for (const key of parsed.searchParams.keys()) {
    if (isSensitiveQueryKey(key)) return 'sensitive';
  }
  if (
    SENSITIVE_PATH_WORD.test(splitCamelCase(parsed.pathname, '-')) ||
    SENSITIVE_PATH_ROOT.test(safeDecode(parsed.pathname))
  ) {
    return 'sensitive';
  }
  if (JWT_LIKE.test(`${parsed.pathname}${parsed.search}`)) return 'sensitive';
  if (hasOpaqueToken(parsed)) return 'sensitive';
  const index = typeof prompt === 'string' ? indexPromptLinks(prompt) : prompt;
  if (index.text) {
    const bareUrl = url.endsWith('/') ? url.slice(0, -1) : url;
    if (
      index.text.includes(url) ||
      (bareUrl.length > 'https://'.length && index.text.includes(bareUrl)) ||
      index.keys.has(promptKey(normalized))
    ) {
      return 'in-prompt';
    }
  }
  return null;
}

// ── Проба одной ссылки ──────────────────────────────────────────────────────

export type ProbeVerdict = 'ok' | 'dead' | 'unknown';

export interface ProbeResult {
  verdict: ProbeVerdict;
  /** Машинный код: http-404, nxdomain, refused, timeout, tls, budget… */
  reason: string;
  /** Для мёртвых — по-русски, для промпта исправления. */
  label?: string;
  status?: number;
  ms: number;
}

type LookupAll = (
  hostname: string,
  options: { all: true },
) => Promise<Array<{ address: string; family: number }>>;

export interface ProbeDeps {
  fetchImpl: typeof fetch;
  lookup: LookupAll;
  /** c-ares (A-записи) — второй, независимый от getaddrinfo резолвер. */
  resolve: (hostname: string) => Promise<string[]>;
  /** Есть ли вообще сеть и DNS; мемоизуется на одну проверку. */
  canary: () => Promise<boolean>;
  isBlockedAddress: (address: string) => boolean;
  /** Задан *_PROXY: «отказ в соединении» может быть отказом прокси. */
  proxyConfigured: boolean;
  /** Общий обрыв (бюджет всей проверки). */
  signal?: AbortSignal;
  now?: () => number;
  timeouts?: Partial<{
    dnsMs: number;
    headMs: number;
    getMs: number;
    perLinkMs: number;
  }>;
}

export function proxyConfiguredInEnv(env: NodeJS.ProcessEnv): boolean {
  return Object.keys(env).some(
    (key) => /^(https?|all)_proxy$/i.test(key) && Boolean(env[key]),
  );
}

async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  signal?: AbortSignal,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(Object.assign(new Error('timeout'), { code: 'ETIMEOUT' })),
          ms,
        );
        if (signal) {
          onAbort = () =>
            reject(Object.assign(new Error('aborted'), { code: 'EABORTED' }));
          if (signal.aborted) onAbort();
          else signal.addEventListener('abort', onAbort, { once: true });
        }
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    if (signal && onAbort) signal.removeEventListener('abort', onAbort);
  }
}

/** Мемоизованная канарейка: резолвится ли chatgpt.com (Codex только что туда ходил). */
export function makeDnsCanary(
  lookup: LookupAll,
  host = 'chatgpt.com',
  timeoutMs = DNS_TIMEOUT_MS,
): () => Promise<boolean> {
  let memo: Promise<boolean> | undefined;
  return () => {
    memo ??= withTimeout(lookup(host, { all: true }), timeoutMs).then(
      (addresses) => addresses.length > 0,
      () => false,
    );
    return memo;
  };
}

export function defaultProbeDeps(
  env: NodeJS.ProcessEnv = process.env,
): ProbeDeps {
  const lookup: LookupAll = (hostname, options) =>
    dns.promises.lookup(hostname, options);
  return {
    fetchImpl: fetch,
    lookup,
    resolve: (hostname) => dns.promises.resolve(hostname),
    canary: makeDnsCanary(lookup),
    isBlockedAddress: isPrivateAddress,
    proxyConfigured: proxyConfiguredInEnv(env),
  };
}

function errorCode(err: unknown): string {
  const e = err as {
    code?: unknown;
    name?: unknown;
    cause?: { code?: unknown; errors?: Array<{ code?: unknown }> };
  };
  const code =
    e?.cause?.code ?? e?.cause?.errors?.[0]?.code ?? e?.code ?? e?.name;
  return typeof code === 'string' ? code : 'unknown';
}

function linkedController(
  parent: AbortSignal | undefined,
  ms: number,
): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const onAbort = () => controller.abort(parent?.reason);
  if (parent?.aborted) controller.abort(parent.reason);
  else parent?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(
    () =>
      controller.abort(
        Object.assign(new Error('timeout'), { name: 'TimeoutError' }),
      ),
    Math.max(1, ms),
  );
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer);
      parent?.removeEventListener('abort', onAbort);
    },
  };
}

type HostCheck =
  | { kind: 'ok' }
  | { kind: 'verdict'; verdict: ProbeVerdict; reason: string; label?: string };

const DEAD_NXDOMAIN = {
  kind: 'verdict',
  verdict: 'dead',
  reason: 'nxdomain',
  label: 'домен не существует',
} as const;

/** NXDOMAIN подтверждается вторым резолвером и живой сетью, иначе — неизвестно. */
async function confirmNxdomain(
  hostname: string,
  deps: ProbeDeps,
  dnsMs: number,
  signal: AbortSignal,
): Promise<HostCheck> {
  try {
    await withTimeout(deps.resolve(hostname), dnsMs, signal);
    // c-ares нашёл адрес — getaddrinfo просто споткнулся.
    return { kind: 'verdict', verdict: 'unknown', reason: 'dns' };
  } catch (err) {
    if (errorCode(err) !== 'ENOTFOUND') {
      return { kind: 'verdict', verdict: 'unknown', reason: 'dns' };
    }
  }
  const online = await deps.canary().catch(() => false);
  return online
    ? DEAD_NXDOMAIN
    : { kind: 'verdict', verdict: 'unknown', reason: 'offline' };
}

async function checkHost(
  hostname: string,
  deps: ProbeDeps,
  dnsMs: number,
  signal: AbortSignal,
): Promise<HostCheck> {
  const host = hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host)) {
    return deps.isBlockedAddress(host)
      ? { kind: 'verdict', verdict: 'unknown', reason: 'private-address' }
      : { kind: 'ok' };
  }
  let addresses: Array<{ address: string }>;
  try {
    addresses = await withTimeout(
      deps.lookup(host, { all: true }),
      dnsMs,
      signal,
    );
  } catch (err) {
    if (signal.aborted) {
      return { kind: 'verdict', verdict: 'unknown', reason: 'budget' };
    }
    if (errorCode(err) === 'ENOTFOUND') {
      return confirmNxdomain(host, deps, dnsMs, signal);
    }
    return { kind: 'verdict', verdict: 'unknown', reason: 'dns' };
  }
  if (addresses.length === 0) {
    return { kind: 'verdict', verdict: 'unknown', reason: 'dns' };
  }
  if (addresses.some((entry) => deps.isBlockedAddress(entry.address))) {
    return { kind: 'verdict', verdict: 'unknown', reason: 'private-address' };
  }
  return { kind: 'ok' };
}

type ChainOutcome =
  | { kind: 'response'; status: number; host: string }
  | { kind: 'verdict'; verdict: ProbeVerdict; reason: string; label?: string }
  | { kind: 'error'; error: unknown; host: string };

/** Домен для сравнения хопов: `www.` не считается другим сайтом. */
function redirectDomainKey(hostname: string): string {
  return hostname.toLowerCase().replace(/^www\./, '');
}

/**
 * Один метод по цепочке редиректов вручную: каждый новый хост снова проходит
 * проверку на частный адрес — редирект во внутреннюю сеть не выполняется.
 *
 * Редиректы в пределах одного домена — признак живого сайта, а не мёртвой
 * ссылки: петля «тот же протокол+host+path, другой query» обрывается после
 * REDIRECT_LOOP_HOPS хопов ПОДРЯД как ok, исчерпание MAX_REDIRECTS на одном
 * домене — тоже ok. Только цепочка, ушедшая на другой домен, остаётся unknown
 * (26 «unknown:redirects» за 11 дней — все Ozon, все живые). Любой другой хоп
 * (смена протокола http→https, пути, хоста) сбрасывает счётчик: иначе
 * http→https + «?city=» считались петлёй, и до 404 за ними дело не доходило
 * (проверка 09.10, SR-1).
 */
async function requestChain(
  url: string,
  method: 'HEAD' | 'GET',
  deps: ProbeDeps,
  requestMs: number,
  dnsMs: number,
  linkSignal: AbortSignal,
): Promise<ChainOutcome> {
  let current = new URL(url);
  const originDomain = redirectDomainKey(current.hostname);
  let crossedDomain = false;
  let sameAddressHops = 0;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    if (hop > 0) {
      if (current.protocol !== 'http:' && current.protocol !== 'https:') {
        return {
          kind: 'verdict',
          verdict: 'unknown',
          reason: 'redirect-scheme',
        };
      }
      if (isPrivateHostname(current.hostname, deps.isBlockedAddress)) {
        return {
          kind: 'verdict',
          verdict: 'unknown',
          reason: 'private-redirect',
        };
      }
    }
    const host = await checkHost(current.hostname, deps, dnsMs, linkSignal);
    if (host.kind === 'verdict') {
      // Мёртвый домен в середине цепочки — не наш вывод: исходная ссылка жива.
      if (hop > 0 && host.verdict === 'dead') {
        return { kind: 'verdict', verdict: 'unknown', reason: 'redirect-dns' };
      }
      return host;
    }
    const request = linkedController(linkSignal, requestMs);
    let response: Response;
    try {
      response = await deps.fetchImpl(current.href, {
        method,
        redirect: 'manual',
        headers: BROWSER_HEADERS,
        signal: request.signal,
      });
    } catch (error) {
      return { kind: 'error', error, host: current.hostname };
    } finally {
      request.dispose();
    }
    try {
      // Тело не нужно: только статус. Незачем качать страницу целиком.
      await response.body?.cancel();
    } catch {
      /* уже закрыто */
    }
    const status = response.status;
    const location = response.headers.get('location');
    if (status >= 300 && status < 400 && location) {
      let next: URL;
      try {
        next = new URL(location, current);
      } catch {
        return {
          kind: 'verdict',
          verdict: 'unknown',
          reason: 'redirect-invalid',
        };
      }
      if (redirectDomainKey(next.hostname) !== originDomain) {
        crossedDomain = true;
        sameAddressHops = 0;
      } else if (
        !crossedDomain &&
        next.protocol === current.protocol &&
        next.hostname === current.hostname &&
        next.pathname === current.pathname &&
        next.search !== current.search
      ) {
        sameAddressHops += 1;
        if (sameAddressHops >= REDIRECT_LOOP_HOPS) {
          return {
            kind: 'verdict',
            verdict: 'ok',
            reason: 'redirect-loop-alive',
          };
        }
      } else {
        sameAddressHops = 0;
      }
      current = next;
      continue;
    }
    return { kind: 'response', status, host: current.hostname };
  }
  return crossedDomain
    ? { kind: 'verdict', verdict: 'unknown', reason: 'redirects' }
    : { kind: 'verdict', verdict: 'ok', reason: 'redirect-exhausted' };
}

/** Хостинги кода отвечают 404 на приватный репозиторий — это не «мёртвая». */
const PRIVATE_OR_MISSING_HOSTS =
  /(^|\.)(github\.com|gist\.github\.com|raw\.githubusercontent\.com|gitlab\.com|bitbucket\.org)$/i;

async function classifyFetchError(
  error: unknown,
  host: string,
  deps: ProbeDeps,
  dnsMs: number,
  linkSignal: AbortSignal,
): Promise<{ verdict: ProbeVerdict; reason: string; label?: string }> {
  if (deps.signal?.aborted) return { verdict: 'unknown', reason: 'budget' };
  if (linkSignal.aborted) return { verdict: 'unknown', reason: 'timeout' };
  const code = errorCode(error);
  if (code === 'TimeoutError' || code === 'AbortError') {
    return { verdict: 'unknown', reason: 'timeout' };
  }
  if (code === 'ECONNREFUSED') {
    if (deps.proxyConfigured) return { verdict: 'unknown', reason: 'refused' };
    const online = await deps.canary().catch(() => false);
    return online
      ? { verdict: 'dead', reason: 'refused', label: 'сервер не отвечает' }
      : { verdict: 'unknown', reason: 'offline' };
  }
  if (code === 'ENOTFOUND') {
    const check = await confirmNxdomain(host, deps, dnsMs, linkSignal);
    return check.kind === 'verdict'
      ? { verdict: check.verdict, reason: check.reason, label: check.label }
      : { verdict: 'unknown', reason: 'dns' };
  }
  if (
    /^(CERT_|SELF_SIGNED_|UNABLE_TO_|ERR_TLS_|ERR_SSL_|DEPTH_ZERO_)/.test(code)
  ) {
    return { verdict: 'unknown', reason: 'tls' };
  }
  if (code === 'ECONNRESET' || code.startsWith('UND_ERR_')) {
    return { verdict: 'unknown', reason: 'network' };
  }
  return { verdict: 'unknown', reason: 'network' };
}

/**
 * Проба: DNS → HEAD (редиректы вручную) → при ≥400 или сбое — GET. «Мёртвая»
 * только по правилам из шапки файла; всё прочее — «неизвестно».
 */
export async function probeUrl(
  url: string,
  deps: ProbeDeps,
): Promise<ProbeResult> {
  const now = deps.now ?? Date.now;
  const started = now();
  const dnsMs = deps.timeouts?.dnsMs ?? DNS_TIMEOUT_MS;
  const headMs = deps.timeouts?.headMs ?? HEAD_TIMEOUT_MS;
  const getMs = deps.timeouts?.getMs ?? GET_TIMEOUT_MS;
  const perLinkMs = deps.timeouts?.perLinkMs ?? PER_LINK_CAP_MS;
  const link = linkedController(deps.signal, perLinkMs);
  const finish = (
    verdict: ProbeVerdict,
    reason: string,
    extra: { label?: string; status?: number } = {},
  ): ProbeResult => ({
    verdict,
    reason,
    ...(extra.label ? { label: extra.label } : {}),
    ...(extra.status !== undefined ? { status: extra.status } : {}),
    ms: Math.max(0, now() - started),
  });
  try {
    const head = await requestChain(
      url,
      'HEAD',
      deps,
      headMs,
      dnsMs,
      link.signal,
    );
    if (head.kind === 'verdict') {
      return finish(head.verdict, head.reason, { label: head.label });
    }
    if (head.kind === 'response' && head.status < 400) {
      return finish('ok', head.status >= 300 ? 'redirect' : 'ok', {
        status: head.status,
      });
    }
    if (deps.signal?.aborted) return finish('unknown', 'budget');
    if (link.signal.aborted) return finish('unknown', 'timeout');
    // HEAD ≥400 или сбой: многие сайты не умеют HEAD (405) или режут его
    // антиботом (403) — решает GET.
    const get = await requestChain(url, 'GET', deps, getMs, dnsMs, link.signal);
    if (get.kind === 'verdict') {
      return finish(get.verdict, get.reason, { label: get.label });
    }
    if (get.kind === 'error') {
      const classified = await classifyFetchError(
        get.error,
        get.host,
        deps,
        dnsMs,
        link.signal,
      );
      return finish(classified.verdict, classified.reason, {
        label: classified.label,
      });
    }
    const status = get.status;
    if (status < 400)
      return finish('ok', status >= 300 ? 'redirect' : 'ok', { status });
    if (status === 404 || status === 410) {
      if (PRIVATE_OR_MISSING_HOSTS.test(get.host)) {
        return finish('unknown', 'private-or-missing', { status });
      }
      return finish('dead', `http-${status}`, {
        label: `HTTP ${status}`,
        status,
      });
    }
    return finish('unknown', `http-${status}`, { status });
  } catch {
    return finish('unknown', 'error');
  } finally {
    link.dispose();
  }
}

// ── Проверка набора ссылок ──────────────────────────────────────────────────

function hostOf(normalized: string): string {
  try {
    return new URL(normalized).hostname;
  } catch {
    return '';
  }
}

/**
 * Пул проб: не больше CONCURRENCY сразу и PER_HOST на хост (без ограничения
 * 220 ссылок разом дали 167 таймаутов). По общему дедлайну недоделанное
 * становится unknown('budget'), и функция возвращается сразу.
 */
export async function checkLinks(
  urls: readonly string[],
  options: {
    totalMs: number;
    deps: ProbeDeps;
    concurrency?: number;
    perHost?: number;
  },
): Promise<Map<string, ProbeResult>> {
  const results = new Map<string, ProbeResult>();
  const unique = [...new Set(urls)];
  if (unique.length === 0) return results;
  const concurrency = options.concurrency ?? CONCURRENCY;
  const perHost = options.perHost ?? PER_HOST;
  const global = new AbortController();
  const pending = [...unique];
  const perHostActive = new Map<string, number>();
  let active = 0;
  let closed = false;
  let resolveDone!: () => void;
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });
  const deps: ProbeDeps = { ...options.deps, signal: global.signal };
  const pump = (): void => {
    if (closed) return;
    for (let i = 0; i < pending.length && active < concurrency; ) {
      const url = pending[i];
      const host = hostOf(url);
      if ((perHostActive.get(host) ?? 0) >= perHost) {
        i += 1;
        continue;
      }
      pending.splice(i, 1);
      active += 1;
      perHostActive.set(host, (perHostActive.get(host) ?? 0) + 1);
      void probeUrl(url, deps)
        .catch(
          (): ProbeResult => ({ verdict: 'unknown', reason: 'error', ms: 0 }),
        )
        .then((result) => {
          if (!closed) results.set(url, result);
          active -= 1;
          perHostActive.set(host, (perHostActive.get(host) ?? 1) - 1);
          if (pending.length === 0 && active === 0) resolveDone();
          else pump();
        });
    }
  };
  const timer = setTimeout(() => resolveDone(), Math.max(1, options.totalMs));
  pump();
  await done;
  clearTimeout(timer);
  closed = true;
  // Всё, что не успело, — обрываем, чтобы не держать сокеты.
  global.abort(
    Object.assign(new Error('link check budget'), { name: 'AbortError' }),
  );
  for (const url of unique) {
    if (!results.has(url)) {
      results.set(url, {
        verdict: 'unknown',
        reason: 'budget',
        ms: options.totalMs,
      });
    }
  }
  return results;
}

// ── Пометка, промпт исправления, приёмка ────────────────────────────────────

/** Пометка после каждого вхождения мёртвой ссылки. Повторный вызов ничего не меняет. */
export function markDeadLinks(
  text: string,
  deadNormalized: ReadonlySet<string>,
): string {
  if (deadNormalized.size === 0) return text;
  const targets = extractLinks(text)
    .filter((link) => deadNormalized.has(link.normalized))
    .sort((a, b) => b.markAt - a.markAt);
  let out = text;
  for (const link of targets) {
    if (out.startsWith(DEAD_MARK, link.markAt)) continue;
    out = `${out.slice(0, link.markAt)}${DEAD_MARK}${out.slice(link.markAt)}`;
  }
  return out;
}

export function buildLinkFixPrompt(
  dead: ReadonlyArray<{ url: string; label: string }>,
): string {
  const lines = dead.map((entry) => `- ${entry.url} — ${entry.label}`);
  return [
    '<link_check source="system">',
    'Это автоматическая проверка ссылок перед отправкой, а не сообщение пользователя. Эти ссылки из твоего ответа не открылись:',
    ...lines,
    'Для каждой найди рабочую замену и убедись, что она открывается (web search или curl -sIL), либо убери ссылку, если замены нет. Остальной текст не меняй. Не вызывай send_message и другие инструменты отправки. Верни ПОЛНЫЙ исправленный ответ целиком, как он уйдёт пользователю, без пояснений про проверку.',
    '</link_check>',
  ].join('\n');
}

function wordSet(text: string): Set<string> {
  const withoutUrls = text
    .replace(/\]\(\s*https?:\/\/[^\s)]*\)/gi, ']')
    .replace(new RegExp(BARE_URL_RE.source, 'gi'), ' ');
  return new Set(withoutUrls.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);
}

/**
 * Исправление принимается, только если это тот же ответ с другими ссылками:
 * не пустой, не ужатый вдвое, не раздутый, по словам совпадает хотя бы на 60 %
 * и не начинается с пояснения про правку.
 */
export function acceptCorrection(
  original: string,
  corrected: string | null | undefined,
): { ok: true } | { ok: false; reason: string } {
  const text = (corrected ?? '').trim();
  if (!text) return { ok: false, reason: 'empty' };
  if (original.length >= 400 && text.length < original.length * 0.5) {
    return { ok: false, reason: 'too-short' };
  }
  if (text.length > original.length * 2 + 500) {
    return { ok: false, reason: 'too-long' };
  }
  if (
    /^(исправленн|вот исправ|обновлённ|обновленн)/i.test(text) ||
    /<\/?link_check\b/i.test(text)
  ) {
    return { ok: false, reason: 'meta' };
  }
  const a = wordSet(original);
  const b = wordSet(text);
  const union = new Set([...a, ...b]);
  if (union.size > 0) {
    let common = 0;
    for (const word of a) if (b.has(word)) common += 1;
    if (common / union.size < 0.6)
      return { ok: false, reason: 'changed-too-much' };
  }
  return { ok: true };
}

// ── Чужой текст, прочитанный инструментами хода ─────────────────────────────

/**
 * Инструменты claudeclaw, которые отдают модели чужой текст: WhatsApp
 * владельца, почту, документы, таблицы, календарь. Ссылка оттуда в ответе —
 * не выдумка модели, а чужой адрес (трекер, одноразовый вход), и проверка
 * не должна открывать его с Mac владельца. Хост выключает проверку, только
 * когда чужой текст приложен к промпту; прочитанное инструментом он не видит.
 */
export const FOREIGN_CONTENT_READ_TOOLS: ReadonlySet<string> = new Set([
  'chat_history',
  'gmail_search_threads',
  'gmail_get_thread',
  'google_docs_read',
  'google_sheets_get_values',
  'google_drive_list_files',
  'google_apps_script_get_content',
  'google_calendar_list_events',
]);

/**
 * Env MCP-серверу claudeclaw: токен метки этого прогона. Путь сервер строит
 * сам внутри своего IPC-каталога, так что env не может указать ему писать
 * куда-то ещё.
 */
export const FOREIGN_READ_MARKER_ENV = 'CLAUDECLAW_FOREIGN_READ_MARKER';

/**
 * Файл-метка прогона: `.foreign-read-<токен>` в IPC-каталоге группы. Токен
 * свой у каждого прогона, так что два прогона одной группы (плановая задача
 * рядом с живым ходом) друг друга не задевают. Не шлагбаум против модели —
 * она и так ходит в сеть сама, — а замок от наших собственных проб.
 */
export function foreignReadMarkerPath(
  ipcDir: string,
  token: string | undefined,
): string | null {
  if (!ipcDir || !token || !/^[A-Za-z0-9-]{16,64}$/.test(token)) return null;
  return path.join(ipcDir, `.foreign-read-${token}`);
}

/** Метка прогона, убитого до своего finally, старше этого — мусор. */
export const STALE_FOREIGN_READ_MARKER_MS = 24 * 60 * 60 * 1000;

function removeStaleForeignReadMarkers(ipcDir: string, now: number): void {
  let names: string[];
  try {
    names = fs.readdirSync(ipcDir);
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.startsWith('.foreign-read-')) continue;
    const file = path.join(ipcDir, name);
    try {
      if (now - fs.lstatSync(file).mtimeMs > STALE_FOREIGN_READ_MARKER_MS) {
        fs.unlinkSync(file);
      }
    } catch {
      /* её прогон убрал сам */
    }
  }
}

/**
 * Метку можно создать и удалить — тогда путь, иначе null, и проверка ссылок
 * на этот прогон выключается: без метки чтение почты прошло бы незамеченным.
 * Заодно убираются метки давно упавших прогонов.
 */
export function prepareForeignReadMarker(
  ipcDir: string,
  token: string,
  now: number = Date.now(),
): string | null {
  const markerPath = foreignReadMarkerPath(ipcDir, token);
  if (!markerPath) return null;
  removeStaleForeignReadMarkers(ipcDir, now);
  try {
    fs.writeFileSync(markerPath, '');
    fs.unlinkSync(markerPath);
    return markerPath;
  } catch {
    return null;
  }
}

/** Сторона MCP-сервера: инструмент отдал чужой текст. Строка на чтение. */
export function recordForeignContentRead(
  markerPath: string,
  tool: string,
): void {
  fs.appendFileSync(markerPath, `${tool}\n`);
}

/**
 * Какие инструменты читали чужой текст с последней очистки. Метка есть, но
 * не читается или пуста — тоже чтение: сомнение здесь значит «не проверять».
 */
export function foreignContentReads(markerPath: string): string[] {
  let raw: string;
  try {
    raw = fs.readFileSync(markerPath, 'utf-8');
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code === 'ENOENT' ? [] : ['unknown'];
  }
  const tools = [
    ...new Set(
      raw
        .split('\n')
        .map((line) => line.trim())
        .filter((tool) => FOREIGN_CONTENT_READ_TOOLS.has(tool)),
    ),
  ];
  return tools.length > 0 ? tools : ['unknown'];
}

/**
 * Начало хода пользователя: чтения прошлого хода к нему не относятся. Не
 * удалось удалить — метка остаётся, и ход просто не проверяет ссылки.
 */
export function clearForeignContentReads(markerPath: string): boolean {
  try {
    fs.unlinkSync(markerPath);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code === 'ENOENT';
  }
}

// ── Ссылки чужого текста на весь чат ────────────────────────────────────────

/**
 * Метка выше — на один ход, а вывод инструмента остаётся в треде Codex, и тред
 * живёт между ходами и прогонами: на следующем ходу («скинь ссылку из письма»)
 * модель цитирует одноразовую ссылку по памяти треда, когда метка уже пуста.
 * Поэтому MCP-сервер ещё и дописывает ссылки каждого успешного чтения чужого
 * текста в файл каталога группы, и проверка любого следующего хода и прогона
 * этого чата их не открывает. Хранятся не адреса, а их хэши: файл не должен
 * стать второй копией одноразовых токенов (каталог группы уходит в копии).
 */
export const FOREIGN_URLS_FILE = '.codex-foreign-urls.jsonl';
export const FOREIGN_URLS_MAX_ENTRIES = 5_000;
export const FOREIGN_URLS_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
/** Файл больше этого писали не мы: он не читается, и ни одной пробы. */
export const FOREIGN_URLS_MAX_BYTES = 4 * 1024 * 1024;

export function foreignUrlsFilePath(groupDir: string): string {
  return path.join(groupDir, FOREIGN_URLS_FILE);
}

interface ForeignUrlEntry {
  at: number;
  k: string[];
}

function foreignKeyHash(key: string): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 32);
}

/**
 * Ключи ссылки: адрес без #fragment и хост+путь без query (модель может
 * процитировать ссылку без хвоста параметров, с http вместо https, без www).
 */
export function foreignUrlKeys(url: string): string[] {
  const normalized = normalizeLinkUrl(url);
  if (!normalized) return [];
  const parsed = new URL(normalized);
  const host = parsed.host.replace(/^www\./, '');
  const pathOnly = parsed.pathname.replace(/\/+$/, '');
  return [
    foreignKeyHash(promptKey(normalized)),
    foreignKeyHash(`${host}${pathOnly}`),
  ];
}

function collectJsonStrings(value: unknown, out: string[], depth = 0): void {
  if (depth > 64) return;
  if (typeof value === 'string') {
    out.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) collectJsonStrings(item, out, depth + 1);
  } else if (value && typeof value === 'object') {
    for (const item of Object.values(value)) {
      collectJsonStrings(item, out, depth + 1);
    }
  }
}

/**
 * Все http(s)-ссылки чужого текста, включая код и строки JSON (результат
 * Google-инструмента — JSON, и «\n» в письме там два знака, которые иначе
 * приклеились бы к адресу).
 */
export function extractForeignUrls(text: string): string[] {
  const texts = [
    text,
    text
      .replace(/\\\//g, '/')
      .replace(/\\(?:u[0-9a-fA-F]{4}|[nrtbf"\\])/g, ' '),
  ];
  const trimmed = text.trimStart();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      collectJsonStrings(JSON.parse(text), texts);
    } catch {
      /* не JSON — хватит самого текста */
    }
  }
  const urls = new Set<string>();
  for (const part of texts) {
    for (const m of part.matchAll(new RegExp(BARE_URL_RE.source, 'gi'))) {
      const normalized = normalizeLinkUrl(trimBareUrl(m[0]));
      if (normalized) urls.add(normalized);
    }
  }
  return [...urls];
}

function isForeignUrlEntry(value: unknown): value is ForeignUrlEntry {
  const entry = value as Partial<ForeignUrlEntry> | null;
  return (
    typeof entry === 'object' &&
    entry !== null &&
    typeof entry.at === 'number' &&
    Number.isFinite(entry.at) &&
    Array.isArray(entry.k) &&
    entry.k.length > 0 &&
    entry.k.every(
      (key) => typeof key === 'string' && /^[0-9a-f]{32}$/.test(key),
    )
  );
}

/** [] — файла нет; null — файл есть, но это не наш список. */
function readForeignUrlEntries(file: string): ForeignUrlEntry[] | null {
  let raw: string;
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.size > FOREIGN_URLS_MAX_BYTES) return null;
    raw = fs.readFileSync(file, 'utf-8');
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code === 'ENOENT' ? [] : null;
  }
  const entries: ForeignUrlEntry[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      return null;
    }
    if (!isForeignUrlEntry(value)) return null;
    entries.push(value);
  }
  return entries;
}

/**
 * Сторона MCP-сервера: дописать ссылки прочитанного чужого текста в список
 * чата. Файл переписывается целиком через временный (права 600) — оборванной
 * строки не бывает; старше 14 дней и сверх 5000 последних записи уходят.
 * Список, который не читается, не трогается (бросает): проверка и так не
 * пробует ничего, пока он такой. Возвращает число ссылок текста.
 */
export function recordForeignUrls(
  file: string,
  text: string,
  now: number = Date.now(),
): number {
  const fresh = extractForeignUrls(text);
  if (fresh.length === 0) return 0;
  const existing = readForeignUrlEntries(file);
  if (!existing) {
    throw new Error('the foreign-link list is unreadable; left as is');
  }
  const byKey = new Map<string, ForeignUrlEntry>();
  for (const entry of existing) {
    if (now - entry.at <= FOREIGN_URLS_MAX_AGE_MS) byKey.set(entry.k[0], entry);
  }
  for (const url of fresh) {
    const keys = foreignUrlKeys(url);
    if (keys.length === 0) continue;
    byKey.delete(keys[0]);
    byKey.set(keys[0], { at: now, k: keys });
  }
  const kept = [...byKey.values()]
    .sort((a, b) => a.at - b.at)
    .slice(-FOREIGN_URLS_MAX_ENTRIES);
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(
      tmp,
      `${kept.map((entry) => JSON.stringify(entry)).join('\n')}\n`,
      { mode: 0o600, flag: 'wx' },
    );
    fs.renameSync(tmp, file);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* не создан */
    }
    throw err;
  }
  return fresh.length;
}

export interface ForeignUrlIndex {
  /** false — список есть, но не читается: в этом ответе ни одной пробы. */
  readonly readable: boolean;
  /** Ссылка (или её хост+путь) была в чужом тексте этого чата. */
  has(url: string): boolean;
}

export const NO_FOREIGN_URLS: ForeignUrlIndex = {
  readable: true,
  has: () => false,
};

const UNREADABLE_FOREIGN_URLS: ForeignUrlIndex = {
  readable: false,
  has: () => true,
};

/** Сторона раннера: список чата, один раз на проверку ответа. */
export function readForeignUrls(file: string): ForeignUrlIndex {
  const entries = readForeignUrlEntries(file);
  if (!entries) return UNREADABLE_FOREIGN_URLS;
  if (entries.length === 0) return NO_FOREIGN_URLS;
  const keys = new Set(entries.flatMap((entry) => entry.k));
  return {
    readable: true,
    has: (url) => foreignUrlKeys(url).some((key) => keys.has(key)),
  };
}

/**
 * Список можно вести: в каталоге группы создаётся и удаляется файл. Нет —
 * MCP-сервер не запишет ссылки, и проверка на этот прогон выключается.
 */
function canKeepForeignUrls(file: string, token: string): boolean {
  const probe = `${file}.probe-${token}`;
  try {
    fs.writeFileSync(probe, '', { mode: 0o600 });
    fs.unlinkSync(probe);
    return true;
  } catch {
    return false;
  }
}

// ── Неприменённое исправление ───────────────────────────────────────────────

/**
 * Исправление шло в тред чата. Если его отклонили, оно упало или прервалось,
 * пользователь получил исходный ответ с пометками, а тред помнит отброшенный
 * текст (или висящую просьбу проверки) и считает, что его и прочли.
 * Следующий ход этого треда начинается с этой заметки.
 */
export const LINK_FIX_DISCARDED_NOTE =
  '[Служебно: твой предыдущий ответ ушёл пользователю в исходном виде (битые ссылки помечены «⚠️ ссылка не открылась»), исправление проверки ссылок не применено и пользователю не показано. Отвечай на сообщение ниже.]';

export function linkFixDiscarded(
  summary: Pick<LinkCheckSummary, 'correction'> | undefined,
): boolean {
  return summary?.correction === 'failed' || summary?.correction === 'rejected';
}

/**
 * Заметка ждёт в файле рядом с id треда: следующий ход обычно приходит уже
 * в новый прогон (раннер ждёт следующего сообщения секунды).
 */
export function saveLinkFixNote(file: string, threadId: string): void {
  fs.writeFileSync(
    file,
    JSON.stringify({ threadId, at: new Date().toISOString() }),
  );
}

/**
 * Забрать заметку для треда, который сейчас продолжится. Заметка другого
 * треда (его сменили) просто удаляется: новый тред отброшенного не видел.
 */
export function takeLinkFixNote(
  file: string,
  threadId: string | undefined,
): string {
  let saved: { threadId?: unknown } | null = null;
  try {
    saved = JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return '';
  }
  try {
    fs.unlinkSync(file);
  } catch {
    /* уже нет */
  }
  return threadId && saved?.threadId === threadId
    ? LINK_FIX_DISCARDED_NOTE
    : '';
}

/**
 * Состояние проверки ссылок на весь прогон раннера — то, чего нет в треде
 * Codex: метка чтений чужого текста, список ссылок чужого текста чата, ссылки
 * всех промптов, заметка треду о неприменённом исправлении.
 */
export interface LinkCheckRun {
  /** null — проверки в прогоне нет: не разрешена или метку не завести. */
  readonly foreignReadMarker: string | null;
  /** Добавка к env MCP-сервера claudeclaw (токен метки). */
  readonly mcpEnv: Record<string, string>;
  /**
   * Начало хода пользователя: метка прошлого хода стирается, ссылки промпта
   * идут в индекс, а тред, которому не дошло исправление, получает заметку
   * перед сообщением. Возвращает промпт для продолжения этого треда.
   */
  startUserTurn(
    text: string,
    thread: { id: string | undefined; sharesChatThread: boolean },
  ): string;
  /** Ещё сообщения того же хода (supersede). */
  addPrompt(text: string): void;
  promptLinks(): PromptLinkIndex;
  foreignContentReads(): string[];
  /** Ссылки чужого текста прошлых ходов и прогонов этого чата. */
  foreignUrls(): ForeignUrlIndex;
  /** После проверки: исправление не дошло — заметка следующему ходу треда. */
  afterCheck(
    summary: Pick<LinkCheckSummary, 'correction'>,
    thread: {
      sharesChatThread: boolean;
      fixThreadId: string | undefined;
      threadId: string | undefined;
    },
  ): void;
  /** Конец прогона: метка удаляется. */
  close(): void;
}

export function createLinkCheckRun(options: {
  /** Хост и замки раннера разрешили проверку в этом прогоне. */
  enabled: boolean;
  ipcDir: string;
  /** Файл заметки треду (каталог группы, рядом с id треда). */
  noteFile: string;
  /** Список ссылок чужого текста чата (каталог группы, foreignUrlsFilePath). */
  foreignUrlsFile: string;
  log: (message: string) => void;
}): LinkCheckRun {
  const token = randomUUID();
  let marker: string | null = null;
  if (options.enabled) {
    if (canKeepForeignUrls(options.foreignUrlsFile, token)) {
      marker = prepareForeignReadMarker(options.ipcDir, token);
    } else {
      options.log(
        'Link check: the group dir cannot keep the list of foreign links; no link check in this run',
      );
    }
  }
  let index: PromptLinkIndex = { text: '', keys: new Set() };
  return {
    foreignReadMarker: marker,
    mcpEnv: marker ? { [FOREIGN_READ_MARKER_ENV]: token } : {},
    startUserTurn(text, thread) {
      if (marker && !clearForeignContentReads(marker)) {
        options.log(
          'Link check: could not clear the foreign-read marker; this turn will not probe links',
        );
      }
      index = addPromptLinks(index, text);
      // Плановая задача и ход с пересланным текстом идут в свой тред:
      // заметка ждёт следующего хода треда чата.
      if (!thread.sharesChatThread) return text;
      const note = takeLinkFixNote(options.noteFile, thread.id);
      if (!note) return text;
      options.log(
        `Link check: telling thread ${thread.id} its link correction was not delivered`,
      );
      return `${note}\n\n${text}`;
    },
    addPrompt(text) {
      index = addPromptLinks(index, text);
    },
    promptLinks: () => index,
    foreignContentReads: () => (marker ? foreignContentReads(marker) : []),
    foreignUrls: () =>
      marker ? readForeignUrls(options.foreignUrlsFile) : NO_FOREIGN_URLS,
    afterCheck(summary, thread) {
      if (
        !linkFixDiscarded(summary) ||
        !thread.sharesChatThread ||
        !thread.fixThreadId ||
        thread.threadId !== thread.fixThreadId
      ) {
        return;
      }
      try {
        saveLinkFixNote(options.noteFile, thread.fixThreadId);
      } catch (err) {
        options.log(
          `Link check: could not save the note for the next turn: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
    close() {
      if (marker) clearForeignContentReads(marker);
    },
  };
}

// ── Весь цикл ───────────────────────────────────────────────────────────────

export interface LinkCheckSummary {
  mode: LinkCheckMode;
  /** Уникальных ссылок в ответе (без кода). */
  found: number;
  checked: number;
  ok: number;
  dead: number;
  unknown: number;
  skipped: number;
  truncated: number;
  /**
   * none | shadow | skipped-mark-mode | skipped-foreign-content |
   * skipped-foreign-urls-unreadable | skipped-<причина> | failed | rejected |
   * applied
   */
  correction: string;
  fix_reject?: string;
  check_ms: number;
  fix_ms?: number;
  /** Новые ссылки исправленного ответа: сколько проверено и сколько мёртвых. */
  recheck_checked?: number;
  recheck_dead?: number;
  /** Мёртвые ссылки, оставшиеся в итоговом тексте с пометкой. */
  marked?: number;
  /** Только хосты мёртвых ссылок — пути могут нести приватные id. */
  dead_hosts: string[];
  /** Счётчики причин: «dead:http-404», «unknown:tls», «skip:in-prompt»… */
  reasons: Record<string, number>;
}

/** One log line: counts and hosts only, like the event. */
export function describeLinkCheckSummary(summary: LinkCheckSummary): string {
  const parts = [
    `found=${summary.found}`,
    `checked=${summary.checked}`,
    `ok=${summary.ok}`,
    `dead=${summary.dead}`,
    `unknown=${summary.unknown}`,
    `skipped=${summary.skipped}`,
    `correction=${summary.correction}`,
    `check_ms=${summary.check_ms}`,
  ];
  if (summary.fix_ms !== undefined) parts.push(`fix_ms=${summary.fix_ms}`);
  if (summary.dead_hosts.length > 0) {
    parts.push(`dead_hosts=${summary.dead_hosts.join(',')}`);
  }
  return `Link check (${summary.mode}): ${parts.join(' ')}`;
}

export interface LinkCorrectionResult {
  status: 'success' | 'error';
  text: string | null;
  error?: string;
}

export interface ApplyLinkCheckInput<R extends LinkCorrectionResult> {
  text: string;
  /**
   * Всё, что пришло в прогон (строка или накопленный индекс всех его
   * промптов): ссылки оттуда не проверяются.
   */
  promptText: string | PromptLinkIndex;
  mode: LinkCheckMode;
  /**
   * Какие инструменты этого хода прочли чужой текст (метка MCP-сервера).
   * Спрашивается перед пробами и ещё раз перед повторной проверкой
   * исправления: непустой ответ — ни одной пробы.
   */
  foreignContentReads?: () => readonly string[];
  /**
   * Ссылки чужого текста прошлых ходов и прогонов этого чата (тред Codex их
   * помнит): такие не пробуются никогда. Читается один раз на проверку;
   * список не читается — в ответе ни одной пробы.
   */
  foreignUrls?: () => ForeignUrlIndex;
  /** Причина, по которой исправление нельзя (тогда только пометка). */
  fixBlockedReason?: string;
  /** Абсолютный момент конца бюджета хода. */
  turnDeadlineAt: number;
  deps: ProbeDeps;
  runCorrection: (prompt: string, timeoutMs: number) => Promise<R>;
  log: (message: string) => void;
  now?: () => number;
  /** Для тестов. */
  limits?: Partial<{ checkTotalMs: number; recheckTotalMs: number }>;
}

export interface ApplyLinkCheckOutcome<R> {
  text: string;
  summary: LinkCheckSummary;
  correctionResult?: R;
}

function bump(reasons: Record<string, number>, key: string): void {
  reasons[key] = (reasons[key] ?? 0) + 1;
}

export async function applyLinkCheck<R extends LinkCorrectionResult>(
  input: ApplyLinkCheckInput<R>,
): Promise<ApplyLinkCheckOutcome<R>> {
  const now = input.now ?? Date.now;
  const started = now();
  const original = input.text;
  const reasons: Record<string, number> = {};
  const summary: LinkCheckSummary = {
    mode: input.mode,
    found: 0,
    checked: 0,
    ok: 0,
    dead: 0,
    unknown: 0,
    skipped: 0,
    truncated: 0,
    correction: 'none',
    check_ms: 0,
    dead_hosts: [],
    reasons,
  };
  const links = extractLinks(original);
  const firstRaw = new Map<string, string>();
  for (const link of links) {
    if (!firstRaw.has(link.normalized)) firstRaw.set(link.normalized, link.url);
  }
  summary.found = firstRaw.size;
  if (firstRaw.size === 0) return { text: original, summary };

  // Ход читал почту, WhatsApp или документы: ссылки ответа могут быть оттуда —
  // трекеры, одноразовые входы. Ни одной пробы, в любом режиме, даже shadow.
  const foreign = input.foreignContentReads?.() ?? [];
  if (foreign.length > 0) {
    summary.skipped = firstRaw.size;
    reasons['skip:foreign-content'] = firstRaw.size;
    summary.correction = 'skipped-foreign-content';
    input.log(
      `link check: the turn read foreign content (${foreign.join(', ')}); no link is probed`,
    );
    return { text: original, summary };
  }

  // Прошлые ходы этого чата читали почту или WhatsApp: их ссылки всё ещё в
  // треде. Список не читается — сомнение значит «не проверять».
  const foreignUrls = input.foreignUrls?.() ?? NO_FOREIGN_URLS;
  if (!foreignUrls.readable) {
    summary.skipped = firstRaw.size;
    reasons['skip:foreign-urls-unreadable'] = firstRaw.size;
    summary.correction = 'skipped-foreign-urls-unreadable';
    input.log(
      'link check: the list of foreign links of this chat cannot be read; no link is probed',
    );
    return { text: original, summary };
  }

  const promptIndex =
    typeof input.promptText === 'string'
      ? indexPromptLinks(input.promptText)
      : input.promptText;
  const candidates: string[] = [];
  for (const [normalized, raw] of firstRaw) {
    const skip = foreignUrls.has(normalized)
      ? 'foreign-url'
      : linkSkipReason(raw, promptIndex);
    if (skip) {
      summary.skipped += 1;
      bump(reasons, `skip:${skip}`);
    } else {
      candidates.push(normalized);
    }
  }
  const toCheck = candidates.slice(0, MAX_LINKS);
  summary.truncated = candidates.length - toCheck.length;
  const results = await checkLinks(toCheck, {
    totalMs: input.limits?.checkTotalMs ?? CHECK_TOTAL_MS,
    deps: input.deps,
  });
  summary.check_ms = Math.max(0, now() - started);
  summary.checked = toCheck.length;
  const dead: Array<{ normalized: string; url: string; label: string }> = [];
  for (const normalized of toCheck) {
    const result = results.get(normalized);
    if (!result || result.verdict === 'unknown') {
      summary.unknown += 1;
      bump(reasons, `unknown:${result?.reason ?? 'budget'}`);
    } else if (result.verdict === 'ok') {
      summary.ok += 1;
    } else {
      summary.dead += 1;
      bump(reasons, `dead:${result.reason}`);
      dead.push({
        normalized,
        url: firstRaw.get(normalized) ?? normalized,
        label: result.label ?? result.reason,
      });
    }
  }
  summary.dead_hosts = [
    ...new Set(dead.map((entry) => hostOf(entry.normalized)).filter(Boolean)),
  ];
  if (dead.length === 0) return { text: original, summary };

  const deadSet = new Set(dead.map((entry) => entry.normalized));
  const markedOriginal = (): string => {
    summary.marked = deadSet.size;
    return markDeadLinks(original, deadSet);
  };
  if (input.mode === 'shadow') {
    summary.correction = 'shadow';
    return { text: original, summary };
  }
  if (input.mode === 'mark') {
    summary.correction = 'skipped-mark-mode';
    return { text: markedOriginal(), summary };
  }
  if (input.fixBlockedReason) {
    summary.correction = `skipped-${input.fixBlockedReason}`;
    return { text: markedOriginal(), summary };
  }
  const remainingMs = input.turnDeadlineAt - now();
  if (remainingMs < FIX_MIN_REMAINING_MS) {
    summary.correction = 'skipped-budget';
    return { text: markedOriginal(), summary };
  }

  const timeoutMs = Math.min(FIX_TURN_MAX_MS, remainingMs - FIX_SAFETY_MS);
  const fixStarted = now();
  let correctionResult: R | undefined;
  try {
    correctionResult = await input.runCorrection(
      buildLinkFixPrompt(dead),
      timeoutMs,
    );
  } catch (err) {
    input.log(
      `link check: correction turn threw: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  summary.fix_ms = Math.max(0, now() - fixStarted);
  if (!correctionResult || correctionResult.status !== 'success') {
    summary.correction = 'failed';
    return { text: markedOriginal(), summary, correctionResult };
  }
  const corrected = (correctionResult.text ?? '').trim();
  const verdict = acceptCorrection(original, corrected);
  if (!verdict.ok) {
    summary.correction = 'rejected';
    summary.fix_reject = verdict.reason;
    return { text: markedOriginal(), summary, correctionResult };
  }

  // Новые ссылки проверяются один раз; второго исправления не бывает.
  const originalSet = new Set(firstRaw.keys());
  const newLinks = new Map<string, string>();
  for (const link of extractLinks(corrected)) {
    if (originalSet.has(link.normalized) || newLinks.has(link.normalized)) {
      continue;
    }
    if (foreignUrls.has(link.normalized)) continue;
    if (linkSkipReason(link.url, promptIndex)) continue;
    newLinks.set(link.normalized, link.url);
  }
  const recheck = [...newLinks.keys()].slice(0, MAX_LINKS);
  const markSet = new Set(deadSet);
  if (recheck.length > 0 && (input.foreignContentReads?.() ?? []).length > 0) {
    // Ход-исправление сам читал чужой текст: его новые ссылки не пробуем.
    reasons['skip:recheck-foreign-content'] = recheck.length;
  } else if (recheck.length > 0) {
    const rechecked = await checkLinks(recheck, {
      totalMs: input.limits?.recheckTotalMs ?? RECHECK_TOTAL_MS,
      deps: input.deps,
    });
    let recheckDead = 0;
    for (const normalized of recheck) {
      if (rechecked.get(normalized)?.verdict === 'dead') {
        recheckDead += 1;
        markSet.add(normalized);
        const host = hostOf(normalized);
        if (host && !summary.dead_hosts.includes(host)) {
          summary.dead_hosts.push(host);
        }
      }
    }
    summary.recheck_checked = recheck.length;
    summary.recheck_dead = recheckDead;
  }
  const finalText = markDeadLinks(corrected, markSet);
  summary.marked = new Set(
    extractLinks(finalText)
      .map((link) => link.normalized)
      .filter((normalized) => markSet.has(normalized)),
  ).size;
  summary.correction = 'applied';
  return { text: finalText, summary, correctionResult };
}
