import { createHash } from 'crypto';

import { readEnvFile } from './env.js';
import type {
  GoogleDriveFileType,
  GoogleWorkspaceTool,
} from './google-workspace-operation.js';
import type { NewMessage } from './types.js';

export interface GoogleOperationPolicy {
  intentId: string;
  allowedTools: GoogleWorkspaceTool[];
  allowedDocumentIds: string[];
  allowedSpreadsheetIds: string[];
  allowedScriptIds: string[];
  allowedFolderIds: string[];
  allowedCalendarIds: string[];
  allowedSheetRanges: string[];
  allowedSheetTargets: Array<{ spreadsheetId: string; range: string }>;
  /**
   * Append authority is intentionally separate from read authority so a turn
   * that reads one table and appends another cannot cross-use the targets.
   */
  allowedSheetAppendTargets: Array<{
    label: string;
    spreadsheetId: string;
    range: string;
    columnCount: number;
    maxRowsPerCall: number;
  }>;
  allowedScriptFileNames: string[];
  confirmedDocumentReplaceIds: string[];
  confirmedSheetUpdateIds: string[];
  confirmedSheetUpdateTargets: Array<{
    spreadsheetId: string;
    range: string;
  }>;
  confirmedScriptUpdateIds: string[];
  confirmedScriptUpdateTargets: Array<{
    scriptId: string;
    fileName: string;
  }>;
  /** Per-clause Drive authority; name/full-text/type/folder never cross-mix. */
  allowedDriveSearchTargets: Array<{
    nameQuery?: string;
    contentQuery?: string;
    type: GoogleDriveFileType;
    folderId?: string;
    rootOnly: boolean;
    unfiltered: boolean;
  }>;
  /** Exact optional Calendar search terms explicitly supplied by the owner. */
  allowedCalendarQueries: string[];
  /** Exact Calendar/resource pairs; the global time window applies to each. */
  allowedCalendarTargets: Array<{ calendarId: string; query?: string }>;
  /** Stable bounds derived from the latest authoritative owner timestamp. */
  calendarEarliestTime?: string;
  calendarLatestTime?: string;
  /** Exact per-turn creation targets; omitted title means one generic slot. */
  allowedCreateTargets: Array<{
    tool: 'google_sheets_create' | 'google_docs_create';
    title?: string;
    folderId?: string;
    root: boolean;
  }>;
  rootCreateTools: Array<'google_sheets_create' | 'google_docs_create'>;
  allowStatusVerify: boolean;
  allowDriveSearch: boolean;
  allowUnfilteredDriveList: boolean;
  allowRootCreate: boolean;
  allowUserEnteredValues: boolean;
}

export interface ConfiguredGoogleSheetTarget {
  aliases: string[];
  spreadsheetId: string;
  /** Exact, bounded A1 table range used for both reads and append-only writes. */
  range: string;
}

const GOOGLE_ID_RE =
  /(?<![A-Za-z0-9_-])([A-Za-z0-9_-]{20,256})(?![A-Za-z0-9_-])/g;
