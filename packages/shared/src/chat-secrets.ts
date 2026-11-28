/**
 * Пароли, коды и ключи, присланные в чат (W19-ост, r1111).
 *
 * Модель получает исходный текст, как и раньше: иначе она не выполнит «вот
 * пароль, войди». Здесь — маска только для хранения и эха хоста: журнал
 * событий, data/telegram-inbox, строка «⏳ Работаю над…». Через эту строку
 * пароль однажды ушёл обратно в чат, а журнал событий до этого маскировал
 * только sk-ключи.
 *
 * Секрет узнаётся по устойчивым признакам:
 *  - по форме: токен Telegram-бота <id>:<35 знаков>, ключи sk-…, AIza…, AQ.…,
 *    ya29.…, GOCSPX-…, gh*_…, xox*-…, AKIA…, JWT, Bearer, закрытый ключ,
 *    пароль в ссылке, ?token=… в ссылке, ИМЯ_TOKEN=…;
 *  - по подписи: «пароль 4821», «Пароль: qwerty», «пароль от мака Шефа
 *    4821», «пин-код 1234», «Код для входа в Telegram: 52814», «Login code:
 *    52814», «токен: …», «апи ключ …». Без «:»/«=» значение должно быть
 *    похоже на секрет (цифры, смесь регистров и знаков), после «:»/«=» —
 *    любое, кроме служебных слов («пароль: не нужен»);
 *    После «:»/«=» скрывается всё значение до конца фразы («пароль:
 *    correct horse battery»), значение в кавычках — целиком («пароль от
 *    вайфая «Синий Кит 1985»»);
 *  - настройки: POSTGRES_PASSWORD: …, "DB_PASSWORD": "…", db_password=…,
 *    SMTP_PASS=…, pass: …, pwd: …, dbPassword: …;
 *  - значение перед словом: «4821 — пароль от мака» (кроме номера заказа,
 *    счёта, телефона: «Заказ 48213, пароль …»);
 *  - SMS с одноразовым кодом: «5281 — ваш код для входа», «Kaspi.kz: 1234 -
 *    Код для входа», «G-123456 is your Google verification code», «Ваш код:
 *    5281», «Код 5281. Никому не сообщайте»;
 *  - ответ на просьбу бота: бот в последний час просил пароль или код, а
 *    человек прислал короткий бессмысленный набор («4821», «Qw3rty!», «5 2 8
 *    1 4»). Просьба — это просьба («пришли», «введи», «жду», «нужен», «?»),
 *    а не упоминание в отчёте («токен обновил»); свои строки хоста («⏳
 *    Работаю над: «…»») просьбой не считаются. Просьба в промежуточной
 *    реплике «⏳ …» запоминается при отправке (noteBotTextForSecretRequests),
 *    и следующий ответ бота («Хорошо, жду») её не отменяет.
 * Обычные числа без подписи — даты, время, суммы, номера заказов — остаются.
 */

import { derivedFromInstanceProfile } from './instance-profile.js';

export const CHAT_SECRET_MASK = '[скрыто]';

/** What the host says instead of a message that is nothing but a secret. */
export const CHAT_SECRET_PREVIEW = 'сообщение с паролем или ключом';

/** A reply this long after the bot's request no longer answers it. */
export const SECRET_REQUEST_WINDOW_MS = 60 * 60_000;

export interface ChatSecretContext {
  /** The bot asked for a password or a code in this chat within the hour. */
  afterSecretRequest?: boolean;
}

const MASK = CHAT_SECRET_MASK;

// --- Формы ключей и токенов: заменяется всё совпадение ---------------------

