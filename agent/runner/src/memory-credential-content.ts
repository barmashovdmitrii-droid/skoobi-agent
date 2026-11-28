/** Recognize credential values, not words describing access or quota.
 *
 * Review r1111 (memory detector). Four rules, each bounded per label, so the
 * check stays linear in the length of the text:
 *
 * 1. Key formats (sk-, ghp_, Bearer, PEM, JWT, user:password@ in a link…) are
 *    secrets with or without a label.
 * 2. Grammar. A credential LABEL (password/пароль, token/токен, API key/ключ
 *    API, secret/секрет, private key, cookie…) may be followed by QUALIFIERS
 *    (whose it is: «от почты кассира», «for Stripe prod», «(Kaspi)», «issued
 *    by BotFather»), then by a CONNECTOR («:», «=», «—», «?», «is», «это»,
 *    «remains», «changed to», «сменён на», «теперь») or by nothing, and then
 *    by the VALUE. A word in the value slot is a value unless it is on a
 *    closed list of what notes say there: a status («сменён», «expired»), a
 *    person or a role («Гульнара», «кассир»), a place where it is kept, a
 *    service («Kaspi»), a function word. Word endings are not guessed: «Пароль:
 *    Тюльпан», «Password: Butterfly» are values. «Kotik2024 — пароль от Wi-Fi»
 *    reads backwards the same way.
 * 3. Sweep. On the label's line (and on the lines a label line opens: «:»,
 *    «ниже», a heading over one word), a strongly value-shaped word that is not
 *    the object of a preposition («от server3») and not a reference (path,
 *    host, hash, phone, version, model, env name) is a value, in whatever words
 *    it is wrapped. In a later clause it must open the clause or follow a word
 *    that points at it («…, still X», «It is X», «Value: X», «вводить X»).
 * 4. Structures. A table or CSV column headed by a label, a table row
 *    «| Пароль | … |», a field or identifier that names a credential
 *    (kaspi_password, dbPassword, STRIPE_API_KEY_PROD, {key: 'wifi_password'})
 *    and a list under «Passwords:» hold values in slots; a slot is read like
 *    the words after a connector.
 *
 * Counts are not values: a number after a plural label («Токены: 1532847»), a
 * date when the line speaks of a change or a term («Смена пароля: 10.11.2026»).
 * A window never runs past the next label, so many labels stay cheap.
 */

import { derivedFromInstanceProfile } from './instance-profile.js';

// --- Key formats that are secrets with or without a label -------------------
const SHAPE = /(?:^|[^A-Za-z0-9_-])(?:sk-(?=[A-Za-z0-9_-]{0,200}\d)[A-Za-z0-9_-]{12,}|sk_(?:live|test)_(?=[A-Za-z0-9]{0,200}\d)[A-Za-z0-9]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|glpat-(?=[A-Za-z0-9_-]{0,200}\d)[A-Za-z0-9_-]{20,}|hf_(?=[A-Za-z0-9]{0,200}\d)[A-Za-z0-9]{24,}|y0_(?=[A-Za-z0-9_-]{0,200}\d)[A-Za-z0-9_-]{20,}|IGQ(?=[A-Za-z0-9_-]{0,200}\d)[A-Za-z0-9_-]{20,}|EAA(?=[A-Za-z0-9]{0,200}\d)[A-Za-z0-9]{30,}|GOCSPX-[A-Za-z0-9_-]{16,}|AIza[0-9A-Za-z_-]{30,}|ntn_(?=[A-Za-z0-9]{0,200}\d)[A-Za-z0-9]{20,}|secret_(?=[A-Za-z0-9]{0,200}\d)[A-Za-z0-9]{20,}|whsec_[A-Za-z0-9]{8,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})/u;
// Bearer and Basic need a digit or a sign: «Bearer authentication» is prose.
// The cookie name is bounded: «Cookie:» repeated over 64 KB made it quadratic.
const SHAPE_I = /\b(?:Bearer\s+(?=[A-Za-z0-9._~+/-]{0,300}[\d._~+/-])[A-Za-z0-9._~+/-]{8,}|Basic\s+(?=[A-Za-z0-9+/]{0,300}[\d+/=])[A-Za-z0-9+/]{8,}={0,2})|\b\d{6,12}:[A-Za-z0-9_-]{30,}|-----BEGIN\s+(?:(?:OPENSSH|RSA|EC|DSA|ENCRYPTED|PGP)\s+)?PRIVATE\s+KEY(?:\s+BLOCK)?-----|\bCookie[ \t]{0,3}:[ \t]{0,3}[^\s=;:]{1,64}=(?=[^\s;]{0,300}\d|[^\s;]{12})[^\s;]+/iu;
// A password on a command line: «sshpass -p …», «mysql -u root -p…», «curl -u user:…».
const CLI = /\bsshpass[ \t]+-p[ \t]*['"]?(?![$<*])[^\s'"]{3,}|\b(?:mysql|mysqldump|mariadb)\b[^\n]{0,100}?[ \t]-p(?![$<*\s])['"]?[^\s'"]{3,}|\bcurl\b[^\n]{0,200}?[ \t](?:-u|--user)[ \t]+['"]?[^\s:'"]+:(?![$<*])[^\s'"]{3,}/u;
// A password inside a link: a scheme, «://», a login, «:», the password, «@», the host.
const URL_USERINFO = /\b[a-z][a-z0-9+.-]{0,20}:\/\/[^\s/:@?#]{1,64}:([^\s/@?#]{1,128})@/giu;
const PLACEHOLDER = /^(?:\*+|x+|\.+|_+|<[^>]*>|\$\{?[A-Za-z_][A-Za-z0-9_]*\}?|%\w|\[[^\]]*\]|\{[^}]*\}|password|passwd|pass|pwd|secret|token|пароль)$/iu;

// --- Labels -------------------------------------------------------------------
// key:   names a key or token itself («token», «API key», «ключ API»);
// pw:    a password, a passphrase, a secret word;
// glued: also names ordinary things («top secret», «private key file», «cookie
//        banner», a bare «ключ»): a machine-made value, or after a connector a
//        key-like one that is not a name («ключ проекта: date-repair-2026»);
// pass:  «pass», «pwd», «пасс», «pw»: only a value with digits or signs;
// pin:   «PIN», «пин-код»: only 4–8 digits.
// A label glued to a name by «_» («max_tokens», «kaspi_password») is an
// identifier; identifiers have their own rule below.
const W = String.raw`[ \t]{1,3}`;
const LABEL = new RegExp(
  String.raw`(?<![\p{L}\p{N}_])(?:` +
    String.raw`(?<key>api[ _-]?keys?|wi-?fi[ _-]?key|(?:network${W})?security${W}key|(?:api|апи)[ -]?ключ|ключ(?:у|а|ом|е)?${W}(?:api|апи|доступа|авторизации)|(?:access|refresh|bot|bearer|auth|api)[ _-]?tokens?|tokens?|токен(?:ы|а|у|ом|е)?|(?:client|webhook|signing|app|api)[ _-]?secrets?|secret[ _-]?keys?|(?:merchant|signing|hmac|encryption|license|licence|master|terminal)[ _-]?keys?|секретный${W}ключ|секрет${W}вебхука)` +
    String.raw`|(?<pw>passwords?|passwd|passphrases?|passcode|парол(?:ь|я|ем|ю|и|ей|ям|ями|ях)|пасс?ворд(?:а|ом|у)?|(?:secret|code)[ _-]?words?|(?:кодов|секретн)(?:ое|ого|ым)${W}слов(?:о|а|ом)|basic[ _-]?auth)` +
    String.raw`|(?<glued>secrets?|секрет|private[ _-]?key|приватный${W}ключ|ssh[ _-]?key|ключ${W}ssh|authorization|cookies?|куки|ключ)` +
    String.raw`|(?<pass>pass|pwd|пасс|pw|psw|pswd|passw)|(?<pin>pin(?:[ _-]?(?:code|код))?|пин(?:-код)?)` +
    String.raw`)(?![\p{L}\p{N}_-])`,
  'giu',
);
const LABEL_ONE = new RegExp(LABEL.source, 'iu');
type Kind = 'key' | 'pw' | 'glued' | 'pass' | 'pin';
// A plural label counts: «Токены: 1532847», «Паролей сохранено: 1240».
const PLURAL = /(?:passwords|passphrases|tokens|keys|secrets|cookies|токены|токенов|токенам|токенами|токенах|пароли|паролей|паролям|паролями|паролях)$/iu;
// «логин/пароль», «логин и пароль», «username/password», «user/pass»: a pair follows.
const LOGIN_BEFORE = /(?:логин|login|username|user)[ \t]*(?:\/|-|–|[ \t](?:и|and|&)[ \t])[ \t]*$/iu;

