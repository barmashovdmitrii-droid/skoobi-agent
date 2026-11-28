// Name matching is for already-scoped reads only. Mutation targets and
// activation/forget grants continue to use their exact-key host checks.
import type { MemoryStateRecord } from './memory-state-store.js';

export type MemoryReadProject = Extract<MemoryStateRecord, { kind: 'project' }>;
export type MemoryReadName = Pick<MemoryReadProject, 'projectKey'> & {
  card: Pick<MemoryReadProject['card'], 'title' | 'aliases'>;
};

const wordOrHost =
  /(?:[\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)*\.)+[\p{L}]{2,}(?![\p{L}\p{N}]|\.[\p{L}\p{N}])|[\p{L}\p{N}]+/gu;
const generic = new Set(
  'что как для про сайт проект нужен нужна новый новая сделать решили есть api sdk http https www the for with project'.split(
    ' ',
  ),
);
// Product nouns participate only together with a distinguishing word from the
// same title. A generic request for a site or an API doesn't select any card.
const productKinds = new Set([
  'сайт',
  'портал',
  'кабинет',
  'помощник',
  'ассистент',
  'бот',
  'site',
  'portal',
  'assistant',
]);
const commonAcronyms = new Set([
  'API',
  'SDK',
  'HTTP',
  'HTTPS',
  'URL',
  'WWW',
  'SQL',
  'JSON',
  'PDF',
  'HTML',
  'CSS',
  'CLI',
  'MCP',
  'CRM',
  'LLM',
  'ИИ',
  'AI',
]);
const acronymLetters: Record<string, string> = {
  а: 'a',
  б: 'b',
  в: 'v',
  г: 'g',
  д: 'd',
  е: 'e',
  з: 'z',
  и: 'i',
  к: 'k',
  л: 'l',
  м: 'm',
  н: 'n',
  о: 'o',
  п: 'p',
  р: 'r',
  с: 's',
  т: 't',
  у: 'u',
  ф: 'f',
  х: 'x',
};

function words(value: string): string[] {
  return (
    value
      .normalize('NFKC')
      .toLowerCase()
      .replace(/ё/g, 'е')
      .match(wordOrHost) ?? []
  );
}

function phrase(tokens: readonly string[]): string {
  return ' ' + tokens.join(' ') + ' ';
}

function acronym(word: string): string {
  if (!/^[а-я]{3,6}$/.test(word)) return word;
  return [...word].map((letter) => acronymLetters[letter] ?? letter).join('');
}

const RU_ENDINGS = (
  'иями ями ами ого его ому ему ыми ими ией ия ие ий ый ой ей ая яя ое ее ом ' +
  'ем ам ям ах ях ов ев ую юю ы и а я о е у ю ь й'
).split(' ');

/** Existing lexical memory_search stemmer, also used for descriptive titles. */
export function memorySearchStem(term: string): string {
  if (term.length >= 5 && /^[а-я]+$/.test(term)) {
    for (const ending of RU_ENDINGS)
      if (term.endsWith(ending) && term.length - ending.length >= 4)
        return term.slice(0, -ending.length);
  }
  if (term.length >= 5 && /^[a-z]+[^s]s$/.test(term)) return term.slice(0, -1);
  return term;
}