const GOOGLE_ID_VALUE_RE = /^[A-Za-z0-9_-]{20,256}$/;
const CALENDAR_ID_VALUE_RE = /^[A-Za-z0-9._@#-]{1,256}$/;
const CALENDAR_IDENTIFIER_RE =
  /(?:\bprimary\b|[A-Za-z0-9._%+#-]+@[A-Za-z0-9.-]+)/gi;
const SHEET_RANGE_RE =
  /(?<![A-Za-z0-9_])((?:(?:'[^'\r\n]{1,100}'|[A-Za-z\u0400-\u04ff0-9_]{1,100})!)?(?:\$?[A-Za-z]{1,3}\$?[1-9]\d{0,6}(?::\$?[A-Za-z]{1,3}\$?[1-9]\d{0,6})?|\$?[A-Za-z]{1,3}:\$?[A-Za-z]{1,3}))(?![A-Za-z0-9_])/g;
const SCRIPT_FILE_WITH_EXTENSION_RE =
  /(?<![\p{L}\p{N}_.-])([\p{L}\p{N}][\p{L}\p{N}_.-]{0,127}\.(?:gs|html|json))(?![\p{L}\p{N}_.-])/giu;
const SCRIPT_FILE_AFTER_LABEL_RE =
  /(?:^|[^\p{L}\p{N}_])(?:файл(?:е|а)?|file)\s+[`"'«]?([\p{L}\p{N}][\p{L}\p{N}_.-]{0,127})[`"'»]?/giu;

const SHEET_OBJECT = String.raw`(?:\bgoogle\s+sheets?\b|\bgoogle\s+spreadsheet\b|\bsheets?\b|\bspreadsheet\b|(?:google|гугл)[\s-]*(?:таблиц[а-яё]*|таблич[а-яё]*)|таблиц[а-яё]*|таблич[а-яё]*)`;
const DIRECT_NAMED_SHEET_OBJECT = String.raw`(?<![\p{L}\p{N}_])(?:google\s+sheets?|google\s+spreadsheets?|sheets?|spreadsheets?|(?:(?:google|гугл)[\s-]*)?(?:таблица|таблицу|таблице|таблицы|таблицей|таблиц|таблицам|таблицами|таблицах|табличка|табличку|табличке|таблички|табличкой|табличек|табличкам|табличками|табличках)|табель|табеля|табелю|табеле|табелем|табели|табелей|табелям|табелями|табелях|ведомость|ведомости|ведомостью|ведомостей|ведомостям|ведомостями|ведомостях)(?![\p{L}\p{N}_])`;
const DOCUMENT_OBJECT = String.raw`(?:\bgoogle\s+docs?\b|\bdocuments?\b|гугл[\s-]*документ[а-яё]*|документ[а-яё]*)`;
const SCRIPT_OBJECT = String.raw`(?:\bapps?\s*script\b|\bgoogle\s+script\b|гугл[\s-]*скрипт[а-яё]*|скрипт[а-яё]*)`;
const FOLDER_OBJECT = String.raw`(?:\bfolders?\b|папк[а-яё]*)`;
const DRIVE_OBJECT = String.raw`(?:\bgoogle\s+drive\b|\bmy\s+drive\b|гугл[\s-]*диск[а-яё]*|диск[а-яё]*[\s-]*google)`;
const CALENDAR_OBJECT = String.raw`(?:\bgoogle\s+calendar\b|\bcalendar\b|гугл[\s-]*календар[а-яё]*|календар[а-яё]*)`;
const RUSSIAN_MAILBOX_OBJECT = String.raw`(?:электронн[а-яё]*\s+)?почт(?:а|у|е|ы|ой|ою)(?![\p{L}\p{N}_])`;
const GMAIL_OBJECT = String.raw`(?:\bgmail\b|\bgoogle\s+mail\b|\b(?:e-?mails?|mail|mailbox|inbox)\b|гугл[\s-]*(?:почт(?:а|у|е|ы|ой|ою)(?![\p{L}\p{N}_])|мейл(?:а|у|е|ом|ы)?(?![\p{L}\p{N}_]))|${RUSSIAN_MAILBOX_OBJECT}|(?:в|во)\s+входящ[а-яё]*(?=\s*(?:[.!?]|$)|\s+письм[а-яё]*)|входящ[а-яё]*\s+письм[а-яё]*|\be-?mailed\s+me\b)`;

const READ_ACTION = String.raw`(?:(?<![\p{L}\p{N}_])прочит[а-яё]*|(?<![\p{L}\p{N}_])прочт[а-яё]*|посмотр[а-яё]*|глян[а-яё]*|провер[а-яё]*|покаж[а-яё]*|откро[а-яё]*|выгруз[а-яё]*|\bread\b|\bcheck\b|\bshow\b|\bopen\b|\bexport\b)`;
const DRIVE_SEARCH_ACTION = String.raw`(?:найд[а-яё]*|поищ[а-яё]*|ищи|искать|покаж[а-яё]*|перечисл[а-яё]*|\bfind\b|\bsearch\b|\blist\b|\bshow\b)`;
const SHEET_UPDATE_ACTION = String.raw`(?:запис[а-яё]*|запиш[а-яё]*|впис[а-яё]*|впиш[а-яё]*|внес[а-яё]*|добав[а-яё]*|занес[а-яё]*|заполн[а-яё]*|обнов[а-яё]*|измен[а-яё]*|поправ[а-яё]*|замен[а-яё]*|очист[а-яё]*|\bwrite\b|\badd\b|\bupdate\b|\breplace\b|\bclear\b)`;
const SHEET_APPEND_ACTION = String.raw`(?:запис[а-яё]*|запиш[а-яё]*|впис[а-яё]*|впиш[а-яё]*|внес[а-яё]*|добав[а-яё]*|занес[а-яё]*|\bwrite\b|\badd\b|\bappend\b)`;
const DIRECT_SHEET_APPEND_INTENT_ACTION = String.raw`(?<![\p{L}\p{N}_])(?:добавь(?:те)?|добавляй(?:те)?|добавить|запиши(?:те)?|записывай(?:те)?|записать|впиши(?:те)?|вписывай(?:те)?|вписать|внеси(?:те)?|вноси(?:те)?|внести|занеси(?:те)?|заноси(?:те)?|занести|write|add|append)(?![\p{L}\p{N}_])`;
const DOCUMENT_REPLACE_ACTION = String.raw`(?:замен[а-яё]*|перепиш[а-яё]*|запиш[а-яё]*|обнов[а-яё]*|измен[а-яё]*|очист[а-яё]*|\breplace\b|\boverwrite\b|\bupdate\b|\bclear\b)`;
const SCRIPT_UPDATE_ACTION = String.raw`(?:обнов[а-яё]*|измен[а-яё]*|поправ[а-яё]*|замен[а-яё]*|перепиш[а-яё]*|\bupdate\b|\breplace\b|\boverwrite\b)`;
const CREATE_ACTION = String.raw`(?:созда[а-яё]*|сдела[а-яё]*|\bcreate\b|\bmake\b)`;
const GMAIL_READ_ACTION = String.raw`(?:${READ_ACTION}|${DRIVE_SEARCH_ACTION}|(?:что|чего|сколько|какие|какая|какой|кто|есть\s+ли)(?![\p{L}\p{N}_])|\bwhat(?:'s|\s+is)?\b|\bwhich\b|\bwho\b|\bhow\s+many\b)`;
const AMBIGUOUS_EMAIL_ADDRESS_LOOKUP =
  /(?:(?:найд[а-яё]*|покаж[а-яё]*|скажи|узнай[а-яё]*)[\s\S]{0,80}(?:почт[а-яё]*|e-?mail)[\s\S]{0,80}(?:адрес[а-яё]*|контакт[а-яё]*|компан[а-яё]*|организац[а-яё]*|сайт[а-яё]*|телефон[а-яё]*)|\b(?:find|show|look\s+up|get)\b[\s\S]{0,80}\b(?:e-?mail|mail)\b[\s\S]{0,80}\b(?:address|contact|company|business|website|phone)\b)/iu;
const PERSONAL_EMAIL_ADDRESS_LOOKUP =
  /(?:(?:найд[а-яё]*|покаж[а-яё]*|скажи|узнай[а-яё]*)\s+(?:мне\s+)?(?:почт(?:у|а|ы)|e-?mail)\s+(?!за\b|от\b|в\b|из\b|с\b|по\b)[\p{L}][\p{L}-]{1,}|\b(?:find|show|look\s+up|get)\b[\s\S]{0,40}(?:\b[\p{L}][\p{L}'’-]{1,}['’]s\s+e-?mail\b|\be-?mail\s+(?:for|of)\s+[\p{L}][\p{L}'’-]{1,}\b))/iu;
const EXPLICIT_GMAIL_MESSAGE_CONTEXT =
  /(?:\bgmail\b|\b(?:my\s+)?inbox\b|(?:в|из)\s+(?:мо[её]й\s+)?почт(?:е|ы)|письм[а-яё]*\s+от|\b(?:e-?mails?|messages?)\s+from\b)/iu;
const EXPLICIT_GMAIL_LOCATION_CONTEXT =
  /(?:\bgmail\b|\b(?:my\s+)?(?:inbox|mailbox)\b|\b(?:in|inside|from)\s+(?:my\s+)?(?:e-?mail|mail)\b|(?:в|из)\s+(?:мо[её]й\s+)?почт(?:е|ы))/iu;
const EXPLICIT_NON_GMAIL_CONTENT_SOURCE =
  /(?:\b(?:this|following|pasted|copied)\s+(?:e-?mail|mail)\b|\b(?:in|inside|from|into|on)\s+(?:(?:this|the|an?|attached)\s+)?(?:telegram|slack|whatsapp|teams?|discord|notion|chat|message|pdf|file|document|csv|spreadsheet|sheet|google\s+(?:docs?|drive|sheets?))\b|\b(?:pasted|copied)(?:\s+\p{L}+){0,3}\s+(?:below|here|into\s+(?:telegram|slack|whatsapp|teams?|discord))\b|\b(?:pasted\s+below|copied\s+below)\b|(?:в|из)\s+(?:эт(?:ом|ого)\s+|прикрепленн[а-яё]*\s+)?(?:телеграм[а-яё]*|telegram|slack|whatsapp|чат[а-яё]*|сообщен[а-яё]*|pdf|файл[а-яё]*|документ[а-яё]*|csv|гугл[\s-]*(?:документ|диск|таблиц)[а-яё]*))/iu;
const NON_MAILBOX_TECHNICAL_CONTEXT =
  /(?:\b(?:gmail|e-?mails?|mail|mailbox)\s+(?:(?:account\s+)?(?:password|credentials?)|login|oauth|authentication|address|field|validation|validator|parser|module|server|service|template|code|api|connector|logs?|settings?|config(?:uration)?)\b|(?:парол|логин|уч[её]тн[а-яё]*\s+данн)[а-яё]*[\s\S]{0,40}(?:gmail|почт[а-яё]*)|почтов[а-яё]*\s+(?:адрес|поле|валидац|валидатор|парсер|модул|сервер|сервис|шаблон|код|api|коннектор|лог|настройк|конфигурац)[а-яё]*)/iu;

const DEFAULT_ALIAS =
  /(?:основн(?:ая|ую|ой|ый|ого|ом)|по\s+умолчанию|\bdefault\b)/i;
const ROOT_TARGET =
  /(?:(?:в|из|на)\s+(?:самом\s+)?корн(?:е|ь)\s+(?:моего\s+)?(?:my\s+drive|google\s+drive|гугл[\s-]*диск[а-яё]*)|(?:в|на)\s+мо[её]м\s+гугл[\s-]*диск[а-яё]*|\b(?:in|at|to|under|from|inside|within)\s+(?:the\s+)?(?:google\s+drive|my\s+drive)(?:'s)?\s+root\b|\b(?:in|at|to|under|from|inside|within)\s+(?:the\s+)?root\s+(?:of|in)\s+(?:google\s+drive|my\s+drive)\b)/i;
const NEGATIVE_ROOT_TARGET =
  /(?:не\s+(?:в|на)\s+(?:самом\s+)?корн(?:е|ь)|\bnot\s+(?:in|at|to)\s+(?:the\s+)?(?:google\s+drive|my\s+drive|root)\b|\boutside\s+(?:google\s+drive|my\s+drive|the\s+root)\b)/i;
const ALL_FILES_DRIVE = /(?:все\s+файл[а-яё]*|\ball\s+files\b)/i;
const NEGATIVE_ALL_FILES_DRIVE =
  /(?:не\s+все\s+файл[а-яё]*|\bnot\s+all\s+files\b)/i;
const MY_DRIVE_SCOPE =
  /(?:\bmy\s+(?:(?:own|personal)\s+)?(?:google\s+)?drive\b|мо[её]м\s+(?:личн[а-яё]*\s+)?(?:(?:google|гугл)[\s-]*)?диск[а-яё]*)/i;
const CONCEPTUAL_QUESTION =
  /(?:что\s+такое|как\s+(?:можно\s+)?(?:пользоваться|работает|прочитать|читать)|\bwhat\s+is\b(?!\s+(?:in|inside|on)\b)|\bhow\s+to\b)/i;
const POSITIVE_CONFIRMATION_PREFIX =
  /^(?:(?:я|i)\s+)?(?:явно\s+|explicitly\s+)?(?:подтверждаю|\bconfirm(?:ed)?\b)\s*[:,\-]?\s*/i;
const ASSISTANT_ADDRESS_PREFIX =
  /^(?:(?:(?:скуби(?:\s+кот)?|skoobi)(?:\s*[,!:;\-–—]\s*|\s+)){1,4})/iu;
const NEGATIVE_CONFIRMATION =
  /(?:не\s+подтверждаю|без\s+подтверждения|\b(?:do\s+not|don['’]?t|not)\s+confirm\b)/i;
const POSITIVE_FORMULA_PERMISSION =
  /(?:формул[а-яё]*\s+разрешаю|разрешаю\s+(?:использовать\s+)?формул[а-яё]*|\buser[_ -]?entered\b)/i;
const NEGATIVE_FORMULA_PERMISSION =
  /(?:без\s+формул[а-яё]*|не\s+разрешаю\s+формул[а-яё]*|формул[а-яё]*\s+(?:не\s+разрешаю|запрещ[а-яё]*)|не\s+использ(?:уй|овать)[а-яё]*\s+user[_ -]?entered|user[_ -]?entered\s+не\s+использ(?:уй|овать)[а-яё]*|\bno\s+formulas?\b|\bformulas?\s+(?:are\s+)?(?:not\s+allowed|forbidden|prohibited)\b|\b(?:do\s+not|don['’]?t)\s+use\s+user[_ -]?entered\b|\buser[_ -]?entered\s+(?:is\s+)?(?:not\s+allowed|forbidden|prohibited)\b)/i;
const NEGATIVE_DEFAULT_ALIAS =
  /(?:не\s+основн[а-яё]*|не\s+по\s+умолчанию|\bnot\s+(?:the\s+)?default\b)/i;
const NEGATIVE_NEW_OBJECT =
  /(?:не\s+(?:нужн[а-яё]*|созда[а-яё]*|дела[а-яё]*)\s+нов[а-яё]*|без\s+нов[а-яё]*|\bno\s+new\b|\b(?:do\s+not|don['’]?t)\s+(?:create|make)\b)/i;
const REPORTED_OR_QUOTED_COMMAND =
  /(?:в\s+(?:цитате|тексте|сообщении)\s+(?:написано|сказано)|^(?:цитата|quoted\s+text|the\s+text\s+says)\s*[:\-])/i;
const TRAILING_REPORTED_ATTRIBUTION =
  /(?:^|[\s,;:—–-])(?:это\s+)?(?:так\s+)?(?:сказал[а-яё]*|попросил[а-яё]*|велел[а-яё]*|написал[а-яё]*)\s+[\p{L}][\p{L}\p{N}_.-]*(?:\s+[\p{L}][\p{L}\p{N}_.-]*){0,5}\s*$/iu;
const TRAILING_NAMED_SHEET_APPEND_CANCELLATION =
  /(?:^|[\s.!?！？…。;,—–-])(?:(?:(?:стоп|отмена|подожди(?:те)?|погоди(?:те)?)(?![\p{L}\p{N}_])(?:\s*[,;—–-]\s*(?:я\s+)?передумал[а-яё]*)?)|(?:(?:ничего\s+)?не\s+(?:записывай(?:те)?|вноси(?:те)?|добавляй(?:те)?|заноси(?:те)?|вписывай(?:те)?|делай(?:те)?)(?![\p{L}\p{N}_])(?:\s+пока)?(?:\s*[,;—–-]\s*(?:я\s+)?передумал[а-яё]*)?)|(?:пока\s+не\s+(?:записывай(?:те)?|вноси(?:те)?|добавляй(?:те)?|заноси(?:те)?|вписывай(?:те)?|делай(?:те)?)(?![\p{L}\p{N}_]))|(?:(?:я\s+)?передумал[а-яё]*|не\s+сейчас|не\s+надо|(?:хотя|но|а)\s+нет))(?:\s*[.!?！？…。\]])*$/iu;
const EXPLICIT_NAMED_SHEET_COMMENT_LABEL =
  /(?:^|[,.!?;—–-]\s*|\s+)(?:комментарий|примечание|пометка|comment|note)\s*:/iu;
const NAMED_SHEET_REPORT_DEMONSTRATIVE =
  /(?:^|[\s,;:—–-])(?:эт(?:от|а|о|и|ого|ой|ою|их|ому|им(?:и)?|ом|у)|т(?:от|а|о|е|ого|ой|ою|ех|ому|ем(?:и)?|ом|у)|данн(?:ый|ая|ое|ые|ого|ой|ою|ых|ому|ым(?:и)?|ом|ую)|вот|(?:this|that|these|those)(?:\s+(?:is|was))?)\s+/iu;
const NAMED_SHEET_REPORT_NOUN =
  /(?<![\p{L}\p{N}_])(?:просьб[а-яё]*|запрос[а-яё]*|сообщени[а-яё]*|письм[а-яё]*|инструкци[а-яё]*|команд[а-яё]*|напоминани[а-яё]*|requests?|messages?|emails?|instructions?|commands?|reminders?)(?![\p{L}\p{N}_])/iu;
const NAMED_SHEET_CONTAINER_POSSESSIVE = String.raw`(?:мой|моя|мо[её]|мои|моего|моей|моему|моим(?:и)?|моих|мою|мо[её]м|наш|наша|наше|наши|нашего|нашей|нашему|нашим(?:и)?|наших|нашу|нашем|ваш|ваша|ваше|ваши|вашего|вашей|вашему|вашим(?:и)?|ваших|вашу|вашем|свой|своя|сво[её]|свои|своего|своей|своему|своим(?:и)?|своих|свою|сво[её]м|его|е[её]|их|my|our|your|his|her|their|its|the|this|that|these|those)`;
const NAMED_SHEET_CONTAINER_NOUN = String.raw`(?:входящ[а-яё]*|исходящ[а-яё]*|отправленн[а-яё]*|архив[а-яё]*|спам[а-яё]*|корзин[а-яё]*|черновик[а-яё]*|папк[а-яё]*|почт[а-яё]*|ящик[а-яё]*|чат[а-яё]*|переписк[а-яё]*|цепочк[а-яё]*|календар[а-яё]*|таблиц[а-яё]*|документ[а-яё]*|файл[а-яё]*|диск[а-яё]*|inbox|mailbox|mail|archive|spam|trash|bin|drafts?|sent|folder|chat|threads?|calendar|spreadsheets?|sheets?|documents?|files?|drive|gmail|(?:google|гугл[а-яё]*)[\s-]+(?:calendar|drive|docs?|sheets?|календар[а-яё]*|диск[а-яё]*|документ[а-яё]*|таблиц[а-яё]*))`;
const NAMED_SHEET_CONTAINER_TARGET = String.raw`(?:(?:${NAMED_SHEET_CONTAINER_POSSESSIVE})\s+)?(?:${NAMED_SHEET_CONTAINER_NOUN})(?![\p{L}\p{N}_])`;
const NAMED_SHEET_GROUP_FIELD = String.raw`(?:subjects?|senders?|recipients?|dates?|times?|labels?|statuses?|types?|names?|titles?|threads?|conversations?|relevance|newest|oldest|latest|recent)(?![\p{L}\p{N}_])`;
const NAMED_SHEET_BENIGN_RELATION_ITEM = String.raw`(?:(?:из|from|of)\s+${NAMED_SHEET_CONTAINER_TARGET}|by\s+(?:${NAMED_SHEET_CONTAINER_TARGET}|${NAMED_SHEET_GROUP_FIELD}))`;
const NAMED_SHEET_BENIGN_RELATION_SUFFIX = String.raw`(?:\s+(?:only|please|kindly|только|пожалуйста))*`;
const NAMED_SHEET_RELATION_TERMINUS = String.raw`(?:${NAMED_SHEET_BENIGN_RELATION_SUFFIX}\s*[,;:.!?—–-]*\s*$|\s*(?:[,—–-]\s*)?(?:in|on|within|inside|в|во|на)\s+${NAMED_SHEET_CONTAINER_TARGET}${NAMED_SHEET_BENIGN_RELATION_SUFFIX}\s*[,;:.!?—–-]*\s*$)`;
const NAMED_SHEET_BENIGN_RELATION_SEQUENCE = String.raw`${NAMED_SHEET_BENIGN_RELATION_ITEM}(?:\s*(?:[,—–-]\s*)?(?:(?:and|и)\s+)?${NAMED_SHEET_BENIGN_RELATION_ITEM})*${NAMED_SHEET_RELATION_TERMINUS}`;
const NAMED_SHEET_BENIGN_CONTAINER_RELATION = new RegExp(
  String.raw`(?<![\p{L}\p{N}_])${NAMED_SHEET_BENIGN_RELATION_SEQUENCE}`,
  'giu',
);
const NAMED_SHEET_REPORT_SOURCE_RELATION = new RegExp(
  String.raw`(?<![\p{L}\p{N}_])(?:(?!(?:${NAMED_SHEET_BENIGN_RELATION_SEQUENCE}))(?:от|из|from|of|by)|(?:с|со)(?=\s+(?:google|gmail|гугл[а-яё]*)(?![\p{L}\p{N}_])))\s+[\p{L}][\p{L}\p{N}_.-]*`,
  'iu',
);
const META_OR_REPORTED_COMMAND =
  /^(?:\s*explain\s+why\b|\s*(?:summari[sz]e|paraphrase|translate|discuss)\b[\s\S]{0,120}\b(?:request|instruction|plan|message)\b|\s*(?:the\s+)?(?:request|instruction|plan|message)\s+(?:is|was)\s+to\b|\s*[\p{L}][\p{L}\p{N}_. -]{0,80}\b(?:said|asked|told)\b[\s\S]{0,80}\b(?:to\s+)?(?:read|show|find|search|list|create|replace|update)\b|\s*объясни\s*,?\s*почему\b|\s*(?:перескажи|резюмируй|переведи|обсуди)\b[\s\S]{0,120}\b(?:просьб[а-яё]*|инструкц[а-яё]*|план[а-яё]*|сообщен[а-яё]*)\b|\s*(?:просьб[а-яё]*|инструкц[а-яё]*|план[а-яё]*|сообщен[а-яё]*)\s+(?:состоит\s+в\s+том,?\s+чтобы|был[а-яё]*\s+)?|\s*[\p{L}][\p{L}\p{N}_. -]{0,80}\b(?:сказал[а-яё]*|попросил[а-яё]*|велел[а-яё]*)\b[\s\S]{0,80}\b(?:прочит|покаж|найд|созда|замен|обнов)[а-яё]*)/iu;
const META_OR_REPORTED_COMMAND_RU =
  /^(?:\s*объясни\s*,?\s*почему(?![\p{L}\p{N}_])|\s*(?:перескажи|резюмируй|переведи|обсуди)(?![\p{L}\p{N}_])[\s\S]{0,120}(?:просьб[а-яё]*|инструкц[а-яё]*|план[а-яё]*|сообщен[а-яё]*)(?![\p{L}\p{N}_])|\s*(?:просьб[а-яё]*|инструкц[а-яё]*|план[а-яё]*|сообщен[а-яё]*)(?![\p{L}\p{N}_])\s+(?:состоит\s+в\s+том,?\s+чтобы|был[а-яё]*\s+)?|\s*[\p{L}][\p{L}\p{N}_. -]{0,80}(?:сказал[а-яё]*|попросил[а-яё]*|велел[а-яё]*)(?![\p{L}\p{N}_])[\s\S]{0,80}(?:прочит|покаж|найд|созда|замен|обнов)[а-яё]*)/iu;
const ACTION_LED_META_PREFIX =
  /^(?:(?:read|show)[\s\S]{0,120}(?:quote|quoted\s+(?:request|instruction|text)|instruction|literal|pasted\s+(?:text|request))[\s\S]{0,40}:|(?:прочит|покаж)[а-яё]*[\s\S]{0,120}(?:цитат[а-яё]*|инструкц[а-яё]*|буквальн[а-яё]*\s+текст[а-яё]*|вставленн[а-яё]*\s+текст[а-яё]*)[\s\S]{0,40}:)/iu;
const DECLARATIVE_AUTHORITY_TEXT =
  /^(?:(?:read\s+(?:access|permission)|(?:check|update)\s+of)\b|(?:проверка|обновление|доступ)(?![\p{L}\p{N}_]))/iu;
const FAIL_CLOSED_AUTHORITY_NEGATION =
  /(?:\b(?:no|none|neither|nor|zero|never|forbidden|prohibited|denied|disallowed|blocked|cancel|cancelled|canceled)\b|(?<![\p{L}\p{N}_])(?:ни\s+один|ни\s+одна|ни\s+одно|ни\s+одного|ноль|никогда|запрещ[а-яё]*|отказан[а-яё]*|отмен[а-яё]*|заблокир[а-яё]*)(?![\p{L}\p{N}_])|(?:^|[.!?]\s*)нет(?:\s*[.!?]|$))/iu;
const UNSUPPORTED_TARGET_ACTION =
  /(?:\b(?:then|subsequently|afterwards?|next|fetch|retrieve|download|email|notify|archive|send|forward|discuss|explain)\b|(?<![\p{L}\p{N}_])(?:затем|потом|далее|скача[а-яё]*|получ[а-яё]*|отправ[а-яё]*|уведом[а-яё]*|архив[а-яё]*|обсуд[а-яё]*|объясн[а-яё]*)(?![\p{L}\p{N}_]))/giu;
const UNSUPPORTED_DRIVE_FILTER =
  /(?:\b(?:modified|created)\s+(?:before|after|since)\b|\bowned\s+by\b|\bshared\s+with\b|(?:измен[а-яё]*|создан[а-яё]*)\s+(?:до|после)\b|(?:владел[а-яё]*|принадлеж[а-яё]*)\s+|доступн[а-яё]*\s+мне)/iu;
const DRIVE_ROOT_LANGUAGE =
  /(?:(?:\b(?:in|at|to|under|from|inside|within|outside|near|beside)\s+(?:the\s+)?(?:google\s+drive|my\s+drive)(?:'s)?\s+root\b)|(?:\b(?:in|at|to|under|from|inside|within|outside|near|beside)\s+(?:the\s+)?root\s+(?:of|in)\s+(?:google\s+drive|my\s+drive)\b)|(?:(?:в|из|на|под|рядом\s+с)\s+(?:самом\s+)?корн[а-яё]*[\s\S]{0,30}(?:гугл[\s-]*диск[а-яё]*|google\s+drive|my\s+drive)))/iu;
const UNSUPPORTED_CALENDAR_ID_ROLE =
  /(?:\b(?:attendee|recipient|email|notify)\b|(?<![\p{L}\p{N}_])(?:участник[а-яё]*|получател[а-яё]*|отправ[а-яё]*|уведом[а-яё]*)(?![\p{L}\p{N}_]))[\s\S]{0,100}[A-Za-z0-9._%+#-]+@[A-Za-z0-9.-]+/iu;
const NEGATED_GOOGLE_SELECTOR =
  /(?:\b(?:not|except|excluding|without|other\s+than)\b|(?<![\p{L}\p{N}_])(?:не|кроме|вне|без|исключая)(?![\p{L}\p{N}_]))[\s\S]{0,80}(?:\bnamed\b|\bwith\s+(?:the\s+)?name\b|\bcontaining\b|\bcontent\b|\bquery\b|\brange\b|\btype\b|\bfolder\b|\bcalendar\b|с\s+названием|по\s+названию|содержащ[а-яё]*|по\s+запросу|диапазон[а-яё]*|тип[а-яё]*|папк[а-яё]*|календар[а-яё]*)/iu;
const GENERAL_AUTHORITY_NEGATION =
  /(?:\b(?:not|except|excluding|outside|without|other\s+than)\b|(?<![\p{L}\p{N}_])(?:не|кроме|вне|без|исключая)(?![\p{L}\p{N}_]))/iu;
const STATUS_ACTION = String.raw`(?:провер[а-яё]*|покаж[а-яё]*|\bcheck\b|\bshow\b)`;
const EXPLICIT_STATUS_ACTION =
  /(?:(?:провер[а-яё]*|покаж[а-яё]*|\bcheck\b|\bshow\b).{0,80}(?:статус|подключ[а-яё]*|настро[а-яё]*|\bstatus\b|\bconfigured\b).{0,80}(?:google|гугл)|(?:google|гугл).{0,80}(?:статус|подключ[а-яё]*|настро[а-яё]*|\bstatus\b|\bconfigured\b).{0,80}(?:провер[а-яё]*|покаж[а-яё]*|\bcheck\b|\bshow\b))/i;
const CREATE_TITLE_LABEL = String.raw`(?:\b(?:with\s+)?(?:the\s+)?title\b|\bnamed\b|\bcalled\b|\btitled\b|(?:с|под)\s+названием|название|назови(?:те)?)`;
const CREATE_CONTENT_LABEL = String.raw`(?:\b(?:with\s+)?(?:the\s+)?(?:contents?|body|text)\b|(?:с\s+(?:таким\s+)?)?(?:содержани|содержим)[а-яё]*|(?:с\s+(?:таким\s+)?)?текст[а-яё]*)`;
const GOOGLE_OPERATION_OBJECT = String.raw`(?:${SHEET_OBJECT}|${DOCUMENT_OBJECT}|${SCRIPT_OBJECT}|${FOLDER_OBJECT}|${DRIVE_OBJECT}|${CALENDAR_OBJECT}|${GMAIL_OBJECT})`;
const GOOGLE_OPERATION_ACTION = String.raw`(?:${READ_ACTION}|${DRIVE_SEARCH_ACTION}|${SHEET_UPDATE_ACTION}|${DOCUMENT_REPLACE_ACTION}|${SCRIPT_UPDATE_ACTION}|${CREATE_ACTION}|${GMAIL_READ_ACTION})`;
const NEGATIVE_OBJECT_LEAD = String.raw`(?:\b(?:except|excluding|outside(?:\s+of)?|other\s+than|not(?:\s+(?:in|on|from))?)\b|(?<![\p{L}\p{N}_])(?:кроме|вне|исключая)(?![\p{L}\p{N}_])|(?<![\p{L}\p{N}_])не(?:\s+(?:в|на|из))?(?![\p{L}\p{N}_]))`;
const NEGATIVE_ID_BINDING =
  /(?:\b(?:except|excluding)\b|\bother\s+than\b|\bnot\b(?!\s+only\b)|(?<![\p{L}\p{N}_])(?:кроме|исключая)(?![\p{L}\p{N}_])|(?<![\p{L}\p{N}_])не(?![\p{L}\p{N}_]|\s+только\b))[\s\S]{0,100}$/iu;
const TYPED_GOOGLE_OPERATION_PAIRS: ReadonlyArray<
  readonly [actionSource: string, objectSource: string]
> = [
  [READ_ACTION, DOCUMENT_OBJECT],
  [READ_ACTION, SHEET_OBJECT],
  [READ_ACTION, SCRIPT_OBJECT],
  [READ_ACTION, CALENDAR_OBJECT],
  [GMAIL_READ_ACTION, GMAIL_OBJECT],
  [DRIVE_SEARCH_ACTION, DRIVE_OBJECT],
  [SHEET_UPDATE_ACTION, SHEET_OBJECT],
  [DOCUMENT_REPLACE_ACTION, DOCUMENT_OBJECT],
  [SCRIPT_UPDATE_ACTION, SCRIPT_OBJECT],
  [CREATE_ACTION, String.raw`(?:${SHEET_OBJECT}|${DOCUMENT_OBJECT})`],
];

type ResourceKind = 'document' | 'spreadsheet' | 'script' | 'folder';

interface ConfiguredGoogleResources {
  allowedResourceIds: string[];
  defaultSpreadsheetId?: string;
  defaultScriptId?: string;
  namedSheetTargets: ConfiguredGoogleSheetTarget[];
}

interface ClassifiedResourceIds {
  document: string[];
  spreadsheet: string[];
  script: string[];
  folder: string[];
}

function splitValidIds(value: string): string[] {
  return value
    .split(/[\s,]+/)
    .map((entry) => entry.trim())
    .filter((entry) => GOOGLE_ID_VALUE_RE.test(entry));
}

const CONFIGURED_SHEET_RANGE_RE =
  /^(?:'[^'\r\n]{1,100}'|[\p{L}\p{N}_]{1,100})!\$?[A-Za-z]{1,3}\$?[1-9]\d{0,6}:\$?[A-Za-z]{1,3}\$?[1-9]\d{0,6}$/u;

function configuredSheetRangeColumnCount(range: string): number | null {
  const match =
    /!\$?([A-Za-z]{1,3})\$?[1-9]\d{0,6}:\$?([A-Za-z]{1,3})\$?[1-9]\d{0,6}$/u.exec(
      range,
    );
  if (!match) return null;
  const columnNumber = (letters: string): number => {
    let result = 0;
    for (const char of letters.toUpperCase()) {
      result = result * 26 + char.charCodeAt(0) - 64;
    }
    return result;
  };
  const first = columnNumber(match[1]);
  const last = columnNumber(match[2]);
  const count = last - first + 1;
  return count >= 1 && count <= 100 ? count : null;
}

function normalizedSheetAlias(value: string): string {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase('ru-RU')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function validConfiguredSheetTargets(
  value: unknown,
): ConfiguredGoogleSheetTarget[] {
  if (!Array.isArray(value) || value.length > 32) return [];
  const targets: ConfiguredGoogleSheetTarget[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const record = raw as Record<string, unknown>;
    if (
      Object.keys(record).some(
        (key) => !['aliases', 'spreadsheetId', 'range'].includes(key),
      ) ||
      !Array.isArray(record.aliases) ||
      record.aliases.length === 0 ||
      record.aliases.length > 16 ||
      typeof record.spreadsheetId !== 'string' ||
      !GOOGLE_ID_VALUE_RE.test(record.spreadsheetId) ||
      typeof record.range !== 'string' ||
      !CONFIGURED_SHEET_RANGE_RE.test(record.range) ||
      configuredSheetRangeColumnCount(record.range) === null
    ) {
      continue;
    }
    const aliases = [
      ...new Set(
        record.aliases.flatMap((alias) => {
          if (
            typeof alias !== 'string' ||
            alias.length > 100 ||
            /[\u0000-\u001f\u007f]/.test(alias)
          ) {
            return [];
          }
          const normalized = normalizedSheetAlias(alias);
          return normalized ? [normalized] : [];
        }),
      ),
    ];
    if (aliases.length === 0) continue;
    targets.push({
      aliases,
      spreadsheetId: record.spreadsheetId,
      range: record.range,
    });
  }
  return targets;
}

function parseConfiguredSheetTargets(
  raw: string,
): ConfiguredGoogleSheetTarget[] {
  if (!raw || Buffer.byteLength(raw, 'utf8') > 64 * 1024) return [];
  try {
    return validConfiguredSheetTargets(JSON.parse(raw));
  } catch {
    return [];
  }
}

function configuredGoogleResources(input: {
  configuredResourceIds?: string[];
  defaultSpreadsheetId?: string;
  defaultScriptId?: string;
  configuredSheetTargets?: ConfiguredGoogleSheetTarget[];
}): ConfiguredGoogleResources {
  const env = readEnvFile([
    'SKOOBI_GOOGLE_WORKSPACE_ALLOWED_RESOURCE_IDS',
    'SKOOBI_GOOGLE_WORKSPACE_DEFAULT_SCRIPT_ID',
    'SKOOBI_GOOGLE_WORKSPACE_DEFAULT_SPREADSHEET_ID',
    'SKOOBI_GOOGLE_WORKSPACE_NAMED_SHEET_TARGETS_JSON',
  ]);
  const namedSheetTargets =
    input.configuredSheetTargets === undefined
      ? parseConfiguredSheetTargets(
          process.env.SKOOBI_GOOGLE_WORKSPACE_NAMED_SHEET_TARGETS_JSON ||
            env.SKOOBI_GOOGLE_WORKSPACE_NAMED_SHEET_TARGETS_JSON ||
            '',
        )
      : validConfiguredSheetTargets(input.configuredSheetTargets);
  const allowedResourceIds =
    input.configuredResourceIds === undefined
      ? splitValidIds(
          process.env.SKOOBI_GOOGLE_WORKSPACE_ALLOWED_RESOURCE_IDS ||
            env.SKOOBI_GOOGLE_WORKSPACE_ALLOWED_RESOURCE_IDS ||
            '',
        )
      : input.configuredResourceIds.filter((entry) =>
          GOOGLE_ID_VALUE_RE.test(entry),
        );
  const configuredDefaultSpreadsheetId =
    input.defaultSpreadsheetId ??
    process.env.SKOOBI_GOOGLE_WORKSPACE_DEFAULT_SPREADSHEET_ID ??
    env.SKOOBI_GOOGLE_WORKSPACE_DEFAULT_SPREADSHEET_ID;
  const configuredDefaultScriptId =
    input.defaultScriptId ??
    process.env.SKOOBI_GOOGLE_WORKSPACE_DEFAULT_SCRIPT_ID ??
    env.SKOOBI_GOOGLE_WORKSPACE_DEFAULT_SCRIPT_ID;
  return {
    allowedResourceIds: [
      ...new Set([
        ...allowedResourceIds,
        ...namedSheetTargets.map((target) => target.spreadsheetId),
      ]),
    ],
    ...(configuredDefaultSpreadsheetId &&
    GOOGLE_ID_VALUE_RE.test(configuredDefaultSpreadsheetId)
      ? { defaultSpreadsheetId: configuredDefaultSpreadsheetId }
      : {}),
    ...(configuredDefaultScriptId &&
    GOOGLE_ID_VALUE_RE.test(configuredDefaultScriptId)
      ? { defaultScriptId: configuredDefaultScriptId }
      : {}),
    namedSheetTargets,
  };
}

function configuredCalendarIds(): string[] {
  const env = readEnvFile(['SKOOBI_GOOGLE_CALENDAR_ID']);
  const value =
    process.env.SKOOBI_GOOGLE_CALENDAR_ID ||
    env.SKOOBI_GOOGLE_CALENDAR_ID ||
    '';
  return value
    .split(/[\s,]+/)
    .map((entry) => entry.trim())
    .filter((entry) => CALENDAR_ID_VALUE_RE.test(entry));
}

function currentOwnerMessages(messages: NewMessage[]): NewMessage[] | null {
  const userMessages = messages.filter(
    (message) => !message.is_from_me && !message.is_bot_message,
  );
  if (userMessages.length === 0) return null;
  const first = userMessages[0].sender_identity;
  if (
    first?.is_owner_sender !== true ||
    !first.telegram_user_id ||
    !first.identity_id ||
    first.telegram_message_origin !== 'direct'
  ) {
    return null;
  }
  return userMessages.every(
    (message) =>
      message.sender_identity?.is_owner_sender === true &&
      message.sender_identity.telegram_user_id === first.telegram_user_id &&
      message.sender_identity.identity_id === first.identity_id &&
      message.sender_identity.telegram_message_origin === 'direct',
  )
    ? userMessages
    : null;
}

function latestAuthoritativeOwnerTimestamp(
  messages: readonly NewMessage[],
): number | null {
  const timestamps = messages
    .map((message) => Date.parse(message.timestamp))
    .filter((value) => Number.isFinite(value));
  return timestamps.length > 0 ? Math.max(...timestamps) : null;
}

function effectiveOwnerMessages(messages: NewMessage[]): NewMessage[] {
  const authorityMessages = messages.filter(
    (message) =>
      !isBenignNamedSheetAppendAcknowledgement(
        authorityBearingOwnerText(message.content),
      ),
  );
  return authorityMessages.length > 0 ? authorityMessages : messages;
}

function stableIntentId(chatJid: string, messages: NewMessage[]): string {
  const canonical = [...effectiveOwnerMessages(messages)]
    .sort(compareOwnerMessagesDeterministically)
    .map((message) => [
      message.id,
      message.chat_jid,
      message.sender_identity?.identity_id || '',
      message.sender_identity?.telegram_user_id || '',
      message.sender_identity?.telegram_message_origin || '',
      message.content,
    ]);
  return createHash('sha256')
    .update(JSON.stringify(['skoobi.google.intent.v1', chatJid, canonical]))
    .digest('hex');
}

function hasUnbalancedMarkdownCode(raw: string): boolean {
  let fence: { marker: '`' | '~'; length: number } | null = null;
  for (const line of raw.split(/\r?\n/)) {
    const fenceMatch = /^\s*(?:(?:[-+*]|\d+[.)])\s+)?(`{3,}|~{3,})/.exec(line);
    if (fenceMatch) {
      const marker = fenceMatch[1][0] as '`' | '~';
      if (!fence) {
        fence = { marker, length: fenceMatch[1].length };
      } else if (
        fence.marker === marker &&
        fenceMatch[1].length >= fence.length
      ) {
        fence = null;
      }
      continue;
    }
    if (fence) continue;
    const inlineRuns = [...line.matchAll(/`+/g)].map(
      (match) => match[0].length,
    );
    if (inlineRuns.length % 2 !== 0) return true;
    for (let index = 0; index < inlineRuns.length; index += 2) {
      if (inlineRuns[index] !== inlineRuns[index + 1]) return true;
    }
  }
  return fence !== null;
}

function unwrapOwnerVoiceEnvelope(raw: string): string | null {
  const trimmed = raw.trim();
  const opens = /^\[Voice:\s*/iu.test(trimmed);
  if (!opens) {
    // Square brackets are ordinary row data unless this is recognizably a
    // transport Voice envelope. A note such as `смена [09:00–11:00]` must not
    // be rejected as an orphan Voice closer.
    return /\[Voice:/iu.test(trimmed) ? null : raw;
  }
  if (!/\]\s*$/u.test(trimmed)) return null;
  let squareDepth = 0;
  for (let index = 0; index < trimmed.length; index += 1) {
    if (trimmed[index] === '[') squareDepth += 1;
    if (trimmed[index] !== ']') continue;
    squareDepth -= 1;
    if (
      squareDepth < 0 ||
      (squareDepth === 0 && index !== trimmed.length - 1)
    ) {
      return null;
    }
  }
  if (squareDepth !== 0) return null;
  const unwrapped = trimmed
    .replace(/^\[Voice:\s*/iu, '')
    .replace(/\]\s*$/u, '');
  if (/\[Voice:/iu.test(unwrapped)) return null;
  return unwrapped;
}

function authorityBearingOwnerText(raw: string): string {
  const voiceText = unwrapOwnerVoiceEnvelope(raw);
  if (voiceText === null) return '';
  raw = voiceText;
  // Pasted/forwarded material is data, not an owner command. In particular,
  // destructive words inside Markdown quotes or code must never mint a grant.
  if (
    hasUnbalancedMarkdownCode(raw) ||
    /^\s*(?:(?:fwd|fw|forwarded)\s*:|переслано\s*:|forwarded\s+(?:message\s+)?from|переслано\s+от|пересланное\s+сообщение)/iu.test(
      raw,
    )
  ) {
    return '';
  }
  let fenced = false;
  let htmlQuoted = false;
  const lines: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (
      /^\s*(?:.*(?:объясни|проанализируй|разбери).*(?:текст|фрагмент|код|письмо|сообщение)|.*(?:вставленн[а-яё]*|цитируем[а-яё]*)\s+(?:текст|фрагмент|код|письмо|сообщение)|.*\b(?:explain|analy[sz]e|review)\b.*\b(?:text|snippet|code|email|message)\b|.*\b(?:pasted|quoted)\s+(?:text|snippet|code|email|message)\b)\s*:\s*$/iu.test(
        line,
      )
    ) {
      break;
    }
    if (
      /^\s*(?:(?:fwd|fw|forwarded|переслано)\s*:|(?:-+\s*)?(?:forwarded\s+message|original\s+message|пересылаемое\s+сообщение)(?:\s*-+)?|forwarded\s+(?:message\s+)?from|begin\s+forwarded\s+message|переслано\s+от|пересланное\s+сообщение(?:\s+от)?|on\s+.{1,300}\s+wrote\s*:|(?:цитата|quoted\s+text)\s*:|(?:from|от)\s*:)/iu.test(
        line,
      )
    ) {
      // Everything after a forwarded/email delimiter remains quoted data,
      // even if the owner added an ordinary comment before the delimiter.
      break;
    }
    if (htmlQuoted) {
      if (/<\/(?:pre|code|blockquote)\s*>/iu.test(line)) htmlQuoted = false;
      continue;
    }
    if (/<(?:pre|code|blockquote)(?:\s|>)/iu.test(line)) {
      if (!/<\/(?:pre|code|blockquote)\s*>/iu.test(line)) htmlQuoted = true;
      continue;
    }
    if (/^\s*(?:(?:[-+*]|\d+[.)])\s+)?(?:```|~~~)/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced || /^\s*(?:(?:[-+*]|\d+[.)])\s+)?(?:>|\t| {4})/.test(line)) {
      continue;
    }
    // Inline code is also quoted data. Removing the whole span is deliberately
    // fail-closed; owners can put an actionable ID/query in ordinary text.
    lines.push(line.replace(/`+[^`\r\n]*`+/g, ' '));
  }
  return lines.join('\n');
}

interface OwnerClause {
  text: string;
  destructiveConfirmationEligible: boolean;
  /** Append authority may come only from the latest owner message in a batch. */
  namedSheetAppendEligible: boolean;
  /**
   * Only a recognized named-Sheet append may turn an explicit comment tail
   * into row data. Generic Google operations keep their complete text.
   */
  namedSheetCommentData: boolean;
  /**
   * The owner-level parser already bound this clause's append command to the
   * explicit comment that follows it. This survives typed-clause splitting.
   */
  namedSheetAppendCommandValidated?: boolean;
  /**
   * A single configured append target may be named in an earlier sentence of
   * the same direct-owner message. This never carries generic Google authority
   * and is consumed only by the narrow append-only path below.
   */
  inheritedNamedSheetTargets?: ConfiguredGoogleSheetTarget[];
}

interface QuoteRange {
  start: number;
  end: number;
}

function unicodeLetterOrNumber(value: string | undefined): boolean {
  return Boolean(value && /[\p{L}\p{N}]/u.test(value));
}

function ordinaryApostropheAt(raw: string, index: number): boolean {
  const previous = raw[index - 1];
  const next = raw[index + 1];
  if (unicodeLetterOrNumber(previous) && unicodeLetterOrNumber(next)) {
    return true;
  }
  // Preserve ordinary English plural possessives while treating a stray
  // closing quote after any other word as malformed authority text.
  return /[sS]/u.test(previous ?? '') && !unicodeLetterOrNumber(next);
}

/** Return every balanced quoted-data range, or fail the whole authority text. */
function scanQuoteRanges(
  raw: string,
): { ok: true; ranges: QuoteRange[] } | { ok: false } {
  const ranges: QuoteRange[] = [];
  const closingFor: Record<string, readonly string[]> = {
    '"': ['"'],
    "'": ["'"],
    '«': ['»'],
    '“': ['”'],
    '‘': ['’'],
    '‹': ['›'],
    // Common low-opening styles used by pasted European text.
    '„': ['“', '”'],
    '‚': ['‘', '’'],
    '「': ['」'],
    '『': ['』'],
    '《': ['》'],
    '〝': ['〞'],
    '❝': ['❞'],
  };
  const asymmetricClosers = new Set(
    Object.entries(closingFor)
      .filter(([opener]) => !closingFor[opener].includes(opener))
      .flatMap(([, closers]) => closers)
      .filter((closer) => !(closer in closingFor)),
  );
  const quoteCharacters = new Set([
    ...Object.keys(closingFor),
    ...asymmetricClosers,
  ]);
  // An escaped delimiter is transport-dependent and the operation-specific
  // query regexes do not interpret escapes. Reject it before range scanning,
  // including when it is nested inside a different outer quote pair, so an
  // exact owner query can never be truncated at `\"`/`\'`.
  let precedingBackslashes = 0;
  for (const character of raw) {
    if (quoteCharacters.has(character) && precedingBackslashes % 2 === 1) {
      return { ok: false };
    }
    precedingBackslashes = character === '\\' ? precedingBackslashes + 1 : 0;
  }
  for (let index = 0; index < raw.length; index += 1) {
    const opener = raw[index];
    if (asymmetricClosers.has(opener)) {
      // Curly apostrophes in don't/users' style prose are not delimiters.
      if (opener === '’' && ordinaryApostropheAt(raw, index)) {
        continue;
      }
      return { ok: false };
    }
    if (!(opener in closingFor)) continue;
    if (
      (opener === "'" && ordinaryApostropheAt(raw, index)) ||
      (opener === '‘' &&
        unicodeLetterOrNumber(raw[index - 1]) &&
        unicodeLetterOrNumber(raw[index + 1]))
    ) {
      // Apostrophe inside O'Brien / don't, not a quoted-data delimiter.
      continue;
    }
    const closers = closingFor[opener];
    let end = index + 1;
    for (; end < raw.length; end += 1) {
      if (!closers.includes(raw[end])) continue;
      if (
        (raw[end] === "'" || raw[end] === '’') &&
        unicodeLetterOrNumber(raw[end - 1]) &&
        unicodeLetterOrNumber(raw[end + 1])
      ) {
        continue;
      }
      break;
    }
    if (end >= raw.length) return { ok: false };
    ranges.push({ start: index, end });
    index = end;
  }
  return { ok: true, ranges };
}

function indexInsideQuote(
  index: number,
  ranges: readonly QuoteRange[],
): boolean {
  return ranges.some((range) => index > range.start && index < range.end);
}

function splitOutsideQuotes(
  raw: string,
  separator: RegExp,
  ranges: readonly QuoteRange[],
  ignoreAtOrAfter = Number.POSITIVE_INFINITY,
): string[] {
  const parts: string[] = [];
  let start = 0;
  for (const match of raw.matchAll(separator)) {
    if (indexInsideQuote(match.index, ranges)) continue;
    if (match.index >= ignoreAtOrAfter) continue;
    parts.push(raw.slice(start, match.index));
    start = match.index + match[0].length;
  }
  parts.push(raw.slice(start));
  return parts;
}

function maskQuotedContents(raw: string): string {
  const scan = scanQuoteRanges(raw);
  if (!scan.ok) return '';
  const characters = raw.split('');
  for (const range of scan.ranges) {
    for (let index = range.start + 1; index < range.end; index += 1) {
      characters[index] = ' ';
    }
  }
  return characters.join('');
}

function maskExplicitNamedSheetCommentData(raw: string): string {
  const label = EXPLICIT_NAMED_SHEET_COMMENT_LABEL.exec(
    maskQuotedContents(raw),
  );
  if (!label) return raw;
  const characters = raw.split('');
  const dataStart = label.index + label[0].length;
  for (let index = dataStart; index < characters.length; index += 1) {
    characters[index] = ' ';
  }
  return characters.join('');
}

function isBenignNamedSheetAppendAcknowledgement(text: string): boolean {
  return /^(?:спасибо(?:\s*,?\s*(?:тебе|большое|скуби(?:\s+кот)?))?|благодарю|пожалуйста|thanks|thank\s+you)\s*[.!?！？…。]*$/iu.test(
    text.trim(),
  );
}

function stripSafeUnquotedGoogleSelectorTail(
  raw: string,
  selector: RegExp,
): string {
  const match = selector.exec(raw);
  const value = match?.[1];
  if (!match || !value) return raw;
  if (
    NAMED_SHEET_REPORT_NOUN.test(value) ||
    hasReportedNamedSheetCommentCue(value)
  ) {
    return raw;
  }
  return `${raw.slice(0, match.index)} `;
}

function isFullyConsumedNamedSheetLeadingGoogleOperation(
  text: string,
  namedTargets: readonly ConfiguredGoogleSheetTarget[],
): boolean {
  const quoteScan = scanQuoteRanges(text);
  if (!quoteScan.ok) return false;
  let residual = stripDirectGoogleOperationPrefixes(maskQuotedContents(text));
  const attributionResidual = residual.replace(
    /(?:с\s+темой|subject|с\s+названием|named|title|по\s+запросу|query)\s*:?\s+[\p{L}\p{N}_.-]+\s*$/iu,
    ' ',
  );
  const demonstrativeAttribution =
    NAMED_SHEET_REPORT_DEMONSTRATIVE.exec(attributionResidual);
  if (demonstrativeAttribution) {
    const attributionTail = attributionResidual.slice(
      demonstrativeAttribution.index,
    );
    if (
      NAMED_SHEET_REPORT_NOUN.test(attributionTail) &&
      textNamesConfiguredSheetTarget(attributionTail, namedTargets)
    ) {
      return false;
    }
  }
  const operationKinds = [
    {
      kind: 'document-read',
      action: READ_ACTION,
      object: DOCUMENT_OBJECT,
      vocabulary:
        /(?<![\p{L}\p{N}_])(?:contents?|body|text|carefully|fully|completely|содержим[а-яё]*|текст[а-яё]*|полност[а-яё]*|внимательн[а-яё]*|тщательн[а-яё]*)(?![\p{L}\p{N}_])/giu,
    },
    {
      kind: 'sheet-read',
      action: READ_ACTION,
      object: SHEET_OBJECT,
      vocabulary:
        /(?<![\p{L}\p{N}_])(?:range|ranges|cell|cells|row|rows|column|columns|data|carefully|fully|completely|диапазон[а-яё]*|ячейк[а-яё]*|строк[а-яё]*|столбц[а-яё]*|данн[а-яё]*|полност[а-яё]*|внимательн[а-яё]*|тщательн[а-яё]*)(?![\p{L}\p{N}_])/giu,
    },
    {
      kind: 'script-read',
      action: READ_ACTION,
      object: SCRIPT_OBJECT,
      vocabulary:
        /(?<![\p{L}\p{N}_])(?:file|files|function|functions|project|code|файл[а-яё]*|функци[а-яё]*|проект[а-яё]*|код[а-яё]*)(?![\p{L}\p{N}_])/giu,
    },
    {
      kind: 'gmail-read',
      action: GMAIL_READ_ACTION,
      object: GMAIL_OBJECT,
      vocabulary:
        /(?<![\p{L}\p{N}_])(?:message|messages|email|emails|mail|thread|threads|inbox|unread|recent|latest|subject|containing|contains|письм[а-яё]*|сообщен[а-яё]*|цепочк[а-яё]*|входящ[а-яё]*|непрочитан[а-яё]*|последн[а-яё]*|тем[а-яё]*|содержащ[а-яё]*)(?![\p{L}\p{N}_])/giu,
    },
    {
      kind: 'drive-search',
      action: DRIVE_SEARCH_ACTION,
      object: DRIVE_OBJECT,
      vocabulary:
        /(?<![\p{L}\p{N}_])(?:file|files|folder|folders|named|called|name|content|contents|containing|contains|text|type|файл[а-яё]*|папк[а-яё]*|назван[а-яё]*|содержим[а-яё]*|содержащ[а-яё]*|текст[а-яё]*|тип[а-яё]*)(?![\p{L}\p{N}_])/giu,
    },
    {
      kind: 'calendar-read',
      action: READ_ACTION,
      object: CALENDAR_OBJECT,
      vocabulary:
        /(?<![\p{L}\p{N}_])(?:event|events|query|title|named|today|tomorrow|yesterday|next|upcoming|событи[а-яё]*|запрос[а-яё]*|назван[а-яё]*|сегодня|завтра|вчера|следующ[а-яё]*|предстоящ[а-яё]*)(?![\p{L}\p{N}_])/giu,
    },
    {
      kind: 'sheet-update',
      action: SHEET_UPDATE_ACTION,
      object: SHEET_OBJECT,
      vocabulary:
        /(?<![\p{L}\p{N}_])(?:range|ranges|cell|cells|row|rows|column|columns|data|formula|formulas|allowed|user[_ -]?entered|диапазон[а-яё]*|ячейк[а-яё]*|строк[а-яё]*|столбц[а-яё]*|данн[а-яё]*|формул[а-яё]*|разреш[а-яё]*)(?![\p{L}\p{N}_])/giu,
    },
    {
      kind: 'document-update',
      action: DOCUMENT_REPLACE_ACTION,
      object: DOCUMENT_OBJECT,
      vocabulary:
        /(?<![\p{L}\p{N}_])(?:contents?|body|text|содержим[а-яё]*|текст[а-яё]*)(?![\p{L}\p{N}_])/giu,
    },
    {
      kind: 'script-update',
      action: SCRIPT_UPDATE_ACTION,
      object: SCRIPT_OBJECT,
      vocabulary:
        /(?<![\p{L}\p{N}_])(?:file|files|function|functions|project|code|файл[а-яё]*|функци[а-яё]*|проект[а-яё]*|код[а-яё]*)(?![\p{L}\p{N}_])/giu,
    },
    {
      kind: 'sheet-create',
      action: CREATE_ACTION,
      object: SHEET_OBJECT,
      vocabulary:
        /(?<![\p{L}\p{N}_])(?:new|title|titled|named|called|content|contents|text|нов[а-яё]*|назван[а-яё]*|содержим[а-яё]*|текст[а-яё]*)(?![\p{L}\p{N}_])/giu,
    },
    {
      kind: 'document-create',
      action: CREATE_ACTION,
      object: DOCUMENT_OBJECT,
      vocabulary:
        /(?<![\p{L}\p{N}_])(?:new|title|titled|named|called|content|contents|text|body|нов[а-яё]*|назван[а-яё]*|содержим[а-яё]*|текст[а-яё]*)(?![\p{L}\p{N}_])/giu,
    },
  ].filter(({ action, object }) => hasBoundAction(residual, action, object));
  if (operationKinds.length !== 1) return false;
  const operation = operationKinds[0];
  if (operation.kind === 'gmail-read') {
    residual = stripSafeUnquotedGoogleSelectorTail(
      residual,
      /(?:с\s+темой|subject)\s*:?\s+([\p{L}\p{N}_.-]+)\s*$/iu,
    );
  } else if (operation.kind === 'calendar-read') {
    residual = stripSafeUnquotedGoogleSelectorTail(
      residual,
      /(?:с\s+названием|named|title|по\s+запросу|query)\s*:?\s+([\p{L}\p{N}_.-]+)\s*$/iu,
    );
  } else if (operation.kind === 'drive-search') {
    residual = stripSafeUnquotedGoogleSelectorTail(
      residual,
      /(?:с\s+названием|named|содержащ[а-яё]*\s+(?:текст|фразу)|containing\s+(?:the\s+)?(?:text|phrase))\s*:?\s+([\p{L}\p{N}_.-]+)\s*$/iu,
    );
  }
  residual = residual.replace(NAMED_SHEET_BENIGN_CONTAINER_RELATION, ' ');
  if (
    /^(?:sheet-read|sheet-update|gmail-read|drive-search|calendar-read)$/u.test(
      operation.kind,
    )
  ) {
    for (const target of namedTargets) {
      for (const alias of target.aliases) {
        const source = escapeRegExp(alias.trim()).replace(
          /\s+/gu,
          String.raw`\s+`,
        );
        if (!source) continue;
        residual = residual.replace(
          new RegExp(
            String.raw`(?<![\p{L}\p{N}_])(?:${source})(?![\p{L}\p{N}_])`,
            'giu',
          ),
          ' ',
        );
      }
    }
  }
  for (const source of [
    GOOGLE_ID_RE.source,
    SHEET_RANGE_RE.source,
    CALENDAR_IDENTIFIER_RE.source,
    SCRIPT_FILE_WITH_EXTENSION_RE.source,
    operation.action,
    operation.object,
    ROOT_TARGET.source,
    DEFAULT_ALIAS.source,
    POSITIVE_FORMULA_PERMISSION.source,
  ]) {
    residual = residual.replace(new RegExp(source, 'giu'), ' ');
  }
  residual = residual
    .replace(operation.vocabulary, ' ')
    .replace(
      /(?<![\p{L}\p{N}_])(?:google|the|a|an|my|this|that|these|those|in|on|at|from|to|into|of|for|with|under|inside|within|by|root|default|primary|all|only|please|kindly)(?![\p{L}\p{N}_])/giu,
      ' ',
    )
    .replace(
      /(?<![\p{L}\p{N}_])(?:гугл|в|во|из|на|по|с|со|от|до|для|у|к|ко|под|над|между|мой|мою|мо[её]м|мо[её]й|моего|самом|эт(?:от|а|о|и|ого|ой|ою|их|ому|им(?:и)?|ом|у)|т(?:от|а|о|е|ого|ой|ою|ех|ому|ем(?:и)?|ом|у)|данн(?:ый|ая|ое|ые|ого|ой|ою|ых|ому|ым(?:и)?|ом|ую)|вот|такой|таким|корн[а-яё]*|основн[а-яё]*|пожалуйста|прошу)(?![\p{L}\p{N}_])/giu,
      ' ',
    )
    .replace(/[\p{P}\p{S}\p{N}_]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  return residual.length === 0;
}

function isBenignNamedSheetAppendLeadingClause(
  text: string,
  namedTargets: readonly ConfiguredGoogleSheetTarget[],
): boolean {
  const quoteScan = scanQuoteRanges(text);
  if (!quoteScan.ok) return false;
  const semantic = maskQuotedContents(text);
  if (
    !semantic ||
    META_OR_REPORTED_COMMAND.test(semantic) ||
    META_OR_REPORTED_COMMAND_RU.test(semantic) ||
    ACTION_LED_META_PREFIX.test(semantic) ||
    DECLARATIVE_AUTHORITY_TEXT.test(semantic) ||
    hasFailClosedAuthorityNegation(semantic) ||
    hasUnsupportedAuthorityNegation(semantic) ||
    /(?:повтори|процитир[а-яё]*|перескаж[а-яё]*|перевед[а-яё]*|объясн[а-яё]*|сделай(?:те)?\s+вид|представ[а-яё]*|сыгра[а-яё]*\s+роль|цитат[а-яё]*|фраз[а-яё]*|для\s+примера|например|допустим|предположим|представим|якобы|условно|гипотетически|если\s+бы|сценари[а-яё]*|не\s+(?:выполняй[а-яё]*|исполняй[а-яё]*|следуй[а-яё]*|делай[а-яё]*))/iu.test(
      semantic,
    )
  ) {
    return false;
  }
  if (
    hasDirectGoogleOperationPrefix(semantic) &&
    firstBoundGoogleOperationPairEnd(semantic) !== null
  ) {
    return isFullyConsumedNamedSheetLeadingGoogleOperation(
      semantic,
      namedTargets,
    );
  }
  // A factual shift clause has no legitimate free-form quoted field. Reject
  // it instead of masking the quote: otherwise `worked "hypothetically"` is
  // reduced to the same authority text as a real, unqualified shift.
  if (quoteScan.ranges.length > 0) return false;
  const direct = semantic
    .trimStart()
    .replace(ASSISTANT_ADDRESS_PREFIX, '')
    .trimStart();
  const normalized = normalizedSheetAlias(direct).replace(/ё/gu, 'е');
  const aliases = namedTargets.flatMap((target) =>
    target.aliases.map((alias) =>
      normalizedSheetAlias(alias).replace(/ё/gu, 'е'),
    ),
  );
  const russianTimePoint = String.raw`\d{1,2}(?:\s+\d{2})?(?:\s+(?:час(?:а|ов)?|утра|дня|вечера|ночи)){0,2}`;
  const russianShiftDetail = String.raw`(?:\s+(?:с\s+${russianTimePoint}\s+до\s+${russianTimePoint}|\d+(?:\s+\d+)?\s+час(?:а|ов)?))?`;
  const englishTimePoint = String.raw`\d{1,2}(?:\s+\d{2})?(?:\s+(?:am|pm|o\s+clock))?`;
  const englishShiftDetail = String.raw`(?:\s+(?:from\s+${englishTimePoint}\s+to\s+${englishTimePoint}|for\s+\d+(?:\s+\d+)?\s+hours?))?`;
  const isCompleteNarrowShiftFact = aliases.some((alias) => {
    const escapedAlias = escapeRegExp(alias);
    return new RegExp(
      String.raw`^(?:(?:сегодня|вчера)\s+${escapedAlias}\s+работал(?:а|и)?${russianShiftDetail}|${escapedAlias}\s+(?:(?:сегодня|вчера)\s+работал(?:а|и)?|работал(?:а|и)?\s+(?:сегодня|вчера))${russianShiftDetail}|(?:сегодня|вчера)\s+у\s+${escapedAlias}\s+смена${russianShiftDetail}|у\s+${escapedAlias}\s+(?:сегодня|вчера)\s+смена${russianShiftDetail}|(?:today|yesterday)\s+${escapedAlias}\s+(?:worked|had\s+(?:a\s+)?shift)${englishShiftDetail}|${escapedAlias}\s+(?:(?:today|yesterday)\s+(?:worked|had\s+(?:a\s+)?shift)|worked\s+(?:today|yesterday))${englishShiftDetail})$`,
      'u',
    ).test(normalized);
  });
  return (
    isCompleteNarrowShiftFact &&
    !new RegExp(GOOGLE_OPERATION_ACTION, 'iu').test(semantic)
  );
}

function compareDecimalIdentifiers(
  left: string | undefined,
  right: string | undefined,
): number {
  const canonical = (value: string | undefined): string | null => {
    if (!value || !/^\d+$/u.test(value)) return null;
    return value.replace(/^0+(?=\d)/u, '');
  };
  const a = canonical(left);
  const b = canonical(right);
  if (a !== null && b !== null) {
    return a.length - b.length || a.localeCompare(b);
  }
  if (a !== null) return 1;
  if (b !== null) return -1;
  return (left ?? '').localeCompare(right ?? '');
}

function compareOwnerMessagesDeterministically(
  left: NewMessage,
  right: NewMessage,
): number {
  const leftTime = Date.parse(left.timestamp);
  const rightTime = Date.parse(right.timestamp);
  const timeOrder =
    Number.isFinite(leftTime) && Number.isFinite(rightTime)
      ? leftTime - rightTime
      : left.timestamp.localeCompare(right.timestamp);
  if (timeOrder !== 0) return timeOrder;
  const updateOrder = compareDecimalIdentifiers(
    left.telegram_update_id,
    right.telegram_update_id,
  );
  if (updateOrder !== 0) return updateOrder;
  const messageOrder = compareDecimalIdentifiers(left.id, right.id);
  if (messageOrder !== 0) return messageOrder;
  return (
    left.chat_jid.localeCompare(right.chat_jid) ||
    (left.sender_identity?.identity_id ?? '').localeCompare(
      right.sender_identity?.identity_id ?? '',
    ) ||
    (left.sender_identity?.telegram_user_id ?? '').localeCompare(
      right.sender_identity?.telegram_user_id ?? '',
    ) ||
    (left.sender_identity?.telegram_message_origin ?? '').localeCompare(
      right.sender_identity?.telegram_message_origin ?? '',
    ) ||
    left.content.localeCompare(right.content)
  );
}

function latestOwnerMessageIndex(messages: readonly NewMessage[]): number {
  let latestIndex = 0;
  for (let index = 1; index < messages.length; index += 1) {
    const candidate = messages[index];
    const current = messages[latestIndex];
    if (compareOwnerMessagesDeterministically(candidate, current) >= 0) {
      latestIndex = index;
    }
  }
  return latestIndex;
}

function latestAppendAuthorityMessageIndex(
  messages: readonly NewMessage[],
): number {
  let latestIndex = -1;
  for (let index = 0; index < messages.length; index += 1) {
    const authorityText = authorityBearingOwnerText(messages[index].content);
    if (isBenignNamedSheetAppendAcknowledgement(authorityText)) continue;
    if (
      latestIndex < 0 ||
      compareOwnerMessagesDeterministically(
        messages[index],
        messages[latestIndex],
      ) >= 0
    ) {
      latestIndex = index;
    }
  }
  return latestIndex >= 0 ? latestIndex : latestOwnerMessageIndex(messages);
}

function isBenignOperationBridge(raw: string): boolean {
  if (raw.length > 560) return false;
  const words = raw.toLocaleLowerCase().match(/\p{L}+/gu) ?? [];
  if (words.length === 0 || words.length > 80) return false;
  const hasProgressionMarker = words.some((word) =>
    /^(?:after|once|when|then|next|afterwards?|после|когда|затем|потом|далее)$/u.test(
      word,
    ),
  );
  if (!hasProgressionMarker) return false;
  return words.every((word) =>
    /^(?:after|once|when|then|next|afterwards?|that|you|we|i|have|has|had|are|am|is|were|was|carefully|fully|completely|thoroughly|review(?:ed|ing)?|check(?:ed|ing)?|inspect(?:ed|ing)?|look(?:ed|ing)?|finish(?:ed|ing)?|done|results?|output|files?|contents?|them|it|this|these|those|all|of|its|their|the|for|me|us|please|kindly|proceed|go|ahead|and|to|at|после|того|как|когда|затем|потом|далее|этого|ты|вы|мы|я|внимательн[а-яё]*|тщательн[а-яё]*|полност[а-яё]*|просмотр[а-яё]*|провер[а-яё]*|изуч[а-яё]*|прочит[а-яё]*|ознаком[а-яё]*|заверш[а-яё]*|закон[а-яё]*|результат[а-яё]*|вывод[а-яё]*|файл[а-яё]*|содержим[а-яё]*|контент[а-яё]*|их|это|этим|все|всего|для|меня|нас|пожалуйста|прошу|можешь|можете|перейд[а-яё]*|приступ[а-яё]*|и|к)$/u.test(
      word,
    ),
  );
}

type GoogleOperationBoundary =
  | { kind: 'split'; start: number }
  | { kind: 'none' }
  | { kind: 'unsafe' };

/** Return the exact operation start, excluding a recognized polite bridge. */
function boundGoogleOperationStart(raw: string): GoogleOperationBoundary {
  const leadingWhitespace = raw.length - raw.trimStart().length;
  const prefix = raw.slice(leadingWhitespace, leadingWhitespace + 600);
  const actions = [
    ...prefix.matchAll(new RegExp(GOOGLE_OPERATION_ACTION, 'giu')),
  ];
  const objects = [
    ...prefix.matchAll(new RegExp(GOOGLE_OPERATION_OBJECT, 'giu')),
  ];
  const candidates: Array<{ start: number; distance: number }> = [];
  for (const action of actions) {
    for (const object of objects) {
      const distance = Math.abs(action.index - object.index);
      if (distance > 160) continue;
      candidates.push({
        start: Math.min(action.index, object.index),
        distance,
      });
    }
  }
  candidates.sort((a, b) => a.distance - b.distance || a.start - b.start);
  for (const candidate of candidates) {
    if (candidate.start <= 32) {
      return { kind: 'split', start: leadingWhitespace };
    }
    if (isBenignOperationBridge(prefix.slice(0, candidate.start))) {
      return { kind: 'split', start: leadingWhitespace + candidate.start };
    }
  }
  // Candidate discovery above is intentionally bounded. If a later operation
  // exists only after that safe window, or behind an unrecognized/overlong
  // bridge, keeping one combined span would leak its type, query, root scope,
  // or destructive confirmation into the preceding operation. Drop the whole
  // authority clause instead. The bounded action/object gap keeps this scan
  // linear in the owner message length.
  if (
    new RegExp(
      String.raw`(?:(?:${GOOGLE_OPERATION_ACTION})[\s\S]{0,160}(?:${GOOGLE_OPERATION_OBJECT})|(?:${GOOGLE_OPERATION_OBJECT})[\s\S]{0,160}(?:${GOOGLE_OPERATION_ACTION}))`,
      'iu',
    ).test(raw)
  ) {
    return { kind: 'unsafe' };
  }
  return { kind: 'none' };
}

function firstBoundGoogleOperationPairEnd(raw: string): number | null {
  let earliest: { start: number; end: number } | null = null;
  for (const [actionSource, objectSource] of TYPED_GOOGLE_OPERATION_PAIRS) {
    const pair = new RegExp(
      String.raw`(?:(?:${actionSource})[\s\S]{0,160}?(?:${objectSource})|(?:${objectSource})[\s\S]{0,160}?(?:${actionSource}))`,
      'iu',
    ).exec(raw);
    if (!pair) continue;
    const candidate = { start: pair.index, end: pair.index + pair[0].length };
    if (
      !earliest ||
      candidate.start < earliest.start ||
      (candidate.start === earliest.start && candidate.end < earliest.end)
    ) {
      earliest = candidate;
    }
  }
  return earliest?.end ?? null;
}

function hasSequentialGoogleOperations(raw: string): boolean {
  const firstEnd = firstBoundGoogleOperationPairEnd(raw);
  return (
    firstEnd !== null &&
    firstBoundGoogleOperationPairEnd(raw.slice(firstEnd)) !== null
  );
}

function hasCompetingActionsBeforeFirstTypedObject(raw: string): boolean {
  const firstObject = new RegExp(GOOGLE_OPERATION_OBJECT, 'iu').exec(raw);
  if (!firstObject) return false;
  const prefix = raw.slice(0, firstObject.index);
  return (
    [...prefix.matchAll(new RegExp(GOOGLE_OPERATION_ACTION, 'giu'))].length > 1
  );
}

function looksLikeCreateSegment(raw: string): boolean {
  const prefix = raw.trimStart().slice(0, 220);
  const create = new RegExp(CREATE_ACTION, 'iu').exec(prefix);
  const object = new RegExp(
    String.raw`(?:${SHEET_OBJECT}|${DOCUMENT_OBJECT})`,
    'iu',
  ).exec(prefix);
  if (create && object && Math.abs(object.index - create.index) <= 160) {
    return true;
  }
  return Boolean(
    object &&
    object.index <= 40 &&
    /(?:\bnew\b|нов[а-яё]*)/iu.test(prefix.slice(0, object.index)),
  );
}

function startsCreateTargetContinuation(raw: string): boolean {
  const prefix = raw.trimStart().slice(0, 220);
  const object = new RegExp(
    String.raw`(?:${SHEET_OBJECT}|${DOCUMENT_OBJECT})`,
    'iu',
  ).exec(prefix);
  if (!object || object.index > 40) return false;
  const beforeObject = prefix.slice(0, object.index);
  if (/(?:\bnew\b|нов[а-яё]*)/iu.test(beforeObject)) return true;
  const afterObject = prefix.slice(object.index + object[0].length, 180);
  return new RegExp(
    String.raw`^(?:[\s,:=-]{0,12})(?:${CREATE_TITLE_LABEL}|["'«“‘‹„‚])`,
    'iu',
  ).test(afterObject);
}

function startsDriveTargetContinuation(raw: string): boolean {
  const prefix = raw.trimStart().slice(0, 260);
  const resultObject = new RegExp(
    String.raw`^(?:(?:the\s+)?(?:files?|${SHEET_OBJECT}|${DOCUMENT_OBJECT})|файл[а-яё]*)(?![\p{L}\p{N}_])`,
    'iu',
  );
  const selector =
    /(?:\bnamed\b|\bwith\s+(?:the\s+)?name\b|\bcontaining\b|с\s+названием|по\s+названию|содержащ[а-яё]*|\b(?:in|under)\s+(?:the\s+)?folder\b|(?:в|из)\s+папк[а-яё]*)/iu;
  return (
    (resultObject.test(prefix) && selector.test(prefix)) ||
    /^(?:named|with\s+(?:the\s+)?name|с\s+названием|по\s+названию)(?![\p{L}\p{N}_])/iu.test(
      prefix,
    )
  );
}

function startsSheetReadTargetContinuation(raw: string): boolean {
  const prefix = raw.trimStart().slice(0, 260);
  const nextBoundary =
    /(?:\s+(?:and\s+then|then|and|и\s+затем|и|затем|потом)\s+|\s*&\s*|\s+(?:-|–|—)\s+)/iu.exec(
      prefix,
    );
  const targetPrefix = prefix.slice(0, nextBoundary?.index ?? prefix.length);
  const object = new RegExp(SHEET_OBJECT, 'iu').exec(targetPrefix);
  const range = /(?:\brange\b|диапазон[а-яё]*)/iu.exec(targetPrefix);
  if (!object || object.index > 160 || !range) return false;
  if (object.index < range.index) return object.index <= 24;
  const betweenRangeAndObject = targetPrefix.slice(
    range.index + range[0].length,
    object.index,
  );
  return /(?:\b(?:from|in|of)\b|(?:из|в|у))\s*$/iu.test(betweenRangeAndObject);
}

function startsCalendarTargetContinuation(raw: string): boolean {
  const prefix = raw.trimStart().slice(0, 320);
  const nextBoundary =
    /(?:\s+(?:and\s+then|then|and|и\s+затем|и|затем|потом)\s+|\s*&\s*|\s+(?:-|–|—)\s+)/iu.exec(
      prefix,
    );
  const targetPrefix = prefix.slice(0, nextBoundary?.index ?? prefix.length);
  const calendarId = new RegExp(CALENDAR_IDENTIFIER_RE.source, 'iu').exec(
    targetPrefix,
  );
  return Boolean(
    calendarId &&
    calendarId.index <= 160 &&
    /(?:по\s+запросу|с\s+текстом|содержащ[а-яё]*|\bquery\b|\bsearch(?:\s+for)?\b|\bcontaining\b)/iu.test(
      targetPrefix,
    ),
  );
}

/**
 * Split only when a conjunction starts another typed Google operation. Query
 * complements such as `name "Plan" and containing text "approved"` stay in one
 * span, preserving their linked Drive semantics. A second explicitly titled
 * create object inherits the create verb from the first span.
 */
function splitOperationBoundSubclauses(
  raw: string,
  namedSheetCommentData = false,
): string[] {
  const quoteScan = scanQuoteRanges(raw);
  if (!quoteScan.ok) return [];
  const quoteMaskedRaw = maskQuotedContents(raw);
  const explicitCommentLabel = namedSheetCommentData
    ? EXPLICIT_NAMED_SHEET_COMMENT_LABEL.exec(quoteMaskedRaw)
    : null;
  const explicitCommentBoundary =
    explicitCommentLabel?.index ?? Number.POSITIVE_INFINITY;
  const semanticRaw = namedSheetCommentData
    ? maskExplicitNamedSheetCommentData(quoteMaskedRaw)
    : quoteMaskedRaw;
  const wholeDriveContext =
    new RegExp(DRIVE_SEARCH_ACTION, 'iu').test(semanticRaw) &&
    new RegExp(DRIVE_OBJECT, 'iu').test(semanticRaw);
  const wholeCalendarContext =
    new RegExp(READ_ACTION, 'iu').test(semanticRaw) &&
    new RegExp(CALENDAR_OBJECT, 'iu').test(semanticRaw);
  const conjunction =
    /(?:\s+(?:and\s+then|then|and|и\s+затем|и|затем|потом)\s+|\s*,\s*|\s*&\s*|:\s+|\s+(?:-|–|—)\s+)/giu;
  const result: string[] = [];
  let start = 0;
  let inheritedPrefix = '';
  for (const match of raw.matchAll(conjunction)) {
    if (indexInsideQuote(match.index, quoteScan.ranges)) continue;
    const boundaryStart = match.index;
    const boundaryEnd = boundaryStart + match[0].length;
    if (boundaryStart < start) continue;
    if (boundaryStart >= explicitCommentBoundary) continue;
    const prefixThroughBoundary = raw.slice(start, boundaryEnd).trimStart();
    const confirmationPrefix = POSITIVE_CONFIRMATION_PREFIX.exec(
      prefixThroughBoundary,
    );
    if (confirmationPrefix?.[0].length === prefixThroughBoundary.length) {
      // `confirm: update ...` is one destructive operation. Treating the
      // confirmation punctuation as an operation boundary would silently
      // strip the owner's resource-bound confirmation.
      continue;
    }
    if (!stripDirectGoogleOperationPrefixes(prefixThroughBoundary)) {
      // A comma inside an accepted owner/address/polite prefix belongs to the
      // operation that follows it; it is not an authority-clause boundary.
      continue;
    }
    const currentRaw = raw.slice(start, boundaryStart).trim();
    const current = `${inheritedPrefix}${currentRaw}`;
    const suffix = raw.slice(boundaryEnd);
    const semanticCurrent = namedSheetCommentData
      ? maskExplicitNamedSheetCommentData(maskQuotedContents(current))
      : maskQuotedContents(current);
    const semanticSuffix = namedSheetCommentData
      ? maskExplicitNamedSheetCommentData(maskQuotedContents(suffix))
      : maskQuotedContents(suffix);
    if (
      hasDirectGoogleOperationPrefix(semanticCurrent) &&
      new RegExp(
        String.raw`${NAMED_SHEET_BENIGN_RELATION_ITEM}\s*[,—–-]?\s*$`,
        'iu',
      ).test(semanticCurrent) &&
      new RegExp(
        String.raw`^\s*(?:(?:and|и)\s+)?${NAMED_SHEET_BENIGN_RELATION_ITEM}`,
        'iu',
      ).test(semanticSuffix)
    ) {
      // `from my inbox and by subject` is one bounded selector sequence,
      // not two Google operations. Keep it intact so the terminal relation
      // parser can validate the whole suffix and reject any trailing actor.
      continue;
    }
    const operationBoundary = boundGoogleOperationStart(semanticSuffix);
    if (operationBoundary.kind === 'unsafe') return [];
    const explicitOperationStart =
      operationBoundary.kind === 'split' ? operationBoundary.start : null;
    const createContinuation: boolean =
      explicitOperationStart === null &&
      looksLikeCreateSegment(semanticCurrent) &&
      startsCreateTargetContinuation(semanticSuffix);
    const currentDriveContext = hasBoundAction(
      semanticCurrent,
      DRIVE_SEARCH_ACTION,
      DRIVE_OBJECT,
    );
    const driveContinuation =
      explicitOperationStart === null &&
      !createContinuation &&
      (currentDriveContext ||
        (wholeDriveContext &&
          new RegExp(DRIVE_SEARCH_ACTION, 'iu').test(semanticCurrent))) &&
      startsDriveTargetContinuation(semanticSuffix);
    const sheetReadContinuation =
      explicitOperationStart === null &&
      !createContinuation &&
      !driveContinuation &&
      hasBoundAction(semanticCurrent, READ_ACTION, SHEET_OBJECT) &&
      startsSheetReadTargetContinuation(semanticSuffix);
    const currentCalendarContext = hasBoundAction(
      semanticCurrent,
      READ_ACTION,
      CALENDAR_OBJECT,
    );
    const calendarContinuation =
      explicitOperationStart === null &&
      !createContinuation &&
      !driveContinuation &&
      !sheetReadContinuation &&
      (currentCalendarContext ||
        (wholeCalendarContext &&
          new RegExp(READ_ACTION, 'iu').test(semanticCurrent))) &&
      extractCalendarQueries(current).length > 0 &&
      startsCalendarTargetContinuation(semanticSuffix);
    if (
      explicitOperationStart === null &&
      !createContinuation &&
      !driveContinuation &&
      !sheetReadContinuation &&
      !calendarContinuation
    ) {
      continue;
    }
    const contextualCurrent =
      driveContinuation && !currentDriveContext
        ? `find in Google Drive ${current}`
        : calendarContinuation && !currentCalendarContext
          ? `show Google Calendar ${current}`
          : current;
    if (contextualCurrent) result.push(contextualCurrent);
    if (explicitOperationStart !== null) {
      start = boundaryEnd + explicitOperationStart;
      inheritedPrefix = '';
    } else {
      start = boundaryEnd;
      inheritedPrefix = createContinuation
        ? 'create '
        : driveContinuation
          ? 'find in Google Drive '
          : calendarContinuation
            ? 'show Google Calendar '
            : 'read ';
    }
  }
  const tailRaw = raw.slice(start).trim();
  const tail = `${inheritedPrefix}${tailRaw}`;
  if (tail) result.push(tail);
  // Any remaining span with two complete, sequential action+object pairs was
  // joined by grammar we do not explicitly understand. Drop the whole clause:
  // otherwise the later pair's ID/query can authorize the earlier destructive
  // action. This runs after intentional continuations have been split.
  if (
    result.some((subclause) =>
      [
        namedSheetCommentData
          ? maskExplicitNamedSheetCommentData(maskQuotedContents(subclause))
          : maskQuotedContents(subclause),
      ].some(
        (semanticSubclause) =>
          hasSequentialGoogleOperations(semanticSubclause) ||
          hasCompetingActionsBeforeFirstTypedObject(semanticSubclause),
      ),
    )
  ) {
    return [];
  }
  return result;
}

function normalizeStandaloneNamedSheetControlClause(raw: string): string {
  let normalized = raw
    .trim()
    .replace(/^[.!?！？…。;,—–-]+\s*/u, '')
    .replace(/^(?:(?:[-+*•]|\d+[.)]|\[[ xX]\])\s*)+/u, '')
    .replace(/[.!?！？…。]+$/u, '')
    .trim();
  for (let count = 0; count < 4; count += 1) {
    const stripped = normalized
      .replace(ASSISTANT_ADDRESS_PREFIX, '')
      .replace(
        /^(?:(?:(?:а|и|но|and|but)\s+)?(?:затем|потом|далее|теперь|также|ещ[её]|после\s+этого|так\s+что|тогда(?:\s+и)?|заодно|плюс|дополнительно|then|next|also|after\s+that|additionally)\s+|(?:а|и|но|and|but|ну|ладно|хорошо|вс[её]-таки|please|ой)\s+|(?:нет|ой)\s*,\s*|команда\s*\d+\s*:\s*)/iu,
        '',
      )
      .trimStart();
    if (stripped === normalized) break;
    normalized = stripped;
  }
  for (let count = 0; count < 3; count += 1) {
    const stripped = normalized
      .replace(
        /(?:\s*,?\s*(?:пожалуйста|please|спасибо(?:\s*,?\s*(?:тебе|большое|скуби(?:\s+кот)?))?|благодарю|thanks|thank\s+you|скуби(?:\s+кот)?))\s*$/iu,
        '',
      )
      .trimEnd();
    if (stripped === normalized) break;
    normalized = stripped;
  }
  return normalized.replace(/[.!?！？…。]+$/u, '').trim();
}

function isStandaloneNamedSheetAppendBlocker(raw: string): boolean {
  const normalized = normalizeStandaloneNamedSheetControlClause(raw);
  if (!normalized || isBenignNamedSheetAppendAcknowledgement(normalized)) {
    return false;
  }
  if (
    /^(?:(?:стоп|отмена(?:\s+(?:записи|добавления|операции))?|отмени(?:те)?(?:\s+(?:это|запись|добавление|операцию))?|отбой|отставить|забудь(?:те)?|оставь(?:те)?(?:\s+пока)?|подожди(?:те)?|погоди(?:те)?)|(?:(?:ничего\s+)?не\s+(?:записывай(?:те)?|вноси(?:те)?|добавляй(?:те)?|заноси(?:те)?|вписывай(?:те)?|делай(?:те)?)(?:\s+(?:ничего|пока|это|этого|запись|строку|данные))?)|(?:пока\s+не\s+(?:записывай(?:те)?|вноси(?:те)?|добавляй(?:те)?|заноси(?:те)?|вписывай(?:те)?|делай(?:те)?))|(?:(?:я\s+)?передумал[а-яё]*|не\s+сейчас|не\s+(?:надо|нужно)(?:\s+(?:этого\s+делать|записывать|добавлять|вносить|заносить|вписывать|делать\s+запись))?|(?:я\s+)?не\s+хочу|(?:хотя|но|а)\s+нет|нет)|(?:это\s+)?(?:понарошку|просто\s+пример|пример|цитата|не\s+команда|тест(?:овый|овая|овое)?\s+сценарий|теоретически|условно|якобы|гипотетически)|сделай(?:те)?\s+вид|не\s+выполняй(?:те)?|scratch\s+that|disregard\s+that|never\s+mind|cancel(?:led|ed)?(?:\s+(?:it|this|that|the\s+(?:append|write|entry)|operation))?|(?:(?:do\s+not|don['’]?t)\s+(?:add|append|write|record)(?:\s+(?:it|this|that|anything|the\s+(?:entry|row)))?))$/iu.test(
      normalized,
    )
  ) {
    return true;
  }
  if (hasReportedNamedSheetCommentCue(normalized)) return false;
  return /^(?:[\p{L}'’-]+(?:\s*,\s*|\s+)){0,4}(?:(?:не\s+(?:записывай(?:те)?|вноси(?:те)?|добавляй(?:те)?|заноси(?:те)?|вписывай(?:те)?|делай(?:те)?)(?:\s+(?:ничего|пока|это|этого|запись|строку|данные))?)|(?:(?:do\s+not|don['’]?t)\s+(?:add|append|write|record)(?:\s+(?:it|this|that|anything|the\s+(?:entry|row)))?))$/iu.test(
    normalized,
  );
}

function hasReportedNamedSheetCommentCue(raw: string): boolean {
  const demonstrative = NAMED_SHEET_REPORT_DEMONSTRATIVE.exec(raw);
  const demonstrativeTail = demonstrative ? raw.slice(demonstrative.index) : '';
  const hasAttributedSource =
    Boolean(demonstrativeTail) &&
    NAMED_SHEET_REPORT_NOUN.test(demonstrativeTail) &&
    NAMED_SHEET_REPORT_SOURCE_RELATION.test(demonstrativeTail);
  return (
    /(?:по\s+словам|according\s+to|(?<![\p{L}\p{N}_])(?:просил[а-яё]*|попросил[а-яё]*|просьб[а-яё]*|сказал[а-яё]*|сообщил[а-яё]*|велел[а-яё]*|написал[а-яё]*|напоминан[а-яё]*|цитат[а-яё]*|said|asked|told|ordered|wrote|request|reminder)(?![\p{L}\p{N}_]))/iu.test(
      raw,
    ) ||
    /(?:^|[\s,;:—–-])(?!(?:я|i)(?![\p{L}\p{N}_]))(?:[\p{L}][\p{L}\p{N}_.-]*\s+){1,4}(?:просит|говорит|требует|хочет|рекомендует|советует|says|asks|requests|wants|recommends|advises)(?![\p{L}\p{N}_])/iu.test(
      raw,
    ) ||
    hasAttributedSource ||
    /(?:^|[\s,;:—–-])(?:эт(?:от|а|о|и|ого|ой|ою|их|ому|им(?:и)?|ом|у)|т(?:от|а|о|е|ого|ой|ою|ех|ому|ем(?:и)?|ом|у)|данн(?:ый|ая|ое|ые|ого|ой|ою|ых|ому|ым(?:и)?|ом|ую)|вот|(?:this|that|these|those)(?:\s+(?:is|was))?)\s+[\s\S]*?(?:просьб[а-яё]*|запрос[а-яё]*|сообщени[а-яё]*|письм[а-яё]*|инструкци[а-яё]*|команд[а-яё]*|напоминани[а-яё]*|requests?|messages?|emails?|instructions?|commands?|reminders?)\s*:\s*$/iu.test(
      raw,
    ) ||
    /(?:^|[\s,;:—–-])(?:просьб[а-яё]*|запрос[а-яё]*|сообщени[а-яё]*|письм[а-яё]*|инструкци[а-яё]*|команд[а-яё]*|напоминани[а-яё]*|requests?|messages?|emails?|instructions?|commands?|reminders?)\s+(?:(?:от|из|from|of|by)\s+[\p{L}][\p{L}\p{N}_.-]*(?:\s+[\p{L}][\p{L}\p{N}_.-]*){0,3}|\p{Lu}[\p{L}\p{N}_.-]*(?:\s+\p{Lu}[\p{L}\p{N}_.-]*){0,3})\s*:/u.test(
      raw,
    )
  );
}

function isCleanNamedSheetConnectorPrefix(
  raw: string,
  namedTargets: readonly ConfiguredGoogleSheetTarget[],
): boolean {
  const prefix = raw.trimEnd();
  if (!prefix.trim()) return true;
  if (hasReportedNamedSheetCommentCue(prefix)) return false;
  return isBenignNamedSheetAppendLeadingClause(prefix, namedTargets);
}

function splitNamedSheetControlSegments(raw: string): string[] {
  const hardSegments = raw.split(
    /\r?\n|;+|[!?！？]+|[.…。](?=\s|$)|\s+[—–-]\s+/gu,
  );
  return hardSegments.flatMap((segment) => {
    const result: string[] = [];
    let start = 0;
    for (const comma of segment.matchAll(/,/gu)) {
      const suffix = segment.slice(comma.index + comma[0].length);
      if (
        hasReportedNamedSheetCommentCue(segment.slice(start, comma.index)) ||
        !/^\s*(?:(?:(?:а|и|но|and|but)\s+)?(?:затем|потом|далее|теперь|также|ещ[её]|после\s+этого|так\s+что|тогда(?:\s+и)?|заодно|плюс|дополнительно|then|next|also|after\s+that|additionally)\s+|(?:а|и|но|and|but|please)\s+)/iu.test(
          suffix,
        )
      ) {
        continue;
      }
      result.push(segment.slice(start, comma.index));
      start = comma.index + comma[0].length;
    }
    result.push(segment.slice(start));
    return result;
  });
}

function hasPostCommentCommaBlocker(
  raw: string,
  explicitCommentLabel: RegExpExecArray | null,
): boolean {
  if (!explicitCommentLabel) return false;
  const dataStart = explicitCommentLabel.index + explicitCommentLabel[0].length;
  const commentTail = maskQuotedContents(raw.slice(dataStart));
  for (const comma of commentTail.matchAll(/,/gu)) {
    const prefix = commentTail.slice(0, comma.index);
    const boundaries = [
      ...prefix.matchAll(/\r?\n|;+|[!?！？]+|[.…。](?=\s|$)|\s+[—–-]\s+/gu),
    ];
    const lastBoundary = boundaries.at(-1);
    const localContext = prefix.slice(
      lastBoundary ? lastBoundary.index + lastBoundary[0].length : 0,
    );
    if (hasReportedNamedSheetCommentCue(localContext)) {
      continue;
    }
    const suffix = commentTail.slice(comma.index + comma[0].length).trim();
    if (isStandaloneNamedSheetAppendBlocker(suffix)) return true;
  }
  return false;
}

function standalonePostCommentClauses(
  raw: string,
  explicitCommentLabel: RegExpExecArray | null,
): string[] {
  if (!explicitCommentLabel) return [];
  const dataStart = explicitCommentLabel.index + explicitCommentLabel[0].length;
  const commentTail = maskQuotedContents(raw.slice(dataStart));
  if (!commentTail) return [];
  // The first span is the labeled row comment itself. Only exact standalone
  // control clauses after an explicit sentence/list boundary can revoke or
  // conflict with the append.
  return splitNamedSheetControlSegments(commentTail)
    .slice(1)
    .map((clause) => clause.trim())
    .filter(Boolean);
}

function hasStandaloneDirectSheetAppendShape(raw: string): boolean {
  let direct = normalizeStandaloneNamedSheetControlClause(raw);
  const politePrefix =
    /^(?:(?:please|kindly)\s+|(?:can|could|would|will)\s+you\s+|пожалуйста\s*[,\-:]?\s*|(?:можешь|можете)\s+)/iu;
  for (let count = 0; count < 2; count += 1) {
    const stripped = direct.replace(politePrefix, '');
    if (stripped === direct) break;
    direct = stripped.trimStart();
  }
  const actionCount = [
    ...direct.matchAll(new RegExp(DIRECT_SHEET_APPEND_INTENT_ACTION, 'giu')),
  ].length;
  const objectCount = [
    ...direct.matchAll(new RegExp(DIRECT_NAMED_SHEET_OBJECT, 'giu')),
  ].length;
  if (actionCount === 0 || objectCount === 0) return false;
  if (hasDirectGoogleOperationPrefix(direct)) return true;
  if (
    /(?<![\p{L}\p{N}_])(?:добавь(?:те)?|добавляй(?:те)?|запиши(?:те)?|записывай(?:те)?|впиши(?:те)?|вписывай(?:те)?|внеси(?:те)?|вноси(?:те)?|занеси(?:те)?|заноси(?:те)?|\badd\b|\bwrite\b|\bappend\b)(?![\p{L}\p{N}_])/iu.test(
      direct,
    )
  ) {
    return true;
  }
  return new RegExp(
    String.raw`^(?:(?:ей|ему|им|туда)\s+(?:в|во|на|\bto\b|\binto\b)\s+${DIRECT_NAMED_SHEET_OBJECT}|(?:в|во|на|\bto\b|\binto\b)\s+${DIRECT_NAMED_SHEET_OBJECT})[\s\S]{0,140}${DIRECT_SHEET_APPEND_INTENT_ACTION}`,
    'iu',
  ).test(direct);
}

function namedSheetCommandImmediatelyBeforeComment(
  text: string,
  commentBoundary: number,
  configuredTargets: readonly ConfiguredGoogleSheetTarget[],
): {
  append: boolean;
  completion: boolean;
  targets: ConfiguredGoogleSheetTarget[];
  split?: { leadingEnd: number; commandStart: number };
} {
  const prefix = text.slice(0, commentBoundary);
  const quoteScan = scanQuoteRanges(prefix);
  if (!quoteScan.ok) {
    return { append: false, completion: false, targets: [] };
  }
  const clauses = splitOutsideQuotes(
    prefix,
    /\r?\n|;+|[?？]+|[!！]+(?=\s|$)|[.…。](?=\s|$)/gu,
    quoteScan.ranges,
  )
    .flatMap((clause) => splitOperationBoundSubclauses(clause))
    .map((clause) => clause.trim())
    .filter(Boolean);
  const immediate = clauses.at(-1);
  if (!immediate) {
    return { append: false, completion: false, targets: [] };
  }
  const immediateStart = prefix.lastIndexOf(immediate);
  const discourseMatches = [
    ...immediate.matchAll(
      /(?:^|[\s,;—–-])(?:(?:(?:а|и|но|and|but)\s+)?(?:затем|потом|далее|теперь|также|ещ[её]|после\s+этого|так\s+что|заодно|плюс|дополнительно|then|next|also|after\s+that|additionally|please)|(?:а|и|но|and|but))\s+/giu,
    ),
  ].filter((match) =>
    isCleanNamedSheetConnectorPrefix(
      immediate.slice(0, match.index),
      configuredTargets,
    ),
  );
  const contextualTargets = namedSheetTargetsForClause(
    prefix,
    configuredTargets,
  );
  const candidates = [
    { raw: immediate },
    ...discourseMatches.map((match) => ({
      raw: immediate.slice(match.index + match[0].length),
      ...(immediateStart >= 0
        ? {
            split: {
              leadingEnd: immediateStart + match.index,
              commandStart: immediateStart + match.index + match[0].length,
            },
          }
        : {}),
    })),
  ]
    .map((candidate) => ({
      ...candidate,
      text: normalizeStandaloneNamedSheetControlClause(candidate.raw),
    }))
    .filter((candidate) => Boolean(candidate.text));
  const evaluated = candidates.map((candidate) => {
    const localTargets = namedSheetTargetsForClause(
      candidate.text,
      configuredTargets,
    );
    const targets =
      localTargets.length === 1 ? localTargets : contextualTargets;
    return {
      append: hasDirectNamedSheetAppendCommand(candidate.text, targets, true),
      completion: hasDirectNamedSheetAccountingCompletionCommand(
        candidate.text,
        targets,
      ),
      targets,
      split: candidate.split,
    };
  });
  const successful = evaluated.filter(
    (candidate) =>
      (candidate.append || candidate.completion) &&
      candidate.targets.length === 1,
  );
  const targetKeys = new Map(
    successful.map((candidate) => {
      const target = candidate.targets[0];
      return [`${target.spreadsheetId}\0${target.range}`, target];
    }),
  );
  if (targetKeys.size !== 1) {
    return { append: false, completion: false, targets: [] };
  }
  return {
    append: successful.some((candidate) => candidate.append),
    completion: successful.some((candidate) => candidate.completion),
    targets: [...targetKeys.values()],
    split: successful
      .flatMap((candidate) => (candidate.split ? [candidate.split] : []))
      .sort((left, right) => right.commandStart - left.commandStart)[0],
  };
}

function hasNamedSheetAppendShapeBeforeComment(
  text: string,
  commentBoundary: number,
  namedTargets: readonly ConfiguredGoogleSheetTarget[],
): boolean {
  if (namedTargets.length !== 1) return false;
  const prefix = text.slice(0, commentBoundary);
  const quoteScan = scanQuoteRanges(prefix);
  if (!quoteScan.ok) return false;
  const immediate = splitOutsideQuotes(
    prefix,
    /\r?\n|;+|[?？]+|[!！]+(?=\s|$)|[.…。](?=\s|$)/gu,
    quoteScan.ranges,
  )
    .map((clause) => clause.trim())
    .filter(Boolean)
    .at(-1);
  if (!immediate) return false;
  const semantic = maskQuotedContents(immediate);
  return (
    new RegExp(DIRECT_SHEET_APPEND_INTENT_ACTION, 'iu').test(semantic) &&
    new RegExp(DIRECT_NAMED_SHEET_OBJECT, 'iu').test(semantic) &&
    textNamesConfiguredSheetTarget(semantic, namedTargets)
  );
}

function hasMultipleDirectSheetAppendIntents(
  messages: readonly NewMessage[],
  configuredSheetTargets: readonly ConfiguredGoogleSheetTarget[],
): boolean {
  let intentCount = 0;
  for (const message of messages) {
    const authorityText = authorityBearingOwnerText(message.content);
    const semanticWithCommentData = maskQuotedContents(authorityText);
    let insideExplicitComment = false;
    for (const segment of splitNamedSheetControlSegments(
      semanticWithCommentData,
    )) {
      const explicitCommentLabel =
        EXPLICIT_NAMED_SHEET_COMMENT_LABEL.exec(segment);
      const operationalSegment = maskExplicitNamedSheetCommentData(segment);
      const segmentTargets = namedSheetTargetsForClause(
        operationalSegment,
        configuredSheetTargets,
      );
      const exactDirectIntent =
        hasDirectNamedSheetAccountingCompletionCommand(
          segment,
          segmentTargets,
        ) || hasDirectNamedSheetAppendCommand(segment, segmentTargets);
      const standaloneDirectIntent =
        hasStandaloneDirectSheetAppendShape(segment);
      const standaloneCompletionIntent =
        /^сделай(?:те)?\s+вс[её]\s*,?\s*чтобы(?=[\s\S]{0,80}(?:уч[её]т[а-яё]*|смен[а-яё]*))(?=[\s\S]{0,160}(?:сегодня|сегодняшн[а-яё]*))/iu.test(
          normalizeStandaloneNamedSheetControlClause(segment),
        );
      if (exactDirectIntent) {
        intentCount += 1;
      } else if (
        !insideExplicitComment ||
        standaloneDirectIntent ||
        standaloneCompletionIntent
      ) {
        // Preserve fail-closed handling for two direct intents joined inside
        // one sentence. Comment data is excluded from this broad count; only
        // an exact standalone append command inside a comment tail counts.
        const directActionCount = [
          ...operationalSegment.matchAll(
            new RegExp(DIRECT_SHEET_APPEND_INTENT_ACTION, 'giu'),
          ),
        ].length;
        const directObjectCount = [
          ...operationalSegment.matchAll(
            new RegExp(DIRECT_NAMED_SHEET_OBJECT, 'giu'),
          ),
        ].length;
        intentCount += Math.min(directActionCount, directObjectCount);
        const completionCount = [
          ...operationalSegment.matchAll(
            /(?<![\p{L}\p{N}_])сделай(?:те)?\s+вс[её]\s*,?\s*чтобы(?=[\s\S]{0,80}(?:уч[её]т[а-яё]*|смен[а-яё]*))(?=[\s\S]{0,160}(?:сегодня|сегодняшн[а-яё]*))/giu,
          ),
        ].length;
        intentCount += completionCount;
      }
      insideExplicitComment ||= explicitCommentLabel !== null;
      if (intentCount > 1) return true;
    }
  }
  return false;
}

function ownerClauses(
  messages: NewMessage[],
  configuredSheetTargets: readonly ConfiguredGoogleSheetTarget[],
  disableNamedSheetAppend = false,
): OwnerClause[] {
  const latestMessageIndex = latestAppendAuthorityMessageIndex(messages);
  return messages.flatMap((message, messageIndex) => {
    const authorityText = authorityBearingOwnerText(message.content);
    const semanticAuthorityTextWithCommentData =
      maskQuotedContents(authorityText);
    const commentMaskedSemanticAuthorityText =
      maskExplicitNamedSheetCommentData(semanticAuthorityTextWithCommentData);
    const targetSelectionText = commentMaskedSemanticAuthorityText;
    const unwrappedOwnerText = unwrapOwnerVoiceEnvelope(message.content);
    const originalAuthorityText = (unwrappedOwnerText ?? '')
      .replace(/\r\n?/gu, '\n')
      .trim();
    const authorityTextOmittedQuotedData =
      unwrappedOwnerText === null ||
      authorityText.trim() !== originalAuthorityText;
    const messageNamedSheetTargets = namedSheetTargetsForClause(
      targetSelectionText,
      configuredSheetTargets,
    );
    const explicitCommentLabel = EXPLICIT_NAMED_SHEET_COMMENT_LABEL.exec(
      semanticAuthorityTextWithCommentData,
    );
    const commandBeforeComment =
      explicitCommentLabel && !authorityTextOmittedQuotedData
        ? namedSheetCommandImmediatelyBeforeComment(
            semanticAuthorityTextWithCommentData,
            explicitCommentLabel.index,
            configuredSheetTargets,
          )
        : { append: false, completion: false, targets: [] };
    const directNamedSheetTargets =
      commandBeforeComment.targets.length === 1
        ? commandBeforeComment.targets
        : messageNamedSheetTargets;
    const appendShapeBeforeComment =
      explicitCommentLabel !== null &&
      !authorityTextOmittedQuotedData &&
      hasNamedSheetAppendShapeBeforeComment(
        semanticAuthorityTextWithCommentData,
        explicitCommentLabel.index,
        directNamedSheetTargets,
      );
    const explicitCommentPayloadAllowed =
      explicitCommentLabel !== null &&
      /^\s*\S[\s\S]{0,500}$/u.test(
        semanticAuthorityTextWithCommentData.slice(
          explicitCommentLabel.index + explicitCommentLabel[0].length,
        ),
      );
    const namedSheetAccountingCompletionGrammar =
      !authorityTextOmittedQuotedData &&
      (explicitCommentLabel
        ? commandBeforeComment.completion && explicitCommentPayloadAllowed
        : hasDirectNamedSheetAccountingCompletionCommand(
            semanticAuthorityTextWithCommentData,
            directNamedSheetTargets,
          ));
    const namedSheetAppendGrammar =
      !authorityTextOmittedQuotedData &&
      (explicitCommentLabel
        ? commandBeforeComment.append && explicitCommentPayloadAllowed
        : hasDirectNamedSheetAppendCommand(
            semanticAuthorityTextWithCommentData,
            directNamedSheetTargets,
          ));
    const namedSheetCommentData =
      explicitCommentLabel !== null &&
      !authorityTextOmittedQuotedData &&
      (commandBeforeComment.completion ||
        commandBeforeComment.append ||
        appendShapeBeforeComment);
    const semanticAuthorityText = namedSheetCommentData
      ? commentMaskedSemanticAuthorityText
      : semanticAuthorityTextWithCommentData;
    const isLatestOwnerMessage = messageIndex === latestMessageIndex;
    const namedSheetAppendCancelled =
      TRAILING_NAMED_SHEET_APPEND_CANCELLATION.test(
        semanticAuthorityText.trimEnd(),
      ) ||
      hasPostCommentCommaBlocker(
        semanticAuthorityTextWithCommentData,
        explicitCommentLabel,
      ) ||
      standalonePostCommentClauses(
        semanticAuthorityTextWithCommentData,
        explicitCommentLabel,
      ).some(isStandaloneNamedSheetAppendBlocker);
    const directNamedSheetAccountingCompletion =
      isLatestOwnerMessage &&
      !disableNamedSheetAppend &&
      !namedSheetAppendCancelled &&
      namedSheetAccountingCompletionGrammar;
    const directNamedSheetAppend =
      isLatestOwnerMessage &&
      !disableNamedSheetAppend &&
      !namedSheetAppendCancelled &&
      namedSheetAppendGrammar;
    if (
      META_OR_REPORTED_COMMAND.test(semanticAuthorityText) ||
      META_OR_REPORTED_COMMAND_RU.test(semanticAuthorityText) ||
      TRAILING_REPORTED_ATTRIBUTION.test(semanticAuthorityText) ||
      ACTION_LED_META_PREFIX.test(semanticAuthorityText) ||
      DECLARATIVE_AUTHORITY_TEXT.test(semanticAuthorityText) ||
      NEGATIVE_ROOT_TARGET.test(semanticAuthorityText) ||
      NEGATIVE_ALL_FILES_DRIVE.test(semanticAuthorityText) ||
      NEGATIVE_DEFAULT_ALIAS.test(semanticAuthorityText) ||
      hasFailClosedAuthorityNegation(semanticAuthorityText) ||
      hasUnsupportedTargetAction(semanticAuthorityText, true) ||
      (!hasDirectGoogleOperationPrefix(semanticAuthorityText) &&
        !directNamedSheetAppend)
    ) {
      return [];
    }
    const quoteScan = scanQuoteRanges(authorityText);
    if (!quoteScan.ok) return [];
    if (directNamedSheetAccountingCompletion) {
      // A colloquial completion request can put a harmless connection-status
      // preamble before the accounting command. The generic typed-operation
      // splitter correctly rejects that unusual object-before-action grammar.
      // Once the narrow direct-owner/one-target checks above pass, reduce it to
      // the exact append-only operation the policy understands.
      return [
        {
          text: `добавь ${directNamedSheetTargets[0].aliases[0]} в таблицу`,
          destructiveConfirmationEligible: false,
          namedSheetAppendEligible: true,
          namedSheetCommentData: false,
          namedSheetAppendCommandValidated: false,
          inheritedNamedSheetTargets: directNamedSheetTargets,
        },
      ];
    }
    const ownerClauseSeparator =
      /\r?\n|;+|[?？]+|[!！]+(?=\s|$)|[.…。](?=\s|$)/gu;
    const rawClauses =
      commandBeforeComment.split &&
      namedSheetCommentData &&
      (directNamedSheetAppend || directNamedSheetAccountingCompletion)
        ? [
            ...splitOutsideQuotes(
              authorityText.slice(0, commandBeforeComment.split.leadingEnd),
              ownerClauseSeparator,
              quoteScan.ranges,
            ),
            authorityText.slice(commandBeforeComment.split.commandStart),
          ]
        : splitOutsideQuotes(
            authorityText,
            ownerClauseSeparator,
            quoteScan.ranges,
            namedSheetCommentData ? explicitCommentLabel?.index : undefined,
          );
    const clauses = rawClauses
      .map((clause) => clause.replace(/\s+/g, ' ').trim())
      .filter(Boolean);
    const startsWithConfirmation = POSITIVE_CONFIRMATION_PREFIX.test(
      authorityText.trimStart(),
    );
    const boundClauses = clauses.flatMap((text, index) =>
      splitOperationBoundSubclauses(text, namedSheetCommentData).map(
        (subclause, subclauseIndex) => ({
          text: subclause,
          destructiveConfirmationEligible:
            startsWithConfirmation && index === 0 && subclauseIndex === 0,
        }),
      ),
    );
    let appendClauseIndex = boundClauses.length - 1;
    while (
      appendClauseIndex >= 0 &&
      isBenignNamedSheetAppendAcknowledgement(
        boundClauses[appendClauseIndex].text,
      )
    ) {
      appendClauseIndex -= 1;
    }
    const appendLeadingContextSafe = boundClauses
      .slice(0, appendClauseIndex)
      .every((clause) =>
        isBenignNamedSheetAppendLeadingClause(
          clause.text,
          configuredSheetTargets,
        ),
      );
    return boundClauses.map((clause, index) => ({
      ...clause,
      namedSheetAppendEligible:
        isLatestOwnerMessage &&
        !disableNamedSheetAppend &&
        !authorityTextOmittedQuotedData &&
        !namedSheetAppendCancelled &&
        index === appendClauseIndex &&
        appendLeadingContextSafe,
      namedSheetCommentData,
      namedSheetAppendCommandValidated:
        directNamedSheetAppend &&
        namedSheetCommentData &&
        EXPLICIT_NAMED_SHEET_COMMENT_LABEL.test(
          maskQuotedContents(clause.text),
        ),
      ...(directNamedSheetAppend
        ? { inheritedNamedSheetTargets: directNamedSheetTargets }
        : {}),
    }));
  });
}

function hasNegatedAction(text: string, actionSource: string): boolean {
  return new RegExp(
    String.raw`(?:^|[\s,:-])(?:не|not|do\s+not|don['’]?t)\s+(?:[^\s,:;.!?]+\s+){0,2}(?:${actionSource})`,
    'iu',
  ).test(text);
}

function hasNegatedObject(text: string, objectSource: string): boolean {
  return new RegExp(
    String.raw`(?:${NEGATIVE_OBJECT_LEAD})\s+(?:the\s+)?(?:${objectSource})`,
    'iu',
  ).test(text);
}

function hasUnsupportedAuthorityNegation(text: string): boolean {
  const recognized = text
    .replace(NEGATIVE_FORMULA_PERMISSION, ' ')
    .replace(NEGATIVE_ALL_FILES_DRIVE, ' ')
    .replace(NEGATIVE_ROOT_TARGET, ' ')
    .replace(NEGATIVE_DEFAULT_ALIAS, ' ')
    .replace(NEGATIVE_NEW_OBJECT, ' ')
    .replace(NEGATIVE_CONFIRMATION, ' ');
  return GENERAL_AUTHORITY_NEGATION.test(recognized);
}

function hasFailClosedAuthorityNegation(text: string): boolean {
  const recognizedFormulaDenial = text.replace(
    new RegExp(NEGATIVE_FORMULA_PERMISSION.source, 'giu'),
    ' ',
  );
  return FAIL_CLOSED_AUTHORITY_NEGATION.test(recognizedFormulaDenial);
}

function hasUnsupportedTargetAction(
  text: string,
  allowTypedProgression = false,
): boolean {
  const target = new RegExp(
    String.raw`(?:${GOOGLE_OPERATION_OBJECT}|${GOOGLE_ID_RE.source}|${SHEET_RANGE_RE.source}|${CALENDAR_IDENTIFIER_RE.source})`,
    'iu',
  );
  for (const action of text.matchAll(
    new RegExp(UNSUPPORTED_TARGET_ACTION.source, 'giu'),
  )) {
    if (
      /^e-?mail$/iu.test(action[0]) &&
      action.index !== undefined &&
      /(?:^|[.!?]\s*|\s)(?:find|search|read|show|check|open|list|which|who|what(?:'s|\s+is)?|how\s+many)\s+(?:(?:an?|the|my|latest|recent|unread|last|new)\s+){0,4}$/iu.test(
        text.slice(Math.max(0, action.index - 120), action.index),
      )
    ) {
      // Here "email" is the mailbox noun ("find an email in Gmail"), not
      // the unsupported delivery verb guarded by UNSUPPORTED_TARGET_ACTION.
      continue;
    }
    const suffix = text.slice(
      action.index + action[0].length,
      action.index + 320,
    );
    if (
      allowTypedProgression &&
      /^(?:then|subsequently|afterwards?|next|затем|потом|далее)$/iu.test(
        action[0],
      ) &&
      firstBoundGoogleOperationPairEnd(suffix) !== null
    ) {
      continue;
    }
    if (target.test(suffix)) return true;
  }
  return false;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeConfiguredAssistantAddress(
  text: string,
  assistantName: string | undefined,
): string {
  const normalized = assistantName?.trim() || '';
  if (
    normalized.length === 0 ||
    normalized.length > 64 ||
    !/^[\p{L}\p{N}_-]+$/u.test(normalized)
  ) {
    return text;
  }
  return text.replace(
    new RegExp(
      String.raw`(?<![\p{L}\p{N}_])@${escapeRegExp(normalized)}(?![\p{L}\p{N}_])`,
      'giu',
    ),
    'Skoobi',
  );
}

function hasExplicitDriveFolderScope(raw: string, folderId: string): boolean {
  const id = escapeRegExp(folderId);
  return new RegExp(
    String.raw`(?:(?:\b(?:in|inside|within|under|from)\s+(?:the\s+)?folder\b|(?<![\p{L}\p{N}_])(?:в|во|из|под)\s+папк[а-яё]*)[\s\S]{0,80}${id}|\b(?:in|inside|within|under|from)\s+https?://drive\.google\.com/drive/(?:u/\d+/)?folders/${id})`,
    'iu',
  ).test(raw);
}

function hasBoundAction(
  text: string,
  actionSource: string,
  objectSource: string,
): boolean {
  if (
    CONCEPTUAL_QUESTION.test(text) ||
    REPORTED_OR_QUOTED_COMMAND.test(text) ||
    TRAILING_REPORTED_ATTRIBUTION.test(text) ||
    hasNegatedAction(text, actionSource) ||
    hasNegatedObject(text, objectSource)
  ) {
    return false;
  }
  return new RegExp(
    String.raw`(?:(?:${actionSource})[\s\S]{0,140}(?:${objectSource})|(?:${objectSource})[\s\S]{0,140}(?:${actionSource}))`,
    'iu',
  ).test(text);
}

function stripDirectGoogleOperationPrefixes(text: string): string {
  let direct = text.trimStart().replace(POSITIVE_CONFIRMATION_PREFIX, '');
  direct = direct
    .replace(ASSISTANT_ADDRESS_PREFIX, '')
    .replace(POSITIVE_CONFIRMATION_PREFIX, '');
  const politePrefix =
    /^(?:(?:please|kindly)\s+|(?:can|could|would|will)\s+you\s+|i\s+(?:want|need|would\s+like)\s+you\s+to\s+|пожалуйста\s*[,\-:]?\s*|прошу\s*[,\-:]?\s*|(?:можешь|можете|давай|давайте)\s+)/iu;
  for (let count = 0; count < 3; count += 1) {
    const stripped = direct.replace(politePrefix, '');
    if (stripped === direct) break;
    direct = stripped;
  }
  return direct.trimStart();
}

function hasDirectGoogleOperationPrefix(text: string): boolean {
  const direct = stripDirectGoogleOperationPrefixes(text);
  if (
    new RegExp(String.raw`^(?:${GOOGLE_OPERATION_ACTION})`, 'iu').test(direct)
  ) {
    return true;
  }
  return new RegExp(
    String.raw`^(?:${GOOGLE_OPERATION_OBJECT})[\s,:=\-–—]{0,40}(?:${GOOGLE_OPERATION_ACTION})`,
    'iu',
  ).test(direct);
}

function hasDirectNamedSheetAccountingCompletionCommand(
  text: string,
  namedTargets: readonly ConfiguredGoogleSheetTarget[],
): boolean {
  if (namedTargets.length !== 1) return false;
  const normalized = ` ${normalizedSheetAlias(text)} `;
  const explicitlyNamesTarget = namedTargets[0].aliases.some((alias) =>
    normalized.includes(` ${alias} `),
  );
  if (
    !explicitlyNamesTarget ||
    !new RegExp(DIRECT_NAMED_SHEET_OBJECT, 'iu').test(text)
  ) {
    return false;
  }

  // Keep this colloquial completion grammar anchored: searching for an
  // imperative anywhere in the message would turn quoted/reported text, status
  // checks, or pretend requests into append authority.
  let direct = text.trim();
  direct = direct.trimStart().replace(ASSISTANT_ADDRESS_PREFIX, '');
  const connectors = [
    ...direct.matchAll(/(?<![\p{L}\p{N}_])так\s+что(?![\p{L}\p{N}_])\s+/giu),
  ];
  if (connectors.length > 1) return false;
  if (connectors.length === 1) {
    const connector = connectors[0];
    const preamble = direct.slice(0, connector.index).trim();
    if (
      !/^(?:я\s+тебе\s+)?(?:восстановил(?:а)?|вернул(?:а)?)\s+(?:доступ|подключение)\s+к\s+(?:google|гугл)[\s-]*(?:таблиц[а-яё]*|таблич[а-яё]*)\s*[,]?$/iu.test(
        preamble,
      )
    ) {
      return false;
    }
    direct = direct.slice(connector.index + connector[0].length).trimStart();
  }

  const command = new RegExp(
    String.raw`^(?:(?:давай|давайте)\s+(?:заново\s+)?(?:пробы|попробуй(?:те)?|пробуй(?:те)?)\s+и\s+)?сделай(?:те)?\s+вс[её]\s*,?\s*чтобы\s+((?:уч[её]т[а-яё]*|смен[а-яё]*)(?:\s+[\p{L}\p{N}_.-]+){0,5})\s+(?:на\s+сегодняшн[а-яё]*\s+день|сегодня)\s+(?:был[а-яё]*\s+(?:сделан[а-яё]*|оформлен[а-яё]*|внес[её]н[а-яё]*|заверш[её]н[а-яё]*)|была\s+(?:сделан[а-яё]*|оформлен[а-яё]*|внесен[а-яё]*|внесён[а-яё]*|завершен[а-яё]*|завершён[а-яё]*))(?:\s+(?:в|во|на)\s+${DIRECT_NAMED_SHEET_OBJECT})?\s*[.!?]*$`,
    'iu',
  ).exec(direct);
  if (!command) return false;
  const subject = normalizedSheetAlias(command[1]).replace(/ё/gu, 'е');
  const [accountingWord, ...subjectRemainder] = subject.split(' ');
  const aliases = namedTargets[0].aliases.map((alias) =>
    normalizedSheetAlias(alias).replace(/ё/gu, 'е'),
  );
  return (
    aliases.includes(subject) ||
    (/^(?:учет[а-я]*|смен[а-я]*)$/u.test(accountingWord) &&
      aliases.includes(subjectRemainder.join(' ')))
  );
}

function hasDirectNamedSheetAppendCommand(
  text: string,
  namedTargets: readonly ConfiguredGoogleSheetTarget[],
  allowInheritedPronounTarget = false,
): boolean {
  if (namedTargets.length !== 1) return false;
  const namedSheetObject = DIRECT_NAMED_SHEET_OBJECT;
  if (hasDirectNamedSheetAccountingCompletionCommand(text, namedTargets)) {
    return true;
  }
  const sentences: Array<{ start: number; text: string }> = [];
  let sentenceStart = 0;
  for (const boundary of text.matchAll(
    /[?？]+|[!！]+(?=\s|$)|[.…。](?=\s|$)/gu,
  )) {
    sentences.push({
      start: sentenceStart,
      text: text.slice(sentenceStart, boundary.index),
    });
    sentenceStart = boundary.index + boundary[0].length;
  }
  sentences.push({ start: sentenceStart, text: text.slice(sentenceStart) });

  for (const sentence of sentences) {
    let direct = sentence.text
      .trimStart()
      .replace(ASSISTANT_ADDRESS_PREFIX, '');
    let strippedPolitePrefix = false;
    const politePrefix =
      /^(?:(?:please|kindly)\s+|(?:can|could|would|will)\s+you\s+|пожалуйста\s*[,\-:]?\s*|(?:можешь|можете)\s+)/iu;
    for (let count = 0; count < 2; count += 1) {
      const stripped = direct.replace(politePrefix, '');
      if (stripped === direct) break;
      direct = stripped;
      strippedPolitePrefix = true;
    }
    direct = direct.trimStart();
    if (/(?:^|[^\p{L}\p{N}_])ли(?![\p{L}\p{N}_])/iu.test(direct)) {
      continue;
    }
    const imperativeAppendAction = String.raw`(?:добавь(?:те)?|добавляй(?:те)?|запиши(?:те)?|записывай(?:те)?|впиши(?:те)?|вписывай(?:те)?|внеси(?:те)?|вноси(?:те)?|занеси(?:те)?|заноси(?:те)?|\bwrite\b|\badd\b|\bappend\b)`;
    const politeInfinitiveAppendAction = String.raw`(?:добавить|записать|вписать|внести|занести)`;
    const directAppendAction = strippedPolitePrefix
      ? String.raw`(?:${imperativeAppendAction}|${politeInfinitiveAppendAction})`
      : imperativeAppendAction;
    const directAppendActionThen = String.raw`(?:${directAppendAction})(?:\s*,?\s*пожалуйста\s*,?\s+|\s+)`;
    const targetAlias = configuredSheetAliasPattern(namedTargets);
    const targetPreposition = String.raw`(?:в|во|на|\bto\b|\binto\b)`;
    const rowObject = String.raw`(?:(?:нов[а-яё]*\s+)?(?:строк[а-яё]*|\brow\b))`;
    const explicitTargetCommands = [
      String.raw`^${directAppendActionThen}${targetAlias}(?:\s+${rowObject})?\s+${targetPreposition}\s+(?:${namedSheetObject})`,
      String.raw`^${directAppendActionThen}${rowObject}\s+${targetPreposition}\s+(?:${namedSheetObject})\s+${targetAlias}`,
      String.raw`^${directAppendActionThen}${targetPreposition}\s+(?:${namedSheetObject})\s+${targetAlias}(?:\s+${rowObject})?`,
      String.raw`^${targetPreposition}\s+(?:${namedSheetObject})\s+${targetAlias}\s+(?:${directAppendAction})(?:\s+${rowObject})?`,
    ];
    let command: RegExpExecArray | null = null;
    for (const pattern of explicitTargetCommands) {
      command = new RegExp(pattern, 'iu').exec(direct);
      if (command) break;
    }
    let pronounTarget = false;
    if (!command) {
      const pronounCommands = [
        String.raw`^(?:ей|ему|им|туда)\s+${targetPreposition}\s+(?:${namedSheetObject})[\s,:=\-–—]{0,40}(?:${directAppendAction})`,
        String.raw`^${directAppendActionThen}(?:ей|ему|им|туда)\s+${targetPreposition}\s+(?:${namedSheetObject})`,
      ];
      for (const pattern of pronounCommands) {
        command = new RegExp(pattern, 'iu').exec(direct);
        if (command) {
          pronounTarget = true;
          break;
        }
      }
    }
    if (!command) continue;
    const commandTail = direct.slice(command[0].length);
    const targetBoundToCommand =
      !pronounTarget ||
      allowInheritedPronounTarget ||
      textNamesConfiguredSheetTarget(
        text.slice(0, sentence.start),
        namedTargets,
      );
    if (
      targetBoundToCommand &&
      isAllowedNamedSheetAppendCommandTail(commandTail, namedTargets)
    ) {
      return true;
    }
  }
  return false;
}

function configuredSheetAliasPattern(
  namedTargets: readonly ConfiguredGoogleSheetTarget[],
): string {
  const aliases = Array.from(
    new Set(
      namedTargets.flatMap((target) =>
        target.aliases.map((alias) => normalizedSheetAlias(alias)),
      ),
    ),
  )
    .filter(Boolean)
    .sort((left, right) => right.length - left.length)
    .map((alias) =>
      alias
        .split(' ')
        .map((word) => escapeRegExp(word).replace(/[её]/gu, '[её]'))
        .join(String.raw`(?:\s+|[-–—]+)`),
    );
  return String.raw`(?<![\p{L}\p{N}_])(?:${aliases.join('|')})(?![\p{L}\p{N}_])`;
}

function textNamesConfiguredSheetTarget(
  raw: string,
  namedTargets: readonly ConfiguredGoogleSheetTarget[],
): boolean {
  const normalized = ` ${normalizedSheetAlias(raw).replace(/ё/gu, 'е')} `;
  return namedTargets.some((target) =>
    target.aliases.some((alias) =>
      normalized.includes(
        ` ${normalizedSheetAlias(alias).replace(/ё/gu, 'е')} `,
      ),
    ),
  );
}

function isExactConfiguredSheetAlias(
  raw: string,
  namedTargets: readonly ConfiguredGoogleSheetTarget[],
): boolean {
  const payload = raw.trim().replace(/^[,;:—–-]+\s*/u, '');
  const normalizedPayload = normalizedSheetAlias(payload).replace(/ё/gu, 'е');
  return namedTargets.some((target) =>
    target.aliases.some(
      (alias) =>
        normalizedSheetAlias(alias).replace(/ё/gu, 'е') === normalizedPayload,
    ),
  );
}

function isAllowedNamedSheetAppendCommandTail(
  raw: string,
  namedTargets: readonly ConfiguredGoogleSheetTarget[],
): boolean {
  const tail = raw.trim();
  if (!tail || /^[,;:—–-]+$/u.test(tail)) return true;
  const payload = tail.replace(/^[,;:—–-]+\s*/u, '');
  if (!payload) return true;
  if (isExactConfiguredSheetAlias(payload, namedTargets)) {
    return true;
  }

  // Free text is data only when the owner labels it as such. This preserves
  // ordinary notes such as "комментарий: интернета нет" without allowing an
  // arbitrary reported/cancel/pretend suffix to inherit append authority.
  if (
    /^(?:(?:комментарий|примечание|пометка|comment|note)\s*:\s*)\S[\s\S]{0,500}$/iu.test(
      payload,
    )
  ) {
    return true;
  }
  if (
    /^(?:формул[а-яё]*\s+разрешаю|разрешаю\s+формул[а-яё]*|formulas?\s+(?:are\s+)?allowed)$/iu.test(
      payload,
    )
  ) {
    return true;
  }
  if (
    /^(?:пожалуйста|спасибо(?:\s*,?\s*(?:большое|тебе|скуби(?:\s+кот)?))?|благодарю|thanks|thank\s+you)$/iu.test(
      payload,
    )
  ) {
    return true;
  }

  const timePoint = String.raw`\d{1,2}(?:[:.\s]\d{2})?(?:\s+(?:час(?:а|ов)?|утра|дня|вечера|ночи|am|pm)){0,2}`;
  const timeRange = String.raw`(?:с|from)\s+${timePoint}\s+(?:до|to)\s+${timePoint}`;
  const duration = String.raw`\d+(?:[.,]\d+)?\s*(?:час(?:а|ов)?|hours?)`;
  const labeledNumber = String.raw`(?:ставка|сумма|rate|amount)\s*:?\s*\d+(?:[.,]\d+)?(?:\s*(?:₽|руб(?:лей)?|₸|тг|тенге))?`;
  const date = String.raw`(?:(?:за|на)\s+)?(?:сегодня|вчера|today|yesterday)`;
  const structuredField = String.raw`(?:${date}|${timeRange}|${duration}|${labeledNumber})`;
  return new RegExp(
    String.raw`^${structuredField}(?:\s*[,;]\s*${structuredField})*$`,
    'iu',
  ).test(payload);
}

const DIRECT_ACTION_OBJECT_BRIDGE_WORDS = new Set([
  'the',
  'a',
  'an',
  'this',
  'that',
  'my',
  'google',
  'content',
  'contents',
  'text',
  'body',
  'new',
  'value',
  'values',
  'event',
  'events',
  'to',
  'into',
  'default',
  'main',
  'in',
  'inside',
  'of',
  'for',
  'этот',
  'эту',
  'это',
  'мой',
  'мою',
  'гугл',
  'содержимое',
  'содержание',
  'текст',
  'новое',
  'новый',
  'новую',
  'значение',
  'значения',
  'событие',
  'события',
  'событий',
  'основной',
  'основную',
  'в',
  'из',
  'у',
]);

function hasDirectActionObjectBinding(
  text: string,
  actionSource: string,
  objectSource: string,
): boolean {
  for (const action of text.matchAll(new RegExp(actionSource, 'giu'))) {
    const suffixStart = action.index + action[0].length;
    const suffix = text.slice(suffixStart, suffixStart + 100);
    const object = new RegExp(objectSource, 'iu').exec(suffix);
    if (!object) continue;
    const bridge = suffix.slice(0, object.index);
    if (/[^\p{L}\s,:=\-–—]/u.test(bridge)) continue;
    const words = bridge.toLocaleLowerCase().match(/\p{L}+/gu) ?? [];
    if (words.every((word) => DIRECT_ACTION_OBJECT_BRIDGE_WORDS.has(word))) {
      return true;
    }
  }
  return false;
}

function countTypedObjectMentions(text: string, objectSource: string): number {
  return [...text.matchAll(new RegExp(objectSource, 'giu'))].length;
}

function hasDefaultAliasForObject(text: string, objectSource: string): boolean {
  if (!DEFAULT_ALIAS.test(text) || NEGATIVE_DEFAULT_ALIAS.test(text)) {
    return false;
  }
  return new RegExp(
    String.raw`(?:(?:${objectSource})[\s\S]{0,60}(?:основн(?:ая|ую|ой|ый|ого|ом)|по\s+умолчанию|\bdefault\b)|(?:основн(?:ая|ую|ой|ый|ого|ом)|по\s+умолчанию|\bdefault\b)[\s\S]{0,60}(?:${objectSource}))`,
    'iu',
  ).test(text);
}

function hasExplicitCreateForObject(
  text: string,
  objectSource: string,
  newObjectPattern: RegExp,
): boolean {
  if (
    hasNegatedAction(text, CREATE_ACTION) ||
    NEGATIVE_NEW_OBJECT.test(text) ||
    REPORTED_OR_QUOTED_COMMAND.test(text)
  ) {
    return false;
  }
  return (
    hasBoundAction(text, CREATE_ACTION, objectSource) ||
    newObjectPattern.test(text)
  );
}

function typedUrlKind(raw: string, idIndex: number): ResourceKind | null {
  const prefix = raw.slice(Math.max(0, idIndex - 180), idIndex);
  if (/docs\.google\.com\/document\/d\/$/i.test(prefix)) return 'document';
  if (/docs\.google\.com\/spreadsheets\/d\/$/i.test(prefix)) {
    return 'spreadsheet';
  }
  if (/script\.google\.com\/(?:home\/)?projects\/$/i.test(prefix)) {
    return 'script';
  }
  if (/drive\.google\.com\/drive\/(?:u\/\d+\/)?folders\/$/i.test(prefix)) {
    return 'folder';
  }
  return null;
}

function objectMentions(
  raw: string,
): Array<{ kind: ResourceKind; start: number; end: number }> {
  const masked = raw.replace(new RegExp(GOOGLE_ID_RE.source, 'g'), (id) =>
    ' '.repeat(id.length),
  );
  const sources: Array<[ResourceKind, string]> = [
    ['document', DOCUMENT_OBJECT],
    ['spreadsheet', SHEET_OBJECT],
    ['script', SCRIPT_OBJECT],
    ['folder', FOLDER_OBJECT],
  ];
  const mentions: Array<{ kind: ResourceKind; start: number; end: number }> =
    [];
  for (const [kind, source] of sources) {
    const re = new RegExp(source, 'giu');
    for (const match of masked.matchAll(re)) {
      const start = match.index;
      mentions.push({ kind, start, end: start + match[0].length });
    }
  }
  return mentions;
}

function classifyAllowedResourceIds(
  raw: string,
  allowedMaximum: ReadonlySet<string>,
): ClassifiedResourceIds {
  const result: Record<ResourceKind, Set<string>> = {
    document: new Set(),
    spreadsheet: new Set(),
    script: new Set(),
    folder: new Set(),
  };
  const mentions = objectMentions(raw);
  for (const match of raw.matchAll(new RegExp(GOOGLE_ID_RE.source, 'g'))) {
    const id = match[1];
    if (!allowedMaximum.has(id)) continue;
    const start = match.index;
    const end = start + id.length;
    if (NEGATIVE_ID_BINDING.test(raw.slice(Math.max(0, start - 180), start))) {
      continue;
    }
    const urlKind = typedUrlKind(raw, start);
    if (urlKind) {
      result[urlKind].add(id);
      continue;
    }
    let nearest: { kind: ResourceKind; distance: number } | null = null;
    let tied = false;
    for (const mention of mentions) {
      const distance =
        end < mention.start
          ? mention.start - end
          : mention.end < start
            ? start - mention.end
            : 0;
      if (distance > 100) continue;
      if (!nearest || distance < nearest.distance) {
        nearest = { kind: mention.kind, distance };
        tied = false;
      } else if (
        distance === nearest.distance &&
        mention.kind !== nearest.kind
      ) {
        tied = true;
      }
    }
    if (nearest && !tied) result[nearest.kind].add(id);
  }
  return {
    document: [...result.document],
    spreadsheet: [...result.spreadsheet],
    script: [...result.script],
    folder: [...result.folder],
  };
}

function extractSheetRanges(raw: string): string[] {
  const quoteScan = scanQuoteRanges(raw);
  if (!quoteScan.ok) return [];
  const ranges = new Set<string>();
  for (const match of raw.matchAll(new RegExp(SHEET_RANGE_RE.source, 'g'))) {
    const enclosingQuote = quoteScan.ranges.find(
      (range) => match.index > range.start && match.index < range.end,
    );
    if (enclosingQuote) {
      const beforeQuote = raw.slice(
        Math.max(0, enclosingQuote.start - 100),
        enclosingQuote.start,
      );
      if (!/(?:\brange|диапазон[а-яё]*)\s*[:=]?\s*$/iu.test(beforeQuote)) {
        continue;
      }
    }
    ranges.add(match[1]);
  }
  return [...ranges];
}

function allNamedSheetTargetsForText(
  raw: string,
  configured: readonly ConfiguredGoogleSheetTarget[],
): ConfiguredGoogleSheetTarget[] {
  const normalized = ` ${normalizedSheetAlias(raw)} `;
  const matches = configured.filter((target) =>
    target.aliases.some((alias) => normalized.includes(` ${alias} `)),
  );
  const unique = new Map(
    matches.map((target) => [
      `${target.spreadsheetId}\0${target.range}`,
      target,
    ]),
  );
  return [...unique.values()];
}

function namedSheetTargetsForClause(
  raw: string,
  configured: readonly ConfiguredGoogleSheetTarget[],
): ConfiguredGoogleSheetTarget[] {
  const matches = allNamedSheetTargetsForText(raw, configured);
  // Two distinct configured targets named in one clause are ambiguous. Typed
  // continuations are split into separate clauses before reaching this point.
  return matches.length === 1 ? matches : [];
}

function canonicalExplicitQuery(value: string): string | null {
  const canonical = value.replace(/\s+/g, ' ').trim();
  return canonical.length >= 2 &&
    canonical.length <= 512 &&
    !/[\u0000-\u001f\u007f]/.test(canonical)
    ? canonical
    : null;
}

const DRIVE_CONTENT_INTENT =
  /(?:по\s+содержимому|в\s+содержимом|содержащ[а-яё]*\s+(?:текст|фразу|слов[а-яё]*)|\bfull[ -]?text\b|\b(?:file\s+)?content\s+(?:contains?|containing|with)\b|\bcontaining\s+(?:the\s+)?(?:text|phrase|words?)\b)/iu;

function firstExplicitQueries(raw: string, patterns: RegExp[]): string[] {
  const quoteScan = scanQuoteRanges(raw);
  if (!quoteScan.ok) return [];
  for (const pattern of patterns) {
    const queries = new Set<string>();
    for (const match of raw.matchAll(pattern)) {
      if (indexInsideQuote(match.index, quoteScan.ranges)) continue;
      const canonical = canonicalExplicitQuery(match[1]);
      if (canonical) queries.add(canonical);
    }
    if (queries.size > 0) return [...queries];
  }
  return [];
}

/** Extract only exact filename terms, never a full-text/content request. */
function extractDriveNameQueries(raw: string): string[] {
  const explicitName = firstExplicitQueries(raw, [
    /(?:с\s+названием|по\s+названию)\s*[:=]?\s*["'«“‘‹„‚]([^"'«»“”‘’‹›„‚]{2,512})["'»”’›“‘]/giu,
    /\b(?:named|with\s+(?:the\s+)?name)\s*[:=]?\s*["'«“‘‹„‚]([^"'«»“”‘’‹›„‚]{2,512})["'»”’›“‘]/giu,
    /(?:с\s+названием|по\s+названию|по\s+запросу)\s+(.{2,512}?)(?=\s+(?:в|на)\s+(?:google\s+drive|гугл[\s-]*диск[а-яё]*)\b|$|[,;])/giu,
    /\b(?:named|with\s+(?:the\s+)?name|query)\s+(.{2,512}?)(?=\s+(?:in|on)\s+(?:google\s+drive|drive)\b|$|[,;])/giu,
  ]);
  if (explicitName.length > 0) return explicitName;
  if (DRIVE_CONTENT_INTENT.test(maskQuotedContents(raw))) return [];
  return firstExplicitQueries(raw, [
    /\bsearch\s+(?:in\s+)?(?:google\s+drive|drive)\s+for\s+(.{2,512})$/giu,
    /\bfind\s+(.{2,512}?)\s+files?\s+(?:in|on)\s+(?:google\s+drive|drive)\b/giu,
    /\bfind\s+(.{2,512}?)\s+(?:in|on)\s+(?:google\s+drive|drive)\b/giu,
    /(?:найд[а-яё]*|поищ[а-яё]*)\s+(.{2,512}?)\s+(?:в|на)\s+(?:google\s+drive|гугл[\s-]*диск[а-яё]*)/giu,
  ]);
}

/** Full-text search needs an explicit content phrase and a quoted term. */
function extractDriveContentQueries(raw: string): string[] {
  if (!DRIVE_CONTENT_INTENT.test(maskQuotedContents(raw))) return [];
  return firstExplicitQueries(raw, [
    /(?:по\s+содержимому|в\s+содержимом|содержащ[а-яё]*\s+(?:текст|фразу|слов[а-яё]*))\s*[:=]?\s*[`"'«“‘‹„‚]([^`"'«»“”‘’‹›„‚]{2,512})[`"'»”’›“‘]/giu,
    /(?:\bfull[ -]?text\b|\b(?:file\s+)?content\s+(?:contains?|containing|with)\b|\bcontaining\s+(?:the\s+)?(?:text|phrase|words?)\b)\s*[:=]?\s*[`"'«“‘‹„‚]([^`"'«»“”‘’‹›„‚]{2,512})[`"'»”’›“‘]/giu,
  ]);
}

function extractDriveResultTypes(raw: string): GoogleDriveFileType[] {
  const types = new Set<GoogleDriveFileType>();
  if (new RegExp(SHEET_OBJECT, 'iu').test(raw)) types.add('sheet');
  if (new RegExp(DOCUMENT_OBJECT, 'iu').test(raw)) types.add('doc');
  // Singular "folder/папке" commonly scopes a search. Only an explicit plural
  // or type label is treated as the requested result kind.
  if (
    /(?:\b(?:only|type\s*[:=]?)\s+folders?\b|(?:только|тип\s*[:=]?)\s+папк(?:и|ами|ах)\b)/iu.test(
      raw,
    )
  ) {
    types.add('folder');
  }
  return types.size > 0 ? [...types] : ['any'];
}

/** Calendar filters are authorized only when explicitly labelled and quoted. */
function extractCalendarQueries(raw: string): string[] {
  const pattern =
    /(?:по\s+запросу|с\s+текстом|содержащ[а-яё]*|\bquery\b|\bsearch(?:\s+for)?\b|\bcontaining\b)\s*[:=]?\s*[`"'«“‘‹„‚]([^`"'«»“”‘’‹›„‚]{2,512})[`"'»”’›“‘]/giu;
  return firstExplicitQueries(raw, [pattern]);
}

function extractScriptFileNames(raw: string): string[] {
  const quoteScan = scanQuoteRanges(raw);
  if (!quoteScan.ok) return [];
  const names = new Set<string>();
  for (const match of raw.matchAll(
    new RegExp(SCRIPT_FILE_WITH_EXTENSION_RE.source, 'giu'),
  )) {
    if (indexInsideQuote(match.index, quoteScan.ranges)) continue;
    names.add(match[1].replace(/\.(?:gs|html|json)$/i, ''));
  }
  for (const match of raw.matchAll(
    new RegExp(SCRIPT_FILE_AFTER_LABEL_RE.source, 'giu'),
  )) {
    const labelIndex =
      match.index + (unicodeLetterOrNumber(raw[match.index]) ? 0 : 1);
    if (indexInsideQuote(labelIndex, quoteScan.ranges)) continue;
    names.add(match[1].replace(/\.(?:gs|html|json)$/i, ''));
  }
  return [...names].filter(Boolean);
}

type CreateTitleSelection =
  | { kind: 'generic' }
  | { kind: 'exact'; title: string }
  | { kind: 'ambiguous' };

interface PairedQuote {
  value: string;
  start: number;
}

function hasUnquotedCreateTitleCandidate(
  raw: string,
  objectSource: string,
): boolean {
  const semantic = maskQuotedContents(raw);
  const objects = [...semantic.matchAll(new RegExp(objectSource, 'giu'))];
  if (objects.length !== 1) return objects.length > 1;
  const object = objects[0];
  const createActions = [
    ...semantic
      .slice(0, object.index)
      .matchAll(new RegExp(CREATE_ACTION, 'giu')),
  ];
  const createAction = createActions.at(-1);
  if (!createAction) return true;
  const afterObject = semantic.slice(object.index + object[0].length);
  const root = new RegExp(ROOT_TARGET.source, 'iu').exec(afterObject);
  const folder = new RegExp(FOLDER_OBJECT, 'iu').exec(afterObject);
  const locations = [
    ...(root
      ? [
          {
            kind: 'root' as const,
            start: root.index,
            end: root.index + root[0].length,
          },
        ]
      : []),
    ...(folder
      ? [
          {
            kind: 'folder' as const,
            start: folder.index,
            end: folder.index + folder[0].length,
          },
        ]
      : []),
  ].sort((a, b) => a.start - b.start);
  const location = locations[0];

  const normalizePlacement = (value: string): string => {
    const blankQuote = String.raw`(?:"\s*"|'\s*'|«\s*»|“\s*”|‘\s*’|‹\s*›|„\s*[“”]|‚\s*[‘’])`;
    return value
      .replace(
        new RegExp(
          String.raw`(?:(?:and|и)\s+)?(?:(?:add|set|write|put|include|containing)\s+|(?:добав[а-яё]*|запиш[а-яё]*|встав[а-яё]*|укаж[а-яё]*)\s+)?(?:${CREATE_TITLE_LABEL}|${CREATE_CONTENT_LABEL})\s*[:=]?\s*${blankQuote}`,
          'giu',
        ),
        ' ',
      )
      .replace(new RegExp(blankQuote, 'gu'), ' ')
      .replace(/^(?:and|with|и|с)\s*$/iu, ' ')
      .replace(/[\s,:;.!?=&-]+/g, ' ')
      .trim();
  };

  const beforeObject = normalizePlacement(
    semantic.slice(createAction.index + createAction[0].length, object.index),
  );
  const beforeObjectAllowed =
    /^(?:(?:please|kindly)(?:\s+|$))?(?:(?:for\s+)?me(?:\s+|$))?(?:(?:a|an|the)(?:\s+|$))?(?:new(?:\s+|$))?(?:google)?$/iu.test(
      beforeObject,
    ) ||
    /^(?:пожалуйста(?:\s+|$))?(?:мне(?:\s+|$))?(?:нов[а-яё]*(?:\s+|$))?(?:(?:google|гугл))?$/iu.test(
      beforeObject,
    );

  const betweenObjectAndLocation = normalizePlacement(
    afterObject.slice(0, location?.start ?? afterObject.length),
  );
  const betweenAllowed =
    betweenObjectAndLocation === '' ||
    /^(?:and|with)$/iu.test(betweenObjectAndLocation) ||
    /^(?:in|into|at|to|on|inside|under)$/iu.test(betweenObjectAndLocation) ||
    /^(?:for\s+me)(?:\s+(?:in|into|at|to|on))?$/iu.test(
      betweenObjectAndLocation,
    ) ||
    /^(?:and\s+)?(?:put|place|save)\s+(?:it|the\s+file)(?:\s+(?:in|into|at|to|on))?$/iu.test(
      betweenObjectAndLocation,
    ) ||
    /^(?:в|во|на|из|для\s+меня|мне|и)$/iu.test(betweenObjectAndLocation) ||
    /^(?:и\s+)?(?:положи|помести|сохрани)[а-яё]*\s+(?:его|её|файл)(?:\s+(?:в|во|на))?$/iu.test(
      betweenObjectAndLocation,
    );

  let afterLocationRaw = location ? afterObject.slice(location.end) : '';
  if (location?.kind === 'folder') {
    afterLocationRaw = afterLocationRaw.replace(
      new RegExp(String.raw`^\s*${GOOGLE_ID_RE.source}`),
      ' ',
    );
  }
  const afterLocation = normalizePlacement(afterLocationRaw);
  const afterLocationAllowed =
    afterLocation === '' ||
    /^(?:please|kindly|for\s+me|and|with)$/iu.test(afterLocation) ||
    /^(?:in|into)\s+(?:it|the\s+(?:doc|document))$/iu.test(afterLocation) ||
    /^(?:пожалуйста|для\s+меня|мне|и|с)$/iu.test(afterLocation);

  return !beforeObjectAllowed || !betweenAllowed || !afterLocationAllowed;
}

function pairedQuotedValues(raw: string): PairedQuote[] {
  const scan = scanQuoteRanges(raw);
  if (!scan.ok) return [];
  return scan.ranges
    .map((range) => ({
      value: raw.slice(range.start + 1, range.end),
      start: range.start,
    }))
    .filter((quote) => quote.value.length >= 1 && quote.value.length <= 256);
}

/**
 * A named create target must be one unambiguous, visibly quoted title in the
 * same operation span. Once the owner uses a title label or quote syntax, any
 * malformed/multiple/unbound value fails closed instead of degrading to the
 * generic one-create slot.
 */
function selectCreateTitle(
  raw: string,
  objectSource: string,
): CreateTitleSelection {
  const hasLabel = new RegExp(CREATE_TITLE_LABEL, 'iu').test(
    maskQuotedContents(raw),
  );
  const hasQuoteSignal =
    /["«»“”‘’‹›„‚]/u.test(raw) ||
    /(?<![\p{L}\p{N}])'|'(?![\p{L}\p{N}])/u.test(raw);
  const unquotedTitleCandidate = hasUnquotedCreateTitleCandidate(
    raw,
    objectSource,
  );
  const quotes = pairedQuotedValues(raw);
  const hasTypedObject = new RegExp(objectSource, 'iu').test(raw);
  if (!hasTypedObject) return { kind: 'ambiguous' };
  if (unquotedTitleCandidate) return { kind: 'ambiguous' };

  const titleQuotes: PairedQuote[] = [];
  const unrelatedQuotes: PairedQuote[] = [];
  for (const quote of quotes) {
    const beforeQuote = raw.slice(0, quote.start);
    const labelBound = new RegExp(
      String.raw`(?:${CREATE_TITLE_LABEL})\s*[:=]?\s*$`,
      'iu',
    ).test(beforeQuote.slice(-140));
    const objectBound = new RegExp(
      String.raw`(?:${objectSource})\s*[:=,-]?\s*$`,
      'iu',
    ).test(beforeQuote.slice(-220));
    if (labelBound || objectBound) {
      titleQuotes.push(quote);
      continue;
    }
    const contentBound = new RegExp(
      String.raw`(?:${CREATE_CONTENT_LABEL})\s*[:=]?\s*$`,
      'iu',
    ).test(beforeQuote.slice(-120));
    if (!contentBound) unrelatedQuotes.push(quote);
  }

  if (titleQuotes.length === 0) {
    if (!hasLabel && !hasQuoteSignal) {
      return { kind: 'generic' };
    }
    if (quotes.length > 0 && unrelatedQuotes.length === 0 && !hasLabel) {
      // Explicitly content-bound quotes do not imply a title request.
      return { kind: 'generic' };
    }
    return { kind: 'ambiguous' };
  }
  if (titleQuotes.length !== 1 || unrelatedQuotes.length > 0) {
    return { kind: 'ambiguous' };
  }
  const quote = titleQuotes[0];
  const title = quote.value.replace(/\s+/g, ' ').trim();
  return title.length > 0 &&
    title.length <= 256 &&
    !/[\u0000-\u001f\u007f]/.test(title)
    ? { kind: 'exact', title }
    : { kind: 'ambiguous' };
}

function hasPositiveConfirmationFor(
  raw: string,
  actionSource: string,
  objectSource: string,
  eligible: boolean,
): boolean {
  if (!eligible) return false;
  if (NEGATIVE_CONFIRMATION.test(raw)) return false;
  const prefix = POSITIVE_CONFIRMATION_PREFIX.exec(raw);
  if (!prefix) return false;
  // A confirmation binds only the first nearby Google operation. Without
  // this check, a non-destructive first operation plus a very long bridge can
  // make a later replacement inherit the prefix even when clause splitting
  // correctly refuses to guess across that bridge.
  const body = raw.slice(prefix[0].length, prefix[0].length + 320);
  const firstGeneralAction = new RegExp(GOOGLE_OPERATION_ACTION, 'iu').exec(
    body,
  );
  const firstGeneralObject = new RegExp(GOOGLE_OPERATION_OBJECT, 'iu').exec(
    body,
  );
  const firstTargetAction = new RegExp(actionSource, 'iu').exec(body);
  const firstTargetObject = new RegExp(objectSource, 'iu').exec(body);
  if (
    !firstGeneralAction ||
    !firstGeneralObject ||
    !firstTargetAction ||
    !firstTargetObject ||
    firstGeneralAction.index !== firstTargetAction.index ||
    firstGeneralObject.index !== firstTargetObject.index
  ) {
    return false;
  }
  return Math.abs(firstTargetAction.index - firstTargetObject.index) <= 140;
}

function selectCalendarIds(
  raw: string,
  configured: readonly string[],
): string[] {
  const mentioned = Array.from(
    raw.matchAll(new RegExp(CALENDAR_IDENTIFIER_RE.source, 'gi')),
    (match) => match[0],
  );
  if (mentioned.length > 0) {
    return configured.filter((id) => mentioned.includes(id));
  }
  if (configured.length === 1) return [configured[0]];
  if (hasDefaultAliasForObject(raw, CALENDAR_OBJECT)) {
    return configured.filter((id) => id === 'primary');
  }
  return [];
}

/**
 * Derive least authority only from explicit commands in the current homogeneous
 * owner batch. The env allowlist is a ceiling for owner-mentioned IDs, never a
 * source of implicit authority; configured defaults require an object-bound
 * "main/default" alias.
 */
export function buildGoogleOperationPolicy(input: {
  chatJid: string;
  messages: NewMessage[];
  /** Trusted host configuration; invalid values are ignored fail-closed. */
  assistantName?: string;
  configuredResourceIds?: string[];
  configuredCalendarIds?: string[];
  defaultSpreadsheetId?: string;
  defaultScriptId?: string;
  configuredSheetTargets?: ConfiguredGoogleSheetTarget[];
}): GoogleOperationPolicy | null {
  const ownerMessages = currentOwnerMessages(input.messages);
  if (!ownerMessages) return null;
  const messages = effectiveOwnerMessages(ownerMessages).map((message) => {
    const content = normalizeConfiguredAssistantAddress(
      message.content,
      input.assistantName,
    );
    return content === message.content ? message : { ...message, content };
  });
  const latestOwnerTimestamp = latestAuthoritativeOwnerTimestamp(messages);
  const calendarEarliestTime =
    latestOwnerTimestamp === null
      ? undefined
      : new Date(latestOwnerTimestamp - 24 * 60 * 60 * 1000).toISOString();
  const calendarLatestTime =
    latestOwnerTimestamp === null
      ? undefined
      : new Date(latestOwnerTimestamp + 31 * 24 * 60 * 60 * 1000).toISOString();

  const resources = configuredGoogleResources(input);
  const resourceMaximum = new Set(resources.allowedResourceIds);
  const calendars = [
    ...new Set(
      (input.configuredCalendarIds ?? configuredCalendarIds()).filter((id) =>
        CALENDAR_ID_VALUE_RE.test(id),
      ),
    ),
  ];
  const clauses = ownerClauses(
    messages,
    resources.namedSheetTargets,
    hasMultipleDirectSheetAppendIntents(messages, resources.namedSheetTargets),
  );
  if (clauses.length === 0) return null;

  const tools = new Set<GoogleWorkspaceTool>();
  const allowedDocumentIds = new Set<string>();
  const allowedSpreadsheetIds = new Set<string>();
  const allowedScriptIds = new Set<string>();
  const allowedFolderIds = new Set<string>();
  const allowedCalendarIds = new Set<string>();
  const allowedSheetRanges = new Set<string>();
  const allowedSheetTargets = new Map<
    string,
    { spreadsheetId: string; range: string }
  >();
  const allowedSheetAppendTargets = new Map<
    string,
    GoogleOperationPolicy['allowedSheetAppendTargets'][number]
  >();
  const allowedScriptFileNames = new Set<string>();
  const confirmedDocumentReplaceIds = new Set<string>();
  const confirmedSheetUpdateIds = new Set<string>();
  const confirmedSheetUpdateTargets = new Map<
    string,
    { spreadsheetId: string; range: string }
  >();
  const confirmedScriptUpdateIds = new Set<string>();
  const confirmedScriptUpdateTargets = new Map<
    string,
    { scriptId: string; fileName: string }
  >();
  const allowedDriveSearchTargets = new Map<
    string,
    GoogleOperationPolicy['allowedDriveSearchTargets'][number]
  >();
  const allowedCalendarQueries = new Set<string>();
  const allowedCalendarTargets = new Map<
    string,
    GoogleOperationPolicy['allowedCalendarTargets'][number]
  >();
  const allowedCreateTargets = new Map<
    string,
    GoogleOperationPolicy['allowedCreateTargets'][number]
  >();
  const rootCreateTools = new Set<
    'google_sheets_create' | 'google_docs_create'
  >();
  let allowDriveSearch = false;
  let allowUnfilteredDriveList = false;
  let allowRootCreate = false;
  let allowUserEnteredValues = false;
  let allowStatusVerify = false;

  for (const clause of clauses) {
    const raw = clause.text;
    const rawOperational = clause.namedSheetCommentData
      ? maskExplicitNamedSheetCommentData(raw)
      : raw;
    const semanticWithCommentData = maskQuotedContents(raw);
    const semantic = clause.namedSheetCommentData
      ? maskExplicitNamedSheetCommentData(semanticWithCommentData)
      : semanticWithCommentData;
    const clauseNamedSheetTargets = namedSheetTargetsForClause(
      maskExplicitNamedSheetCommentData(semanticWithCommentData),
      resources.namedSheetTargets,
    );
    const namedSheetTargets =
      clauseNamedSheetTargets.length > 0
        ? clauseNamedSheetTargets
        : clause.inheritedNamedSheetTargets || [];
    const directNamedSheetAppend =
      clause.namedSheetAppendEligible &&
      (clause.namedSheetAppendCommandValidated ||
        hasDirectNamedSheetAppendCommand(
          semanticWithCommentData,
          namedSheetTargets,
          clause.inheritedNamedSheetTargets?.length === 1,
        ));
    if (
      CONCEPTUAL_QUESTION.test(semantic) ||
      REPORTED_OR_QUOTED_COMMAND.test(semantic) ||
      META_OR_REPORTED_COMMAND.test(semantic) ||
      META_OR_REPORTED_COMMAND_RU.test(semantic) ||
      TRAILING_REPORTED_ATTRIBUTION.test(semantic) ||
      ACTION_LED_META_PREFIX.test(semantic) ||
      DECLARATIVE_AUTHORITY_TEXT.test(semantic) ||
      NEGATED_GOOGLE_SELECTOR.test(semantic) ||
      NEGATIVE_ROOT_TARGET.test(semantic) ||
      NEGATIVE_ALL_FILES_DRIVE.test(semantic) ||
      NEGATIVE_DEFAULT_ALIAS.test(semantic) ||
      hasFailClosedAuthorityNegation(semantic) ||
      hasUnsupportedAuthorityNegation(semantic) ||
      hasUnsupportedTargetAction(semantic) ||
      (!hasDirectGoogleOperationPrefix(semantic) && !directNamedSheetAppend)
    ) {
      continue;
    }
    const ids = classifyAllowedResourceIds(semantic, resourceMaximum);
    const ranges = extractSheetRanges(rawOperational);

    if (
      hasBoundAction(semantic, GMAIL_READ_ACTION, GMAIL_OBJECT) &&
      !AMBIGUOUS_EMAIL_ADDRESS_LOOKUP.test(semantic) &&
      !NON_MAILBOX_TECHNICAL_CONTEXT.test(semantic) &&
      !(
        PERSONAL_EMAIL_ADDRESS_LOOKUP.test(semantic) &&
        !EXPLICIT_GMAIL_MESSAGE_CONTEXT.test(semantic)
      ) &&
      !(
        EXPLICIT_NON_GMAIL_CONTENT_SOURCE.test(semantic) &&
        !EXPLICIT_GMAIL_LOCATION_CONTEXT.test(semantic)
      )
    ) {
      tools.add('gmail_search_threads');
      tools.add('gmail_get_thread');
    }

    const documentRead =
      hasBoundAction(semantic, READ_ACTION, DOCUMENT_OBJECT) &&
      hasDirectActionObjectBinding(semantic, READ_ACTION, DOCUMENT_OBJECT);
    const documentReplace =
      hasBoundAction(semantic, DOCUMENT_REPLACE_ACTION, DOCUMENT_OBJECT) &&
      hasDirectActionObjectBinding(
        semantic,
        DOCUMENT_REPLACE_ACTION,
        DOCUMENT_OBJECT,
      ) &&
      countTypedObjectMentions(semantic, DOCUMENT_OBJECT) === 1;
    if (documentRead || documentReplace) {
      for (const id of ids.document) allowedDocumentIds.add(id);
      if (ids.document.length > 0) tools.add('google_docs_read');
      if (
        documentReplace &&
        ids.document.length === 1 &&
        hasPositiveConfirmationFor(
          semantic,
          DOCUMENT_REPLACE_ACTION,
          DOCUMENT_OBJECT,
          clause.destructiveConfirmationEligible,
        )
      ) {
        for (const id of ids.document) confirmedDocumentReplaceIds.add(id);
        tools.add('google_docs_replace_content');
      }
    }

    const sheetRead = hasBoundAction(semantic, READ_ACTION, SHEET_OBJECT);
    const sheetUpdate =
      hasBoundAction(semantic, SHEET_UPDATE_ACTION, SHEET_OBJECT) &&
      hasDirectActionObjectBinding(
        semantic,
        SHEET_UPDATE_ACTION,
        SHEET_OBJECT,
      ) &&
      countTypedObjectMentions(semantic, SHEET_OBJECT) === 1;
    const sheetAppend = directNamedSheetAppend;
    const sheetCreate = hasExplicitCreateForObject(
      semantic,
      SHEET_OBJECT,
      /(?:новую\s+(?:(?:google|гугл)[\s-]*)?(?:таблиц[а-яё]*|таблич[а-яё]*)|\bnew\s+(?:google\s+)?(?:sheet|spreadsheet)\b)/i,
    );
    const sheetIds = new Set(ids.spreadsheet);
    if (
      (sheetRead || sheetUpdate || sheetAppend) &&
      resources.defaultSpreadsheetId &&
      hasDefaultAliasForObject(semantic, SHEET_OBJECT)
    ) {
      sheetIds.add(resources.defaultSpreadsheetId);
    }
    if (sheetRead || sheetUpdate || sheetAppend) {
      for (const id of sheetIds) allowedSpreadsheetIds.add(id);
      for (const range of ranges) allowedSheetRanges.add(range);
      // Two-or-more IDs and two-or-more ranges in one unsplit span are
      // ambiguous. Never manufacture their Cartesian product; typed
      // continuations are split above into exact per-resource spans.
      const sheetTargetsUnambiguous = sheetIds.size <= 1 || ranges.length <= 1;
      if (sheetTargetsUnambiguous) {
        for (const id of sheetIds) {
          for (const range of ranges) {
            allowedSheetTargets.set(`${id}\0${range}`, {
              spreadsheetId: id,
              range,
            });
          }
        }
      }
      for (const target of namedSheetTargets) {
        allowedSpreadsheetIds.add(target.spreadsheetId);
        allowedSheetRanges.add(target.range);
        allowedSheetTargets.set(`${target.spreadsheetId}\0${target.range}`, {
          spreadsheetId: target.spreadsheetId,
          range: target.range,
        });
        const columnCount = configuredSheetRangeColumnCount(target.range);
        if (sheetAppend && columnCount !== null) {
          allowedSheetAppendTargets.set(
            `${target.spreadsheetId}\0${target.range}`,
            {
              label: target.aliases[0],
              spreadsheetId: target.spreadsheetId,
              range: target.range,
              columnCount,
              // A natural-language owner turn may append one accounting row.
              // Bulk imports require a separate, explicit design.
              maxRowsPerCall: 1,
            },
          );
        }
      }
      if (allowedSheetTargets.size > 0) {
        tools.add('google_sheets_get_values');
      }
      if (
        sheetAppend &&
        namedSheetTargets.length === 1 &&
        allowedSheetAppendTargets.size > 0
      ) {
        tools.add('google_sheets_append_values');
      }
      const confirmed =
        sheetUpdate &&
        sheetIds.size === 1 &&
        ranges.length > 0 &&
        hasPositiveConfirmationFor(
          semantic,
          SHEET_UPDATE_ACTION,
          SHEET_OBJECT,
          clause.destructiveConfirmationEligible,
        );
      if (confirmed) {
        for (const id of sheetIds) {
          confirmedSheetUpdateIds.add(id);
          for (const range of ranges) {
            confirmedSheetUpdateTargets.set(`${id}\0${range}`, {
              spreadsheetId: id,
              range,
            });
          }
        }
        if (
          POSITIVE_FORMULA_PERMISSION.test(semantic) &&
          !NEGATIVE_FORMULA_PERMISSION.test(semantic)
        ) {
          allowUserEnteredValues = true;
        }
      }
    }

    const scriptRead =
      hasBoundAction(semantic, READ_ACTION, SCRIPT_OBJECT) &&
      hasDirectActionObjectBinding(semantic, READ_ACTION, SCRIPT_OBJECT);
    const scriptUpdate =
      hasBoundAction(semantic, SCRIPT_UPDATE_ACTION, SCRIPT_OBJECT) &&
      hasDirectActionObjectBinding(
        semantic,
        SCRIPT_UPDATE_ACTION,
        SCRIPT_OBJECT,
      ) &&
      countTypedObjectMentions(semantic, SCRIPT_OBJECT) === 1;
    const scriptIds = new Set(ids.script);
    if (
      (scriptRead || scriptUpdate) &&
      resources.defaultScriptId &&
      hasDefaultAliasForObject(semantic, SCRIPT_OBJECT)
    ) {
      scriptIds.add(resources.defaultScriptId);
    }
    if (scriptRead || scriptUpdate) {
      for (const id of scriptIds) allowedScriptIds.add(id);
      if (scriptIds.size > 0) tools.add('google_apps_script_get_content');
      const fileNames = scriptUpdate
        ? extractScriptFileNames(rawOperational)
        : [];
      for (const fileName of fileNames) allowedScriptFileNames.add(fileName);
      if (
        scriptUpdate &&
        scriptIds.size === 1 &&
        fileNames.length > 0 &&
        hasPositiveConfirmationFor(
          semantic,
          SCRIPT_UPDATE_ACTION,
          SCRIPT_OBJECT,
          clause.destructiveConfirmationEligible,
        )
      ) {
        for (const id of scriptIds) {
          confirmedScriptUpdateIds.add(id);
          for (const fileName of fileNames) {
            confirmedScriptUpdateTargets.set(`${id}\0${fileName}`, {
              scriptId: id,
              fileName,
            });
          }
        }
      }
    }

    const driveSearch = hasBoundAction(
      semantic,
      DRIVE_SEARCH_ACTION,
      DRIVE_OBJECT,
    );
    if (driveSearch) {
      const rootLanguage = DRIVE_ROOT_LANGUAGE.test(semantic);
      if (
        UNSUPPORTED_DRIVE_FILTER.test(semantic) ||
        (rootLanguage && !ROOT_TARGET.test(semantic)) ||
        (MY_DRIVE_SCOPE.test(semantic) &&
          !ROOT_TARGET.test(semantic) &&
          ids.folder.length === 0) ||
        ids.folder.some(
          (folderId) => !hasExplicitDriveFolderScope(semantic, folderId),
        )
      ) {
        continue;
      }
      const nameQueries = extractDriveNameQueries(rawOperational);
      const contentQueries = extractDriveContentQueries(rawOperational);
      const rootOnly =
        ROOT_TARGET.test(semantic) && !NEGATIVE_ROOT_TARGET.test(semantic);
      const unfiltered =
        !rootOnly &&
        !MY_DRIVE_SCOPE.test(semantic) &&
        ALL_FILES_DRIVE.test(semantic) &&
        !NEGATIVE_ALL_FILES_DRIVE.test(semantic);
      allowUnfilteredDriveList ||= unfiltered;
      for (const id of ids.folder) allowedFolderIds.add(id);
      const driveTargetUnambiguous =
        nameQueries.length <= 1 &&
        contentQueries.length <= 1 &&
        ids.folder.length <= 1;
      const queryTargets: Array<{
        nameQuery?: string;
        contentQuery?: string;
      }> =
        nameQueries.length > 0 && contentQueries.length > 0
          ? [
              {
                nameQuery: nameQueries[0],
                contentQuery: contentQueries[0],
              },
            ]
          : nameQueries.length > 0
            ? nameQueries.map((nameQuery) => ({ nameQuery }))
            : contentQueries.length > 0
              ? contentQueries.map((contentQuery) => ({ contentQuery }))
              : [{}];
      const folderTargets: Array<string | undefined> =
        ids.folder.length > 0 ? ids.folder : [undefined];
      if (driveTargetUnambiguous) {
        for (const queryTarget of queryTargets) {
          for (const type of extractDriveResultTypes(semantic)) {
            for (const folderId of folderTargets) {
              if (
                !queryTarget.nameQuery &&
                !queryTarget.contentQuery &&
                !folderId &&
                !rootOnly &&
                !unfiltered
              ) {
                continue;
              }
              const target = {
                ...queryTarget,
                type,
                ...(folderId ? { folderId } : {}),
                rootOnly,
                unfiltered,
              };
              allowedDriveSearchTargets.set(JSON.stringify(target), target);
            }
          }
        }
      }
      if (allowedDriveSearchTargets.size > 0) {
        allowDriveSearch = true;
        tools.add('google_drive_list_files');
      }
    }

    const rootTarget =
      ROOT_TARGET.test(semantic) && !NEGATIVE_ROOT_TARGET.test(semantic);
    const documentCreate = hasExplicitCreateForObject(
      semantic,
      DOCUMENT_OBJECT,
      /(?:новый\s+(?:(?:google|гугл)[\s-]*)?документ[а-яё]*|\bnew\s+(?:google\s+)?doc(?:ument)?\b)/i,
    );
    if (sheetCreate || documentCreate) {
      for (const id of ids.folder) allowedFolderIds.add(id);
    }
    const addCreateTargets = (
      tool: 'google_sheets_create' | 'google_docs_create',
      titleSelection: CreateTitleSelection,
    ): void => {
      if (titleSelection.kind === 'ambiguous') return;
      const locations: Array<{ folderId?: string; root: boolean }> = [
        ...(rootTarget ? [{ root: true }] : []),
        ...ids.folder.map((folderId) => ({ folderId, root: false })),
      ];
      // One create span names one exact location. Multiple folders, or root plus
      // a folder, are ambiguous and must never expand into a target cross-product.
      if (locations.length !== 1) return;
      const target = {
        tool,
        ...(titleSelection.kind === 'exact'
          ? { title: titleSelection.title }
          : {}),
        ...locations[0],
      };
      allowedCreateTargets.set(JSON.stringify(target), target);
      tools.add(tool);
      allowRootCreate ||= rootTarget;
      if (rootTarget) rootCreateTools.add(tool);
    };
    if (sheetCreate) {
      addCreateTargets(
        'google_sheets_create',
        selectCreateTitle(rawOperational, SHEET_OBJECT),
      );
    }
    if (documentCreate) {
      addCreateTargets(
        'google_docs_create',
        selectCreateTitle(rawOperational, DOCUMENT_OBJECT),
      );
    }

    if (
      calendarEarliestTime &&
      calendarLatestTime &&
      hasBoundAction(semantic, READ_ACTION, CALENDAR_OBJECT) &&
      !UNSUPPORTED_CALENDAR_ID_ROLE.test(semantic)
    ) {
      const selected = selectCalendarIds(semantic, calendars);
      for (const id of selected) allowedCalendarIds.add(id);
      const queries = extractCalendarQueries(rawOperational);
      for (const query of queries) {
        allowedCalendarQueries.add(query);
      }
      // As with Sheets and Drive, an unsplit many-ID/many-query span is not
      // evidence for every possible pair.
      if (selected.length <= 1 || queries.length <= 1) {
        for (const calendarId of selected) {
          const targets = queries.length > 0 ? queries : [undefined];
          for (const query of targets) {
            const target = {
              calendarId,
              ...(query === undefined ? {} : { query }),
            };
            allowedCalendarTargets.set(JSON.stringify(target), target);
          }
        }
      }
      if (allowedCalendarTargets.size > 0) {
        tools.add('google_calendar_list_events');
      }
    }

    if (
      EXPLICIT_STATUS_ACTION.test(semantic) &&
      !hasNegatedAction(semantic, STATUS_ACTION)
    ) {
      tools.add('google_workspace_status');
      allowStatusVerify = true;
    }
  }

  // A natural-language owner turn may authorize one append target only. If
  // separate clauses accumulated more than one, retain their read authority
  // but fail closed for every append.
  if (allowedSheetAppendTargets.size > 1) {
    allowedSheetAppendTargets.clear();
    tools.delete('google_sheets_append_values');
  }
  if (tools.size === 0) return null;
  tools.add('google_workspace_status');
  return {
    intentId: stableIntentId(input.chatJid, messages),
    allowedTools: [...tools].sort(),
    allowedDocumentIds: [...allowedDocumentIds].sort(),
    allowedSpreadsheetIds: [...allowedSpreadsheetIds].sort(),
    allowedScriptIds: [...allowedScriptIds].sort(),
    allowedFolderIds: [...allowedFolderIds].sort(),
    allowedCalendarIds: [...allowedCalendarIds].sort(),
    allowedSheetRanges: [...allowedSheetRanges].sort(),
    allowedSheetTargets: [...allowedSheetTargets.values()].sort((a, b) =>
      `${a.spreadsheetId}\0${a.range}`.localeCompare(
        `${b.spreadsheetId}\0${b.range}`,
      ),
    ),
    allowedSheetAppendTargets: [...allowedSheetAppendTargets.values()].sort(
      (a, b) =>
        `${a.spreadsheetId}\0${a.range}`.localeCompare(
          `${b.spreadsheetId}\0${b.range}`,
        ),
    ),
    allowedScriptFileNames: [...allowedScriptFileNames].sort(),
    confirmedDocumentReplaceIds: [...confirmedDocumentReplaceIds].sort(),
    confirmedSheetUpdateIds: [...confirmedSheetUpdateIds].sort(),
    confirmedSheetUpdateTargets: [...confirmedSheetUpdateTargets.values()].sort(
      (a, b) =>
        `${a.spreadsheetId}\0${a.range}`.localeCompare(
          `${b.spreadsheetId}\0${b.range}`,
        ),
    ),
    confirmedScriptUpdateIds: [...confirmedScriptUpdateIds].sort(),
    confirmedScriptUpdateTargets: [
      ...confirmedScriptUpdateTargets.values(),
    ].sort((a, b) =>
      `${a.scriptId}\0${a.fileName}`.localeCompare(
        `${b.scriptId}\0${b.fileName}`,
      ),
    ),
    allowedDriveSearchTargets: [...allowedDriveSearchTargets.values()].sort(
      (a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)),
    ),
    allowedCalendarQueries: [...allowedCalendarQueries].sort(),
    allowedCalendarTargets: [...allowedCalendarTargets.values()].sort((a, b) =>
      JSON.stringify(a).localeCompare(JSON.stringify(b)),
    ),
    ...(calendarEarliestTime ? { calendarEarliestTime } : {}),
    ...(calendarLatestTime ? { calendarLatestTime } : {}),
    allowedCreateTargets: [...allowedCreateTargets.values()].sort((a, b) =>
      JSON.stringify(a).localeCompare(JSON.stringify(b)),
    ),
    rootCreateTools: [...rootCreateTools].sort(),
    allowStatusVerify,
    allowDriveSearch,
    allowUnfilteredDriveList,
    allowRootCreate,
    allowUserEnteredValues,
  };
}
