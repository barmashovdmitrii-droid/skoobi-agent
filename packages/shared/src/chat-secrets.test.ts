import { afterEach, describe, expect, it } from 'vitest';

import {
  resetInstanceProfileForTests,
  setInstanceProfileForTests,
} from './instance-profile.js';
import {
  _resetNotedSecretRequests,
  CHAT_SECRET_MASK,
  CHAT_SECRET_PREVIEW,
  followsSecretRequest,
  isOnlyMaskedSecrets,
  isSecretRequest,
  maskChatSecrets,
  noteBotTextForSecretRequests,
} from './chat-secrets.js';

// Тестовые «секреты» собраны из кусков: pre-commit хук режет строки, похожие
// на настоящие ключи.
const BOT_TOKEN = '7123456789' + ':' + 'AAH' + 'fakeFAKEfake0123456789abcdefABCD';
const GOOGLE_KEY = 'AI' + 'za' + 'SyFAKEfake0123456789abcdefABCDEFghi';
const GOOGLE_AQ_KEY = 'AQ' + '.' + 'Ab8RN6FAKEfake0123456789abcdefABCDEFghijklmnopq';
const OPENAI_KEY = 's' + 'k-proj-' + 'FAKEfake0123456789abcdef';
const M = CHAT_SECRET_MASK;

afterEach(() => resetInstanceProfileForTests());

describe('maskChatSecrets: формы ключей и токенов', () => {
  it('прячет токен Telegram-бота, в том числе внутри ссылки API', () => {
    expect(maskChatSecrets(`вот токен бота ${BOT_TOKEN} подключи`)).toBe(
      `вот токен бота ${M} подключи`,
    );
    expect(
      maskChatSecrets(`https://api.telegram.org/bot${BOT_TOKEN}/getMe`),
    ).toBe(`https://api.telegram.org/${M}/getMe`);
  });

  it('прячет ключи Google, OpenAI и закрытый ключ', () => {
    expect(maskChatSecrets(`гугл апи ключ ${GOOGLE_KEY}`)).toBe(
      `гугл апи ключ ${M}`,
    );
    expect(maskChatSecrets(`ключ ${GOOGLE_AQ_KEY}`)).toBe(`ключ ${M}`);
    expect(maskChatSecrets(`OPENAI: ${OPENAI_KEY}`)).toBe(`OPENAI: ${M}`);
    const pem =
      '-----BEGIN ' + 'OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXk\n-----END ' +
      'OPENSSH PRIVATE KEY-----';
    expect(maskChatSecrets(`ключ:\n${pem}\nготово`)).toBe(
      `ключ:\n${M}\nготово`,
    );
  });

  it('прячет пароль в ссылке, ?token= и ИМЯ_TOKEN=', () => {
    expect(maskChatSecrets('https://user:' + 'Qw3rty' + '@example.org/x')).toBe(
      'https://user:' + M + '@example.org/x',
    );
    expect(maskChatSecrets('https://x.io/api?token=' + 'abc123def&page=2')).toBe(
      `https://x.io/api?token=${M}&page=2`,
    );
    expect(maskChatSecrets('MY_BOT_TOKEN=' + 'abc123')).toBe(`MY_BOT_TOKEN=${M}`);
  });
});