const SHAPE_RULES: ReadonlyArray<readonly [RegExp, string]> = [
  [
    /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g,
    MASK,
  ],
  // Токен Telegram-бота, в том числе в ссылке API (…/bot<id>:<ключ>/getMe).
  [/(?<![\p{L}\p{N}_])(?:bot)?\d{6,12}:[A-Za-z0-9_-]{30,}/gu, MASK],
  [
    /(?<![A-Za-z0-9_-])(?:sk-(?:ant-|proj-|svcacct-)?[A-Za-z0-9_-]{16,}|AIza[0-9A-Za-z_-]{30,}|AQ\.[0-9A-Za-z_.-]{30,}|ya29\.[0-9A-Za-z_.-]{20,}|GOCSPX-[0-9A-Za-z_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|xapp-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})/g,
    MASK,
  ],
  // Bearer/Basic: только непрозрачное значение с цифрой («Bearer of bad news»
  // — не ключ).
  [/\b(Bearer\s+)(?=[A-Za-z0-9._~+/=-]*\d)[A-Za-z0-9._~+/=-]{12,}/g, `$1${MASK}`],
  [/\b(Basic\s+)(?=[A-Za-z0-9+/]*[0-9+/])[A-Za-z0-9+/]{12,}={0,2}/g, `$1${MASK}`],
  // Логин:пароль в ссылке — остаются схема, логин и адрес.
  [/(\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:)[^\s@/]+(?=@)/gi, `$1${MASK}`],
  [
    /([?&](?:api[_-]?key|key|token|access_token|refresh_token|secret|client_secret|password|passwd|pass|pwd|signature|sig)=)[^&\s"'#]+/gi,
    `$1${MASK}`,
  ],
  [
    /(?<![A-Za-z0-9_])([A-Z][A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|APIKEY|PRIVATE_KEY))(\s*=\s*)["']?[^\s"']+["']?/g,
    `$1$2${MASK}`,
  ],
];

// --- Подписанные значения -----------------------------------------------------

type LabelKind = 'password' | 'code' | 'token';

// \b в JS понимает только латиницу, поэтому границы слова — через \p{L}.
const LABELS: ReadonlyArray<readonly [RegExp, LabelKind]> = [
  [
    /(?<![\p{L}\p{N}_])(?:парол(?:ь|я|ю|ем|е)|pass(?:word|wd|code|phrase))(?![\p{L}\p{N}_])/giu,
    'password',
  ],
  [
    /(?<![\p{L}\p{N}_])(?:пин(?:[- ]?код(?:а|ом)?)?|pin(?:[- ]?code)?|код(?:а|ом)?\s+(?:доступа|подтверждения|входа|для\s+входа|из\s+(?:смс|sms|сообщения|письма)|авторизации|верификации|безопасности)|(?:login|verification|security|confirmation|one[- ]time|2fa|otp|sms)\s+code)(?![\p{L}\p{N}_])/giu,
    'code',
  ],
  [
    /(?<![\p{L}\p{N}_])(?:токен(?:а|ом|у)?|(?:access|refresh|bot|api|auth)[_ -]?token|token|api[_ -]?key|apikey|апи[- ]?ключ(?:а|ом)?|ключ(?:а|ом)?\s+(?:api|апи|доступа|авторизации)|client[_ -]?secret|secret[_ -]?key|секретный\s+ключ)(?![\p{L}\p{N}_])/giu,
    'token',
  ],
];

// После «:»/«=» это не значение, а рассказ о нём: «пароль: не нужен».
const NON_VALUES =
  /^(?:не|нет|да|есть|нужен|нужна|нужно|понадобился|требуется|отсутствует|изменён|изменен|сохранён|сохранен|неизменён|неизменен|верный|неверный|правильный|неправильный|указан|введён|введен|истёк|истек|пуст|пустой|задан|скрыт|скрыто|см|ниже|выше|в|из|для|и|или|are|is|was|not|none|null|undefined|true|false|empty|required|unchanged|changed|stored|field|and|or|yes|no|ok|set|unset|missing|invalid|expired|revoked|present|absent|hidden)$/iu;

// Значение в кавычках скрывается целиком: «пароль: «мой кот 2020»».
const QUOTE_PAIRS: Readonly<Record<string, string>> = {
  '«': '»',
  '"': '"',
  "'": "'",
  '“': '”',
  '„': '“',
};
// Значение после «:»/«=» — до конца фразы, но не длиннее этого.
const PHRASE_LIMIT = 100;
// Конец фразы: перевод строки, знак препинания с пробелом, тире, скобка,
// следующая подпись («Логин:»).
const PHRASE_STOP =
  /\n|[.,;!?…](?=\s|$)|\s[—–-]\s|\s\(|\s+\p{L}[\p{L}\p{N}_-]*:(?=\s|$)/u;

const PREPOSITIONS = new Set([
  'от', 'для', 'к', 'на', 'в', 'во', 'of', 'for', 'to', 'on', 'at',
]);
const WEAK_SEPARATORS = new Set(['—', '–', '-', 'это', 'is']);
const LEADING_QUOTES = /^["'«(]+/u;
const TRAILING_PUNCT = /[.,;)"'»}\]]+$/u;
const EMAIL = /^[^\s@]+@[^\s@]+\.\p{L}{2,}$/u;
const URL_LIKE = /^(?:[a-z][a-z0-9+.-]*:\/\/|www\.)/i;
// Даты, время и суммы — обычные числа, а не пароли.
const DATE_TIME_AMOUNT = [
  /^\d{1,2}[:.]\d{2}(?::\d{2})?$/u,
  /^\d{1,4}[./-]\d{1,2}(?:[./-]\d{1,4})?$/u,
  /^\d+(?:[.,]\d+)?(?:тг|тенге|₸|р|руб|₽|\$|€|к|k|кг|г|шт|%|мин|ч|км|м)$/iu,
];
// Слово после числа, с которым число — количество: «1500 тг», «3 раза».
// Что ещё считает эта установка, добавляет профиль инстанса
// (chatSecrets.unitWords). Шаблон закреплён с обеих сторон, поэтому порядок
// слов в нём на результат не влияет.
const UNIT_WORDS = String.raw`тг|тенге|₸|р|руб|рублей|рубля|₽|\$|€|шт|штук|кг|г|мин|минут|ч|час|часа|часов|дней|дня|день|раз|раза|км|м|%|человек|заказов|tg|kzt|usd|rub`;
const unitWord = derivedFromInstanceProfile(
  (profile) =>
    new RegExp(
      `^(?:${[UNIT_WORDS, ...profile.chatSecrets.unitWords].join('|')})[.,!?]?$`,
      'iu',
    ),
);

function hasMask(value: string): boolean {
  return value.includes(MASK);
}

function looksLikeDateTimeOrAmount(value: string): boolean {
  return DATE_TIME_AMOUNT.some((re) => re.test(value));
}

function characterClasses(value: string): number {
  return (
    Number(/\p{Ll}/u.test(value)) +
    Number(/\p{Lu}/u.test(value)) +
    Number(/\d/.test(value)) +
    Number(/[^\p{L}\p{N}]/u.test(value))
  );
}

function looksLikeSecret(value: string, kind: LabelKind): boolean {
  if (!value || hasMask(value) || EMAIL.test(value) || URL_LIKE.test(value)) {
    return false;
  }
  if (looksLikeDateTimeOrAmount(value)) return false;
  if (kind === 'code') return /^(?:[A-Z]-)?\d(?:-?\d){3,9}$/.test(value);
  if (kind === 'token') {
    return (
      value.length >= 12 &&
      /^[A-Za-z0-9_\-.:+/=~]+$/.test(value) &&
      ((/\d/.test(value) && /[A-Za-z]/.test(value)) || characterClasses(value) >= 3)
    );
  }
  return (
    (/\d/.test(value) && Array.from(value).length >= 4) ||
    (Array.from(value).length >= 8 && characterClasses(value) >= 3)
  );
}

function isNameWord(value: string): boolean {
  if (NON_VALUES.test(value)) return false;
  return EMAIL.test(value) || /^\p{L}[\p{L}._@'-]*$/u.test(value);
}

interface Token {
  start: number;
  end: number;
  text: string;
}

function nextToken(text: string, from: number): Token | null {
  const re = /\s*(\S+)/y;
  re.lastIndex = from;
  const match = re.exec(text);
  if (!match) return null;
  const end = re.lastIndex;
  return { start: end - match[1].length, end, text: match[1] };
}

/** Value bounds without surrounding quotes and trailing punctuation. */
function valueBounds(token: Token): Token | null {
  const lead = token.text.match(LEADING_QUOTES)?.[0].length ?? 0;
  const core = token.text.slice(lead).replace(TRAILING_PUNCT, '');
  if (!core) return null;
  const start = token.start + lead;
  return { start, end: start + core.length, text: core };
}

/**
 * The text between an opening quote at `openAt` and its pair, or to the end
 * of the line when the pair is missing. Null when there is no pair within
 * PHRASE_LIMIT and the line goes on — then only one word is a value.
 */
function quotedValue(text: string, openAt: number): Token | null {
  const close = QUOTE_PAIRS[text[openAt]];
  if (close === undefined) return null;
  const start = openAt + 1;
  const newline = text.indexOf('\n', start);
  const lineEnd = newline === -1 ? text.length : newline;
  const closeAt = text.indexOf(close, start);
  let end: number;
  if (closeAt !== -1 && closeAt <= lineEnd && closeAt - start <= PHRASE_LIMIT) {
    end = closeAt;
  } else if (lineEnd - start <= PHRASE_LIMIT) {
    end = lineEnd;
  } else {
    return null;
  }
  let core = text.slice(start, end).replace(/\s+$/u, '');
  if (closeAt === -1 || closeAt > lineEnd) core = core.replace(TRAILING_PUNCT, '');
  if (!core.trim()) return null;
  return { start, end: start + core.length, text: core };
}

/**
 * After «:»/«=» a password may be several words («correct horse battery
 * staple»): the value runs to the end of the phrase. A phrase longer than
 * PHRASE_LIMIT keeps only its first word.
 */
function phraseValue(text: string, first: Token): Token {
  const limitEnd = Math.min(text.length, first.start + PHRASE_LIMIT);
  const rest = text.slice(first.start, limitEnd);
  const stop = rest.search(PHRASE_STOP);
  let end: number;
  if (stop === -1) {
    if (limitEnd < text.length) return first;
    end = text.length;
  } else {
    end = first.start + stop;
  }
  if (end <= first.end) return first;
  const phrase = text
    .slice(first.start, end)
    .replace(/\s+$/u, '')
    .replace(TRAILING_PUNCT, '');
  if (phrase.length <= first.text.length || hasMask(phrase)) return first;
  return { start: first.start, end: first.start + phrase.length, text: phrase };
}

/**
 * The value a label names, or null. Grammar after the label:
 *   [от|для|в… + 1–2 слова | одно слово] [—|это] ЗНАЧЕНИЕ
 * where «:» or «=» anywhere on the way makes any next word the value.
 */
function labelledValue(
  text: string,
  from: number,
  kind: LabelKind,
): Token | null {
  let position = from;
  let strong = false;
  let phase: 'start' | 'names' | 'beforeValue' = 'start';
  let names = 0;
  for (let step = 0; step < 6; step += 1) {
    const token = nextToken(text, position);
    if (!token || hasMask(token.text)) return null;
    position = token.end;
    let start = token.start;
    let body = token.text;
    // «"password": …» — кавычка закрывает имя, дальше разделитель.
    const keyClose = body.match(/^["'»”]+(?=[:=])/u);
    if (keyClose) {
      start += keyClose[0].length;
      body = body.slice(keyClose[0].length);
    }
    const separator = body.match(/^[:=]+/);
    if (separator) {
      strong = true;
      start += separator[0].length;
      body = body.slice(separator[0].length);
      if (!body) continue;
    }
    if (QUOTE_PAIRS[body[0]] !== undefined) {
      const quoted = quotedValue(text, start);
      if (quoted && !hasMask(quoted.text)) {
        if (strong) {
          const first = quoted.text.split(/\s+/u)[0].replace(TRAILING_PUNCT, '');
          return NON_VALUES.test(first) ? null : quoted;
        }
        // Без «:» кавычки — значение, только если оно похоже на секрет:
        // «пароль от «Госуслуг»» — это название, а не пароль.
        if (looksLikeSecret(quoted.text.replace(/\s+/gu, ''), kind)) return quoted;
      }
    }
    const unquoted = body.replace(LEADING_QUOTES, '');
    const candidate: Token = {
      start: token.end - unquoted.length,
      end: token.end,
      text: unquoted,
    };
    if (/[:=]["']?$/.test(candidate.text)) {
      const word = candidate.text.replace(/[:=]["']?$/u, '');
      // «пароль Abc123: войди» — значение само с двоеточием.
      if (!strong && looksLikeSecret(word, kind)) {
        return { start: candidate.start, end: candidate.start + word.length, text: word };
      }
      // «Facebook:», «Telegram:» — слово-уточнение, дальше значение.
      if (phase === 'beforeValue' || !isNameWord(word)) return null;
      strong = true;
      phase = 'beforeValue';
      continue;
    }
    const value = valueBounds(candidate);
    if (!value) return null;
    if (strong) {
      if (NON_VALUES.test(value.text) || hasMask(value.text)) return null;
      return kind === 'password' ? phraseValue(text, value) : value;
    }
    if (WEAK_SEPARATORS.has(value.text.toLowerCase())) {
      phase = 'beforeValue';
      continue;
    }
    if (looksLikeSecret(value.text, kind)) return value;
    if (phase === 'start' && PREPOSITIONS.has(value.text.toLowerCase())) {
      phase = 'names';
      continue;
    }
    if (phase === 'names' && names < 2 && isNameWord(value.text)) {
      names += 1;
      continue;
    }
    if (phase === 'start' && isNameWord(value.text)) {
      phase = 'beforeValue';
      continue;
    }
    return null;
  }
  return null;
}

function applyRanges(text: string, ranges: Token[]): string {
  if (ranges.length === 0) return text;
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  let out = '';
  let cursor = 0;
  for (const range of sorted) {
    if (range.start < cursor) continue;
    out += text.slice(cursor, range.start) + MASK;
    cursor = range.end;
  }
  return out + text.slice(cursor);
}

function maskLabelledValues(text: string): string {
  const ranges: Token[] = [];
  for (const [re, kind] of LABELS) {
    for (const match of text.matchAll(re)) {
      const value = labelledValue(text, (match.index ?? 0) + match[0].length, kind);
      if (value) ranges.push(value);
    }
  }
  return applyRanges(text, ranges);
}

// «4821 пароль от мака», «Qwe12345 — пароль связки ключей».
const VALUE_BEFORE_PASSWORD =
  /(?<![\p{L}\p{N}_])([^\s"'«»(),;]{4,64})([,.]?\s+(?:[—–:-]\s+)?(?:это\s+)?(?:мой\s+|моя\s+|его\s+|её\s+|ее\s+|наш\s+)?(?:пароль|password)(?![\p{L}\p{N}_]))/giu;
// «в 2024 пароль сменил» — год, а не пароль.
const PRECEDING_PREPOSITION =
  /(?:^|[\s(«"])(?:в|с|до|после|к|на|за|from|in|since|until|by)\s+$/iu;
// «Заказ 48213, пароль от двери 4521», «Звони 8700…, пароль скажу» — номер
// заказа, счёта, квартиры или телефон, а не пароль (одно слово между ними
// допускается: «заказ номер 48213»).
const PRECEDING_NUMBER_LABEL =
  /(?:^|[\s(«"])(?:заказ\p{L}*|№|#|номер\p{L}*|тел\.?|телефон\p{L}*|(?:по)?звон\p{L}*|сч[её]т\p{L}*|кв\.?|квартир\p{L}*|дом|id|order|invoice|phone)[\s:.]*(?:[\p{L}№#.]+\s+)?$/iu;
const PHONE_LIKE = /^\+?[78]\d{10}$/;

function looksLikeNumberNotPassword(value: string, before: string): boolean {
  if (/^[№#]/u.test(value)) return true;
  // Хвост телефона «8(700)1234567» или «700-1234567».
  if (/^[\d-]+$/.test(value) && /[)\-]$/.test(before)) return true;
  if (PHONE_LIKE.test(value.replace(/[\s()-]/g, ''))) return true;
  return /^[\d-]+$/.test(value) && PRECEDING_NUMBER_LABEL.test(before);
}

function maskValueBeforePassword(text: string): string {
  return text.replace(
    VALUE_BEFORE_PASSWORD,
    (match: string, raw: string, rest: string, offset: number) => {
      // «Заказ 48213. Пароль…» — точка после значения остаётся точкой.
      const trail = raw.match(/[.,]+$/u)?.[0] ?? '';
      const value = raw.slice(0, raw.length - trail.length);
      if (!looksLikeSecret(value, 'password')) return match;
      if (PRECEDING_PREPOSITION.test(text.slice(Math.max(0, offset - 12), offset))) {
        return match;
      }
      if (looksLikeNumberNotPassword(value, text.slice(Math.max(0, offset - 40), offset))) {
        return match;
      }
      return `${MASK}${trail}${rest}`;
    },
  );
}

// --- SMS с одноразовым кодом --------------------------------------------------

const CODE_VALUE = /^(?:[A-Z]-)?\d(?:-?\d){3,7}$/;
// «5281 — ваш код для входа», «Kaspi.kz: 1234 - Код для входа в Kaspi.kz».
const VALUE_BEFORE_CODE =
  /(?<![\p{L}\p{N}_-])(\d(?:-?\d){3,7})([,.]?\s+(?:[—–:-]\s+)?(?:это\s+)?(?:ваш\s+|твой\s+)?код(?:а|ом)?\s+(?:для\s+входа|входа|подтверждения|доступа|авторизации|верификации|безопасности|из\s+(?:смс|sms)))/giu;
// «G-123456 is your Google verification code».
const VALUE_IS_YOUR_CODE =
  /(?<![A-Za-z0-9_-])((?:[A-Z]-)?\d(?:-?\d){3,7})(\s+is\s+your\s+(?:[\p{L}.]+\s+){0,3}code)(?![\p{L}\p{N}_])/giu;
// Признаки служебного SMS: только с ними голое «код:»/«code:» — подпись.
const SMS_MARKER =
  /никому\s+не\s+(?:сообщайте|говорите|давайте|показывайте|передавайте)|не\s+(?:сообщайте|передавайте|показывайте|давайте)\s+(?:его|код|никому)|do\s+not\s+share|don['’]t\s+share|never\s+share|is\s+your\s+(?:[\p{L}.]+\s+){0,3}code/iu;
// «Ваш код: 5281», «Your WhatsApp code: 123-456» — подпись сама по себе SMS.
const POSSESSIVE_CODE_LABEL =
  /(?<![\p{L}\p{N}_])(?:ваш|твой|your(?:\s+[\p{L}.]+){0,2})\s+(?:код|code)\s*:/giu;
const BARE_CODE_LABEL = /(?<![\p{L}\p{N}_])(?:код|code)(?![\p{L}\p{N}_])/giu;

function codeAfter(text: string, from: number): Token | null {
  let position = from;
  for (let step = 0; step < 2; step += 1) {
    const token = nextToken(text, position);
    if (!token || hasMask(token.text)) return null;
    position = token.end;
    const body = token.text.replace(/^[:=]+/, '');
    if (!body) continue;
    const value = valueBounds({ start: token.end - body.length, end: token.end, text: body });
    return value && CODE_VALUE.test(value.text) ? value : null;
  }
  return null;
}

function maskSmsCodes(text: string): string {
  let out = text.replace(
    VALUE_BEFORE_CODE,
    (match: string, value: string, rest: string, offset: number) =>
      PRECEDING_PREPOSITION.test(text.slice(Math.max(0, offset - 12), offset))
        ? match
        : `${MASK}${rest}`,
  );
  out = out.replace(VALUE_IS_YOUR_CODE, (_match: string, _value: string, rest: string) => `${MASK}${rest}`);
  const labels = SMS_MARKER.test(out) ? BARE_CODE_LABEL : POSSESSIVE_CODE_LABEL;
  const ranges: Token[] = [];
  for (const match of out.matchAll(labels)) {
    const value = codeAfter(out, (match.index ?? 0) + match[0].length);
    if (value) ranges.push(value);
  }
  return applyRanges(out, ranges);
}

// --- Настройки: POSTGRES_PASSWORD: …, "DB_PASSWORD": "…", dbPassword: … ------

const CONFIG_TAIL = String.raw`\1([ \t]*[:=][ \t]*)(?!\[скрыто\])(?:"([^"\n]*)"|'([^'\n]*)'|([^\s"',;}\]]+))`;
// snake_case, kebab-case, через точку, ВЕРХНИЙ_РЕГИСТР. Суффикс — целый
// сегмент: bypass, compass, BYPASS, passport, token_count не трогаются.
const CONFIG_SNAKE = new RegExp(
  String.raw`(?<![A-Za-z0-9_.-])(["']?)((?:[A-Za-z][A-Za-z0-9]*[_.-])*(?:token|secret|pass(?:word|wd)?|pwd|api[_-]?key|apikey|private[_-]?key))` +
    CONFIG_TAIL,
  'gi',
);
// camelCase — с учётом регистра: dbPassword, smtpPass, apiKey.
const CONFIG_CAMEL = new RegExp(
  String.raw`(?<![A-Za-z0-9_.-])(["']?)([a-z][a-z0-9]*(?:[A-Z][a-z0-9]*)*(?:Token|Secret|Pass(?:word|wd)?|Pwd|ApiKey|PrivateKey))` +
    CONFIG_TAIL,
  'g',
);

function maskConfigValues(text: string): string {
  const replace = (
    match: string,
    quote: string,
    name: string,
    separator: string,
    doubleQuoted: string | undefined,
    singleQuoted: string | undefined,
    bare: string | undefined,
  ): string => {
    const value = doubleQuoted ?? singleQuoted ?? bare ?? '';
    // true/null/«не нужен» и ссылка на переменную ${VAR} — не значение.
    if (
      !value.trim() ||
      hasMask(value) ||
      NON_VALUES.test(value.trim().split(/\s+/u)[0]) ||
      /^\$\{?[A-Za-z_]/.test(value)
    ) {
      return match;
    }
    const valueQuote =
      doubleQuoted !== undefined ? '"' : singleQuoted !== undefined ? "'" : '';
    return `${quote}${name}${quote}${separator}${valueQuote}${MASK}${valueQuote}`;
  };
  return text.replace(CONFIG_SNAKE, replace).replace(CONFIG_CAMEL, replace);
}

// --- Ответ на просьбу бота ----------------------------------------------------

// О чём бот может просить.
const SECRET_REQUEST_LABEL =
  /(?<![\p{L}\p{N}_])(?:парол(?:ь|я|ю|ем|е)|pass(?:word|code|phrase)|пин(?:[- ]?код\p{L}*)?|pin(?:[- ]?code)?|2fa|otp|двухфактор\p{L}*|одноразов\p{L}*\s+код\p{L}*|код(?:а|ом)?\s+(?:доступа|подтверждения|входа|для\s+входа|из\s+\p{L}+|авторизации|верификации|безопасности)|код(?:а|ом)?,?\s+(?:котор\p{L}*\s+)?(?:приш\p{L}*|прид\p{L}*)|(?:login|verification|security|confirmation|one[- ]time|sms)\s+code|токен(?:а|ом)?|token|api[_ -]?key|апи[- ]?ключ\p{L}*|ключ(?:а|ом)?\s+(?:api|апи|доступа|авторизации))(?![\p{L}\p{N}_])/iu;
// «Пришли код», «Жду код», «Пришли шестизначный код», «цифры из SMS» —
// голое слово «код» просьба, только рядом с прямой просьбой.
const BARE_CODE_LABEL_IN_REQUEST =
  /(?<![\p{L}\p{N}_])(?:код(?:а|ом)?|code|цифр\p{L}*\s+из\s+(?:смс|sms|сообщения))(?![\p{L}\p{N}_])/iu;
// Прямая просьба прислать.
const REQUEST_VERB =
  /(?<![\p{L}\p{N}_])(?:пришли(?:те)?|прислать|присылай(?:те)?|скинь(?:те)?|скинуть|введи(?:те)?|ввести|вводи(?:те)?|напиши(?:те)?|написать|отправь(?:те)?|отправить|продиктуй(?:те)?|дай(?:те)?|дать|скажи(?:те)?|сказать|подскажи(?:те)?|укажи(?:те)?|жду|ожидаю|нужен|нужна|нужно|нужны|понадобится|send|enter|type|share|provide|give|need|tell)(?![\p{L}\p{N}_])/iu;
// Вопрос тоже просьба: «Какой пароль от Wi-Fi?».
const QUESTION_CUE = /\?\s*$|(?<![\p{L}\p{N}_])(?:какой|какая|какое|what)(?![\p{L}\p{N}_])/iu;
// Своя строка хоста повторяет текст человека или маску — это не просьба.
const HOST_ECHO = /^\s*⏳\s*Работаю над(?![\p{L}\p{N}_])/u;

function sentences(text: string): string[] {
  return text.split(/(?<=[.!?…])\s+|\n+/u).filter((part) => part.trim());
}

/** The bot asked for a password, a login code or a key (end of its message). */
export function isSecretRequest(botText: string): boolean {
  const text = String(botText || '');
  if (HOST_ECHO.test(text) || hasMask(text) || text.includes(CHAT_SECRET_PREVIEW)) {
    return false;
  }
  // The request is the end of the bot's message; a long report that merely
  // mentions «пароль» at the top does not turn the next number into one.
  // A label alone is a report («токен бота обновил»), not a request.
  return sentences(text.slice(-500)).some((sentence) => {
    const verb = REQUEST_VERB.test(sentence);
    if (SECRET_REQUEST_LABEL.test(sentence)) return verb || QUESTION_CUE.test(sentence);
    return verb && BARE_CODE_LABEL_IN_REQUEST.test(sentence);
  });
}

export interface BotReply {
  content: string;
  timestamp: string;
}

// Просьбы, отправленные в чат (в том числе промежуточной репликой «⏳ …»,
// которая в messages не сохраняется). Только память процесса: после
// перезапуска остаются сохранённые ответы бота.
const NOTED_PER_CHAT = 8;
const NOTED_CHATS_MAX = 500;
// Время Telegram у сообщения и часы хоста расходятся на секунды.
const NOTE_CLOCK_SKEW_MS = 60_000;
const notedSecretRequests = new Map<string, number[]>();

/**
 * Remember a delivered bot text that asks for a password or a code. Called
 * for every text the host delivers; a later reply without a request never
 * clears it («Хорошо, жду» after «Пришли код»).
 */
export function noteBotTextForSecretRequests(
  chatJid: string,
  text: string,
  at: number = Date.now(),
): boolean {
  if (!chatJid || !Number.isFinite(at) || !isSecretRequest(text)) return false;
  const kept = (notedSecretRequests.get(chatJid) ?? []).filter(
    (time) => at - time <= SECRET_REQUEST_WINDOW_MS,
  );
  kept.push(at);
  kept.sort((a, b) => a - b);
  notedSecretRequests.delete(chatJid);
  notedSecretRequests.set(chatJid, kept.slice(-NOTED_PER_CHAT));
  while (notedSecretRequests.size > NOTED_CHATS_MAX) {
    const oldest = notedSecretRequests.keys().next().value;
    if (oldest === undefined) break;
    notedSecretRequests.delete(oldest);
  }
  return true;
}

/** Tests only. */
export function _resetNotedSecretRequests(): void {
  notedSecretRequests.clear();
}

/**
 * The bot asked for a secret within the hour before this message: in one of
 * its stored replies (newest first, any of them — a later «Хорошо, жду» does
 * not cancel the request) or in a delivered text noted for `chatJid`.
 * A false positive only hides a short meaningless string from the journal
 * and the status line; the model always gets the original text.
 */
export function followsSecretRequest(
  botReplies: BotReply | ReadonlyArray<BotReply> | undefined | null,
  messageAt: number = Date.now(),
  chatJid?: string,
): boolean {
  if (!Number.isFinite(messageAt)) return false;
  if (chatJid) {
    for (const at of notedSecretRequests.get(chatJid) ?? []) {
      const age = messageAt - at;
      if (age >= -NOTE_CLOCK_SKEW_MS && age <= SECRET_REQUEST_WINDOW_MS) return true;
    }
  }
  const replies: ReadonlyArray<BotReply> = !botReplies
    ? []
    : Array.isArray(botReplies)
      ? botReplies
      : [botReplies as BotReply];
  return replies.some((reply) => {
    if (!reply) return false;
    const at = Date.parse(reply.timestamp);
    if (!Number.isFinite(at)) return false;
    const age = messageAt - at;
    if (age < -5 * 60_000 || age > SECRET_REQUEST_WINDOW_MS) return false;
    return isSecretRequest(reply.content);
  });
}

function looksLikeReplySecret(value: string): boolean {
  if (!value || hasMask(value) || EMAIL.test(value) || URL_LIKE.test(value)) {
    return false;
  }
  if (looksLikeDateTimeOrAmount(value)) return false;
  const length = Array.from(value).length;
  if (/^\d{4,12}$/.test(value)) return true;
  if (length < 6 || length > 64) return false;
  return (/\d/.test(value) && /\p{L}/u.test(value)) || characterClasses(value) >= 3;
}

function maskSecretReply(text: string): string {
  const voice = text.match(/^(\s*\[(?:Voice|Audio)[^\]:]*:\s*)([\s\S]*?)(\s*\]\s*)$/i);
  if (voice) return voice[1] + maskSecretReply(voice[2]) + voice[3];
  const parts = text.match(/^(\s*(?:@[\p{L}\p{N}_]+[\s,:]+)?)([\s\S]*?)(\s*)$/u);
  if (!parts) return text;
  const [, lead, body, tail] = parts;
  if (!body || Array.from(body).length > 120) return text;
  if (looksLikeDateTimeOrAmount(body)) return text;
  // Код входа часто набирают через пробел, чтобы Telegram его не сжёг.
  if (/^\d(?:[\s-]?\d){3,11}$/.test(body)) return `${lead}${MASK}${tail}`;
  const pieces = body.split(/(\s+)/);
  if (pieces.filter((_, index) => index % 2 === 0).length > 4) return text;
  let changed = false;
  for (let index = 0; index < pieces.length; index += 2) {
    const piece = pieces[index];
    if (hasMask(piece)) continue;
    const value = valueBounds({ start: 0, end: piece.length, text: piece });
    if (!value || !looksLikeReplySecret(value.text)) continue;
    if (/^\d+$/.test(value.text) && unitWord().test(pieces[index + 2] ?? '')) continue;
    pieces[index] = piece.slice(0, value.start) + MASK + piece.slice(value.end);
    changed = true;
  }
  return changed ? `${lead}${pieces.join('')}${tail}` : text;
}

// --- Вход ----------------------------------------------------------------------

/**
 * The text with passwords, codes and keys replaced by «[скрыто]» — for
 * storage and the host's own echo only, never for what the model receives.
 */
export function maskChatSecrets(
  text: string,
  context: ChatSecretContext = {},
): string {
  if (typeof text !== 'string' || !text) return text;
  let out = text;
  for (const [re, replacement] of SHAPE_RULES) out = out.replace(re, replacement);
  out = maskValueBeforePassword(out);
  out = maskSmsCodes(out);
  out = maskLabelledValues(out);
  // После подписей: «password: correct horse» подпись скрывает целиком, а
  // здесь — только то, что подпись не узнаёт (DB_PASSWORD, pass, pwd).
  out = maskConfigValues(out);
  if (context.afterSecretRequest) out = maskSecretReply(out);
  return out;
}

/** Text that is nothing but masked secrets (and punctuation). */
export function isOnlyMaskedSecrets(masked: string): boolean {
  return (
    hasMask(masked) &&
    !/[\p{L}\p{N}]/u.test(masked.split(MASK).join(''))
  );
}