const memoryExclusion = /(?:^|\s)(?:без|кроме|исключая|не\s+учитывая|except|excluding|without|ignore|omit|skip|игнорируй|исключи|пропусти|отложи|(?:не|don't|do not)\s+(?:подставляй|вспоминай|упоминай|используй|учитывай|обсуждай|показывай|трогай|бери|касайся|надо|нужно|стоит|нужн[ыао]|нужен|интересует|будем|про|об?|include|recall|use|mention))(?=\s|$)/iu;
const actionRestriction = /(?:^|\s)(?:не\s+(?:меняй|изменяй|редактируй|запускай|отправляй|публикуй|выкатывай)|(?:don't|do not)\s+(?:change|edit|deploy|send))(?=$|[^\p{L}\p{N}])/iu;
const readCue = /(?:^|\s)(?:напомни|расскажи|покажи|уточни|статус|какие|что\s+(?:уже|осталось|решили|проверили)|summarize|recall|status)(?=$|[^\p{L}\p{N}])/iu;
const onlyNamed = /(?:^|\s)(?:только|only|solely)(?=\s|$)/iu;

const withheldQuote = '\0';
const textTask = /(?:переведи|перевести|перевод|перефразируй|процитируй|орфографи|грамматик|дословно|в\s+(?:этой\s+)?фразе|translate|translation|proofread|paraphrase|quote verbatim)/iu;

// Mentioned text can be the object of translation, proofreading or quotation.
function projectQueryOutsideExamples(query: string) {
  let withheld = false;
  const text = query.replace(/«[^»]*»|“[^”]*”|‘[^’]*’|"[^"]*"|`[^`]*`|(?<![\p{L}\p{N}])'[^'\n]*'(?![\p{L}\p{N}])/gu,
    (whole: string, start: number) => {
      const lead = query.slice(0,start).split(/[!?;\n]|\.(?=\s|$)/u).at(-1)!.trim();
      const quoted = whole.slice(1,-1);
      const topic = /(?:^|\s)(?:проект[\p{L}]*|карточк[\p{L}]*|по|про|об?|с|у|решени[\p{L}]*|статус|между|project|about|on)$/iu.test(lead);
      if (!textTask.test(lead) && (topic || memoryExclusion.test(lead) || (!lead && query.trim() === whole))) return quoted;
      withheld = true;
      return withheldQuote;
    });
  // A clipped/open quotation has no trustworthy outside span.
  if (/[«»“”‘’"`]|(?<![\p{L}\p{N}])'(?=[\p{L}\p{N}])/u.test(text)) return {text:'',withheld:true};
  return {text, withheld};
}

function asksForProjectContext<T extends MemoryReadName>(clause: string, matched: readonly T[]): boolean {
  const tokens = words(clause);
  if (tokens.length <= 2) return true;
  // A question about an object carrying a project's name does not ask for
  // its stored decisions. Require a state/lookup cue or a named phrase, not
  // merely a question mark, a wh-word or a general request to write text.
  if (/(?:^|\s)(?:что\s+(?:там\s+)?(?:с|по|у|известно|решили|осталось|дальше)|как\s+(?:там|дела|продвига[\p{L}]*)|(?:принят[\p{L}]*|следующ[\p{L}]*|дальнейш[\p{L}]*)\s+(?:решени[\p{L}]*|шаг[\p{L}]*)|сравни|статус|истори[яию]|решени[\p{L}]*|решили|итог[аи]?|результат[\p{L}]*|провер[\p{L}]*|задач[\p{L}]*|новост[\p{L}]*|продолжай|продолжи|запускай|как там|обсудим|интересует|интересуют|посмотреть\s+проект[\p{L}]*|update|status|compare|recall|what about|how is)(?=$|[^\p{L}\p{N}])/iu.test(clause)) return true;
  if (/^\s*(?:почему|отчего|why)(?:\s|$)/iu.test(clause) &&
      /(?:^|\s)(?:не|нет|not)(?:\s|$)/iu.test(clause)) return true;
  // A title fragment by itself is a natural lookup. Extra narrative words
  // turn a mere past mention into context only when an actual request is made.
  const named = new Set(matched.flatMap(({projectKey,card}) =>
    [projectKey, card.title, ...(card.aliases ?? [])].flatMap(name => words(name).map(memorySearchStem))));
  if (['про','о','об'].includes(tokens[0]) && named.has(memorySearchStem(tokens[1] ?? ''))) return true;
  return tokens.every(token => named.has(memorySearchStem(token)) || named.has(acronym(token)) ||
    ['и','или','только','лишь','отдельно','а','наш','наша','для','где','расскажи','покажи','напомни','про','по','о','что','с','как','там','какие','варианты','the','and','only'].includes(token) ||
    /^(?:предусмотрен[аоы]?|есть|будет|работает|готов[аоы]?|открыт[аоы]?|создан[аоы]?)$/u.test(token)) ||
    /(?:^|\s)(?:по|про|о|об|для)\s+проект[\p{L}]*(?=\s)/iu.test(clause);
}

// Treat a comma as name punctuation only at an exact occurrence of a scoped
// title or declared alias. Keep punctuation and line breaks in the comparison
// so independent clauses cannot supply missing pieces of a name.
const namePiece = new RegExp(wordOrHost.source + '|[^\\s]|[\\r\\n]', 'gu');
const clauseBoundary = /[,;\n]|(?<=[!?])|\.(?=\s|$)|\s+(?:а|но|but|whereas)\s+/iu;
const sentenceBoundary = /([;\n]|(?<=[!?])|\.(?=\s|$)|\s+(?:а(?!\s+также(?:\s|$))|но|but|whereas)\s+)/iu;

function protectNameCommas(
  projects: readonly MemoryReadName[],
  text: string,
): string {
  if (!text.includes(',') || textTask.test(text)) return text;
  const pieces = [...text.matchAll(namePiece)];
  const fold = (piece: string) => piece.toLowerCase().replace(/ё/g, 'е');
  const query = pieces.map((piece) => fold(piece[0]));
  const protectedOffsets = new Set<number>();
  for (const { card } of projects) {
    for (const name of [card.title, ...(card.aliases ?? [])]) {
      if (!name.includes(',')) continue;
      const parts = (name.match(namePiece) ?? []).map(fold);
      if (parts.length > query.length) continue;
      // A stored label must not mask an instruction in the user's text.
      const label = phrase(words(name));
      if (
        memoryExclusion.test(label) ||
        onlyNamed.test(label) ||
        /\s(?:не|нет|not|don t)\s/u.test(label)
      ) continue;
      for (
        let start = query.indexOf(parts[0]);
        start >= 0;
        start = query.indexOf(parts[0], start + 1)
      ) {
        if (!parts.every((part, i) => part === query[start + i])) continue;
        for (let i = 0; i < parts.length; i++) {
          if (parts[i] === ',') protectedOffsets.add(pieces[start + i].index);
        }
      }
    }
  }
  return text.replace(/,/g, (comma, index) =>
    protectedOffsets.has(index) ? ' ' : comma,
  );
}

// In "exclude A, B, what about C?", B still belongs to the exclusion.
function splitReadClauses(text: string, projects: readonly MemoryReadName[]): string[] {
  const clauses: string[] = [];
  let restriction = '';
  const sentences = text.split(sentenceBoundary);
  for (let i = 0; i < sentences.length; i += 2) {
    const sentence = sentences[i];
    if (!sentence.trim()) continue;
    const lookup = sentence.includes(withheldQuote)
      ? sentence.replaceAll(withheldQuote, ' ')
      : protectNameCommas(projects, sentence);
    for (const part of lookup.split(',')) {
      if (!words(part).length) continue;
      const ownRestriction = (memoryExclusion.exec(part) ?? actionRestriction.exec(part))?.[0].trim();
      if (ownRestriction) {
        restriction = ownRestriction;
      } else if (restriction) {
        // A bare title can itself start with a word such as "status".
        const subject = part.trim().replace(
          /^(?:и(?:\s+ещ[ёе])?|а\s+также|также|and(?:\s+also)?|as well as)\s+/iu, '',
        );
        const asks = /^(?:(?:только|just)\s+)?(?:что|как|како[йяеи]|какие|почему|покажи|расскажи|напомни|сравни|проверь|скажи|уточни|назови|статус|what|how|show|tell|recall|compare|status)(?=\s)/iu.test(subject);
        const signature = phrase(words(subject));
        const bareName = asks && projects.some(({ card, projectKey }) =>
          [card.title, projectKey, ...(card.aliases ?? [])].some(
            name => phrase(words(name)) === signature,
          ),
        );
        if (!asks || bareName) {
          clauses.push(restriction + ' ' + part);
          continue;
        }
        restriction = '';
      }
      clauses.push(part);
    }
    // A comma at the end of a line explicitly continues the same list.
    if (sentences[i + 1] !== '\n' || !/,\s*$/u.test(sentence)) restriction = '';
  }
  return clauses;
}

/** Keep names mentioned as exclusions outside every automatic read surface.
 * Restrictive clauses also opt out of file/global context, whose provenance
 * cannot reliably be classified by project. Treat an overlong input as a
 * whole: dropping the prefix could discard "do not recall". */
export function memoryReadProjectRequest<T extends MemoryReadName>(projects: readonly T[], query: string) {
  if (query.length > 1600) {
    // Keep the ordinary bounded last-message behavior when shortening loses
    // no request restriction. Do not discard an exclusion in a long preface.
    if (query.length > 65536 || memoryExclusion.test(query) || onlyNamed.test(query) || /[«»“”‘’"'`]|(?:^|\s)(?:не|not)(?=\s)/iu.test(query))
      return {projects: [] as T[], restricted: true};
    query = query.slice(-1600);
  }
  const {text: masked, withheld} = projectQueryOutsideExamples(query);
  const text = masked.replaceAll(withheldQuote, ' ');
  const include = new Set<string>(), exclude = new Set<string>(), onlyKeys = new Set<string>();
  const actionOnly = new Set<string>();
  let restricted = withheld;
  let unresolvedExclusion = false;
  let hasReadCue = false;
  // A dot inside a domain is part of its name. Independent questions and
  // contrastive clauses must never combine their words to form a title.
  let clauses = text.split(clauseBoundary).filter(c => words(c).length);
  if (clauses.length > 16) return {projects: [] as T[], restricted: withheld || onlyNamed.test(text) || memoryExclusion.test(text) || /(?:^|\s)(?:не|not)(?=\s)/iu.test(text)};
  if (text.includes(',')) clauses = splitReadClauses(masked, projects);
  for (const clause of clauses) {
    if (/(?:в\s+(?:слове|предложении|фразе|строке)|(?:spell|translate)\s+(?:the\s+)?(?:word|sentence|phrase)|переведи\s+(?:слово|фразу|предложение|строку))/iu.test(clause)) {
      restricted = true;
      continue;
    }
    const exclusion = memoryExclusion.exec(clause);
    const only = onlyNamed.test(clause);
    if (only) for (const p of matchProjectClause(projects, clause)) onlyKeys.add(p.projectKey);
    if (!exclusion) {
      const matched = matchProjectClause(projects, clause);
      if (actionRestriction.test(clause)) {
        restricted = true;
        for (const p of matched) actionOnly.add(p.projectKey);
        continue;
      }
      hasReadCue ||= readCue.test(clause);
      const negative = /(?:^|\s)(?:не|нет|not|don't|do not)(?=\s|$)/iu.test(clause);
      // A factual question may ask why a named project has not succeeded.
      // Otherwise unsupported negation is not permission to attach a card.
      const factual = /^\s*(?:почему|отчего|why|правда ли|известно ли)(?=\s)/iu.test(clause) ||
        clause.includes('?') && /(?:^|\s)не\s+(?:провер[\p{L}]*|протестир[\p{L}]*|готов[\p{L}]*|сдела[\p{L}]*|заверш[\p{L}]*|ответил[\p{L}]*|достав[\p{L}]*|получ[\p{L}]*)(?=$|[^\p{L}\p{N}])/iu.test(clause);
      restricted ||= only || negative && !factual;
      const target = negative && !factual ? exclude : include;
      if (target === include && matched.length && !only && !asksForProjectContext(clause, matched)) {
        restricted = true;
        continue;
      }
      for (const p of matched) target.add(p.projectKey);
      continue;
    }
    restricted = true;
    const left = matchProjectClause(projects, clause.slice(0, exclusion.index));
    const right = matchProjectClause(projects, clause.slice(exclusion.index + exclusion[0].length));
    const preposition = /^(?:без|кроме|исключая|не\s+учитывая|except|excluding|without)$/iu.test(exclusion[0].trim());
    if (preposition) {
      for (const p of left) include.add(p.projectKey);
    } else {
      for (const p of left) exclude.add(p.projectKey);
    }
    for (const p of right) exclude.add(p.projectKey);
    if (!left.length && !right.length) {
      const operand = clause.slice(0, exclusion.index) + ' ' + clause.slice(exclusion.index + exclusion[0].length);
      if (words(operand).every(w => ['его','их','это','этот','этого','об','о','этом','сейчас','пока','пожалуйста','it','this','them','please'].includes(w)))
        unresolvedExclusion = true;
    }
  }
  // "Don't change A; just tell me what passed" requests reading A. If B
  // is positively named, A's action restriction must not add a second route.
  if (!include.size && actionOnly.size && hasReadCue) {
    for (const key of actionOnly) include.add(key);
  }
  const visible = unresolvedExclusion ? [] : projects.filter(p => include.has(p.projectKey) && !exclude.has(p.projectKey) &&
    (!onlyKeys.size || onlyKeys.has(p.projectKey)));
  return { projects: visible, restricted };
}

export function matchMemoryReadProjects<T extends MemoryReadName>(projects: readonly T[], query: string): T[] {
  return memoryReadProjectRequest(projects, query).projects;
}

function matchProjectClause<T extends MemoryReadName>(projects: readonly T[], query: string): T[] {
  const original = query.normalize('NFKC').match(wordOrHost) ?? [];
  const tokens = original.map(word => word.toLowerCase().replace(/ё/g, 'е'));
  if (!tokens.length) return [];
  const exact = new Set<string>();
  const byStart = new Map<number, { end: number; keys: Set<string> }>();
  // Protect complete compound names. Their embedded acronym is not a
  // second request. A separately mentioned acronym remains in the remainder.
  for (const project of projects) {
    for (const name of [
      project.card.title,
      project.projectKey,
      ...(project.card.aliases ?? []),
    ]) {
      const parts = words(name);
      if (parts.length < 2 || parts.length > tokens.length) continue;
      for (
        let start = tokens.indexOf(parts[0]);
        start !== -1;
        start = tokens.indexOf(parts[0], start + 1)
      ) {
        if (!parts.every((part, offset) => tokens[start + offset] === part))
          continue;
        const end = start + parts.length;
        const prior = byStart.get(start);
        if (!prior || prior.end < end)
          byStart.set(start, { end, keys: new Set([project.projectKey]) });
        else if (prior.end === end) prior.keys.add(project.projectKey);
      }
    }
  }
  const remainder: number[][] = [];
  let boundary = 0;
  for (const [start, span] of [...byStart].sort(([a], [b]) => a - b)) {
    if (span.end <= boundary) continue;
    if (boundary < start) remainder.push([boundary, start]);
    span.keys.forEach((key) => exact.add(key));
    boundary = span.end;
  }
  if (boundary < tokens.length) remainder.push([boundary, tokens.length]);
  for (const [start, end] of remainder) {
    matchNameSegment(projects, tokens.slice(start, end), original.slice(start, end)).forEach((project) =>
      exact.add(project.projectKey),
    );
  }
  return projects.filter((p) => exact.has(p.projectKey));
}

function matchNameSegment<T extends MemoryReadName>(
  projects: readonly T[],
  tokens: string[],
  original: string[],
): T[] {
  const request = phrase(tokens);
  const stemmedTokens = tokens.map(memorySearchStem);
  const stemmedRequest = phrase(stemmedTokens);
  // A modal "Can" or "can" in an English sentence is not the project CAN.
  // Literal uppercase, a standalone lookup, or an explicit project cue
  // make a short Latin name intentional. Cyrillic aliases obey the same rule.
  const shortNames = new Set(tokens.filter((word, i) =>
    (original[i] === original[i].toUpperCase() &&
      !(['can','may','will','must','are'].includes(word) && ['i','you','we','it','they','the','a','an'].includes(tokens[i+1]))) || tokens.length === 1 ||
    ['проект', 'проекта', 'проекту', 'по', 'про', 'project', 'продолжай', 'решений', 'статус', 'результаты', 'history'].includes(tokens[i-1])
  ).map(acronym));
  return projects.filter(({ projectKey, card }) => {
    const names = [projectKey, card.title, ...(card.aliases ?? [])];
    return names.some((name) => {
      const parts = words(name);
      if (
        parts.length === 1 &&
        (generic.has(parts[0]) ||
          productKinds.has(parts[0]) ||
          commonAcronyms.has(parts[0].toUpperCase()))
      )
        return false;
      if (
        parts.length &&
        name.trim().length >= 3 &&
        request.includes(phrase(parts)) &&
        (parts.length > 1 || !/^[a-z]{3,6}$/.test(parts[0]) || shortNames.has(parts[0]))
      )
        return true;
      if (
        parts.length > 1 &&
        stemmedRequest.includes(phrase(parts.map(memorySearchStem)))
      )
        return true;
      // Compare whole host names. A shared suffix and a URL belonging to a
      // different project must not count as naming this host.
      if (parts.some((p) => p.includes('.') && tokens.includes(p))) return true;
      const brandNames = [
        ...(parts.length === 1 ? parts : []),
        ...parts
          .filter((p) => p.includes('.'))
          .map((host) => host.split('.').at(-2)!),
      ];
      if (
        brandNames.some(
          (brand) =>
            /^[a-z]{3,6}$/.test(brand) &&
            !commonAcronyms.has(brand.toUpperCase()) &&
            shortNames.has(brand),
        )
      )
        return true;
      for (const token of name.normalize('NFKC').match(/[\p{L}\p{N}]+/gu) ?? [])
        if (
          /^[A-Z]{3,6}$/.test(token) &&
          !commonAcronyms.has(token) &&
          shortNames.has(token.toLowerCase())
        )
          return true;
      // A product and its distinguishing noun may be inflected or reversed.
      // Only particles may lie between them; two unrelated phrases in a
      // request must not be assembled into a descriptive project name.
      if (name !== card.title) return false;
      const nameStems = new Set(parts.map(memorySearchStem));
      for (let i = 0; i < stemmedTokens.length; i++) {
        const first = stemmedTokens[i];
        if (!nameStems.has(first)) continue;
        for (let j = i + 1; j < Math.min(i + 5, stemmedTokens.length); j++) {
          const other = stemmedTokens[j];
          if (nameStems.has(other) && first !== other &&
            ((productKinds.has(first) && !generic.has(other) && !productKinds.has(other)) ||
             (productKinds.has(other) && !generic.has(first) && !productKinds.has(first)))) return true;
          const connector = ['для','что','с','у','по','и','на','нас','как','там','наш','сейчас','for','with','the'].includes(tokens[j]) ||
            /^(?:предусмотрен[аоы]?|есть|будет|работает|готов[аоы]?|открыт[аоы]?|создан[аоы]?)$/u.test(tokens[j]);
          if (!connector) break;
        }
      }
      return false;
    });
  });
}

export function linkedMemoryReadProjects(
  primary: MemoryReadProject,
  projects: readonly MemoryReadProject[],
): MemoryReadProject[] {
  const keys = new Set(primary.card.relatedProjectKeys ?? []);
  keys.delete(primary.projectKey);
  // Direct edges only; absent/forgotten/off-scope cards cannot add a source.
  return projects.filter((p) => keys.has(p.projectKey)).slice(0, 3);
}