describe('maskChatSecrets: подписанные значения', () => {
  it('«пароль …» со значением — прячет только значение', () => {
    expect(maskChatSecrets('пароль 4821')).toBe(`пароль ${M}`);
    expect(maskChatSecrets('Пароль: qwerty')).toBe(`Пароль: ${M}`);
    expect(maskChatSecrets('пароль от мака Шефа 4821, попробуй войти')).toBe(
      `пароль от мака Шефа ${M}, попробуй войти`,
    );
    expect(maskChatSecrets('почта user@example.com пароль Abc12345!')).toBe(
      `почта user@example.com пароль ${M}`,
    );
    expect(maskChatSecrets('пароль от user2000@example.com: Qwerty')).toBe(
      `пароль от user2000@example.com: ${M}`,
    );
    expect(maskChatSecrets('password = hunter2')).toBe(`password = ${M}`);
    expect(maskChatSecrets('{"password": "hunter"}')).toBe(
      `{"password": "${M}"}`,
    );
  });

  it('значение перед словом «пароль»', () => {
    expect(maskChatSecrets('4821 пароль от мака Шефа')).toBe(
      `${M} пароль от мака Шефа`,
    );
    expect(maskChatSecrets('Qwe12345 — пароль связки ключей')).toBe(
      `${M} — пароль связки ключей`,
    );
  });

  it('код входа в Telegram: и пересланное служебное сообщение, и ручной ввод', () => {
    expect(
      maskChatSecrets(
        'Код для входа в Telegram: 52814. Не давайте код никому, даже если его требуют от имени Telegram!',
      ),
    ).toBe(
      `Код для входа в Telegram: ${M}. Не давайте код никому, даже если его требуют от имени Telegram!`,
    );
    expect(
      maskChatSecrets('Login code: 52814. Do not give this code to anyone'),
    ).toBe(`Login code: ${M}. Do not give this code to anyone`);
    expect(maskChatSecrets('код подтверждения 52814')).toBe(
      `код подтверждения ${M}`,
    );
    expect(maskChatSecrets('пин-код 1234')).toBe(`пин-код ${M}`);
  });

  it('«токен …» и «апи ключ …» с непрозрачным значением', () => {
    expect(maskChatSecrets('токен: abcdef')).toBe(`токен: ${M}`);
    expect(maskChatSecrets('api key a1b2c3d4e5f6g7h8')).toBe(`api key ${M}`);
  });

  it('повторный прогон ничего не меняет', () => {
    const once = maskChatSecrets(`пароль 4821, токен ${BOT_TOKEN}`);
    expect(maskChatSecrets(once)).toBe(once);
    expect(maskChatSecrets(once, { afterSecretRequest: true })).toBe(once);
  });
});

describe('maskChatSecrets: значение из нескольких слов и в кавычках (ревью W19)', () => {
  // Пароли собраны из кусков: pre-commit хук.
  const WORDS = 'мой кот ' + '2020';
  const PHRASE = 'correct horse ' + 'battery staple';
  const WIFI = 'Синий Кит ' + '1985';

  it('после «:»/«=» скрывает значение до конца фразы', () => {
    expect(maskChatSecrets(`пароль: ${PHRASE}`)).toBe(`пароль: ${M}`);
    expect(maskChatSecrets(`Пароль: ${PHRASE}, зайди`)).toBe(`Пароль: ${M}, зайди`);
    expect(maskChatSecrets('пароль: qwerty, зайди')).toBe(`пароль: ${M}, зайди`);
    // Следующая подпись и новая строка — конец значения.
    expect(maskChatSecrets('Пароль: ' + 'abc12345' + '\nЛогин: admin')).toBe(
      `Пароль: ${M}\nЛогин: admin`,
    );
    expect(maskChatSecrets('Пароль: ' + 'abc12345' + ' Логин: admin')).toBe(
      `Пароль: ${M} Логин: admin`,
    );
    expect(maskChatSecrets('пароль: не нужен, зайди так')).toBe(
      'пароль: не нужен, зайди так',
    );
  });

  it('значение в кавычках скрывает целиком, кавычки остаются', () => {
    expect(maskChatSecrets(`пароль: «${WORDS}»`)).toBe(`пароль: «${M}»`);
    expect(maskChatSecrets(`пароль: "${WORDS}"`)).toBe(`пароль: "${M}"`);
    expect(maskChatSecrets(`пароль: '${WORDS}'`)).toBe(`пароль: '${M}'`);
    expect(maskChatSecrets(`пароль от вайфая: «${WIFI}», зайди`)).toBe(
      `пароль от вайфая: «${M}», зайди`,
    );
    // Без двоеточия — только если похоже на секрет.
    expect(maskChatSecrets(`пароль от вайфая «${WIFI}»`)).toBe(
      `пароль от вайфая «${M}»`,
    );
    expect(maskChatSecrets(`{"password": "${PHRASE}"}`)).toBe(
      `{"password": "${M}"}`,
    );
    const masked = maskChatSecrets(`пароль: «${WORDS}»`);
    expect(isOnlyMaskedSecrets(masked)).toBe(false);
  });

  it('название в кавычках и «не нужен» в кавычках не трогает', () => {
    for (const text of [
      'пароль от «Госуслуг» поменял',
      'пароль: «не нужен»',
    ]) {
      expect(maskChatSecrets(text)).toBe(text);
    }
  });
});