// --- Words --------------------------------------------------------------------
// Never a value: function words, whereabouts, days, and the nouns of
// «password manager», «token budget».
const EN_NOT_VALUE = new Set(`a an the this that these those it its is are was were be been am and or but nor
not no none null nil n/a na tbd tba todo pending unknown unset empty blank in on at by via with without from for
of to into onto under over as per see ask check use using stored saved kept lives here there where elsewhere
everywhere somewhere today tonight tomorrow yesterday now later soon first last next asap again already still
yet also too only just please anymore either though instead lost works work fails fail exists missing expires
expiry valid invalid required needed optional ok okay fine good bad weak strong same different new old default
factory another something nothing other stronger weaker longer shorter random temporary correct wrong incorrect
ready set reset changed updated rotated manager managers policy policies field fields prompt hint hints length
rule rules strength protection recovery generator vault hash change login form page screen dialog header headers
budget usage count limit limits quota rotation lifetime file files name id entry owner holder leak fix my our
your his her their must should will would can could may might do does did has have had sms email mail phone
password passwd passphrase token secret key value login cookie cookies session 1password bitwarden keychain
keepass lastpass 2fa mfa otp true false yes monday tuesday wednesday thursday friday saturday sunday january
february march april may june july august september october november december jan feb mar apr jun jul aug sep
sept oct nov dec morning evening etc ie i.e e.g eg approx min max incl personal forgotten twice once anywhere well
together myself issue reuse audit complexity breach history requirements stuff problem update link button pass
username`.split(/\s+/u));
// How an English note starts: «see 1Password», «not needed», «same as Gmail».
const NOTE_START = new Set(`see ask check use using not no none n/a na tbd tba todo pending unknown same different also only
just please stored saved kept lives here there where in on at by via with without from for of to it its this that
the a an my our your his her their must should will would can could may might do does did has have had is are was
were be been am and or but nor yes true false ok okay owner`.split(/\s+/u));
// What a password «is» in an English note: a closed list, not a guess by the
// ending («Butterfly», «Pudding», «Starling» are values).
const EN_ADJECTIVE = new Set(`long short simple unique known enough complex secure safe expired good`.split(/\s+/u));
const EN_STATUS = new Set(`changed updated expired reset rotated saved stored shared required needed removed revoked
disabled enabled locked blocked leaked compromised encrypted hashed generated sent received issued provided confirmed
verified accepted rejected deleted lost forgotten unknown missing pending working broken attached included hidden
masked redacted protected unchanged outdated deprecated regenerated reissued renewed refreshed recovered restored
requested approved printed written noted recorded documented configured unset defined undefined assigned copied
pasted typed entered used reused unused shown displayed emailed texted dictated mentioned given applied installed
activated deactivated suspended cancelled canceled closed opened scheduled planned expected expiring rotating coming
waiting following matching existing remaining outstanding ongoing upcoming failing currently recently probably
apparently basically definitely technically actually really usually normally likely unlikely possibly maybe perhaps
simply finally initially originally previously temporarily permanently separately securely safely locally manually
automatically daily weekly monthly yearly quarterly rarely never always often sometimes mostly partly fully entirely
completely exactly directly immediately newly public private mandatory sensitive obsolete stale generic irrelevant
guessable reusable common insecure plaintext cleartext readable unreadable predictable memorable unsafe great
terrible easy hard difficult trivial obvious corporate official unofficial active inactive gone useless useful
necessary unnecessary available unavailable visible invisible identical similar standard plain underneath below
above inside outside nearby offline online handy single-use one-time anyway somewhere shared`.split(/\s+/u));
const RU_NOT_VALUE = new Set(`не нет ни нету как так у в во из для и а но или от к ко на с со по при без о об про за до
после через над под тот та то те же такой такая такое мой моя моё наш наша его её их свой своя есть был была было
были будет спросить узнать уточнить спроси уточни ещё еще уже пока только тоже также лишь здесь там тут где сейчас
теперь вчера сегодня завтра потом позже раньше см смотри ждём ждем новый новая новое старый старая прежний
прежняя верный неверный пусто пустой пароль токен ключ секрет логин да мин макс тел ген зам бух т.е т.к т.д напр
стр имя кличка подсказка код всё все он она оно они мы вы я ты кто что около примерно`.split(/\s+/u));
// What a Russian note says after «Пароль:»: statuses, participles, verbs,
// adverbs. A closed list: «Тюльпан», «Капитан», «Солнышко» are values.
const RU_STATUS = new Set(`сменён сменен сменена сменено сменены сменили сменил сменила смена сменить сменим
изменён изменен изменена изменено изменили изменил изменила обновлён обновлен обновлена обновлено обновили обновил
обновила поменян поменяна поменяли поменял поменяла установлен установлена установили установил задан задана задали
задал сброшен сброшена сбросили сбросил сбросила сброс потерян потеряна потеряли потерял потеряла утерян утеряна
утеряли забыт забыта забыли забыл забыла отключён отключен отключена отключили отключил включён включен включена
включили заблокирован заблокирована заблокировали заблокировал разблокирован разблокировали истёк истек истекла
истекли истекает истекают устарел устарела устарели просрочен просрочена выдан выдана выдали выдал получен получена
получили получил отправлен отправлена отправили отправил прислан прислана прислали прислал прислала сохранён
сохранен сохранена сохранили сохранил записан записана записали записал записала удалён удален удалена удалили
удалил отозван отозвана отозвали отозвал скомпрометирован скомпрометирована утёк утекла утекли утекло засвечен
засвечена засветился восстановлен восстановлена восстановили восстановил перевыпущен перевыпущена перевыпустили
перевыпустил сгенерирован сгенерирована создан создана создали создал найден найдена нашли нашёл известен известна
неизвестен неизвестна нужен нужна нужно нужны требуется отсутствует работает подходит действует действителен
действительна недействителен обязателен обязательна хранится хранятся лежит лежат висит приклеен приклеена написан
написана указан указана привязан привязана передан передана передали передал продиктован продиктовала продиктовал
продиктовали совпадает совпадают готов готова закрыт закрыта открыт открыта скрыт скрыта знает знают знаю помнит
помнят короток коротковат слабоват длинноват простоват длинен прост сложен слаб надёжен надежен вычищен вычищена вычистили убран убрана убрали
нормально удобно безопасно опасно надёжно надежно отдельно временно срочно обязательно точно понятно ясно известно
неизвестно сложно просто легко трудно давно недавно плохо хорошо отлично заново снова опять скоро вручную
автоматически ежедневно ежемесячно регулярно иногда всегда никогда часто редко одинаковый одинаковые запрошен
запросили запросил попросил попросила проверен проверено проверили проверил ок неверен неправильно`.split(/\s+/u));
// Russian verbs and long adjectives by their ending: «хранится», «проверить»,
// «временный», «заводской». Nouns are never guessed.
const RU_VERB = /(?:ться|тся|ся|сь|[аяеиуыо]ть|ти|чь)$/u;
const RU_ADJ = /(?:[ыио]й|[ая]я|[оеы]е|ие|ого|его|ому|ему|ым|им|ых|их|ую|юю)$/u;
// …and in lowercase a participle, a past verb or a predicative: «одобрен»,
// «деактивирован», «сменена», «забыли», «важно», «проще». «тюльпан»,
// «лимон», «капитан» are not guessed past this.
const RU_VERBAL = /(?:[её]н|ян|[оеё]ван|[еёя]н[аоы]|ан[аоы]|[аяеиыу]ли|[аяеиы]ла|но|[чшжщ]е)$/u;
// Words that only join a qualifier («Пароль по умолчанию для роутера: …»,
// «Password in Kaspi Business: …»).
const FUNCTION = new Set(`в во по с со у при из про за над под к ко на о об in on at by with from via about within
under over into to of for the a an умолчанию default header headers 2fa mfa otp`.split(/\s+/u));
// Words that open a clause and change nothing: «…, кстати, X», «…, btw X».
const DISCOURSE = new Set(`кстати итак и а но или ну вот так также тоже ещё еще and but or so btw also again then also
и/или`.split(/\s+/u));
// Words between a label and its value that change nothing («is still», «тоже»).
const FILLER = new Set(`still also too always will would shall must has have had been being тоже также такой такая
такое же всё все ещё еще по-прежнему now теперь`.split(/\s+/u));
// The label names a property, not the secret («Token TTL: 2592000», «API key
// ID: …», «Password owner: …»).
const PROPERTY = new Set(`ttl lifetime expiry expiration length size format type scope scopes budget usage quota limit
limits count policy policies manager managers strength complexity requirements rules rule history id ids comment
comments fingerprint fingerprints owner owners holder holders keeper срок длина длину лимит квота тип формат размер
политика сложность требования менеджер отпечаток комментарий владелец`.split(/\s+/u));
// A noun before «пароля/паролей/паролю» makes the label its attribute:
// «Менеджер паролей: NordPass», «Смена пароля: 10.11.2026».
const PROPERTY_BEFORE = new Set(`менеджер менеджера менеджере генератор генератора политика политики подсказка подсказки
подсказку требования требований требование срок срока сроки дата даты смена смены смене смену владелец владельца
хранитель хранителя хранилище хранилища хранение ротация ротации выдача сервер провайдер тип формат сложность
сложности длина длины истечение истечения напоминание история истории сброс сброса сбросе восстановление
восстановления ответственный ответственная ответственного утечка утечки база базе количество число сервис сервиса
счётчик счетчик лимит квота расход действия действие 2fa список списка перечень таблица таблицы файл файла шаблон
шаблона правила правило проверка проверки замена замены обновление обновления изменение изменения генерация
генерации ввод ввода поле поля окно окна форма формы страница страницы`.split(/\s+/u));
// Where a secret is kept: «Пароль: iCloud», «Пароль от Wi-Fi: холодильник».
const PLACE = new Set(`icloud google keychain bitwarden 1password lastpass dashlane keepass keepassxc authenticator passkey
passkeys sso totp vault notes apple сейф сейфе флешка флешке бумажка бумажке тетрадь тетради блокнот
блокноте менеджер менеджере бухгалтерия бухгалтерии биометрия отпечаток двухфакторка шеф шефа босс босса избранное
избранном заметки заметках связка смс sms роутер роутере роутера наклейка наклейке оборот обороте сторона стороне
холодильник холодильнике стикер стикере доска доске кухня кухне стена стене стойка стойке ресепшн ресепшене полка
полке ящик ящике конверт конверте листок листке карточка карточке fridge sticker kitchen wall drawer envelope
notebook desk keeper roboform proton телефон телефоне почта почте облако облаке диск диске компьютер компьютере ноутбук ноутбуке
документ документе файл файле письмо письме чат чате банк банка банке замок замка кошелёк кошелька`.split(/\s+/u));
// People and roles who hold a secret: «Пароль: бухгалтер», «Пароли:\n- Kaspi — кассир». The names of the
// people of one installation come from its instance profile (see OWN below).
const PEOPLE = new Set(`владелец владельца владельцу владельцем владелица owner owner's кассир кассира кассиру
бухгалтер бухгалтера бухгалтеру главбух главбуха главбуху админ админа админу администратор администратора
администратору директор директора директору бариста охранник охранника охраннику сисадмин сисадмина разработчик
разработчика курьер курьера продавец продавца управляющий управляющего секретарь секретаря айтишник айтишника it-отдел
ит-отдел начальник начальника хозяин хозяина хозяйка хозяйки cashier accountant barista director developer support`.split(/\s+/u));
// First names, Russian and Kazakh, with their case forms: «Пароль от Kaspi:
// Гульнара» names who holds it. Ordinary nouns («Роман», «Вера») are left out.
const NAMES = new Set<string>();
for (const name of `гульнара айгерим асель анель ерлан нурлан марат мадина динара айжан алия айдана жанна дана сауле
бауыржан ерик арман асхат данияр тимур руслан азамат ержан айбек ринат салтанат жанар камила аружан акмарал
гаухар мурат серик канат болат ербол айдар алибек санжар эльмира индира зарина карина аяна томирис алихан ильяс
сергей ольга мария анна елена наталья ирина светлана татьяна юлия екатерина анастасия виктория александр алексей
михаил николай иван владимир павел максим денис антон олег игорь виктор юрий константин галина людмила оксана
марина алина кристина дарья полина ксения вадим артур кирилл никита станислав василий пётр петр борис леонид
валентина тамара лариса нина инна яна`.split(/\s+/u)) {
  const stem = name.slice(0, -1);
  const forms = name.endsWith('а') ? [name, stem + (/[гкхжшчщ]$/u.test(stem) ? 'и' : 'ы'), stem + 'е', stem + 'у', stem + 'ой']
    : name.endsWith('я') ? [name, stem + 'и', stem + 'е', stem + 'ю', stem + 'ей']
    : name.endsWith('й') ? [name, stem + 'я', stem + 'ю', stem + 'ем']
    : name.endsWith('ь') ? [name, stem + 'и', stem + 'я', stem + 'ю', stem + 'ем']
    : [name, name + 'а', name + 'у', name + 'ом', name + 'е'];
  for (const form of forms) NAMES.add(form);
}
for (const name of `gulnara aigerim asel anel erlan nurlan marat madina dinara aizhan aliya zhanna saule arman askhat
daniyar timur ruslan azamat aibek rinat sergey sergei olga maria anna elena natalia natalya irina svetlana
tatiana yulia ekaterina anastasia alexander alexey alexei mikhail nikolai ivan vladimir pavel maxim denis anton oleg
igor viktor yuri`.split(/\s+/u)) NAMES.add(name);
// Accounts and services a note names instead of a value: «Пароль: Kaspi»,
// «пароль Ozon», «Пароль от аккаунта Skoobi».
const SERVICE = new Set(`kaspi каспи halyk халык халыка jusan homebank egov егов госуслуги gmail yandex яндекс яндекса icloud
google гугл гугла github gitlab bitbucket telegram телеграм телеграма телеграмм whatsapp вотсап ватсап вотсапа
instagram инстаграм инстаграма facebook vk вк tiktok youtube twitter linkedin notion figma canva slack zoom skype
discord binance aliexpress ozon озон озона wildberries вайлдберриз olx krisha kolesa hh headhunter avito авито bitrix
битрикс битрикса amocrm tilda wix wordpress shopify stripe paypal cloudpayments robokassa yookassa
tinkoff тинькофф sber сбер сбера сбербанк сбербанка outlook microsoft dropbox chatgpt openai anthropic claude codex
suno roblox steam netflix spotify vds vps ssh wifi wi-fi вайфай вайфая keenetic hikvision
mikrotik tp-link xiaomi samsung huawei lenovo asus macbook imac 2gis passbolt nordpass vaultwarden doppler infisical
keycloak auth0 authy enpass diceware nist`.split(/\s+/u));
const PREPOSITION = /^(?:for|of|from|to|on|от|для|к|ко|на)$/iu;
// The next word names an object, not a value: «от server3», «for Office_5G»,
// «коммит 3c5ff5d», «заказ ORD20261110», «договору 1234567», «ИИН: …».
const OBJECT_BEFORE = /^(?:for|of|from|to|on|at|in|by|with|about|от|для|к|ко|на|у|в|во|с|со|по|при|из|про|без|id|ид|номер|номеру|номера|№|ref|commit|коммит|коммите|коммитом|hash|хеш|version|версия|build|сборка|run|job|issue|ticket|invoice|заказ|order|договор|договору|договора|счёт|счет|счета|счету|иин|бин|инн|снилс|паспорт|iban|тел|телефон|phone|заявка|заявки)$/iu;
// …and these name a login: a word with letters after them is its name
// («пользователя user01», «аккаунт Gulnara2024», «клиент Ivan2024»), digits are not.
const NAME_BEFORE = /^(?:пользователя|пользователь|юзера|юзер|учётки|учетки|учётка|учетка|аккаунта|аккаунт|аккаунтов|аккаунте|логина|логин|логином|ник|клиент|клиента|сеть|сети|ssid|network|запись|записи|entry|папка|папке|folder|файл|file|лист|sheet|вкладка|tab|модель|model|login|user|username|account|accounts|client|customer|nickname)$/iu;
const AND = /^(?:and|и|а|but|но|or|или)$/iu;
function objectAfter(previous: string, word: string): boolean {
  if (word.includes('=')) return false; // «for Stripe=<value>»
  return OBJECT_BEFORE.test(previous) || (NAME_BEFORE.test(previous) && /\p{L}/u.test(word));
}
/** «Keenetic KN1011», «Hikvision DS2CD1043»: a model after a brand. */
function modelAfter(previous: string, word: string): boolean {
  return /^\p{Lu}\p{Ll}{2,}$/u.test(previous) && /^[A-Z][A-Z0-9-]{3,11}$/u.test(word) && /\d/u.test(word);
}
const ACCOUNT = String.raw`root|admin|administrator|guest|user|wifi|router|server|mail|email|ssh|vds|vps|mac|mini|panel|site|bot|gmail|yandex|icloud|vpn|kaspi|google|github|telegram|whatsapp|instagram|apple|outlook|bitrix|amocrm|suno|codex|roblox`;
// The words of one installation (instance profile, credentialDetector): the names of its people, more first
// names, its services, its accounts. Each is one plain word, checked by the profile loader. They are read on
// every call, never kept in a constant: in the agent runner the profile comes with the run, after this module
// is loaded.
const OWN = derivedFromInstanceProfile(profile => {
  const { peopleWords, nameWords, serviceWords, accountWords } = profile.credentialDetector;
  return {
    holders: new Set([...peopleWords, ...nameWords]),
    services: new Set(serviceWords),
    account: new RegExp(`^(?:${[ACCOUNT, ...accountWords].join('|')})$`, 'iu'),
  };
});
/** «Kaspi», «Ozon»: a service a note names (lower case). */
function serviceName(w: string): boolean {
  return SERVICE.has(w) || OWN().services.has(w);
}
/** «root», «admin», «wifi»: the name of an account. */
function accountName(word: string): boolean {
  return OWN().account.test(word);
}
// A bare «ключ» with a lowercase genitive names some key: «ключ проекта»,
// «ключ таблицы»; these say whose access it is.
const KEY_ACCESS = new Set(`доступа авторизации апи api бота вебхука подписи шифрования интеграции сервиса приложения
от для мерчанта магазина терминала кассы продавца эквайринга`.split(/\s+/u));
// A public key, its id or fingerprint: «Публичный ключ WireGuard: …=», «GPG-ключ бухгалтера: 3AA5…».
const PUBLIC_BEFORE = /(?:публичн|открыт|public|gpg|pgp|ssh|age|wireguard|отпечат|fingerprint)[\p{L}]*[\s-]*(?:\p{L}+[\s-]+)?$/iu;

