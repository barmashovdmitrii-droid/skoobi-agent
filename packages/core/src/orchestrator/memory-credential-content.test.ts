import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { resetInstanceProfileForTests, setInstanceProfileForTests } from './instance-profile.js';
import { containsMemoryCredentials } from './memory-credential-content.js';
// The names of the people, services and accounts of one installation come from
// its instance profile (credentialDetector). The cases below run with an
// invented one: two people («Образец», «Эталон», Sampler) and two services.
const FIXTURE_PROFILE = {
  credentialDetector: {
    peopleWords: ['образец', 'образца', 'образцу', 'образцом', 'эталон', 'эталона', 'sampler', "sampler's"],
    nameWords: ['fixturename'],
    serviceWords: ['fixturepay', 'payfixture'],
    accountWords: ['fixturepay', 'payfixture'],
  },
};
beforeEach(() => setInstanceProfileForTests(FIXTURE_PROFILE));
afterEach(() => resetInstanceProfileForTests());
it.each([
  '.env unchanged; authorization completed; токены жалко',
  'Пароль не понадобился', 'password unchanged', 'token budget',
  'API key, cookie, private key and secret are field labels',
  { operationId: 'disk-authorization', completed: ['.env неизменён'] },
  // Connectors are glue now; status words after them are still not values.
  '.env не трогали', 'password is required', 'the password was reset',
  'пароль был сброшен', 'пароль — тот же', 'password-protected archive',
  'secret sauce', 'top secret project-x-2026', 'private key file',
  'token budget is 50000000', 'token budget: 12000000',
  'ssh key лежит в домашней папке', 'токен — это единица текста',
  // Review r1111 (turn-3, security-4): notes about a password or a key name
  // carry no value. The prod card «SSH key <word>.» was refused for its
  // sentence-ending period.
  'Проверено: SSH key accepted.', 'Bot token rotated.', 'Добавил SSH key deploy_key на VDS',
  'ssh key id_ed25519 лежит в ~/.ssh', 'ssh key: ~/.ssh/id_ed25519_node2',
  'Пароль от Wi-Fi в офисе знает Образец', 'пароль от роутера поменяли на прошлой неделе',
  'Пароль у владельца, бот его не хранит', 'пароль администратора сменили 09.11',
  'пароль администратора сменили после чистки 09.11', 'Пароль Mac вычищен из истории 09.11',
  'Пароль от почты хранится у Образца, не спрашивать', 'Образец просил: пароль от VDS знает только Эталон',
  'Пароль Kaspi приходит по SMS', 'Пароль от Kaspi приходит по SMS', 'пароль от почты теперь знает только Образец',
  'Владелец сменил пароль от Kaspi', 'Пароль от Wi-Fi в офисе поменяли 05.11',
  // Review r1111 (security-1): state words stay allowed when no value follows.
  'пароль сброшен', 'password was reset', 'пароль сменён на новый', 'Пароль не понадобился для входа',
  'password is required for login', 'the password was reset yesterday', 'пароль сброшен вчера',
  'пароль сменён на прошлой неделе', 'password changed to a stronger one', 'password reset to default',
  'пароль тот же, что и раньше', 'пароль в менеджере паролей', 'password unchanged since March',
  'пароль обновлён в 1Password',
  // Review r1111 (regress-1, security-2): free words before a non-opaque value.
  'Токен бота Справки перевыпущен 28.07, новый лежит в .env', 'ключ API Fixturepay: в .env',
  'Payfixture API token хранится в .env как PAYFIXTURE_TOKEN', 'token usage for gpt-5.5 is 1200000',
  'ключ проекта: date-repair-2026', 'Ключ Образца — v2 (префикс afk_), заголовок X-API-Key',
  'Токен у Скуби (только в .env, НЕ в памяти), подтверждён 6 июня', 'Картинка Nano Banana = фикс 6 500 токенов',
  'токен в файле ~/.config/skoobi/secrets.env, ключ TELEGRAM_BOT_TOKEN', 'Секреты на сервере в secrets/ (chmod 600).',
  'токен для модели gpt-5.5-codex-mini', 'cookie consent banner accepted', 'логин/пароль как fallback',
  JSON.stringify({ kind: 'project_value', value: 'token budget', note: 'API key for OpenAI лежит в .env' }),
])('allows references without values: %j', value => expect(containsMemoryCredentials(value)).toBe(false));
it.each([
  'password=synthetic-placeholder', 'пароль 4829',
  'SHOP_API_KEY=synthetic-placeholder', 'TELEGRAM_BOT_TOKEN=synthetic-placeholder',
  { password: 'synthetic-placeholder' },
  { key: 'api_key', value: 'synthetic-placeholder' },
  // Review r1111 (memory detector): words joined by «-» after «:» or with no
  // connector read as prose («API key: read-only», «Bot token: long-lived»),
  // so these placeholders carry a digit now; after «=» they are still values.
  'token: synthetic-placeholder-' + '42', 'access_token=synthetic-placeholder',
  'ключ доступа synthetic-placeholder-' + '42', 'api_key synthetic-placeholder-' + '42',
  'Bearer synthetic-placeholder', 'Authorization: Basic c3ludGhldGlj',
  '-----BEGIN ' + 'PRIVATE KEY-----', '-----BEGIN OPENSSH ' + 'PRIVATE KEY-----',
  '-----BEGIN RSA ' + 'PRIVATE KEY-----', 'Cookie: session=synthetic-placeholder',
  '{"password":"synthetic-placeholder"}',
  { nested: ['пароль: synthetic-placeholder'] },
  // Review r1111 (M3): these passed the new detector but the old word filter
  // refused them. Values are assembled so the pre-commit secret scan stays quiet.
  'VDS root password is ' + 'Xyz' + '123', 'The admin password was ' + 'Xyz' + '123',
  'пароль — это ' + '4829', 'пароль был ' + '4829', 'password - ' + 'Xyz' + '123',
  'the bot token is ' + 'a8f3' + 'c91d7e', 'token is ' + 'a8f3' + 'c91d7e',
  'secret is ' + 'a8f3' + 'c91d7e', 'client secret — ' + 'a8f3' + 'c91d7e',
  // «ssh key a8f3…» without a connector is no longer read as a key (turn-3:
  // «SSH key deploy_key добавлен» is a key name); with one it still is.
  'ssh key: ' + 'a8f3' + 'c91d7e', 'ssh key — ' + 'a8f3' + 'c91d7e', 'private key: ' + 'a8f3' + 'c91d7e',
  'токен — ' + 'a8f3' + 'c91d7e', 'токен бота — ' + 'a8f3' + 'c91d7e',
  'токен от бота: ' + 'a8f3' + 'c91d7e', 'ключ API — ' + 'a8f3' + 'c91d7e',
  'секрет вебхука — ' + 'a8f3' + 'c91d7e',
  // Review r1111 (security-4, turn-3): a value after whose-password words.
  'пароль от почты: ' + 'Kotik' + '2026', 'пароль от wifi ' + '8765' + '4321', 'пароль от вайфая ' + '8765' + '4321',
  'пароль администратора ' + 'Qwe' + '123', 'пароль от почты — котик', 'пароль администратора: котик',
  'пароль был котик', 'пароль qwerty никому не говори', 'пароль для VDS ' + 'Qwe' + 'rty' + '123',
  'пароль от почты ' + 'Xyz' + '123.', 'пароль от wifi — кошка', 'Пароль от VDS для root: ' + 'Xk9' + 'qLm2' + 'Pz7w',
  'пароль от мака ' + 'Xk9' + 'qLm2' + 'Pz7w', 'password for VDS root: ' + 'Xk9' + 'qLm2' + 'Pz7w',
  'Fixturepay merchant password: ' + 'Xk9' + 'qLm2' + 'Pz7w', 'Fixturepay merchant password ' + 'Xk9' + 'qLm2' + 'Pz7w',
  'ssh key passphrase is ' + 'Kot' + 'Ik2026',
  // Review r1111 (security-1): a state word does not hide the value after it.
  'password set to ' + 'Xyz' + '123', 'password reset to ' + 'Xyz' + '123',
  'VDS root password updated to ' + 'Xyz' + '123', 'password changed to ' + 'Xyz' + '123',
  'пароль сменён на ' + 'Xyz' + '123', 'пароль новый ' + 'Xyz' + '123', 'Пароль тот же — ' + 'Xyz' + '123',
  'пароль прежний ' + 'Xyz' + '123', 'пароль установлен ' + 'Xyz' + '123', 'пароль сменён на ' + 'kotik',
  'пароль от роутера поменяли на ' + 'Qwe' + '123', 'VDS: пароль сменён на ' + 'Xyz' + '123',
  // Review r1111 (regress-1, security-2): label, free words, then the value.
  'Google OAuth client secret ' + 'GOC' + 'SPX-' + 'Ab12Cd34' + 'Ef56Gh78' + 'Ij90Kl',
  'API token for Payfixture: ' + '3f9c' + 'a1b2-' + '7d4e-' + '4c5f-' + '9a8b-' + '1c2d3e4f5a6b',
  'Payfixture API token for payments ' + '3f9c' + 'a1b2-' + '7d4e-' + '4c5f-' + '9a8b-' + '1c2d3e4f5a6b',
  'Fixturepay secret key ' + 'a8f3' + 'c91d7e' + '42b0' + '5f6a7c8d' + '9e0f1a2b',
  'webhook secret ' + 'a8f3' + 'c91d7e' + '42b0' + '5f6a7c8d' + '9e0f1a2b',
  'GitHub token for CI: ' + 'Xk9' + 'qLm2' + 'Pz7w',
  'токен для Payfixture: ' + '3f9c' + 'a1b2-' + '7d4e-' + '4c5f-' + '9a8b-' + '1c2d3e4f5a6b',
  'Токен API Payfixture: ' + '3f9c' + 'a1b2-' + '7d4e-' + '4c5f-' + '9a8b-' + '1c2d3e4f5a6b',
  'ключ API Fixturepay: ' + 'a8f3' + 'c91d7e' + '42b0' + '5f6a7c8d' + '9e0f1a2b',
  'секретный ключ Fixturepay ' + 'a8f3' + 'c91d7e' + '42b0' + '5f6a7c8d' + '9e0f1a2b',
  'OpenAI token for Skoobi: ' + '9f8e7d6c' + '5b4a3210' + 'fedcba98' + '76543210',
  'the token for the VDS is ' + '9f8e7d6c' + '5b4a3210' + 'fedcba98' + '76543210',
  'api_key for weather = ' + '9f8e7d6c' + '5b4a3210' + 'fedcba98' + '76543210',
  'GOOGLE_CLIENT_SECRET in .env is ' + 'GOC' + 'SPX-' + '9f8e7d6c' + '5b4a3210' + 'fedcba98',
  'private key for the wallet: ' + '5Kb8kLf9' + 'zgWQnogi' + 'dDA76MzPL6TsZZY36hW',
  'admin cookie sessionid=' + '9f8e7d6c' + '5b4a3210' + 'fedcba98' + '76543210',
  'Notion integration ' + 'sec' + 'ret_' + '9f8e7d6c' + '5b4a3210' + 'fedcba98' + '76543210',
  'token of the Yandex Direct account: ' + 'y0' + '_Ag' + '9f8e7d6c' + '5b4a3210' + 'fedcba98',
  'access token (Instagram): ' + 'IGQ' + 'VJ' + '9f8e7d6c' + '5b4a3210' + 'fedcba98',
  'Instagram access token для автопостинга: ' + 'IGQ' + 'VJ' + '9f8e7d6c' + '5b4a3210' + 'fedcba98',
  'Токен Яндекс Директа — ' + 'y0' + '_Ag' + '9f8e7d6c' + '5b4a3210' + 'fedcba98',
  'Notion API token для интеграции: ' + 'ntn' + '_' + '9f8e7d6c' + '5b4a3210' + 'fedcba98' + '76543210',
  JSON.stringify({ note: 'API token for Payfixture: ' + '3f9c' + 'a1b2-' + '7d4e-' + '4c5f-' + '9a8b-' + '1c2d3e4f5a6b' }),
])('blocks actual credential forms: %j', value => expect(containsMemoryCredentials(value)).toBe(true));
// The runner (separate build) refuses memory_save before the host sees it and
// keeps an exact copy of this detector. Edit both together.
it('the runner copy is identical to the host detector', () => {
  const host = fileURLToPath(new URL('./memory-credential-content.ts', import.meta.url));
  const runner = fileURLToPath(new URL('../../../../agent/runner/src/memory-credential-content.ts', import.meta.url));
  expect(fs.readFileSync(runner, 'utf8')).toBe(fs.readFileSync(host, 'utf8'));
});
// Many labels in one long text must not make the check quadratic.
it('stays fast on a long text full of labels', () => {
  const text = 'Пароль от почты хранится у Образца, token budget is 5000 и cookie banner '.repeat(900);
  const started = performance.now();
  expect(containsMemoryCredentials(text)).toBe(false);
  expect(performance.now() - started).toBeLessThan(1000);
});
// Review r1111 delta (memsec-1): an English password label followed by one
// Latin word that ends the phrase, or by a quoted Latin word, is a dictated
// value. 3c5ff5d refused all of these (memory_save by the word «password»,
// memory_state by SPOKEN_PASSWORD); 2c073e6 let them through as «names».
it.each([
  'password ' + 'Kotik', 'password ' + 'admin', 'VDS root password ' + 'toor', 'root password ' + 'Hunter',
  'wifi password ' + 'admin', 'Wi-Fi password ' + 'Kotik', 'router password ' + 'admin, login admin',
  'Kaspi password ' + 'Kotik', 'admin panel password ' + 'Qwerty', 'user root password ' + 'Kotik',
  'login admin / password ' + 'Kotik', 'Роутер офиса: login admin, password ' + 'admin',
  'password "' + 'Kotik"', 'password «' + 'Kotik»', 'password ' + 'kotik!', 'Kaspi password "' + 'Kotik"',
  'passwd ' + 'Kotik', 'Password ' + 'Admin', 'пароль "' + 'Kotik"',
  'password ' + 'toor\r\nдальше',
])('blocks a bare English password value: %j', value => expect(containsMemoryCredentials(value)).toBe(true));
it.each([
  'password for VDS root', 'password for Kaspi', 'Kaspi password works.', 'password via SMS',
  'Kaspi password expired', 'password', 'Kaspi password, login and 2FA are in the vault',
  'Kaspi password was rotated.', 'password Kaspi Business приходит по SMS', 'Mac password changed',
  // Review r1111 (memory detector): a plain word after «for <name>» cannot be
  // told from the account name («password for Kaspi Business», «… for Fixturepay
  // prod.»), so «password for VDS Kotik» is a note now; with a digit, a sign,
  // quotes or a connector («password for VDS: Kotik») it is still refused.
  'password for VDS ' + 'Kotik', 'Ask Sampler for the password for Fixturepay prod.',
])('allows English notes about a password: %j', value => expect(containsMemoryCredentials(value)).toBe(false));
// Review r1111 delta (memsec-2): «<provider> secret <value>» and «private key
// <value>» without a connector: machine-made shapes (hex 32+, uuid, mixed-case
// base58/base64 with a digit) are values; names with - _ . are not.
const HEX32 = '0123' + '4567' + '89ab' + 'cdef' + '0123' + '4567' + '89ab' + 'cdef';
const UUID = '3f2a' + '1b4c-' + '5d6e-' + '7f80-' + '9a1b-' + '2c3d4e5f6a7b';
const WIF = '5Kb8kLf9' + 'zgWQnogi' + 'dDA76MzPL6' + 'TsZZY36hWXMssSzNydYXYB9KF';
it.each([
  `Fixturepay secret ${HEX32}`, `Payfixture secret ${UUID}`, `merchant secret ${HEX32}`, `API secret ${HEX32}`,
  `Fixturepay merchant secret ${HEX32}`, `secret for Fixturepay ${HEX32}`, `Payfixture merchant id 12345, secret ${UUID}`,
  `Fixturepay private key ${HEX32}`, `wallet private key ${WIF}`, `private key for the wallet ${WIF}`,
  `секрет Payfixture ${UUID}`,
])('blocks a bare machine-made secret after a glued label: %j', value =>
  expect(containsMemoryCredentials(value)).toBe(true));