describe('maskChatSecrets: настройки и конфиги (ревью W19)', () => {
  const PW = 'Qwerty' + '123';

  it.each([
    [`POSTGRES_PASSWORD: ${PW}`, `POSTGRES_PASSWORD: ${M}`],
    [`"DB_PASSWORD": "${PW}"`, `"DB_PASSWORD": "${M}"`],
    [`db_password=${PW}`, `db_password=${M}`],
    [`SMTP_PASS=${PW}`, `SMTP_PASS=${M}`],
    [`pass: ${PW}`, `pass: ${M}`],
    [`pwd: ${PW}`, `pwd: ${M}`],
    [`GITHUB_TOKEN: ${PW}`, `GITHUB_TOKEN: ${M}`],
    [`dbPassword: ${PW}`, `dbPassword: ${M}`],
    [`{"smtp": {"pass": "my ${PW}"}}`, `{"smtp": {"pass": "${M}"}}`],
  ])('%s', (text, masked) => {
    expect(maskChatSecrets(text)).toBe(masked);
  });

  it('в блоке docker-compose скрывает только пароль', () => {
    expect(
      maskChatSecrets(
        `environment:\n  POSTGRES_USER: app\n  POSTGRES_PASSWORD: ${PW}\n  POSTGRES_DB: app`,
      ),
    ).toBe(
      `environment:\n  POSTGRES_USER: app\n  POSTGRES_PASSWORD: ${M}\n  POSTGRES_DB: app`,
    );
  });

  it.each([
    'bypass: on',
    'compass: north',
    'BYPASS=1',
    'password_reset: true',
    'token_count: 5',
    'passport: 123',
    'POSTGRES_PASSWORD: ${DB_PW}',
    'POSTGRES_PASSWORD_FILE: /run/secrets/db',
    'POSTGRES_PASSWORD:\n  next: x',
    'пароль: не нужен',
  ])('не трогает: %s', (text) => {
    expect(maskChatSecrets(text)).toBe(text);
  });

  it('не задевает уже скрытое (?token=…)', () => {
    expect(maskChatSecrets('https://x.io/api?token=' + 'abc123def&page=2')).toBe(
      `https://x.io/api?token=${M}&page=2`,
    );
  });
});

describe('maskChatSecrets: SMS с одноразовым кодом без просьбы бота (ревью W19)', () => {
  const C = '52' + '81';
  it.each([
    [`Ваш код: ${C}`, `Ваш код: ${M}`],
    [`Код ${C}. Никому не сообщайте его`, `Код ${M}. Никому не сообщайте его`],
    [
      `Kaspi.kz: ${C} - Код для входа в Kaspi.kz. Никому не сообщайте`,
      `Kaspi.kz: ${M} - Код для входа в Kaspi.kz. Никому не сообщайте`,
    ],
    [`${C} — ваш код для входа в Госуслуги`, `${M} — ваш код для входа в Госуслуги`],
    [
      'G-' + '123456 is your Google verification code.',
      `${M} is your Google verification code.`,
    ],
    ['123' + '456 is your Instagram code', `${M} is your Instagram code`],
    ['Your WhatsApp code: 123-' + '456', `Your WhatsApp code: ${M}`],
    [`Никому не говорите код! Код: ${C}`, `Никому не говорите код! Код: ${M}`],
  ])('%s', (text, masked) => {
    expect(maskChatSecrets(text)).toBe(masked);
  });

  it.each([
    'код проекта лежит в папке 2026',
    'в 2024 код для входа сменили',
    'Заказ 5281 — ваш код заказа',
    'Код 1С: 2026',
    'Login code expired',
  ])('не трогает: %s', (text) => {
    expect(maskChatSecrets(text)).toBe(text);
  });
});