const CONNECTOR_WORD = /^(?:is|was|are|were|be|equals|it['’]s|это|был|была|было|будет|быть|равен|равна|remains|remain|stays|stay|became|becomes|become|остался|осталась|осталось|остаётся|остается|стал|стала|стало|становится)$/iu;
const STATE_WORD = /^(?:changed|reset|updated|rotated|set|same|сменён|сменен|сменили|сменил[аи]?|поменяли|поменял[аи]?|изменён|изменен|изменили|обновлён|обновлен|обновили|установлен|установили|задан|задали|новый|новая|прежний|старый|тот|та)$/iu;
const NOW = /^(?:now|теперь)$/iu;
const TO = /^(?:to|into|на)$/iu;
// «Owner changed the password for X to …», «Кассир сменил пароль на …».
const VERB_BEFORE = /(?:^|[^\p{L}])(?:chang(?:e|ed|es|ing)|set|sets|reset|updated?|rotated?|сменил[аи]?|сменить|поменял[аи]?|поменять|изменил[аи]?|изменить|обновил[аи]?|обновить|установил[аи]?|установить|поставил[аи]?|поставить|задал[аи]?|задать)(?![\p{L}])/iu;
const NEGATION = /(?:^|[^\p{L}])(?:без|without|no)[ \t]+$/iu;
// «Authorization: Bearer abc123»: the scheme names the value after it.
const SCHEME = /^(?:bearer|basic|token|digest)$/iu;
// A word that points at the value in a later clause: «It is X», «Value: X»,
// «Он такой: X», «temp is X»; these verbs take it directly: «use X», «вводить X».
const POINTER = /^(?:it|value|значение|он|она|оно|такой|такая|вот|here|temp|temporary|replacement|new|новый|новая|новое|который|которая|которое|which)$/iu;
// Words that lead a later clause to its value: «…, we use X», «…, owner
// picked X», «…, владелец выбрал X»; «…, ask X», «…, звонил клиент X» do not.
const INTRO = /^(?:we|i|мы|я|owner|владелец|one|picked|chose|chosen|set|выбрал[аи]?|поставил[аи]?|ставим|поставили|used|using|ещё|еще|всё|все|is|это)$/iu;
// What a person does to a password: «Gulnara2024 забыла пароль».
const SUBJECT_VERB = /^(?:forgot|forgets|knows|lost|loses|asked|asks|wants|needs|changed|reset|shared|сбросил[аи]?|забыл[аи]?|потерял[аи]?|попросил[аи]?|просит|просил[аи]?|знает|хочет)$/iu;
// A leak names where the old value went: «Токен утёк — 24691c7».
const LEAK = /^(?:утёк|утек|утекла|утекли|утекло|утечка|leak|leaked|leaks|засвечен|засвечена|засветился)$/iu;
const POINT_VERB = /^(?:use|enter|type|вводить|вводим|ввести|вводите|используем|использовать|пользуемся|name|named|called|зовут|кличка|кличке|теперь|now)$/iu;
// A hex word on a line about git is a commit or a hash. A leak is not such a
// line: after «старый утёк» comes the new key.
const COMMIT_LINE = /коммит|commit|hash|хеш|хэш|sha\d|(?<!\p{L})git(?!\p{L})|истори|голов|ревизи|revision|ветк|branch/iu;
// A date is when, not the value, on a line about a change or a term.
const WHEN = /срок|дат[аеуыой]|смен|истек|истёк|истеч|действ|годен|годна|(?<!\p{L})до(?!\p{L})|until|valid|expir|chang|rotat|updat|reset|обнов|измен|сброс|напомин|последн|следующ|(?<!\p{L})(?:next|last|since)(?!\p{L})|создан|created|выдан|issued|поменя|replac|установ|когда|when|дедлайн|deadline/iu;

const LATIN = /^[A-Za-z]+(?:['’-][A-Za-z]+)*$/u;
const CYRILLIC = /^\p{Script=Cyrillic}+(?:-\p{Script=Cyrillic}+)*$/u;
const DATE = /^(?:\d{1,4}(?:[./-]\d{1,2}){1,2}(?:[./-]\d{2,4})?|\d{1,2}:\d{2}(?::\d{2})?|\d{1,4}[./-]\d{1,2}[./-]\d{1,4}T\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?Z?)$/u;
// A date that can be the password itself: «12.05.1987», «12.05.87», «1987-05-12».
const DATE_VALUE = /^(?:\d{1,2}[./-]\d{1,2}[./-](?:\d\d|(?:19|20)\d\d)|(?:19|20)\d\d-\d{1,2}-\d{1,2})$/u;
const YEAR = /^(?:19|20)\d\d$/u;
// Paths, links, addresses, handles, versions, file and key names, public
// keys, phones, bot names and fingerprints are references, not secrets.
const REFERENCE = /^(?:~?\.{0,2}\/|[a-z][a-z0-9+.-]*:\/\/|ssh-(?:ed25519|rsa|dss)$|ecdsa-sha2-|sk-ssh-|SHA256:|AAAA[A-Za-z0-9+/]{16}|id_(?:ed25519|rsa|ecdsa|dsa)(?![A-Za-z0-9])|@[A-Za-z0-9_]{3,}$|v?\d+(?:\.\d+){1,3}(?:[-+][\w.]+)?$|[\w.+-]+@(?:[\w-]+\.)+[\w-]+(?::\d+)?$|\+?[78]\d{10}$|\d{2,}(?:-\d+)+[A-Za-z]?$|@?[A-Za-z][A-Za-z0-9_]{2,30}(?:Bot|_bot)$|(?:[0-9a-f]{2}:){5,}[0-9a-f]{2}$)|\.(?:pub|env|json|md|txt|csv|xlsx?|docx?|pdf|png|jpe?g|html?|pem|key|ts|js|mjs|py|sh|plist|log|db|sqlite|sql|yaml|yml|toml|ini|cfg|conf|zip|gz|local)$/iu;
// Hosts end with a real top-level domain («kaspi.kz»); «kotik.murka»,
// «welcome.home» are values.
const HOST = /^(?:[a-z0-9-]+\.)+(?:com|net|org|ru|kz|io|ai|dev|app|me|info|biz|co|uk|de|us|su|by|ua|uz|kg|eu|tv|cc|gg|ly|sh|to|fm|cn|jp|kr|in|fr|it|es|nl|pl|tr|ae|cloud|site|online|tech|xyz|pro|store|shop|local|lan|internal|localhost|test|example|edu|gov|page|link|email|space|website|ws|ca|au|ch|se|no|fi|dk|cz|at|be|pt|il|br|id|sg|hk|tw|nz|am|ge|az|tj|lv|lt|ee|md|ro|bg|rs|life|work|world|news|blog|one|live|art|media|studio|digital|team|chat|bot|games|club|rf|рф|қаз)(?::\d+)?$/u;
// «deploy@mac», «worker@vds2», «admin@MacBook-Pro»: a login on a machine.
const USER_AT = /^[a-z][\w.-]*@([A-Za-z][\w.-]*)$/u;
// Product models: «KN-1011», «RT-AX88U».
const PRODUCT = /^[A-Z]{1,4}-[A-Z]{0,3}\d{2,5}[A-Z]?$/u;
// Machines and platforms: «server3», «worker1», «vds2», «node22».
const MACHINE = /^(?:mac-?mini|macmini|mini|mac|vds|vps|server|host|node|worker|rpi|pi|nas|python|php|java|ruby|ubuntu|debian|macos|ios|android|windows|win|iphone|ipad)\d{0,3}$/iu;
// Products with a number: «Bitrix24», «Office365», «Ubuntu2204».
const PRODUCT_NAME = /^(?:office|bitrix|битрикс|ubuntu|windows|win|iphone|ipad|galaxy|pixel|redmi|xiaomi|macos|ios|android|python|node|java|php|postgres|postgresql|mysql|redis|nginx|debian|centos|fedora|keenetic|excel|outlook|gpt|claude|codex|macmini|mini|vds|vps|server|worker|rpi|nas)\d+$/iu;
// «`SKOOBI_DASHBOARD_TOKEN`»: the name of an environment variable; «gpt-4o»,
// «claude-opus-4»: a model.
const ENV_NAME = /^[A-Z][A-Z0-9]*(?:_[A-Z][A-Z0-9]*)+$/u;
const MODEL = /^(?:gpt|o\d|claude|gemini|llama|deepseek|qwen|mistral|codex|sonnet|opus|haiku)(?:[-.][\w.-]*)?$/iu;
const PUBLIC_KEY = /^(?:ssh-(?:ed25519|rsa|dss)|ecdsa-sha2-\S+|sk-ssh-\S+|SHA256:\S+)$/u;
// Schemes and standards: «Wi-Fi password is WPA2», «Токен: OAuth2».
const PROTOCOL = /^(?:wpa[23]?|wep|oauth\d?|oidc|saml\d?|pkce|sha-?\d{1,3}|md5|totp|hotp|sso|2fa|mfa|otp|ntlm|hmac|rsa|ecdsa|ed25519|tls\d?|ssl|jwt|ldap|kerberos|webauthn|fido2?|u2f)$/iu;
// «case-sensitive», «2FA-protected», «single-use», «Gmail-style»: how a
// password works, not what it is.
const PROSE_SUFFIX = /^(?:case|2fa|mfa|sso|password|passcode|pin|ip|time|read|write)-(?:protected|only|based|enabled|disabled|sensitive|free|less|limited)$|^[\w]+-(?:protected|based|style|only|enabled|disabled|like|specific|compatible|generated|use|time|lived|factor|step|level)$/iu;
// «2592000 сек», «86400s», «1.5M»: a measure.
const UNIT = /^(?:сек|секунд[аы]?|мин|минут[аы]?|час|часа|часов|дн[яей]|день|недел[ьиям]+|месяц[аев]*|символ[аов]*|знак[аов]*|цифр[ы]?|токенов|запрос[аов]*|раз[а]?|пользовател[ьяеймх]+|chars?|characters?|symbols?|digits?|seconds?|secs?|minutes?|mins?|hours?|hrs?|days?|weeks?|months?|tokens|requests?|times|users?|%)$/iu;
const MEASURE = /^\d+(?:[.,]\d+)?(?:s|sec|ms|m|min|h|hr|d|k|kb|mb|gb|tb|x|%)$/iu;
// «read-only», «long-lived», «bot_token»: words joined, prose or a name.
const JOINED_WORDS = /^[A-Za-z]+(?:[-_.][A-Za-z]+)+$/u;
// A dictated number: «котик две тысячи двадцать четыре».
const NUMBER_WORD = /^(?:ноль|один|одна|два|две|три|четыре|пять|шесть|семь|восемь|девять|десять|одиннадцать|двенадцать|двадцать|тридцать|сорок|пятьдесят|шестьдесят|семьдесят|восемьдесят|девяносто|сто|двести|триста|тысяча|тысячи|тысяч|zero|one|two|three|four|five|six|seven|eight|nine|ten|twenty|thirty|hundred|thousand)$/iu;

function lower(word: string): string {
  return word.toLowerCase();
}
function stopWord(word: string): boolean {
  return EN_NOT_VALUE.has(lower(word)) || RU_NOT_VALUE.has(lower(word));
}
/** On a closed list of what a note says instead of a value. */
function listedNote(word: string): boolean {
  const w = lower(word);
  return EN_NOT_VALUE.has(w) || RU_NOT_VALUE.has(w) || EN_ADJECTIVE.has(w) || EN_STATUS.has(w) || RU_STATUS.has(w);
}
function notValueWord(word: string): boolean {
  if (listedNote(word)) return true;
  const w = lower(word);
  // «changed», «Gulnara's»; a capitalized word is not guessed.
  if (LATIN.test(word)) return (word === w && w.length > 5 && w.endsWith('ed')) || /['’]s$/u.test(w);
  return CYRILLIC.test(word) && w.length >= 4 && (RU_VERB.test(w) || RU_ADJ.test(w) || (word === w && RU_VERBAL.test(w)));
}
/** A person, a role, a place, a service, a scheme: what a note names instead of a value. */
function noteName(word: string): boolean {
  const w = lower(word);
  return PLACE.has(w) || PEOPLE.has(w) || NAMES.has(w) || OWN().holders.has(w) || serviceName(w) || word.split('/').every(part => PROTOCOL.test(part)) ||
    PROSE_SUFFIX.test(word);
}
/** «, and», «и»: the value ends the phrase («Password is Murka and PIN is 4821»). */
function endsValue(next: Tok | undefined): boolean {
  return clauseEnds(next) || (next!.k === 'w' && AND.test(next!.t));
}
/** The label's line, to tell a commit hash from a hex key; read only when a
 * hex word turns up. */
type Ctx = { s: string; at: number; floor: number; commit?: boolean; plural?: boolean; when?: boolean };
function commitLine(ctx: Ctx): boolean {
  const { s, at, floor } = ctx;
  return (ctx.commit ??= COMMIT_LINE.test(
    s.slice(lineStart(s, at, Math.max(floor, at - 200)), lineEnd(s, at, Math.min(s.length, at + 200)))));
}
/** A line about a change or a term: a date there says when. */
function whenNear(ctx: Ctx, upto: number): boolean {
  const { s, at, floor } = ctx;
  const from = Math.max(lineStart(s, at, Math.max(floor, at - 120)), at - 80);
  return (ctx.when ??= WHEN.test(s.slice(from, Math.min(Math.max(upto, at), from + 400))));
}
// «process.env.DB_PASSWORD», «settings.STRIPE_KEY»: code that names a variable.
const CODE_REF = /^[A-Za-z_$][\w$]*(?:\.[\w$]+)*\.[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/u;
function reference(word: string, ctx?: Ctx, kind?: Kind): boolean {
  const at = USER_AT.exec(word);
  // «kotik@murka» after a password label is the value; «worker@vds2» is a login.
  if (at && (kind !== 'pw' || MACHINE.test(at[1]) || /[-.\d\p{Lu}]/u.test(at[1]))) return true;
  return REFERENCE.test(word) || HOST.test(word) || MACHINE.test(word) || ENV_NAME.test(word) || MODEL.test(word) ||
    CODE_REF.test(word) || PRODUCT.test(word) ||
    Boolean(ctx && /^[0-9a-f]{7,64}$/u.test(word) && /\d/u.test(word) && commitLine(ctx));
}
/** «9 ноября», «12+ символов», «3 days», «2592000 сек»: a number that counts
 * something. After a state word a number of any length does
 * («сменили 1500 пользователям»). */
function counted(word: string, next: Tok | undefined, state = false): boolean {
  if (MEASURE.test(word)) return true;
  if (!/^[<>≥≤~≈]?\d+\+?$/u.test(word) || next?.k !== 'w') return false;
  if (UNIT.test(next.t)) return true;
  return (state || word.length <= 3) && /^\p{Ll}+$/u.test(next.t);
}
function letterDigitTurns(word: string): number {
  let turns = 0;
  let previous = 0;
  for (let i = 0; i < word.length; i++) {
    const c = word.charCodeAt(i) | 32;
    const kind = c >= 48 && c <= 57 ? 1 : c >= 97 && c <= 122 ? 2 : 0;
    if (kind && previous && kind !== previous) turns++;
    previous = kind;
  }
  return turns;
}
/** Machine-made: hex, a uuid, base58/base64, letters and digits mixed many
 * times. Names with words and numbers («id_ed25519_deploy_2026»,
 * «server3-deploy», «project-x-2026») are not. */
function opaque(word: string): boolean {
  if (word.length < 8 || reference(word) || DATE.test(word)) return false;
  if (!/^[A-Za-z0-9+/=_.~%-]+$/u.test(word) || !/\d/u.test(word) || !/[A-Za-z]/u.test(word)) return false;
  if (/^(?:0x)?[0-9a-f]{16,}$/iu.test(word)) return true;
  const turns = letterDigitTurns(word);
  const mixedCase = /[a-z]/u.test(word) && /[A-Z]/u.test(word);
  return turns >= 3 || (turns >= 2 && mixedCase) || (word.length >= 20 && mixedCase && !/[-_.]/u.test(word));
}
/** A dictated password without a connector: letters with digits, 4+ digits,
 * or letters with a sign («Zq8!mN3pL», «4829», «котик2024»). */
function passwordShaped(word: string, next: Tok | undefined): boolean {
  if (reference(word) || DATE.test(word) || notValueWord(word) || noteName(word)) return false;
  if (/^\d+$/u.test(word)) return word.length >= 4 && !(YEAR.test(word) && next?.k === 'w');
  const letters = /\p{L}/u.test(word);
  return (letters && /\d/u.test(word) && word.length >= 6) ||
    (letters && /[!#$%&*@^~+=?|\\]/u.test(word) && word.length >= 5);
}
/** «server3», «user01», «Bitrix24», «Office365»: a name with a small number
 * or a product. «admin123», «Murka123» are values. */
function nameWithNumber(word: string): boolean {
  return /^\p{L}{2,}\d{1,2}$/u.test(word) || PRODUCT_NAME.test(word);
}
/** «webhook-v2», «server3-deploy», «release9-wave2»: lowercase words and numbers joined. */
function nameSlug(word: string): boolean {
  return /^(?:\p{Ll}+\d*|\d+)(?:[-_.](?:\p{Ll}+\d*|\d+))+$/u.test(word);
}
/** A token or key after a connector: printable, with a digit or a sign, or
 * long, or random case («hunter2», «A9x7Q2mZ»). «pending», «TBD», «OpenAI»,
 * «read-only» are words; after «=» joined words are a value
 * («TOKEN=synthetic-placeholder»). */
function keyShaped(word: string, quoted: boolean, assignment: boolean): boolean {
  if (reference(word) || DATE.test(word) || notValueWord(word) || noteName(word) || !/^[\x21-\x7e]+$/u.test(word))
    return false;
  if (quoted && word.length >= 4) return true;
  if (JOINED_WORDS.test(word)) return assignment;
  if (/[^=]=[^=]/u.test(word)) return cookiePair(word); // «consent=declined» is a setting
  const core = word.replace(/=+$/u, ''); // base64 padding is not a sign
  if (core.length < 6 || stopWord(core)) return false;
  const humps = core.match(/[a-z][A-Z]/gu)?.length ?? 0;
  return /\d/u.test(core) || /[~+/!#$%&*@^_.-]/u.test(core) || core.length >= 16 || humps >= 3;
}
/** A quoted value: «password "Kotik"»; a quoted note («"in .env"», «"кассир
 * знает"») is not, and a quoted phrase needs a connector before it. */
function quotedValue(tok: Tok, connector = false): boolean {
  if (!tok.quoted || tok.t.length < 3 || reference(tok.t)) return false;
  const words = tok.t.split(/\s+/u);
  const first = words[0].replace(/[.,:;!?]+$/u, '');
  // «логин/пароль: "manager 482193"»: a login and its password.
  if (connector && words.slice(1).some(w => passwordShaped(w, undefined))) return true;
  if (notValueWord(first) || noteName(first)) return false;
  // After a connector a quoted phrase is the value («"root / toor"»); right
  // after the label it needs a digit («Пароль «Kaspi Магазин» у кассира»).
  return words.length === 1 || connector || /\d/u.test(tok.t);
}
/** «date-repair-2026», «VDS_ROOT_KEY»: words and numbers joined, a name. */
function slug(word: string): boolean {
  return /[-_.]/u.test(word) && word.split(/[-_.]+/u).every(part => /^(?:\p{L}*|\d*)$/u.test(part));
}
const COOKIE_PAIR = /^[A-Za-z][A-Za-z0-9_.-]{0,40}=[^\s;"']{8,}$/u;
function cookiePair(word: string): boolean {
  return COOKIE_PAIR.test(word) && /\d/u.test(word.slice(word.indexOf('=')));
}
/** A Russian word that is a dictated value, not a note word: «Мурка»,
 * «котик», «лимон». A lowercase word that may be a genitive («кабинета»), a
 * past verb («запросил») or a participle («привязан») is not. */
function russianValue(word: string): boolean {
  const w = lower(word);
  if (w.length < 3 || notValueWord(word) || noteName(word)) return false;
  if (/^\p{Lu}/u.test(word)) return true;
  // «котик», «лимон», «мурка», «рыбка»; not «кабинета», «запросил», «привязан».
  return (/[бгджзкпрсфхцчшщвнт]$/u.test(w) && !/[еёая]н$/u.test(w) && !UNIT.test(word)) || /[бвгджзлмнпрстфхцчшщ]ка$/u.test(w);
}
/** Several words in a value slot: «Kotik 2024», «correct horse battery
 * staple», «Kotik Murka», «синий кит», «8f3k 2j5h 9d7a», «K o t i k 2 0 2 4».
 * A note names a person, a place, a status or uses a function word. */
function phraseWords(words: string[]): boolean {
  if (words.length < 2) return false;
  // Spelled out or split into single letters and digits.
  if (words.filter(w => /^[\p{L}\p{N}]$/u.test(w)).length >= 4) return true;
  if (words.length > 6) return false;
  const first = words[0].replace(/[.,:;!?]+$/u, '');
  const lowercasePhrase = words.every(w => w === lower(w));
  // A note starts with a function word, a status, a person or a place;
  // «correct horse battery staple» starts with an ordinary adjective.
  const f = lower(first);
  if (words.length === 2 && lowercasePhrase && words.some(w => listedNote(w) || (LATIN.test(w) && w.length > 5 && w.endsWith('ed')) ||
    (CYRILLIC.test(w) && w.length >= 4 && (RU_VERB.test(w) || RU_VERBAL.test(w)))))
    return false;
  if ((lowercasePhrase ? NOTE_START.has(f) || RU_NOT_VALUE.has(f) || FUNCTION.has(f) || EN_STATUS.has(f) ||
    RU_STATUS.has(f) || (CYRILLIC.test(first) && RU_VERB.test(f)) || (LATIN.test(first) && f.length > 5 && f.endsWith('ed'))
    : notValueWord(first) && !(CYRILLIC.test(first) && RU_ADJ.test(f) && !listedNote(first))) ||
    noteName(first) || CONNECTOR_WORD.test(first) || OBJECT_BEFORE.test(first))
    return false;
  // «синий кит»: an adjective, then a noun that is not one too.
  if (CYRILLIC.test(first) && RU_ADJ.test(lower(first)) && (words.length > 3 || words.slice(1).some(w => notValueWord(w))))
    return false;
  if (words.slice(1).some(w => passwordShaped(w, undefined) && !nameWithNumber(w))) return true;
  if (groupedKey(words)) return true;
  const rest = lowercasePhrase ? words.slice(1) : words;
  if (rest.some(w => stopWord(w) || noteName(w) || FUNCTION.has(lower(w)) || UNIT.test(w) || accountName(w)) ||
    words.some(w => /[^\p{L}'’-]/u.test(w)))
    return false; // «восемь символов минимум» counts
  const capAll = words.every(w => /^\p{Lu}[\p{Ll}'’-]+$/u.test(w));
  return lowercasePhrase || (capAll && words.length <= 4);
}

// --- Lexer --------------------------------------------------------------------
type Tok = {
  t: string;
  /** w word, c connector (: = — – and a free-standing -), p clause end
   * (, . ; ! ? …), n line break, o bracket, s free-standing slash,
   * m markup (** | #). */
  k: 'w' | 'c' | 'p' | 'n' | 'o' | 's' | 'm';
  /** Where the token starts in the text. */
  p: number;
  quoted?: boolean;
  /** The first token of a line (list markers, headings). */
  bol?: boolean;
};
const QUOTES: Record<string, string> = { '"': '"', "'": "'", '«': '»', '“': '”', '„': '“', '`': '`' };
const BREAKS = '\n\r\u2028\u2029\v\f';
const WORD_END = ' \t"«»“”„,;()[]{}—–' + BREAKS;
const TRAILING = '.!?…:\'’*_~';

/** The tokens from `from` to `until`: at most `max` within 300 characters
 * (one word may run to 512), and at most two past `stop` (the next label),
 * which no word crosses. Every loop is bounded, so many labels stay linear. */
function lex(s: string, from: number, stop = Infinity, max = 20, until = s.length): Tok[] {
  const out: Tok[] = [];
  const end = Math.min(until, from + 300);
  let i = from;
  let bol = false;
  let past = 0;
  let unclosed = '';
  // «"password": "…"»: the quote that closes a quoted key.
  if ((s[i] === '"' || s[i] === "'") && /^.\s{0,3}[:=]/u.test(s.slice(i, i + 6))) i++;
  const push = (tok: Tok) => {
    if (bol) tok.bol = true;
    bol = false;
    out.push(tok);
  };
  while (i < end && out.length < max) {
    if (i >= stop && ++past > 2) break;
    const c = s[i];
    if (c === ' ' || c === '\t') {
      i++;
    } else if (BREAKS.includes(c)) {
      push({ t: '\n', k: 'n', p: i });
      i += c === '\r' && s[i + 1] === '\n' ? 2 : 1;
      bol = true;
    } else if (':=—–'.includes(c) || (c === '-' && WORD_END.includes(s[i + 1] ?? ' '))) {
      const p = i++;
      while (i < end && (s[i] === ':' || s[i] === '=' || s[i] === '>' || (c === '-' && s[i] === '-'))) i++;
      push({ t: c, k: 'c', p });
    } else if (',.;!?…'.includes(c)) {
      push({ t: c, k: 'p', p: i++ });
    } else if ('()[]{}'.includes(c)) {
      push({ t: c, k: 'o', p: i++ });
    } else if (c === '/' && WORD_END.includes(s[i + 1] ?? ' ')) {
      push({ t: c, k: 's', p: i++ });
    } else if (c in QUOTES) {
      // A quoted value on one line; a quote that never closes is skipped.
      const close = QUOTES[c];
      let j = i + 1;
      if (!unclosed.includes(c)) while (j < end && s[j] !== close && !BREAKS.includes(s[j])) j++;
      if (s[j] === close && j > i + 1) {
        push({ t: s.slice(i + 1, j).trim(), k: 'w', p: i, quoted: true });
        i = j + 1;
      } else {
        if (j >= end) unclosed += c;
        i++;
      }
    } else {
      // A word never runs into the next label or past the window's end.
      let j = i;
      const wordStop = i < stop ? Math.min(until, i + 512, stop) : Math.min(until, i + 64);
      while (j < wordStop && !WORD_END.includes(s[j])) j++;
      if (j === i) {
        i++; // a stray closing quote
        continue;
      }
      // Trailing «.», «!», «:» belong to the sentence, «**», «_» to markdown.
      let k = j;
      while (k > i && TRAILING.includes(s[k - 1])) k--;
      let word = s.slice(i, k);
      if ('*~_'.includes(word[0]) || '*~'.includes(word[word.length - 1]))
        word = word.replace(/^[*~_]+(?=[\p{L}\p{N}])|(?<=[\p{L}\p{N}])[*~]+$/gu, '');
      const tail = s.slice(k, j);
      const p = i;
      i = j;
      if (word) push({ t: word, k: /[\p{L}\p{N}]/u.test(word) ? 'w' : /^(?:->|=>|→)$/u.test(word) ? 'c' : 'm', p });
      if (tail && /[^*_~]/u.test(tail)) push({ t: tail, k: tail.includes(':') ? 'c' : 'p', p: k });
    }
  }
  return out;
}

function clauseEnds(tok: Tok | undefined): boolean {
  return !tok || tok.k === 'n' || tok.k === 'p' || tok.k === 'o';
}
/** A list item, heading or quote starts the next line: not a value line. */
function listMarker(toks: Tok[], i: number): boolean {
  const tok = toks[i];
  if (!tok || !tok.bol) return false;
  if (tok.k === 'c' || tok.k === 'm' || tok.k === 'n') return true;
  return tok.k === 'w' && /^\d{1,3}$/u.test(tok.t) && (toks[i + 1]?.k === 'p' || toks[i + 1]?.t === ')');
}
function lineStart(s: string, at: number, floor: number): number {
  let from = at;
  while (from > floor && !BREAKS.includes(s[from - 1])) from--;
  return from;
}
function lineEnd(s: string, at: number, limit: number): number {
  let to = at;
  while (to < limit && !BREAKS.includes(s[to])) to++;
  return to;
}

// --- Grammar ------------------------------------------------------------------
type Mode = 'connector' | 'state' | 'stateBare' | 'newline' | 'verb';

/** The word right after the label, with no connector. */
function valueRightAfterLabel(kind: Kind, tok: Tok, next: Tok | undefined, russian: boolean, ctx: Ctx): boolean {
  const word = tok.t;
  if (kind === 'key') {
    // Prod's spoken-key rule («api_key 8f3k2j5h9d», «токен бота <id>:…») and
    // a short value with letters and digits («token hunter2»), not a short
    // commit hash («token 724506e»).
    if (reference(word, ctx) || DATE.test(word) || JOINED_WORDS.test(word) || noteName(word)) return false;
    return (/^[A-Za-z0-9_./+~-]{8,}$/u.test(word) && (word.length >= 24 || /[\d_./+~-]/u.test(word))) ||
      (/^[\x21-\x7e]{6,}$/u.test(word) && /\d/u.test(word) && /[A-Za-z]/u.test(word) && !slug(word) &&
        !/^[0-9a-f]{6,7}$/u.test(word)) || opaque(word);
  }
  if (kind === 'glued') return opaque(word) || cookiePair(word);
  if (kind === 'pass') return passValue(word, next, false);
  if (kind === 'pin') return /^\d{4,8}$/u.test(word) && !YEAR.test(word) && clauseEnds(next);
  if (passwordShaped(word, next) || quotedValue(tok)) return true;
  if (noteName(word) || PROPERTY.has(lower(word)) || reference(word, ctx) || (russian && accountName(word))) return false;
  // «Kaspi password Kotik», «пароль Мурка», «пароль котик», «password admin.»:
  // one word ends the phrase. «password policy», «Admin password lost.»,
  // «пароль приложения», «пароль Kaspi» are notes.
  if (endsValue(next) && word.length >= 3 && !notValueWord(word)) {
    if (LATIN.test(word)) return true;
    if (CYRILLIC.test(word)) return russianValue(word);
  }
  // «пароль qwerty никому не говори»: a lowercase Latin word is dictated.
  return russian && /^[a-z]{5,}$/u.test(word) && !notValueWord(word) && !serviceName(word);
}

/** «pass»/«pwd»/«пасс»: a value with digits or signs, not a path, a name or
 * a flight («pwd: build7-work/part2», «Second pass: build7-w2», «Boarding pass:
 * SU1234»); digits alone only after a connector («pwd: 1234»). */
function passValue(word: string, next: Tok | undefined, digits: boolean): boolean {
  if (!passwordShaped(word, next) || (!digits && /^\d+$/u.test(word))) return false;
  return !word.includes('/') && !nameSlug(word) && !/^[A-Z]{2}\d{3,4}$/u.test(word);
}

/** A word after the qualifiers, still with no connector («пароль от почты
 * Xyz123», «пароль от вайфая Котик», «Пароль от роутера admin»). */
function valueAfterQualifiers(kind: Kind, tok: Tok, next: Tok | undefined, ctx: Ctx, previous: string, russian: boolean): boolean {
  const word = tok.t;
  if (reference(word, ctx) || modelAfter(previous, word) || (ctx.plural && /^\d+$/u.test(word))) return false;
  if (kind === 'pw') {
    if ((passwordShaped(word, next) && !PRODUCT_NAME.test(word)) || (Boolean(tok.quoted) && quotedValue(tok))) return true;
    // A Russian phrase ends with the dictated word: a Cyrillic word or a
    // lowercase Latin one; a capitalized Latin word there names a brand.
    if (!russian || !endsValue(next)) return false;
    if (CYRILLIC.test(word)) return russianValue(word);
    return /^[a-z]{3,}$/u.test(word) && !notValueWord(word) && !noteName(word) && !/^(?:root|user|guest)$/u.test(word);
  }
  if (kind === 'pass') return passValue(word, next, false);
  if (kind === 'pin') return /^\d{4,8}$/u.test(word) && !YEAR.test(word) && clauseEnds(next);
  return opaque(word) || cookiePair(word);
}

function valueAfter(mode: Mode, kind: Kind, tok: Tok, next: Tok | undefined, assignment: boolean, ctx: Ctx,
  sawState = false): boolean {
  const word = tok.t;
  // «Токены: 1532847», «Паролей сохранено: 1240»: a count.
  if (ctx.plural && /^\d+$/u.test(word)) return false;
  // After «Пароль:» a word with «@» in front and a digit is a value; «токен: @BotFather» a handle.
  const handleValue = kind === 'pw' && mode === 'connector' && /^@[\w.]*\d/u.test(word);
  if (DATE.test(word)) {
    // «Пароль от сейфа: 12.05.87»; «Смена пароля: 10.11.2026», «пароль
    // обновлён: 10.11.2026» say when.
    return kind === 'pw' && (mode === 'connector' || mode === 'newline') && !sawState && DATE_VALUE.test(word) &&
      endsValue(next) && !whenNear(ctx, tok.p);
  }
  if (!handleValue && (notValueWord(word) || reference(word, ctx, kind) || noteName(word))) return false;
  if (counted(word, next, mode !== 'connector' && mode !== 'newline')) return false;
  // «Токен Stripe: "8f3k 2j5h 9d7a"», «Пароль: "Kotik 2024"».
  if (tok.quoted && /\s/u.test(word)) return kind === 'pw' ? quotedValue(tok, true) : groupedKey(word.split(/\s+/u));
  if (kind === 'pin') return /^\d{4,8}$/u.test(word) && !(mode !== 'connector' && YEAR.test(word));
  if (kind === 'pass') return passValue(word, next, true);
  if (kind !== 'pw') {
    if (mode === 'newline' || mode === 'stateBare' || mode === 'verb') return opaque(word) || cookiePair(word);
    const keyLike = keyShaped(word, Boolean(tok.quoted), assignment);
    return opaque(word) || cookiePair(word) || (keyLike && (kind === 'key' || (!slug(word) && !nameSlug(word))));
  }
  if (mode === 'verb') {
    // «сменил пароль на VDS / на Kaspi / на server3» names where; a value
    // has digits or signs, quotes, or is a lowercase dictated word.
    return passwordShaped(word, next) || quotedValue(tok) ||
      (/^[a-z]{4,}$/u.test(word) && !accountName(word) && clauseEnds(next));
  }
  if (mode === 'stateBare') return passwordShaped(word, next) && !YEAR.test(word);
  if (passwordShaped(word, next) || quotedValue(tok, mode === 'connector')) return true;
  // A plain word is a value when it ends the phrase: «Пароль: Тюльпан»,
  // «password is Kotik, do not share it», «changed to Kotik.», «Password is
  // Murka and PIN is 4821»; «Пароль: кассир знает», «на прошлой неделе» are notes.
  if (word.length < 3 || !endsValue(next)) return false;
  if (LATIN.test(word)) return true;
  // After «сменили на» a lowercase locative names where: «на сайте», «на почте».
  if (CYRILLIC.test(word)) return mode !== 'state' || /^\p{Lu}/u.test(word) || !/[еи]$/u.test(lower(word));
  if (/^\p{L}+(?:-\p{L}+)+$/u.test(word)) return false; // «SMS-код», «IT-отдел», «QR-код»
  return (mode === 'connector' || mode === 'newline') && /[\p{N}\p{S}\p{P}]/u.test(word);
}

/** «8f3k 2j5h 9d7a 6s5d», «abcd efgh ijkl mnop»: a key written in groups. */
function groupedKey(words: string[]): boolean {
  return words.length >= 3 && words.length <= 8 && words.every(w => /^[A-Za-z0-9]{3,6}$/u.test(w)) &&
    (opaque(words.join('')) || words.every(w => /^[a-z]{4}$/u.test(w)));
}
/** Several words after a connector: «Kotik 2024», «Kotik Murka», «котик
 * любит рыбу», «8f3k 2j5h 9d7a 6s5d». */
function phraseValue(kind: Kind, toks: Tok[], i: number): boolean {
  if (kind !== 'pw' && kind !== 'key' && kind !== 'glued') return false;
  const words: string[] = [];
  for (let j = i; j < toks.length && words.length < 12; j++) {
    const tok = toks[j];
    if (tok.k === 'w' && !tok.quoted) words.push(tok.t);
    else if (tok.k !== 'm') break;
  }
  if (words.length < 2) return false;
  return kind === 'pw' ? phraseWords(words) : groupedKey(words);
}
/** «котик две тысячи двадцать четыре»: a word and a dictated number. */
function spokenNumber(toks: Tok[], i: number): boolean {
  let numbers = 0;
  for (let j = i; j < toks.length && j < i + 8; j++) {
    const tok = toks[j];
    if (tok.k !== 'w') break;
    if (NUMBER_WORD.test(tok.t)) numbers++;
    else if (numbers > 0) return false;
  }
  return numbers >= 2;
}

/** «admin / Kotik2024», «root / toor», «admin:Kotik2024»; after
 * «логин/пароль» also «manager 482193», and after a connector «shop Kotik». */
function loginPair(toks: Tok[], i: number, login: boolean, plain = false): boolean {
  const a = toks[i], b = toks[i + 1], c = toks[i + 2];
  if (a?.k !== 'w' || RU_NOT_VALUE.has(lower(a.t))) return false;
  if (b?.k === 's' && c?.k === 'w' && !stopWord(c.t) && !notValueWord(a.t) && !noteName(c.t)) return true;
  if (!login) return false;
  if (/^[^:\s]+:[^:\s]{3,}$/u.test(a.t) && !DATE.test(a.t)) return true;
  if (b?.k !== 'w') return false;
  if (passwordShaped(b.t, c)) return true;
  return plain && endsValue(c) && b.t.length >= 3 && !notValueWord(b.t) && !noteName(b.t) && !notValueWord(a.t) &&
    !noteName(a.t) && !reference(b.t);
}

type Site = { s: string; start: number; end: number; floor: number; stop: number; ctx: Ctx };

/** «Kotik2024 — пароль от Wi-Fi», «hunter2 is the VDS root password.»: a value,
 * a connector, at most three words, the label and its qualifiers end the phrase. */
function valueBeforeLabel(kind: Kind, after: Tok[], before: Tok[]): boolean {
  if (kind !== 'pw' && kind !== 'key' && kind !== 'pin') return false;
  let j = 0;
  const qualifier = (word: string) =>
    PREPOSITION.test(word) || !(notValueWord(word) || CONNECTOR_WORD.test(word) || STATE_WORD.test(word));
  while (j < 5 && after[j]?.k === 'w' && qualifier(after[j].t)) j++;
  if (!clauseEnds(after[j])) return false;
  let k = before.length - 1;
  for (let words = 0; k >= 0 && before[k].k === 'w' && !CONNECTOR_WORD.test(before[k].t) && words < 3; words++) k--;
  const connector = before[k];
  if (!connector) return false;
  const joins = connector.k === 'c' ? connector.t !== ':' : connector.k === 'w' && CONNECTOR_WORD.test(connector.t);
  if (!joins) return false;
  k--;
  if (connector.k === 'w' && before[k]?.k === 'c') k--; // «— это»
  const value = before[k];
  if (value?.k !== 'w' || (before[k - 1] && !clauseEnds(before[k - 1]) && before[k - 1].k !== 'c')) return false;
  if (kind === 'pin') return /^\d{4,8}$/u.test(value.t);
  if (kind === 'pw') return (passwordShaped(value.t, undefined) && !MACHINE.test(value.t)) || quotedValue(value);
  return opaque(value.t) || (keyShaped(value.t, Boolean(value.quoted), false) && /\d/u.test(value.t));
}

/** A strongly value-shaped word anywhere near a label: letters with digits,
 * many letter-digit turns, a sign, a machine-made key, a long hex key. Not a
 * name with a small number («server3», «Bitrix24»), a short hash, a uuid or a
 * reference. */
function strong(kind: Kind, tok: Tok, next: Tok | undefined, ctx: Ctx, state: boolean): boolean {
  const word = tok.t;
  // Files, times, settings, addresses and quoted phrases: «a.pdf», «1С:Бухгалтерия», «id=…».
  if (/[\s.:@=]/u.test(word) || reference(word, ctx) || noteName(word) || counted(word, next, state)) return false;
  // Hashes and ids: hex shorter than a key, a uuid, hex groups joined by «-».
  if (/^[0-9a-f]+$/iu.test(word) && /[a-f]/iu.test(word)) return word.length >= 32 && word.length !== 40 && /\d/u.test(word);
  if (/^[0-9a-f]+(?:-[0-9a-f]+){2,}$/iu.test(word)) return false;
  if (kind === 'pw') {
    if (/^\d+$/u.test(word)) return word.length >= 6 && !ctx.plural;
    // Latin with digits («Kotik2024», «admin123»), or a Russian word with a
    // number («котик123»).
    return (/^[\x21-\x7e]+$/u.test(word) || /^\p{L}{3,}\d{3,}$/u.test(word)) && passwordShaped(word, next) &&
      /\d/u.test(word) && (state || !nameWithNumber(word)) && !nameSlug(word);
  }
  // A path is made of words: «build7-work/part2», «Users/Desktop/Kaspi2»; a
  // base64 key mixes case inside its parts.
  if (word.includes('/') && word.split('/').every(part => /^(?:[a-z0-9_-]*|\p{Lu}?[\p{Ll}\d_-]+|[\p{Lu}\d_-]+)$/u.test(part)))
    return false;
  return opaque(word) && !nameSlug(word);
}

/** The sweep: a strong word on the label's line, not right after a
 * preposition or a name noun. In the label's own clause any such word
 * counts; in a later clause one of its first three words does, or one a
 * connector, a state word or a pointer introduces («…, still X», «…; new one
 * is X», «вводить X»), not one deep in it («…, звонил клиент Ivan2024»). With
 * `plain`, a password label also takes a plain word that a pointer and a
 * connector introduce and that ends its clause («It is Murka.», «Value:
 * Murka», «— from owner 10.11 — Murka»). */
function sweep(kind: Kind, toks: Tok[], from: number, ctx: Ctx, stateBefore: boolean, plain = true): boolean {
  let object = false;
  let state = stateBefore;
  let introduced = true;
  let opening = true;
  let labelClause = true;
  let connectors = 0;
  let pointer = false;
  let join = false;
  let chained = false;
  let previous = '';
  for (let i = from; i < toks.length; i++) {
    const tok = toks[i];
    if (tok.k === 'n') return false;
    if (tok.k !== 'w') {
      if (tok.k === 'p' || tok.k === 'o') {
        introduced = join = pointer = false;
        opening = true;
        if (tok.k === 'p') labelClause = false;
      }
      if (tok.k === 'c') {
        introduced = true;
        // The grammar read the first connector of the label's clause.
        join = plain && (pointer || (labelClause && ++connectors > 1));
      }
      // «ИИН: 900101300123», «тел.: …»: the number after an id word.
      if (tok.k !== 'm' && !(tok.k === 'c' && OBJECT_BEFORE.test(previous))) object = false;
      continue;
    }
    const word = tok.t;
    const next = toks[i + 1];
    if (chained && AND.test(word)) continue;
    const isObject: boolean = (object && (chained || objectAfter(previous, word))) || modelAfter(previous, word);
    chained = isObject && AND.test(next?.t ?? '');
    if (!isObject && (introduced || opening) && strong(kind, tok, next, ctx, state)) return true;
    // Only a capitalized or quoted word: «It is Murka.»; «it is annoying» is prose.
    if (join && !isObject && kind === 'pw' && (/^\p{Lu}/u.test(word) || tok.quoted) &&
      valueAfter('connector', kind, tok, next, false, ctx)) return true;
    if (STATE_WORD.test(word) || NOW.test(word) || /^(?:new|новый|новая|новое)$/iu.test(word)) state = introduced = true;
    if (CONNECTOR_WORD.test(word)) {
      introduced = true;
      join = plain && (pointer || (labelClause && ++connectors > 1));
    } else if (!(join && FILLER.has(lower(word)))) {
      join = plain && POINT_VERB.test(word) && !(labelClause && NOW.test(word));
    }
    if (POINTER.test(word)) pointer = true;
    if (!INTRO.test(word) && !DISCOURSE.has(lower(word)) && !FILLER.has(lower(word)) && !POINTER.test(word) && !POINT_VERB.test(word))
      opening = false;
    object = ((OBJECT_BEFORE.test(word) || NAME_BEFORE.test(word)) && !(TO.test(word) && state)) || chained;
    previous = word;
  }
  return false;
}

/** A value slot (a table cell, a field value, an item «Kaspi: …»): read like
 * the words after a connector. */
function slotValue(kind: Kind, toks: Tok[], i: number, ctx: Ctx, login = false): boolean {
  while (i < toks.length && toks[i].k === 'm') i++;
  let tok = toks[i];
  let next: Tok | undefined = toks[i + 1];
  if (tok?.k === 'o' && '([{'.includes(tok.t) && toks[i + 1]?.k === 'w' && toks[i + 2]?.k === 'o') {
    tok = toks[++i];
    next = undefined;
  }
  if (tok?.k !== 'w') return false;
  if (kind === 'pw' && loginPair(toks, i, login, login)) return true;
  return valueAfter('connector', kind, tok, next, false, ctx) || phraseValue(kind, toks, i) || sweep(kind, toks, i, ctx, false);
}

/** The tokens of a line after its list marker or heading. */
function lineBody(toks: Tok[]): number {
  let i = 0;
  while (i < toks.length && (toks[i].k === 'c' || toks[i].k === 'm' || (toks[i].k === 'w' && /^\d{1,3}$/u.test(toks[i].t) && toks[i + 1]?.k === 'p'))) {
    i += toks[i].k === 'w' ? 2 : 1;
  }
  return i;
}
/** One word alone on a line under a label line: «### Kaspi password\n- Kotik»,
 * «Пароль от Kaspi\nMurka». A password label takes a plain word when the label
 * line names nothing else (`plain`); other labels need a machine-made key. */
function aloneOnLine(kind: Kind, toks: Tok[], i: number, ctx: Ctx, plain: boolean): boolean {
  const words = toks.slice(i).filter(t => t.k !== 'm' && !(t.k === 'p' && t === toks[toks.length - 1]));
  if (words.length !== 1 || words[0].k !== 'w') return false;
  const tok = words[0];
  if (strong(kind, tok, undefined, ctx, false)) return true;
  // A line starts with a capital: «Отключён», «Согласован» are statuses there.
  if (kind !== 'pw' || !plain || accountName(tok.t) || (CYRILLIC.test(tok.t) && RU_VERBAL.test(lower(tok.t)))) return false;
  return valueAfter('newline', kind, tok, undefined, false, ctx) || (CYRILLIC.test(tok.t) && russianValue(tok.t));
}
// An item that holds the value under its label: «- value: …», «- значение: …».
const VALUE_ITEM = /^(?:value|val|значение|сам|it)$/iu;

/** «Пароль от Kaspi:\n- Kotik2024», «Passwords:\n- Kaspi: Kotik2024», «…: см.
 * ниже\nKotik2024»: lines under a label line that ends with «:» or points
 * below. An item «Name: value» is a slot; other lines need a strong word, or
 * for one password one word alone on the first line. */
function linesBelow(site: Site, kind: Kind, from: number, list: boolean, single: boolean): boolean {
  const { s, ctx } = site;
  let at = from;
  let blank = 0;
  let first = true;
  for (let n = 0; n < (list ? 6 : 1) + blank && at < s.length && n < 10; n++) {
    const begin = at;
    const end = lineEnd(s, begin, Math.min(s.length, begin + 400));
    at = end + (s[end] === '\r' && s[end + 1] === '\n' ? 2 : 1);
    const line = s.slice(begin, end);
    if (!line.trim() || /^\s*```/u.test(line)) {
      if (++blank > 2) return false;
      continue;
    }
    const toks = lex(s, begin, Infinity, 20, end);
    const i = lineBody(toks);
    // «- Kaspi: Kotik2024»: a name, «:», the value.
    let c = i;
    while (c < i + 4 && toks[c]?.k === 'w' && !toks[c].quoted) c++;
    if (c > i && toks[c]?.k === 'c' && toks[c].t !== '-' && slotValue(kind, toks, c + 1, ctx)) return true;
    if (sweep(kind, toks, i, ctx, false, false)) return true;
    if (kind === 'pw' && loginPair(toks, i, false)) return true;
    if (first && aloneOnLine(kind, toks, i, ctx, single)) return true;
    first = false;
    if (!list) return false;
  }
  return false;
}
/** The first line under a label line that has no value: one word alone on it
 * («### Kaspi password\n- Kotik», «- token issued 10.11\n- Zq8m…»), or an item
 * «- value: …» («- пароль прислал владелец\n- значение: Мурка»). */
function nextLine(site: Site, kind: Kind, from: number, plain: boolean): boolean {
  const { s, ctx } = site;
  let at = from;
  for (let n = 0; n < 3 && at < s.length; n++) {
    const begin = at;
    const end = lineEnd(s, begin, Math.min(s.length, begin + 400));
    at = end + (s[end] === '\r' && s[end + 1] === '\n' ? 2 : 1);
    if (!s.slice(begin, end).trim() || /^\s*```/u.test(s.slice(begin, end))) continue;
    const toks = lex(s, begin, Infinity, 12, end);
    const i = lineBody(toks);
    if (toks[i]?.k === 'w' && VALUE_ITEM.test(toks[i].t) && toks[i + 1]?.k === 'c' && slotValue(kind, toks, i + 2, ctx)) return true;
    return aloneOnLine(kind, toks, i, ctx, plain);
  }
  return false;
}

/** «Менеджер паролей: NordPass», «Смена пароля: 10.11.2026», «Подсказка к
 * паролю: …»: a noun before an oblique «пароля/паролей/паролю» owns the label. */
function propertyBefore(s: string, start: number, lineFrom: number, label: string): boolean {
  if (!/^парол(?:я|ей|ю|ям|ями|ях)$/iu.test(label)) return false;
  const words = lex(s, Math.max(lineFrom, start - 40), Infinity, 8, start).filter(t => t.k === 'w');
  let k = words.length - 1;
  if (k > 0 && /^(?:к|о|об|для|от|за|при|по|на)$/iu.test(words[k].t)) k--;
  return k >= 0 && PROPERTY_BEFORE.has(lower(words[k].t));
}

function labelHasValue(site: Site, label: string, kind: Kind, toks: Tok[]): boolean | 'note' | 'prop' {
  const { s, start, ctx } = site;
  const russian = /\p{Script=Cyrillic}/u.test(label);
  const bare = lower(label) === 'ключ';
  const lineFrom = lineStart(s, start, site.floor);
  const login = (kind === 'pw' || kind === 'pass') &&
    (LOGIN_BEFORE.test(s.slice(Math.max(site.floor, start - 12), start)) || /^basic/iu.test(label));
  if (propertyBefore(s, start, lineFrom, label)) return 'prop';
  // «Публичный ключ WireGuard: …», «GPG-ключ бухгалтера: …»: a public key.
  if (bare && PUBLIC_BEFORE.test(s.slice(Math.max(lineFrom, start - 30), start))) return 'note';
  let verb: boolean | undefined;
  const verbBefore = () =>
    (verb ??= VERB_BEFORE.test(s.slice(Math.max(lineFrom, start - 60), start)));
  // Where the clause joins the label to something: the first «:», «=», «—»
  // or joining word («is», «это», «теперь», «changed to»), brackets skipped.
  let join = -1;
  for (let j = 0; j < toks.length; j++) {
    const tok = toks[j];
    if (tok.k === 'o' && (tok.t === '(' || tok.t === '[')) {
      const close = tok.t === '(' ? ')' : ']';
      while (j < toks.length && toks[j].t !== close) j++;
      continue;
    }
    if (tok.k === 'c' && !tok.bol) {
      join = j;
      break;
    }
    if (tok.k === 'w' && (CONNECTOR_WORD.test(tok.t) || NOW.test(tok.t) || (STATE_WORD.test(tok.t) && TO.test(toks[j + 1]?.t ?? '')))) {
      join = j;
      break;
    }
    if (tok.k === 'n' || tok.k === 'p') break;
  }
  // 1. Qualifiers on the label line: «от почты кассира», «for the VDS root»,
  // «issued by BotFather», «(sandbox)».
  let i = 0;
  let words = 0;
  let prepositionObject = 0;
  let objectNext = false;
  let status = false;
  let leak = false;
  let chain = false;
  let chainNext = false;
  let firstPreposition = true;
  for (; i < toks.length; i++) {
    const tok = toks[i];
    if (tok.k === 'm') continue;
    if (tok.k === 'o' && (tok.t === '(' || tok.t === '[')) {
      // «access token (Instagram): …», «пароль [Kaspi]: …», «password (Kotik2024) is saved»
      const close = tok.t === '(' ? ')' : ']';
      let j = i + 1;
      while (j < toks.length && j <= i + 9 && toks[j].t !== close) j++;
      if (toks[j]?.t !== close) return false;
      for (let k = i + 1; k < j; k++) {
        const inner = toks[k];
        if (inner.k !== 'w') continue;
        if (k === i + 1 && PROPERTY.has(lower(inner.t))) return 'note'; // «Token (TTL): …»
        if (j === i + 2 && (kind === 'pw' ? passwordShaped(inner.t, undefined) && !nameWithNumber(inner.t) :
          kind === 'pin' ? /^\d{4,8}$/u.test(inner.t) : opaque(inner.t)))
          return true;
      }
      if (++words > 8) return false;
      i = j;
      objectNext = false;
      continue;
    }
    if (tok.k !== 'w') break;
    const word = tok.t;
    const w = lower(word);
    const next = toks[i + 1];
    if (PUBLIC_KEY.test(word)) return 'note';
    if (CONNECTOR_WORD.test(word) || STATE_WORD.test(word) || NOW.test(word) || (TO.test(word) && verbBefore())) break;
    if (login && loginPair(toks, i, true, /^[a-z][\w.@+-]*$/u.test(word) && !serviceName(w))) return true;
    const previous = toks[i - 1]?.t ?? '';
    // «от аккаунтов ivan1990 и gulnara2024»: «и» joins another object.
    if (chain && AND.test(word)) {
      objectNext = true;
      chain = false;
      continue;
    }
    const object: boolean = objectNext && (chainNext || objectAfter(previous, word) || (FUNCTION.has(lower(previous)) && !word.includes('=')));
    objectNext = false;
    chainNext = chain = object && AND.test(next?.t ?? '');
    if (!object) {
      const value = words === 0 ? valueRightAfterLabel(kind, tok, next, russian, ctx)
        : valueAfterQualifiers(kind, tok, next, ctx, previous, russian);
      if (value) return true;
      if (kind === 'pw' && spokenNumber(toks, i + 1) && !notValueWord(word)) return true;
    }
    if (++words > (join > i ? 10 : 7)) return false;
    if (words === 1) firstPreposition = PREPOSITION.test(word) || FUNCTION.has(w);
    if (FILLER.has(w)) continue;
    // «Token TTL: 2592000», «password manager»; «Kaspi password type Kotik2024».
    if (PROPERTY.has(w) && words === 1)
      return next?.k === 'w' && kind === 'pw' && !CONNECTOR_WORD.test(next.t) && strong(kind, next, toks[i + 2], ctx, false) ? true : 'note';
    if (PREPOSITION.test(word)) {
      prepositionObject = 3;
      objectNext = true;
      continue;
    }
    if (OBJECT_BEFORE.test(word) || NAME_BEFORE.test(word)) objectNext = true;
    if ((prepositionObject > 0 && /^(?:the|a|an)$/iu.test(word)) || /^values?$/iu.test(word)) continue;
    // «ключ проекта», «ключ таблицы»: some other key.
    if (bare && words === 1 && CYRILLIC.test(word) && word === w && !KEY_ACCESS.has(w)) return 'note';
    if (notValueWord(word)) status = true;
    if (LEAK.test(word)) leak = true;
    // Function words («у», «в», «with», «at») introduce whose or where it is.
    if (FUNCTION.has(w)) {
      objectNext = true;
      continue;
    }
    // Other stop words end the label («Password not needed»), unless a
    // connector follows («Kaspi password received today: …»).
    if (stopWord(word)) {
      if (join > i) continue;
      return false;
    }
    if (prepositionObject > 0 || russian || /\p{Lu}|\d|^@/u.test(word) || join > i) {
      prepositionObject = Math.max(0, prepositionObject - 1);
      continue;
    }
    // A lowercase word with nothing joining: a verb or a compound noun
    // («token remains …», «password reset link»); the sweep reads the line.
    return false;
  }
  // 2. The connector: «:», «is», «— это», «changed to», «сменён на», «, теперь», «?».
  let mode: Mode | undefined;
  let assignment = false;
  let state = false;
  let sawState = false;
  for (let n = 0; n < 6 && i < toks.length; n++) {
    const tok = toks[i];
    const word = tok.t;
    if (tok.k === 'm') {
      i++;
    } else if (tok.k === 'c' && !tok.bol) {
      if (mode !== 'state') mode = 'connector';
      assignment = word === '=';
      state = false;
      i++;
    } else if (tok.k === 'p' && word === ',' && state && NOW.test(toks[i + 1]?.t ?? '')) {
      i++;
    } else if (tok.k === 'p' && word === '?' && !mode && n === 0 && toks[i + 1]?.k === 'w') {
      mode = 'connector'; // «Kaspi password? Kotik»
      i++;
    } else if (tok.k !== 'w') {
      break;
    } else if (CONNECTOR_WORD.test(word)) {
      mode ??= 'connector';
      i++;
    } else if (FILLER.has(lower(word)) && (mode || state)) {
      i++;
    } else if (NOW.test(word) || (TO.test(word) && (state || verbBefore()))) {
      // «сменил пароль на VDS» names where; «changed it to …» does not.
      mode = state || sawState || NOW.test(word) || !/^на$/iu.test(word) ? 'state' : 'verb';
      state = false;
      i++;
    } else if (STATE_WORD.test(word) || (state && /^же$/iu.test(word))) {
      state = true;
      sawState = true;
      i++;
    } else {
      break;
    }
  }
  if (state) mode = 'stateBare';
  // A line break only at the end of the label line, at most one blank line,
  // and not into a list or a heading.
  if (toks[i]?.k === 'n') {
    if (mode === 'state' || mode === 'stateBare' || mode === 'verb') return false;
    mode ??= 'newline';
    i += toks[i + 1]?.k === 'n' ? 2 : 1;
    if (listMarker(toks, i) || toks[i]?.k === 'n') return false;
  }
  if (!mode) return false;
  // 3. The value.
  if ((kind === 'glued' || kind === 'key') && SCHEME.test(toks[i]?.t ?? '') && toks[i + 1]?.k === 'w') i++;
  let tok = toks[i];
  let next: Tok | undefined = toks[i + 1];
  // «Пароль: [Kotik2024]», «Password: (Kotik2024)».
  if (tok?.k === 'o' && '([{'.includes(tok.t) && toks[i + 1]?.k === 'w' && toks[i + 2]?.k === 'o') {
    tok = toks[++i];
    next = undefined;
  }
  if (tok?.k !== 'w') return false;
  if ((kind === 'pw' || kind === 'pass') && loginPair(toks, i, login, login && mode === 'connector')) return true;
  if (mode === 'newline') {
    // The value is alone on its line; a plain word only under a bare label
    // line, and not a status in sentence case («Отключён»).
    if (!clauseEnds(toks[i + 1])) return false;
    if ((status || (CYRILLIC.test(tok.t) && RU_VERBAL.test(lower(tok.t)))) && kind === 'pw') return passwordShaped(tok.t, next);
  }
  if (bare && (nameSlug(tok.t) || /^\p{L}+#\d+$/u.test(tok.t))) return false; // «Ключ: server3-deploy», «Ключ: box#14»
  // «Токен утёк — 24691c7»: where it leaked, a commit.
  if (leak && /^(?:[0-9a-f]{7,12}|[0-9a-f]{40})$/u.test(tok.t)) return false;
  // «Secret: Kotik»: right after «secret:» a secret may be a plain word, like a
  // password; «Secret Santa: …», «Secret project: …» name something else.
  if (mode === 'connector' && /^(?:secrets?|секрет)$/iu.test(label) && (words === 0 || firstPreposition) &&
    LATIN.test(tok.t) && tok.t.length >= 5 && clauseEnds(next) && !notValueWord(tok.t) && !noteName(tok.t) &&
    !accountName(tok.t))
    return true;
  return valueAfter(mode, kind, tok, next, assignment, ctx, sawState) ||
    ((mode === 'connector' || mode === 'newline') && phraseValue(kind, toks, i)) ||
    (kind === 'pw' && mode === 'connector' && spokenNumber(toks, i + 1) && !notValueWord(tok.t));
}

/** A label inside quotes names a button or a field: «"Forgot password" link». */
function quotedLabel(s: string, start: number, end: number, floor: number): boolean {
  const q = s[end];
  if (!q || !'"\'”»`'.includes(q)) return false;
  if (/^.\s{0,3}[:=]/u.test(s.slice(end, end + 6))) return false;
  const open = q === '”' ? '“' : q === '»' ? '«' : q;
  for (let i = start - 1; i >= Math.max(floor, start - 40); i--) {
    if (BREAKS.includes(s[i])) return false;
    if (s[i] === open) return true;
  }
  return false;
}

function clauseStart(toks: Tok[]): number {
  let clause = toks.length;
  while (clause > 0 && toks[clause - 1].k !== 'p' && toks[clause - 1].k !== 'n') clause--;
  return clause;
}

/** Back to the start of the label's clause: «Use X as the Kaspi password»,
 * «X (пароль от Kaspi)»; a strong word that is the subject of a verb
 * («Gulnara2024 забыла пароль») or follows a service name («Instagram
 * ivan1990: …») names an account. */
function sweepBefore(kind: Kind, before: Tok[], ctx: Ctx): boolean {
  const from = clauseStart(before);
  let previous = '';
  for (let i = from; i < before.length; i++) {
    const tok = before[i];
    if (tok.k !== 'w') {
      previous = '';
      continue;
    }
    const next = before[i + 1];
    // «Gulnara2024 забыла пароль», «gulnara2024 forgot the password».
    const subject = next?.k === 'w' && !CONNECTOR_WORD.test(next.t) && !STATE_WORD.test(next.t) &&
      (RU_STATUS.has(lower(next.t)) || SUBJECT_VERB.test(next.t) || (CYRILLIC.test(next.t) && RU_VERB.test(lower(next.t))));
    if (!subject && !serviceName(lower(previous)) && !(previous && (objectAfter(previous, tok.t) || modelAfter(previous, tok.t))) &&
      strong(kind, tok, next, ctx, false))
      return true;
    previous = tok.t;
  }
  return false;
}

function labelSite(site: Site, label: string, kind: Kind): boolean {
  const { s, start, end, ctx } = site;
  if (NEGATION.test(s.slice(Math.max(site.floor, start - 12), start))) return false; // «без пароля», «no password»
  // «user:password@host», «secrets/password.txt»: part of a link or a path;
  // «логин/пароль», «password/token» are labels.
  if (s[end] === '@' || (s[start - 1] === '/' && !/(?:логин|login|user|username)\/$/iu.test(s.slice(Math.max(0, start - 9), start))))
    return false;
  const lineFrom = lineStart(s, start, site.floor);
  const toks = lex(s, end, site.stop, 32);
  const before = lex(s, Math.max(lineFrom, start - 80), Infinity, 20, start);
  const stateBefore = VERB_BEFORE.test(s.slice(Math.max(lineFrom, start - 60), start));
  // «"Forgot password" link», «в поле «Пароль» вводить X»: a field's name;
  // only a value-shaped word next to it counts.
  if (quotedLabel(s, start, end, site.floor)) {
    return sweep(kind, toks, 0, ctx, stateBefore, false) || sweepBefore(kind, before, ctx);
  }
  const grammar = labelHasValue(site, label, kind, toks);
  if (grammar === true) return true;
  if (valueBeforeLabel(kind, toks, before)) return true;
  if (grammar === 'prop') return sweep(kind, toks, 0, ctx, false, false);
  if (grammar === 'note' || kind === 'pass' || kind === 'pin' || lower(label) === 'ключ') return false;
  // 3. The sweep, after and before the label on its line.
  if (sweep(kind, toks, 0, ctx, stateBefore)) return true;
  if (sweepBefore(kind, before, ctx)) return true;
  // «kaspi_session=8f3k2j5h9d7a (cookie)».
  if (/^(?:cookies?|куки)$/iu.test(label) && [...before, ...toks].some(t => t.k === 'w' && cookiePair(t.t))) return true;
  // The line above, when the label opens its line: «Kotik2024\n(пароль от
  // Kaspi)»; after only «(», «—» or «это» the line above is the value slot
  // («Murka\n(пароль от Kaspi)»).
  const lead = before.filter(t => t.k !== 'm');
  if (lead.filter(t => t.k === 'w').length <= 3 && start > 0) {
    const above = lineStart(s, start, site.floor);
    if (above > site.floor + 1) {
      const prev = lex(s, lineStart(s, above - 1, Math.max(site.floor, above - 200)), Infinity, 6, above - 1);
      const words = prev.filter(t => t.k === 'w');
      const pointing = lead.length > 0 &&
        lead.every(t => (t.k === 'o' && t.t === '(') || (t.k === 'c' && (t.t === '—' || t.t === '–')) ||
          (t.k === 'w' && CONNECTOR_WORD.test(t.t))); // «- пароль …» is a list item
      if (words.length === 1 && strong(kind, words[0], undefined, ctx, false)) return true;
      if (pointing && words.length >= 1 && words.length <= 3 && slotValue(kind, prev, lineBody(prev), ctx)) return true;
    }
  }
  // Lines below a label line that ends with «:» or points below; else the
  // first line below when it holds one word or «value: …».
  const nl = toks.findIndex(t => t.k === 'n');
  if (nl < 0) return false;
  const rest = toks.slice(0, nl).filter(t => t.k !== 'm');
  const last = rest[rest.length - 1];
  const opens = rest.length === 0 || last.k === 'c' || rest.some(t => /^(?:ниже|below)$/iu.test(t.t));
  const plural = PLURAL.test(label);
  const from = toks[nl].p + (s[toks[nl].p] === '\r' && s[toks[nl].p + 1] === '\n' ? 2 : 1);
  // A plain word below counts only when the label line names nothing more
  // than whose password it is («### Kaspi password», «Пароль от Kaspi»).
  const bareLine = !plural && rest.filter(t => t.k === 'w').length <= 3 &&
    rest.every(t => t.k !== 'w' || (!notValueWord(t.t) || PREPOSITION.test(t.t) || /^(?:ниже|below)$/iu.test(t.t)));
  if (opens) {
    const list = /(?:s|и|ы|ей)$/iu.test(label) || rest.every(t => t.k === 'w' || t.k === 'c' || t.k === 'o' || t.k === 's');
    return linesBelow(site, kind, from, list, bareLine);
  }
  return nextLine(site, kind, from, bareLine);
}

// --- Identifiers and fields named after a credential --------------------------
const CRED_PART: Record<string, Kind> = {
  password: 'pw', passwd: 'pw', passphrase: 'pw', passcode: 'pw', пароль: 'pw',
  pass: 'pass', pwd: 'pass', pw: 'pass',
  secret: 'glued', cookie: 'glued', token: 'key', токен: 'key', apikey: 'key', key: 'key', auth: 'key', pin: 'pin',
};
const SUFFIX = /^(?:prod|production|dev|develop|test|testing|stage|staging|sandbox|live|value|val|old|new|main|primary|secondary|backup|raw|b64|base64|enc|current|cur|prev|previous|local|default|\d+|v\d+)$/iu;
const NOT_SECRET_KEY = /^(?:primary|foreign|sort|partition|idempotency|cache|routing|row|object|map|public|pub|project|table|fact|i18n|translation|message|unique|lookup|dedupe|dedup|composite|index|search|hash|group|range|cluster|shard|lock|ssh|gpg|pgp|deploy|host|license|licence|registry|storage|state|config|setting|settings|dict|hotkey|shortcut)$/iu;
const GLUED_SUFFIX = /(?:password|passwd|rootpass|apikey|accesstoken|authtoken|bottoken|secretkey)$/iu;
/** «kaspi_password», «dbPassword», «STRIPE_API_KEY_PROD», «wifipassword»:
 * the credential the identifier names, if any. «password_policy»,
 * «token_limit», «sort_key», «max_tokens» name something else. */
function identKind(name: string): Kind | undefined {
  const parts = name.split(/[_.\s-]+|(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/u).filter(Boolean).map(lower);
  if (parts.length === 0 || parts.length > 10) return undefined;
  let at = parts.length - 1;
  while (at > 0 && SUFFIX.test(parts[at]) && !CRED_PART[parts[at]]) at--;
  const part = parts[at];
  const kind = CRED_PART[part];
  if (kind) {
    if ((part === 'key' || part === 'auth') && (parts.length === 1 || (at > 0 && NOT_SECRET_KEY.test(parts[at - 1]))))
      return parts.length === 1 ? 'glued' : undefined;
    return kind;
  }
  if (parts.length === 1 && GLUED_SUFFIX.test(part) && part.length > 7)
    return /pass/u.test(part) ? 'pw' : 'key';
  return undefined;
}
const IDENT = /(?<![\p{L}\p{N}_.$-])(["'`]?)([A-Za-z][A-Za-z0-9_.-]{0,80})\1[ \t]{0,3}([:=])(?![=:/])/gu;

function identHasValue(s: string): boolean {
  const matches = [...s.matchAll(IDENT)];
  for (let n = 0; n < matches.length; n++) {
    const match = matches[n];
    const name = match[2];
    // A plain label is grammar's job; «key=…», «auth=…» are assignments.
    if (!/[_.-]|[a-z][A-Z]/u.test(name) && !GLUED_SUFFIX.test(name) && !(match[3] === '=' && /^(?:key|auth|pw)$/iu.test(name)))
      continue;
    const kind = identKind(name);
    if (!kind) continue;
    const from = match.index! + match[0].length;
    // The value word stops at the next identifier: «KEY=KEY=…» stays linear.
    const until = Math.min(s.length, from + 256, Math.max(from + 64, matches[n + 1]?.index ?? Infinity));
    const toks = lex(s, from, Infinity, 8, until);
    let i = 0;
    while (toks[i]?.k === 'm') i++;
    const tok = toks[i];
    if (tok?.k !== 'w' || tok.p > from + 4) continue;
    if (PLACEHOLDER.test(tok.t)) continue;
    const assignment = match[3] === '=';
    const ctx: Ctx = { s, at: match.index!, floor: 0 };
    if (valueAfter('connector', kind, tok, toks[i + 1], assignment, ctx, false)) return true;
  }
  return false;
}

// --- Tables and CSV -----------------------------------------------------------
function cells(line: string): { sep: string; cells: string[] } | undefined {
  const t = line.trim();
  if (t.startsWith('|') && t.length > 2) return { sep: '|', cells: t.replace(/^\||\|$/gu, '').split('|').slice(0, 40) };
  for (const sep of ['\t', ';', ',']) {
    if (!t.includes(sep)) continue;
    const parts = t.split(sep);
    if (parts.length >= 2 && parts.length <= 40) return { sep, cells: parts };
  }
  return undefined;
}
const SEPARATOR_ROW = /^\s*\|?\s*:?-{2,}/u;
/** A label cell: a label and at most five more words («Пароль», «API key»,
 * «Пароль от личного кабинета Kaspi»). */
function labelCell(cell: string): Kind | undefined {
  const text = cell.replace(/[*`_]/gu, '').trim();
  if (!text || text.length > 60 || text.split(/\s+/u).length > 6) return undefined;
  const match = LABEL_ONE.exec(text);
  if (!match) return undefined;
  const groups = match.groups!;
  const kind = (Object.keys(groups) as Kind[]).find(name => groups[name] !== undefined)!;
  if (kind === 'pass' || (kind === 'glued' && lower(match[0]) === 'ключ')) return undefined;
  // «| Пароль у кого |», «| Владелец пароля |»: a column of people.
  if (/(?:у[ \t]+кого|кто|owner|holder|владел|хранит|ответствен)/iu.test(text)) return undefined;
  return kind;
}
function labelPlural(cell: string): boolean {
  return PLURAL.test(LABEL_ONE.exec(cell.replace(/[*`_]/gu, '').trim())?.[0] ?? '');
}
function cellValue(kind: Kind, cell: string, ctx: Ctx, plural = false): boolean {
  const text = cell.trim();
  if (!text) return false;
  return slotValue(kind, lex(text, 0, Infinity, 12), 0, { s: text, at: 0, floor: 0, plural, commit: ctx.commit });
}
// A header cell beside «Пароль»: «| Пароль | Где лежит |», «| Пароль | Статус |».
const HEADER_WORD = /^(?:статус|значение|комментарий|примечание|описание|сервис|логин|кто|где|когда|дата|срок|владелец|источник|тип|ссылка|заметка|заметки|имя|название|аккаунт|пользователь|детали|value|status|comment|note|notes|description|service|login|owner|where|who|when|date|type|link|source|name|account|user|details)$/iu;
/** «| Сервис | Логин | Пароль |» over «| Kaspi | shop | … |», «service\tpassword»
 * over its rows, and a row «| Пароль | … |». One pass: a header with label
 * cells holds until a line of another shape. */
function tableHasValue(s: string, ctx: Ctx): boolean {
  let header: { sep: string; count: number; kinds: (Kind | undefined)[]; plural: boolean[] } | undefined;
  let next = 0;
  let line = '';
  for (let at = 0, n = 0; at < s.length; n++) {
    if (n === 0) {
      next = lineEnd(s, at, s.length);
      line = s.slice(at, Math.min(next, at + 2000));
    }
    at = next + (s[next] === '\r' && s[next + 1] === '\n' ? 2 : 1);
    const following = at < s.length ? lineEnd(s, at, s.length) : at;
    const after = at < s.length ? s.slice(at, Math.min(following, at + 2000)) : '';
    const row = /[|\t;,]/u.test(line) && !SEPARATOR_ROW.test(line) ? cells(line) : undefined;
    if (row) {
      const kinds = row.cells.map(labelCell);
      if (row.sep === '|') {
        // A key-value row: «| Пароль | Kotik2024 |»; as the first row of a
        // two-column table too («| Пароль | Kotik |\n|---|---|»).
        const headerRow = SEPARATOR_ROW.test(after);
        if (!headerRow || (kinds.length === 2 && kinds[0] && !kinds[1] && !HEADER_WORD.test(row.cells[1].replace(/[*`_]/gu, '').trim())))
          for (let k = 0; k + 1 < kinds.length; k++)
            if (kinds[k] && cellValue(kinds[k]!, row.cells[k + 1], ctx, labelPlural(row.cells[k]))) return true;
      }
      if (header && header.sep === row.sep && (row.sep === '|' || header.count === row.cells.length)) {
        for (let k = 0; k < header.kinds.length; k++)
          if (header.kinds[k] && row.cells[k] !== undefined && cellValue(header.kinds[k]!, row.cells[k], ctx, header.plural[k])) return true;
      } else {
        header = undefined;
      }
      // A CSV header is short words: «service;login;password».
      const labels = kinds.filter(Boolean).length;
      const shaped = row.sep === '|' || row.cells.every(cell => cell.trim().length <= 60 && cell.trim().split(/\s+/u).length <= 6);
      if (labels > 0 && labels < kinds.length && shaped)
        header = { sep: row.sep, count: row.cells.length, kinds, plural: row.cells.map(labelPlural) };
    } else if (!SEPARATOR_ROW.test(line)) {
      header = undefined;
    }
    next = following;
    line = after;
  }
  return false;
}

function textHasCredential(text: string): boolean {
  if (SHAPE.test(text) || SHAPE_I.test(text) || CLI.test(text)) return true;
  for (const match of text.matchAll(URL_USERINFO)) if (!PLACEHOLDER.test(match[1]) && match[1].length >= 3) return true;
  const labels = [...text.matchAll(LABEL)];
  for (let n = 0; n < labels.length; n++) {
    const match = labels[n];
    const groups = match.groups!;
    const kind = (Object.keys(groups) as Kind[]).find(name => groups[name] !== undefined)!;
    const start = match.index!;
    const end = start + match[0].length;
    const floor = n > 0 ? labels[n - 1].index! + labels[n - 1][0].length : 0;
    const stop = n + 1 < labels.length ? labels[n + 1].index! : Infinity;
    const ctx: Ctx = { s: text, at: start, floor, plural: PLURAL.test(match[0]) };
    if (labelSite({ s: text, start, end, floor, stop, ctx }, match[0], kind)) return true;
  }
  const ctx: Ctx = { s: text, at: 0, floor: 0, commit: false };
  return identHasValue(text) || ((text.includes('|') || text.includes('\t') || /[;,]/u.test(text)) &&
    labels.length > 0 && tableHasValue(text, ctx));
}

/** A field named after a credential holds a value: «{password: 'Мурка'}»,
 * «{key: 'gmail_app_password', value: 'abcd efgh ijkl mnop'}». */
function fieldHasValue(name: string, value: string): boolean {
  const kind = identKind(name) ?? (/[_.\s-]|[a-z][A-Z]/u.test(name) ? undefined : labelCell(name));
  if (!kind || (kind === 'pass' && !/[_.-]/u.test(name))) return false; // «pwd» is a folder
  const text = value.normalize('NFKC').trim();
  if (!text || text.length > 200) return false;
  const ctx: Ctx = { s: text, at: 0, floor: 0, commit: COMMIT_LINE.test(text), plural: /(?:tokens|токены|keys|secrets|passwords|пароли)$/iu.test(name) };
  if (WHEN.test(name)) ctx.when = true;
  return slotValue(kind, lex(text, 0, Infinity, 12), 0, ctx, /(?:login|user|логин)/iu.test(name));
}

export function containsMemoryCredentials(value: unknown): boolean {
  if (typeof value === 'string') return textHasCredential(value.normalize('NFKC'));
  if (Array.isArray(value)) return value.some(containsMemoryCredentials);
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  // The field name is the label: «{password: …}», «{key: 'api_key', value: …}».
  if (typeof record.key === 'string' && typeof record.value === 'string' &&
    (fieldHasValue(record.key, record.value) || textHasCredential(`${record.key}=${record.value}`.normalize('NFKC'))))
    return true;
  return Object.entries(record).some(([key, item]) =>
    typeof item === 'string'
      ? fieldHasValue(key, item) || textHasCredential(`${key}=${item}`.normalize('NFKC'))
      : containsMemoryCredentials(item));
}