it.each([
  'SSH key id_ed25519_skoobi_deploy_2026 добавлен на VDS',
  'ssh key skoobi-backup-2026-11-09.pub добавлен в authorized_keys',
  'ключ ssh server3-deploy-worker-2026 добавлен на worker1',
  'private key for skoobi-memory-provenance-2026 лежит вне workspace',
  'private key signing-key-2026-07-28-rotated перевыпущен', 'secret chat backups-2026-11-09-r1110',
  'secret santa 2026-12-25 в офисе', 'top secret project-x-2026',
])('allows key and file names after a glued label: %j', value =>
  expect(containsMemoryCredentials(value)).toBe(false));
// Review r1111 delta (memsec-4): a date or a count after a state word, and
// «Пароль: у Образца» / «Пароль: нет», are notes. 3c5ff5d memory_save kept them.
it.each([
  'пароль сменён 9 ноября', 'пароль обновлён 1 раз в месяц', 'Пароль: у Образца', 'Пароль: нет',
  'Пароль от VDS: спросить у Образца', 'токен: у Образца', 'password changed 3 days ago',
])('allows a date, a count or a whereabouts after a password label: %j', value =>
  expect(containsMemoryCredentials(value)).toBe(false));
// Review r1111 (memory detector): a number of one to three digits after a
// state word is a day or a count («на 9 ноября», «новый 12 символов»), so
// «пароль новый 12 Kotik» and «пароль сменён на 9 ноября» moved to the notes
// above; a value with the digits in it is still refused.
it.each(['пароль новый 12 ' + 'Kotik', 'пароль сменён на 9 ноября', 'пароль: 12+ символов'])(
  'allows a short number before a word after a state word: %j',
  value => expect(containsMemoryCredentials(value)).toBe(false),
);
it.each([
  'пароль сменён ' + '4829', 'пароль новый ' + 'Kotik12', 'пароль: ' + 'Kotik' + '2026', 'пароль: нет' + '1234',
])('still blocks a number that is the value: %j', value => expect(containsMemoryCredentials(value)).toBe(true));
// Review r1111 delta: a CRLF or U+2028 line after a label threw a TypeError
// (the word regex could not match «\r»), so memory_save failed instead of
// answering.
it.each([
  ['пароль от почты хранится у Образца\r\nдальше', false],
  ['token budget\r\n', false],
  ['пароль от почты x', false],
  ['пароль 4829\r\nдальше', true],
])('does not throw on line breaks other than \\n: %j', (value, expected) => {
  expect(containsMemoryCredentials(value)).toBe(expected);
});
// Review r1111 delta (memsec-3): a long run without spaces after «cookie» made
// the name=value lookaheads quadratic (64 KB took seconds on the host).
it.each([
  ['cookie=', 9400],
  ['=куки=ab', 8192],
])('stays fast on %j repeated %i times', (unit, times) => {
  const text = unit.repeat(times);
  const started = performance.now();
  expect(containsMemoryCredentials(text)).toBe(false);
  expect(performance.now() - started).toBeLessThan(1000);
});
// Review r1111 (memory detector): what 724506e still got wrong. A label, its
// qualifiers, «:» and a short value; a value on the line after the label; a
// value before «— пароль»; the scheme after «Authorization:».
it.each([
  'API token for Fixturepay: ' + 'abc123' + 'def456' + 'ghi789', 'token for Fixturepay: ' + '8f3k' + '2j5h9d',
  'токен Fixturepay: ' + 'secret' + '123', 'ключ API Fixturepay: ' + 'Kotik' + '2024', 'API token: ' + 'abc123' + 'def456',
  'пароль\n' + 'Kotik' + '123', 'пароль\r\n' + 'Kotik' + '123', 'Пароль от роутера:\n' + 'Router#' + '5G88',
  'passwd\n"' + 'Kotik' + '2024"', 'password of the VDS:\n' + '00bcc28d' + '0e374dba',
  'Webhook secret for Payfixture — whsec_' + '4f8a9b2c' + '7d1e', 'token for the VDS is ' + 'A9x7' + 'Q2mZ',
  'Set the password for Fixturepay to ' + '1234', 'Образец сменил пароль на ' + 'P1FZSo' + 'GmABzF',
  'пароль от роутера поменяли, теперь ' + 'OfficeWiFi' + '88', 'Wi-Fi пароль ' + 'котикмурзик', 'пароль ' + 'котик',
  'логин/пароль от роутера\n' + 'root / ' + 'toor', 'cookie\nconnect.sid=' + 's%3Akn' + 'RWk95zt',
  'Kotik' + '2024 — пароль от Wi-Fi', 'hunter' + '2 is the VDS root password.', 'Authorization: Bearer ' + 'abc' + '123',
  '## Пароль от Wi-Fi\n\n' + 'Kotik' + '2024', '**Пароль:** ' + 'Kotik' + '2024', 'Пароль [Kaspi]: ' + 'Kotik' + '2024',
  'Логин и пароль: admin / ' + 'Kotik' + '2024', 'token value: ' + '8f3k' + '2j5h9d', { token: 'abc123' + 'def' },
  'секретный ключ Fixturepay: ' + '3f9a8b' + '7c6d5e', 'апи ключ Kaspi ' + 'GRPo3Gz' + 'AnOItgqBh9xk2Jxh',
])('blocks a value 724506e missed: %j', value => expect(containsMemoryCredentials(value)).toBe(true));
// …and the notes it refused: a word that ends the phrase, a public SSH key, a
// commit hash, «TBD», a service name or a setting after «:», a place.
it.each([
  'Owner changed the Kaspi password today.', 'Need to update the admin password ASAP.', 'Mac mini password lost.',
  'Admin password lost.', 'password policy', 'password manager is Bitwarden', 'password manager: 1Password',
  'Password for Fixturepay prod is with the owner.', 'Mac mini password is in .env, never in memory.',
  'Reset the password for Fixturepay every 90 days.', 'Passphrase for Fixturepay lost.',
  'SSH key ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI' + 'EKyEeqrlGdxvPGojna1uIttHsNC5jlukUZwKR14/Bzg deploy@example-host',
  'secret leak in commit ' + 'cba33cee7e8b1055' + 'e6b5a0f46df9ef9ef8e31547',
  'token check fixed in ' + '88421774e324b4b1' + '2b3dca3a8a0d7e88adbe83bd' + ', see review r1111',
  'token: see BotFather', 'Fixturepay token: TBD', 'Payfixture API key: pending', 'API key: see 1Password', '- token: in .env',
  'top secret: новая обложка для Тестового города', 'API key: OpenAI, лежит в .env', 'API key: read-only',
  'Bot token: long-lived', 'токен: @BotFather', 'API key: `FIXTUREPAY_API_KEY` (в .env)', 'cookie: consent=declined',
  'Wi-Fi password is on the sticker under the router.', 'пароль\nKaspi', 'пароль\nсменили вчера',
  'Пароль\n\nНе храним пароли в памяти.', '- пароль\n- токен\n- ключ API', 'пароль поменяли, теперь Kaspi просит 2FA',
  'Пароль приложения Telegram у Образца', 'Мак мини: пароль потерян', 'пароль от vds3 у Образца', '2FA — пароль не нужен',
  'vds3 — пароль от VDS у Образца', 'GPIO pin 17 drives the relay', 'PIN code has 4 digits.', 'pass the test suite before deploy',
  'пароль от почты у владельца', 'пароль от почты сменили 09.11', { secret: 'true' }, { key: 'fixturepay_token', value: 'в .env' },
])('allows a note 724506e refused: %j', value => expect(containsMemoryCredentials(value)).toBe(false));
// The check stays linear: 64 KB of labels, quotes and connectors.
it.each([
  'пароль «', 'токен ', 'пароль ', 'куки x=', 'ключ API ', 'token for ', 'пароль от ', 'secret is ', '"password":"',
  'пароль\nKotik1 ', 'сменил пароль на ', 'password a b ',
])('stays fast on 64 KB of %j', unit => {
  const text = unit.repeat(Math.ceil(65536 / unit.length)).slice(0, 65536);
  const started = performance.now();
  containsMemoryCredentials(text);
  expect(performance.now() - started).toBeLessThan(1000);
});
// The refusal hints (memory_save, memory_state) suggest these rewrites; they
// must pass, or the model is told to save what is refused again.
it.each([
  'пароль от почты у владельца', 'пароль от почты сменили 09.11', 'токен истёк', 'пароль хранится у Образца',
  'пароль хранится у бухгалтера', 'ключ API в .env', 'password policy: 12+ chars', 'пароль у Гульнары',
  'password is in Bitwarden',
])('allows the rewrite a refusal hint suggests: %j', value => expect(containsMemoryCredentials(value)).toBe(false));
// Review r1111 (memory detector), round 0: values prod 3c5ff5d refused and
// 24691c7 let through. The value sits in a table or CSV column, a field or
// identifier named after a credential, a list under the label, brackets, a
// clause after the label or before it, or several words. The full set is in
// test-fixtures/memory-credential-round0.json.
const KOTIK = 'Kotik' + '2024';
it.each([
  `| Сервис | Логин | Пароль |\n|---|---|---|\n| Kaspi | shop | ${KOTIK} |`,
  `service\tlogin\tpassword\nKaspi\tshop\t${KOTIK}`, `сервис;логин;пароль\nKaspi;shop;${KOTIK}`,
  { kind: 'fact_upsert', key: 'kaspi_password', value: 'Kotik Murka' },
  { kind: 'fact_upsert', key: 'gmail_app_password', value: 'abcd efgh ijkl mnop' },
  { kind: 'fact_upsert', key: 'wifi_password', value: 'Котик' }, { kind: 'fact_upsert', key: 'safe_password', value: '12.05.1987' },
  'Gmail app password: abcd efgh ijkl mnop', 'aws_secret_access_key = ' + 'wJalrXUtnFEMI/' + 'K7MDENG/bPxRfiCYzzz1234',
  `KASPI_PASSWORD_PROD=${KOTIK}`, 'FIXTUREPAY_API_KEY_PROD=' + '8f3k2j5h9d', `dbPassword=${KOTIK}`, `wifipassword: ${KOTIK}`,
  `{"service":"Fixturepay","adminPassword":"${KOTIK}"}`, `Пароль Kaspi сменили 10.11 на ${KOTIK}`,
  `The Kaspi password was changed on 10.11 to ${KOTIK}`, `Admin password lost; new one is ${KOTIK}`,
  `Changed the Kaspi password. New one: ${KOTIK}`, `Пароль от Wi-Fi в офисе: ${KOTIK}`, 'Пароль по умолчанию для роутера: admin' + '123',
  `Password in Kaspi Business: ${KOTIK}`, `Пароль: [${KOTIK}]`, `Kaspi password (${KOTIK}) is saved here`,
  'Пароль от Wi-Fi: Kotik 2024', 'password = Kotik Murka', 'Vault password: correct horse battery staple',
  'Пароль от Wi-Fi: котик любит рыбу', 'Пароль от сейфа: Мурка', 'kaspi:\n  логин: shop\n  пароль: Мурка',
  `The VDS root password is still ${KOTIK}`, `Пароль от Fixturepay тоже ${KOTIK}`, `Пароль от Kaspi, который дал Образец: ${KOTIK}`,
  `Sampler gave me the password for Kaspi, it is ${KOTIK}`, `${KOTIK} (пароль от Kaspi)`, `${KOTIK}\n(пароль от Kaspi)`,
  `Use ${KOTIK} as the Kaspi admin password`, 'Kq8vT2mZ' + '9pLx4RwN — secret for Fixturepay webhooks', `Пароль от Kaspi:\n- ${KOTIK}`,
  `Passwords:\n- Kaspi: ${KOTIK}\n- Fixturepay: Murka2025`, `Логин и пароль от Kaspi — shop и ${KOTIK}`,
  'Authorization header for Fixturepay: ' + '8f3k2j5h9d7a', `Пароль от Kaspi. ${KOTIK}`, `Пароль от Kaspi: см. ниже\n${KOTIK}`,
  'Пароль от сейфа: 12.05.1987', `Пароль: @${KOTIK}`, 'Пароль от почты: Kotik.Murka', `Логин shop с паролем ${KOTIK}`,
  'Ключ 2FA для GitHub: ' + 'JBSWY3DPEHPK3PXP', 'PIN-код карты Kaspi Gold: 4829', `Деплой: sshpass -p ${KOTIK} ssh root@vds`,
  'DATABASE_URL=postgres' + '://app:' + KOTIK + '@' + 'localhost:5432/app', 'kaspi_session=' + '8f3k2j5h9d7a (cookie)',
  "Kaspi password was reset; it's " + KOTIK + ' now', 'The Kaspi password has been changed to kotik', { Password: 'kotik murka' },
  `Пароль от почты, кстати, ${KOTIK}`, 'Пароль от почты, кстати, котик' + '2024', 'Secret: Kotik',
])('blocks a value prod refused and 24691c7 let through: %j', value => expect(containsMemoryCredentials(value)).toBe(true));
// …and notes 24691c7 refused: a name with a number after «от»/«for», a host,
// a project key, a hash after «утёк», a TTL, a place, a person or a scheme
// after «Пароль:», markdown «**Пароль:**», «на VDS» after a verb.
it.each([
  '**Пароль от почты:** хранится у Образца', '- **Пароль от Kaspi:** у Образца\n- **Логин:** shop', '**Пароль Wi-Fi:** на наклейке роутера',
  'Пароль от server3 знает только Эталон', 'Пароль от root@vds у владельца, по ssh-ключу заходим без него',
  'Пароль от skoobi2024-панели сменили вчера', 'Wi-Fi password for Office_5G is on the router sticker', 'Образец сменил пароль на VDS.',
  'Обновили пароль на server3.', 'пароль для пользователя user01 у Образца', 'Пароль от Битрикс24 у Образца.', 'server3 — пароль Эталона',
  'Ключ проекта: release9-wave2', 'Ключ таблицы СКУБИ: 1QwErTy0ZxCv5BnMaSdFgHjKlPoIuYtReWq74OzXc2vb', 'Ключ: box#14',
  'Токен утёк — ' + '5f0c3a917d2e4b86a1c09e3f7b5d2a4c6e8f1b03', 'Токен TTL: 2592000 сек', 'Token TTL: 86400s', 'Fixed the Kaspi password issue.',
  'Typed the Kaspi password twice.', 'The new password is long.', 'Wi-Fi password is WPA2.', 'Пароль: мин. 12 символов', 'Пароль: iCloud',
  'Пароль: сейф', 'Пароль: тетрадь, синяя.', 'Обновить пароль gmail', 'Click the "Forgot password" link.', 'Пароль «Kaspi Магазин» у Образца.',
  'Токен: OAuth2 (Google)', 'Authorization: OIDC/PKCE', 'ключ ssh: deploy@mac', 'SSH key: server3-deploy', 'Tests pass: node22',
  'pwd: build7-work/part2', 'Boarding pass: SU1234', 'Password changed 2023.', 'Пароль сменили 1500 пользователям',
  'Пароль от почты у Образца, звонил клиент Ivan2024', 'Password for the router: on the sticker (model KN-1011)',
  'Secret chat: Sampler', 'Secret Santa: Sampler',
  'Пароль: Kaspi Business, как всегда', 'password_hash: bcrypt, cost 12', 'dbPassword: process.env.DB_PASSWORD', 'Password is case-sensitive.',
  { kind: 'fact_upsert', key: 'token.ttl', value: '2592000' }, { kind: 'fact_upsert', key: 'pass', value: 'node22' },
  { kind: 'fact_upsert', key: 'password', value: 'iCloud' }, { kind: 'fact_upsert', key: 'ключ', value: 'release9-wave2' },
  { kind: 'fact_upsert', key: 'ssh.key', value: 'server3-deploy' }, { kind: 'fact_upsert', key: 'password', value: 'на роутере' },
])('allows a note 24691c7 refused: %j', value => expect(containsMemoryCredentials(value)).toBe(false));
// Round 0 slow inputs: «Cookie:» repeated made the cookie name scan
// quadratic (64 KB took 0.9 s), and dense short labels («—пин», «|пин»)
// re-read one long word per label. Windows now stop at the next label.
it.each([
  ['Cookie:', 65536], ['яCookie:', 65536], ['Cookie:ё', 65536], ['cookie:,', 65536], ['—пин', 65536], ['|пин', 65536],
  ['пин:', 65536], ['`пароль', 65536], ['a;b;пароль\n', 65536], ['| a | Password |\n', 65536], ['Пароли:\n- a: ', 65536],
  ['—пин', 1 << 20],
])('stays linear on %j up to %i characters', (unit, size) => {
  const text = unit.repeat(Math.ceil(size / unit.length)).slice(0, size);
  const started = performance.now();
  containsMemoryCredentials(text);
  expect(performance.now() - started).toBeLessThan(size > 65536 ? 4000 : 1000);
});
// The four word lists of the instance profile, one at a time: a word the
// profile lists is a holder, a first name, a service or an account; without
// the profile the same word in the same place is a value.
it.each([
  [{ peopleWords: ['образец'] }, ['Пароль: Образец', 'Пароль от Wi-Fi в офисе знает Образец', 'Пароли:\n- Kaspi — образец']],
  [{ nameWords: ['fixturename'] }, ['Пароль от Kaspi: Fixturename', 'пароль — fixturename']],
  [{ serviceWords: ['fixturepay'] }, ['Пароль: Fixturepay', 'сменил пароль на fixturepay', 'Secret: fixturepay']],
  [{ accountWords: ['fixturepay'] }, ['пароль Fixturepay', 'логин fixturepay пароль fixturepay', 'Secret: fixturepay']],
])('reads a word list of the instance profile: %j', (credentialDetector, notes) => {
  setInstanceProfileForTests({ credentialDetector });
  expect(notes.filter(note => containsMemoryCredentials(note))).toEqual([]);
  resetInstanceProfileForTests();
  expect(notes.filter(note => !containsMemoryCredentials(note))).toEqual([]);
});
// An empty profile adds nothing: the built-in lists work as before, and no
// word becomes an account or a service by accident.
it('keeps the built-in lists with an empty instance profile', () => {
  resetInstanceProfileForTests();
  const values = ['пароль ' + 'котик', 'password ' + 'Kotik', 'Secret: ' + 'Kotik', 'пароль от почты: ' + 'Kotik' + '2026', 'пароль ' + 'root' + '123'];
  expect(values.filter(value => !containsMemoryCredentials(value))).toEqual([]);
  const notes = ['пароль у владельца', 'Пароль: Kaspi', 'Пароль от роутера знает кассир', 'Пароль: Гульнара', 'пароль от root у владельца'];
  expect(notes.filter(note => containsMemoryCredentials(note))).toEqual([]);
});