describe('maskChatSecrets: номера перед словом «пароль» (ревью W19)', () => {
  it('номер заказа, счёта и телефон — не пароль', () => {
    expect(maskChatSecrets('Заказ 48213, пароль от двери ' + '4521')).toBe(
      `Заказ 48213, пароль от двери ${M}`,
    );
    for (const text of [
      'Заказ 48213. Пароль от Kaspi не нужен',
      'заказ номер 48213 пароль от двери',
      'Звони 87001234567, пароль скажу при встрече',
      'Звони 8(700)1234567, пароль скажу',
      'счёт 123456 пароль от банка',
    ]) {
      expect(maskChatSecrets(text)).toBe(text);
    }
    // Само значение перед словом по-прежнему скрывается.
    expect(maskChatSecrets('4821' + ' пароль от мака')).toBe(`${M} пароль от мака`);
  });
});

describe('maskChatSecrets: обычные сообщения не трогает', () => {
  it.each([
    'Заказ 12345 на 15000 тг, встреча 10:30',
    'Дата 09.11.2026, сумма 1 500 000 ₸, номер 87001234567',
    'пароль не нужен',
    'пароль у Шефа не нужен, он вошёл сам',
    'пароль сохранил в связке ключей',
    'пароль поменял в 2024 году',
    'сменил пароль 2 раза',
    'у меня 2 пароля и 3 ключа',
    'токены жалко, давай короче',
    'token budget is 5000',
    'код проекта лежит в папке 2026',
    'Bearer of bad news',
    'Login code expired',
    'Рабочих нужно 1500, ставка 2000 тг/час',
    'встреча в 14:00 у офиса, 3 этаж',
  ])('%s', (text) => {
    expect(maskChatSecrets(text)).toBe(text);
  });
});

describe('ответ на просьбу бота о пароле или коде', () => {
  it('узнаёт просьбу бота', () => {
    expect(isSecretRequest('Пришли пароль администратора Mac, я введу его сам')).toBe(true);
    expect(isSecretRequest('Введи код, который пришёл в Telegram')).toBe(true);
    expect(isSecretRequest('Пришли код из смс')).toBe(true);
    expect(isSecretRequest('Send me the verification code')).toBe(true);
    expect(isSecretRequest('Сколько рабочих нужно на завтра?')).toBe(false);
    expect(isSecretRequest('Поправил код проекта, проверь')).toBe(false);
    expect(isSecretRequest('Сэкономил токены квоты')).toBe(false);
  });

  it('просьба — это просьба, а не упоминание в отчёте и не строка хоста', () => {
    for (const ask of [
      'Пришли код',
      'Введи код',
      'Жду код',
      'Пришли шестизначный код',
      'Пришли цифры из SMS',
      'Какой пароль от Wi-Fi?',
      '⏳ Окно входа открыто — пришли код из SMS, введу сам',
    ]) {
      expect(isSecretRequest(ask), ask).toBe(true);
    }
    for (const report of [
      'Готово, токен бота обновил, всё работает.',
      'Сделал, пин-коды раздал.',
      `⏳ Работаю над: «${CHAT_SECRET_PREVIEW}» — уже 3 мин.`,
      `⏳ Работаю над: «${M} пароль» — уже 3 мин.`,
      '⏳ Работаю над: «пришли пароль от wifi» — уже 2 мин.',
      'Хорошо, жду.',
      'Какой код ошибки?',
      'Коды пришли на почту',
    ]) {
      expect(isSecretRequest(report), report).toBe(false);
    }
  });

  it('учитывает только недавнюю просьбу', () => {
    const now = Date.parse('2026-11-09T10:00:00.000Z');
    const ask = { content: 'Пришли пароль от Mac', timestamp: '2026-11-09T09:55:00.000Z' };
    expect(followsSecretRequest(ask, now)).toBe(true);
    expect(followsSecretRequest({ ...ask, timestamp: '2026-11-09T07:00:00.000Z' }, now)).toBe(false);
    expect(followsSecretRequest({ ...ask, content: 'Готово, отчёт в таблице' }, now)).toBe(false);
    expect(followsSecretRequest(undefined, now)).toBe(false);
    expect(followsSecretRequest({ ...ask, timestamp: 'не дата' }, now)).toBe(false);
  });

  it('любая просьба за час считается, даже если после неё бот сказал другое', () => {
    const now = Date.parse('2026-11-09T10:00:00.000Z');
    const replies = [
      { content: 'Хорошо, жду.', timestamp: '2026-11-09T09:58:00.000Z' },
      { content: 'Пришли код из SMS', timestamp: '2026-11-09T09:57:00.000Z' },
    ];
    expect(followsSecretRequest(replies, now)).toBe(true);
    expect(followsSecretRequest(replies.slice(0, 1), now)).toBe(false);
  });

  describe('просьба в промежуточной реплике, которой нет в messages', () => {
    afterEach(() => _resetNotedSecretRequests());

    it('запоминается при отправке и действует час', () => {
      const asked = Date.parse('2026-11-01T10:28:07.000Z');
      expect(
        noteBotTextForSecretRequests(
          'tg:1',
          '⏳ Окно входа открыто — пришли код из SMS, введу сам',
          asked,
        ),
      ).toBe(true);
      expect(noteBotTextForSecretRequests('tg:1', 'Хорошо, жду.', asked + 5_000)).toBe(false);
      // Последний сохранённый ответ бота — не просьба: важна заметка.
      const last = { content: 'Готово, открыл окно входа', timestamp: '2026-11-01T10:12:53.000Z' };
      expect(followsSecretRequest(last, asked + 19_000, 'tg:1')).toBe(true);
      expect(followsSecretRequest(last, asked + 19_000)).toBe(false);
      expect(followsSecretRequest(last, asked + 19_000, 'tg:2')).toBe(false);
      expect(followsSecretRequest(last, asked + 2 * 60 * 60_000, 'tg:1')).toBe(false);
      // Сообщение задолго до просьбы ответом на неё не было.
      expect(followsSecretRequest(undefined, asked - 10 * 60_000, 'tg:1')).toBe(false);
    });
  });

  it('после просьбы прячет короткий бессмысленный набор', () => {
    const ctx = { afterSecretRequest: true };
    expect(maskChatSecrets('4821', ctx)).toBe(M);
    expect(maskChatSecrets(' 4821 ', ctx)).toBe(` ${M} `);
    expect(maskChatSecrets('5 2 8 1 4', ctx)).toBe(M);
    expect(maskChatSecrets('Qw3rty!x', ctx)).toBe(M);
    expect(maskChatSecrets('вот 4821', ctx)).toBe(`вот ${M}`);
    expect(maskChatSecrets('@Skoobi 4821', ctx)).toBe(`@Skoobi ${M}`);
    expect(maskChatSecrets('[Voice: 4821]', ctx)).toBe(`[Voice: ${M}]`);
    // Без просьбы тот же текст — обычное число.
    expect(maskChatSecrets('4821')).toBe('4821');
  });

  it('после просьбы не трогает обычные ответы', () => {
    const ctx = { afterSecretRequest: true };
    for (const text of [
      'сейчас скину',
      'не помню',
      '15',
      '10:30',
      '09.11.2026',
      '1500 тенге',
      '15000₸',
      'user@example.com',
      'https://example.com/a1',
      'Давай завтра, сейчас нет времени на это, позвони в 12345 офис',
    ]) {
      expect(maskChatSecrets(text, ctx)).toBe(text);
    }
  });

  it('после просьбы число со словом-количеством — не секрет; свои слова добавляет профиль инстанса', () => {
    const ctx = { afterSecretRequest: true };
    // Встроенные слова работают без профиля.
    for (const text of [
      '1500 штук',
      '1500 человек.',
      '4821 заказов',
      '2000 KZT',
    ]) {
      expect(maskChatSecrets(text, ctx)).toBe(text);
    }
    // Слово, которого нет ни во встроенных, ни в профиле, число не защищает.
    expect(maskChatSecrets('1500 образцов', ctx)).toBe(`${M} образцов`);

    setInstanceProfileForTests({
      chatSecrets: { unitWords: ['образцов', 'fixtures'] },
    });
    for (const text of [
      '1500 образцов',
      '1500 ОБРАЗЦОВ.',
      '4821 fixtures',
      '1500 штук',
      '2000 KZT',
    ]) {
      expect(maskChatSecrets(text, ctx)).toBe(text);
    }
    // Только слово целиком, и только после числа из одних цифр.
    expect(maskChatSecrets('1500 образцовый', ctx)).toBe(`${M} образцовый`);
    expect(maskChatSecrets('Qw3rty!x образцов', ctx)).toBe(`${M} образцов`);

    resetInstanceProfileForTests();
    expect(maskChatSecrets('1500 образцов', ctx)).toBe(`${M} образцов`);
  });
});
